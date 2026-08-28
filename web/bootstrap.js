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

  // ---- tab identity (survives reloads, unique per tab) + takeover flag ----
  var TAB_ID = '';
  try { TAB_ID = sessionStorage.getItem('zwebui_tab') || ''; } catch (e) { /* ignore */ }
  if (!TAB_ID) {
    TAB_ID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('tab-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    try { sessionStorage.setItem('zwebui_tab', TAB_ID); } catch (e) { /* ignore */ }
  }
  var TAKEOVER = '0';
  try {
    var initQs = new URLSearchParams(window.location.search);
    if (initQs.get('takeover') === '1') {
      TAKEOVER = '1';
      initQs.delete('takeover');
      window.history.replaceState(null, '', window.location.pathname + (initQs.toString() ? '?' + initQs.toString() : ''));
    }
  } catch (e) { /* ignore */ }

  // ---- browser-side diagnostics: forward errors to the server log + visible banner ----
  var reported = 0;
  var lastDelivered = [];
  function noteDelivered(hex, len) {
    window.__zb_debug = true;
    lastDelivered.push(len + 'B:' + hex);
    if (lastDelivered.length > 4) lastDelivered.shift();
  }
  function report(kind, message, stack) {
    if (reported++ > 12) return;
    var extra = ' [transport=' + mode + '] [lastDelivered: ' + lastDelivered.join(' | ') + ']';
    try {
      fetch('api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ href: window.location.href, kind: kind, message: message + extra, stack: stack || '' }),
        keepalive: true
      });
    } catch (e) { /* ignore */ }
    try {
      var el = document.getElementById('zcode-webui-error');
      if (!el) {
        el = document.createElement('div');
        el.id = 'zcode-webui-error';
        el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:60%;background:#2b0f10;color:#ffb4ab;font:12px/1.5 monospace;padding:8px 10px;border-radius:8px;white-space:pre-wrap;word-break:break-all;';
        document.body.appendChild(el);
      }
      el.textContent = '[zcode-webui] ' + kind + ': ' + (message || '') + (stack ? '\n' + String(stack).slice(0, 600) : '');
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

  // banner with an action button (parked tab / lost connection)
  function showNotice(text, buttonText, onClick) {
    try {
      var el = document.getElementById('zcode-webui-error');
      if (!el) {
        el = document.createElement('div');
        el.id = 'zcode-webui-error';
        el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:60%;background:#2b0f10;color:#ffb4ab;font:12px/1.5 monospace;padding:8px 10px;border-radius:8px;white-space:pre-wrap;word-break:break-all;';
        document.body.appendChild(el);
      }
      el.innerHTML = '';
      var t = document.createElement('div');
      t.textContent = '[zcode-webui] ' + text;
      var b = document.createElement('button');
      b.textContent = buttonText;
      b.style.cssText = 'margin-top:8px;background:#2f6fed;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;';
      b.addEventListener('click', onClick);
      el.appendChild(t);
      el.appendChild(b);
    } catch (e) { /* ignore */ }
  }

  // superseded by another tab: park this page with an explicit take-back control
  function parkWithNotice() {
    mode = 'parked';
    dismissBackground();
    showNotice('本页面的会话已被另一个标签页接管，此页面已暂停。', '接管回来', function () {
      try {
        var q = new URLSearchParams(window.location.search);
        q.set('takeover', '1');
        window.location.search = q.toString();
      } catch (e) { window.location.reload(); }
    });
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
    t.textContent = '[zcode-webui] 另一处仍在执行任务：' + hosts.length + ' 个进程（pid ' +
      hosts.map(function (h) { return h.pid; }).join(',') + '，最近活动 ' + ages.join('/') + ' 秒前）。' +
      '本页看到的是已落库的历史状态——不要直接发「继续」，否则两个代理可能同时改同一批文件。';
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

  function deliverToRenderer(u8) {
    if (port2) {
      try { port2.postMessage(u8, [u8.buffer]); } catch (e) { /* ignore */ }
      return;
    }
    if (portQueue.length < 64) portQueue.push(u8);
  }

  function deliverPort() {
    if (delivered) return;
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
        window.postMessage('zcode:service-port', '*', [channel.port1]);
        // tell the backend this renderer is now wired: an ADOPTED mid-stream host
        // releases its ordered frame buffer on this signal
        try {
          if (ws && ws.readyState === 1) ws.send('{"kind":"zcode-webui-port-ready"}');
        } catch (e) { /* ignore */ }
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
      if (ws && ws.readyState === 1) { try { ws.send(data); } catch (e) { /* ignore */ } }
      return;
    }
    if (mode === 'http' && httpSessionId) {
      uplinkChain = uplinkChain.then(function () {
        return fetch('bridge/send?id=' + httpSessionId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: data
        });
      }).then(function (r) { if (!r.ok) throw new Error('send ' + r.status); }, function () { /* keep chain alive */ });
    }
  }

  function parseHttpFrames(buf) {
    if (!buf || !buf.byteLength) return;
    var u8 = new Uint8Array(buf);
    var off = 0;
    while (off + 4 <= u8.length) {
      var len = (u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3];
      off += 4;
      if (len === 0 || off + len > u8.length) break;
      var payload = u8.slice(off, off + len);
      off += len;
      if (window.__zb_debug || reported > 0) {
        var hex = '';
        for (var k = 0; k < Math.min(payload.length, 16); k++) hex += ('0' + payload[k].toString(16)).slice(-2);
        noteDelivered(hex, payload.length);
        console.debug('[zb-debug] deliver ' + payload.length + 'B ' + hex);
      }
      deliverToRenderer(payload);
    }
  }

  function pollLoop() {
    if (mode !== 'http' || !httpSessionId) return;
    fetch('bridge/poll?id=' + httpSessionId)
      .then(function (r) {
        if (r.status === 410) throw new Error('session-gone');
        return r.arrayBuffer();
      })
      .then(function (buf) { parseHttpFrames(buf); pollLoop(); })
      .catch(function (e) {
        if (mode === 'http') setTimeout(pollLoop, 1000);
      });
  }

  function startHttpMode() {
    if (mode === 'http') return;
    mode = 'http';
    console.warn('[zcode-webui] websocket unavailable, switching to http polling bridge');
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
    fetch('bridge/open', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (o) {
        if (!o.ok) throw new Error(o.error || 'open failed');
        httpSessionId = o.id;
        reloadAttempts = 0;
        deliverPort();
        pollLoop();
      })
      .catch(function (e) {
        report('bridge-open-failed', String(e.message || e));
      });
  }

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
  var wsUrl = wsProto + '//' + window.location.host + wsPath + '?token=' + (cfg.wsToken || '') + '&tab=' + encodeURIComponent(TAB_ID) + (TAKEOVER === '1' ? '&takeover=1' : '');
  var wsVerified = false;
  var WS_READY = '{"kind":"zcode-webui-ready"}';

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () { wsOpened = true; reloadAttempts = 0; };
    ws.onmessage = function (ev) {
      // the very first message MUST be our ready signal; a foreign websocket
      // server (e.g. code-server's own /ws when the URL lacked a trailing slash)
      // would send its own frames here — reject it and fall back to http polling.
      if (!wsVerified) {
        if (typeof ev.data === 'string' && ev.data === WS_READY) {
          wsVerified = true;
          deliverPort();
        } else {
          console.warn('[zcode-webui] unexpected ws peer, closing and falling back to http');
          try { ws.close(); } catch (e) { /* ignore */ }
          startHttpMode();
        }
        return;
      }
      if (typeof ev.data === 'string') {
        // server control message: another host of this account is mid-turn
        try {
          var ctrl = JSON.parse(ev.data);
          if (ctrl && ctrl.kind === 'zcode-webui-background') { watchBackground(ctrl); return; }
          if (ctrl && ctrl.kind === 'zcode-webui-background-cleared') { dismissBackground(); return; }
        } catch (e) { /* not a control message */ }
        console.debug('[zcode-webui]', ev.data);
        return;
      }
      // The official renderer's port transport accepts ONLY Uint8Array
      // (e.data instanceof Uint8Array); an ArrayBuffer is silently dropped.
      var u8 = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data);
      if (window.__zb_debug || reported > 0) {
        var hx = '';
        for (var k = 0; k < Math.min(u8.length, 16); k++) hx += ('0' + u8[k].toString(16)).slice(-2);
        noteDelivered(hx, u8.length);
        console.debug('[zb-debug] ws deliver ' + u8.length + 'B ' + hx);
      }
      deliverToRenderer(u8);
    };
    ws.onclose = function (ev) {
      if (mode !== 'ws') return;
      // 4001: another tab of this browser took over this page's session; park here
      // (do NOT reload — that would ping-pong the takeover between tabs).
      if (ev.code === 4001) { parkWithNotice(); return; }
      if (!wsOpened) { startHttpMode(); return; }
      // host gone (terminated/exit): a fresh page load will spawn a new host
      if (ev.code === 4000 || ev.code === 1011) {
        reloadAttempts++;
        if (reloadAttempts > 6) { showNotice('连接已断开且自动重连失败。会话数据都在服务端，点此重连即可继续。', '重新连接', function () { window.location.reload(); }); return; }
        setTimeout(function () { window.location.reload(); }, 1500);
        return;
      }
      // ordinary close / network drop: the backend keeps the host running in the
      // background; reload and re-attach to the same session (same tab id).
      reloadAttempts++;
      if (reloadAttempts > 6) { showNotice('连接已断开且自动重连失败。会话数据都在服务端，点此重连即可继续。', '重新连接', function () { window.location.reload(); }); return; }
      setTimeout(function () { window.location.reload(); }, 1500);
    };
    ws.onerror = function () { /* onclose follows */ };
  }

  // debug/transport override: ?transport=http forces the HTTP polling bridge
  // (useful behind proxies that never forward WebSocket upgrades)
  var forceHttp = false;
  try {
    var qs = new URLSearchParams(window.location.search);
    forceHttp = qs.get('transport') === 'http';
    window.__zb_debug = qs.get('zbdebug') === '1';
  } catch (e) { /* ignore */ }

  // if the websocket does not open quickly (SSO/proxy blocks upgrades), fall back
  setTimeout(function () {
    if (!wsOpened && mode === 'ws') startHttpMode();
  }, forceHttp ? 1 : 3000);

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

    function softClamp(v) {  // slight rubber-band beyond the limits while pinching
      if (v < Z_MIN) return Z_MIN + (v - Z_MIN) * 0.35;
      if (v > Z_MAX) return Z_MAX + (v - Z_MAX) * 0.35;
      return v;
    }
    function hardClamp(v) { return Math.min(Z_MAX, Math.max(Z_MIN, v)); }

    function begin(zoomBase, fx, fy) {
      if (g) return;
      g = {
        z0: zoomBase,
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
    function tick() {
      if (!g) return;
      g.raf = 0;
      g.s += (g.rs - g.s) * EMA;
      if (Math.abs(g.rs - g.s) < 0.0004) g.s = g.rs;
      apply();
    }
    function apply() {
      // t = f - (A - scroll) * s  → the anchor content point stays under the focal
      var tX = g.f.x - (g.A.x - window.scrollX) * g.s;
      var tY = g.f.y - (g.A.y - window.scrollY) * g.s;
      document.documentElement.style.transform = 'translate(' + tX + 'px,' + tY + 'px) scale(' + g.s + ')';
    }

    function endGesture() {
      if (!g) return;
      if (g.raf) cancelAnimationFrame(g.raf);
      g.s = g.rs; apply();                      // settle to the exact target first
      var z1 = hardClamp(g.z0 * g.s);
      zoomSet(z1);                              // reflow once, text re-rasterizes crisp
      // keep the anchored content point under the focal after the zoom switch
      // (z1/z0 only differs from g.s at the rubber-band clamp boundaries)
      var ratio = z1 / (g.z0 || 1);
      try {
        window.scrollTo(g.A.x * ratio - g.f.x, g.A.y * ratio - g.f.y);
      } catch (e) { /* ignore */ }
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
      g.rs = softClamp(g.rs * Math.exp(-ev.deltaY * 0.001));
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
      if (pinch && m.d > 0) update(softClamp(m.d / pinch.d0), m.x, m.y);
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
