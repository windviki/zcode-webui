// Restart-safety check: exit 0 + "quiet" when NO agent turn is running, exit 3
// + the blocking reasons when something is active.
//
// Three independent signals, unioned:
//   1. process tree (ALWAYS probed locally, works on old servers too): any
//      descendant of a zcode-server.cjs host burning CPU right now (sampled as
//      a jiffies delta), or spawned within the last 90s — this is the signal
//      that caught a real turn on 2026-09-28 whose task row was stuck at
//      'error' (retry limbo writes nothing) with its tab attached;
//   2. GET /api/active on the server (frame-rate streaming + detached hosts +
//      task rows; src/server.mjs) when the endpoint exists (0.8.2+);
//   3. fallback row semantics read straight from the tasks index +
//      /api/background for pre-0.8.2 servers.
//
// Usage: node scripts/dev/activity-check.mjs [port]   (default 3102)
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';

const PORT = process.argv[2] || '3102';
const reasons = [];
const note = (s) => { reasons.push(s); };

// ---------- 1. host process-tree CPU probe (linux /proc) ----------
function procSnap() {
  const cpuByPid = new Map();
  const ppidByPid = new Map();
  const cmdByPid = new Map();
  let out;
  try { out = readdirSync('/proc'); } catch (_e) { return { cpuByPid, ppidByPid, cmdByPid, hosts: [] }; }
  const hosts = [];
  for (const name of out) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat, cmd;
    try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch (_e) { continue; }
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    const f = stat.slice(close + 2).split(' ');
    // f[0]=state(3) f[1]=ppid(4) ... f[11]=utime(14) f[12]=stime(15)
    const ppid = Number(f[1]);
    const jiffies = Number(f[11]) + Number(f[12]);
    ppidByPid.set(pid, ppid);
    cpuByPid.set(pid, jiffies);
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] && readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch (_e) { cmd = ''; }
    cmdByPid.set(pid, cmd);
    if (cmd.indexOf('zcode-server.cjs') >= 0) hosts.push(pid);
  }
  return { cpuByPid, ppidByPid, cmdByPid, hosts };
}

async function processTreeBusy() {
  const first = procSnap();
  if (first.hosts.length === 0) return false;
  // descendants of any host (BFS over the ppid map)
  const desc = new Set();
  const queue = [...first.hosts];
  while (queue.length) {
    const p = queue.shift();
    for (const [pid, ppid] of first.ppidByPid) {
      if (ppid === p && !desc.has(pid)) { desc.add(pid); queue.push(pid); }
    }
  }
  if (desc.size === 0) return false;
  await new Promise((r) => setTimeout(r, 2000));
  const second = procSnap();
  let deltaTotal = 0;
  const hot = [];
  const young = [];
  const now = Date.now();
  for (const pid of desc) {
    const a = first.cpuByPid.get(pid) || 0;
    const b = second.cpuByPid.get(pid) || 0;
    const delta = b - a;
    if (delta <= 0) continue;
    deltaTotal += delta;
    if (delta >= 10) hot.push((second.cmdByPid.get(pid) || 'pid ' + pid).split(' ').slice(0, 2).join(' ') + ' +' + Math.round(delta * 10) + 'ms cpu');
  }
  // freshly spawned descendants mean a turn just started even if CPU is still low
  try {
    for (const pid of desc) {
      const st = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = st.lastIndexOf(')');
      const starttime = Number(st.slice(close + 2).split(' ')[19]);   // field 22
      const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
      if (starttime > 0 && (uptime - starttime / 100) < 90) young.push(String(second.cmdByPid.get(pid) || pid).split(' ').slice(0, 2).join(' '));
    }
  } catch (_e) { /* best-effort */ }
  void now;
  if (deltaTotal >= 20) note('host children computing: ' + (hot.slice(0, 3).join(', ') || deltaTotal + ' jiffies/2s'));
  else if (young.length > 0) note('freshly spawned host child: ' + young[0]);
  return deltaTotal >= 20 || young.length > 0;
}

// ---------- 2. /api/active (server 0.8.2+) ----------
async function apiActive() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/active`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (typeof j.active !== 'boolean') return null;
    return j;
  } catch (_e) { return null; }
}

// ---------- 3. tasks-index rows (+ /api/background) for pre-0.8.2 servers ----
function taskIndexBusy() {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const zhome = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
    const db = new DatabaseSync(path.join(zhome, 'v2/tasks-index.sqlite'), { readOnly: true });
    try {
      const now = Date.now();
      const rows = db.prepare(
        "SELECT task_id, task_status, updated_at, title FROM tasks WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 12"
      ).all(now - 2 * 3600_000).map((r) => ({
        status: r.task_status, ageSec: Math.round((now - r.updated_at) / 1000),
        label: String(r.task_id).slice(0, 18) + ' ' + String(r.title || '').slice(0, 30),
      }));
      for (const t of rows) {
        if (t.status === 'running') note('task ' + t.label + ' running ' + Math.max(1, Math.round(t.ageSec / 60)) + 'min');
        else if (t.status === 'error' && t.ageSec <= 30 * 60) note('task ' + t.label + ' error ' + Math.max(1, Math.round(t.ageSec / 60)) + 'min (retry window)');
      }
      return rows.length;
    } finally { db.close(); }
  } catch (_e) {
    note('tasks-index unreadable (fail-safe)');
    return -1;
  }
}

// The process probe is independent of the server version — always run it.
const procBusy = await processTreeBusy();
const via = await apiActive();
let apiActiveFlag = false;
if (via) {
  apiActiveFlag = via.active;
  for (const r of via.reasons || []) note(r);
} else {
  let bgCount = 0;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/background`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) bgCount = ((await r.json()).activeCount) || 0;
  } catch (_e) { /* server may be down mid-restart */ }
  if (bgCount > 0) note(bgCount + ' detached host(s) mid-turn');
  const read = taskIndexBusy();
  apiActiveFlag = reasons.some((r) => r.indexOf('tasks-index unreadable') >= 0) || read < 0 || bgCount > 0
    || reasons.some((r) => r.indexOf('task ') === 0);
}

const active = procBusy || apiActiveFlag;
const payload = JSON.stringify({ active, reasons, via: via ? 'api+proc' : 'fallback+proc' });
console.log(payload);
process.exit(active ? 3 : 0);
