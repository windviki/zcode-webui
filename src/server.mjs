// zcode-webui: serve the official ZCode desktop renderer in a browser, backed by the
// in-container zcode host service (zcode-server.cjs), bridged over WebSocket.
//
//   node src/server.mjs [--port 3102] [--base-path /proxy/3102] [--workspace /path]
//
// Env equivalents: ZCODE_WEBUI_PORT, ZCODE_WEBUI_BASE_PATH, ZCODE_WEBUI_WORKSPACE,
// ZCODE_WEBUI_OAUTH_PROXY, ZCODE_SERVER_RUNTIME_ROOT.

import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { encodeFrame, FrameParser } from './frame.mjs';
import { rpcLogLine } from './rpclog.mjs';
import { spawnHost, handshake, resolveServerRoot } from './host.mjs';
import { startLogin, stopLogin, loginState, credentialsPath } from './login.mjs';
import { resolvePaths } from './dirs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PATHS = resolvePaths(ROOT);

// ---------- config ----------
function argValue(name, fallback) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--' + name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return fallback;
}
// config.json in the data home (optional, lowest priority)
let fileConfig = {};
try {
  fileConfig = JSON.parse(readFileSync(PATHS.configFile, 'utf8'));
} catch (_e) { /* ignore */ }

const PORT = Number(process.env.ZCODE_WEBUI_PORT || argValue('port', fileConfig.port) || 3102);
const WORKSPACE = process.env.ZCODE_WEBUI_WORKSPACE || argValue('workspace', fileConfig.workspace) || os.homedir();
const OAUTH_PROXY = process.env.ZCODE_WEBUI_OAUTH_PROXY || argValue('oauth-proxy', fileConfig.oauthProxy) || '';
// proxy used by the spawned host/agent processes for ZCode cloud + model APIs
// (set ZCODE_HTTP_PROXY / ZCODE_NO_PROXY in the child env)
const HOST_PROXY = process.env.ZCODE_WEBUI_HOST_PROXY || argValue('host-proxy', fileConfig.hostProxy) || '';
const LOCALE = process.env.ZCODE_WEBUI_LOCALE || fileConfig.locale || 'zh-CN';

let base = process.env.ZCODE_WEBUI_BASE_PATH || argValue('base-path', '') || '';
base = ('/' + base).replace(/\/+/g, '/').replace(/\/$/, '');
if (base === '/') base = '';
const joinBase = (p) => base + p;

const RENDERER_DIR = PATHS.rendererDir;
const WEB_DIR = path.join(ROOT, 'web');

let serverRoot;
try {
  serverRoot = resolveServerRoot();
} catch (err) {
  console.error('[zcode-webui] WARNING: ' + err.message);
  serverRoot = '';
}

// per-run ws token: the browser's WebSocket must present it AND verify our first
// text message; otherwise a foreign websocket server (e.g. code-server's own /ws
// when the URL lacks a trailing slash) would feed garbage frames into the renderer.
const WS_TOKEN = randomUUID();
const WS_READY = '{"kind":"zcode-webui-ready"}';

// ---------- client identity ----------
// A long-lived cookie identifies the browser (all tabs share it), a sessionStorage
// tab id identifies one tab across reloads. Together they let us re-attach a tab to
// the host process it was using before a reload / disconnect, so tasks keep running
// in the background instead of dying with the tab.
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_e) { /* ignore */ }
    }
  }
  return out;
}
const CLIENT_COOKIE = 'zwebui_client';
function sessionKey(clientKey, tabId) {
  return (clientKey || ('tab:' + tabId)) + ':' + (tabId || 'untabbed');
}

// Detached hosts (tab closed) are kept alive so their tasks can finish. Set a TTL to
// reap hosts that have been detached for longer than this (0 = keep forever).
const DETACHED_TTL_MS = Number(process.env.ZCODE_WEBUI_DETACHED_TTL_MS || 0);

// persistent device id for the renderer
const DEVICE_FILE = PATHS.deviceFile;
let deviceId = '';
try {
  if (existsSync(DEVICE_FILE)) deviceId = JSON.parse(readFileSync(DEVICE_FILE, 'utf8')).deviceId || '';
} catch (_e) { /* ignore */ }
if (!deviceId) {
  deviceId = 'zcode-webui-' + randomUUID();
  try {
    mkdirSync(path.dirname(DEVICE_FILE), { recursive: true });
    writeFileSync(DEVICE_FILE, JSON.stringify({ deviceId }), { flag: 'w' });
  } catch (_e) { /* ignore */ }
}

// ---------- static helpers ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.pdf': 'application/pdf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.webp': 'image/webp',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
function safeJoin(dir, rel) {
  const p = path.normalize(path.join(dir, rel));
  if (!p.startsWith(dir + path.sep) && p !== dir) return null;
  return p;
}
function serveFile(res, filePath) {
  if (!existsSync(filePath)) return send(res, 404, 'not found');
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const size = statSync(filePath).size;
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': String(size),
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}

// ---------- index.html transform ----------
function readRendererIndex() {
  const p = path.join(RENDERER_DIR, 'index.html');
  if (!existsSync(p)) return null;
  let html = readFileSync(p, 'utf8');
  // NOTE: injected script srcs are RELATIVE (./__zcode_webui/...) so they resolve
  // under whatever public prefix the reverse proxy uses (code-server strips
  // /proxy/<port> before forwarding; absolute paths would escape the prefix).
  const assetVersion = '?v=' + Date.now().toString(36);
  // INLINE redirect: relative URLs break when the page URL is '/proxy/<port>'
  // without a trailing slash (e.g. ./assets resolves to /proxy/assets). code-server
  // strips the prefix before forwarding, so the backend cannot fix this — redirect
  // in the browser before any external resource loads.
  const slashRedirect = '<script>(function(){try{var p=window.location.pathname;if(/^\\/proxy\\/\\d+$/.test(p)){window.location.replace(p+"/"+window.location.search);}}catch(e){}})();</script>';
  const cfgScript = '<script>window.__ZCODE_WEBUI_CONFIG__ = ' + JSON.stringify({
    base,
    wsPath: joinBase('/ws'),
    wsToken: WS_TOKEN,
    locale: LOCALE,
    workspace: WORKSPACE,
    deviceId,
    serverRoot: serverRoot || null,
  }) + ';</script>';
  const bridgeScript = '<script src="./__zcode_webui/zcode-bridge.js' + assetVersion + '"></script>';
  const bootScript = '<script src="./__zcode_webui/bootstrap.js' + assetVersion + '"></script>';
  const inject = slashRedirect + cfgScript + bridgeScript + bootScript;
  // Attach the injected scripts right after the renderer's viewport meta tag so they
  // run before the official entry scripts. Fall back to right after <head> in case a
  // future renderer version changes that tag.
  const metaViewport = '<meta name="viewport" content="width=device-width, initial-scale=1.0" />';
  if (html.includes(metaViewport)) {
    html = html.replace(metaViewport, metaViewport + inject);
  } else {
    html = html.replace(/<head([^>]*)>/i, (m, attrs) => '<head' + attrs + '>' + inject);
  }
  return html;
}

// ---------- login ----------
let loginRun = null; // {child, url(), output()}
let loginLog = '';

// ---------- host pipe (shared by WS transport and HTTP fallback transport) ----------
function openHostPipe() {
  const extraEnv = HOST_PROXY
    ? { ZCODE_HTTP_PROXY: HOST_PROXY, ZCODE_NO_PROXY: 'localhost,127.0.0.1' }
    : {};
  const host = spawnHost({ serverRoot, log: (l) => console.error(l), extraEnv });
  const { child } = host;
  return handshake(child).then(({ hello, rest }) => {
    const state = {
      child, hello, closed: false, framesIn: 0, framesOut: 0,
      onFrame: null, onExit: null,
    };
    const rpcDebug = process.env.ZCODE_WEBUI_DEBUG_RPC === '1';
    const parser = new FrameParser((payload) => {
      state.framesOut++;
      if (rpcDebug) { const l = rpcLogLine('RPC-out', payload); if (l) console.error('[rpc] ' + l); }
      if (state.onFrame && !state.closed) {
        try { state.onFrame(Buffer.from(payload)); } catch (_e) { /* ignore */ }
      }
    });
    parser.push(rest);
    child.stdout.on('data', (d) => parser.push(d));
    child.on('exit', (code, signal) => {
      state.closed = true;
      if (state.onExit) { try { state.onExit(code, signal); } catch (_e) { /* ignore */ } }
    });
    state.push = (payload) => {
      if (state.closed) return false;
      state.framesIn++;
      // protect the host: only forward payloads that look like serialized channel
      // messages (first byte is an RPC preset 0..6); drop flow-control JSON etc.
      if (!payload || payload.length === 0 || payload[0] > 6) {
        console.error('[bridge] dropped non-protocol inbound payload ' + payload.length + 'B first=' + (payload[0] ?? 'nil'));
        return true;
      }
      if (rpcDebug) { const l = rpcLogLine('RPC-in ', payload); if (l) console.error('[rpc] ' + l); }
      try { child.stdin.write(encodeFrame(payload)); return true; } catch (_e) { return false; }
    };
    state.close = () => {
      state.closed = true;
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
      }
    };
    return state;
  });
}

// ---------- host sessions ----------
// One host process per (clientKey, tabId) session. Hosts are NOT killed when the
// browser tab / websocket goes away: they keep running their turns in the background
// and can be re-attached by a later tab (same tab id after a reload, or any tab of
// the same browser adopting a detached host).
const sessions = new Map();       // sessionKey -> session
const clientSessions = new Map(); // clientKey -> Set(session)
const httpRelays = new Map();     // id -> {pipe, queue, waiter, waiterTimer, lastSeen} (HTTP long-poll fallback)

function rpcLogOut(payload) {
  const l = rpcLogLine('RPC-out', payload);
  if (l) console.error('[rpc] ' + l);
}
function rpcLogIn(payload) {
  const l = rpcLogLine('RPC-in ', payload);
  if (l) console.error('[rpc] ' + l);
}

function writeToHost(session, payload) {
  if (session.closed) return false;
  session.framesIn++;
  // protect the host: only forward payloads that look like serialized channel
  // messages (first byte is an RPC preset 0..6); drop flow-control JSON etc.
  if (!payload || payload.length === 0 || payload[0] > 6) {
    console.error('[bridge] dropped non-protocol inbound payload ' + payload.length + 'B first=' + (payload[0] ?? 'nil'));
    return true;
  }
  if (process.env.ZCODE_WEBUI_DEBUG_RPC === '1') rpcLogIn(payload);
  try { session.child.stdin.write(encodeFrame(payload)); return true; } catch (_e) { return false; }
}

function removeSession(session) {
  for (const [k, s] of sessions) if (s === session) sessions.delete(k);
  const set = clientSessions.get(session.clientKey);
  if (set) {
    set.delete(session);
    if (set.size === 0) clientSessions.delete(session.clientKey);
  }
}

function terminateSession(session, reason) {
  if (!session) return;
  session.closed = true;
  if (session.ws) { try { session.ws.close(1011, 'host terminated'); } catch (_e) { /* ignore */ } }
  const child = session.child;
  if (child && child.exitCode === null) {
    console.error('[zcode-webui] terminating host pid=' + child.pid + ' reason=' + reason);
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
  }
  removeSession(session);
}

function createSession(clientKey, tabId) {
  let child;
  try {
    const host = spawnHost({ serverRoot, log: (l) => console.error(l) });
    child = host.child;
  } catch (err) {
    throw new Error('failed to spawn host: ' + err.message);
  }
  const session = {
    id: randomUUID(), clientKey, tabId, child, hello: null,
    ws: null, wsAttachedAt: 0, detachedAt: 0,
    framesIn: 0, framesOut: 0, pendingInbound: [], closed: false,
  };
  console.error('[zcode-webui] host spawned pid=' + child.pid + ' client=' + (clientKey || '(no-cookie)') + '/' + (tabId || '').slice(0, 8));
  sessions.set(sessionKey(clientKey, tabId), session);
  let set = clientSessions.get(clientKey);
  if (!set) { set = new Set(); clientSessions.set(clientKey, set); }
  set.add(session);

  // stdout must be drained forever — even with no tab attached — so the pipe never
  // fills up and blocks the host while it keeps working in the background.
  const parser = new FrameParser((payload) => {
    session.framesOut++;
    // remember the host's Initialize frame (the first thing it pushes after the
    // stdio handshake) so we can replay it to a freshly re-attached renderer —
    // the renderer only starts its boot sequence after receiving it.
    if (session.framesOut === 1) session.initializePayload = Buffer.from(payload);
    if (process.env.ZCODE_WEBUI_DEBUG_RPC === '1') rpcLogOut(payload);
    const ws = session.ws;
    if (!session.closed && ws && ws.readyState === 1) {
      try { ws.send(payload, { binary: true }); } catch (_e) { /* ignore */ }
    }
  });
  session.parser = parser;
  session.initializePayload = null;
  child.on('exit', (code, signal) => {
    session.closed = true;
    if (session.ws) { try { session.ws.close(1011, 'host exited'); } catch (_e) { /* ignore */ } }
    console.error('[zcode-webui] host exited pid=' + child.pid + ' code=' + code + ' signal=' + signal + (session.detachedAt ? ' (was detached)' : ''));
    removeSession(session);
  });

  handshake(child)
    .then(({ hello, rest }) => {
      if (session.closed) return;
      session.hello = hello;
      console.error('[zcode-webui] handshake ok pid=' + child.pid + ' host=' + hello.version);
      // attach the stdout drain only after the handshake consumed the hello line —
      // otherwise the hello JSON would contaminate the frame parser's buffer
      parser.push(rest);
      child.stdout.on('data', (d) => parser.push(d));
      for (const p of session.pendingInbound.splice(0)) writeToHost(session, p);
      if (session.ws && session.ws.readyState === 1) {
        try { session.ws.send('[zcode-webui] handshake ok, host version=' + hello.version); } catch (_e) { /* ignore */ }
      }
    })
    .catch((err) => {
      console.error('[zcode-webui] handshake failed pid=' + child.pid + ': ' + err.message);
      if (session.ws) { try { session.ws.close(1011, 'host handshake failed'); } catch (_e) { /* ignore */ } }
      terminateSession(session, 'handshake failed');
    });

  const timer = setInterval(() => {
    if (session.closed) { clearInterval(timer); return; }
    if (session.framesIn || session.framesOut) {
      console.error('[relay] frames in=' + session.framesIn + ' out=' + session.framesOut + ' (pid=' + child.pid + (session.ws ? '' : ', detached') + ')');
    }
  }, 15000);
  timer.unref();

  return session;
}

function rebindSession(session, clientKey, tabId) {
  for (const [k, s] of sessions) if (s === session) sessions.delete(k);
  let set = clientSessions.get(session.clientKey);
  if (set) {
    set.delete(session);
    if (set.size === 0) clientSessions.delete(session.clientKey);
  }
  session.clientKey = clientKey;
  session.tabId = tabId;
  sessions.set(sessionKey(clientKey, tabId), session);
  set = clientSessions.get(clientKey);
  if (!set) { set = new Set(); clientSessions.set(clientKey, set); }
  set.add(session);
}

function attachRelay(ws, session) {
  // reload race: a previous websocket for the same (client, tab) may still be open;
  // park it so only one connection drives the host at a time.
  const prev = session.ws;
  if (prev && prev !== ws) {
    try { prev.close(4001, 'superseded'); } catch (_e) { /* ignore */ }
  }
  session.ws = ws;
  session.wsAttachedAt = Date.now();
  const reattach = !!session.detachedAt;
  session.detachedAt = 0;
  console.error('[zcode-webui] host ' + (reattach ? 'REATTACHED' : 'attached') + ' pid=' + session.child.pid + ' client=' + (session.clientKey || '(no-cookie)') + '/' + (session.tabId || '').slice(0, 8));

  const log = (line) => {
    try { if (ws.readyState === 1) ws.send(String(line)); } catch (_e) { /* ignore */ }
  };
  log('[zcode-webui] host ' + (reattach ? 'reattached' : 'spawned') + ' pid=' + session.child.pid);
  if (reattach && session.initializePayload) {
    // kick the fresh renderer's boot sequence by replaying the host Initialize
    try { ws.send(session.initializePayload, { binary: true }); } catch (_e) { /* ignore */ }
    console.error('[zcode-webui] replayed host initialize to re-attached renderer pid=' + session.child.pid);
  }

  ws.on('message', (data, isBinary) => {
    if (session.closed) return;
    if (!isBinary) return; // string messages are reserved for future control
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (session.hello) writeToHost(session, payload);
    else session.pendingInbound.push(payload);
  });

  ws.on('close', (code) => {
    if (session.ws !== ws) return; // superseded by a newer attachment
    session.ws = null;
    if (code === 4000) {
      // explicit terminate request (tests / cleanup)
      console.error('[ws] terminate (code 4000) pid=' + session.child.pid);
      terminateSession(session, 'ws terminate');
      return;
    }
    if (session.closed) return;
    if (session.framesIn === 0 && session.framesOut === 0) {
      // closed before any traffic: nothing was started, free the host
      console.error('[ws] closed before traffic, terminating host pid=' + session.child.pid);
      terminateSession(session, 'closed before traffic');
      return;
    }
    // DETACH: the host keeps running in the background until its task finishes,
    // waits for user input, or is re-attached by another tab.
    session.detachedAt = Date.now();
    console.error('[ws] DETACHED (host keeps running) pid=' + session.child.pid + ' frames in=' + session.framesIn + ' out=' + session.framesOut);
  });
  ws.on('error', () => { /* close follows */ });
}

// Optional reaper for hosts that stay detached for a long time (off by default).
if (DETACHED_TTL_MS > 0) {
  setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (!s.closed && !s.ws && s.detachedAt && now - s.detachedAt > DETACHED_TTL_MS) {
        console.error('[zcode-webui] reaping host detached for ' + Math.round((now - s.detachedAt) / 1000) + 's pid=' + s.child.pid);
        terminateSession(s, 'detached ttl');
      }
    }
  }, 30000).unref();
}

// ---------- http server ----------
const server = http.createServer((req, res) => {
  // request logging (diagnostics)
  if (!req.url.startsWith('/assets/') && !req.url.startsWith('/material-icons/') && !req.url.startsWith('/pdfjs/')) {
    console.error('[http] ' + new Date().toISOString() + ' ' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress) + ' ' + req.method + ' ' + req.url + ' UA=' + String(req.headers['user-agent'] || '').slice(0, 80));
  }
  // browser identity cookie: lets a re-opened tab adopt the host it left running
  if (!parseCookies(req.headers.cookie)[CLIENT_COOKIE]) {
    res.setHeader('Set-Cookie', CLIENT_COOKIE + '=' + randomUUID() + '; Path=/; SameSite=Lax; HttpOnly; Max-Age=31536000');
  }
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (base) {
    if (urlPath === base) {
      res.writeHead(302, { Location: base + '/' });
      return res.end();
    }
    if (!urlPath.startsWith(base + '/')) return send(res, 404, 'not found (outside base path)');
    urlPath = urlPath.slice(base.length) || '/';
  }
  if (!urlPath.startsWith('/')) urlPath = '/' + urlPath;

  // api
  if (urlPath === '/api/health') {
    const all = [...sessions.values()];
    return sendJson(res, 200, {
      ok: true, name: 'zcode-webui', base,
      dataHome: PATHS.dataHome,
      rendererLoaded: existsSync(path.join(RENDERER_DIR, 'index.html')),
      serverRoot: serverRoot || null, workspace: WORKSPACE,
      login: loginState(),
      sessions: {
        total: all.length,
        attached: all.filter((s) => !s.closed && s.ws).length,
        detached: all.filter((s) => !s.closed && !s.ws).length,
      },
      httpRelays: httpRelays.size,
    });
  }
  if (urlPath === '/api/login/status') {
    return sendJson(res, 200, {
      ...loginState(),
      running: !!loginRun && loginRun.child.exitCode === null,
      url: loginRun ? loginRun.url() : null,
      output: loginRun ? loginRun.output() : loginLog,
    });
  }
  if (urlPath === '/api/login/start' && req.method === 'POST') {
    if (!serverRoot) return sendJson(res, 500, { ok: false, error: 'zcode server runtime not found' });
    if (loginRun && loginRun.child.exitCode === null) stopLogin(loginRun);
    loginLog = '';
    loginRun = startLogin({ serverRoot, oauthProxy: OAUTH_PROXY, log: (t) => { loginLog = (loginLog + t).slice(-8000); } });
    loginRun.child.on('exit', (code) => {
      loginLog += '[login] exited code=' + code + '\n';
    });
    return sendJson(res, 200, { ok: true, running: true });
  }
  if (urlPath === '/api/login/cancel' && req.method === 'POST') {
    stopLogin(loginRun);
    loginRun = null;
    return sendJson(res, 200, { ok: true });
  }

  // ---- HTTP fallback bridge (long-polling, works through any reverse proxy) ----
  if (urlPath === '/bridge/open' && req.method === 'POST') {
    return openHostPipe().then((pipe) => {
      const id = randomUUID();
      const entry = { pipe, queue: [], waiter: null, waiterTimer: null, lastSeen: Date.now() };
      pipe.onFrame = (payload) => {
        entry.lastSeen = Date.now();
        if (entry.waiter) {
          const w = entry.waiter;
          entry.waiter = null;
          clearTimeout(entry.waiterTimer);
          w(payload);
        } else {
          entry.queue.push(payload);
          if (entry.queue.length > 256) entry.queue.shift();
        }
      };
      pipe.onExit = () => {
        if (entry.waiter) {
          const w = entry.waiter;
          entry.waiter = null;
          clearTimeout(entry.waiterTimer);
          w(null);
        }
      };
      httpRelays.set(id, entry);
      console.error('[bridge] http session opened id=' + id + ' host=' + pipe.hello.version);
      sendJson(res, 200, { ok: true, id, hostVersion: pipe.hello.version });
    }).catch((err) => {
      console.error('[bridge] open failed: ' + err.message);
      sendJson(res, 500, { ok: false, error: err.message });
    });
  }
  if (urlPath === '/bridge/send' && req.method === 'POST') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const entry = httpRelays.get(id);
    if (!entry || entry.pipe.closed) return sendJson(res, 410, { ok: false, error: 'session gone' });
    entry.lastSeen = Date.now();
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const ok = entry.pipe.push(Buffer.concat(chunks));
      sendJson(res, ok ? 200 : 410, { ok });
    });
    return;
  }
  if (urlPath === '/bridge/poll' && req.method === 'GET') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const entry = httpRelays.get(id);
    if (!entry || entry.pipe.closed) return sendJson(res, 410, { ok: false, error: 'session gone' });
    entry.lastSeen = Date.now();
    const hdrs = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };
    const frames = entry.queue.splice(0, entry.queue.length);
    if (frames.length > 0) {
      const parts = frames.map((f) => {
        const h = Buffer.alloc(4);
        h.writeUInt32BE(f.length, 0);
        return Buffer.concat([h, f]);
      });
      res.writeHead(200, hdrs);
      return res.end(Buffer.concat(parts));
    }
    entry.waiter = (payload) => {
      res.writeHead(200, hdrs);
      if (payload) {
        const h = Buffer.alloc(4);
        h.writeUInt32BE(payload.length, 0);
        res.end(Buffer.concat([h, payload]));
      } else {
        res.end(Buffer.alloc(0));
      }
    };
    entry.waiterTimer = setTimeout(() => {
      if (entry.waiter) {
        const w = entry.waiter;
        entry.waiter = null;
        w(Buffer.alloc(0));
      }
    }, 25000).unref();
    return;
  }
  if (urlPath === '/bridge/close' && req.method === 'POST') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const entry = httpRelays.get(id);
    if (entry) {
      entry.pipe.close();
      httpRelays.delete(id);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (urlPath === '/api/sessions/terminate' && req.method === 'POST') {
    // ops endpoint: terminate every host session (attached + detached) immediately
    const n = sessions.size;
    for (const s of [...sessions.values()]) terminateSession(s, 'api terminate');
    for (const [, entry] of httpRelays) {
      try { entry.pipe.close(); } catch (_e) { /* ignore */ }
    }
    httpRelays.clear();
    return sendJson(res, 200, { ok: true, terminated: n });
  }

  // import credentials (e.g. exported from an already-logged-in ZCode desktop)
  if (urlPath === '/api/login/import' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 262144) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        const creds = j && j.credentials && typeof j.credentials === 'object' ? j.credentials : null;
        if (!creds) return sendJson(res, 400, { ok: false, error: 'missing credentials object' });
        if (!creds['oauth:zai:access_token'] && !creds.zaiAccessToken) {
          return sendJson(res, 400, { ok: false, error: 'no zai access token in credentials' });
        }
        const p = credentialsPath();
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
        console.error('[login] credentials imported to ' + p);
        sendJson(res, 200, { ok: true, ...loginState() });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e && e.message || e) });
      }
    });
    return;
  }

  // directory listing for the web directory picker
  if (urlPath === '/api/fs/list' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    let p = (q.get('path') || WORKSPACE || os.homedir()).trim();
    if (!p || !path.isAbsolute(p)) p = os.homedir();
    try {
      const entries = readdirSync(p, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
      sendJson(res, 200, { ok: true, path: p, parent: path.dirname(p), dirs });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
    }
    return;
  }

  // browser-side diagnostics: POST {href, message, stack}
  if (urlPath === '/api/log' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        console.error('[browser] ' + (j.href || '?') + ' | ' + j.kind + ' | ' + String(j.message || '').slice(0, 500));
        if (j.stack) console.error('[browser:stack] ' + String(j.stack).slice(0, 2000));
      } catch (_e) { console.error('[browser] (unparseable log body)'); }
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // webui injected assets
  if (urlPath.startsWith('/__zcode_webui/')) {
    const f = safeJoin(WEB_DIR, urlPath.slice('/__zcode_webui/'.length).split('?')[0]);
    return f ? serveFile(res, f) : send(res, 404, 'not found');
  }

  // login page
  if (urlPath === '/login') {
    const f = path.join(WEB_DIR, 'login.html');
    const html = existsSync(f) ? readFileSync(f, 'utf8') : '<h1>missing login.html</h1>';
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  // debug self-check page
  if (urlPath === '/debug') {
    const f = path.join(WEB_DIR, 'debug.html');
    const html = existsSync(f) ? readFileSync(f, 'utf8') : '<h1>missing debug.html</h1>';
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  // web directory picker (replaces the desktop-native folder dialog)
  if (urlPath === '/picker.html') {
    const f = path.join(WEB_DIR, 'picker.html');
    const html = existsSync(f) ? readFileSync(f, 'utf8') : '<h1>missing picker.html</h1>';
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  // desktop credentials export tool (runs entirely in the browser)
  if (urlPath === '/export-credentials.html') {
    const f = path.join(WEB_DIR, 'export-credentials.html');
    const html = existsSync(f) ? readFileSync(f, 'utf8') : '<h1>missing export-credentials.html</h1>';
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  // official renderer
  if (urlPath === '/' || urlPath === '/index.html') {
    const html = readRendererIndex();
    if (!html) return send(res, 503, 'renderer missing: run npm run fetch-renderer');
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  const f = safeJoin(RENDERER_DIR, urlPath.slice(1));
  return f ? serveFile(res, f) : send(res, 404, 'not found');
});

// ---------- websocket ----------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (base) {
    if (urlPath === base) urlPath = base + '/';
    if (!urlPath.startsWith(base + '/')) return socket.destroy();
    urlPath = urlPath.slice(base.length) || '/';
  }
  if (urlPath !== '/ws') return socket.destroy();
  const q = new URL(req.url, 'http://x').searchParams;
  const token = q.get('token');
  if (token !== WS_TOKEN) {
    console.error('[ws] rejected upgrade with bad/missing token from ' + req.socket.remoteAddress);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  // resolve the host session this connection should drive:
  // 1. same (client, tab) as an existing session          -> re-attach (page reload)
  // 2. ?takeover=1 with an active session for this client -> steal it (parked tab takes back over)
  // 3. a detached session of this client                  -> adopt it (tab reopened after close)
  // 4. otherwise                                          -> spawn a fresh host
  const clientKey = parseCookies(req.headers.cookie)[CLIENT_COOKIE] || '';
  const tabId = (q.get('tab') || '').slice(0, 128);
  const takeover = q.get('takeover') === '1';
  let session = sessions.get(sessionKey(clientKey, tabId));
  if (session && session.closed) session = null;
  if (!session && takeover && clientKey) {
    const actives = [...(clientSessions.get(clientKey) || [])].filter((s) => !s.closed && s.ws);
    if (actives.length) {
      session = actives[0];
      console.error('[zcode-webui] takeover: tab ' + tabId.slice(0, 8) + ' steals active host pid=' + session.child.pid);
      rebindSession(session, clientKey, tabId);
    }
  }
  if (!session && clientKey) {
    const detached = [...(clientSessions.get(clientKey) || [])]
      .filter((s) => !s.closed && !s.ws)
      .sort((a, b) => (b.detachedAt || 0) - (a.detachedAt || 0));
    if (detached.length) {
      session = detached[0];
      console.error('[zcode-webui] adopt detached host pid=' + session.child.pid + ' for tab ' + tabId.slice(0, 8));
      rebindSession(session, clientKey, tabId);
    }
  }
  if (!session) {
    try {
      session = createSession(clientKey, tabId);
    } catch (err) {
      console.error('[ws] host spawn failed: ' + err.message);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      return socket.destroy();
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, session);
  });
});
wss.on('connection', (ws, req, session) => {
  console.error('[ws] connected from ' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress) + ' UA=' + String(req.headers['user-agent'] || '').slice(0, 80));
  ws.send(WS_READY);
  attachRelay(ws, session);
});

// ---------- start ----------
server.listen(PORT, '0.0.0.0', () => {
  console.log('[zcode-webui] listening on http://0.0.0.0:' + PORT + base + '/');
  console.log('[zcode-webui] base path : ' + (base || '(root)'));
  console.log('[zcode-webui] data home : ' + PATHS.dataHome);
  console.log('[zcode-webui] workspace  : ' + WORKSPACE);
  console.log('[zcode-webui] serverRoot : ' + (serverRoot || '(missing)'));
  console.log('[zcode-webui] renderer   : ' + (existsSync(path.join(RENDERER_DIR, 'index.html')) ? 'ready' : 'MISSING (run: npm run fetch-renderer)'));
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
function shutdown() {
  console.log('[zcode-webui] shutting down');
  for (const s of [...sessions.values()]) {
    terminateSession(s, 'server shutdown');
  }
  for (const [, entry] of httpRelays) {
    try { entry.pipe.close(); } catch (_e) { /* ignore */ }
  }
  httpRelays.clear();
  stopLogin(loginRun);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
