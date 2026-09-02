// window.processMonitor shim for the official renderer's process-monitor page.
// On the desktop, Electron's preload exposes getProcessMetrics() over IPC
// (app.getAppMetrics()); here we fetch the same tree — the server-side process
// tree of the webui service and its zcode host/sessions — from our backend.
// The page polls us once per second and shows "进程监控接口不可用" when we
// resolve falsy, so a failed fetch degrades to that message instead of an error.
(function () {
  'use strict';
  window.processMonitor = {
    getProcessMetrics: function () {
      // resolve against the page's own directory so the request works behind
      // reverse proxies that mount us under a prefix (e.g. /proxy/3102/)
      var dir = window.location.pathname.replace(/[^/]*$/, '');
      return fetch(dir + 'api/process-metrics', { cache: 'no-store' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; });
    }
  };
})();
