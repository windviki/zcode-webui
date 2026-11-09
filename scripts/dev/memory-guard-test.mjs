// Unit tests for the host memory guard (src/memory-guard.mjs) and the Buffer
// attribution preload (src/memory-attribution-guard.cjs).
//
// Two things are covered for the guard:
//   * the proportional threshold resolver — thresholds must scale with the
//     machine (Ram/swap totals), with absolute floors only for tiny boxes;
//   * the decision function — warn vs reclaim vs nothing, cooldown, swap
//     counting as free memory, fail-safe when /proc/meminfo is unreadable.
//
// The attribution guard is a preload, so — like api-cache-guard-test — the test
// drives it the way the host loads it: a child Node process started with
// `--require <guard>`.
//
// Usage: node scripts/dev/memory-guard-test.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideMemoryAction, createMemoryGuard, resolveMemoryThresholds,
  sampleSystemMemory, sampleHostRssMb, collectHostPids,
} from '../../src/memory-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(HERE, '..', '..', 'src', 'memory-attribution-guard.cjs');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok || detail === undefined ? '' : '  [' + detail + ']'));
}

// Absolute thresholds used by the decision-matrix cases (the resolver has its
// own cases below; these keep the decision matrix readable).
const TH = {
  enabled: true,
  intervalMs: 15000,
  warnRssMb: 1536,
  warnRepeatMs: 300000,
  killRssMb: 1024,
  minAvailMb: 1024,
  hardRssMb: 3072,
  softAvailMb: 2048,
  cooldownMs: 300000,
};
// Ratio policy identical to memoryGuardConfig() defaults.
const POLICY = {
  availPct: 0.10,
  softAvailPct: 0.18,
  warnRssPct: 0.06,
  killRssPct: 0.08,
  hardRssPct: 0.20,
  warnRssMbFloor: 768, killRssMbFloor: 768, hardRssMbFloor: 2048,
  minAvailMbFloor: 512, softAvailMbFloor: 1024,
  warnRssMbOverride: null, killRssMbOverride: null, hardRssMbOverride: null,
  minAvailMbOverride: null, softAvailMbOverride: null,
};
const THIS_BOX = { memTotalMb: 15480, swapTotalMb: 10240, memAvailableMb: 2300, swapFreeMb: 0 };
const T0 = 1_700_000_000_000;
const base = { now: T0, lastReclaimAt: 0, lastWarnAt: 0, swapFreeMb: 0 };

// ---- proportional thresholds --------------------------------------------
{
  const t = resolveMemoryThresholds(POLICY, THIS_BOX);
  check('ratio resolver: this box (15480MB RAM + 10240MB swap)',
    t.warnRssMb === 929 && t.killRssMb === 1238 && t.hardRssMb === 3096 &&
    t.minAvailMb === 2572 && t.softAvailMb === 4630,
    JSON.stringify(t));
}
{
  const t = resolveMemoryThresholds(POLICY, { memTotalMb: 32768, swapTotalMb: 0 });
  check('ratio resolver: 32GB box scales up',
    t.hardRssMb === 6554 && t.killRssMb === 2621 && t.minAvailMb === 3277,
    JSON.stringify(t));
}
{
  const t = resolveMemoryThresholds(POLICY, { memTotalMb: 4096, swapTotalMb: 0 });
  check('ratio resolver: 4GB box falls back to floors',
    t.warnRssMb === 768 && t.killRssMb === 768 && t.hardRssMb === 2048 &&
    t.minAvailMb === 512 && t.softAvailMb === 1024,
    JSON.stringify(t));
}
{
  const t = resolveMemoryThresholds({ ...POLICY, killRssMbOverride: 4000, minAvailMbOverride: 3000 }, THIS_BOX);
  check('ratio resolver: explicit *_MB overrides win',
    t.killRssMb === 4000 && t.minAvailMb === 3000 && t.warnRssMb === 929,
    JSON.stringify(t));
}
{
  const t = resolveMemoryThresholds(POLICY, null);
  check('ratio resolver: unknown machine → floors (warn-only upstream)',
    t.ramMb === null && t.minAvailMb === 512 && t.killRssMb === 768,
    JSON.stringify(t));
}

// ---- decision function ---------------------------------------------------
{
  const d = decideMemoryAction({ ...base, hosts: [], memAvailableMb: 8000 }, TH);
  check('no hosts → no action', d.action === 'none', d.action);
}
{
  const d = decideMemoryAction({ ...base, hosts: [{ pid: 1, rssMb: 400 }], memAvailableMb: 8000 }, TH);
  check('healthy host + plenty of memory → no action', d.action === 'none', d.action);
}
{
  const d = decideMemoryAction({ ...base, hosts: [{ pid: 1, rssMb: 1700 }], memAvailableMb: 8000 }, TH);
  check('large host + plenty of memory → warn only (never kills)', d.action === 'warn' && d.pid === 1, d.action);
}
{
  const d = decideMemoryAction({ ...base, now: T0 + 1000, lastWarnAt: T0, hosts: [{ pid: 1, rssMb: 1700 }], memAvailableMb: 8000 }, TH);
  check('warn is throttled by warnRepeatMs', d.action === 'none', d.action);
}
{
  const d = decideMemoryAction({ ...base, hosts: [{ pid: 7, rssMb: 1200 }], memAvailableMb: 900 }, TH);
  check('low free memory + hog host → reclaim', d.action === 'reclaim' && d.pid === 7, d.action);
}
{
  const d = decideMemoryAction({ ...base, now: T0 + 60_000, lastReclaimAt: T0, hosts: [{ pid: 7, rssMb: 1200 }], memAvailableMb: 900 }, TH);
  check('reclaim respects cooldown', d.action === 'none', d.action);
}
{
  // swap counts as free memory: the box is low on RAM but has headroom in swap.
  const d = decideMemoryAction({ ...base, hosts: [{ pid: 7, rssMb: 1200 }], memAvailableMb: 900, swapFreeMb: 400 }, TH);
  check('swap free memory is counted before reclaiming', d.action === 'none', d.action + ' ' + d.reason);
}
{
  const d = decideMemoryAction({ ...base, hosts: [{ pid: 9, rssMb: 3500 }], memAvailableMb: 1500 }, TH);
  check('absurd host + tight memory → reclaim (hard cap)', d.action === 'reclaim' && d.pid === 9, d.action);
}
{
  const d = decideMemoryAction({ ...base, hosts: [{ pid: 9, rssMb: 3500 }], memAvailableMb: 2600 }, TH);
  check('absurd host + still-fine memory → warn, not reclaim', d.action === 'warn', d.action);
}
{
  const d = decideMemoryAction({ ...base, hosts: [{ pid: 1, rssMb: 300 }, { pid: 2, rssMb: 2200 }, { pid: 3, rssMb: 900 }], memAvailableMb: 700 }, TH);
  check('picks the biggest host', d.action === 'reclaim' && d.pid === 2, d.action + ' pid=' + d.pid);
}
{
  const d = decideMemoryAction({ ...base, hosts: [{ pid: 1, rssMb: 2000 }], memAvailableMb: null }, TH);
  check('unreadable /proc/meminfo → never reclaim (fail-safe: warn only)', d.action === 'warn', d.action);
}
{
  const d = decideMemoryAction({ ...base, hosts: [{ pid: 1, rssMb: 2000 }], memAvailableMb: null }, { ...TH, warnRssMb: 99999 });
  check('unknown system memory + no warn threshold → no action', d.action === 'none', d.action);
}

// ---- 2026-11-09 replay: ratio policy on the real machine -----------------
{
  const thresholds = resolveMemoryThresholds(POLICY, THIS_BOX);
  const incident = {
    ...base,
    hosts: [{ pid: 3509722, rssMb: 3700 }],
    memAvailableMb: THIS_BOX.memAvailableMb,
    swapFreeMb: THIS_BOX.swapFreeMb,
  };
  const d = decideMemoryAction(incident, { ...POLICY, ...thresholds });
  check('incident replay (host 3.7GB, free 2.3GB, swap 0) → reclaim under ratio policy',
    d.action === 'reclaim' && d.hostRssMb === 3700, d.action + ' ' + d.reason);
  const healthy = { ...base, hosts: [{ pid: 1, rssMb: 269 }], memAvailableMb: 5840, swapFreeMb: 5582 };
  const h = decideMemoryAction(healthy, { ...POLICY, ...thresholds });
  check('post-upgrade healthy state (host 269MB, free 11.4GB) → no action', h.action === 'none', h.action);
}

// ---- guard instance with injected readers --------------------------------
{
  let now = T0;
  const guard = createMemoryGuard({
    config: { ...POLICY, enabled: true, intervalMs: 1000, warnRepeatMs: 300000, cooldownMs: 300000 },
    getHosts: () => [11, 22],
    rssReader: (pid) => (pid === 11 ? 500 : 3000),
    sysReader: () => THIS_BOX,
    now: () => now,
  });
  const reclaimed = [];
  const d1 = guard.tick((x) => reclaimed.push(x));
  check('tick() reclaims the hog through onReclaim', d1.action === 'reclaim' && reclaimed.length === 1 && reclaimed[0].pid === 22);
  now += 1000;
  const d2 = guard.tick((x) => reclaimed.push(x));
  check('second tick inside cooldown never reclaims again', reclaimed.length === 1 && d2.action !== 'reclaim', d2.action);
  const snap = guard.snapshot();
  check('snapshot exposes resolved thresholds + machine totals',
    snap.enabled === true && snap.hosts.length === 2 && snap.reclaims === 1 &&
    snap.thresholds.killRssMb === 1238 && snap.machine.totalMb === 25720 &&
    snap.machine.freeMb === 2300 && snap.machine.freePct === 8.9,
    JSON.stringify({ t: snap.thresholds, m: snap.machine }));
}
{
  const guard = createMemoryGuard({
    config: { ...POLICY, enabled: false, intervalMs: 1000, warnRepeatMs: 300000, cooldownMs: 300000 },
    getHosts: () => [1], rssReader: () => 9999, sysReader: () => THIS_BOX,
  });
  const d = guard.tick(() => { throw new Error('must not run'); });
  check('ZCODE_WEBUI_MEM_GUARD=0 disables sampling', d.action === 'none' && guard.snapshot().reclaims === 0, d.action);
}

// ---- procfs readers ------------------------------------------------------
{
  const sys = sampleSystemMemory();
  check('sampleSystemMemory() reads totals and MemAvailable',
    sys && Number.isFinite(sys.memTotalMb) && sys.memTotalMb > 0 &&
    Number.isFinite(sys.memAvailableMb) && sys.memAvailableMb > 0 &&
    Number.isFinite(sys.swapTotalMb),
    JSON.stringify(sys));
  const rss = sampleHostRssMb(process.pid);
  check('sampleHostRssMb() reads VmRSS for a live pid', Number.isFinite(rss) && rss > 0, String(rss));
  check('sampleHostRssMb() returns null for a dead pid', sampleHostRssMb(999999) === null, String(sampleHostRssMb(999999)));
}
{
  const sessions = new Map([
    ['a', { closed: false, child: { pid: 101, exitCode: null } }],
    ['b', { closed: true, child: { pid: 102, exitCode: null } }],
    ['c', { closed: false, child: { pid: 103, exitCode: 1 } }],
    ['d', { closed: false, child: null }],
  ]);
  const relays = new Map([['r1', { session: { closed: false, child: { pid: 101, exitCode: null } } }]]);
  const pids = collectHostPids(sessions, relays).sort();
  check('collectHostPids() dedupes live hosts and skips closed/exited ones',
    JSON.stringify(pids) === JSON.stringify([101]), JSON.stringify(pids));
}

// ---- Buffer attribution preload -----------------------------------------
const attrEnv = {
  ...process.env,
  ZCODE_WEBUI_MEM_ATTR_MIN_MB: '1',
  ZCODE_WEBUI_MEM_ATTR_SPIKE_MB: '1',
  ZCODE_WEBUI_MEM_ATTR_INTERVAL_MS: '200',
  ZCODE_WEBUI_MEM_ATTR_REPORT_MS: '500',
};
{
  const script = `
    const keep = [];
    const t = setInterval(() => keep.push(Buffer.alloc(3 * 1024 * 1024, 7)), 120);
    setTimeout(() => { clearInterval(t); process.exit(0); }, 900);
  `;
  const r = spawnSync(process.execPath, ['--require', GUARD, '-e', script], { encoding: 'utf8', timeout: 15000, env: attrEnv });
  check('big Buffer allocations produce a spike report',
    /mem-attribution: build=1 spike=\+/.test(r.stderr), (r.stderr || '').split('\n').slice(-3).join(' | '));
  check('report names the allocation site', /Buffer\.alloc/.test(r.stderr), (r.stderr || '').split('\n').slice(-4).join(' | '));
  check('report includes memory numbers and handles line',
    /rss=\d|external=/.test(r.stderr) && /handles:/.test(r.stderr), (r.stderr || '').slice(0, 200));
}
{
  const script = `
    const keep = [];
    const t = setInterval(() => keep.push(Buffer.alloc(2048, 1)), 40);
    setTimeout(() => { clearInterval(t); process.exit(0); }, 800);
  `;
  // A realistic spike threshold: production defaults to 192MB, so 2048-byte
  // allocations must never produce a report.
  const r = spawnSync(process.execPath, ['--require', GUARD, '-e', script], {
    encoding: 'utf8', timeout: 15000,
    env: { ...attrEnv, ZCODE_WEBUI_MEM_ATTR_SPIKE_MB: '64' },
  });
  check('small allocations stay silent (no attribution noise)', !/spike=/.test(r.stderr), (r.stderr || '').slice(0, 200));
}
{
  const r = spawnSync(process.execPath, ['--require', GUARD, '-e', 'Buffer.alloc(4*1024*1024)'], {
    encoding: 'utf8', timeout: 15000, env: { ...attrEnv, ZCODE_WEBUI_MEM_ATTR: '0' },
  });
  check('ZCODE_WEBUI_MEM_ATTR=0 disables the preload', r.status === 0 && !/mem-attribution/.test(r.stderr), (r.stderr || '').slice(0, 120));
}
{
  // The wrappers must not change Buffer semantics.
  const r = spawnSync(process.execPath, ['--require', GUARD, '-e', `
    const b = Buffer.alloc(4, 1);
    const f = Buffer.from('hello');
    const c = Buffer.concat([f, Buffer.from(' world')]);
    const u = Buffer.allocUnsafe(8);
    console.log([b.length, f.toString(), c.toString(), u.length, Buffer.isBuffer(b)].join('|'));
  `], { encoding: 'utf8', timeout: 15000, env: attrEnv });
  check('Buffer factories keep working through the wrappers',
    (r.stdout || '').trim() === '4|hello|hello world|8|true', (r.stdout || '').trim() + ' ' + (r.stderr || '').slice(0, 160));
}

console.log(failures === 0 ? '\nall memory-guard checks passed' : '\n' + failures + ' check(s) failed');
process.exit(failures ? 1 : 0);
