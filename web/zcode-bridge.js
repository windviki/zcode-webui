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

  // ---- mode boost (⚡ 完全访问 fast-lane) ----
  // While a permission card is pending the official renderer REPLACES the
  // composer, so the mode dropdown is not in the DOM and a build-mode
  // multi-step turn locks the user into clicking 允许 for every step. The
  // agent, however, applies mode changes instantly (every tool call re-reads
  // the live mode), so a push through the backend takes effect on the very
  // NEXT step. This floating switch:
  //   ON  → POST /api/mode-boost {mode:'yolo'} (host → v4 switchCollaboration
  //         Mode → agent setMode), auto-allow the pending card, and keep
  //         auto-allowing cards that slip through the sub-second race;
  //   OFF → push whatever the official dropdown currently shows and stop
  //         auto-allowing.
  // The official dropdown keeps working and stays authoritative for the NEXT
  // prompt's session config; this switch is an accelerator, not a replacement.
  var BOOST_KEY = 'zwebui-mode-boost';
  var boostOn = false;
  try { boostOn = localStorage.getItem(BOOST_KEY) === 'yolo'; } catch (e) { /* ignore */ }
  var boostBtn = null;

  // ---- quota-reset switch (♻ 自动重置) ----
  // Same floating panel, second chip. Unlike the ⚡ switch this one is
  // SERVER-state (not localStorage): POST /api/quota-reset writes a switch file
  // the host-side guard re-reads within seconds, so the state follows the
  // service, not the browser. Default OFF — auto-spending reset chances is
  // strictly opt-in.
  var qresetBtn = null;
  var qresetOn = false;
  var qresetBusy = false;

  function findAllowOnceButton() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].innerText || '').replace(/\s+/g, '');
      // matches "1.\n允许\n仅允许这一次"; excludes 始终允许… / 允许本会话
      if (t.indexOf('允许仅允许这一次') >= 0 && t.indexOf('始终') < 0 && t.indexOf('本会话') < 0) return btns[i];
    }
    return null;
  }
  function autoAllowPendingCard(reason) {
    var b = findAllowOnceButton();
    if (!b) return false;
    try { b.click(); } catch (e) { return false; }
    try { console.info('[zcode-webui] mode-boost: auto-allowed pending card (' + reason + ')'); } catch (e) {}
    return true;
  }
  function officialPickerMode() {
    try {
      var b = document.querySelector('button[aria-label="切换模式"]');
      var t = b ? (b.innerText || '').trim() : '';
      if (t === '完全访问') return 'yolo';
      if (t === '自动编辑') return 'edit';
      if (t === '计划模式') return 'plan';
      if (t === '自动') return 'auto';       // ZCodeTaskMode 'auto' (legacy setMode path)
    } catch (e) { /* ignore */ }
    return 'build';
  }
  function postModeBoost(mode) {
    return fetch(pageUrl('api/mode-boost'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: mode }),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); });
  }
  function postQuotaReset(mode) {
    return fetch(pageUrl('api/quota-reset'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: mode }),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); });
  }
  function loadQuotaReset() {
    fetchJson(pageUrl('api/quota-reset')).then(function (j) {
      if (!j || !j.ok || qresetBusy || !qresetBtn) return;
      qresetOn = j.mode === 'on';
      renderQresetButton();
    }).catch(function () { /* chip stays neutral until first click */ });
  }
  function renderQresetButton(errText) {
    if (!qresetBtn) return;
    qresetBtn.className = 'zwebui-qreset' + (qresetOn ? ' on' : errText ? ' err' : '');
    qresetBtn.__lbl.textContent = qresetOn ? '♻ 自动重置 已开启' : '♻ 自动重置';
    qresetBtn.title = qresetOn
      ? '宿主进程会在「池子快用完且有任务在跑 / 刚撞额度墙 / 机会快过期」时自动使用编程套餐的重置机会。点击关闭；可拖动。'
      : (errText || '开启后，宿主进程在池子快用完、任务被额度卡住或机会即将过期时自动使用「重置额度」机会。默认关闭；点击开启；可拖动。');
  }
  function setQreset(next) {
    if (qresetBusy) return;
    qresetBusy = true;
    var prev = qresetOn;
    qresetOn = !!next;                        // optimistic; reverted on failure
    renderQresetButton();
    postQuotaReset(qresetOn ? 'on' : 'off').then(function (r) {
      qresetBusy = false;
      if (r.j && r.j.ok) {
        qresetOn = r.j.mode === 'on';
        renderQresetButton(r.j.mode === 'dry-run' ? '当前为 dry-run（只记录决策，不实际使用），由 ZCODE_WEBUI_QUOTA_RESET 环境变量设定' : '');
        if (r.j.mode === 'dry-run') setTimeout(renderQresetButton, 4000);
        try { console.info('[zcode-webui] quota-reset switch → ' + r.j.mode); } catch (e) {}
      } else {
        qresetOn = prev;
        renderQresetButton((r.j && r.j.error) || ('HTTP ' + r.status));
        setTimeout(renderQresetButton, 4000);
      }
    }).catch(function (e) {
      qresetBusy = false;
      qresetOn = prev;
      renderQresetButton(String(e && e.message || e));
      setTimeout(renderQresetButton, 4000);
    });
  }

  // ---- official sidebar toggle (◧) ----
  // Product gap confirmed in the open-source renderer (v3.14.3): the sidebar's
  // expand/collapse button is DESKTOP-ONLY (DesktopTopOverlay renders it just
  // for win/linux caption areas and mac), and sidebar visibility is a
  // non-persistent in-memory state. In a browser there is NOTHING clickable to
  // reopen a collapsed sidebar — only the Cmd/Ctrl+B shortcut — so a collapsed
  // sidebar felt "stuck" until a page refresh (which resets visibility). This
  // chip drives the OFFICIAL command path (SHORTCUT_COMMANDS.toggleSidebar,
  // default CmdOrCtrl+B; the renderer's keyboard kernel listens on window in
  // the capture phase and does not check isTrusted), so both directions work.
  var sidebarBtn = null;
  function sidebarHidden() {
    var el = document.querySelector('[data-workspace-sidebar-panel]');
    // hidden state applies the `opacity-0` utility class (plus pointer-events-none)
    return !!(el && el.classList && el.classList.contains('opacity-0'));
  }
  function toggleOfficialSidebar() {
    var mac = /mac/i.test(String((navigator && navigator.platform) || (navigator && navigator.userAgent) || ''));
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'b', code: 'KeyB', bubbles: true, cancelable: true,
        ctrlKey: !mac, metaKey: mac,
      }));
    } catch (e) { return false; }
    try { console.info('[zcode-webui] sidebar toggle dispatched (official CmdOrCtrl+B path)'); } catch (e) { /* ignore */ }
    return true;
  }
  function renderSidebarButton() {
    if (!sidebarBtn) return;
    var hidden = sidebarHidden();
    sidebarBtn.className = 'zwebui-sidebar' + (hidden ? ' hint' : '');
    sidebarBtn.__lbl.textContent = hidden ? '◧ 展开侧栏' : '◧ 侧栏';
    sidebarBtn.title = hidden
      ? '官方 Web 渲染层没有可点击的侧栏展开按钮（折叠后只能 Ctrl/Cmd+B 或刷新页面）——这里代发官方快捷键把侧栏展开。可拖动。'
      : '收起/展开左侧栏（代发官方 Cmd/Ctrl+B 快捷键，与官方按钮等效）。可拖动。';
  }

  // debug/test hooks: official sidebar visibility + the toggle driver
  window.__zwebui_sidebarHidden = sidebarHidden;
  window.__zwebui_sidebarToggle = toggleOfficialSidebar;

  // ---- position / drag ----
  // Default berth: just OUTSIDE the top-right corner of the composer surface
  // (.chat-composer-input-surface — the input window). While not dragged the
  // panel keeps following the composer (sidebar collapse / window resize);
  // once dragged to a custom spot the position is remembered. Dragging it
  // back near the berth re-docks it (custom position forgotten).
  var BOOST_POS_KEY = 'zwebui-mode-boost-pos';
  var boostDragged = false;
  var boostPanel = null;

  function boostAnchorRect() {
    var el = document.querySelector('.chat-composer-input-surface')
      || document.querySelector('[data-testid="v4-composer-input"]');
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return r.width >= 60 ? r : null;
  }
  // The berth coordinates (view-space) for the composer's top-right outside edge.
  function boostBerth() {
    var r = boostAnchorRect();
    var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
    var w = boostPanel.offsetWidth || 120, h = boostPanel.offsetHeight || 30;
    if (!r) return { x: vw - w - 16, y: vh - h - 72 };
    var x = r.right + 10, y = r.top + 2;
    if (x + w > vw - 8) {                 // narrow viewport: no room outside the edge —
      x = Math.max(8, r.right - w);       // sit above the composer's right corner instead
      y = r.top - h - 8;
      if (y < 8) { x = r.right + 10; y = r.top + 2; }
    }
    return { x: x, y: y };
  }
  function placeBoost(x, y) {
    var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
    var w = boostPanel.offsetWidth || 120, h = boostPanel.offsetHeight || 30;
    x = Math.min(Math.max(4, x), Math.max(4, vw - w - 4));
    y = Math.min(Math.max(4, y), Math.max(4, vh - h - 4));
    var ls = Math.round(x) + 'px', ts = Math.round(y) + 'px';
    if (boostPanel.style.left !== ls) boostPanel.style.left = ls;   // no-op writes keep the node
    if (boostPanel.style.top !== ts) boostPanel.style.top = ts;     // stable for playwright checks
  }
  function savedBoostPos() {
    try {
      var s = (localStorage.getItem(BOOST_POS_KEY) || '').split(',');
      var x = parseFloat(s[0]), y = parseFloat(s[1]);
      if (isFinite(x) && isFinite(y)) return { x: x, y: y };
    } catch (e) { /* ignore */ }
    return null;
  }
  function dockBoost() { var b = boostBerth(); placeBoost(b.x, b.y); }

  function makeBoostChip(cls) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = cls;
    var dot = document.createElement('span');
    dot.className = 'dot';
    var lbl = document.createElement('span');
    chip.appendChild(dot);
    chip.appendChild(lbl);
    chip.__lbl = lbl;
    return chip;
  }
  function ensureBoostPanel() {
    if (boostPanel) return;
    try {
      var css = ''
        + '.zwebui-boost-panel{position:fixed;z-index:99999;display:flex;flex-direction:column;align-items:flex-end;gap:6px;'
        + 'user-select:none;-webkit-user-select:none;touch-action:none;}'
        + '.zwebui-boost-panel.dragging{opacity:.88;}'
        + '.zwebui-boost-panel.dragging .zwebui-boost,.zwebui-boost-panel.dragging .zwebui-qreset,.zwebui-boost-panel.dragging .zwebui-sidebar{cursor:grabbing;}'
        + '.zwebui-boost,.zwebui-qreset,.zwebui-sidebar{display:inline-flex;align-items:center;gap:6px;'
        + 'padding:7px 14px;border:1px solid var(--color-border,#2c3138);border-radius:999px;'
        + 'background:var(--color-surface,#1a1e23);color:var(--color-foreground,#e8eaed);'
        + 'font:600 12px/1 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;cursor:grab;'
        + 'box-shadow:0 6px 24px rgba(0,0,0,.35);user-select:none;-webkit-user-select:none;touch-action:none;}'
        + '.zwebui-boost:hover,.zwebui-qreset:hover,.zwebui-sidebar:hover{background:var(--color-surface-hover,#262b31);}'
        + '.zwebui-boost.on,.zwebui-qreset.on{border-color:rgba(84,214,138,.6);background:rgba(84,214,138,.14);color:#63d68f;}'
        + '.zwebui-boost.err,.zwebui-qreset.err{border-color:rgba(255,99,99,.7);color:#ff8a8a;}'
        + '.zwebui-sidebar.hint{border-color:rgba(255,212,121,.7);background:rgba(255,212,121,.12);color:#ffd479;}'
        + '.zwebui-boost .dot,.zwebui-qreset .dot,.zwebui-sidebar .dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:0 0 auto;}';
      var st = document.createElement('style');
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
      boostPanel = document.createElement('div');
      boostPanel.className = 'zwebui-boost-panel';
      boostBtn = makeBoostChip('zwebui-boost');
      qresetBtn = makeBoostChip('zwebui-qreset');
      sidebarBtn = makeBoostChip('zwebui-sidebar');
      boostPanel.appendChild(boostBtn);
      boostPanel.appendChild(qresetBtn);
      boostPanel.appendChild(sidebarBtn);
      (document.body || document.documentElement).appendChild(boostPanel);
      installBoostDrag();
      renderBoostButton();
      renderQresetButton();
      renderSidebarButton();
      loadQuotaReset();
      var saved = savedBoostPos();
      if (saved) { boostDragged = true; placeBoost(saved.x, saved.y); }
      else dockBoost();
      // keep the berth (or the clamped custom spot) correct as the layout moves
      setInterval(function () {
        if (!boostPanel) return;
        if (!boostDragged) dockBoost();
        else placeBoost(parseFloat(boostPanel.style.left) || 0, parseFloat(boostPanel.style.top) || 0);
        renderSidebarButton();          // label follows the official visibility state
      }, 500);
    } catch (e) { boostPanel = null; }
  }
  // Pointer-based drag on the whole panel; a press-release without a 5px move
  // counts as a click on whichever chip was pressed (each chip toggles its own
  // switch). Dropping within 24px of the berth re-docks the panel.
  function installBoostDrag() {
    var drag = null;
    boostPanel.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      var chip = e.target && e.target.closest ? e.target.closest('.zwebui-boost,.zwebui-qreset,.zwebui-sidebar') : null;
      drag = {
        id: e.pointerId, sx: e.clientX, sy: e.clientY, chip: chip,
        bx: parseFloat(boostPanel.style.left) || 0, by: parseFloat(boostPanel.style.top) || 0,
        moved: false,
      };
      try { boostPanel.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    boostPanel.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved) {
        if (dx * dx + dy * dy < 25) return;      // 5px threshold: still a click
        drag.moved = true;
        boostDragged = true;
        boostPanel.classList.add('dragging');
      }
      placeBoost(drag.bx + dx, drag.by + dy);
    });
    var finish = function (e) {
      if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.id)) return;
      var moved = drag.moved, chip = drag.chip;
      drag = null;
      boostPanel.classList.remove('dragging');
      try { boostPanel.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (moved) {
        var berth = boostBerth();
        var cx = parseFloat(boostPanel.style.left) || 0, cy = parseFloat(boostPanel.style.top) || 0;
        if (Math.abs(cx - berth.x) <= 24 && Math.abs(cy - berth.y) <= 24) {
          boostDragged = false;                  // dropped back on the berth: re-dock
          try { localStorage.removeItem(BOOST_POS_KEY); } catch (err) { /* ignore */ }
          dockBoost();
          return;
        }
        try { localStorage.setItem(BOOST_POS_KEY, Math.round(cx) + ',' + Math.round(cy)); } catch (err) { /* ignore */ }
      } else if (chip) {
        if (chip === boostBtn) setBoost(!boostOn, true);
        else if (chip === qresetBtn) setQreset(!qresetOn);
        else if (chip === sidebarBtn) toggleOfficialSidebar();
      }
    };
    boostPanel.addEventListener('pointerup', finish);
    boostPanel.addEventListener('pointercancel', finish);
  }
  function renderBoostButton(errText) {
    if (!boostBtn) return;
    boostBtn.className = 'zwebui-boost' + (boostOn ? ' on' : errText ? ' err' : '');
    boostBtn.__lbl.textContent = boostOn ? '⚡ 完全访问 已生效' : '⚡ 切完全访问';
    boostBtn.title = boostOn
      ? '当前会话已是完全访问：等待中的确认自动放行，后续步骤不再逐条询问。点击切回；可拖动。'
      : (errText || '立即把「完全访问」推送给当前会话——不用等任务空闲；等待中的确认会自动放行，后续步骤不再逐条询问。可拖动，拖回输入框右上角即恢复停靠。');
  }
  function setBoost(next, userAction) {
    boostOn = !!next;
    try { localStorage.setItem(BOOST_KEY, boostOn ? 'yolo' : ''); } catch (e) { /* ignore */ }
    renderBoostButton();
    var mode = boostOn ? 'yolo' : officialPickerMode();
    postModeBoost(mode).then(function (r) {
      if (r.j && r.j.ok) {
        renderBoostButton();
        if (boostOn) autoAllowPendingCard('switch-on');
      } else {
        renderBoostButton((r.j && r.j.error) || ('HTTP ' + r.status));
        setTimeout(renderBoostButton, 4000);
      }
    }).catch(function (e) {
      renderBoostButton(String(e && e.message || e));
      setTimeout(renderBoostButton, 4000);
    });
    if (!boostOn && userAction) { /* nothing else to do when turning off */ }
  }

  // Auto-allow while ON: covers cards raised inside the sub-second window
  // before the agent applies the pushed mode. Throttled body observer.
  var boostScanTimer = 0;
  function scheduleBoostScan() {
    if (!boostOn || boostScanTimer) return;
    boostScanTimer = setTimeout(function () {
      boostScanTimer = 0;
      if (boostOn) autoAllowPendingCard('observer');
    }, 350);
  }
  function installModeBoost() {
    var boot = function () {
      ensureBoostPanel();
      try {
        new MutationObserver(scheduleBoostScan).observe(document.body, { childList: true, subtree: true });
      } catch (e) { /* ignore */ }
      if (boostOn) autoAllowPendingCard('page-load');
    };
    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot);
  }
  installModeBoost();

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
    // 3.15's settings shell fetches close-to-tray capabilities and then renders
    // `capability.supported` without a null guard. The generic Proxy fallback
    // used to resolve `undefined`, which stored undefined in state and crashed
    // the whole settings section ("Cannot read properties of undefined
    // (reading 'supported')"). The browser has no close-to-tray support.
    getCloseToTrayCapability: val({ supported: false, gnomeLikeWithoutTray: false }),
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
    showTaskNotification: noop,
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
