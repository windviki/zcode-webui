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
    showNotice('本页面的会话已被另一个标签页接管，此页面已暂停。', '接管回来', function () {
      try {
        var q = new URLSearchParams(window.location.search);
        q.set('takeover', '1');
        window.location.search = q.toString();
      } catch (e) { window.location.reload(); }
    });
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
      if (typeof ev.data === 'string') { console.debug('[zcode-webui]', ev.data); return; }
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
  // Ctrl+wheel is how Chrome reports two-finger pinch on touchpads/touchscreens;
  // a tiny two-pointer recognizer covers touchscreens whose regions set
  // touch-action:none (pointer events still fire there). Both drive the zoom
  // channel implemented in zcode-bridge.js (CSS zoom 50%..200%).
  (function () {
    function zoomGet() { return (window.__zwebui_zoom && window.__zwebui_zoom.get()) || 1; }
    function zoomSet(l) { if (window.__zwebui_zoom) window.__zwebui_zoom.set(l); }

    window.addEventListener('wheel', function (ev) {
      if (!ev.ctrlKey || ev.defaultPrevented) return;
      ev.preventDefault();
      // ~12% per wheel notch (deltaY ≈ ±100), finer on trackpad pinch deltas
      zoomSet(zoomGet() * Math.exp(-ev.deltaY * 0.001));
    }, { passive: false });

    var pointers = {};
    var pinchDist = 0;
    function onPointerDown(ev) {
      if (ev.pointerType !== 'touch') return;
      pointers[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      pinchDist = 0;
    }
    function onPointerMove(ev) {
      if (ev.pointerType !== 'touch' || !pointers[ev.pointerId]) return;
      pointers[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      var ids = Object.keys(pointers);
      if (ids.length !== 2) { pinchDist = 0; return; }
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var d = Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
      if (pinchDist > 0 && d > 0) {
        ev.preventDefault();
        zoomSet(zoomGet() * (d / pinchDist));
      }
      pinchDist = d;
    }
    function onPointerEnd(ev) {
      delete pointers[ev.pointerId];
      pinchDist = 0;
    }
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerEnd, { passive: true });
    window.addEventListener('pointercancel', onPointerEnd, { passive: true });
  })();

  connect();
})();
