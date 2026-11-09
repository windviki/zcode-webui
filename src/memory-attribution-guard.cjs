'use strict';
// Host-process preload: name the cause of a Buffer memory blow-up.
//
// 2026-11-09 incident: the official host grew to 3.75 GB of anonymous memory
// in ten minutes (2.6 GB of it `external`, i.e. Buffers; JS heap only ~340 MB)
// and took the box down with it. The runtime already logs an aggregate
// `[memory]` line once a minute, but nothing said *who* allocated the memory:
// a run of tool/subagent output, a stalled pipe, a retain cycle — all look the
// same from the outside. This guard answers that question.
//
// What it does (registered from src/host.mjs next to the other preloads, so it
// also covers every child the host spawns through the inherited NODE_OPTIONS):
//
//   * wraps the Buffer factories and accounts allocations >= MIN_MB (default
//     1 MiB) by call site, in a rolling window;
//   * samples process.memoryUsage() every INTERVAL_MS and, when `external`
//     grew by >= SPIKE_MB inside the window, prints one report to stderr:
//     memory numbers, the top allocation sites in that window, and — when the
//     spike was NOT explained by big Buffers — a summary of active handles
//     with queued bytes (that is the "stalled consumer / pipe backlog" shape);
//   * throttles reports to one per REPORT_MS.
//
// Steady-state cost is one memoryUsage() call per INTERVAL_MS; the Buffer
// wrappers only do work for allocations >= MIN_MB, which are rare.
//
// Env:
//   ZCODE_WEBUI_MEM_ATTR=0            disable (default: on)
//   ZCODE_WEBUI_MEM_ATTR_MIN_MB       default 1
//   ZCODE_WEBUI_MEM_ATTR_INTERVAL_MS  default 15000
//   ZCODE_WEBUI_MEM_ATTR_SPIKE_MB     default 192
//   ZCODE_WEBUI_MEM_ATTR_REPORT_MS    default 60000
//   ZCODE_WEBUI_MEM_ATTR_VERBOSE=1    log every sample (debugging only)
(function install() {
  if (/^(0|off|false|no)$/i.test(String(process.env.ZCODE_WEBUI_MEM_ATTR || ''))) return;
  if (typeof Buffer !== 'function' || typeof process !== 'object') return;

  const num = (name, dflt) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return dflt;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  const MIN_BYTES = num('ZCODE_WEBUI_MEM_ATTR_MIN_MB', 1) * 1024 * 1024;
  const INTERVAL_MS = Math.max(500, num('ZCODE_WEBUI_MEM_ATTR_INTERVAL_MS', 15000));
  const SPIKE_BYTES = num('ZCODE_WEBUI_MEM_ATTR_SPIKE_MB', 192) * 1024 * 1024;
  const REPORT_MS = Math.max(1000, num('ZCODE_WEBUI_MEM_ATTR_REPORT_MS', 60000));
  const VERBOSE = /^(1|true|yes)$/i.test(String(process.env.ZCODE_WEBUI_MEM_ATTR_VERBOSE || ''));
  const MAX_SITES = 256;
  const TAG = '[zcode-webui] mem-attribution:';

  const mb = (bytes) => (bytes / 1048576).toFixed(1) + 'MB';

  // ---- allocation accounting -------------------------------------------------
  const sites = new Map(); // key -> { bytes, count }
  let windowBytes = 0;
  let windowCount = 0;
  let windowStartAt = 0;
  let reportedAt = 0;
  let lastUsage = usage();
  let lastSampleAt = Date.now();

  function usage() {
    try { return process.memoryUsage(); } catch (_e) { return { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 }; }
  }

  function callsite() {
    try {
      const stack = new Error().stack || '';
      const lines = stack.split('\n');
      const frames = [];
      for (let i = 2; i < lines.length && frames.length < 3; i++) {
        const line = lines[i].trim();
        if (!line || line.indexOf(__filename) !== -1) continue;
        if (line.indexOf('/src/memory-attribution-guard.cjs') !== -1) continue;
        frames.push(line.replace(/^at\s+/, '').slice(0, 120));
      }
      return frames.join(' <- ') || '(unknown)';
    } catch (_e) { return '(unknown)'; }
  }

  function account(bytes, kind) {
    if (!Number.isFinite(bytes) || bytes < MIN_BYTES) return;
    try {
      const key = kind + ' ' + callsite();
      const cur = sites.get(key);
      if (cur) {
        cur.bytes += bytes;
        cur.count += 1;
      } else if (sites.size < MAX_SITES) {
        sites.set(key, { bytes, count: 1 });
      }
      if (windowStartAt === 0) windowStartAt = Date.now();
      windowBytes += bytes;
      windowCount += 1;
    } catch (_e) { /* never break an allocation */ }
  }

  // Sizes are only evaluated for the >= MIN_BYTES path, but the wrappers still
  // run on every call — keep them branch-only to stay off the hot path.
  function wrap(name, sizeOf) {
    const orig = Buffer[name];
    if (typeof orig !== 'function' || orig.__zwebuiMemAttr) return;
    const label = 'Buffer.' + name;
    const wrapped = function (...args) {
      const size = sizeOf(args);
      if (size >= MIN_BYTES) account(size, label);
      return orig.apply(Buffer, args);
    };
    wrapped.__zwebuiMemAttr = true;
    try { Buffer[name] = wrapped; } catch (_e) { /* frozen in some runtimes; skip */ }
  }

  // Approximations on purpose: for strings `length` is a lower bound on the
  // byte size, and Buffer.byteLength would scan the whole string on every
  // Buffer.from() call. The gate only decides whether to account.
  const lenOf = (v) => {
    if (typeof v === 'string') return v.length;
    if (v && typeof v.byteLength === 'number') return v.byteLength;
    if (v && typeof v.length === 'number') return v.length;
    return 0;
  };
  wrap('alloc', (a) => Number(a[0]) || 0);
  wrap('allocUnsafe', (a) => Number(a[0]) || 0);
  wrap('allocUnsafeSlow', (a) => Number(a[0]) || 0);
  wrap('from', (a) => lenOf(a[0]));
  wrap('concat', (a) => {
    const list = a[0];
    if (!Array.isArray(list)) return 0;
    let total = 0;
    for (const b of list) total += b && typeof b.length === 'number' ? b.length : 0;
    return total;
  });

  // ---- handle backlog summary (only computed when a spike needs explaining) --
  function handleSummary() {
    const groups = new Map(); // name -> { n, queued }
    try {
      const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
      for (const h of handles) {
        if (!h) continue;
        const name = (h.constructor && h.constructor.name) || 'Handle';
        let queued = 0;
        try {
          if (typeof h.writableLength === 'number') queued = h.writableLength;
          if (typeof h.bufferSize === 'number' && h.bufferSize > queued) queued = h.bufferSize;
        } catch (_e) { /* ignore */ }
        const cur = groups.get(name) || { n: 0, queued: 0, queuedN: 0 };
        cur.n += 1;
        if (queued > 0) { cur.queued += queued; cur.queuedN += 1; }
        groups.set(name, cur);
      }
    } catch (_e) { /* ignore */ }
    return [...groups.entries()]
      .sort((a, b) => b[1].queued - a[1].queued || b[1].n - a[1].n)
      .slice(0, 6)
      .map(([name, g]) => name + '=' + g.n + (g.queued > 0 ? '(queued=' + mb(g.queued) + ' in ' + g.queuedN + ')' : ''));
  }

  function report(deltaExternal, deltaBytes, elapsedMs) {
    const u = lastUsage;
    console.error(TAG + ' build=1 spike=+' + mb(deltaExternal) + ' in ' + (elapsedMs / 1000).toFixed(1) + 's' +
      ' rss=' + mb(u.rss) + ' heapUsed=' + mb(u.heapUsed) + ' heapTotal=' + mb(u.heapTotal) +
      ' external=' + mb(u.external) + ' arrayBuffers=' + mb(u.arrayBuffers));
    if (sites.size > 0) {
      const top = [...sites.entries()]
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .slice(0, 8)
        .map(([key, v]) => '+' + mb(v.bytes) + ' x' + v.count + ' ' + key);
      console.error(TAG + ' tracked allocations this window: +' + mb(deltaBytes) + ' in ' + windowCount + ' call(s)');
      for (const line of top) console.error(TAG + '   ' + line.slice(0, 400));
    } else {
      console.error(TAG + ' no tracked Buffer (>= ' + mb(MIN_BYTES) + ') allocations this window —' +
        ' growth is likely small-buffer/stream queueing (see handles)');
    }
    console.error(TAG + ' handles: ' + (handleSummary().join(' ') || '(none)'));
    sites.clear();
    windowBytes = 0;
    windowCount = 0;
    windowStartAt = 0;
    reportedAt = Date.now();
  }

  function sample() {
    const u = usage();
    const now = Date.now();
    const deltaExternal = u.external - lastUsage.external;
    const elapsed = Math.max(1, now - lastSampleAt);
    if (VERBOSE) {
      console.error(TAG + ' sample rss=' + mb(u.rss) + ' ext=' + mb(u.external) + ' dExt=' + mb(deltaExternal) + ' dTracked=' + mb(windowBytes));
    }
    lastUsage = u;
    lastSampleAt = now;
    // External memory is the Buffer/ArrayBuffer pool; a spike there is what
    // took the box down. Also report a large *tracked* window even when the
    // external delta is small (allocations freed by GC between samples).
    const spike = deltaExternal >= SPIKE_BYTES || windowBytes >= SPIKE_BYTES;
    if (!spike) {
      // Roll the window so a slow drip of >=1MB allocations is still
      // attributable without keeping counters forever.
      if (windowStartAt > 0 && now - windowStartAt > REPORT_MS) {
        sites.clear();
        windowBytes = 0;
        windowCount = 0;
        windowStartAt = 0;
      }
      return;
    }
    if (now - reportedAt < REPORT_MS) return; // throttled; keep accumulating
    report(deltaExternal, windowBytes, elapsed);
  }

  const timer = setInterval(() => {
    try { sample(); } catch (_e) { /* the host must keep running */ }
  }, INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  if (VERBOSE) console.error(TAG + ' armed (min=' + mb(MIN_BYTES) + ' spike=' + mb(SPIKE_BYTES) + ' interval=' + INTERVAL_MS + 'ms)');
})();
