// window.zcode shim for the official ZCode renderer.
// The desktop preload exposes ~130 typed IPC methods; in the browser we provide the
// meaningful subset and fall back to safe no-ops for desktop-only channels.
(function () {
  'use strict';
  var cfg = window.__ZCODE_WEBUI_CONFIG__ || {};
  var DEVICE_ID = cfg.deviceId || 'zcode-webui-unknown';
  var LOCALE = cfg.locale || 'zh-CN';
  var isEn = function () { return LOCALE === 'en-US'; };
  // page-relative URL helper: works with or without a trailing slash and under
  // reverse-proxy prefixes (code-server /proxy/<port>)
  function pageUrl(name) {
    var p = window.location.pathname;
    if (!/\/$/.test(p)) p += '/';
    return p + name;
  }
  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; });
  }

  // ---- desktop-style app zoom (CSS zoom, 50%..200%), driven by ctrl+wheel /
  // two-finger pinch (see bootstrap.js) and reported back to the official UI ----
  var ZOOM_MIN = 0.5, ZOOM_MAX = 2;
  var ZOOM_KEY = 'zwebui-zoom';
  var zoomLevel = 1;
  try {
    var savedZoom = parseFloat(localStorage.getItem(ZOOM_KEY) || '');
    if (savedZoom >= ZOOM_MIN && savedZoom <= ZOOM_MAX) zoomLevel = savedZoom;
  } catch (e) { /* ignore */ }
  var zoomListeners = [];
  function applyZoom() {
    try { document.documentElement.style.zoom = String(zoomLevel); } catch (e) { /* ignore */ }
    for (var i = 0; i < zoomListeners.length; i++) {
      try { zoomListeners[i]({ zoomLevel: zoomLevel }); } catch (e) { /* ignore */ }
    }
  }
  window.__zwebui_zoom = {
    get: function () { return zoomLevel; },
    set: function (lvl) {
      if (typeof lvl !== 'number' || !isFinite(lvl)) return;
      lvl = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(lvl * 1000) / 1000));
      if (lvl === zoomLevel) return;
      zoomLevel = lvl;
      try { localStorage.setItem(ZOOM_KEY, String(lvl)); } catch (e) { /* ignore */ }
      applyZoom();
    }
  };

  // ---- in-page overlay panels ----
  // The desktop app opens the folder picker / process monitor / about dialog as
  // separate OS windows. In the browser we render them as modal panels above the
  // app instead — no popup blockers, keeps the session context. Colors come from
  // the renderer's own theme variables (--color-*) so light/dark both work.
  var overlayStyleEl = null;
  function ensureOverlayStyle() {
    if (overlayStyleEl) return;
    var css = ''
      + '.zwebui-ovl{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);}'
      + '.zwebui-ovl-panel{display:flex;flex-direction:column;overflow:hidden;border-radius:14px;background:var(--color-menu,#1d2127);border:1px solid var(--color-popover-border,#2c3138);box-shadow:0 24px 64px rgba(0,0,0,.5);}'
      + '.zwebui-ovl-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:0 0 44px;padding:0 8px 0 16px;background:var(--color-header,#16191d);border-bottom:1px solid var(--color-border,#2c3138);color:var(--color-foreground,#e8eaed);font:600 13px/1 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}'
      + '.zwebui-ovl-x{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--color-foreground-subtle,#9aa3ad);font:400 15px/1 system-ui,sans-serif;cursor:pointer;}'
      + '.zwebui-ovl-x:hover{background:var(--color-surface-hover,#262b31);color:var(--color-foreground,#e8eaed);}'
      + '.zwebui-ovl-body{flex:1;min-height:0;}'
      + '.zwebui-ovl-frame{display:block;width:100%;height:100%;border:0;background:var(--color-background,#111418);}'
      + '.zwebui-ovl-info{box-sizing:border-box;padding:20px 22px;max-height:min(560px,80vh);overflow:auto;color:var(--color-foreground,#e8eaed);font:13px/1.75 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}'
      + '.zwebui-ovl-info h1{margin:0 0 14px;font-size:16px;font-weight:600;}'
      + '.zwebui-ovl-kv{display:flex;gap:14px;padding:3px 0;}'
      + '.zwebui-ovl-k{flex:0 0 128px;color:var(--color-foreground-subtle,#9aa3ad);}'
      + '.zwebui-ovl-v{word-break:break-all;}'
      + '.zwebui-ovl-links{margin:14px 0 0;}'
      + '.zwebui-ovl-links a{color:#6ea8ff;text-decoration:none;margin-right:14px;}'
      + '.zwebui-ovl-links a:hover{text-decoration:underline;}'
      + '.zwebui-ovl-cmd{margin:10px 0 0;padding:8px 12px;border-radius:8px;background:var(--color-surface,#1a1e23);border:1px solid var(--color-border,#2c3138);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;}'
      + '.zwebui-ovl-note{margin:8px 0 0;color:var(--color-foreground-subtle,#9aa3ad);font-size:12px;}';
    overlayStyleEl = document.createElement('style');
    overlayStyleEl.textContent = css;
    document.head.appendChild(overlayStyleEl);
  }

  // openOverlay({title, url?, node?, width?, height?, key?, onClose?}) → {close}
  // key: only one overlay per key — re-opening replaces the previous one
  // (matches the desktop's "focus the existing window" behavior).
  var overlaysByKey = {};
  function openOverlay(opts) {
    if (opts.key && overlaysByKey[opts.key]) {
      try { overlaysByKey[opts.key].close(); } catch (e) { /* ignore */ }
    }
    ensureOverlayStyle();
    var ovl = document.createElement('div');
    ovl.className = 'zwebui-ovl';
    var panel = document.createElement('div');
    panel.className = 'zwebui-ovl-panel';
    panel.style.width = 'min(' + (opts.width || 720) + 'px,92vw)';
    if (opts.url) panel.style.height = 'min(' + (opts.height || 640) + 'px,88dvh)';
    var head = document.createElement('div');
    head.className = 'zwebui-ovl-head';
    var title = document.createElement('span');
    title.textContent = opts.title || '';
    var x = document.createElement('button');
    x.className = 'zwebui-ovl-x';
    x.type = 'button';
    x.setAttribute('aria-label', 'close');
    x.textContent = '✕';
    head.appendChild(title);
    head.appendChild(x);
    var body = document.createElement('div');
    body.className = 'zwebui-ovl-body';
    if (opts.url) {
      var frame = document.createElement('iframe');
      frame.className = 'zwebui-ovl-frame';
      frame.src = opts.url;
      body.appendChild(frame);
    } else if (opts.node) {
      body.appendChild(opts.node);
    }
    panel.appendChild(head);
    panel.appendChild(body);
    ovl.appendChild(panel);
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (opts.key && overlaysByKey[opts.key] === handle) delete overlaysByKey[opts.key];
      document.removeEventListener('keydown', onKey, true);
      if (ovl.parentNode) ovl.parentNode.removeChild(ovl);
      if (opts.onClose) { try { opts.onClose(); } catch (e) { /* ignore */ } }
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close();
      }
    }
    x.addEventListener('click', close);
    ovl.addEventListener('mousedown', function (e) { if (e.target === ovl) close(); });
    document.addEventListener('keydown', onKey, true);
    (document.body || document.documentElement).appendChild(ovl);
    var handle = { close: close };
    if (opts.key) overlaysByKey[opts.key] = handle;
    return handle;
  }

  function infoBox(titleText) {
    var box = document.createElement('div');
    box.className = 'zwebui-ovl-info';
    var h = document.createElement('h1');
    h.textContent = titleText;
    box.appendChild(h);
    return box;
  }
  function kvRow(box, key) {
    var row = document.createElement('div');
    row.className = 'zwebui-ovl-kv';
    var k = document.createElement('span');
    k.className = 'zwebui-ovl-k';
    k.textContent = key;
    var v = document.createElement('span');
    v.className = 'zwebui-ovl-v';
    v.textContent = '…';
    row.appendChild(k);
    row.appendChild(v);
    box.appendChild(row);
    return v;
  }
  function noteRow(box, text) {
    var n = document.createElement('div');
    n.className = 'zwebui-ovl-note';
    n.textContent = text;
    box.appendChild(n);
    return n;
  }
  function cmdRow(box, text) {
    var c = document.createElement('div');
    c.className = 'zwebui-ovl-cmd';
    c.textContent = text;
    box.appendChild(c);
    return c;
  }
  function linkRow(box, links) {
    var wrap = document.createElement('div');
    wrap.className = 'zwebui-ovl-links';
    links.forEach(function (l) {
      var a = document.createElement('a');
      a.href = l[1];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = l[0];
      wrap.appendChild(a);
    });
    box.appendChild(wrap);
  }

  // ---- About (Help menu → 关于) ----
  function showAbout() {
    var box = infoBox('zcode-webui');
    var fields = isEn()
      ? [['Version', 'version'], ['zcode-server host', 'hostVersion'], ['Node (server)', 'nodeVersion'], ['Workspace', 'workspace'], ['Data home', 'dataHome'], ['Uptime', 'uptime']]
      : [['版本', 'version'], ['zcode-server 宿主', 'hostVersion'], ['Node(服务端)', 'nodeVersion'], ['工作区', 'workspace'], ['数据目录', 'dataHome'], ['运行时长', 'uptime']];
    var vals = {};
    fields.forEach(function (f) { vals[f[1]] = kvRow(box, f[0]); });
    linkRow(box, isEn()
      ? [['Docs', 'https://zcode.z.ai/docs'], ['GitHub', 'https://github.com/windvike/zcode-webui'], ['npm', 'https://www.npmjs.com/package/@aixyzstudio/zcode-webui']]
      : [['文档', 'https://zcode.z.ai/docs'], ['GitHub', 'https://github.com/windvike/zcode-webui'], ['npm', 'https://www.npmjs.com/package/@aixyzstudio/zcode-webui']]);
    openOverlay({ title: isEn() ? 'About' : '关于', node: box, key: 'about', width: 480 });
    fetchJson(pageUrl('api/health')).then(function (j) {
      if (!j) {
        Object.keys(vals).forEach(function (k) { vals[k].textContent = '—'; });
        return;
      }
      vals.version.textContent = j.version || '?';
      vals.hostVersion.textContent = j.hostVersion || '—';
      vals.nodeVersion.textContent = j.nodeVersion || '—';
      vals.workspace.textContent = j.workspace || '—';
      vals.dataHome.textContent = j.dataHome || '—';
      if (typeof j.uptimeSec === 'number') {
        var d = Math.floor(j.uptimeSec / 86400);
        var h = Math.floor((j.uptimeSec % 86400) / 3600);
        var m = Math.floor((j.uptimeSec % 3600) / 60);
        vals.uptime.textContent = (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm';
      } else vals.uptime.textContent = '—';
    }).catch(function () { /* values stay "…" */ });
  }

  // ---- update check state machine (Help menu → 检查更新) ----
  // The menu label reacts to getUpdateState()/onUpdateStateChanged():
  // {kind:'idle'} → "检查更新", {kind:'checking'} → "正在检查更新...",
  // {kind:'update-available', version} → "下载更新 vX.Y.Z" (clicking it again
  // re-enters checkForUpdates, where we show the upgrade instructions instead
  // of re-checking). The renderer reads state.kind without a null guard
  // (null → unhandledrejection on load), so the exposed state must never be
  // null: setUpdateState(null) resets to {kind:'idle'}.
  var updateState = { kind: 'idle' };
  var updateListeners = [];
  var lastUpdateResult = null;
  function setUpdateState(s) {
    updateState = s || { kind: 'idle' };
    for (var i = 0; i < updateListeners.length; i++) {
      try { updateListeners[i](s); } catch (e) { /* ignore */ }
    }
  }
  function showUpdate(j) {
    var box;
    if (j && j.hasUpdate) {
      box = infoBox(isEn() ? 'Official update available' : '有官方更新可用');
      kvRow(box, isEn() ? 'Latest (official)' : '官方最新版本').textContent = 'v' + j.latest;
      kvRow(box, isEn() ? 'Renderer' : '渲染器').textContent = j.rendererVersion ? 'v' + j.rendererVersion : (isEn() ? 'not installed' : '未部署');
      kvRow(box, isEn() ? 'Server runtime' : '服务端运行时').textContent = j.serverVersion ? 'v' + j.serverVersion : (isEn() ? 'not installed' : '未部署');
      cmdRow(box, 'zcode-webui upgrade');
      noteRow(box, isEn()
        ? 'Downloads and deploys the official renderer (vendor/renderer) and server runtime (~/.zcode/server). After it finishes, restart the service when no tasks are running (./zcode-service.sh restart).'
        : '将下载并部署官方渲染器(vendor/renderer)与服务端运行时(~/.zcode/server)。完成后请在所有任务空闲时重启服务(./zcode-service.sh restart)。');
      linkRow(box, [['Changelog', 'https://zcode.z.ai/cn/changelog']]);
    } else if (j && j.latest) {
      box = infoBox(isEn() ? 'Up to date' : '已是最新版本');
      kvRow(box, isEn() ? 'Official latest' : '官方最新版本').textContent = 'v' + j.latest;
      kvRow(box, isEn() ? 'Renderer' : '渲染器').textContent = j.rendererVersion ? 'v' + j.rendererVersion : (isEn() ? 'not installed' : '未部署');
      kvRow(box, isEn() ? 'Server runtime' : '服务端运行时').textContent = j.serverVersion ? 'v' + j.serverVersion : (isEn() ? 'not installed' : '未部署');
      noteRow(box, isEn()
        ? 'Renderer and server runtime both match the official release.'
        : '渲染器与服务端运行时均与官方发布版本一致。');
    } else {
      box = infoBox(isEn() ? 'Update check failed' : '检查更新失败');
      if (j && j.rendererVersion) kvRow(box, isEn() ? 'Renderer' : '渲染器').textContent = 'v' + j.rendererVersion;
      if (j && j.serverVersion) kvRow(box, isEn() ? 'Server runtime' : '服务端运行时').textContent = 'v' + j.serverVersion;
      noteRow(box, isEn()
        ? 'Cannot reach the official release pages (zcode.z.ai) right now. Try again later.'
        : '暂时无法访问官方发布页(zcode.z.ai),可稍后重试。');
      linkRow(box, [['zcode.z.ai', 'https://zcode.z.ai/cn/changelog']]);
    }
    openOverlay({ title: isEn() ? 'Check for Updates' : '检查更新', node: box, key: 'update-check', width: 480 });
  }
  function checkForUpdates() {
    if (updateState && updateState.kind === 'update-available') {
      showUpdate(lastUpdateResult || { latest: updateState.version, hasUpdate: true });
      return;
    }
    setUpdateState({ kind: 'checking' });
    fetchJson(pageUrl('api/update-check')).then(function (j) {
      lastUpdateResult = j;
      if (j && j.hasUpdate) setUpdateState({ kind: 'update-available', version: j.latest });
      else setUpdateState(null);
      showUpdate(j);
    }).catch(function () {
      setUpdateState(null);
      showUpdate(null);
    });
  }

  // ---- pin (置顶) kill switch ----
  // The official renderer moves a pinned task into the "已置顶" group, and the
  // host serves pinned tasks from a separate listPinnedTasks/listPinnedTaskIds
  // bucket — so a stray click on the tiny hover-only pin icon right next to the
  // row makes the session disappear from the task list. The web shell renders
  // the normal list only, so the control is removed from the UI outright.
  //
  // Two layers here, and a third on the server (src/pin.mjs, applied by
  // writeToHost and the /bridge/send relay):
  //   1. CSS hides both the row control and the "更多" popover item, so there is
  //      nothing to mis-click and nothing to focus from the keyboard;
  //   2. a capture-phase shield swallows click/mousedown/mouseup/focusin on any
  //      surviving pin control, so even a synthetic or stale-tab click cannot
  //      reach the renderer's handler and send the RPC.
  // A pinned row that predates the fix is un-pinned on the data side instead
  // (scripts/dev/unpin-tasks.mjs), because the renderer's task service is built
  // internally and is not reachable from this shim.
  var PIN_LABELS = [
    '\u7f6e\u9876\u4efb\u52a1',           // 置顶任务 (taskList.pin)
    '\u53d6\u6d88\u7f6e\u9876\u4efb\u52a1',  // 取消置顶任务 (taskList.unpin)
    'Pin task', 'Unpin task'
  ];
  function isPinControl(el) {
    if (!el || el.nodeType !== 1) return false;
    var label = el.getAttribute && el.getAttribute('aria-label');
    if (label && PIN_LABELS.indexOf(label.trim()) >= 0) return true;
    if (el.getAttribute && el.getAttribute('data-testid') === 'pin-button') return true;
    var txt = (el.textContent || '').trim();
    for (var i = 0; i < PIN_LABELS.length; i++) if (txt === PIN_LABELS[i]) return true;
    return false;
  }
  // Built from the renderer's own aria-labels: the row control carries one, and
  // the popover item carries the same label plus the menu text.
  var PIN_CSS = PIN_LABELS.map(function (l) {
    return '[aria-label="' + l.replace(/"/g, '\\"') + '"]';
  }).join(',') + ',[data-testid="pin-button"]';
  var PIN_STYLE = PIN_CSS + '{display:none !important;pointer-events:none !important;}';

  function installPinKillSwitch() {
    try {
      var st = document.createElement('style');
      st.id = '__zcode_webui_pin_kill';
      st.textContent = PIN_STYLE;
      (document.head || document.documentElement).appendChild(st);

      // kill clicks during the CAPTURE phase: the control's own mousedown
      // preventDefault/stopPropagation must not be relied on once we hide it
      function shield(ev) {
        var t = ev.target;
        var el = t && t.closest ? t.closest(PIN_CSS + ',[data-task-row-actions]') : null;
        if (!el || !isPinControl(el)) return;
        try { ev.preventDefault(); } catch (e) { /* ignore */ }
        try { ev.stopImmediatePropagation(); } catch (e) { /* ignore */ }
      }
      document.addEventListener('click', shield, true);
      document.addEventListener('mousedown', shield, true);
      document.addEventListener('mouseup', shield, true);
      // touch devices fire focus on the tiny control before the (mis)tap lands
      document.addEventListener('focusin', function (ev) {
        var el = ev.target;
        if (!el || !isPinControl(el)) return;
        try { el.blur(); } catch (e) { /* ignore */ }
      }, true);
    } catch (e) { /* never break the app shell over a UI patch */ }
  }
  installPinKillSwitch();

  function noop() {}
  function ok() { return Promise.resolve(undefined); }
  function unsub() { return function () {}; }
  function val(v) { return function () { return Promise.resolve(v); }; }
  function unsupported() { return Promise.reject(new Error('not supported in zcode-webui')); }

  // ---- browser task notifications ----
  // The official renderer asks the host to notify on task completion/failure,
  // but the desktop-only preload is a no-op in a browser. Forward that channel
  // to the browser Notification API, while keeping notification failures from
  // affecting the task flow.
  var notificationClickListeners = [];
  var notificationPermissionRequested = false;
  function requestNotificationPermission() {
    if (notificationPermissionRequested || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default') return;
    notificationPermissionRequested = true;
    try {
      var result = Notification.requestPermission();
      if (result && typeof result.catch === 'function') result.catch(function () { /* optional permission */ });
    } catch (e) { /* notification permission is best effort */ }
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', requestNotificationPermission, true);
    document.addEventListener('keydown', requestNotificationPermission, true);
  }
  function emitTaskNotificationClick(taskId) {
    for (var i = 0; i < notificationClickListeners.length; i++) {
      try { notificationClickListeners[i](taskId); } catch (e) { /* one listener must not block others */ }
    }
  }
  function onTaskNotificationClick(cb) {
    if (typeof cb !== 'function') return unsub();
    notificationClickListeners.push(cb);
    return function () {
      var i = notificationClickListeners.indexOf(cb);
      if (i >= 0) notificationClickListeners.splice(i, 1);
    };
  }
  function showTaskNotification(payload) {
    if (!payload || typeof payload !== 'object' || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    try {
      // Match desktop behavior: do not interrupt a user who is looking at the page.
      if (document.visibilityState === 'visible' && document.hasFocus()) return;
      var failed = payload.status === 'failed';
      var title = payload.title || (failed
        ? (isEn() ? 'ZCode task failed' : 'ZCode 任务失败')
        : (isEn() ? 'ZCode task completed' : 'ZCode 任务完成'));
      var notification = new Notification(title, {
        body: payload.body || '',
        tag: payload.taskId ? 'zcode-task-' + payload.taskId : undefined,
        requireInteraction: failed
      });
      if (payload.taskId) {
        notification.onclick = function () {
          try { window.focus(); } catch (e) { /* focus is best effort */ }
          emitTaskNotificationClick(payload.taskId);
          try { notification.close(); } catch (e) { /* already closed */ }
        };
      }
    } catch (e) { /* notifications must never break the task flow */ }
  }

  var api = {
    // identity / lifecycle
    getDeviceId: val(DEVICE_ID),
    notifyRendererReady: noop,
    log: function (level, args) { var c = console[level] || console.log; try { c.apply(console, args || []); } catch (e) {} },
    // telemetry / update (all stubbed)
    syncTelemetryContext: noop,
    reportTelemetryEvent: ok,
    reportArmsCustomEvent: ok,
    // The 3.11 renderer's ui-action tracer asks for this config and then calls
    // updateConfig(result) unconditionally. Our generic fallback below returns
    // Promise.resolve(undefined) for any unknown method, which would store
    // `undefined` as the config and crash on the next traced action
    // ("Cannot read properties of undefined (reading 'enabled')"). Return the
    // same disabled shape the renderer itself uses as its default.
    getRendererActionTraceConfig: val({ enabled: false, sampleRatio: 0, enabledGroups: [], configVersion: 'disabled' }),
    onRendererActionTraceConfigChanged: unsub,
    reportRendererActionTraceBatch: ok,
    syncWindowTabs: noop,
    syncWindowUnreadCount: noop,
    syncAppSettings: noop,
    syncWebRemoteControlWorkspaces: noop,
    syncWebRemoteControlTasks: noop,
    getUpdateState: function () { return Promise.resolve(updateState); },
    onUpdateStateChanged: function (cb) {
      if (typeof cb !== 'function') return unsub();
      updateListeners.push(cb);
      return function () {
        var i = updateListeners.indexOf(cb);
        if (i >= 0) updateListeners.splice(i, 1);
      };
    },
    getAutoUpdatePreferences: val({ autoDownload: false, autoInstall: false }),
    setAutoDownloadAndInstallUpdates: ok,
    downloadUpdate: ok,
    cancelUpdateDownload: ok,
    openUpdateStatusWindow: ok,
    acknowledgePostUpdateReleaseNotes: ok,
    skipUpdateVersion: ok,
    quitAndInstallUpdate: ok,
    getDesktopSessionActivity: val({}),
    // locale / window chrome
    getSystemLocale: val(LOCALE),
    getApplicationLocale: val(LOCALE),
    setApplicationLocale: ok,
    getDesktopZoomLevel: function () { return Promise.resolve({ zoomLevel: zoomLevel }); },
    setDesktopZoomLevel: function (lvl) { window.__zwebui_zoom.set(Number(lvl)); return Promise.resolve(undefined); },
    onDesktopZoomLevelChanged: function (cb) {
      if (typeof cb === 'function' && zoomListeners.indexOf(cb) < 0) zoomListeners.push(cb);
      return function () { var i = zoomListeners.indexOf(cb); if (i >= 0) zoomListeners.splice(i, 1); };
    },
    getDesktopWindowChromeState: val({ maximized: false, fullscreen: false, focused: true }),
    getWindowControlsOverlayMetrics: val(null),
    setTitleBarTheme: ok,
    // workspaces / remote (unsupported in webui; official UI will show local-only)
    listSSHConfigAliases: val([]),
    isDockerAvailable: val(false),
    listDockerContainers: val([]),
    listWSLDistros: val([]),
    connectRemote: val({ success: false, error: 'remote connections are not supported in zcode-webui' }),
    cancelPendingRemoteConnection: ok,
    bindRemoteWorkspaceSessionContext: val({ success: false, error: 'not supported in zcode-webui' }),
    disposeRemoteSession: ok,
    activateOrSetWorkspace: val({}),
    // web remote control (needs desktop + cloud relay) — disabled
    startWebRemoteControl: val({ success: false, error: 'not supported in zcode-webui' }),
    refreshWebRemoteControlPairing: ok,
    stopWebRemoteControl: ok,
    getWebRemoteControlStatus: val({ status: 'idle' }),
    // native dialogs / fs
    selectDirectory: function () {
      // Desktop opens a native folder dialog; we show our web picker as an
      // in-page overlay (no popup blockers). picker.html postMessages the
      // result back — see web/picker.html.
      return new Promise(function (resolve, reject) {
        var settled = false;
        var ov = null;
        function finish(fn, v) {
          if (settled) return;
          settled = true;
          window.removeEventListener('message', onMsg);
          if (ov) ov.close();
          fn(v);
        }
        function onMsg(ev) {
          if (!ev.data || typeof ev.data !== 'object') return;
          if (ev.data.type === 'zcode-dir-picked') finish(resolve, ev.data.path);
          else if (ev.data.type === 'zcode-dir-cancelled') finish(reject, new Error('cancelled'));
        }
        window.addEventListener('message', onMsg);
        ov = openOverlay({
          title: isEn() ? 'Select Folder' : '选择文件夹',
          url: pageUrl('picker.html'),
          key: 'dir-picker',
          width: 620, height: 600,
          onClose: function () { finish(reject, new Error('cancelled')); }
        });
      });
    },
    selectFile: unsupported,
    selectFiles: unsupported,
    saveFile: unsupported,
    printPageToPdf: noop,
    getPathForFile: function () { return null; },
    createTempTextAttachment: val(null),
    openInFileManager: val(false),
    openExternal: function (url) { try { window.open(url, '_blank', 'noopener'); } catch (e) {} },
    canOpenCommunity: val(false),
    // OAuth (login handled by zcode-webui /login page + backend)
    registerOAuthState: noop,
    onPaymentCallback: unsub,
    // CUA / browser view (desktop-only) — stubs
    openCuaPermissionOnboarding: ok,
    prepareCuaHelperPermissionDrag: ok,
    startCuaHelperPermissionDrag: noop,
    openCuaAccessibilitySettings: ok,
    browserViewAttachGuest: ok,
    browserViewCloseTab: ok,
    browserViewReportResidency: ok,
    browserViewSuspendReady: ok,
    browserViewEnsureResident: ok,
    browserViewRestoreTabs: ok,
    browserViewUpdateViewport: ok,
    importChromeBrowserData: ok,
    clearEmbeddedBrowserData: ok,
    browserViewScreenshotSurfaceReady: noop,
    // misc
    showTaskNotification: showTaskNotification,
    onTaskNotificationClick: onTaskNotificationClick,
    exportLogs: function () {
      // Downloads the server-side log bundle (service snapshot + process tree +
      // service log tail) as a file; the renderer just needs {success}.
      return fetch(pageUrl('api/logs/export'), { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.blob();
        })
        .then(function (blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'zcode-webui-logs-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.txt';
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
          return { success: true };
        })
        .catch(function (e) {
          return { success: false, error: e && e.message ? e.message : String(e) };
        });
    },
    captureWindowScreenshot: val(null),
    startPerformanceTrace: ok,
    stopPerformanceTrace: ok,
    getZCodeStdioTapDevState: val(false),
    getInstalledEditors: val([]),
    openInEditor: val(false),
    // desktop commands arrive as camelCase strings; the ones with a web
    // equivalent are handled here, everything else is a no-op.
    executeDesktopCommand: function (cmd) {
      if (cmd === 'openProcessMonitor') {
        // official renderer page; server injects the window.processMonitor shim
        openOverlay({
          title: isEn() ? 'Process Monitor' : '进程监控',
          url: pageUrl('process-monitor.html'),
          key: 'process-monitor',
          width: 880, height: 620
        });
      } else if (cmd === 'showAbout') {
        showAbout();
      } else if (cmd === 'checkForUpdates') {
        checkForUpdates();
      }
      return Promise.resolve(true);
    },
    loadMcpFromUserDirectory: val({ items: [] }),
    saveMcpToUserDirectory: ok,
    migrateLegacyCommonMcp: ok
  };

  // Every "onXxx" channel becomes a subscribe helper returning an unsubscribe fn.
  var callLog = [];
  var target = new Proxy(api, {
    get: function (t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then') return undefined;
      var wrapped;
      if (prop in t) {
        wrapped = t[prop];
      } else {
        wrapped = String(prop).indexOf('on') === 0 ? unsub : ok;
        t[prop] = wrapped;
      }
      if (typeof wrapped === 'function') {
        return function () {
          if (callLog.length < 40) callLog.push(prop + '(' + Array.prototype.map.call(arguments, function (a) { try { return JSON.stringify(a); } catch (e) { return String(a); } }).join(',').slice(0, 120) + ')');
          return wrapped.apply(this, arguments);
        };
      }
      return wrapped;
    },
    set: function (t, prop, v) { t[prop] = v; return true; }
  });
  window.__zb_bridge_calls = callLog;

  window.zcode = target;
  window.__ZCODE_DEVICE_ID__ = DEVICE_ID;
})();
