// Quota-reset auto-use guard for the official runtime ("重置机会" optimizer).
//
// The coding plan occasionally grants reset chances ("获得 N 次重置额度"):
// one kind refills the 5-hour prompt pool, the other the weekly quota. Each
// chance has its own expiry. The official UI only uses them when a human
// clicks. Policy implemented here (per the operator's rules):
//
//   - no reset while idle and the pool is healthy (pointless);
//   - FIVE_HOUR: reset when a task is actively running AND the 5h pool is
//     almost exhausted (remaining ratio at/below the threshold);
//   - WEEK: same, with its own thresholds (chances live longer, so the
//     expiry-rescue window is wider);
//   - exhaustion rescue: the runtime reports "quota used up" as HTTP 429 with
//     a provider business code (1310 = weekly/monthly, 1308 = 5h). Those land
//     as per-pool signals from the host AND the agent children; a fresh signal
//     uses the matching chance even while idle, because the operator is
//     demonstrably blocked right now;
//   - bone-dry pool: a pool at ~100% used with the chance still valid and the
//     pool's own natural reset still far enough away is reset on the spot —
//     there is nothing left to preserve, and waiting only means the next turn
//     fails. Suppressed when the natural reset is imminent (that refill is
//     free).
//   - never twice for the same pool without a fresh /status confirming the
//     previous use; cooldown between uses; hard daily cap.
//
// Pool usage is taken the way the official client takes it
// (`bigmodelUsageQuotaMapper` / renderer `kL()`): limits[] entries carry
// `usage` = the window allowance, `currentValue` = what was consumed,
// `remaining` = usage - currentValue and `percentage` = consumed %. The pool
// identity is `type` + `unit` (TOKENS_LIMIT|CREDIT_LIMIT × 3 = 5h with
// number 5, × 6 = week; TIME_LIMIT × 5 = the monthly MCP quota, never a reset
// target). `number` is NOT the pool size — dividing the absolute `remaining`
// by it (the 0.7.1 bug) made a drained 60000-credit week pool look like
// "200% remaining", so the ≤5% trigger could only ever fire at exactly zero,
// i.e. after the turn had already died.
//
// Mechanism (all inside the host process, preloaded via NODE_OPTIONS):
//   observe  — fetch is wrapped; responses for coding-plan/reset/status and
//              the billing/quota endpoints are cloned and parsed (chances +
//              pool buckets). Requests carrying BOTH auth headers have those
//              headers captured for replay (this is exactly the header set the
//              runtime itself sends; credentials never touch the disk).
//   refresh  — with captured headers younger than HEADER_MAX_AGE, GET
//              .../reset/status on a slow cadence (read-only) so the engine
//              keeps working while no UI is attached.
//   decide   — pure decide() below; inputs: chances, pool buckets (usage
//              ratios), task activity (read-only query on the official tasks
//              index, same access pattern as the webui server's reaper), and
//              per-pool exhaustion signals appended by the child-process
//              observers.
//   act      — POST .../reset/use with a fresh idempotency key, then poll
//              /status until the chance count drops (confirm). In dry-run the
//              decision is logged and nothing is sent.
//
// 2026-09-28 incident postmortem (both fixes below are load-bearing):
//   The operator enabled the switch at 92% 5h-pool usage and left. The task
//   drained the pool to the wall ~30min later — the guard did NOTHING until
//   the operator returned and opened the page, at which point it fired within
//   10s (6s before their OFF click landed). Two stacked causes:
//   ① pool usage was only ever OBSERVED passively from the runtime's own
//     billing/quota responses — with no UI attached that traffic stops, so the
//     engine decided on a 30-minute-old "92% used" snapshot all the way past
//     the wall. Fix: the engine now refreshes the pool data itself
//     (fetchLimit, replayed headers, URL learned from observed traffic) while
//     enabled, so a draining pool is seen within ~1-2 ticks even with no UI.
//   ② the 429 exhaustion signals never arrive: the agent's model calls go
//     through the runtime's BUNDLED undici (same "preload 补不到" issue the
//     repo-snapshot guard hit), so the globalThis.fetch wrapper in the child
//     observer never sees them. The signal path stays as a best-effort net,
//     but detection no longer depends on it — a pool at remaining=0 IS the
//     wall, visible through ①.
//   Plus a UX guard: when pool data REVIVES after a blind gap (headers
//   expired >12h while away, or the switch just flipped on after a long
//   off), idle resets hold for RETURN_GRACE_MS so the returning operator
//   keeps agency for a beat instead of being preempted mid-click. Busy /
//   hard-signal / expiring-chance paths are not delayed — those are urgent.
//
// Everything lands on stderr ("[zcode-webui] quota-reset-guard: …") and in
// ${ZCODE_WEBUI_GUARD_STATS_DIR}/quota-reset-guard.json (surfaced in
// /api/health → guards.quotaReset).
//
// On/off is operator-controlled from the web UI (the ♻ chip next to the ⚡
// mode-boost switch): POST /api/quota-reset writes {at, mode} into
// ${ZCODE_WEBUI_GUARD_STATS_DIR}/quota-reset-switch.json and every running
// guard re-reads that file within ~10s — no respawn needed. The switch file
// outranks the env baseline (latest intent wins); the DEFAULT is off.
//
// Knobs (env): ZCODE_WEBUI_QUOTA_RESET=on|dry-run|off (baseline while no
// switch file exists; default off),
// _TICK_MS, _STATUS_REFRESH_MS, _LIMIT_REFRESH_MS, _FIVE_HOUR_MIN_RATIO, _WEEK_MIN_RATIO,
// _EXPIRY_SOON_FIVE_HOUR_MS, _EXPIRY_SOON_WEEK_MS, _RESCUE_MIN_USED,
// _COOLDOWN_MS, _MAX_USES_PER_DAY, _HEADER_MAX_AGE_MS, _ACTIVITY_WINDOW_MS,
// _EXHAUSTION_SIGNAL_MS, _NATURAL_RESET_FLOOR_FIVE_HOUR_MS,
// _NATURAL_RESET_FLOOR_WEEK_MS, _DRY_IDLE=on|off.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_KEY = Symbol.for('zcode-webui.quota-reset-guard');
const RESET_BASE = '/api/v1/coding-plan/reset';
const OBSERVED_URL_RE = /\/api\/v1\/coding-plan\/reset\/(status|opportunity)|\/api\/v1\/zcode-plan\/billing\/(balance|current)|\/api\/monitor\/usage\/quota\/limit/;
const AUTH_HEADER = 'authorization';
const PLAN_AUTH_HEADER = 'x-bigmodel-authorization';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const envNum = (name, dflt) => {
  const v = num(process.env[name]);
  return v === null || v < 0 ? dflt : v;
};
const envOff = (name) => (process.env[name] || '').trim().toLowerCase() === 'off';

const CFG = {
  // baseline mode only — superseded at any moment by the UI switch file (see
  // effectiveMode below). Default OFF: auto-spending reset chances is opt-in.
  mode: (process.env.ZCODE_WEBUI_QUOTA_RESET || 'off').trim().toLowerCase(),
  tickMs: envNum('ZCODE_WEBUI_QUOTA_RESET_TICK_MS', 60_000),
  statusRefreshMs: envNum('ZCODE_WEBUI_QUOTA_RESET_STATUS_REFRESH_MS', 10 * 60_000),
  fiveHourMinRatio: envNum('ZCODE_WEBUI_QUOTA_RESET_FIVE_HOUR_MIN_RATIO', 0.05),
  weekMinRatio: envNum('ZCODE_WEBUI_QUOTA_RESET_WEEK_MIN_RATIO', 0.05),
  expirySoonFiveHourMs: envNum('ZCODE_WEBUI_QUOTA_RESET_EXPIRY_SOON_FIVE_HOUR_MS', 30 * 60_000),
  expirySoonWeekMs: envNum('ZCODE_WEBUI_QUOTA_RESET_EXPIRY_SOON_WEEK_MS', 2 * 3600_000),
  rescueMinUsed: envNum('ZCODE_WEBUI_QUOTA_RESET_RESCUE_MIN_USED', 0.30),
  cooldownMs: envNum('ZCODE_WEBUI_QUOTA_RESET_COOLDOWN_MS', 10 * 60_000),
  maxUsesPerDay: envNum('ZCODE_WEBUI_QUOTA_RESET_MAX_USES_PER_DAY', 6),
  headerMaxAgeMs: envNum('ZCODE_WEBUI_QUOTA_RESET_HEADER_MAX_AGE_MS', 12 * 3600_000),
  // A tasks-index row keeps task_status='running' for the whole turn (flipping to
  // completed/error when it ends), and the row is not rewritten every minute — so
  // the window must be as generous as the webui reaper's (2h), not 10 minutes,
  // otherwise a long turn looks idle exactly when the pool is draining.
  activityWindowMs: envNum('ZCODE_WEBUI_QUOTA_RESET_ACTIVITY_WINDOW_MS', 2 * 3600_000),
  // how long a provider "quota used up" (429 + business code) counts as "the
  // operator is blocked right now"
  exhaustionSignalMs: envNum('ZCODE_WEBUI_QUOTA_RESET_EXHAUSTION_SIGNAL_MS', 15 * 60_000),
  // do not spend a chance when the pool's own natural reset is this close (it
  // would refill for free); mirrors the expiry-rescue windows per pool
  naturalResetFloorFiveHourMs: envNum('ZCODE_WEBUI_QUOTA_RESET_NATURAL_RESET_FLOOR_FIVE_HOUR_MS', 30 * 60_000),
  naturalResetFloorWeekMs: envNum('ZCODE_WEBUI_QUOTA_RESET_NATURAL_RESET_FLOOR_WEEK_MS', 2 * 3600_000),
  // bone-dry pool (≈100% used) is reset even while idle — see the header
  dryIdle: !envOff('ZCODE_WEBUI_QUOTA_RESET_DRY_IDLE'),
  // pool-data self-refresh (fetchLimit): while enabled, refresh the pool
  // buckets whenever they are older than this (older than one tick while a
  // task is running). Passive observation only updates them when the UI is
  // attached — this is what keeps the engine from deciding on stale data
  // through a wall (2026-09-28 incident ①).
  limitRefreshMs: envNum('ZCODE_WEBUI_QUOTA_RESET_LIMIT_REFRESH_MS', 90_000),
  // a pool-data gap longer than this counts as "blind"; the first fresh data
  // after it triggers the idle-reset grace below
  reviveGapMs: envNum('ZCODE_WEBUI_QUOTA_RESET_REVIVE_GAP_MS', 10 * 60_000),
  // after a blind gap ends, hold IDLE resets for this long so the returning
  // operator keeps agency (2026-09-28 incident: the fire landed 6s before the
  // user's OFF click). Busy/signal/expiry paths are not held.
  returnGraceMs: envNum('ZCODE_WEBUI_QUOTA_RESET_RETURN_GRACE_MS', 60_000),
  // re-log an unchanged decision at this cadence (default 5min) so a pool
  // draining towards a wall stays visible in the log tick by tick
  logEveryMs: envNum('ZCODE_WEBUI_QUOTA_RESET_LOG_EVERY_MS', 5 * 60_000),
};

const STATS_DIR = process.env.ZCODE_WEBUI_GUARD_STATS_DIR || '';
const STATE_FILE = STATS_DIR ? path.join(STATS_DIR, 'quota-reset-guard.json') : '';
const SIGNALS_FILE = STATS_DIR ? path.join(STATS_DIR, 'quota-reset-signals.log') : '';
// written by POST /api/quota-reset (the web panel's ♻ chip); polled below
const SWITCH_FILE = STATS_DIR ? path.join(STATS_DIR, 'quota-reset-switch.json') : '';

// ---------- runtime switch (UI-controlled) ----------
// The guard always installs itself (even while off) so flipping the web switch
// can wake a running host without a respawn; every decision point resolves the
// mode through here instead of reading the env snapshot.
function readSwitchMode() {
  if (!SWITCH_FILE) return null;
  try {
    const j = JSON.parse(fs.readFileSync(SWITCH_FILE, 'utf8'));
    const m = typeof j.mode === 'string' ? j.mode.trim().toLowerCase() : '';
    return (m === 'on' || m === 'dry-run' || m === 'off') ? m : null;
  } catch (_e) { return null; }
}
function effectiveMode() {
  return readSwitchMode() || CFG.mode;
}
// balance snapshots older than this are ignored for the predictive trigger
const BUCKET_MAX_AGE_MS = envNum('ZCODE_WEBUI_QUOTA_RESET_BUCKET_MAX_AGE_MS', 2 * 3600_000);

const STATS = {
  statusFetches: 0, limitFetches: 0,
  statusObservations: 0, balanceObservations: 0, limitObservations: 0,
  limitsUnclassified: 0, signals: 0, usesAttempted: 0, usesConfirmed: 0, usesFailed: 0,
};

function log(message) {
  try { process.stderr.write('[zcode-webui] quota-reset-guard: ' + message + '\n'); } catch (_e) { /* ignore */ }
}

// ---------- state ----------
const S = {
  headers: null,          // { at, Authorization, XBigmodelAuthorization, targetType, organization, project }
  status: null,           // { at, fiveHourResets: [ms], weekResets: [ms], lastFiveHourUsedAt, lastWeekUsedAt }
  buckets: null,          // { at, FIVE_HOUR?: {total, remaining, usedRatio, expiresAt}, WEEK?: {...} }
  exhaustionAt: 0,        // last 402/429-style signal from a model call (any pool)
  exhaustionByType: { FIVE_HOUR: 0, WEEK: 0 },   // per-pool signals
  lastSignal: null,       // { at, scope, pid } for observability
  lastUsedAt: 0,
  lastUsedType: null,
  usesDay: '',            // YYYY-MM-DD for the daily cap
  usesToday: 0,
  wantStatusRefreshAt: 0, // bump to pull a fresh /status sooner than the cadence
  limitUrl: null,         // last OBSERVED quota/limit URL — replayed verbatim by fetchLimit
  lastTickPoolAt: null,   // pool-data age as of the end of the last tick (blind-gap detection)
  revivedAt: 0,           // pool data came back after a blind gap (idle-reset grace)
  poolSeen: {},           // last logged per-pool {rem,tot,used} — wall/refill transition logs
  lastDecision: null,     // { at, fired, type, reason } for observability
  busyCheckedAt: 0,
  busy: false,
  confirmed: true,        // false after a use until /status confirms it landed
};

function dayKey(now) {
  const d = new Date(now);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function writeState(extra = {}) {
  if (!STATE_FILE) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({
      at: Date.now(), mode: effectiveMode(), pid: process.pid, stats: STATS,
      headersAt: S.headers ? S.headers.at : null,
      status: S.status, buckets: S.buckets, busy: S.busy,
      exhaustion: { at: S.exhaustionAt, byType: S.exhaustionByType, last: S.lastSignal },
      usesToday: S.usesToday, lastUsedAt: S.lastUsedAt, lastUsedType: S.lastUsedType,
      confirmed: S.confirmed, lastDecision: S.lastDecision,
      ...extra,
    }));
    fs.renameSync(tmp, STATE_FILE);
  } catch (_e) { /* observability only */ }
}

// ---------- decision engine (pure; unit-tested directly) ----------
//
// inputs:
//   now                     ms epoch
//   fiveHourResets/weekResets  [expireAt ms] (may be empty)
//   fiveHourBucket/weekBucket  { total, remaining, usedRatio?, expiresAt? } or null
//   busy                    a task is known to be running (tasks index)
//   exhaustedSignalAt       ms of the last unscoped hard-quota signal (0 = none)
//   fiveHourSignalAt/weekSignalAt  ms of the last per-pool signal
//   headersAgeMs            age of the captured auth headers (null = none)
//   usesToday, cooldownLeftMs, dailyCapLeft, confirmed, now
function usedRatioOf(bucket) {
  if (!bucket) return null;
  const explicit = num(bucket.usedRatio);
  if (explicit !== null) return Math.max(0, Math.min(1, explicit));
  const total = num(bucket.total), remaining = num(bucket.remaining);
  if (total === null || remaining === null || total <= 0) return null;
  return Math.max(0, Math.min(1, 1 - remaining / total));
}

function decide(i) {
  const no = (reason) => ({ fired: false, reason });
  if (i.mode === 'off') return no('mode off');
  if (i.headersAgeMs === null || i.headersAgeMs > i.headerMaxAgeMs) return no('no fresh auth headers (open the UI once / keep HEADER_MAX_AGE)');
  if (i.dailyCapLeft <= 0) return no('daily cap reached');
  if (!i.confirmed) return no('waiting for /status to confirm the previous use');
  if (i.cooldownLeftMs > 0) return no('cooldown ' + Math.round(i.cooldownLeftMs / 1000) + 's');

  const signalWindow = i.exhaustionSignalMs ?? 15 * 60_000;
  const legacySignalAt = i.exhaustedSignalAt || 0;
  const pools = [
    {
      type: 'FIVE_HOUR', resets: i.fiveHourResets || [], bucket: i.fiveHourBucket,
      minRatio: i.fiveHourMinRatio, expirySoonMs: i.expirySoonFiveHourMs,
      naturalResetFloorMs: i.naturalResetFloorFiveHourMs ?? 30 * 60_000,
      signalAt: Math.max(i.fiveHourSignalAt || 0, legacySignalAt),
    },
    {
      type: 'WEEK', resets: i.weekResets || [], bucket: i.weekBucket,
      minRatio: i.weekMinRatio, expirySoonMs: i.expirySoonWeekMs,
      naturalResetFloorMs: i.naturalResetFloorWeekMs ?? 2 * 3600_000,
      signalAt: Math.max(i.weekSignalAt || 0, legacySignalAt),
    },
  ];
  const pct = (r) => Math.round(r * 100) + '%';
  for (const p of pools) {
    if (!p.resets.length) continue;
    const nextExpire = Math.min(...p.resets);
    const expiringIn = nextExpire - i.now;
    const used = usedRatioOf(p.bucket);
    const hardSignal = p.signalAt > 0 && i.now - p.signalAt < signalWindow;
    const dry = used !== null && used >= 1 - p.minRatio;        // at/below the remaining threshold
    const boneDry = used !== null && used >= 0.999;             // nothing left
    const naturalResetIn = p.bucket && Number.isFinite(p.bucket.expiresAt) ? p.bucket.expiresAt - i.now : null;
    // spending a chance just before the pool refills itself is waste
    const naturalResetSoon = naturalResetIn !== null && naturalResetIn <= p.naturalResetFloorMs;

    if (!naturalResetSoon) {
      // main rule: pool almost gone (predicted) or already gone (hard signal),
      // AND something is running that needs the quota right now
      if (dry && i.busy) {
        return { fired: true, type: p.type, reason: 'pool remaining ' + pct(1 - used) + ' with an active task' };
      }
      // exhaustion rescue: the provider just told the runtime this pool is used
      // up (429 + business code). The operator is blocked *now*, so the matching
      // chance is spent even with nothing running — as long as the pool has
      // enough usage (or is unknown) for the refill to be worth a chance.
      if (hardSignal && (used === null || used >= i.rescueMinUsed)) {
        return { fired: true, type: p.type, reason: 'quota-exhausted signal ' + Math.round((i.now - p.signalAt) / 60_000) + 'min ago'
          + (used === null ? ' (pool usage unknown)' : ', pool ' + pct(used) + ' used') };
      }
      // the original "idle but the pool is empty" case: a bone-dry pool cannot
      // be preserved by waiting, and the natural reset is still far off
      if (i.dryIdle !== false && boneDry) {
        return { fired: true, type: p.type, reason: 'pool exhausted (' + pct(used) + ' used) with '
          + (naturalResetIn === null ? 'no known natural reset' : Math.round(naturalResetIn / 60_000) + 'min until the natural reset') };
      }
    }
    // expiry rescue: the chance lapses soon and the pool has enough usage that a
    // reset is worth something (a nearly-full pool would waste it)
    if (expiringIn <= p.expirySoonMs && !naturalResetSoon && (used === null || used >= i.rescueMinUsed)) {
      return { fired: true, type: p.type, reason: 'chance expires in ' + Math.round(expiringIn / 60_000) + 'min' + (used === null ? '' : ', pool ' + pct(used) + ' used') };
    }
  }
  return no('nothing urgent (idle/pool healthy/chances not expiring)');
}

// ---------- observation ----------
function headerFrom(init, input, name) {
  const sources = [init && init.headers, input && typeof input.headers !== 'undefined' && input.headers];
  for (const h of sources) {
    if (!h) continue;
    if (typeof h.get === 'function') { const v = h.get(name); if (v) return v; continue; }
    if (typeof h === 'object') {
      for (const [k, v] of Object.entries(h)) {
        if (k.toLowerCase() === name && typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  return null;
}

function captureHeaders(url, init, input) {
  if (!/zcode\.z\.ai\//.test(url)) return;
  const auth = headerFrom(init, input, AUTH_HEADER);
  const plan = headerFrom(init, input, PLAN_AUTH_HEADER);
  if (!auth || !plan) return;
  const prevAt = S.headers ? S.headers.at : 0;
  S.headers = {
    at: Date.now(),
    Authorization: auth,
    XBigmodelAuthorization: plan,
    targetType: headerFrom(init, input, 'bigmodel-target-type'),
    organization: headerFrom(init, input, 'bigmodel-organization'),
    project: headerFrom(init, input, 'bigmodel-project'),
  };
  // quiet confirmation that the capture path works in the field (first time and
  // after long gaps only — this runs on every authorized request)
  if (!prevAt || S.headers.at - prevAt > 6 * 3600_000) {
    log('auth headers captured from the runtime\'s own request (' + url.slice(0, 80) + ')');
  }
}

function classifyNamed(b) {
  const label = `${b.show_name || ''} ${Array.isArray(b.capabilities) ? b.capabilities.join(' ') : ''}`;
  if (/5\s*小时|5h|five[- ]?hour/i.test(label)) return 'FIVE_HOUR';
  if (/周|week/i.test(label)) return 'WEEK';
  return null;
}

function classifyByWindow(b, now) {
  const exp = num(b.expires_at);
  if (exp === null) return null;
  const win = exp * (exp > 1e11 ? 1 : 1000) - now;   // balances are unix SECONDS
  if (win > 0 && win <= 6 * 3600_000) return 'FIVE_HOUR';
  if (win > 6 * 3600_000 && win <= 8 * 86400_000) return 'WEEK';
  return null;
}

function classifyBucket(b, now) {
  return classifyNamed(b) || classifyByWindow(b, now);
}

// limits[] pool identity, matched the way the official client matches them
// (renderer DL(): {TOKENS_LIMIT|CREDIT_LIMIT} × unit 3 = the 5h pool,
// × unit 6 = the week pool; TIME_LIMIT × unit 5 is the monthly MCP quota,
// which no reset chance refills — never a target). `number` is a per-window
// constant (5 / 1), NOT the pool size, so it plays no part here.
function classifyLimit(L) {
  const type = typeof L.type === 'string' ? L.type.trim().toUpperCase() : '';
  const unit = num(L.unit);
  if (type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT') {
    if (unit === 3) return 'FIVE_HOUR';
    if (unit === 6) return 'WEEK';
  }
  return null;
}

// 2026-09-19 field truth (GET bigmodel.cn/api/monitor/usage/quota/limit):
//   {type:"CREDIT_LIMIT",unit:3,number:5,usage:12000,currentValue:76,remaining:11923,percentage:1,...}
//   {type:"CREDIT_LIMIT",unit:6,number:1,usage:60000,currentValue:60073,remaining:0,percentage:100,...}
// i.e. usage = the window allowance, currentValue = what was consumed,
// remaining = usage - currentValue, percentage = consumed %. The official UI
// shows "remaining %" as 100 - percentage (renderer kL()), so percentage is
// the authoritative usage figure whenever it is present.
function fieldsFromLimit(L, now) {
  const allowance = num(L.usage);
  const spent = num(L.currentValue);
  let remaining = num(L.remaining);
  if (remaining === null && allowance !== null && spent !== null) remaining = Math.max(0, allowance - spent);
  let pct = num(L.percentage);
  if (pct === null && allowance !== null && allowance > 0) {
    if (spent !== null) pct = (spent / allowance) * 100;
    else if (remaining !== null) pct = 100 - (remaining / allowance) * 100;
  }
  const usedRatio = pct === null ? null : Math.max(0, Math.min(1, pct / 100));
  if (usedRatio === null && (allowance === null || remaining === null)) return null;
  const nextRaw = num(L.nextResetTime);
  const expiresAt = nextRaw === null ? null : nextRaw * (nextRaw > 1e11 ? 1 : 1000);
  return {
    total: allowance,
    remaining,
    usedRatio,
    expiresAt,
    showName: 'limit:' + L.type + (num(L.unit) === null ? '' : '/' + num(L.unit)),
    src: 'limit',
    at: now,
  };
}

async function observeResponse(url, res) {
  let json = null;
  try { json = await res.clone().json(); } catch (_e) { return false; }
  const data = json && typeof json === 'object' && json.data && typeof json.data === 'object' ? json.data : null;
  if (!data) return false;
  let saw = false;
  // remember the exact origin/path the runtime itself uses for pool data, so
  // fetchLimit can replay it verbatim (bigmodel.cn vs api.z.ai differ per env)
  if (/\/api\/monitor\/usage\/quota\/limit/.test(url)) {
    const u = /^(https:\/\/[^/]+\/api\/monitor\/usage\/quota\/limit)/.exec(url);
    if (u && u[1] !== S.limitUrl) S.limitUrl = u[1];
  }
  if (url.indexOf(RESET_BASE + '/status') >= 0 && Array.isArray(data.available_five_hour_resets)) {
    saw = true;
    STATS.statusObservations++;
    S.status = {
      at: Date.now(),
      fiveHourResets: data.available_five_hour_resets.map((o) => num(o && o.expire_at) || 0).filter(Boolean),
      weekResets: (data.available_week_resets || []).map((o) => num(o && o.expire_at) || 0).filter(Boolean),
      lastFiveHourUsedAt: num(data.latest_five_hour_reset_history && data.latest_five_hour_reset_history.used_at),
      lastWeekUsedAt: num(data.latest_week_reset_history && data.latest_week_reset_history.used_at),
    };
    // a fresh status after a use is the confirmation the engine waits for
    if (S.lastUsedAt && S.status.at > S.lastUsedAt) S.confirmed = true;
  }
  // coding-plan pools: GET /api/monitor/usage/quota/limit → data.limits[] (see
  // fieldsFromLimit above for the field truth). limits carry explicit
  // type+unit identities and outrank the balance heuristics below.
  if (Array.isArray(data.limits)) {
    saw = true;
    STATS.limitObservations++;
    const now = Date.now();
    if (!S.buckets) S.buckets = { at: 0 };
    for (const L of data.limits) {
      if (!L || typeof L.type !== 'string') continue;
      const kind = classifyLimit(L);
      const fields = kind ? fieldsFromLimit(L, now) : null;
      if (!fields) { STATS.limitsUnclassified++; continue; }
      S.buckets[kind] = fields;
    }
    S.buckets.at = now;
  }
  if (Array.isArray(data.balances)) {
    saw = true;
    STATS.balanceObservations++;
    const now = Date.now();
    // Named classifications win over window heuristics; within the same kind the
    // bucket expiring SOONEST is the binding constraint.
    const picked = {};
    const consider = (b, named) => {
      const kind = named ? classifyNamed(b) : classifyByWindow(b, now);
      if (!kind) return;
      const total = num(b.total_units), remaining = num(b.remaining_units);
      if (total === null || remaining === null) return;
      const expRaw = num(b.expires_at);
      const expMs = expRaw === null ? null : expRaw * (expRaw > 1e11 ? 1 : 1000);
      const fields = {
        total, remaining,
        usedRatio: total > 0 ? Math.max(0, Math.min(1, 1 - remaining / total)) : null,
        expiresAt: expMs, showName: typeof b.show_name === 'string' ? b.show_name : '',
      };
      const prev = picked[kind];
      if (!prev) { picked[kind] = { ...fields, named }; return; }
      if (prev.named && !named) return;   // a named bucket outranks a heuristic one
      if (named === prev.named && (fields.expiresAt ?? Infinity) < (prev.expiresAt ?? Infinity)) picked[kind] = { ...fields, named };
    };
    for (const b of data.balances) consider(b, true);
    for (const b of data.balances) consider(b, false);
    if (!S.buckets) S.buckets = { at: 0 };
    for (const [kind, fields] of Object.entries(picked)) {
      const existing = S.buckets[kind];
      // a fresh limits[] entry (explicit type) is only displaced by newer limits data
      if (existing && existing.src === 'limit' && now - (existing.at || 0) <= 30 * 60_000) continue;
      const { named: _drop, ...rest } = fields;
      S.buckets[kind] = { ...rest, src: 'balance', at: now };
    }
    S.buckets.at = now;
  }
  return saw;
}

// ---------- authorized calls (header replay — same headers the runtime sent) ----------
function replayHeaders() {
  const h = S.headers;
  if (!h) return null;
  const out = {
    'Authorization': h.Authorization,
    'X-Bigmodel-Authorization': h.XBigmodelAuthorization,
    'Bigmodel-Target-Type': h.targetType || 'PERSONAL',
  };
  if (h.organization) out['Bigmodel-Organization'] = h.organization;
  if (h.project) out['Bigmodel-Project'] = h.project;
  return out;
}

function apiUrl(p) {
  const m = /(https:\/\/[^/]*zcode\.z\.ai)/.exec(process.env.ZCODE_BASE_URL || '') ;
  return (m ? m[1] : 'https://zcode.z.ai') + p;
}

async function fetchStatus() {
  const h = replayHeaders();
  if (!h) return;
  STATS.statusFetches++;
  const res = await fetch(apiUrl(RESET_BASE + '/status'), { method: 'GET', headers: h, signal: AbortSignal.timeout(15_000) });
  await observeResponse(apiUrl(RESET_BASE + '/status'), res);
}

// Pool usage self-refresh (2026-09-28 incident ①): with no UI attached nothing
// re-requests quota/limit, and the engine would keep deciding on stale pool
// data straight through a wall. Replays the same double-JWT headers. The
// endpoint ORIGIN differs per deployment (bigmodel.cn vs api.z.ai), so try the
// learned URL first, then the other known candidate — whichever answers gets
// remembered, and a vendor origin migration self-heals on the next refresh.
// Read-only GET; while the UI IS attached this mostly hits the api-cache-guard
// cache, so it adds no upstream pressure.
const LIMIT_URL_CANDIDATES = [
  'https://bigmodel.cn/api/monitor/usage/quota/limit',
  'https://api.z.ai/api/monitor/usage/quota/limit',
];
async function fetchLimit() {
  const h = replayHeaders();
  if (!h) return;
  const order = S.limitUrl
    ? [S.limitUrl, ...LIMIT_URL_CANDIDATES.filter((u) => u !== S.limitUrl)]
    : LIMIT_URL_CANDIDATES;
  let lastErr = null;
  for (const url of order) {
    STATS.limitFetches++;
    try {
      const res = await fetch(url, { method: 'GET', headers: h, signal: AbortSignal.timeout(15_000) });
      const parsed = await observeResponse(url, res);
      if (res.ok && parsed) {
        if (S.limitUrl !== url) S.limitUrl = url;
        return true;
      }
      lastErr = new Error('HTTP ' + res.status + (parsed ? '' : ' (unparsed body)'));
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no quota/limit endpoint answered');
}

async function useReset(type) {
  const h = replayHeaders();
  if (!h) return { ok: false, error: 'no headers' };
  const idempotencyKey = crypto.randomUUID();
  STATS.usesAttempted++;
  const res = await fetch(apiUrl(RESET_BASE + '/use'), {
    method: 'POST',
    headers: { ...h, 'content-type': 'application/json' },
    body: JSON.stringify({ idempotency_key: idempotencyKey, reset_type: type }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.code !== 0 || !json.data || json.data.used !== true) {
    throw new Error('use failed: HTTP ' + res.status + ' code=' + (json && json.code) + ' msg=' + (json && json.msg));
  }
  // confirm: the chance must leave the status list (a few slow polls)
  for (let delay of [4000, 8000, 15000]) {
    await new Promise((r) => setTimeout(r, delay));
    const before = S.status ? (type === 'FIVE_HOUR' ? S.status.fiveHourResets : S.status.weekResets).length : null;
    await fetchStatus().catch(() => {});
    const list = S.status ? (type === 'FIVE_HOUR' ? S.status.fiveHourResets : S.status.weekResets) : [];
    const hist = S.status ? (type === 'FIVE_HOUR' ? S.status.lastFiveHourUsedAt : S.status.lastWeekUsedAt) : null;
    if ((before !== null && list.length < before) || (hist && hist > S.lastUsedAt)) return { ok: true, confirmed: true };
  }
  return { ok: true, confirmed: false };
}

// ---------- task activity (read-only, same access pattern as the webui reaper) ----------
function refreshBusy() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const zhome = process.env.ZCODE_HOME ? path.join(process.env.ZCODE_HOME) : path.join(require('node:os').homedir(), '.zcode');
    const db = new DatabaseSync(path.join(zhome, 'v2', 'tasks-index.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE task_status = ? AND updated_at > ?')
        .get('running', Date.now() - CFG.activityWindowMs);
      S.busy = (row && row.n) > 0;
      S.busyCount = (row && row.n) || 0;
    } finally { db.close(); }
    S.busyCheckedAt = Date.now();
  } catch (_e) {
    S.busy = false;   // conservative for the main rule; the signal/dry paths do not need it
    S.busyCount = 0;
  }
}

function drainSignals() {
  if (!SIGNALS_FILE) return;
  try {
    const lines = fs.readFileSync(SIGNALS_FILE, 'utf8').trim();
    if (!lines) return;
    fs.writeFileSync(SIGNALS_FILE, '');
    for (const line of lines.split('\n')) {
      try {
        const j = JSON.parse(line);
        if (!j || j.kind !== 'quota-exhausted' || !num(j.at)) continue;
        S.exhaustionAt = Math.max(S.exhaustionAt, j.at);
        const scope = j.scope === 'FIVE_HOUR' || j.scope === 'WEEK' ? j.scope : null;
        if (scope) S.exhaustionByType[scope] = Math.max(S.exhaustionByType[scope], j.at);
        S.lastSignal = { at: j.at, scope: scope || 'ANY', pid: j.pid || null };
        STATS.signals++;
      } catch (_e) { /* malformed line */ }
    }
  } catch (_e) { /* no signals file yet */ }
}

// ---------- engine loop (host process only) ----------
function poolSummary() {
  const one = (kind, label) => {
    const b = S.buckets && S.buckets[kind];
    if (!b) return label + '=?';
    const used = usedRatioOf(b);
    return label + '=' + (used === null ? '?' : (Math.round(used * 1000) / 10) + '%used')
      + (b.remaining === null || b.remaining === undefined ? '' : ' rem ' + b.remaining + '/' + (b.total === null || b.total === undefined ? '?' : b.total));
  };
  return one('FIVE_HOUR', '5h') + ', ' + one('WEEK', 'week');
}

// milestone lines for the observation window: entering the trigger zone,
// hitting the wall, refilling. Logged on TRANSITIONS only, so a draining pool
// produces a short readable trail instead of one noisy line per tick.
function logPoolTransitions(now) {
  for (const kind of ['FIVE_HOUR', 'WEEK']) {
    const b = S.buckets && S.buckets[kind];
    if (!b) continue;
    const used = usedRatioOf(b);
    const rem = num(b.remaining), tot = num(b.total);
    const prev = S.poolSeen[kind];
    const minRatio = kind === 'FIVE_HOUR' ? CFG.fiveHourMinRatio : CFG.weekMinRatio;
    if (prev) {
      const wasZero = prev.rem !== null && prev.rem <= 0;
      const isZero = rem !== null && rem <= 0;
      const natIn = b.expiresAt && Number.isFinite(b.expiresAt) ? Math.round((b.expiresAt - now) / 60000) : null;
      if (!wasZero && isZero) {
        log('POOL ' + kind + ' HIT THE WALL — remaining 0' + (tot !== null ? '/' + tot : '')
          + ', natural reset ' + (natIn === null ? 'unknown' : 'in ' + natIn + 'min')
          + ', busy=' + S.busy + (S.status ? ' (chances ' + kind.toLowerCase() + '='
            + ((kind === 'FIVE_HOUR' ? S.status.fiveHourResets : S.status.weekResets) || []).length + ')' : ''));
      } else if (wasZero && rem !== null && rem > 0) {
        log('pool ' + kind + ' refilled: remaining ' + prev.rem + ' → ' + rem
          + (tot !== null ? '/' + tot : '') + ' — back in service');
      } else if (prev.used !== null && used !== null && prev.used < 1 - minRatio && used >= 1 - minRatio) {
        log('pool ' + kind + ' entering the trigger zone: ' + Math.round(used * 1000) / 10 + '% used'
          + (rem !== null ? ' (' + rem + (tot !== null ? '/' + tot : '') + ' left)' : '')
          + (S.busy ? ' with a task running — the busy trigger is live' : ' (idle — waits for ≤0% or a signal)'));
      }
    }
    S.poolSeen[kind] = { rem, tot, used };
  }
}

let engineRunning = false;
async function tick() {
  if (engineRunning) return;
  engineRunning = true;
  try {
    drainSignals();
    refreshBusy();
    const now = Date.now();
    const mode = effectiveMode();
    // per-pool freshness (NOT buckets.at — that bumps on empty balance arrays
    // too). Blindness must be judged against what the LAST tick saw
    // (S.lastTickPoolAt): if the page load's passive observation refreshed the
    // buckets between ticks, the current value alone would hide the gap.
    const poolEntryAt = (k) => num(S.buckets && S.buckets[k] && S.buckets[k].at) || 0;
    const newestPoolAt = Math.max(poolEntryAt('FIVE_HOUR'), poolEntryAt('WEEK'));
    const prevPoolAt = S.lastTickPoolAt ?? 0;
    const wasBlind = prevPoolAt === 0 || now - prevPoolAt > CFG.reviveGapMs;
    const headersOk = S.headers && now - S.headers.at <= CFG.headerMaxAgeMs;
    const statusStale = !S.status || now - S.status.at > CFG.statusRefreshMs
      || (S.wantStatusRefreshAt && now >= S.wantStatusRefreshAt);
    if (headersOk && statusStale) {
      S.wantStatusRefreshAt = 0;
      await fetchStatus().catch((e) => log('status refresh failed: ' + (e && e.message)));
    }
    // pool self-refresh — only while enabled (an OFF guard polls nothing
    // upstream), tighter while a task is running (that is when a draining
    // pool must be seen in time for the busy trigger)
    if (headersOk && mode !== 'off') {
      const limitStale = now - newestPoolAt > (S.busy ? CFG.tickMs : CFG.limitRefreshMs);
      if (limitStale) {
        await fetchLimit().catch((e) => log('pool refresh failed: ' + (e && e.message)));
      }
    }
    // blind-gap revival → idle-reset grace: the operator just came back (or
    // just flipped the switch on after a long off); give them a beat before
    // any IDLE reset fires. Busy/signal/expiry paths stay immediate.
    let dryHoldMs = 0;
    const newestNow = Math.max(poolEntryAt('FIVE_HOUR'), poolEntryAt('WEEK'));
    S.lastTickPoolAt = newestNow;
    if (wasBlind && newestNow > 0) {
      S.revivedAt = now;
      dryHoldMs = CFG.returnGraceMs;
      log('pool data revived after a blind gap — idle resets hold for '
        + Math.round(CFG.returnGraceMs / 1000) + 's (the operator just came back)');
    } else if (S.revivedAt && now - S.revivedAt < CFG.returnGraceMs) {
      dryHoldMs = CFG.returnGraceMs - (now - S.revivedAt);
    }
    logPoolTransitions(now);

    if (S.usesDay !== dayKey(now)) { S.usesDay = dayKey(now); S.usesToday = 0; }
    const d = decide({
      now, mode,
      fiveHourResets: S.status ? S.status.fiveHourResets : [],
      weekResets: S.status ? S.status.weekResets : [],
      // stale balance data must not drive the predictive trigger — with no UI
      // attached nobody refreshes billing, and an old "5% left" may be long gone
      fiveHourBucket: (S.buckets && now - S.buckets.at <= BUCKET_MAX_AGE_MS && S.buckets.FIVE_HOUR) || null,
      weekBucket: (S.buckets && now - S.buckets.at <= BUCKET_MAX_AGE_MS && S.buckets.WEEK) || null,
      busy: S.busy,
      exhaustedSignalAt: S.exhaustionAt,
      fiveHourSignalAt: S.exhaustionByType.FIVE_HOUR,
      weekSignalAt: S.exhaustionByType.WEEK,
      headersAgeMs: S.headers ? now - S.headers.at : null,
      usesToday: S.usesToday,
      cooldownLeftMs: S.lastUsedAt ? Math.max(0, CFG.cooldownMs - (now - S.lastUsedAt)) : 0,
      dailyCapLeft: CFG.maxUsesPerDay - S.usesToday,
      confirmed: S.confirmed,
      fiveHourMinRatio: CFG.fiveHourMinRatio, weekMinRatio: CFG.weekMinRatio,
      expirySoonFiveHourMs: CFG.expirySoonFiveHourMs, expirySoonWeekMs: CFG.expirySoonWeekMs,
      rescueMinUsed: CFG.rescueMinUsed, headerMaxAgeMs: CFG.headerMaxAgeMs,
      exhaustionSignalMs: CFG.exhaustionSignalMs,
      // idle dry-reset held while the return grace is running (see above);
      // busy/signal/expiry paths below do not consult this flag
      dryIdle: CFG.dryIdle && dryHoldMs <= 0,
      naturalResetFloorFiveHourMs: CFG.naturalResetFloorFiveHourMs,
      naturalResetFloorWeekMs: CFG.naturalResetFloorWeekMs,
    });
    const changed = !S.lastDecision || S.lastDecision.fired !== d.fired || S.lastDecision.reason !== d.reason
      || (now - (S.lastDecision.at || 0) > CFG.logEveryMs);
    S.lastDecision = { at: now, fired: d.fired, type: d.type || null, reason: d.reason };
    if (changed) {
      log((d.fired ? 'DECISION use ' + d.type + ' — ' : 'decision: ') + d.reason
        + ' (chances 5h=' + ((S.status && S.status.fiveHourResets || []).length) + ' week=' + ((S.status && S.status.weekResets || []).length)
        + ', pools ' + poolSummary() + ', busy=' + S.busy + ')'
        + (mode === 'dry-run' ? ' [dry-run: not sending]' : ''));
    }
    if (d.fired) {
      if (mode === 'dry-run') { writeState(); return; }
      S.lastUsedAt = now;
      S.lastUsedType = d.type;
      S.confirmed = false;
      S.usesToday++;
      log('using ' + d.type + ' reset chance (' + d.reason + ') — idempotent POST ' + RESET_BASE + '/use');
      try {
        const r = await useReset(d.type);
        if (r.ok) { STATS.usesConfirmed++; log('use ' + d.type + ' accepted' + (r.confirmed ? ' and confirmed via /status' : ' (status confirmation pending)')); }
      } catch (e) {
        STATS.usesFailed++;
        // Ambiguous outcome: a fresh /status decides whether a chance was really
        // consumed before the engine may consider another use.
        S.wantStatusRefreshAt = Date.now() + 20_000;
        log('use ' + d.type + ' FAILED: ' + (e && e.message) + ' — pausing until the next /status confirms nothing was consumed');
      }
      writeState();
    } else if (changed) {
      writeState();
    }
  } catch (e) {
    log('tick error: ' + (e && e.message));
  } finally {
    engineRunning = false;
  }
}

// ---------- child-process observation (append-only signal sink) ----------
// Scope of a provider quota refusal: 1310 = 每周/每月上限, 1308 = 5 小时上限.
const QUOTA_CODE_SCOPE = { 1308: 'FIVE_HOUR', 1310: 'WEEK' };
const QUOTA_TEXT_RE = /已达到[^"]{0,12}(?:每周|每月|5\s*小时)[^"]{0,12}使用上限|使用上限|额度已用完|余额不足|quota exceeded/i;

// The runtime surfaces "quota used up" as HTTP 429 with an Anthropic-shaped
// body ({"type":"error","error":{"type":"rate_limit_error","code":"1310",…}})
// — the 0.7.1 guard only looked for 402, so it never saw a single signal
// (stats.signals stayed 0 and the exhaustion path was dead code).
async function exhaustionScopeOf(url, res) {
  if (!res || !/bigmodel|z\.ai|zhipu/.test(url)) return null;
  if (res.status === 402) return 'ANY';
  if (res.status !== 429) return null;
  let body = '';
  try {
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > 64 * 1024) return null;
    body = await res.clone().text();
  } catch (_e) { return null; }
  if (body.length > 64 * 1024) body = body.slice(0, 64 * 1024);
  const code = (/"(?:providerCode|code)"\s*:\s*"?(1\d{3})"?/.exec(body) || [])[1]
    || (/\[(1\d{3})\]/.exec(body) || [])[1];
  if (code && QUOTA_CODE_SCOPE[code]) return QUOTA_CODE_SCOPE[code];
  if (code && /rate_limit_error|quota/i.test(body) && QUOTA_TEXT_RE.test(body)) return 'ANY';
  if (QUOTA_TEXT_RE.test(body) && /使用上限|额度已用完|余额不足/.test(body)) return 'ANY';
  return null;
}

function appendSignal(kind, scope) {
  if (!SIGNALS_FILE) return;
  try {
    fs.mkdirSync(path.dirname(SIGNALS_FILE), { recursive: true });
    fs.appendFileSync(SIGNALS_FILE, JSON.stringify({ kind, scope: scope || 'ANY', at: Date.now(), pid: process.pid }) + '\n');
  } catch (_e) { /* signals are best-effort */ }
}

// ---------- install ----------
function install() {
  const downstream = globalThis.fetch;
  if (typeof downstream !== 'function') return;
  globalThis.fetch = async function quotaResetGuardedFetch(input, init) {
    let url = '';
    if (typeof input === 'string') url = input;
    else if (input && typeof input.url === 'string') url = input.url;
    else if (input instanceof URL) url = input.href;
    try { captureHeaders(url, init, input && typeof input === 'object' ? input : null); } catch (_e) { /* never break traffic */ }
    const res = await downstream(input, init);
    try {
      if (OBSERVED_URL_RE.test(url)) await observeResponse(url, res);
      else {
        const scope = await exhaustionScopeOf(url, res);
        if (scope) appendSignal('quota-exhausted', scope);
      }
    } catch (_e) { /* observation must never break traffic */ }
    return res;
  };
}

function start() {
  const isHost = process.argv.some((a) => /zcode-server\.cjs$/.test(a))
    || (process.env.ZCODE_WEBUI_QUOTA_RESET_ROLE || '') === 'host';
  if (globalThis[STATE_KEY]) { log('already installed in this process, nothing to do'); return; }
  globalThis[STATE_KEY] = { cfg: CFG, stats: STATS };
  S.modeSeen = effectiveMode();
  install();
  if (isHost) {
    log('armed (' + S.modeSeen + (readSwitchMode() ? ' ← ui switch' : ' ← env/default') + ') — observes reset/billing traffic, decides every '
      + Math.round(CFG.tickMs / 1000) + 's; thresholds: 5h≤' + CFG.fiveHourMinRatio + ' busy, week≤' + CFG.weekMinRatio
      + ' busy, exhausted-signal rescue ≤' + Math.round(CFG.exhaustionSignalMs / 60000) + 'min'
      + (CFG.dryIdle ? ', bone-dry idle reset' : ', dry-idle off')
      + ', natural-reset floor ' + Math.round(CFG.naturalResetFloorFiveHourMs / 60000) + 'min/'
      + Math.round(CFG.naturalResetFloorWeekMs / 60000) + 'min'
      + ', rescue≤' + Math.round(CFG.expirySoonFiveHourMs / 60000) + 'min/' + Math.round(CFG.expirySoonWeekMs / 60000)
      + 'min with ≥' + CFG.rescueMinUsed + ' used; cap ' + CFG.maxUsesPerDay + '/day'
      + (S.modeSeen === 'off' ? ' (currently disabled — the ♻ web switch or ZCODE_WEBUI_QUOTA_RESET enables it)' : ''));
    const t = setInterval(() => { tick(); }, CFG.tickMs);
    if (t.unref) t.unref();
    const s = setInterval(() => { writeState(); }, 5 * 60_000);
    if (s.unref) s.unref();
    // UI switch watcher: the web panel writes quota-reset-switch.json; pick it
    // up within seconds, log the transition, and run an immediate tick when the
    // guard just woke up (no need to wait for the next cadence slot).
    const w = setInterval(() => {
      const m = effectiveMode();
      if (m === S.modeSeen) return;
      log('mode ' + S.modeSeen + ' → ' + m + ' (ui switch file)');
      S.modeSeen = m;
      writeState();
      if (m !== 'off') tick();
    }, 10_000);
    if (w.unref) w.unref();
  } else {
    log('observer mode (child process ' + process.pid + ') — captures quota-exhaustion signals only');
  }
}

start();

module.exports = {
  cfg: CFG, stats: STATS, decide, classifyBucket, classifyLimit, fieldsFromLimit,
  usedRatioOf, exhaustionScopeOf, apiUrl, readSwitchMode, effectiveMode,
  __state: S, __captureHeaders: captureHeaders, __observeJson: observeResponse,
  __tick: tick, __useReset: useReset, __fetchStatus: fetchStatus, __fetchLimit: fetchLimit,
};
