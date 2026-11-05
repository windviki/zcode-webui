// zcode-webui bootstrap:
// 1) rewrite the URL with the query params the official renderer expects
// 2) bridge the official renderer's MessagePort to the backend, over WebSocket
//    with an automatic HTTP long-polling fallback (for SSO/reverse proxies that
//    do not forward WebSocket upgrades)
// 3) forward browser errors to the server log + show a visible banner
(function () {
  'use strict';
  var cfg = window.__ZCODE_WEBUI_CONFIG__ || {};
  var base = cfg.base || '';

  // The official renderer stores its ZCode protocol clientId in localStorage,
  // one random id per browser. The zcode-server host accepts only ONE clientId
  // per host, so a second device presenting its own id gets
  // "fault.connection.clientChanged". Force every browser/device to use the
  // server-injected shared deviceId as the protocol client identity.
  try {
    localStorage.setItem('zcode-v4-client-id:v1', cfg.deviceId || 'zcode-webui-client');
  } catch (e) { /* ignore */ }

  // ---- tab identity (survives reloads, unique per tab) ----
  var TAB_ID = '';
  try { TAB_ID = sessionStorage.getItem('zwebui_tab') || ''; } catch (e) { /* ignore */ }
  if (!TAB_ID) {
    TAB_ID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('tab-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    try { sessionStorage.setItem('zwebui_tab', TAB_ID); } catch (e) { /* ignore */ }
  }

  // ---- presence lease (keeps this tab's server session alive while open) ----
  // The server keeps a parked renderer era for a hot resume, but it cannot tell
  // "the browser is still sitting on this tab" from "the page is gone" just by
  // looking at a dead socket. Before this heartbeat a tab left in the
  // background for a long time lost its parked era (10 min) and then its host
  // (30 min), so coming back forced a full page reload.
  //
  // The page renews the lease over plain HTTP, which keeps working when the
  // websocket/proxy path is down. Closing the tab sends an explicit
  // closing=true; if that beacon is lost the lease simply expires. Best-effort:
  // a failed presence request must never surface as an error banner.
  var PRESENCE_EVERY_MS = 45000;
  var PRESENCE_FROZEN_MS = 12 * 60 * 60 * 1000;
  var presenceTimer = 0;
  var presenceClosed = false;
  function postPresence(closing, ttlMs) {
    if (presenceClosed && !closing) return;
    try {
      var body = {
        tab: TAB_ID,
        state: document.visibilityState || 'unknown',
        closing: !!closing
      };
      if (ttlMs > 0) body.ttlMs = ttlMs;
      fetch('api/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: !!(closing || ttlMs > 0)
      }).catch(function () { /* presence is advisory only */ });
    } catch (e) { /* ignore */ }
  }
  // A frozen/bfcache page cannot run the 45 s heartbeat. Ask the server to hold
  // the lease long enough for a phone tab that the OS freezes for hours; the
  // next normal heartbeat (resume/visible) shortens it again. A really closed
  // tab sends closing=true from pagehide, so this long lease is only a fallback.
  function holdPresenceForFreeze() { postPresence(false, PRESENCE_FROZEN_MS); }
  try {
    document.addEventListener('freeze', holdPresenceForFreeze);
    document.addEventListener('resume', function () { postPresence(false); });
  } catch (e) { /* Page Lifecycle API not available */ }
  function startPresence() {
    postPresence(false);
    if (presenceTimer) return;
    presenceTimer = setInterval(function () { postPresence(false); }, PRESENCE_EVERY_MS);
  }
  startPresence();

  // ---- browser-side diagnostics: forward errors to the server log + visible banner ----
  // Banner rules (learned the hard way): it floats over the bottom-left of the
  // app, so it must NEVER take pointer events — a collapsed sidebar section
  // underneath used to become unclickable until a page refresh. Plain error
  // lines also self-remove after 20s (log forwarding keeps the full record);
  // notices with action buttons stay until clicked and are never clobbered by
  // later transient errors.
  var reported = 0;
  var lastDelivered = [];
  var bannerTimer = 0;
  var BANNER_NOISE = [
    'ResizeObserver loop completed',   // browser layout noise, always benign
  ];
  function bannerEl() {
    var el = document.getElementById('zcode-webui-error');
    if (!el) {
      el = document.createElement('div');
      el.id = 'zcode-webui-error';
      el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:min(60%,520px);max-height:132px;overflow:hidden;background:#2b0f10;color:#ffb4ab;font:12px/1.5 monospace;padding:8px 10px;border-radius:8px;white-space:pre-wrap;word-break:break-all;pointer-events:none;';
      document.body.appendChild(el);
    }
    return el;
  }
  // Ring of the last few delivered frames, attached to the next error report so
  // a crash can be traced to the frame that preceded it. It used to set
  // window.__zb_debug = true as a side effect, which then turned on a
  // console.debug PER FRAME for the rest of the page's life — expensive with
  // devtools open (devtools formats every call) and observed on a page that had
  // 56 errors and ~25-40 frames/s. Debug logging is now strictly opt-in
  // (?zbdebug=1); this ring only records.
  function noteDelivered(hex, len) {
    lastDelivered.push(len + 'B:' + hex);
    if (lastDelivered.length > 4) lastDelivered.shift();
  }
  function report(kind, message, stack) {
    if (reported++ > 12) return;
    var extra = ' [transport=' + mode + '] [lastDelivered: ' + lastDelivered.join(' | ') + ']';
    try {
      // .catch: the reporter must never produce the very rejection it reports
      fetch('api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ href: window.location.href, kind: kind, message: message + extra, stack: stack || '' }),
        keepalive: true
      }).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
    var msg = String(message || '');
    for (var i = 0; i < BANNER_NOISE.length; i++) {
      if (msg.indexOf(BANNER_NOISE[i]) >= 0) return;   // log-only, no banner
    }
    try {
      var el = bannerEl();
      if (el.querySelector('button')) return;          // an active notice outranks this line
      el.textContent = '[zcode-webui] ' + kind + ': ' + msg + (stack ? '\n' + String(stack).slice(0, 600) : '');
      if (bannerTimer) clearTimeout(bannerTimer);
      bannerTimer = setTimeout(function () {
        bannerTimer = 0;
        var b = document.getElementById('zcode-webui-error');
        if (b && !b.querySelector('button')) b.remove();
      }, 20000);
    } catch (e2) { /* ignore */ }
  }
  window.addEventListener('error', function (ev) {
    report('error', (ev.message || '') + (ev.filename ? ' @' + ev.filename + ':' + ev.lineno : ''), ev.error && ev.error.stack);
  });
  window.addEventListener('unhandledrejection', function (ev) {
    report('unhandledrejection', String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason), ev.reason && ev.reason.stack);
  });
  (function () {
    var orig = console.error;
    console.error = function () {
      orig.apply(console, arguments);
      var msg = Array.prototype.map.call(arguments, function (a) { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); } }).join(' ');
      report('console.error', msg.slice(0, 500));
    };
  })();

  // banner with an action button (parked tab / lost connection). A notice is
  // sticky by design (report() must not clobber it), so it also needs an
  // explicit way out that does NOT perform the action: the offline-gap notice
  // after a long background is advisory, and forcing a reload just to clear it
  // is exactly the behaviour this shim is trying to avoid.
  function dismissNotice() {
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = 0; }
    var el = document.getElementById('zcode-webui-error');
    if (el) el.remove();
  }
  function showNotice(text, buttonText, onClick, closable) {
    try {
      if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = 0; }
      var el = bannerEl();
      el.innerHTML = '';
      var t = document.createElement('div');
      t.textContent = '[zcode-webui] ' + text;
      el.appendChild(t);
      if (!buttonText && !closable) return;
      var row = document.createElement('div');
      row.style.cssText = 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
      if (buttonText) {
        var b = document.createElement('button');
        b.textContent = buttonText;
        b.style.cssText = 'background:#2f6fed;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;pointer-events:auto;';
        b.addEventListener('click', onClick);
        row.appendChild(b);
      }
      if (closable) {
        var c = document.createElement('button');
        c.textContent = '关闭';
        c.setAttribute('aria-label', '关闭提示');
        c.title = '关闭提示（不重新同步）';
        c.style.cssText = 'background:transparent;color:#9fb3c8;border:1px solid #40536a;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;pointer-events:auto;';
        c.addEventListener('click', dismissNotice);
        row.appendChild(c);
      }
      el.appendChild(row);
    } catch (e) { /* ignore */ }
  }

  // ---- cross-device execution visibility ----
  // When another host of this account is still mid-turn (e.g. a laptop that
  // slept and resumed), a freshly loaded second device renders only persisted
  // data — an interrupted-looking history invites a duplicate "continue" that
  // makes TWO agents drive the same workspace. Surface it loudly instead.
  var bgTimer = null;
  function dismissBackground() {
    if (bgTimer) { clearInterval(bgTimer); bgTimer = null; }
    var el = document.getElementById('zcode-webui-background');
    if (el) el.remove();
  }
  function paintBackground(hosts) {
    var el = document.getElementById('zcode-webui-background');
    if (!el) {
      el = document.createElement('div');
      el.id = 'zcode-webui-background';
      el.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483646;max-width:min(60%,460px);background:#26313f;color:#ffd479;font:12px/1.5 monospace;padding:10px 12px;border-radius:8px;box-shadow:0 2px 14px rgba(0,0,0,.35);';
      document.body.appendChild(el);
    }
    el.textContent = '';
    var t = document.createElement('div');
    var ages = hosts.map(function (h) { return h.lastFrameAgeSec === null ? '?' : h.lastFrameAgeSec; });
    t.textContent = '[zcode-webui] 后台仍有任务在执行（pid ' +
      hosts.map(function (h) { return h.pid; }).join(',') + '，最近活动 ' + ages.join('/') + ' 秒前）——' +
      '它由之前离开的设备启动，正在持续产出。可继续在本页查看进度；确认不再需要时才终止。';
    var row = document.createElement('div');
    row.style.cssText = 'margin-top:8px;display:flex;gap:8px;';
    var btnKill = document.createElement('button');
    btnKill.textContent = '终止后台执行并刷新';
    btnKill.style.cssText = 'background:#c0392b;color:#fff;border:0;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit;';
    btnKill.onclick = function () {
      btnKill.disabled = true;
      // relative paths only — under the code-server /proxy/<port> mode the prefix
      // is stripped before forwarding, so absolute paths would escape it
      fetch('api/sessions/terminate?user=1&keepTab=' + encodeURIComponent(TAB_ID), { method: 'POST' })
        .catch(function () {})
        .then(function () { setTimeout(function () { window.location.reload(); }, 600); });
    };
    var btnDismiss = document.createElement('button');
    btnDismiss.textContent = '忽略';
    btnDismiss.style.cssText = 'background:transparent;color:#9fb3c8;border:1px solid #40536a;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit;';
    btnDismiss.onclick = function () { dismissBackground(); };
    row.appendChild(btnKill); row.appendChild(btnDismiss);
    el.appendChild(t); el.appendChild(row);
  }
  function updateBackground(info) {
    try {
      var active = (info && info.hosts || []).filter(function (h) { return h.active; });
      if (!active.length) { dismissBackground(); return; }
      paintBackground(active);
    } catch (e) { /* never break the page over cosmetics */ }
  }
  function watchBackground(pushInfo) {
    if (pushInfo) updateBackground(pushInfo);
    if (bgTimer) return;
    bgTimer = setInterval(function () {
      fetch('api/background?tab=' + encodeURIComponent(TAB_ID)).then(function (r) { return r.json(); }).then(updateBackground).catch(function () {});
    }, 45000);
  }

  // ---- URL params for the official renderer ----
  try {
    var params = new URLSearchParams(window.location.search);
    var changed = false;
    if (!params.get('locale') && cfg.locale) { params.set('locale', cfg.locale); changed = true; }
    if (!params.get('windowKind')) { params.set('windowKind', 'main'); changed = true; }
    if (cfg.workspace && !params.get('initialWorkspacePath')) { params.set('initialWorkspacePath', cfg.workspace); changed = true; }
    if (changed) {
      window.history.replaceState(null, '', window.location.pathname + '?' + params.toString());
    }
  } catch (err) { /* ignore */ }

  // ---- transport selection: ws first, http long-poll fallback ----
  var mode = 'ws';
  var ws = null;
  var wsOpened = false;
  var port2 = null;
  var delivered = false;
  var httpSessionId = null;
  var uplinkChain = Promise.resolve();
  var reloadAttempts = 0;
  var portQueue = []; // binary frames that arrive before the renderer's port exists
  var wsOpenFails = 0;      // consecutive ws open failures (http-fallback ladder, see onclose)
  var httpRetryTimer = 0;   // bridge/open retry when the http fallback itself cannot open
  var httpRetryDelay = 2000;
  // Frames the renderer sent while no transport was open — flushed as soon as a
  // transport comes back. Without this, service calls made during a dead-socket
  // window (backgrounded tab, network blip) vanish silently and the UI promises
  // waiting on them never settle: file-tree opens, list refreshes etc. hang.
  var uplinkBuf = [];
  var uplinkBufBytes = 0;

  function queueUplink(data) {
    var n = (data && data.length) || 0;
    if (uplinkBuf.length < 256 && uplinkBufBytes + n <= 4 * 1024 * 1024) {
      uplinkBuf.push(data);
      uplinkBufBytes += n;
      return;
    }
    uplinkBuf.length = 0;                      // a hole in the ordering — drop all
    uplinkBufBytes = 0;
    try { console.warn('[zcode-webui] uplink queue overflow; dropped buffered frames'); } catch (e) { /* ignore */ }
  }
  function flushUplink() {
    if (!uplinkBuf.length) return;
    var q = uplinkBuf;
    uplinkBuf = [];
    uplinkBufBytes = 0;
    for (var i = 0; i < q.length; i++) sendToBridge(q[i]);
  }

  function deliverToRenderer(u8) {
    if (port2) {
      try { port2.postMessage(u8, [u8.buffer]); } catch (e) { /* ignore */ }
      return;
    }
    perf.queued++;
    if (portQueue.length < 64) portQueue.push(u8);
  }

  // ---- performance telemetry -------------------------------------------------
  // "zcode-webui 最近很卡" needs measurements, not guesses. The shim is the only
  // place that sees both halves of the conversation at once, so it samples the
  // two things that actually cause perceived lag here:
  //
  //   1. the traffic it pushes into the renderer — frames/s, bytes/s, the largest
  //      frames and the biggest poll batch. A streaming turn emits ~25-40 RPC
  //      frames/s (measured from the host's own frame counters), and every frame
  //      walks the renderer's whole RPC channel and usually a React update;
  //   2. main-thread blockage: long tasks (passive PerformanceObserver) plus a
  //      short rAF sampling window per report (p50/p95/max interval + jank
  //      counts), heap and DOM size.
  //
  // Every report posts ONE compact line to the server (kind=perf) so the server
  // log itself carries the timeline; the full object is one call away:
  //   window.__zwebui_perf()           current snapshot (object)
  //   window.__zwebui_perf_sample(ms)  Promise<fps stats> — runs a rAF window
  //   window.__zwebui_perf_report()    force a report now (also logs it)
  //   window.__zwebui_perf_reset()     zero the counters
  // Cost per frame: a handful of counter increments. Cost per 30s: one 6s rAF
  // window (20% duty cycle). No layout reads, no string building until report.
  var PERF_REPORT_MS = Math.max(Number((cfg && cfg.perfIntervalMs)) || 30000, 5000);
  var PERF_RAF_WINDOW_MS = 6000;
  var perf = {
    at: Date.now(),
    inFrames: 0, inBytes: 0, outFrames: 0, outBytes: 0,
    maxFrame: 0, maxFrameHex: '', topFrames: [],
    types: {},                       // first byte (RPC preset 0..6) -> count
    queued: 0,
    batches: 0, maxBatchFrames: 0, maxBatchBytes: 0,
    polls: 0, pollMs: [], pollMaxMs: 0, pollFail: 0,
    wsOpens: 0, fallbacks: 0, reconnects: 0, httpOpens: 0,
    preReadyFrames: 0, controlDrops: 0,
    longTasks: 0, longTotal: 0, longMax: 0, longTop: [],
    fps: null, fpsAt: 0, fpsHidden: 0, fpsStalled: 0,
    reports: 0, lastReport: '',
    // cumulative since load/reset (the 30s log line reports the interval; the
    // on-demand snapshot shows both, so a short collection is still readable)
    totInFrames: 0, totInBytes: 0, totOutFrames: 0, totOutBytes: 0,
    totLongTasks: 0, totLongTotal: 0, totLongMax: 0,
    // 60 one-second buckets for frames/bytes (peak rate + last-minute totals)
    buckets: [],
  };
  function perfBucket(now) {
    var s = Math.floor(now / 1000);
    var b = perf.buckets[s % 60];
    if (!b || b.sec !== s) { b = { sec: s, frames: 0, bytes: 0 }; perf.buckets[s % 60] = b; }
    return b;
  }
  // one inbound frame as delivered to the renderer (called from the ws handler
  // and from the http frame parser)
  function perfIn(bytes, firstByte, hex) {
    perf.inFrames++;
    perf.inBytes += bytes || 0;
    perf.totInFrames++;
    perf.totInBytes += bytes || 0;
    if (!hex) { hex = ''; for (var i = 0; i < Math.min(bytes || 0, 8); i++) hex += '..'; }
    if ((bytes || 0) > perf.maxFrame) { perf.maxFrame = bytes || 0; perf.maxFrameHex = hex || ''; }
    if (perf.topFrames.length < 5 || (bytes || 0) > perf.topFrames[perf.topFrames.length - 1].bytes) {
      perf.topFrames.push({ bytes: bytes || 0, hex: hex || '', t: Date.now() });
      perf.topFrames.sort(function (a, b) { return b.bytes - a.bytes; });
      if (perf.topFrames.length > 5) perf.topFrames.length = 5;
    }
    var b = perfBucket(Date.now());
    b.frames++; b.bytes += bytes || 0;
    if (typeof firstByte === 'number') perf.types[firstByte] = (perf.types[firstByte] || 0) + 1;
  }
  function perfOut(bytes) {
    perf.outFrames++;
    perf.outBytes += bytes || 0;
    perf.totOutFrames++;
    perf.totOutBytes += bytes || 0;
    var b = perfBucket(Date.now());
    b.outFrames++;
  }
  (function watchLongTasks() {
    try {
      if (typeof PerformanceObserver !== 'function') return;
      var po = new PerformanceObserver(function (list) {
        var es = list.getEntries();
        for (var i = 0; i < es.length; i++) {
          var d = es[i].duration;
          perf.longTasks++;
          perf.longTotal += d;
          if (d > perf.longMax) perf.longMax = d;
          perf.totLongTasks++;
          perf.totLongTotal += d;
          if (d > perf.totLongMax) perf.totLongMax = d;
          if (d >= 100) {
            var a = (es[i].attribution && es[i].attribution[0]) || null;
            perf.longTop.push({
              ms: Math.round(d),
              name: (a && (a.name || a.containerType)) || '',
              src: String((a && a.containerSrc) || '').slice(-60),
              t: Date.now(),
            });
            perf.longTop.sort(function (x, y) { return y.ms - x.ms; });
            if (perf.longTop.length > 5) perf.longTop.length = 5;
          }
        }
      });
      po.observe({ entryTypes: ['longtask'] });
    } catch (e) { /* longtask unsupported (Safari/Firefox): fps window still works */ }
  })();
  // rAF jank sampling window. Runs for PERF_RAF_WINDOW_MS at a time so the page
  // is not kept awake by a permanent animation-frame loop.
  function perfSampleFps(ms, done) {
    var windowMs = Math.max(1000, Number(ms) || PERF_RAF_WINDOW_MS);
    var started = performance.now();
    var t0 = 0;
    var intervals = [];
    var stalled = 0;
    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      if (stalled) perf.fpsStalled++;
      if (!intervals.length) { perf.fps = { frames: 0, p50: 0, p95: 0, max: 0, jank50: 0, jank100: 0, jank250: 0, hidden: true }; }
      else {
        var s = intervals.slice().sort(function (a, b) { return a - b; });
        var pick = function (p) { return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10; };
        var j = function (v) { var n = 0; for (var i = 0; i < intervals.length; i++) if (intervals[i] >= v) n++; return n; };
        perf.fps = {
          frames: intervals.length, windowMs: Math.round(performance.now() - started),
          p50: pick(0.5), p95: pick(0.95), max: Math.round(s[s.length - 1] * 10) / 10,
          jank50: j(50), jank100: j(100), jank250: j(250),
        };
      }
      perf.fpsAt = Date.now();
      if (done) { try { done(perf.fps); } catch (e) { /* ignore */ } }
    }
    if (document.hidden) { stalled = 1; setTimeout(finish, 0); return; }
    // hard deadline in case rAF stalls completely (throttled tab / frozen frame)
    var guard = setTimeout(function () { stalled = 1; finish(); }, windowMs + 4000);
    var prev = 0;
    function tick(now) {
      if (finished) return;
      if (prev) intervals.push(now - prev);
      prev = now;
      if (now - started >= windowMs) { clearTimeout(guard); finish(); return; }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  function perfRate() {
    var now = Date.now();
    var sumF = 0, sumB = 0, peak = 0;
    for (var i = 0; i < 60; i++) {
      var b = perf.buckets[i];
      if (!b) continue;
      if (now - b.sec * 1000 > 60000) continue;
      sumF += b.frames; sumB += b.bytes;
      if (b.frames > peak) peak = b.frames;
    }
    return { framesPerSec: Math.round(sumF / 60 * 10) / 10, kbPerSec: Math.round(sumB / 1024 / 60 * 10) / 10, peakFramesPerSec: peak, minuteFrames: sumF, minuteBytes: sumB };
  }
  function kb(n) { return Math.round((n || 0) / 1024 * 10) / 10 + 'kB'; }
  function perfSnapshot() {
    var r = perfRate();
    var mem = null;
    try {
      if (performance.memory) {
        mem = {
          usedMb: Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10,
          totalMb: Math.round(performance.memory.totalJSHeapSize / 1048576 * 10) / 10,
          limitMb: Math.round(performance.memory.jsHeapSizeLimit / 1048576 * 10) / 10,
        };
      }
    } catch (e) { /* not available */ }
    var nodes = 0;
    try { nodes = document.getElementsByTagName('*').length; } catch (e) { /* ignore */ }
    return {
      upSec: Math.round((Date.now() - perf.at) / 1000),
      transport: mode,
      traffic: { inFrames: perf.inFrames, inBytes: perf.inBytes, outFrames: perf.outFrames, outBytes: perf.outBytes, queued: perf.queued, kbPerSec: r.kbPerSec, framesPerSec: r.framesPerSec, peakFramesPerSec: r.peakFramesPerSec, minuteFrames: r.minuteFrames, minuteBytes: r.minuteBytes, types: perf.types },
      totals: { inFrames: perf.totInFrames, inBytes: perf.totInBytes, outFrames: perf.totOutFrames, outBytes: perf.totOutBytes, longTasks: perf.totLongTasks, longTotalMs: Math.round(perf.totLongTotal), longMaxMs: Math.round(perf.totLongMax) },
      frames: { maxBytes: perf.maxFrame, maxHex: perf.maxFrameHex, top: perf.topFrames.slice(0, 5) },
      batches: { polls: perf.batches, maxFrames: perf.maxBatchFrames, maxBytes: perf.maxBatchBytes },
      poll: { count: perf.polls, maxMs: perf.pollMaxMs, p50: pctl(perf.pollMs, 0.5), p95: pctl(perf.pollMs, 0.95), failed: perf.pollFail },
      ws: { opens: perf.wsOpens, fallbacks: perf.fallbacks, reconnects: perf.reconnects, httpOpens: perf.httpOpens, preReadyFrames: perf.preReadyFrames, controlDrops: perf.controlDrops },
      longTasks: { count: perf.longTasks, totalMs: Math.round(perf.longTotal), maxMs: Math.round(perf.longMax), top: perf.longTop.slice(0, 5) },
      fps: perf.fps, fpsAt: perf.fpsAt, fpsHidden: perf.fpsHidden, fpsStalled: perf.fpsStalled,
      heap: mem, domNodes: nodes,
      hidden: document.hidden, reports: perf.reports, lastReport: perf.lastReport,
    };
  }
  function pctl(arr, p) {
    if (!arr || !arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10;
  }
  function perfReport(force) {
    var now = Date.now();
    if (!force && perfLastTick && now - perfLastTick < PERF_REPORT_MS - 1000) return;
    perfLastTick = now;
    perf.reports++;
    var s = perfSnapshot();
    var f = s.fps;
    var line = 'up=' + s.upSec + 's transport=' + s.transport +
      ' in=' + s.traffic.inFrames + 'f/' + kb(s.traffic.inBytes) +
      ' out=' + s.traffic.outFrames + 'f/' + kb(s.traffic.outBytes) +
      ' rate=' + s.traffic.framesPerSec + 'f/s ' + s.traffic.kbPerSec + 'kB/s peak=' + s.traffic.peakFramesPerSec + 'f/s' +
      ' max=' + kb(s.frames.maxBytes) + (s.frames.maxHex ? ':' + s.frames.maxHex : '') +
      ' polls=' + s.batches.polls + ' batchMax=' + s.batches.maxFrames + 'f/' + kb(s.batches.maxBytes) +
      (s.poll.count ? ' rtt=' + s.poll.p50 + '/' + s.poll.p95 + '/' + s.poll.maxMs + 'ms' : '') +
      ' ws=' + s.ws.opens + '/fb' + s.ws.fallbacks + '/rc' + s.ws.reconnects +
      ' lt=' + s.longTasks.count + '/' + s.longTasks.totalMs + 'ms max' + s.longTasks.maxMs +
      (f ? ' fps=' + f.p50 + '/' + f.p95 + '/' + f.max + ' jank50=' + f.jank50 : ' fps=na') +
      (s.heap ? ' heap=' + s.heap.usedMb + 'MB' : '') +
      ' dom=' + s.domNodes + (s.hidden ? ' hidden' : '');
    perf.lastReport = line;
    s.lastReport = line;
    try {
      fetch('api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ href: window.location.href, kind: 'perf', message: line.slice(0, 480) }),
        keepalive: true,
      }).catch(function () { /* never surface as an error */ });
    } catch (e) { /* ignore */ }
    // keep the counters bounded: rates are windowed by the buckets, totals are
    // per-report-interval so the numbers describe "now", not "since load"
    var carryIn = perf.inFrames, carryOut = perf.outFrames;
    perf.inFrames = 0; perf.inBytes = 0; perf.outFrames = 0; perf.outBytes = 0;
    perf.batches = 0; perf.maxBatchFrames = 0; perf.maxBatchBytes = 0;
    perf.polls = 0; perf.pollMs = []; perf.pollMaxMs = 0; perf.pollFail = 0;
    perf.longTasks = 0; perf.longTotal = 0; perf.longMax = 0;
    perf.lastTotalIn = (perf.lastTotalIn || 0) + carryIn;
    perf.lastTotalOut = (perf.lastTotalOut || 0) + carryOut;
    // start the next fps window right after reporting (20% duty cycle)
    perfSampleFps(PERF_RAF_WINDOW_MS);
  }
  var perfLastTick = 0;
  function perfReset() {
    perf.at = Date.now();
    perf.inFrames = 0; perf.inBytes = 0; perf.outFrames = 0; perf.outBytes = 0;
    perf.maxFrame = 0; perf.maxFrameHex = ''; perf.topFrames = []; perf.types = {};
    perf.totInFrames = 0; perf.totInBytes = 0; perf.totOutFrames = 0; perf.totOutBytes = 0;
    perf.totLongTasks = 0; perf.totLongTotal = 0; perf.totLongMax = 0;
    perf.queued = 0; perf.batches = 0; perf.maxBatchFrames = 0; perf.maxBatchBytes = 0;
    perf.polls = 0; perf.pollMs = []; perf.pollMaxMs = 0; perf.pollFail = 0;
    perf.longTasks = 0; perf.longTotal = 0; perf.longMax = 0; perf.longTop = [];
    perf.reports = 0; perf.lastReport = ''; perf.buckets = [];
    return true;
  }
  window.__zwebui_perf = perfSnapshot;
  window.__zwebui_perf_report = function () { perfReport(true); return perfSnapshot(); };
  window.__zwebui_perf_reset = function () { perfReset(); perfLastTick = 0; return true; };
  window.__zwebui_perf_sample = function (ms) {
    return new Promise(function (resolve) { perfSampleFps(Number(ms) || 5000, resolve); });
  };
  setInterval(function () { try { perfReport(false); } catch (e) { /* ignore */ } }, Math.max(PERF_REPORT_MS, 5000));
  setTimeout(function () { try { perfReport(true); } catch (e) { /* ignore */ } }, Math.min(15000, PERF_REPORT_MS));

  // Server control line (JSON). Arrives as a ws text message, or as a '{"…'
  // payload in the HTTP relay frame stream — one handler for both transports, so
  // startup states / pongs / gap notices behave identically on either.
  // Returns true when the line was a control message (callers skip delivery).
  function handleControlText(text) {
    var data = String(text);
    try {
      var ctrl = JSON.parse(data);
      if (ctrl && ctrl.kind === 'zcode-webui-background') { watchBackground(ctrl); return true; }
      if (ctrl && ctrl.kind === 'zcode-webui-background-cleared') { dismissBackground(); return true; }
      if (ctrl && ctrl.kind === 'zcode-webui-startup') { postRealStartupState(ctrl.state); return true; }
      if (ctrl && ctrl.kind === 'zcode-webui-pong') { pongSeen = true; return true; }   // liveness only
      if (ctrl && ctrl.kind === 'zcode-webui-gap') {
        // the offline gap overflowed the server's replay buffer: the page was
        // deliberately kept alive instead of reloaded, so say what was lost.
        // Resyncing is the safe choice when the UI looks wrong, but it is not
        // always needed — the notice must be dismissible without reloading.
        showNotice('连接已恢复，但离线期间的部分事件未能送达。界面无异常时可关闭此提示继续使用；若显示异常，请重新同步。',
          '重新同步', function () { window.location.reload(); }, true);
        return true;
      }
      // The peer-verification line the ws handshake uses ('…-ready'). Over the
      // HTTP relay the server sends it as a regular frame (it is the FIRST frame
      // of every /bridge/open), and it used to fall through to
      // deliverToRenderer: the official RPC client then decoded JSON as an RPC
      // message and threw "Cannot read properties of undefined (reading '0')"
      // inside its MessagePort handler — 56x in the server log on 2026-11-03/04.
      if (ctrl && ctrl.kind === 'zcode-webui-ready') {
        if (ctrl.startupMode === 'runtime' && ctrl.startupId) {
          serverStartup = { mode: 'runtime', startupId: String(ctrl.startupId) };
        }
        return true;
      }
      // Anything else in the shim's namespace is a control line too: consume it
      // instead of feeding it to the renderer (a future server control kind must
      // never be able to crash the RPC channel again).
      if (ctrl && typeof ctrl.kind === 'string' && ctrl.kind.indexOf('zcode-webui-') === 0) {
        try { console.debug('[zcode-webui] unknown control line: ' + data.slice(0, 120)); } catch (e2) { /* ignore */ }
        return true;
      }
    } catch (e) { /* not a control message */ }
    console.debug('[zcode-webui]', data);
    return false;
  }

  // The official renderer's service-port handshake changed in 3.12:
  //   <= 3.11  window.postMessage('zcode:service-port', '*', [port])      (bare string)
  //   >= 3.12  window.postMessage({type:'zcode:service-port',
  //                                databaseStartupId}, '*', [port])       (object)
  //            ...and the app only boots once it has ALSO received a
  //            'zcode:database-startup-state' message whose state.phase === 'ready'
  //            and state.startupId === message.databaseStartupId.
  // In the desktop app the main process opens/migrates the local database and reports
  // that progress; here the official runtime owns the database, so we simply report
  // "ready". Without it 3.12+ renders its startup-failure screen
  // ("未能收到启动状态" / startup-channel-unavailable) after 30s.
  // The deployed renderer version arrives in cfg (src/server.mjs), so exactly one
  // handshake is sent — never both, which would leak queued frames on the unused port.
  function rendererAtLeast(major, minor) {
    var parts = String((cfg && cfg.rendererVersion) || '').split('.');
    if (parts.length < 2) return false;
    var M = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (isNaN(M) || isNaN(m)) return false;
    return M > major || (M === major && m >= minor);
  }

  var lastStartupStateMsg = null;
  function postDatabaseStartupState(startupId) {
    var now = Date.now();
    var msg = {
      type: 'zcode:database-startup-state',
      state: {
        schemaVersion: 1,
        startupId: startupId,
        attemptId: 'zcode-webui-startup',
        sequence: 1,
        startedAt: now,
        updatedAt: now,
        phase: 'ready',
        databasePhase: 'ready',
        disk: []
      }
    };
    lastStartupStateMsg = msg;
    var send = function () { try { window.postMessage(msg, '*'); } catch (e) { /* ignore */ } };
    send();
    // the renderer registers its message listener in the same module execution that
    // sets __ZCODE_RENDERER_START__, so re-send once to beat the race (duplicates are
    // ignored by the renderer's startupId+sequence rule)
    setTimeout(send, 500);
  }

  // >= 3.16: forward the host's real startup states (migration progress), with
  // the same duplicate-race treatment as the synthesized one.
  function postRealStartupState(state) {
    if (!state || typeof state !== 'object') return;
    var msg = { type: 'zcode:database-startup-state', state: state };
    var send = function () { try { window.postMessage(msg, '*'); } catch (e) { /* ignore */ } };
    var prev = lastStartupStateMsg && lastStartupStateMsg.state;
    // same startupId + sequence never goes backwards (renderer ignores replays)
    if (prev && prev.startupId === state.startupId && typeof prev.sequence === 'number' &&
        typeof state.sequence === 'number' && state.sequence < prev.sequence) return;
    lastStartupStateMsg = msg;
    send();
    setTimeout(send, 300);
  }

  // HTTP fallback has no control line: poll the relay's startup state until the
  // host reports ready (a migration can take minutes; the renderer shows it).
  var startupPollTimer = 0;
  function pollStartupState() {
    if (startupPollTimer || !httpSessionId) return;
    var tick = function () {
      startupPollTimer = 0;
      if (mode !== 'http' || !httpSessionId) return;
      fetch('bridge/state?id=' + encodeURIComponent(httpSessionId))
        .then(function (r) { return r.json(); })
        .then(function (o) {
          if (o && o.state) postRealStartupState(o.state);
          var ready = o && o.state && o.state.phase === 'ready';
          if (!ready) startupPollTimer = setTimeout(tick, 1000);
        })
        .catch(function () { startupPollTimer = setTimeout(tick, 2000); });
    };
    startupPollTimer = setTimeout(tick, 700);
  }

  function requestStartupSnapshot() {
    // works on both transports: sendToBridge queues while a socket/relay is
    // down and flushes on recovery, so a snapshot request is never lost
    try { sendToBridge('{"kind":"zcode-webui-startup-snapshot"}'); } catch (e) { /* ignore */ }
  }

  // The renderer can also ASK for a state replay: at module end it posts
  // {type:'zcode:database-startup-control', control:{action:'snapshot'}} (the
  // desktop preload forwards that to the main process, whose relay re-sends the
  // latest state — the official reload-race solution). We play the "main
  // process" here and answer snapshot requests the same way, so a renderer
  // that asks later than our proactive sends still boots instead of waiting
  // out its 30s startup-status timeout. (Duplicate states are ignored by the
  // renderer's same-startupId + sequence>=rule, so re-sending is always safe.)
  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || ev.data.type !== 'zcode:database-startup-control') return;
    var c = ev.data.control || {};
    if (c.action === 'snapshot') {
      if (serverStartup.mode === 'runtime') { requestStartupSnapshot(); return; }
      if (lastStartupStateMsg) {
        try { window.postMessage(lastStartupStateMsg, '*'); } catch (e) { /* ignore */ }
      }
    }
  });

  function deliverPort() {
    if (delivered) {
      // hot reconnect: the renderer already has its port — tell the server to
      // release any buffered frames immediately (resume mode, no replay)
      try { sendToBridge('{"kind":"zcode-webui-port-ready"}'); } catch (e) { /* ignore */ }
      return;
    }
    delivered = true;
    // The official renderer registers its one-shot 'zcode:service-port' listener when
    // its module executes. Delivering before that loses the message forever (blank
    // #root). It sets window.__ZCODE_RENDERER_START__ at module scope, so wait for
    // that readiness signal, then post the port.
    var tries = 0;
    (function waitReady() {
      if (window.__ZCODE_RENDERER_START__ || tries++ > 200) {
        var channel = new MessageChannel();
        port2 = channel.port2;
        port2.onmessage = function (ev) { sendToBridge(ev.data); };
        window.__zb_port2 = port2;
        // flush frames buffered while the port was not available yet (e.g. the host
        // Initialize replayed by the backend right after a re-attach)
        for (var q = 0; q < portQueue.length; q++) {
          try { port2.postMessage(portQueue[q], [portQueue[q].buffer]); } catch (e) { /* ignore */ }
        }
        portQueue = [];
        if (rendererAtLeast(3, 12)) {
          var startupId = serverStartup.startupId || ('zcode-webui-' + ((cfg && cfg.deviceId) || 'local') + '-' + Date.now().toString(36));
          window.postMessage({ type: 'zcode:service-port', databaseStartupId: startupId }, '*', [channel.port1]);
          // >= 3.16 hosts own the database and stream real states; only the
          // legacy host (which is up by the time the handshake returns) gets the
          // synthesized ready state.
          if (serverStartup.mode !== 'runtime') postDatabaseStartupState(startupId);
          else requestStartupSnapshot();
        } else {
          window.postMessage('zcode:service-port', '*', [channel.port1]);
        }
        everDelivered = true;
        // tell the backend this renderer is now wired: an ADOPTED mid-stream host
        // releases its ordered frame buffer on this signal
        try { sendToBridge('{"kind":"zcode-webui-port-ready"}'); } catch (e) { /* ignore */ }
        return;
      }
      setTimeout(waitReady, 50);
    })();
  }

  function sendToBridge(data) {
    // flow-control objects ({__zcodeRpcControl:...}) from the official transport are
    // advisory; serialize them as JSON text so the backend can ignore them safely.
    if (data && typeof data === 'object' && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      try { data = JSON.stringify(data); } catch (e) { return; }
    }
    if (mode === 'ws') {
      if (ws && ws.readyState === 1) { try { ws.send(data); perfOut(data && data.byteLength || data && data.length || 0); } catch (e) { /* ignore */ } }
      else queueUplink(data);                       // socket down: replay when it returns
      return;
    }
    if (mode === 'http') {
      if (!httpSessionId) { queueUplink(data); return; }
      perfOut(data && data.byteLength || data && data.length || 0);
      uplinkChain = uplinkChain.then(function () {
        return fetch('bridge/send?id=' + httpSessionId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: data
        });
      }).then(function (r) {
        // never throw from this chain: a dead relay turned every queued send
        // into an unhandledrejection storm (51 logged occurrences) that kept
        // re-painting the error banner. The 410 recovery path is pollLoop's job.
        if (!r.ok && r.status !== 410) {
          try { console.warn('[zcode-webui] bridge/send HTTP ' + r.status); } catch (e) { /* ignore */ }
        }
      }, function () { /* keep chain alive */ });
    }
  }

  function parseHttpFrames(buf) {
    if (!buf || !buf.byteLength) return;
    var u8 = new Uint8Array(buf);
    var off = 0;
    var batchFrames = 0;
    var batchBytes = 0;
    while (off + 4 <= u8.length) {
      var len = (u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3];
      off += 4;
      if (len === 0 || off + len > u8.length) break;
      var payload = u8.slice(off, off + len);
      off += len;
      // Control lines (ready / startup state / pong / gap notice) share the frame
      // stream on this transport: renderer frames always start with an RPC preset
      // byte 0..6, so a leading '{' (0x7b) is unambiguously a JSON control line.
      // Every such line is consumed here and NEVER handed to the renderer — the
      // official RPC client decodes it as an RPC message and throws
      // "Cannot read properties of undefined (reading '0')" from its MessagePort
      // handler (2026-11-03/04: 56 hits in the server log, every one of them a
      // '{"kind":"zcode-webui-ready",…}' line from the /bridge/open handshake).
      // It must also not abandon the batch: this loop used to `return` on a
      // known control line, silently dropping every later frame of that poll.
      if (payload.length > 1 && payload[0] === 0x7b) {
        var text = '';
        try { text = new TextDecoder().decode(payload); } catch (e) { text = ''; }
        if (text) handleControlText(text); else perf.controlDrops++;
        continue;
      }
      var hex = '';
      for (var k = 0; k < Math.min(payload.length, 8); k++) hex += ('0' + payload[k].toString(16)).slice(-2);
      if (reported > 0) noteDelivered(hex, payload.length);        // error attribution only
      if (window.__zb_debug) console.debug('[zb-debug] deliver ' + payload.length + 'B ' + hex);
      perfIn(payload.length, payload[0], hex);
      batchFrames++; batchBytes += payload.length;
      deliverToRenderer(payload);
    }
    if (batchFrames) {
      perf.batches++;
      if (batchFrames > perf.maxBatchFrames) perf.maxBatchFrames = batchFrames;
      if (batchBytes > perf.maxBatchBytes) perf.maxBatchBytes = batchBytes;
    }
    return batchFrames;
  }

  function pollLoop() {
    if (mode !== 'http' || !httpSessionId) return;
    var t0 = performance.now();
    fetch('bridge/poll?id=' + httpSessionId)
      .then(function (r) {
        if (r.status === 410) throw new Error('session-gone');
        return r.arrayBuffer();
      })
      .then(function (buf) {
        var dt = performance.now() - t0;
        var frames = parseHttpFrames(buf);
        // A poll that returns without frames was simply held server-side until
        // its idle timeout: that duration is not latency. Only a poll woken by
        // real data measures "frame produced -> renderer fed", which is the
        // number that matters for perceived lag.
        perf.polls++;
        if (frames) {
          perf.pollMs.push(dt);
          if (perf.pollMs.length > 240) perf.pollMs.shift();
          if (dt > perf.pollMaxMs) perf.pollMaxMs = dt;
        }
        pollLoop();
      })
      .catch(function (e) {
        if (mode !== 'http') return;
        if (e && e.message === 'session-gone') {
          // relay reaped server-side (idle TTL / restart). Without this branch
          // the loop used to spin on 410s forever with no recovery. Prefer the
          // ws hot-resume path — the tab's era may still be parked on the
          // session host; if it is gone the server answers close 4000 and the
          // page reloads clean.
          httpSessionId = null;
          perf.pollFail++;
          recoverTransport();
          return;
        }
        perf.pollFail++;
        setTimeout(pollLoop, 1000);
      });
  }

  // Bring SOME transport back when the current one is verifiably dead, always
  // preferring the ws hot-resume path (it keeps the renderer era alive and the
  // server replays the offline gap).
  function recoverTransport() {
    if (mode === 'ws') {
      if (!ws || ws.readyState > 1) connect();
      return;
    }
    if (httpRetryTimer) { clearTimeout(httpRetryTimer); httpRetryTimer = 0; }
    // hand the page back to ws: drop the relay VIEW (the server parks the era and
    // the ws resume below re-attaches it to the same host)
    closeHttpMode();
    mode = 'ws';
    connect();
  }

  function startHttpMode() {
    if (mode === 'http' && httpSessionId) return;
    if (httpRetryTimer) { clearTimeout(httpRetryTimer); httpRetryTimer = 0; }
    mode = 'http';
    perf.fallbacks++;
    console.warn('[zcode-webui] websocket unavailable, switching to http polling bridge');
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
    // tab + resume: the server attaches this page as a VIEW of the account's
    // running host. resume=1 (the page already booted) makes it a HOT switch of
    // the SAME renderer era — same host, same conversation handshake, ids
    // re-pointed — instead of a second host that never got the handshake.
    fetch('bridge/open?tab=' + encodeURIComponent(TAB_ID) + (everDelivered ? '&resume=1' : ''), { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (o) {
        if (o && o.staleEra) {
          // the host no longer holds this page's era (server restart / reaped):
          // its event subscriptions can never be restored, so reload clean
          console.warn('[zcode-webui] relay open: stale era on the server, reloading');
          window.location.reload();
          return;
        }
        if (!o.ok) throw new Error(o.error || 'open failed');
        httpSessionId = o.id;
        if (o.startupMode === 'runtime' && o.startupId) {
          serverStartup = { mode: 'runtime', startupId: String(o.startupId) };
        }
        httpRetryDelay = 2000;
        reloadAttempts = 0;
        wsOpenFails = 0;
        perf.httpOpens++;
        deliverPort();
        if (serverStartup.mode === 'runtime') pollStartupState();
        pollLoop();
        flushUplink();
      })
      .catch(function (e) {
        report('bridge-open-failed', String(e.message || e));
        // retry with backoff: a single failed open used to leave the page with
        // NO transport and NO recovery path — only a manual refresh could save it
        if (mode === 'http' && !httpSessionId) {
          httpRetryDelay = Math.min(httpRetryDelay * 2, 30000);
          httpRetryTimer = setTimeout(function () {
            httpRetryTimer = 0;
            if (mode === 'http' && !httpSessionId) startHttpMode();
          }, httpRetryDelay);
        }
      });
  }

  // Closing the browser tab must close the HTTP bridge too — otherwise every
  // refresh/close leaves a parked relay view behind. With one host per account
  // this only drops the VIEW (the server keeps a running turn alive).
  function closeHttpMode() {
    if (!httpSessionId) return;
    var id = httpSessionId;
    httpSessionId = null;
    try {
      // .catch: a rejection here (page hiding, network gone) fires the global
      // unhandledrejection handler, which would call report() on a dying page
      fetch('bridge/close?id=' + encodeURIComponent(id), { method: 'POST', keepalive: true })
        .catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('pagehide', function (ev) {
    // Do NOT close when entering bfcache (ev.persisted): the page can restore
    // and re-open its relay in the pageshow handler below.
    if (ev.persisted) {
      holdPresenceForFreeze();          // bfcache pages can sit for hours
    } else {
      // tell the server the lease is over even if the WS close event is lost;
      // a missed beacon is harmless (the lease simply expires)
      presenceClosed = true;
      postPresence(true);
      closeHttpMode();
    }
  });

  // WebSocket path by deployment mode:
  //  - Mode A (code-server /proxy/<port>/ proxy): the proxy STRIPS the prefix, so the
  //    path must be derived from the PUBLIC page URL (e.g. /proxy/3102/ws).
  //  - Mode B (standalone with explicit base path): the prefix is preserved end to
  //    end, so the injected cfg.wsPath (= <base>/ws) is correct.
  var wsPath = null;
  if (cfg.base && cfg.wsPath) {
    wsPath = cfg.wsPath;
  } else {
    var p = window.location.pathname;
    if (p.charAt(p.length - 1) !== '/') p = p.substring(0, p.lastIndexOf('/') + 1);
    wsPath = p + 'ws';
  }
  var wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  var everDelivered = false;
  function wsUrl() {
    return wsProto + '//' + window.location.host + wsPath + '?token=' + (cfg.wsToken || '') +
      '&tab=' + encodeURIComponent(TAB_ID) +
      (everDelivered ? '&resume=1' : '');
  }
  var wsVerified = false;
  // Frames that arrive before the ws ready line. A hot resume replays the missed
  // frames first and announces itself right after, so the first message of a
  // resumed socket is normally BINARY (see the onmessage comment).
  var preReadyFrames = [];
  var preReadyBytes = 0;
  var preReadyTimer = 0;
  var WS_READY = '{"kind":"zcode-webui-ready"}';
  // Liveness: browsers cannot send WebSocket protocol pings, and a half-open
  // TCP socket (phone sleep, NAT timeout, proxy drop) keeps readyState === OPEN
  // for minutes after the peer is gone — the page then looks connected but is
  // frozen until a manual reload. We send an app-level ping on a timer and treat
  // "no inbound at all for 45 s while visible" as dead (pongs arrive every 10 s
  // on an idle-but-healthy socket, so this only fires when the path is broken).
  var lastInboundAt = 0;
  var PING_EVERY_MS = 10000;
  var STALE_VISIBLE_MS = 45000;
  // A server from before this change does not answer pings. Without this guard a
  // page that fetched the new bootstrap against the old backend would keep
  // declaring the (healthy) socket dead once a minute. After three unanswered
  // probes with no pong ever seen, the heartbeat turns itself off for the page.
  var pongSeen = false;
  var pingsSent = 0;
  var hbDisabled = false;
  // >= 3.16: the host migrates the database itself and streams
  // zcode:database-startup-state; the page must NOT synthesize "ready" then.
  // The server announces which mode and which startupId to use in its ready line.
  var serverStartup = { mode: 'synthetic', startupId: '' };

  function connect() {
    wsVerified = false;                          // re-arm per connection (hot reconnects)
    wsOpened = false;
    preReadyFrames = [];                         // stale replay buffer from the previous socket
    preReadyBytes = 0;
    if (preReadyTimer) { clearTimeout(preReadyTimer); preReadyTimer = 0; }
    ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () { wsOpened = true; reloadAttempts = 0; hotAttempts = 0; wsOpenFails = 0; perf.wsOpens++; };
    ws.onmessage = function (ev) {
      lastInboundAt = Date.now();
      // The first message is normally our ready line; a foreign websocket server
      // (code-server's own /ws, a proxy error page) would send its own text here
      // — that still has to fall back to http polling.
      //
      // BUT a HOT RESUME answers with the frames this page missed BEFORE the ready
      // line (the server flushes the parked replay buffer inside attachView and
      // sends the ready line right after). Those replayed frames are binary and
      // arrive first, which used to be read as "unexpected ws peer" → ws.close()
      // → http fallback on EVERY resume with a non-empty gap (62 /bridge/open
      // calls with resume=1 in the log on 2026-11-04). The fallback then delivered
      // the 115-byte ready line as an RPC frame and crashed the renderer client.
      // So: buffer pre-ready frames and flush them in order once the peer
      // announces itself; give up only when the stream goes SILENT (a peer that
      // is not ours never sends our ready line).
      if (!wsVerified) {
        if (typeof ev.data === 'string') {
          var ready = null;
          if (ev.data === WS_READY) ready = { kind: 'zcode-webui-ready' };
          else { try { ready = JSON.parse(ev.data); } catch (e) { ready = null; } }
          if (ready && ready.kind === 'zcode-webui-ready') {
            if (ready.startupMode === 'runtime' && ready.startupId) {
              serverStartup = { mode: 'runtime', startupId: String(ready.startupId) };
            }
            wsVerified = true;
            if (preReadyTimer) { clearTimeout(preReadyTimer); preReadyTimer = 0; }
            deliverPort();
            var queued = preReadyFrames;
            preReadyFrames = [];
            preReadyBytes = 0;
            for (var qi = 0; qi < queued.length; qi++) deliverToRenderer(queued[qi]);
            perf.preReadyFrames += queued.length;
            flushUplink();                         // frames the renderer sent while offline
          } else {
            console.warn('[zcode-webui] unexpected ws peer, closing and falling back to http');
            try { ws.close(); } catch (e) { /* ignore */ }
            startHttpMode();
          }
          return;
        }
        var pre = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data);
        preReadyBytes += pre.length;
        if (preReadyFrames.length < 8192 && preReadyBytes <= 32 * 1024 * 1024) {
          preReadyFrames.push(pre);
          if (preReadyTimer) clearTimeout(preReadyTimer);
          preReadyTimer = setTimeout(function () {
            preReadyTimer = 0;
            if (wsVerified) return;
            console.warn('[zcode-webui] ' + preReadyFrames.length + ' frame(s) (' + preReadyBytes +
              'B) with no ready line, treating the peer as foreign and falling back to http');
            preReadyFrames = [];
            preReadyBytes = 0;
            try { if (ws) ws.close(); } catch (e) { /* ignore */ }
            startHttpMode();
          }, 3000);
          return;
        }
        console.warn('[zcode-webui] pre-ready replay overflow (' + preReadyFrames.length + ' frame(s), ' +
          preReadyBytes + 'B) with no ready line, falling back to http');
        preReadyFrames = [];
        preReadyBytes = 0;
        try { if (ws) ws.close(); } catch (e) { /* ignore */ }
        startHttpMode();
        return;
      }
      if (typeof ev.data === 'string') {
        // server control line — one handler for ws and http, so a control kind can
        // never reach the renderer's RPC client on either transport
        handleControlText(ev.data);
        return;
      }
      // The official renderer's port transport accepts ONLY Uint8Array
      // (e.data instanceof Uint8Array); an ArrayBuffer is silently dropped.
      var u8 = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data);
      var hx = '';
      for (var k = 0; k < Math.min(u8.length, 8); k++) hx += ('0' + u8[k].toString(16)).slice(-2);
      if (reported > 0) noteDelivered(hx, u8.length);              // error attribution only
      if (window.__zb_debug) console.debug('[zb-debug] ws deliver ' + u8.length + 'B ' + hx);
      perfIn(u8.length, u8[0], hx);
      deliverToRenderer(u8);
    };
    ws.onclose = function (ev) {
      if (mode !== 'ws') return;
      if (!wsOpened) {
        // Open failure. Before the first successful bootstrap this is the
        // "proxy refuses websocket upgrades" case → http fallback. AFTER the
        // page has booted it is almost always transient (laptop waking, parked
        // tab, network blip): keep hot-retrying ws — flipping to http here used
        // to strand an already-booted renderer on a brand-new host. Only after
        // several consecutive failures do we accept ws is really gone.
        wsOpenFails++;
        if (!everDelivered || wsOpenFails >= 5) { startHttpMode(); return; }
        scheduleHotReconnect();
        return;
      }
      if (ev.code === 4000 || ev.code === 1011) {
        // host exited (crash / server restart): the renderer must re-bootstrap
        // against a fresh host, which needs a page reload — but NEVER while the
        // page is hidden (defer it; churn-free backgrounding)
        if (isHidden()) { pendingHostReboot = true; return; }
        reloadAttempts++;
        flash('会话进程已重启，正在恢复会话…');
        if (reloadAttempts > 2) {
          showNotice('连接已断开且自动重连失败。会话数据都在服务端，点此重连即可继续。', '重新连接', function () { window.location.reload(); }, true);
          reloadAttempts = 0;
        } else {
          setTimeout(function () { window.location.reload(); }, 1200);
        }
        return;
      }
      // ordinary drop (app switched away, network blip): HOT reconnect — the
      // server re-adopts the same running host, no reload, nothing visible
      scheduleHotReconnect();
    };
    ws.onerror = function () { /* onclose follows */ };
  }

  // ---- lifecycle-aware recovery (module scope: registered exactly once) ----
  // When the app is backgrounded Android freezes the tab and the OS/proxies drop
  // the idle websocket — that part is not ours to control. What IS ours: never
  // reload the page in the background, and recover with a HOT websocket
  // reconnect — with session adoption the server re-attaches this page to the
  // very same running host, so no reload is needed at all.
  var hotAttempts = 0;
  var pendingHostReboot = false;
  function isHidden() { return document.visibilityState === 'hidden'; }
  // one-line, pointer-transparent toast; used before the (unavoidable) reload
  // that a host restart requires, so the refresh does not look like a crash
  function flash(text) {
    try {
      var el = document.createElement('div');
      el.textContent = text;
      el.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483646;' +
        'background:#1f2937;color:#f9fafb;font:13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:999px;' +
        'box-shadow:0 4px 12px rgba(0,0,0,.3);pointer-events:none;';
      (document.body || document.documentElement).appendChild(el);
    } catch (e) { /* ignore */ }
  }
  function scheduleHotReconnect() {
    var delay = Math.min(1000 * Math.pow(2, Math.min(hotAttempts, 4)), 10000);
    hotAttempts++;
    perf.reconnects++;
    setTimeout(function () {
      if (mode !== 'ws' || (ws && (ws.readyState === 0 || ws.readyState === 1))) return;
      connect();
    }, delay);
  }
  var probeTimer = 0;
  // strict: used when the page comes back to the foreground — if the pong does
  // not arrive within 3 s the socket is declared dead right away instead of
  // waiting for the 45 s interval.
  function probeNow(strict) {
    if (hbDisabled || mode !== 'ws' || !ws || ws.readyState !== 1) return;
    try { ws.send('{"kind":"zcode-webui-ping"}'); } catch (e) { /* ignore */ }
    pingsSent++;
    // only enforce the deadline once we know this backend answers probes
    if (!strict || !(pongSeen || pingsSent > 3)) return;
    var before = lastInboundAt;
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(function () {
      probeTimer = 0;
      if (lastInboundAt === before && ws && ws.readyState === 1) {
        try { ws.close(); } catch (e) { /* ignore */ }   // -> hot reconnect
      }
    }, 3000);
  }
  // a socket that reported OPEN but has delivered nothing for a long time while
  // the page is visible is dead: closing it drives the normal hot-reconnect path
  setInterval(function () {
    if (hbDisabled) return;
    if (mode !== 'ws' || !ws || ws.readyState !== 1) return;
    if (isHidden()) return;                       // background tabs throttle timers
    if (!pongSeen && pingsSent >= 3) {
      hbDisabled = true;                          // backend predates the pong: stop probing
      return;
    }
    if (!pongSeen) { probeNow(false); return; }   // still waiting for the first pong
    var idle = Date.now() - lastInboundAt;
    if (idle > STALE_VISIBLE_MS) {
      try { ws.close(); } catch (e) { /* ignore */ }   // onclose → hot reconnect
      return;
    }
    probeNow();
  }, PING_EVERY_MS);
  window.addEventListener('focus', function () {
    postPresence(false);
    if (mode !== 'ws') return;
    if (!ws || ws.readyState > 1) { hotAttempts = 0; connect(); return; }
    probeNow(true);
  });
  window.addEventListener('online', function () {
    postPresence(false);
    if (mode !== 'ws') return;
    hotAttempts = 0; reloadAttempts = 0; wsOpenFails = 0;
    if (!ws || ws.readyState > 1) connect();
    else probeNow(true);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    postPresence(false);
    // back in the foreground: fresh recovery budget + immediate action
    hotAttempts = 0;
    reloadAttempts = 0;
    wsOpenFails = 0;
    if (pendingHostReboot) { pendingHostReboot = false; flash('正在恢复会话…'); window.location.reload(); return; }
    if (mode === 'ws') {
      if (!ws || ws.readyState > 1) connect(); else probeNow(true);
    } else if (mode === 'http' && !httpSessionId) {
      // parked in http mode with a dead relay (bridge/open failed while the tab
      // was hidden): prefer the ws hot-resume path now that we are visible
      recoverTransport();
    }
  });
  window.addEventListener('pageshow', function (ev) {
    presenceClosed = false;
    postPresence(false);
    if (!ev.persisted) return;                     // bfcache restore: socket is dead
    hotAttempts = 0; reloadAttempts = 0; wsOpenFails = 0;
    if (mode === 'ws') {
      if (!ws || ws.readyState > 1) connect();
    } else if (mode === 'http' && !httpSessionId) {
      recoverTransport();
    }
  });

  // debug/test hook: current socket readiness (0 connecting, 1 open, 3 closed)
  window.__zwebui_ws = function () { return ws ? ws.readyState : -1; };
  window.__zwebui_wsDrop = function () { try { if (ws) ws.close(); } catch (e) { /* ignore */ } };
  // debug/test hook: renew the presence lease now (or send the closing beacon)
  window.__zwebui_presence = function (closing, ttlMs) { postPresence(!!closing, Number(ttlMs) || 0); };
  // debug/test hook: render an advisory notice exactly like the gap/resent paths
  window.__zwebui_notice = function (text, actionText, onClick, closable) {
    showNotice(text, actionText, onClick, closable);
  };
  // debug/test hook: enqueue a frame exactly as the renderer's port would
  // (goes through the uplink buffer when the transport is down)
  window.__zwebui_send = function (data) { sendToBridge(data); };

  // ---- sidebar interaction audit ------------------------------------------------
  // Diagnoses "after refresh the FIRST-clicked workspace directory collapses
  // fine but can never be expanded again, while other directories keep
  // toggling". Every click on a sidebar toggle ([aria-expanded]: workspace
  // group rows AND file-tree folders) is recorded; 2.5s later the same row is
  // re-inspected — if its state did not flip, a "wedge" line goes to the
  // server log together with document.elementFromPoint at the click position
  // (catches invisible overlays: stuck tooltips/drag ghosts/popovers) and the
  // renderer's own recent decision logs. All client-side: takes effect on the
  // next page refresh, no server restart involved.
  (function () {
    var AUDIT_MAX = 60, audited = 0;
    var recentInfo = [];                       // renderer decision lines worth attaching
    try {
      var origInfo = console.info;
      console.info = function () {
        try {
          var t = Array.prototype.map.call(arguments, function (a) { return typeof a === 'string' ? a : ''; }).join(' ');
          if (/\[Root\]|\[useTabPersistence\]|\[WorkspaceSidebar|\[workspace-file-tree\]|\[WorkspaceFileTree\]/.test(t)) {
            recentInfo.push(t.slice(0, 200));
            if (recentInfo.length > 12) recentInfo.shift();
          }
        } catch (e) { /* ignore */ }
        return origInfo.apply(console, arguments);
      };
    } catch (e) { /* ignore */ }
    function auditLog(message) {
      try {
        fetch('api/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ href: window.location.href, kind: 'sidebar-audit', message: message }),
        }).catch(function () { /* ignore */ });
      } catch (e) { /* ignore */ }
    }
    function describe(el) {
      if (!el) return 'gone';
      var ae = el.getAttribute('aria-expanded');
      return 'ae=' + (ae === null ? 'n/a' : ae) + ' tag=' + el.tagName +
        ' label=' + String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    }
    function rowLabel(el) {
      return String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    }
    function ancestors(el) {
      var out = [];
      var a = el;
      for (var i = 0; i < 3 && a; i++) {
        a = a.parentElement;
        if (!a) break;
        out.push(String(a.className).split(' ').slice(0, 2).join('.').slice(0, 60) || a.tagName);
      }
      return out.join(' < ');
    }
    // every [aria-expanded] row with the same label — duplicates expose stale
    // layers (closing drawer animations, swapped views) whose handlers still run
    // but whose rendering no longer follows the store
    function twins(label) {
      var out = [];
      var nodes = document.querySelectorAll('[aria-expanded]');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (rowLabel(n) === label) {
          var r = n.getBoundingClientRect();
          out.push({ ae: n.getAttribute('aria-expanded'), connected: n.isConnected, y: Math.round(r.top), w: Math.round(r.width), anc: ancestors(n).slice(0, 60) });
        }
      }
      return out;
    }
    // React re-renders replace the DOM node, so the after-state must RE-QUERY:
    // prefer the element now sitting at the row's original center (the row keeps
    // its position through expand/collapse), then fall back to a label match.
    function findLive(el) {
      try {
        var r = el.getBoundingClientRect();
        if (r.width > 0) {
          var hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 20), r.top + r.height / 2);
          var row = hit && hit.closest ? hit.closest('[aria-expanded]') : null;
          if (row) return row;
        }
      } catch (e) { /* detached */ }
      var label = rowLabel(el);
      var nodes = document.querySelectorAll('[aria-expanded]');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n === el) return n;
        if (n.tagName === el.tagName && rowLabel(n) === label) return n;
      }
      return null;
    }
    // touch swipe/scroll trail: the user reports the wedge follows 上划/下划 —
    // record swipes that start on a sidebar row (dnd-kit PointerSensor
    // activates at 8px; a swipe that crosses it can start a drag)
    var swipe = null, swipes = 0;
    document.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType !== 'touch' || swipes >= 30) return;
      var el = ev.target && ev.target.closest ? ev.target.closest('[aria-expanded],[role="treeitem"]') : null;
      swipe = el ? { x: ev.clientX, y: ev.clientY, label: rowLabel(el), ae: el.getAttribute('aria-expanded') } : null;
    }, true);
    document.addEventListener('pointerup', function (ev) {
      if (!swipe) return;
      var dx = ev.clientX - swipe.x, dy = ev.clientY - swipe.y;
      if (dx * dx + dy * dy >= 64) {   // ≥8px: crossed dnd's activation distance
        swipes++;
        auditLog('swipe ' + swipe.label.slice(0, 20) + ' ae=' + swipe.ae + ' Δ=' + Math.round(dx) + ',' + Math.round(dy) + (ev.type === 'pointercancel' ? ' CANCELLED' : ''));
      }
      swipe = null;
    }, true);
    document.addEventListener('pointercancel', function (ev) {
      if (!swipe) return;
      swipes++;
      auditLog('swipe ' + swipe.label.slice(0, 20) + ' ae=' + swipe.ae + ' CANCELLED mid-gesture (browser took over)');
      swipe = null;
    }, true);

    document.addEventListener('click', function (ev) {
      if (audited >= AUDIT_MAX || ev.clientX > 420) return;   // sidebar region only
      if (ev.clientX === 0 && ev.clientY === 0) return;       // synthetic el.click() noise
      var el = ev.target && ev.target.closest ? ev.target.closest('[aria-expanded]') : null;
      if (!el) return;
      var at = { x: Math.round(ev.clientX), y: Math.round(ev.clientY) };
      var before = describe(el);
      var label = rowLabel(el);
      var seq = ++audited;
      el.__zwebuiAuditSeq = seq;                       // a later click on the same row supersedes us
      setTimeout(function () {
        var live = findLive(el);
        var after = describe(live);
        var flipped = before.slice(0, 8) !== after.slice(0, 8);   // compare the ae= part
        var superseded = live && live.__zwebuiAuditSeq !== undefined && live.__zwebuiAuditSeq > seq;
        var msg = 'click@' + at.x + ',' + at.y + ' ' + before + ' → ' + (after === 'gone' ? 'ROW-GONE' : after) +
          ' flipped=' + flipped + (superseded ? ' (superseded by later click)' : '');
        if (!flipped && !superseded) {
          var top = null;
          try { top = document.elementFromPoint(at.x, at.y); } catch (e) { /* ignore */ }
          msg = 'WEDGE? ' + msg + ' topNow=' + (top && top.tagName ? (top.tagName + '.' + String(top.className).split(' ')[0]) : '?') +
            ' vw=' + window.innerWidth +
            ' | twins: ' + JSON.stringify(twins(label).slice(0, 4)) +
            ' | recent: ' + (recentInfo.slice(-4).join(' ⏎ ') || 'none');
        }
        auditLog(msg);
      }, 2500);
    }, true);
    // expansion-map trail: the tabStore persists every toggle here
    try {
      var EXP_KEY = 'zcode-workspace-expansion';
      var lastMap = null;
      setInterval(function () {
        var cur = null;
        try { cur = localStorage.getItem(EXP_KEY); } catch (e) { return; }
        if (cur !== lastMap) {
          if (lastMap !== null) auditLog('expansion-map: ' + (cur || '(empty)'));
          lastMap = cur;
        }
      }, 1000);
    } catch (e) { /* ignore */ }
  })();

  // ---- accidental-stop guard (Esc) -------------------------------------------
  // The official renderer binds Escape to "stop the current turn" (its own
  // tooltip even advertises "Esc" as the shortcut) through a window-level
  // keydown handler that only skips events already prevented or targeted inside
  // a dialog. Pressing Esc to dismiss an IME candidate list, to clear a search
  // box, or just a stray keypress therefore kills a running turn — and a killed
  // turn cancels every in-flight subagent with it (2026-10-29: a 3.5h
  // orchestration turn plus four scene-drafting subagents died 12 minutes after
  // dispatch; the only trace was `v4.stop.foreground_execution_inspected`).
  //
  // Guard: while a turn is stoppable, the FIRST Escape is swallowed and a hint
  // appears; a second Escape within CONFIRM_MS is replayed through to the
  // renderer, so stopping still goes through the app's own path. Scopes that own
  // Escape (dialog / popper menu / listbox) are never touched.
  //
  // Both decisions and stop-button clicks are logged as kind=stop-guard, so the
  // next stop can be attributed (button vs Esc) from the server log instead of
  // the renderer's console.
  (function () {
    var CONFIRM_MS = 2500;
    // the composer swaps its send button for this one while a turn can be stopped
    var STOP_LABEL = /停止生成|停止|stop\s*generating|^stop$/i;
    var OWNED = '[role="dialog"],[data-slot="dialog-content"],[role="menu"],[role="listbox"],' +
      '[data-radix-popper-content-wrapper],[aria-modal="true"]';
    var armed = 0;
    var hintEl = null;
    var hintTimer = 0;

    function log(message) {
      try {
        fetch('api/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ href: window.location.href, kind: 'stop-guard', message: message }),
          keepalive: true,
        }).catch(function () { /* ignore */ });
      } catch (e) { /* ignore */ }
    }

    // only DOM-level truth available to us: an enabled, visible stop button
    function stoppable() {
      var nodes = document.querySelectorAll('button[aria-label]');
      for (var i = 0; i < nodes.length; i++) {
        var b = nodes[i];
        if (b.disabled) continue;
        var label = String(b.getAttribute('aria-label') || '');
        if (!STOP_LABEL.test(label)) continue;
        var r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return label;
      }
      return '';
    }

    function dropHint() {
      if (hintTimer) { clearTimeout(hintTimer); hintTimer = 0; }
      if (hintEl && hintEl.parentNode) hintEl.parentNode.removeChild(hintEl);
      hintEl = null;
    }

    function showHint() {
      dropHint();
      hintEl = document.createElement('div');
      hintEl.setAttribute('data-zwebui-stop-guard', 'hint');
      hintEl.textContent = '再按一次 Esc 停止生成';
      hintEl.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);' +
        'z-index:2147483646;background:#1f2937;color:#f9fafb;font:13px/1.4 system-ui,sans-serif;' +
        'padding:6px 12px;border-radius:999px;box-shadow:0 4px 12px rgba(0,0,0,.25);' +
        'pointer-events:none;opacity:.96;';
      try { document.body.appendChild(hintEl); } catch (e) { /* ignore */ }
      hintTimer = setTimeout(function () { hintTimer = 0; armed = 0; dropHint(); }, CONFIRM_MS);
    }

    function replayEscape() {
      var target = document.activeElement;
      if (!target || typeof target.dispatchEvent !== 'function') target = document.body;
      var ev = new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
        bubbles: true, cancelable: true,
      });
      ev.__zwebuiEscPass = true;          // our own capture handler lets this one through
      try { target.dispatchEvent(ev); } catch (e) { /* ignore */ }
    }

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || ev.__zwebuiEscPass) return;
      if (ev.defaultPrevented) return;    // someone already owns this Escape
      var path = ev.composedPath ? ev.composedPath() : [];
      for (var i = 0; i < path.length; i++) {
        var n = path[i];
        if (n && n.nodeType === 1 && n.matches && n.matches(OWNED)) return;
      }
      var label = stoppable();
      if (!label) return;
      ev.preventDefault();                // and keep it away from the window handler
      ev.stopPropagation();
      var now = Date.now();
      if (armed && now - armed <= CONFIRM_MS) {
        armed = 0;
        dropHint();
        log('esc confirmed -> stop replayed (aria-label=' + label + ')');
        replayEscape();
        return;
      }
      armed = now;
      showHint();
      log('esc swallowed (turn stoppable via "' + label + '"; Esc again within ' + CONFIRM_MS + 'ms to stop)');
    }, true);

    // attribution: record deliberate clicks so a stop can be traced to its source
    document.addEventListener('click', function (ev) {
      var path = ev.composedPath ? ev.composedPath() : [];
      for (var i = 0; i < path.length; i++) {
        var n = path[i];
        if (!n || n.nodeType !== 1 || !n.getAttribute) continue;
        var label = String(n.getAttribute('aria-label') || '');
        if (label && STOP_LABEL.test(label)) { log('stop button clicked (aria-label=' + label + ')'); return; }
      }
    }, true);
  })();

  // debug/transport override: ?transport=http forces the HTTP polling bridge
  // (useful behind proxies that never forward WebSocket upgrades)
  var forceHttp = false;
  try {
    var qs = new URLSearchParams(window.location.search);
    forceHttp = qs.get('transport') === 'http';
    window.__zb_debug = qs.get('zbdebug') === '1';
  } catch (e) { /* ignore */ }

  // if the websocket does not open quickly (SSO/proxy blocks upgrades), fall back
  // — but while the socket is still CONNECTING, give slow proxies two extra
  // windows before degrading to long-polling
  var httpFallbackTries = 0;
  function maybeStartHttpMode() {
    if (wsOpened || mode !== 'ws') return;
    // ?transport=http is meant to FORCE the relay (that is how the ws-less proxy
    // deployments are exercised). It used to fall into the CONNECTING ladder
    // below, so a local ws that opened within 9 s silently won and the "forced"
    // run never touched http at all — which also made the A/B of the control-line
    // crash impossible. Explicit beats automatic.
    if (forceHttp) { startHttpMode(); return; }
    if (ws && ws.readyState === 0 && httpFallbackTries++ < 3) {
      setTimeout(maybeStartHttpMode, 3000);
      return;
    }
    startHttpMode();
  }
  setTimeout(maybeStartHttpMode, forceHttp ? 1 : 3000);

  // watchdog: if the official app never mounts, reload once (fresh attempt)
  setTimeout(function () {
    try {
      var root = document.getElementById('root');
      if (root && root.children.length === 0 && !document.getElementById('zcode-webui-error')) {
        report('no-render', 'renderer did not mount after 20s, reloading once');
        window.location.reload();
      }
    } catch (e) { /* ignore */ }
  }, 20000);

  // ---- desktop-style app zoom gestures ----
  // Hybrid pinch pipeline (research-backed): DURING the gesture the page gets a
  // composited transform preview — 60fps, no reflow, anchored at the pinch
  // midpoint, panning with the fingers — and on gesture end the final scale is
  // committed to the CSS-zoom channel in the same frame, so text re-rasterizes
  // crisp at the new level. Trackpad pinch (ctrl+wheel) drives the same
  // pipeline with a short idle-commit debounce and zooms toward the cursor.
  // Native two-finger page pinch is disabled via touch-action:pan-x pan-y so
  // the browser and the app zoom never fight (iOS ignores user-scalable=no).
  (function () {
    function zoomGet() { return (window.__zwebui_zoom && window.__zwebui_zoom.get()) || 1; }
    function zoomSet(l) { if (window.__zwebui_zoom) window.__zwebui_zoom.set(l); }

    var Z_MIN = 0.5, Z_MAX = 2;
    var EMA = 0.45;          // rendered-scale smoothing toward the target
    var WHEEL_COMMIT_MS = 160;

    try {
      var st = document.createElement('style');
      st.textContent = 'html { touch-action: pan-x pan-y; }';
      document.head.appendChild(st);
    } catch (e) { /* ignore */ }

    var g = null;            // live gesture
    var wheelTimer = 0;

    // rubber-band above the upper limit while zooming in (the zoom-out side is
    // hard-clamped: it commits directly and can never leave blank edges)
    function softClampAbs(v) {
      if (v > Z_MAX) return Z_MAX + (v - Z_MAX) * 0.35;
      return v;
    }
    function hardClamp(v) { return Math.min(Z_MAX, Math.max(Z_MIN, v)); }
    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

    function begin(zoomBase, fx, fy) {
      if (g) return;
      g = {
        zb: zoomBase,          // zoom at gesture start (fixed reference)
        z0: zoomBase,          // currently committed base (moves on rolling commits)
        touch: false,
        f: { x: fx, y: fy },
        A: { x: fx + window.scrollX, y: fy + window.scrollY }, // anchor (scroll space)
        rs: 1, s: 1, raf: 0,
      };
      var de = document.documentElement;
      de.style.willChange = 'transform';
      de.style.transformOrigin = '0 0';
      schedule();
    }
    function update(relTarget, fx, fy) {
      if (!g) return;
      // pan: the content anchor follows midpoint movement 1:1 (fingers drag content)
      g.A.x -= (fx - g.f.x);
      g.A.y -= (fy - g.f.y);
      g.f.x = fx; g.f.y = fy;
      g.rs = relTarget;
      schedule();
    }
    function schedule() { if (g && !g.raf) g.raf = requestAnimationFrame(tick); }

    // Per-frame render. rs/s are the target/rendered zoom ratio relative to the
    // gesture start; the ABSOLUTE target is zb * s. Two regimes:
    //   zoom-in  (zAbs >= committed base): composited transform preview, clamped
    //             so the transformed content always covers the viewport — no
    //             blank edges, pan stays inside the content bounds;
    //   zoom-out (zAbs <  base): transform cannot work (scaling below 1 shrinks
    //             the painted box = blank edges), so the shrink commits directly
    //             per frame — CSS zoom shrinks the layout, which always fills
    //             the viewport width. The anchor stays under the focal via
    //             scroll compensation (scroll = A*(z/zb) - focal).
    function tick() {
      if (!g) return;
      g.raf = 0;
      g.s += (g.rs - g.s) * EMA;
      if (Math.abs(g.rs - g.s) < 0.0004) g.s = g.rs;
      var de = document.documentElement;
      var zAbs = softClampAbs(g.zb * g.s);
      if (zAbs < g.z0 - 0.0005) {
        // zoom-out: rolling direct commit
        var z1 = Math.max(Z_MIN, zAbs);
        if (Math.abs(z1 - g.z0) > 0.0005) {
          var k = z1 / g.zb;
          zoomSet(z1);
          try { window.scrollTo(g.A.x * k - g.f.x, g.A.y * k - g.f.y); } catch (e) { /* ignore */ }
          g.z0 = z1;
        }
        de.style.transform = '';
      } else {
        // zoom-in: transform preview
        var sp = Math.max(zAbs / g.z0, 1);
        var vw = window.innerWidth, vh = window.innerHeight;
        var tX = clamp(g.f.x - (g.A.x - window.scrollX) * sp, vw * (1 - sp), 0);
        var tY = clamp(g.f.y - (g.A.y - window.scrollY) * sp, vh * (1 - sp), 0);
        de.style.transform = 'translate(' + tX + 'px,' + tY + 'px) scale(' + sp + ')';
      }
      if (Math.abs(g.rs - g.s) > 0.0004) schedule();
    }

    function endGesture() {
      if (!g) return;
      if (g.raf) cancelAnimationFrame(g.raf);
      g.s = g.rs;
      tick();                                        // exact final frame
      var z1 = hardClamp(g.zb * g.s);                // commit clamps the rubber band
      if (Math.abs(z1 - g.z0) > 0.0005) {
        var k = z1 / g.zb;
        zoomSet(z1);
        try { window.scrollTo(g.A.x * k - g.f.x, g.A.y * k - g.f.y); } catch (e) { /* ignore */ }
      }
      var de = document.documentElement;
      de.style.transform = '';
      de.style.willChange = '';
      g = null;
    }

    // ---- trackpad / touchscreen pinch reported as ctrl+wheel ----
    window.addEventListener('wheel', function (ev) {
      if (!ev.ctrlKey || ev.defaultPrevented) return;
      ev.preventDefault();
      if (g && g.touch) return;               // a touchscreen pinch owns the gesture
      if (!g) begin(zoomGet(), ev.clientX, ev.clientY);
      g.rs = g.rs * Math.exp(-ev.deltaY * 0.001);
      update(g.rs, ev.clientX, ev.clientY);     // zoom toward the cursor
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(endGesture, WHEEL_COMMIT_MS);
    }, { passive: false });

    // ---- two-finger touchscreen pinch (pointer events) ----
    var pointers = {};       // first two touch pointers only
    var pinch = null;        // { d0, f0 }
    function tracked() { return Object.keys(pointers); }
    function midpoint() {
      var ids = tracked();
      var a = pointers[ids[0]], b = pointers[ids[1]];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
    }
    function onPointerDown(ev) {
      if (ev.pointerType !== 'touch') return;
      var ids = tracked();
      if (ids.length >= 2 || pointers[ev.pointerId]) return;   // ignore 3rd+ finger
      pointers[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      ids = tracked();
      if (ids.length === 2) {
        var m = midpoint();
        pinch = { d0: m.d };
        begin(zoomGet(), m.x, m.y);
        g.touch = true;
      }
    }
    function onPointerMove(ev) {
      if (ev.pointerType !== 'touch' || !pointers[ev.pointerId] || tracked().length !== 2) return;
      // high-frequency touch digitizers: fold the coalesced trail so the last
      // stored position is the true latest sample (finer effective granularity)
      var trail = ev.getCoalescedEvents ? ev.getCoalescedEvents() : null;
      if (trail && trail.length) {
        for (var i = 0; i < trail.length; i++) {
          var c = trail[i];
          if (pointers[c.pointerId]) pointers[c.pointerId] = { x: c.clientX, y: c.clientY };
        }
      }
      pointers[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      var m = midpoint();
      if (pinch && m.d > 0) update(m.d / pinch.d0, m.x, m.y);
    }
    function onPointerEnd(ev) {
      if (!pointers[ev.pointerId]) return;
      delete pointers[ev.pointerId];
      pinch = null;
      if (tracked().length < 2) endGesture();   // commit (also covers pointercancel)
    }
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerEnd, { passive: true });
    window.addEventListener('pointercancel', onPointerEnd, { passive: true });
  })();

  // covers the HTTP long-poll fallback (no ws control channel there) and makes
  // the banner self-clear once the background host goes quiet
  setTimeout(function () { watchBackground(null); }, 4000);

  connect();
})();
