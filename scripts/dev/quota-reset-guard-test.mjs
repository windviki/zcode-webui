// Offline tests for the quota-reset guard. NOTHING here talks to the real API:
// the module is loaded against a mock globalThis.fetch and a temp stats dir.
//
//   node scripts/dev/quota-reset-guard-test.mjs
//
// When the shell itself runs under the 0.7.0+ host, NODE_OPTIONS preloads the
// guard at process start; the test's mock would then replace the (already
// wrapped) fetch and observe nothing. Re-exec once with the guard stripped.
if (process.env.NODE_OPTIONS && process.env.NODE_OPTIONS.includes('quota-reset-guard')) {
  const { spawnSync } = await import('node:child_process');
  const clean = process.env.NODE_OPTIONS.split(/\s+/).filter((p) => !p.includes('quota-reset-guard')).join(' ');
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, NODE_OPTIONS: clean }, stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}

import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!cond) failures++;
};

const statsDir = mkdtempSync(path.join(tmpdir(), 'quota-reset-test-'));
process.env.ZCODE_WEBUI_GUARD_STATS_DIR = statsDir;
process.env.ZCODE_WEBUI_QUOTA_RESET = 'on';

// ---------- mock upstream (installed BEFORE the guard so it wraps ours) ----------
const calls = [];
const upstream = {
  status: { fiveHour: [], week: [], lastFiveHourUsedAt: 0, lastWeekUsedAt: 0 },
  useResult: { code: 0, data: { used: true } },
};
const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const method = (init && init.method) || 'GET';
  calls.push({ url, method, headers: init && init.headers, body: init && init.body });
  if (url.includes('/api/v1/coding-plan/reset/status')) {
    return jsonResponse({
      code: 0, data: {
        available_five_hour_resets: upstream.status.fiveHour.map((expireAt) => ({ expire_at: expireAt })),
        available_week_resets: upstream.status.week.map((expireAt) => ({ expire_at: expireAt })),
        latest_five_hour_reset_history: upstream.status.lastFiveHourUsedAt ? { used_at: upstream.status.lastFiveHourUsedAt } : null,
        latest_week_reset_history: upstream.status.lastWeekUsedAt ? { used_at: upstream.status.lastWeekUsedAt } : null,
        has_unread_history: false,
      },
    });
  }
  if (url.includes('/api/v1/coding-plan/reset/use')) {
    // a real use consumes the chance, so the confirmation poll succeeds on its
    // first pass (keeps the suite fast without weakening the assertions)
    try {
      const used = JSON.parse((init && init.body) || '{}').reset_type;
      if (used === 'FIVE_HOUR') upstream.status.fiveHour = [];
      if (used === 'WEEK') upstream.status.week = [];
    } catch (_e) { /* ignore */ }
    return jsonResponse(upstream.useResult);
  }
  if (url.includes('/api/v1/zcode-plan/billing/balance')) {
    return jsonResponse({
      code: 0, data: {
        balances: upstream.balances || [],
        plans: [], server_time: Math.floor(Date.now() / 1000),
      },
    });
  }
  if (url.includes('/api/monitor/usage/quota/limit')) {
    return jsonResponse({ code: 0, data: { level: 'max', limits: upstream.limits || [] } });
  }
  if (url.includes('/chat/completions')) {
    return new Response('{"error":"payment required"}', { status: 402 });
  }
  // the provider's real "quota used up" shape: 429 + Anthropic-style body with
  // a business code (1310 = 每周/每月上限, 1308 = 5 小时上限)
  if (url.includes('/api/anthropic')) {
    return new Response(JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', code: '1310', message: '[1310][您已达到每周/每月使用上限，您的限额将在 2026-09-22 21:55:11 重置。][202609190718185d4957e6cd3c4582]' },
      request_id: '202609190718185d4957e6cd3c4582',
    }), { status: 429, headers: { 'content-type': 'application/json' } });
  }
  return jsonResponse({ code: 0, data: null });
};

const guard = require(path.join(ROOT, 'src', 'quota-reset-guard.cjs'));
const { decide, __state: S } = guard;
const now = Date.now();
const H = 3600_000;

// ---------- 1. decision matrix (pure) ----------
const base = {
  now, mode: 'on', busy: false,
  fiveHourResets: [now + 5 * H], weekResets: [now + 24 * H],
  fiveHourBucket: { total: 100, remaining: 50 }, weekBucket: { total: 1000, remaining: 500 },
  exhaustedSignalAt: 0, headersAgeMs: 60_000,
  usesToday: 0, cooldownLeftMs: 0, dailyCapLeft: 6, confirmed: true,
  fiveHourMinRatio: 0.05, weekMinRatio: 0.05,
  expirySoonFiveHourMs: 30 * 60_000, expirySoonWeekMs: 2 * H,
  rescueMinUsed: 0.30, headerMaxAgeMs: 12 * H,
};
const d = (over) => decide({ ...base, ...over });

check('off → never fires', d({ mode: 'off' }).fired === false);
check('no auth headers → never fires', d({ headersAgeMs: null }).fired === false);
check('stale auth headers → never fires', d({ headersAgeMs: 13 * H }).fired === false);
check('daily cap reached → never fires', d({ dailyCapLeft: 0 }).fired === false);
check('unconfirmed previous use → never fires', d({ confirmed: false }).fired === false);
check('cooldown → never fires', d({ cooldownLeftMs: 60_000 }).fired === false);
check('no chances → never fires', d({ fiveHourResets: [], weekResets: [] }).fired === false);
check('idle + healthy pool + chance not expiring → NO reset (the core "don\'t waste" rule)', d({}).fired === false);
check('busy + 5h pool ≤ threshold → fires FIVE_HOUR', d({ busy: true, fiveHourBucket: { total: 100, remaining: 3 } }).type === 'FIVE_HOUR');
check('idle + 5h pool ≤ threshold + chance not expiring → holds', d({ fiveHourBucket: { total: 100, remaining: 3 } }).fired === false);
check('idle + hard exhaustion + chance lapsing soon → salvages', d({ exhaustedSignalAt: now, fiveHourResets: [now + 10 * 60_000] }).type === 'FIVE_HOUR');
check('idle + hard exhaustion (fresh) → rescues even with a long-lived chance (2026-09-19 policy fix)',
  d({ exhaustedSignalAt: now, fiveHourResets: [now + 24 * H] }).type === 'FIVE_HOUR');
check('idle + stale exhaustion signal + near-fresh pool → holds (no reset for a rate-limit blip)',
  d({ exhaustedSignalAt: now - 30 * 60_000, fiveHourResets: [now + 24 * H] }).fired === false);
check('chance lapsing + pool sufficiently used → rescue fires', d({ fiveHourResets: [now + 20 * 60_000], fiveHourBucket: { total: 100, remaining: 40 } }).type === 'FIVE_HOUR');
check('chance lapsing + nearly fresh pool → holds (reset would be wasted)', d({ fiveHourResets: [now + 20 * 60_000], fiveHourBucket: { total: 100, remaining: 95 } }).fired === false);
check('busy + WEEK pool ≤ threshold (5h healthy) → fires WEEK', d({ busy: true, weekBucket: { total: 1000, remaining: 20 } }).type === 'WEEK');
check('week chance lapsing (≤2h) + used enough → rescue fires', d({ weekResets: [now + H], weekBucket: { total: 1000, remaining: 300 } }).type === 'WEEK');
check('week chance lapsing + fresh pool → holds', d({ weekResets: [now + H], weekBucket: { total: 1000, remaining: 950 } }).fired === false);
check('both pools critical → FIVE_HOUR wins (checked first)', d({ busy: true, fiveHourBucket: { total: 100, remaining: 1 }, weekBucket: { total: 1000, remaining: 1 } }).type === 'FIVE_HOUR');
check('unknown pool + busy → only exhaustion/expiry paths apply', d({ busy: true, fiveHourBucket: null, weekBucket: null }).fired === false);
// bone-dry pools: nothing left to preserve, but never just before a free refill
check('bone-dry week pool + idle + natural reset days away → uses the chance',
  d({ weekBucket: { total: 60000, remaining: 0, usedRatio: 1, expiresAt: now + 3 * 86400_000 }, weekResets: [now + 30 * 86400_000] }).type === 'WEEK');
check('bone-dry week pool but natural reset in 10min → holds (the refill is free)',
  d({ weekBucket: { total: 60000, remaining: 0, usedRatio: 1, expiresAt: now + 10 * 60_000 }, weekResets: [now + 30 * 86400_000] }).fired === false);
check('dry-idle rule can be switched off',
  d({ dryIdle: false, weekBucket: { total: 60000, remaining: 0, usedRatio: 1, expiresAt: now + 3 * 86400_000 }, weekResets: [now + 30 * 86400_000] }).fired === false);

// ---------- 1b. live 2026-09-19 scenario (weekly wall, both chances valid) ----------
// Real payload at the moment the writing task was killed:
//   week  60000 allowance / 60073 used / remaining 0 / percentage 100 / reset +3.6d
//   five  12000 allowance /    76 used / remaining 11923 / percentage 1 / reset +5h
//   chances: 1 x 5h and 1 x week, both expiring ~30 days out
const liveWeek = { total: 60000, remaining: 0, usedRatio: 1, expiresAt: now + 3.6 * 86400_000 };
const liveFive = { total: 12000, remaining: 11923, usedRatio: 0.01, expiresAt: now + 5 * H };
const liveChances = [now + 30 * 86400_000];
const live = (over) => d({
  fiveHourResets: liveChances, weekResets: liveChances,
  fiveHourBucket: liveFive, weekBucket: liveWeek, ...over,
});
check('live: idle + drained week pool + 30-day chance → WEEK (the reported miss)', live({}).type === 'WEEK');
check('live: while the task was still running the fixed math fires at ≤5% left',
  d({ busy: true, fiveHourResets: liveChances, weekResets: liveChances, fiveHourBucket: liveFive, weekBucket: { total: 60000, remaining: 3000, usedRatio: 0.95 } }).type === 'WEEK');
check('live: the 0.7.1 math (remaining ÷ number) read that same wall as healthy',
  // the guard stored {total: number = 1, remaining: 2} → ratio 2 → no trigger
  d({ busy: true, fiveHourResets: liveChances, weekResets: liveChances, fiveHourBucket: liveFive, weekBucket: { total: 1, remaining: 2 } }).fired === false);

// ---------- 2. observation through the patched fetch ----------
// authorized status request → headers captured + chances parsed
upstream.status.fiveHour = [now + 5 * H];
upstream.status.week = [now + 48 * H];
await globalThis.fetch('https://zcode.z.ai/api/v1/coding-plan/reset/status', {
  headers: {
    'Authorization': 'Bearer zcode-jwt-test',
    'X-Bigmodel-Authorization': 'Bearer plan-jwt-test',
    'Bigmodel-Target-Type': 'PERSONAL',
  },
});
check('auth headers captured from the runtime\'s own request',
  S.headers && S.headers.Authorization === 'Bearer zcode-jwt-test' && S.headers.XBigmodelAuthorization === 'Bearer plan-jwt-test');
check('/status parsed into chances', S.status && S.status.fiveHourResets.length === 1 && S.status.weekResets.length === 1);

// Headers-instance style capture
await globalThis.fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', {
  headers: new Headers({ 'Authorization': 'Bearer zj2', 'x-bigmodel-authorization': 'Bearer pj2' }),
});
check('Headers-object style auth also captured', S.headers.XBigmodelAuthorization === 'Bearer pj2');

// balance parsing → bucket classification (5h by name, week by name, fallback by window)
upstream.balances = [
  { show_name: '5 小时 Prompt 池', total_units: 100, used_units: 96, remaining_units: 4, expires_at: Math.floor((now + 2 * H) / 1000) },
  { show_name: '周额度', total_units: 1000, used_units: 100, remaining_units: 900, expires_at: Math.floor((now + 3 * 86400_000) / 1000) },
  { show_name: 'mystery', total_units: 10, used_units: 1, remaining_units: 9, expires_at: Math.floor((now + 45 * 60_000) / 1000) },
];
await globalThis.fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', { headers: { Authorization: 'Bearer zj3', 'X-Bigmodel-Authorization': 'Bearer pj3' } });
check('5h bucket classified by name + numbers recorded', S.buckets.FIVE_HOUR && S.buckets.FIVE_HOUR.remaining === 4 && S.buckets.FIVE_HOUR.total === 100);
check('week bucket classified by name', S.buckets.WEEK && S.buckets.WEEK.remaining === 900);
check('named 5h bucket outranks the unnamed short-window bucket', S.buckets.FIVE_HOUR.remaining === 4 && S.buckets.FIVE_HOUR.showName.includes('5 小时'));
// fallback heuristics only fill kinds with no named bucket
upstream.balances = [
  { show_name: '', total_units: 50, used_units: 10, remaining_units: 40, expires_at: Math.floor((now + 90 * 60_000) / 1000) },
];
await globalThis.fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', { headers: { Authorization: 'Bearer zj4', 'X-Bigmodel-Authorization': 'Bearer pj4' } });
check('unnamed short-window bucket fills FIVE_HOUR when no named one exists', S.buckets.FIVE_HOUR && S.buckets.FIVE_HOUR.remaining === 40,
  'remaining=' + (S.buckets.FIVE_HOUR && S.buckets.FIVE_HOUR.remaining));

// 402 model call → exhaustion signal file appended (child observer path)
await globalThis.fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer x' } });
const signalFile = path.join(statsDir, 'quota-reset-signals.log');
check('402 model response appends an exhaustion signal', existsSync(signalFile) && /quota-exhausted/.test(readFileSync(signalFile, 'utf8')));

// pass-through integrity: unobserved URL returns the exact response untouched
const passthrough = await globalThis.fetch('https://example.com/none');
check('unrelated traffic passes through untouched', passthrough.ok && (await passthrough.json()).code === 0);

// coding-plan pools come from /api/monitor/usage/quota/limit → data.limits[].
// Shape + numbers are the real 2026-09-19 field capture (the weekly pool already
// drained: 60073 used of a 60000 allowance).
upstream.limits = [
  { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 76, remaining: 11923, percentage: 1, nextResetTime: now + 5 * H },
  { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, currentValue: 0, remaining: 100, percentage: 0, nextResetTime: now + 12 * 86400_000 },
  { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 60073, remaining: 0, percentage: 100, nextResetTime: now + 3.6 * 86400_000 },
];
await globalThis.fetch('https://bigmodel.cn/api/monitor/usage/quota/limit', { headers: { Authorization: 'Bearer zj5', 'X-Bigmodel-Authorization': 'Bearer pj5' } });
check('limits[] 5h pool keyed by unit 3, sized by usage (not number)', S.buckets.FIVE_HOUR && S.buckets.FIVE_HOUR.total === 12000 && S.buckets.FIVE_HOUR.usedRatio === 0.01 && S.buckets.FIVE_HOUR.src === 'limit');
check('limits[] week pool keyed by unit 6, drained state preserved', S.buckets.WEEK && S.buckets.WEEK.total === 60000 && S.buckets.WEEK.usedRatio === 1 && S.buckets.WEEK.remaining === 0);
check('limits[] monthly TIME_LIMIT is not mistaken for a reset target', guard.classifyLimit({ type: 'TIME_LIMIT', unit: 5, number: 1 }) === null);
check('fieldsFromLimit never uses number as the pool size', guard.fieldsFromLimit({ type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 2, remaining: 2, percentage: 0.003 }, now).total === 60000);
check('the real drained week pool + a running task fires WEEK', 
  d({ busy: true, weekBucket: S.buckets.WEEK, fiveHourBucket: S.buckets.FIVE_HOUR, weekResets: [now + 30 * 86400_000] }).type === 'WEEK');
// limits[] outrank subsequent balance heuristics for the same kind
upstream.balances = [{ show_name: '', total_units: 10, used_units: 1, remaining_units: 9, expires_at: Math.floor((now + 30 * 60_000) / 1000) }];
await globalThis.fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', { headers: { Authorization: 'Bearer zj6', 'X-Bigmodel-Authorization': 'Bearer pj6' } });
check('fresh limits[] entry not displaced by balance heuristics', S.buckets.FIVE_HOUR.remaining === 11923 && S.buckets.FIVE_HOUR.src === 'limit');

// provider quota refusal (the real wall): 429 + business code → scoped signal
const quota429 = (code, message) => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', code, message } }), { status: 429 });
check('429 + code 1310 → WEEK-scoped signal', await guard.exhaustionScopeOf('https://open.bigmodel.cn/api/anthropic', quota429('1310', '[1310][您已达到每周/每月使用上限，您的限额将在 2026-09-22 21:55:11 重置。]')) === 'WEEK');
check('429 + code 1308 → FIVE_HOUR-scoped signal', await guard.exhaustionScopeOf('https://open.bigmodel.cn/api/anthropic', quota429('1308', '[1308][已达到 5 小时的使用上限。]')) === 'FIVE_HOUR');
check('plain 429 rate limit (RPM) → no signal', await guard.exhaustionScopeOf('https://open.bigmodel.cn/api/anthropic', quota429(undefined, 'too many requests')) === null);
check('non-quota failure (502) → no signal', await guard.exhaustionScopeOf('https://zcode.z.ai/api/v1/mcp/usage', new Response('{}', { status: 502 })) === null);
check('429 text-only quota message → unscoped signal', await guard.exhaustionScopeOf('https://open.bigmodel.cn/api/anthropic', new Response('{"msg":"您的额度已用完"}', { status: 429 })) === 'ANY');
// …and the child-observer path writes it to the signal file the host drains
await globalThis.fetch('https://open.bigmodel.cn/api/anthropic/v1/messages', { method: 'POST', headers: { authorization: 'Bearer x' }, body: '{}' });
check('429 wall appends a WEEK-scoped signal for the host', existsSync(signalFile) && /"scope":"WEEK"/.test(readFileSync(signalFile, 'utf8')));

// ---------- 3. executor: header replay + idempotency + confirmation ----------
calls.length = 0;
upstream.status.fiveHour = [now + 5 * H];
await guard.__fetchStatus();
upstream.status.fiveHour = [now + 5 * H];   // consume below
const useCallCountBefore = calls.filter((c) => c.url.includes('/reset/use')).length;
const result = await guard.__useReset('FIVE_HOUR');
const useCalls = calls.filter((c) => c.url.includes('/reset/use'));
check('/use sent exactly once', useCalls.length === useCallCountBefore + 1);
const useBody = JSON.parse(useCalls[useCalls.length - 1].body);
check('idempotency key is a ≤64-char uuid', /^[0-9a-f-]{36}$/.test(useBody.idempotency_key) && useBody.idempotency_key.length <= 64);
check('reset_type relayed', useBody.reset_type === 'FIVE_HOUR');
const uh = useCalls[useCalls.length - 1].headers;
check('auth headers replayed for /use (latest captured pair)', uh.Authorization === 'Bearer zj6' && uh['X-Bigmodel-Authorization'] === 'Bearer pj6' && uh['Bigmodel-Target-Type'] === 'PERSONAL');
check('content-type json on /use', (uh['content-type'] || uh['Content-Type'] || '').includes('application/json'));
check('use accepted', result.ok === true);

// ---------- 4. end-to-end: child 429 signal → host drain → /use → state file ----------
// This is the live 2026-09-19 shape: the 429 wall left a WEEK signal on disk, the
// week pool is drained to 100%, and nothing is running (idle rescue path).
calls.length = 0;
S.lastDecision = null;
await guard.__tick();
const weekUses = calls.filter((c) => c.url.includes('/reset/use'));
check('end-to-end: child 429 signal + drained week pool → WEEK reset sent once',
  weekUses.length === 1 && JSON.parse(weekUses[0].body).reset_type === 'WEEK',
  'use calls=' + weekUses.length);
check('the fired use was confirmed by a fresh /status', S.confirmed === true && S.lastUsedType === 'WEEK' && S.usesToday === 1);
// let the engine settle on a non-firing decision so the state file is rewritten
S.lastDecision = null;
await guard.__tick();
const stateFile = path.join(statsDir, 'quota-reset-guard.json');
check('state file written for /api/health', existsSync(stateFile));
const stateJson = JSON.parse(readFileSync(stateFile, 'utf8'));
check('state file carries chances + decision', stateJson.status && Array.isArray(stateJson.status.fiveHourResets) && stateJson.lastDecision && typeof stateJson.lastDecision.fired === 'boolean');
check('state file carries pool usage ratios + exhaustion signals for triage',
  stateJson.buckets && stateJson.buckets.WEEK && stateJson.buckets.WEEK.usedRatio === 1 && stateJson.exhaustion && typeof stateJson.exhaustion.byType.WEEK === 'number');

// ---------- 4b. runtime switch file (the ♻ web chip) ----------
// Precedence: switch file > env baseline; default (neither) = off. The engine
// must consult the file on every tick, not the env snapshot taken at load.
const switchFile = path.join(statsDir, 'quota-reset-switch.json');
const writeSwitch = (mode, extra = '') => writeFileSync(switchFile, '{"at":' + Date.now() + ',"mode":"' + mode + '"' + extra + '}\n');
const useCallCount = () => calls.filter((c) => c.url.includes('/reset/use')).length;

writeSwitch('off');
check('switch file off outranks env on', guard.effectiveMode() === 'off');
S.lastDecision = null;
calls.length = 0;
await guard.__tick();
check('tick with switch off decides "mode off" and sends nothing',
  S.lastDecision && S.lastDecision.fired === false && S.lastDecision.reason === 'mode off' && useCallCount() === 0,
  'reason=' + (S.lastDecision && S.lastDecision.reason) + ' uses=' + useCallCount());
const offState = JSON.parse(readFileSync(stateFile, 'utf8'));
check('state file reports the effective (switch) mode', offState.mode === 'off');

writeSwitch('dry-run');
check('switch file dry-run recognized', guard.effectiveMode() === 'dry-run');
writeFileSync(switchFile, '{"at":' + Date.now() + ',"mode":"bogus"}\n');
check('invalid switch file falls back to the env baseline', guard.effectiveMode() === 'on');
rmSync(switchFile, { force: true });
check('removed switch file falls back to the env baseline', guard.effectiveMode() === 'on');

// ---------- 5. mode behaviours via fresh subprocesses ----------
const probe = (env, script) => new Promise((resolve) => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, ...env, ZCODE_WEBUI_GUARD_STATS_DIR: statsDir },
    encoding: 'utf8', timeout: 30000,
  });
  resolve({ status: r.status, out: (r.stdout || '') + (r.stderr || '') });
});

const dryHome = mkdtempSync(path.join(tmpdir(), 'quota-reset-home-'));
mkdirSync(path.join(dryHome, 'v2'), { recursive: true });
{
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dryHome, 'v2', 'tasks-index.sqlite'));
  db.exec('CREATE TABLE tasks (task_status TEXT, updated_at INTEGER)');
  db.prepare('INSERT INTO tasks VALUES (?, ?)').run('running', Date.now());
  db.close();
}
const dry = await probe({
  ZCODE_WEBUI_QUOTA_RESET: 'dry-run', ZCODE_WEBUI_QUOTA_RESET_ROLE: 'host',
  ZCODE_WEBUI_QUOTA_RESET_TICK_MS: '3600000', ZCODE_HOME: dryHome,
}, `
  const g = require(${JSON.stringify(path.join(ROOT, 'src', 'quota-reset-guard.cjs'))});
  const S = g.__state;
  const now = Date.now();
  S.headers = { at: now, Authorization: 'Bearer a', XBigmodelAuthorization: 'Bearer b', targetType: 'PERSONAL' };
  S.status = { at: now - 60000, fiveHourResets: [now + 3600000], weekResets: [], lastFiveHourUsedAt: 0, lastWeekUsedAt: 0 };
  S.buckets = { at: now, FIVE_HOUR: { total: 100, remaining: 2 } };
  S.busy = true; S.confirmed = true; S.usesToday = 0; S.lastUsedAt = 0;
  // hard network isolation: every fetch the engine makes is answered locally
  globalThis.__sent = [];
  globalThis.fetch = async (u) => {
    const s = String(u);
    globalThis.__sent.push(s);
    const hdrs = { 'content-type': 'application/json' };
    if (s.includes('/reset/use')) return new Response('{"code":0,"data":{"used":true}}', { status: 200, headers: hdrs });
    if (s.includes('/reset/status')) return new Response(JSON.stringify({ code: 0, data: { available_five_hour_resets: [], available_week_resets: [], latest_five_hour_reset_history: null, latest_week_reset_history: null, has_unread_history: false } }), { status: 200, headers: hdrs });
    return new Response('{}', { status: 200, headers: hdrs });
  };
  g.__tick().then(() => {
    console.log('DECISION=' + JSON.stringify(S.lastDecision));
    console.log('SENT=' + JSON.stringify(globalThis.__sent.filter((u) => u.includes('/reset/use'))));
    console.log('BUSY=' + S.busy);
  });
`);
check('dry-run decides to fire but sends NOTHING to /use', /DECISION=\{"at":\d+,"fired":true/.test(dry.out) && /SENT=\[\]/.test(dry.out), dry.out.split('\n').filter((l) => /DECISION|SENT|BUSY/.test(l)).join(' | ').slice(0, 200));
check('task activity read from the (synthetic) tasks index', /BUSY=true/.test(dry.out));

const dflt = await probe({ ZCODE_WEBUI_QUOTA_RESET: '' }, `
  const g = require(${JSON.stringify(path.join(ROOT, 'src', 'quota-reset-guard.cjs'))});
  console.log('MODE=' + g.effectiveMode());
`);
check('no env + no switch file → the default is now OFF (opt-in)', dflt.status === 0 && /MODE=off/.test(dflt.out), dflt.out.trim().slice(-80));

// off is no longer "don't even load": the guard installs itself (so the web ♻
// chip can wake it) and holds fire; flipping the switch file mid-run must take
// effect on the very next tick, without a respawn.
const offOn = await probe({
  ZCODE_WEBUI_QUOTA_RESET: 'off', ZCODE_WEBUI_QUOTA_RESET_ROLE: 'host',
}, `
  const fs = require('node:fs');
  const g = require(${JSON.stringify(path.join(ROOT, 'src', 'quota-reset-guard.cjs'))});
  const S = g.__state;
  const now = Date.now();
  S.headers = { at: now, Authorization: 'Bearer a', XBigmodelAuthorization: 'Bearer b', targetType: 'PERSONAL' };
  S.status = { at: now, fiveHourResets: [now + 3600000], weekResets: [], lastFiveHourUsedAt: 0, lastWeekUsedAt: 0 };
  // bone-dry 5h pool with the natural reset days away: would fire if enabled
  S.buckets = { at: now, FIVE_HOUR: { total: 100, remaining: 0, usedRatio: 1, expiresAt: now + 3 * 86400000 } };
  S.busy = false; S.confirmed = true; S.usesToday = 0; S.lastUsedAt = 0;
  globalThis.__sent = [];
  globalThis.fetch = async (u) => {
    const s = String(u);
    globalThis.__sent.push(s);
    const hdrs = { 'content-type': 'application/json' };
    if (s.includes('/reset/use')) return new Response('{"code":0,"data":{"used":true}}', { status: 200, headers: hdrs });
    if (s.includes('/reset/status')) return new Response(JSON.stringify({ code: 0, data: { available_five_hour_resets: [], available_week_resets: [], latest_five_hour_reset_history: null, latest_week_reset_history: null, has_unread_history: false } }), { status: 200, headers: hdrs });
    return new Response('{}', { status: 200, headers: hdrs });
  };
  (async () => {
    await g.__tick();
    console.log('OFF_DECISION=' + JSON.stringify(S.lastDecision && S.lastDecision.reason));
    console.log('OFF_SENT=' + JSON.stringify(globalThis.__sent.filter((u) => u.includes('/reset/use'))));
    // the web panel's ♻ chip writes the switch file — the running engine must pick it up
    fs.writeFileSync(process.env.ZCODE_WEBUI_GUARD_STATS_DIR + '/quota-reset-switch.json', JSON.stringify({ at: Date.now(), mode: 'on', by: 'ui' }));
    S.lastDecision = null;
    globalThis.__sent = [];
    await g.__tick();
    console.log('ON_DECISION=' + JSON.stringify(S.lastDecision));
    console.log('ON_SENT=' + JSON.stringify(globalThis.__sent.filter((u) => u.includes('/reset/use'))));
  })();
`);
check('baseline off: engine installed, would-fire state still holds fire',
  /OFF_DECISION="mode off"/.test(offOn.out) && /OFF_SENT=\[\]/.test(offOn.out),
  offOn.out.split('\n').filter((l) => /OFF_/.test(l)).join(' | ').slice(0, 160));
check('switch file flipped ON mid-run fires on the next tick (no respawn)',
  /ON_DECISION=\{"at":\d+,"fired":true,"type":"FIVE_HOUR"/.test(offOn.out),
  offOn.out.split('\n').filter((l) => /ON_/.test(l)).join(' | ').slice(0, 200));
check('the woken engine sent exactly one /use', /ON_SENT=\["https:\/\/[^"]*\/reset\/use"\]/.test(offOn.out),
  offOn.out.split('\n').filter((l) => /ON_SENT/.test(l)).join(' | ').slice(0, 160));

// ---------- cleanup ----------
rmSync(statsDir, { recursive: true, force: true });
console.log(failures === 0 ? '\nall quota-reset guard checks passed' : '\n' + failures + ' check(s) FAILED');
process.exit(failures === 0 ? 0 : 1);
