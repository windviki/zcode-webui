// Server-side memory guard for the official host process.
//
// Why this exists (2026-11-09 incident): host pid 1682346 (official 3.16.3
// utility host) grew from 402 MB to 3.75 GB of anonymous memory in ten minutes
// — 2.6 GB of it Buffers, JS heap only ~340 MB — while three review subagents
// were running. This box has 15.8 GB RAM + 10 GB swap; swap hit 0 free, the
// machine started thrashing, /api/health answered in 11-19 s and the web UI was
// unusable for minutes. Nothing in the stack noticed: hosts are only reaped for
// being idle, never for being huge, and the kernel OOM killer only fires after
// the whole box is already wedged.
//
// Thresholds are proportional to the machine, not fixed MB values: the guard has
// to leave headroom on a 64 GB box and still act on an 8 GB one. Both sides are
// derived from /proc/meminfo at sample time:
//
//   RAM-relative (MemTotal)        available-relative (MemTotal + SwapTotal)
//   ------------------------       ---------------------------------------
//   warnRssMb   = max(768,  6%)    minAvailMb  = max(512,  10%)
//   killRssMb   = max(768,  8%)    softAvailMb = max(1024, 18%)
//   hardRssMb   = max(2048, 20%)
//
// On this box (15480 MB RAM + 10240 MB swap) that resolves to: warn 929 MB,
// kill 1238 MB, hard 3096 MB, minAvail 2572 MB, softAvail 4630 MB. The incident
// state (host 3700 MB, MemAvailable 2300 MB, swap 0) therefore trips rule 1.
//
// The guard is deliberately conservative — it must never kill work for being
// merely large:
//
//   warn     one log line when a host crosses warnRssMb (re-logged every
//            WARN_REPEAT_MS while it stays over);
//   reclaim  only when the machine is genuinely short of memory (available
//            memory incl. swap <= minAvailMb) AND some host is actually the hog
//            (RSS >= killRssMb), or when one host is absurdly large
//            (RSS >= hardRssMb) while available memory is already tight
//            (< softAvailMb);
//   at most one reclaim per COOLDOWN_MS, and only the biggest host is picked.
//
// Cost: two procfs reads (one per host + /proc/meminfo) every INTERVAL_MS
// (default 15 s). Nothing runs on the request path.
//
// Env — ratios (fraction of the machine, these are the defaults):
//   ZCODE_WEBUI_MEM_GUARD=0|off          disable the guard entirely
//   ZCODE_WEBUI_MEM_GUARD_INTERVAL_MS    default 15000
//   ZCODE_WEBUI_MEM_GUARD_AVAIL_PCT      default 0.10  (of RAM+swap)
//   ZCODE_WEBUI_MEM_GUARD_SOFT_AVAIL_PCT default 0.18  (of RAM+swap)
//   ZCODE_WEBUI_MEM_GUARD_WARN_RSS_PCT   default 0.06  (of RAM)
//   ZCODE_WEBUI_MEM_GUARD_KILL_RSS_PCT   default 0.08  (of RAM)
//   ZCODE_WEBUI_MEM_GUARD_HARD_RSS_PCT   default 0.20  (of RAM)
//   ZCODE_WEBUI_MEM_GUARD_WARN_REPEAT_MS default 300000
//   ZCODE_WEBUI_MEM_GUARD_COOLDOWN_MS    default 300000
// Env — absolute overrides (set only to pin a value regardless of machine size;
// the legacy *_MB names still work and win over the ratios):
//   ZCODE_WEBUI_MEM_GUARD_WARN_RSS_MB / _KILL_RSS_MB / _HARD_RSS_MB
//   ZCODE_WEBUI_MEM_GUARD_MIN_AVAIL_MB / _SOFT_AVAIL_MB
import { readFileSync } from 'node:fs';

function envNum(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function envOverride(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function memoryGuardConfig() {
  const off = /^(0|off|false|no)$/i.test(String(process.env.ZCODE_WEBUI_MEM_GUARD || ''));
  return {
    enabled: !off,
    intervalMs: Math.max(2000, envNum('ZCODE_WEBUI_MEM_GUARD_INTERVAL_MS', 15000)),
    warnRepeatMs: envNum('ZCODE_WEBUI_MEM_GUARD_WARN_REPEAT_MS', 300000),
    cooldownMs: envNum('ZCODE_WEBUI_MEM_GUARD_COOLDOWN_MS', 300000),
    // proportions of the machine (see the header table)
    availPct: envNum('ZCODE_WEBUI_MEM_GUARD_AVAIL_PCT', 0.10),
    softAvailPct: envNum('ZCODE_WEBUI_MEM_GUARD_SOFT_AVAIL_PCT', 0.18),
    warnRssPct: envNum('ZCODE_WEBUI_MEM_GUARD_WARN_RSS_PCT', 0.06),
    killRssPct: envNum('ZCODE_WEBUI_MEM_GUARD_KILL_RSS_PCT', 0.08),
    hardRssPct: envNum('ZCODE_WEBUI_MEM_GUARD_HARD_RSS_PCT', 0.20),
    // floors for machines too small for the ratios to be meaningful
    warnRssMbFloor: 768,
    killRssMbFloor: 768,
    hardRssMbFloor: 2048,
    minAvailMbFloor: 512,
    softAvailMbFloor: 1024,
    // explicit absolute overrides (legacy env names)
    warnRssMbOverride: envOverride('ZCODE_WEBUI_MEM_GUARD_WARN_RSS_MB'),
    killRssMbOverride: envOverride('ZCODE_WEBUI_MEM_GUARD_KILL_RSS_MB'),
    hardRssMbOverride: envOverride('ZCODE_WEBUI_MEM_GUARD_HARD_RSS_MB'),
    minAvailMbOverride: envOverride('ZCODE_WEBUI_MEM_GUARD_MIN_AVAIL_MB'),
    softAvailMbOverride: envOverride('ZCODE_WEBUI_MEM_GUARD_SOFT_AVAIL_MB'),
  };
}

// /proc/meminfo → totals and free memory. Returns null when the file cannot be
// read (non-Linux sandbox) so callers can degrade to warn-only.
export function sampleSystemMemory() {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const pick = (key) => {
      const m = text.match(new RegExp('^' + key + ':\\s+(\\d+)', 'm'));
      return m ? Number(m[1]) : null;
    };
    const availKb = pick('MemAvailable');
    if (availKb === null) return null;
    const totalKb = pick('MemTotal');
    const swapTotalKb = pick('SwapTotal');
    const swapFreeKb = pick('SwapFree');
    return {
      memTotalMb: totalKb === null ? null : Math.round(totalKb / 1024),
      memAvailableMb: Math.round(availKb / 1024),
      swapTotalMb: swapTotalKb === null ? null : Math.round(swapTotalKb / 1024),
      swapFreeMb: swapFreeKb === null ? null : Math.round(swapFreeKb / 1024),
    };
  } catch (_e) {
    return null;
  }
}

// Per-pid RSS in MiB, or null when the process is gone / unreadable.
export function sampleHostRssMb(pid) {
  if (!pid) return null;
  try {
    const status = readFileSync('/proc/' + pid + '/status', 'utf8');
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (!m) return null;
    return Math.round(Number(m[1]) / 1024);
  } catch (_e) {
    return null;
  }
}

// Turn the ratio config into the absolute numbers used for decisions, for the
// machine we are actually running on. `base` is RAM for host RSS (swap does not
// hold a process's RSS) and RAM+swap for the free-memory floor (a box can be
// out of memory with swap in play). Explicit *_MB overrides win; otherwise the
// bigger of the ratio and the floor is used.
export function resolveMemoryThresholds(cfg, system) {
  const pick = (override, floor, pct, baseMb) => {
    if (Number.isFinite(override)) return override;
    const scaled = Number.isFinite(baseMb) && baseMb > 0 ? Math.round(baseMb * pct) : 0;
    return Math.max(floor, scaled);
  };
  const ramMb = system && Number.isFinite(system.memTotalMb) ? system.memTotalMb : null;
  const swapMb = system && Number.isFinite(system.swapTotalMb) ? system.swapTotalMb : 0;
  const totalMb = ramMb === null ? null : ramMb + (Number.isFinite(swapMb) ? swapMb : 0);
  return {
    ramMb,
    totalMb,
    warnRssMb: pick(cfg.warnRssMbOverride, cfg.warnRssMbFloor, cfg.warnRssPct, ramMb),
    killRssMb: pick(cfg.killRssMbOverride, cfg.killRssMbFloor, cfg.killRssPct, ramMb),
    hardRssMb: pick(cfg.hardRssMbOverride, cfg.hardRssMbFloor, cfg.hardRssPct, ramMb),
    minAvailMb: pick(cfg.minAvailMbOverride, cfg.minAvailMbFloor, cfg.availPct, totalMb),
    softAvailMb: pick(cfg.softAvailMbOverride, cfg.softAvailMbFloor, cfg.softAvailPct, totalMb),
  };
}

// Which host pids exist under this server. `sessions` entries are the host
// children the reaper already knows about; httpRelays may share the same child.
export function collectHostPids(sessions, httpRelays) {
  const pids = new Set();
  try {
    if (sessions && typeof sessions.values === 'function') {
      for (const s of sessions.values()) {
        if (s && !s.closed && s.child && s.child.exitCode === null && s.child.pid) pids.add(s.child.pid);
      }
    }
    if (httpRelays && typeof httpRelays.values === 'function') {
      for (const e of httpRelays.values()) {
        const s = e && e.session;
        if (s && !s.closed && s.child && s.child.exitCode === null && s.child.pid) pids.add(s.child.pid);
      }
    }
  } catch (_e) { /* observability must never throw */ }
  return [...pids];
}

// Pure decision function (unit-tested offline).
//   state = { hosts:[{pid,rssMb}], memAvailableMb, swapFreeMb, now,
//             lastReclaimAt, lastWarnAt }
//   thresholds = resolved { warnRssMb, killRssMb, minAvailMb, hardRssMb,
//                           softAvailMb } + { cooldownMs, warnRepeatMs }
// Returns { action: 'none'|'warn'|'reclaim', pid, reason, hostRssMb }.
export function decideMemoryAction(state, thresholds) {
  const hosts = (state.hosts || []).filter((h) => h && Number.isFinite(h.rssMb) && h.rssMb > 0);
  const none = { action: 'none', pid: null, reason: '', hostRssMb: 0 };
  if (hosts.length === 0) return none;

  const biggest = hosts.reduce((a, b) => (b.rssMb > a.rssMb ? b : a));
  const memAvailableMb = state.memAvailableMb;
  const swapFreeMb = Number.isFinite(state.swapFreeMb) ? state.swapFreeMb : 0;
  const freeMb = Number.isFinite(memAvailableMb) ? memAvailableMb + swapFreeMb : null;
  const now = Number.isFinite(state.now) ? state.now : Date.now();
  const lastReclaimAt = Number.isFinite(state.lastReclaimAt) ? state.lastReclaimAt : 0;
  const lastWarnAt = Number.isFinite(state.lastWarnAt) ? state.lastWarnAt : 0;
  const sysKnown = freeMb !== null;
  const cooling = lastReclaimAt > 0 && now - lastReclaimAt < thresholds.cooldownMs;

  // 1) The box is short of memory (incl. swap) and this host is big: reclaim
  //    now. A host already this large is the reason memory is short; the
  //    alternative is minutes of thrashing for every client.
  if (!cooling && sysKnown && freeMb <= thresholds.minAvailMb && biggest.rssMb >= thresholds.killRssMb) {
    return {
      action: 'reclaim', pid: biggest.pid,
      reason: 'free memory ' + freeMb + 'MB (avail ' + memAvailableMb + ' + swap ' + swapFreeMb +
        ') <= floor ' + thresholds.minAvailMb + 'MB and host rss=' + biggest.rssMb + 'MB',
      hostRssMb: biggest.rssMb,
    };
  }

  // 2) A single host is absurdly large while memory is already tight. Covers
  //    the case where free memory is still reclaimable but the host keeps
  //    growing: waiting for the floor risks the same thrash.
  if (!cooling && sysKnown && biggest.rssMb >= thresholds.hardRssMb && freeMb < thresholds.softAvailMb) {
    return {
      action: 'reclaim', pid: biggest.pid,
      reason: 'host rss=' + biggest.rssMb + 'MB >= hard cap ' + thresholds.hardRssMb +
        'MB with free ' + freeMb + 'MB < ' + thresholds.softAvailMb + 'MB',
      hostRssMb: biggest.rssMb,
    };
  }

  // 3) Log-only warning (never kills).
  if (biggest.rssMb >= thresholds.warnRssMb && now - lastWarnAt >= thresholds.warnRepeatMs) {
    return {
      action: 'warn', pid: biggest.pid,
      reason: 'host rss=' + biggest.rssMb + 'MB >= warn ' + thresholds.warnRssMb + 'MB' +
        (sysKnown ? '; free=' + freeMb + 'MB' : ''),
      hostRssMb: biggest.rssMb,
    };
  }

  return none;
}

// Guard instance used by src/server.mjs. Injectable readers keep it testable.
export function createMemoryGuard({ getHosts, sysReader = sampleSystemMemory, rssReader = sampleHostRssMb, now = Date.now, config = memoryGuardConfig() } = {}) {
  const state = {
    lastWarnAt: 0,
    lastReclaimAt: 0,
    lastReason: '',
    lastAction: 'none',
    reclaims: 0,
    warns: 0,
    lastTickAt: 0,
    lastHosts: [],
    lastSystem: null,
    lastThresholds: null,
  };

  function snapshot() {
    const sys = state.lastSystem;
    const totalMb = sys && Number.isFinite(sys.memTotalMb)
      ? sys.memTotalMb + (Number.isFinite(sys.swapTotalMb) ? sys.swapTotalMb : 0) : null;
    const freeMb = sys && Number.isFinite(sys.memAvailableMb)
      ? sys.memAvailableMb + (Number.isFinite(sys.swapFreeMb) ? sys.swapFreeMb : 0) : null;
    return {
      enabled: config.enabled,
      intervalMs: config.intervalMs,
      // resolved for THIS machine (ratios applied); *_Pct describe the policy
      ratios: {
        availPct: config.availPct, softAvailPct: config.softAvailPct,
        warnRssPct: config.warnRssPct, killRssPct: config.killRssPct, hardRssPct: config.hardRssPct,
      },
      thresholds: state.lastThresholds,
      machine: sys ? {
        ramMb: sys.memTotalMb, swapMb: sys.swapTotalMb, totalMb,
        memAvailableMb: sys.memAvailableMb, swapFreeMb: sys.swapFreeMb, freeMb,
        freePct: totalMb ? Math.round((freeMb / totalMb) * 1000) / 10 : null,
      } : null,
      sampleAt: state.lastTickAt || null,
      hosts: state.lastHosts,
      lastAction: state.lastAction,
      lastReason: state.lastReason,
      lastReclaimAt: state.lastReclaimAt || null,
      reclaims: state.reclaims,
      warns: state.warns,
    };
  }

  // One sampling pass. Returns the decision (also recorded in snapshot()).
  // `onReclaim({pid, reason, hostRssMb, thresholds})` is called for reclaim
  // decisions only.
  function tick(onReclaim) {
    if (!config.enabled) return { action: 'none', pid: null, reason: 'disabled', hostRssMb: 0 };
    const t = now();
    let hosts = [];
    try {
      const pids = typeof getHosts === 'function' ? getHosts() : [];
      hosts = pids.map((pid) => ({ pid, rssMb: rssReader(pid) })).filter((h) => Number.isFinite(h.rssMb));
    } catch (_e) { hosts = []; }
    const system = sysReader();
    const thresholds = resolveMemoryThresholds(config, system);
    state.lastTickAt = t;
    state.lastHosts = hosts.map((h) => ({ pid: h.pid, rssMb: h.rssMb }));
    state.lastSystem = system;
    state.lastThresholds = thresholds;
    const decision = decideMemoryAction({
      hosts,
      memAvailableMb: system ? system.memAvailableMb : null,
      swapFreeMb: system ? system.swapFreeMb : null,
      now: t, lastReclaimAt: state.lastReclaimAt, lastWarnAt: state.lastWarnAt,
    }, { ...config, ...thresholds });
    state.lastAction = decision.action;
    if (decision.action !== 'none') state.lastReason = decision.reason;
    if (decision.action === 'warn') {
      state.warns++;
      state.lastWarnAt = t;
    }
    if (decision.action === 'reclaim') {
      state.reclaims++;
      state.lastReclaimAt = t;
      try {
        if (typeof onReclaim === 'function') onReclaim({ ...decision, thresholds });
      } catch (_e) { /* the caller's kill path must not break the guard */ }
    }
    return decision;
  }

  return { tick, snapshot, config };
}
