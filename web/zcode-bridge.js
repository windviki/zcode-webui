// window.zcode shim for the official ZCode renderer.
// The desktop preload exposes ~130 typed IPC methods; in the browser we provide the
// meaningful subset and fall back to safe no-ops for desktop-only channels.
(function () {
  'use strict';
  var cfg = window.__ZCODE_WEBUI_CONFIG__ || {};
  var DEVICE_ID = cfg.deviceId || 'zcode-webui-unknown';
  var LOCALE = cfg.locale || 'zh-CN';

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
    getDesktopZoomLevel: val({ zoomLevel: 1 }),
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
