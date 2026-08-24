// window.zcode shim for the official ZCode renderer.
// The desktop preload exposes ~130 typed IPC methods; in the browser we provide the
// meaningful subset and fall back to safe no-ops for desktop-only channels.
(function () {
  'use strict';
  var cfg = window.__ZCODE_WEBUI_CONFIG__ || {};
  var DEVICE_ID = cfg.deviceId || 'zcode-webui-unknown';
  var LOCALE = cfg.locale || 'zh-CN';

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
      lvl = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(lvl * 100) / 100));
      if (lvl === zoomLevel) return;
      zoomLevel = lvl;
      try { localStorage.setItem(ZOOM_KEY, String(lvl)); } catch (e) { /* ignore */ }
      applyZoom();
    }
  };

  function noop() {}
  function ok() { return Promise.resolve(undefined); }
  function unsub() { return function () {}; }
  function val(v) { return function () { return Promise.resolve(v); }; }
  function unsupported() { return Promise.reject(new Error('not supported in zcode-webui')); }

  var api = {
    // identity / lifecycle
    getDeviceId: val(DEVICE_ID),
    notifyRendererReady: noop,
    log: function (level, args) { var c = console[level] || console.log; try { c.apply(console, args || []); } catch (e) {} },
    // telemetry / update (all stubbed)
    syncTelemetryContext: noop,
    reportTelemetryEvent: ok,
    reportArmsCustomEvent: ok,
    syncWindowTabs: noop,
    syncWindowUnreadCount: noop,
    syncAppSettings: noop,
    syncWebRemoteControlWorkspaces: noop,
    syncWebRemoteControlTasks: noop,
    getUpdateState: val({ status: 'idle' }),
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
      return new Promise(function (resolve, reject) {
        var win = null;
        try {
          win = window.open('picker.html', 'zcode-dir-picker', 'width=600,height=640');
        } catch (e) { reject(new Error('无法打开文件夹选择器（弹窗被拦截？）: ' + e.message)); return; }
        if (!win) { reject(new Error('无法打开文件夹选择器（弹窗被拦截，请允许本站弹窗）')); return; }
        var done = false;
        var onMsg = function (ev) {
          if (!ev.data || typeof ev.data !== 'object') return;
          if (ev.data.type === 'zcode-dir-picked') { done = true; window.removeEventListener('message', onMsg); resolve(ev.data.path); }
          else if (ev.data.type === 'zcode-dir-cancelled') { done = true; window.removeEventListener('message', onMsg); reject(new Error('cancelled')); }
        };
        window.addEventListener('message', onMsg);
        setTimeout(function () { if (!done) { window.removeEventListener('message', onMsg); reject(new Error('文件夹选择器超时')); } }, 300000);
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
    exportLogs: ok,
    captureWindowScreenshot: val(null),
    startPerformanceTrace: ok,
    stopPerformanceTrace: ok,
    getZCodeStdioTapDevState: val(false),
    getInstalledEditors: val([]),
    openInEditor: val(false),
    executeDesktopCommand: val(true),
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
