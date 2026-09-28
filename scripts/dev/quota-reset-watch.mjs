// Live observer for the quota-reset guard — built for watching a real quota
// wall (e.g. the 2026-09-28 weekly wall) verify the corrected behavior:
//
//   node scripts/dev/quota-reset-watch.mjs [intervalSec]
//
// Prints the full guard state once, then every poll prints
//   · guard/decision/use/mode/pool CHANGES (state file diff)
//   · every new [quota-reset] / quota-reset-guard log line (log tail)
// Milestones worth watching for:
//   'entering the trigger zone'  pool dropped to ≤ the remaining threshold
//   'POOL … HIT THE WALL'        remaining hit 0 — the rescue must fire next
//   'DECISION use …' / 'using … reset chance' + 'accepted and confirmed'
//   'pool … refilled: remaining 0 → N'    proof the reset landed
// If none of that appears at the wall: 'decision:' lines every ~5min show why.
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '../../src/dirs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PATHS = resolvePaths(ROOT);
const STATE = path.join(PATHS.dataHome, 'data', 'guard-stats', 'quota-reset-guard.json');
const SWITCH = path.join(PATHS.dataHome, 'data', 'guard-stats', 'quota-reset-switch.json');
const LOG = path.join(PATHS.dataHome, 'zcode-webui.log');
const POLL_MS = Math.max(3, Number(process.argv[2] || 10)) * 1000;

const ts = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-GB', { hour12: false });
  return d.toDateString() === new Date().toDateString()
    ? time
    : d.toLocaleDateString('en-GB', { month: '2-digit', day: '2-digit' }) + ' ' + time;
};
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch (_e) { return null; } };

function poolLine(j) {
  const one = (b, label) => {
    if (!b) return label + '=?';
    const used = typeof b.usedRatio === 'number' ? Math.round(b.usedRatio * 1000) / 10 + '%' : '?';
    const nat = b.expiresAt ? ' resets ' + ts(b.expiresAt) : '';
    return label + ' ' + used + ' used (' + (b.remaining ?? '?') + '/' + (b.total ?? '?') + nat + ')';
  };
  return one(j.buckets && j.buckets.FIVE_HOUR, '5h') + '  |  ' + one(j.buckets && j.buckets.WEEK, 'week');
}

const fmt = (j) => {
  if (!j) return '(no guard state file yet — host not spawned since restart?)';
  const s = j.status || {};
  return [
    'mode      : ' + j.mode + '  (pid ' + j.pid + ', state ' + ts(j.at) + ')',
    'pools     : ' + poolLine(j),
    'chances   : 5h×' + ((s.fiveHourResets || []).length) + ' week×' + ((s.weekResets || []).length) + '  (status ' + ts(s.at) + ')',
    'busy      : ' + j.busy + '   usesToday: ' + (j.usesToday ?? '?') + (j.lastUsedAt ? '  (last ' + j.lastUsedType + ' ' + ts(j.lastUsedAt) + ', confirmed=' + j.confirmed + ')' : ''),
    'decision  : ' + (j.lastDecision ? (j.lastDecision.fired ? 'FIRE ' + j.lastDecision.type + ' — ' : 'hold — ') + j.lastDecision.reason + '  @' + ts(j.lastDecision.at) : '—'),
    'stats     : statusFetches=' + (j.stats && j.stats.statusFetches) + ' limitFetches=' + (j.stats && j.stats.limitFetches)
      + ' signals=' + (j.stats && j.stats.signals) + ' used=' + (j.stats && j.stats.usesConfirmed) + '/' + (j.stats && j.stats.usesAttempted),
  ].join('\n');
};

// ---- initial dump ----
const sw = readJson(SWITCH);
console.log('== quota-reset guard watch ==  ' + new Date().toISOString() + '  (poll ' + POLL_MS / 1000 + 's, Ctrl-C to stop)');
console.log('switch    : ' + (sw ? sw.mode + ' (by ' + (sw.by || '?') + ' at ' + ts(sw.at) + ')' : '(no switch file → env/default = off)'));
console.log(fmt(readJson(STATE)));
console.log('log tail  : ' + LOG);
console.log('---');

// ---- log tail (only quota-reset lines) ----
// NB: readFileSync ignores {start,end} on this Node — read positioned chunks
// through an fd instead, or every tick would re-scan the whole 40MB log.
let logOffset = 0;
try { logOffset = statSync(LOG).size; } catch (_e) { logOffset = 0; }
function readChunk(from, len) {
  const fd = openSync(LOG, 'r');
  try {
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.toString('utf8', 0, read);
  } finally { closeSync(fd); }
}
function tailLog() {
  try {
    const st = statSync(LOG);
    if (st.size < logOffset) logOffset = 0;             // rotated/truncated
    if (st.size === logOffset) return;
    const chunk = readChunk(logOffset, st.size - logOffset);
    logOffset = st.size;
    for (const line of chunk.split('\n')) {
      if (line.includes('[quota-reset]') || line.includes('quota-reset-guard:')) {
        console.log(ts(Date.now()) + ' | ' + line.replace(/^\[host:stderr\] /, '').slice(0, 240));
      }
    }
  } catch (_e) { /* file gone mid-read */ }
}

// ---- state diff ----
let prev = readJson(STATE);
let prevSwitch = readJson(SWITCH);
function diffState() {
  const swNow = readJson(SWITCH);
  if (JSON.stringify(swNow) !== JSON.stringify(prevSwitch)) {
    console.log(ts(Date.now()) + ' | [switch] ' + (swNow ? swNow.mode + ' (by ' + (swNow.by || '?') + ')' : '(file removed)'));
    prevSwitch = swNow;
  }
  const now = readJson(STATE);
  if (!now || !prev) { prev = now; return; }
  const changes = [];
  if (now.mode !== prev.mode) changes.push('mode ' + prev.mode + '→' + now.mode);
  if (now.busy !== prev.busy) changes.push('busy ' + prev.busy + '→' + now.busy);
  const dec = (x) => x && x.lastDecision ? (x.lastDecision.fired ? 'FIRE' : 'hold') + ':' + x.lastDecision.reason : '';
  if (dec(now) !== dec(prev)) changes.push('decision → ' + (now.lastDecision ? (now.lastDecision.fired ? 'FIRE ' + now.lastDecision.type + ' ' : '') + now.lastDecision.reason : '—'));
  if ((now.usesToday ?? 0) > (prev.usesToday ?? 0)) changes.push('USE #' + now.usesToday + ' (' + now.lastUsedType + ' at ' + ts(now.lastUsedAt) + ', confirmed=' + now.confirmed + ')');
  const pool = (x, k) => { const b = x.buckets && x.buckets[k]; return b ? (b.remaining ?? '?') + '/' + (b.total ?? '?') + ' ' + Math.round((b.usedRatio ?? 0) * 100) + '%' : '?'; };
  for (const k of ['FIVE_HOUR', 'WEEK']) if (pool(now, k) !== pool(prev, k)) changes.push(k.toLowerCase() + ' ' + pool(prev, k) + ' → ' + pool(now, k));
  const ch = (x, k) => { const s = x.status || {}; return (s[k] || []).length; };
  for (const k of ['fiveHourResets', 'weekResets']) if (ch(now, k) !== ch(prev, k)) changes.push('chances.' + k + ' ' + ch(prev, k) + '→' + ch(now, k));
  if (changes.length) console.log(ts(Date.now()) + ' | ' + changes.join('   '));
  prev = now;
}

setInterval(() => { tailLog(); diffState(); }, POLL_MS);
tailLog();
