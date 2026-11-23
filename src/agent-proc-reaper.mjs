// Idle "agent CLI" reaper — the shim-side answer to a vendor leak.
//
// What leaks: every page load makes the official host spawn a batch of agent
// app-servers (`zcode-cli`, 200-450MB each; observed 7 of them / ~1.8GB for one
// page load on 2026-11-16). The host only closes them through the desktop
// transport's dispose (stdin EOF, see the vendor's zcodeStdioTransport.ts),
// which a web session never triggers: after the page is gone they sit at 0 CPU
// for hours. Two days of mobile reloads accumulated 17 of them (~985MB RSS plus
// swap) and pushed this 15GB box into permanent swap thrash — which is what made
// the UI time out on its startup handshake.
//
// What we can safely do from the outside: terminate the *idle* grandchildren of
// a host we are no longer serving a page for. The host keeps its direct children
// (the base attachment runtimes); it respawns a per-attachment runtime on the
// next page connect (verified: a reload after a reap spawns a fresh set and the
// UI works).
//
// Safety rules (all must hold for a pid):
//   * descendant of the host, depth >= minDepth (never the host, never depth-1)
//   * comm is exactly "zcode-cli" (never a tool/subagent shell — bash, python,
//     node, zcode-node-repl — those may be a live tool call)
//   * alive longer than minAgeMs
//   * CPU ticks unchanged for the whole idle window (state kept across ticks)
//   * its entire subtree is idle too (a busy child means an active turn)
//   * the caller already filtered roots to hosts with no attached view and the
//     global busy guard said "nothing is running" (frames, tasks index, CLI DB
//     writes, in-flight model request, tree CPU probe)
//
// Env (server side): ZCODE_WEBUI_PROC_REAPER=off|dry-run|on (default on),
// ZCODE_WEBUI_PROC_REAPER_MIN_AGE_MS (5min), _IDLE_MS (10min), _MAX_PER_TICK (8),
// ZCODE_WEBUI_PROC_REAPER_MIN_DEPTH (2).

const DEFAULTS = {
  minDepth: 2,
  minAgeMs: 5 * 60 * 1000,
  idleMs: 10 * 60 * 1000,
  maxPerTick: 8,
  // exact comm allowlist: the vendor's agent app-server only. `zcode-node-repl`
  // is a tool runtime the agent talks to during a turn — same size class, but
  // killing it can break a live tool call, so it needs its own evidence first.
  commAllow: ['zcode-cli'],
  cpuHz: 100,   // USER_HZ on x86_64/arm64 Linux
};

export function createAgentProcReaper(options = {}) {
  // undefined must NOT override a default (an env var that is unset would
  // otherwise erase minDepth and let the reaper consider the host itself).
  const cfg = { ...DEFAULTS };
  for (const [k, v] of Object.entries(options)) if (v !== undefined && v !== null) cfg[k] = v;
  // hard safety invariants, not configurable: never the host (depth 0) and never
  // its direct attachment runtimes (depth 1), at least one reap per tick cap.
  cfg.minDepth = Math.max(2, Number(cfg.minDepth) || DEFAULTS.minDepth);
  cfg.maxPerTick = Math.max(1, Number(cfg.maxPerTick) || DEFAULTS.maxPerTick);
  cfg.minAgeMs = Math.max(0, Number(cfg.minAgeMs) || DEFAULTS.minAgeMs);
  cfg.idleMs = Math.max(1000, Number(cfg.idleMs) || DEFAULTS.idleMs);
  // pid -> { cpu, seenAt, firstAt } ; pruned every tick so a recycled pid is not
  // judged on another process's history
  const state = new Map();
  const stats = { ticks: 0, reaped: 0, lastReapedAt: 0, lastPids: [], lastCandidates: 0 };
  const history = [];   // [{at, pids, verdict}] for /api/health + logs

  function prune(live, now) {
    for (const [pid, s] of state) {
      if (!live.has(pid)) { state.delete(pid); continue; }
      // a pid that has been invisible for > 3x idle window is stale bookkeeping
      if (now - s.seenAt > cfg.idleMs * 3) state.delete(pid);
    }
  }

  // Build parent->children and BFS from the roots. Returns Map(pid -> depth).
  function depths(snapshot, roots) {
    const kids = new Map();
    for (const [pid, p] of snapshot) {
      if (!kids.has(p.ppid)) kids.set(p.ppid, []);
      kids.get(p.ppid).push(pid);
    }
    const depth = new Map();
    const queue = [];
    for (const r of roots) {
      if (!snapshot.has(r)) continue;      // host already gone
      depth.set(r, 0);
      queue.push(r);
    }
    while (queue.length) {
      const pid = queue.shift();
      const d = depth.get(pid);
      for (const c of kids.get(pid) || []) {
        if (depth.has(c)) continue;
        depth.set(c, d + 1);
        queue.push(c);
      }
    }
    return depth;
  }

  // A subtree is idle only when every descendant also held its CPU ticks for
  // the whole idle window (lastChangeAt is when that pid last burned CPU).
  function subtreeIdle(snapshot, pid, now, kidsIndex) {
    const stack = [pid];
    let seen = 0;
    while (stack.length) {
      const cur = stack.pop();
      const s = state.get(cur);
      const snap = snapshot.get(cur);
      if (!snap || !s) return false;                     // unknown process: be conservative
      if (s.cpu !== snap.cpu) return false;              // burned CPU between ticks
      if (now - s.lastChangeAt < cfg.idleMs) return false;
      seen++;
      if (seen > 512) return false;                      // absurd subtree: refuse
      for (const c of kidsIndex.get(cur) || []) stack.push(c);
    }
    return true;
  }

  function tick({ snapshot, roots, uptimeSec, now = Date.now(), dryRun = false, kill = null } = {}) {
    stats.ticks++;
    if (!snapshot || snapshot.size === 0 || !Array.isArray(roots) || roots.length === 0) {
      return { pids: [], candidates: 0, reason: 'no-roots' };
    }
    prune(snapshot, now);

    // remember this sample for every live pid (cheap: one Map write each).
    // lastChangeAt — not seenAt — is what the idle window is measured against:
    // a process that keeps burning CPU never becomes idle no matter how long we
    // watch it.
    const live = new Set();
    for (const [pid, p] of snapshot) {
      live.add(pid);
      const prev = state.get(pid);
      if (!prev) state.set(pid, { cpu: p.cpu, seenAt: now, firstAt: now, lastChangeAt: now });
      else if (prev.cpu !== p.cpu) { prev.cpu = p.cpu; prev.seenAt = now; prev.lastChangeAt = now; }
      else prev.seenAt = now;
    }

    const depth = depths(snapshot, roots);
    const kidsIndex = new Map();
    for (const [pid, p] of snapshot) {
      if (!kidsIndex.has(p.ppid)) kidsIndex.set(p.ppid, []);
      kidsIndex.get(p.ppid).push(pid);
    }

    const candidates = [];
    for (const [pid, d] of depth) {
      if (d < cfg.minDepth) continue;
      const p = snapshot.get(pid);
      if (!p) continue;
      if (!cfg.commAllow.includes(String(p.comm || ''))) continue;
      const ageMs = uptimeSec > 0 ? (uptimeSec - p.start / cfg.cpuHz) * 1000 : Infinity;
      if (!(ageMs >= cfg.minAgeMs)) continue;
      const s = state.get(pid);
      if (!s) continue;
      if (now - s.firstAt < cfg.idleMs) continue;      // not observed long enough
      if (now - s.lastChangeAt < cfg.idleMs) continue; // burned CPU inside the window
      if (now - s.seenAt > 2000) continue;             // vanished this tick
      if (!subtreeIdle(snapshot, pid, now, kidsIndex)) continue;
      candidates.push({ pid, depth: d, ageMs: Math.round(ageMs), cpu: p.cpu });
    }

    // shallowest first, and never both a node and its descendant
    candidates.sort((a, b) => a.depth - b.depth || a.pid - b.pid);
    const picked = [];
    const covered = new Set();
    for (const c of candidates) {
      if (covered.has(c.pid)) continue;
      // mark the whole subtree as covered
      const stack = [c.pid];
      while (stack.length) {
        const cur = stack.pop();
        if (covered.has(cur)) continue;
        covered.add(cur);
        for (const kid of kidsIndex.get(cur) || []) stack.push(kid);
      }
      picked.push(c);
      if (picked.length >= cfg.maxPerTick) break;
    }

    stats.lastCandidates = candidates.length;
    if (picked.length === 0) return { pids: [], candidates: 0, reason: 'nothing-idle' };

    const pids = picked.map((c) => c.pid);
    stats.lastPids = pids;
    history.push({ at: now, pids: pids.slice(0, cfg.maxPerTick), candidates: candidates.length });
    if (history.length > 20) history.shift();
    if (dryRun) return { pids: [], candidates: candidates.length, wouldReap: pids, dryRun: true };

    let reaped = 0;
    for (const pid of pids) {
      try {
        if (kill) kill(pid, 'SIGTERM');
        else process.kill(pid, 'SIGTERM');
        reaped++;
      } catch (_e) { /* already gone */ }
    }
    stats.reaped += reaped;
    if (reaped > 0) stats.lastReapedAt = now;
    return { pids, candidates: candidates.length, reaped };
  }

  return {
    tick,
    stats,
    history,
    config: cfg,
    // exposed for tests / /api/health
    _state: state,
  };
}
