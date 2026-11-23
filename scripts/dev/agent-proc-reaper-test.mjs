#!/usr/bin/env node
// Offline tests for src/agent-proc-reaper.mjs — no /proc, no signals: every
// scenario is a synthetic snapshot handed to tick(), with a fake killer.
//
// The reaper exists because the official host leaves one agent app-server per
// page load behind (2026-11-16 postmortem). These tests pin the safety rules
// that make it safe to run on a live host: never the host, never a direct child,
// never a tool/subagent process, never a subtree that burned CPU.
import { createAgentProcReaper } from '../../src/agent-proc-reaper.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  (' + extra + ')' : '')); }
}

// snapshot builder: entries = [{pid, ppid, cpu, ageSec, comm}]
function snap(entries, uptimeSec = 100000) {
  const m = new Map();
  for (const e of entries) {
    m.set(e.pid, {
      ppid: e.ppid,
      cpu: e.cpu || 0,
      start: Math.round((uptimeSec - (e.ageSec === undefined ? 3600 : e.ageSec)) * 100),
      comm: e.comm === undefined ? 'zcode-cli' : e.comm,
    });
  }
  return m;
}

const OPTS = { minDepth: 2, minAgeMs: 5000, idleMs: 60000, maxPerTick: 8 };
const T0 = 1700000000000;

// --- A: a fully idle agent runtime (depth 2) is reaped after the idle window ---
{
  const r = createAgentProcReaper(OPTS);
  const killed = [];
  const kill = (pid) => killed.push(pid);
  const tree = (cpu300, cpu400) => snap([
    { pid: 100, ppid: 1, cpu: 500, comm: 'zcode-host' },
    { pid: 200, ppid: 100, cpu: 300 },                    // attachment runtime (depth 1)
    { pid: 300, ppid: 200, cpu: cpu300 },                 // idle leftover (depth 2)
    { pid: 400, ppid: 200, cpu: cpu400 },                 // busy leftover (depth 2)
  ]);
  r.tick({ snapshot: tree(10, 10), roots: [100], uptimeSec: 100000, now: T0, kill });
  check('A1 first sighting reaps nothing (needs an idle window)', killed.length === 0, killed.join(','));
  r.tick({ snapshot: tree(10, 60), roots: [100], uptimeSec: 100000, now: T0 + 70000, kill });
  check('A2 idle depth-2 runtime reaped after the window', killed.length === 1 && killed[0] === 300, killed.join(','));
  check('A3 busy sibling (CPU moved) is left alone', !killed.includes(400), killed.join(','));
}

// --- B: never the host, never its direct children, never a non-zcode process ---
{
  const r = createAgentProcReaper(OPTS);
  const killed = [];
  const kill = (pid) => killed.push(pid);
  const s = () => snap([
    { pid: 100, ppid: 1, cpu: 500, comm: 'zcode-host' },
    { pid: 200, ppid: 100, cpu: 300 },                    // depth 1: keep
    { pid: 300, ppid: 200, cpu: 10, comm: 'bash' },       // tool shell: keep
    { pid: 400, ppid: 200, cpu: 10, comm: 'python3' },    // tool: keep
    { pid: 500, ppid: 200, cpu: 10, comm: 'zcode-cli' },  // our only candidate
    { pid: 600, ppid: 200, cpu: 10, comm: 'zcode-node-repl' }, // tool runtime: keep
  ]);
  r.tick({ snapshot: s(), roots: [100], uptimeSec: 100000, now: T0, kill });
  r.tick({ snapshot: s(), roots: [100], uptimeSec: 100000, now: T0 + 70000, kill });
  check('B1 only the idle zcode-cli grandchild is reaped', killed.length === 1 && killed[0] === 500, killed.join(','));
}

// --- C: young processes are left alone (a fresh page load's runtimes) ---
{
  const r = createAgentProcReaper(OPTS);
  const killed = [];
  const kill = (pid) => killed.push(pid);
  const s = () => snap([
    { pid: 100, ppid: 1, cpu: 500, comm: 'zcode-host', ageSec: 3600 },
    { pid: 200, ppid: 100, cpu: 300, ageSec: 3600 },
    { pid: 300, ppid: 200, cpu: 10, ageSec: 30 },         // 30s old < minAgeMs=5s? no: 30s > 5s
    { pid: 301, ppid: 200, cpu: 10, ageSec: 1 },          // 1s old
  ]);
  r.tick({ snapshot: s(), roots: [100], uptimeSec: 100000, now: T0, kill });
  r.tick({ snapshot: s(), roots: [100], uptimeSec: 100000, now: T0 + 70000, kill });
  check('C1 very young runtime is not reaped', !killed.includes(301), killed.join(','));
  check('C2 old-enough idle runtime is', killed.includes(300), killed.join(','));
}

// --- D: a busy child protects its parent subtree ---
{
  const r = createAgentProcReaper(OPTS);
  const killed = [];
  const kill = (pid) => killed.push(pid);
  const s = (toolCpu) => snap([
    { pid: 100, ppid: 1, cpu: 500, comm: 'zcode-host' },
    { pid: 200, ppid: 100, cpu: 300 },
    { pid: 300, ppid: 200, cpu: 10 },                     // idle runtime
    { pid: 310, ppid: 300, cpu: toolCpu, comm: 'bash' },  // tool running under it
  ]);
  r.tick({ snapshot: s(5), roots: [100], uptimeSec: 100000, now: T0, kill });
  r.tick({ snapshot: s(80), roots: [100], uptimeSec: 100000, now: T0 + 70000, kill });
  check('D1 a runtime with a busy child is never reaped', killed.length === 0, killed.join(','));
}

// --- E: dry-run reports but does not kill ---
{
  const r = createAgentProcReaper(OPTS);
  const killed = [];
  const kill = (pid) => killed.push(pid);
  const s = () => snap([
    { pid: 100, ppid: 1, cpu: 500, comm: 'zcode-host' },
    { pid: 200, ppid: 100, cpu: 300 },
    { pid: 300, ppid: 200, cpu: 10 },
  ]);
  r.tick({ snapshot: s(), roots: [100], uptimeSec: 100000, now: T0, kill });
  const res = r.tick({ snapshot: s(), roots: [100], uptimeSec: 100000, now: T0 + 70000, kill, dryRun: true });
  check('E1 dry-run reports the would-be victim', Array.isArray(res.wouldReap) && res.wouldReap[0] === 300, JSON.stringify(res.wouldReap));
  check('E2 dry-run sends no signal', killed.length === 0, killed.join(','));
}

// --- F: maxPerTick + shallowest-first selection ---
{
  const r = createAgentProcReaper({ ...OPTS, maxPerTick: 2 });
  const killed = [];
  const kill = (pid) => killed.push(pid);
  const s = () => snap([
    { pid: 100, ppid: 1, cpu: 500, comm: 'zcode-host' },
    { pid: 200, ppid: 100, cpu: 300 },
    { pid: 300, ppid: 200, cpu: 10 },
    { pid: 301, ppid: 300, cpu: 10 },                    // child of a candidate
    { pid: 400, ppid: 200, cpu: 10 },
    { pid: 500, ppid: 200, cpu: 10 },
    { pid: 600, ppid: 200, cpu: 10 },
  ]);
  r.tick({ snapshot: s(), roots: [100], uptimeSec: 100000, now: T0, kill });
  r.tick({ snapshot: s(), roots: [100], uptimeSec: 100000, now: T0 + 70000, kill });
  check('F1 respects maxPerTick', killed.length === 2, killed.join(','));
  check('F2 picks the shallowest and never a node under a picked one',
    killed.every((p) => [300, 400, 500, 600].includes(p)) && !killed.includes(301), killed.join(','));
}

// --- G: config safety clamps and dead-pid state pruning ---
{
  const r = createAgentProcReaper({ minDepth: 1, maxPerTick: 0 });
  check('G1 minDepth is clamped to 2 (never host/direct child)', r.config.minDepth === 2, String(r.config.minDepth));
  check('G2 maxPerTick falls back to the default', r.config.maxPerTick === 8, String(r.config.maxPerTick));

  const killed = [];
  const kill = (pid) => killed.push(pid);
  const s = () => snap([
    { pid: 100, ppid: 1, cpu: 500, comm: 'zcode-host' },
    { pid: 200, ppid: 100, cpu: 300 },
    { pid: 300, ppid: 200, cpu: 10 },
  ]);
  r.tick({ snapshot: s(), roots: [100], uptimeSec: 100000, now: T0, kill });
  check('G3 state tracks observed pids', r._state.has(300));
  r.tick({ snapshot: snap([{ pid: 100, ppid: 1, cpu: 500, comm: 'zcode-host' }]), roots: [100], uptimeSec: 100000, now: T0 + 1000, kill });
  check('G4 vanished pids are pruned from state', !r._state.has(300));
  // 300 came back from a *different* process: its history must be new, so no
  // instant reap on the tick it reappears
  const s2 = () => snap([
    { pid: 100, ppid: 1, cpu: 500, comm: 'zcode-host' },
    { pid: 200, ppid: 100, cpu: 300 },
    { pid: 300, ppid: 200, cpu: 999 },
  ]);
  r.tick({ snapshot: s2(), roots: [100], uptimeSec: 100000, now: T0 + 20000, kill });
  const res = r.tick({ snapshot: s2(), roots: [100], uptimeSec: 100000, now: T0 + 21000, kill });
  check('G5 a recycled pid is not judged on stale history', res.pids.length === 0, JSON.stringify(res.pids));
}

// --- H: unknown roots / empty snapshots are no-ops (safe mode) ---
{
  const r = createAgentProcReaper(OPTS);
  const a = r.tick({ snapshot: new Map(), roots: [100], uptimeSec: 1, now: T0 });
  const b = r.tick({ snapshot: snap([{ pid: 1, ppid: 0, comm: 'init' }]), roots: [], uptimeSec: 1, now: T0 });
  check('H1 empty snapshot is a no-op', a.pids.length === 0);
  check('H2 no roots is a no-op', b.pids.length === 0);
}

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
