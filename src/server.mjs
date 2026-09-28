// zcode-webui: serve the official ZCode desktop renderer in a browser, backed by the
// in-container zcode host service (zcode-server.cjs), bridged over WebSocket.
//
//   node src/server.mjs [--port 3102] [--base-path /proxy/3102] [--workspace /path]
//
// Env equivalents: ZCODE_WEBUI_PORT, ZCODE_WEBUI_BASE_PATH, ZCODE_WEBUI_WORKSPACE,
// ZCODE_WEBUI_OAUTH_PROXY, ZCODE_SERVER_RUNTIME_ROOT.

import http from 'node:http';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { encodeFrame, FrameParser } from './frame.mjs';
import { rpcLogLine, decodeRpcHeader, rewriteRpcId, encodeRpcHeader } from './rpclog.mjs';
import { interceptPinRpc, pinAckFor, errorAckFor } from './pin.mjs';
import { buildSetModeCall, normalizeBoostMode, scanCommandSessionId, scanTopicSessionId, INJECTED_ID_BASE } from './mode-boost.mjs';
import { spawnHost, handshake, resolveServerRoot, ensureCliProviderConfig } from './host.mjs';
import { LATEST_PAGE_URLS, parseVersionsFromPage, currentRendererVersion, currentServerAppVersion } from './upgrade.mjs';
import { startLogin, stopLogin, loginState, credentialsPath } from './login.mjs';
import { resolvePaths } from './dirs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PATHS = resolvePaths(ROOT);

let pkgVersion = '0.0.0';
try { pkgVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || pkgVersion; } catch (_e) { /* ignore */ }

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

const PORT = (() => {
  const n = Math.floor(Number(process.env.ZCODE_WEBUI_PORT || argValue('port', fileConfig.port) || 3102));
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? n : 3102;
})();
const WORKSPACE = process.env.ZCODE_WEBUI_WORKSPACE || argValue('workspace', fileConfig.workspace) || os.homedir();
// Bind address: loopback by default so the service is not silently LAN-exposed;
// open it up explicitly (config "host" / --host / ZCODE_WEBUI_HOST, e.g. "0.0.0.0")
// when a reverse proxy on another host needs to reach it.
const BIND_HOST = (() => {
  const h = process.env.ZCODE_WEBUI_HOST || argValue('host', fileConfig.host) || '127.0.0.1';
  return h === '*' ? '0.0.0.0' : h;
})();
// Optional shared-secret gate: when set (config "accessToken" /
// ZCODE_WEBUI_ACCESS_TOKEN / --access-token), every page/api/bridge/ws request
// must carry the cookie issued by the /access page. Empty = gate disabled.
const ACCESS_TOKEN = process.env.ZCODE_WEBUI_ACCESS_TOKEN || argValue('access-token', fileConfig.accessToken) || '';
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

// Cache-buster for the injected scripts: stable for the life of this process so
// browsers reuse them across reloads; a restart (code change) busts it naturally.
const ASSET_VERSION = '?v=' + Date.now().toString(36);

// ---------- client identity ----------
// A long-lived cookie identifies the browser (all tabs share it), a sessionStorage
// tab id identifies one tab across reloads. Together they let us re-attach a tab to
// the host process it was using before a reload / disconnect, so tasks keep running
// in the background instead of dying with the tab.
//
// Sessions are keyed by a stable USER key (derived from the shared ZCode
// credentials) instead of the cookie: the same account opening the WebUI from
// different browsers/devices sequentially reuses the same detached host instead
// of spawning a second one for the same session — which prevents one session
// being executed twice. The cookie remains the fallback when no credentials
// exist (per-browser, as before).
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

// ---------- optional access-token gate ----------
// When ACCESS_TOKEN is configured, the browser must exchange it for the
// zwebui_access cookie at /access first; everything else (pages, /api, /bridge,
// WS upgrades) is refused without it. The cookie stores sha256(token), so the
// raw secret never round-trips; it rotates whenever the operator changes the token.
const ACCESS_COOKIE = 'zwebui_access';
const accessCookieValue = ACCESS_TOKEN
  ? createHash('sha256').update('zcode-webui-access:' + ACCESS_TOKEN).digest('hex')
  : '';
function cookieMatches(value) {
  if (!ACCESS_TOKEN || typeof value !== 'string' || !value) return false;
  const a = Buffer.from(value, 'utf8');
  const b = Buffer.from(accessCookieValue, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
function tokenMatches(token) {
  if (!ACCESS_TOKEN || typeof token !== 'string' || !token) return false;
  return cookieMatches(createHash('sha256').update('zcode-webui-access:' + token).digest('hex'));
}
function hasAccess(req) {
  if (!ACCESS_TOKEN) return true;
  return cookieMatches(parseCookies(req.headers.cookie)[ACCESS_COOKIE] || '');
}
let accessFailures = 0;
function noteAccessFailure(req) {
  accessFailures++;
  if (accessFailures <= 5 || accessFailures % 50 === 0) {
    console.error('[http] access denied (' + (accessFailures <= 5 ? 'bad token' : 'bad token, ' + accessFailures + ' attempts so far') + ') from '
      + (req.headers['x-forwarded-for'] || req.socket.remoteAddress));
  }
}
function serveAccessPage(res) {
  const f = path.join(WEB_DIR, 'access.html');
  const html = existsSync(f) ? readFileSync(f, 'utf8') : '<h1>missing access.html</h1>';
  return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}

// stable per-account key (in-memory only, never logged in full; the account id
// itself stays out of logs by using a short hash)
// per-browser cache (a single global entry would cross-contaminate users)
const userKeyCache = new Map();   // clientKey -> { key, at }
function shortKey(k) { try { return createHash('sha256').update(k).digest('hex').slice(0, 8); } catch (_e) { return '?'; } }
function resolveUserKey(clientKey) {
  const now = Date.now();
  const cached = userKeyCache.get(clientKey);
  if (cached && now - cached.at < 30000) return cached.key;
  let key = '';
  try {
    const zhome = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
    const raw = JSON.parse(readFileSync(path.join(zhome, 'v2', 'credentials.json'), 'utf8'));
    for (const k of ['oauth:bigmodel:user_info', 'oauth:zai:user_info']) {
      if (!raw[k]) continue;
      let info = raw[k];
      if (typeof info === 'string') { try { info = JSON.parse(info); } catch (_e) { /* keep raw */ } }
      const id = (info && (info.id || info.sub || info.userId || info.user_id)) || (typeof info === 'string' ? info : '');
      if (id) { key = (k.indexOf('bigmodel') >= 0 ? 'bm:' : 'zai:') + String(id); break; }
    }
    if (!key && raw.zcodejwttoken) {
      key = 'jwt:' + createHash('sha256').update(String(raw.zcodejwttoken)).digest('hex').slice(0, 16);
    }
  } catch (_e) { /* ignore */ }
  if (!key) key = 'cookie:' + (clientKey || 'anon');
  if (process.env.ZCODE_WEBUI_DEBUG_RPC === '1') console.error('[userkey] client=' + (clientKey || 'none').slice(0, 8) + ' key=' + shortKey(key) + ' creds=' + (key.indexOf('cookie:') !== 0));
  userKeyCache.set(clientKey || 'anon', { key, at: now });
  if (userKeyCache.size > 256) {
    const cutoff = now - 30000;
    for (const [k, v] of userKeyCache) if (v.at < cutoff) userKeyCache.delete(k);
  }
  return key;
}
function shortUserKey(userKey) {
  return createHash('sha256').update(userKey).digest('hex').slice(0, 8);
}

// Detached hosts (tab closed) are kept alive so their tasks can finish. Auto-reap
// them ONLY when they are verifiably idle, guarded three ways so in-progress
// sessions (including ones waiting for user input) are never interrupted:
//   1. detached for at least ZCODE_WEBUI_DETACHED_TTL_MS (default 30 min; 0 = never)
//   2. no host->client frames for at least ZCODE_WEBUI_FRAME_QUIET_MS (default 10 min;
//      idle hosts are silent, working turns stream frames)
//   3. no task marked "running" in the official tasks index (updated within the
//      staleness window, default 2 h) — a global guard that also protects hosts
//      parked in a wait-for-user-input state
const DETACHED_TTL_MS = process.env.ZCODE_WEBUI_DETACHED_TTL_MS === undefined
  ? 30 * 60 * 1000
  : Number(process.env.ZCODE_WEBUI_DETACHED_TTL_MS) || 0;
const FRAME_QUIET_MS = Number(process.env.ZCODE_WEBUI_FRAME_QUIET_MS || 10 * 60 * 1000);
const RUNNING_TASK_STALE_MS = Number(process.env.ZCODE_WEBUI_RUNNING_TASK_STALE_MS || 2 * 60 * 60 * 1000);
// "a sibling host is actively driving turns" heuristic: protocol frames flowing
// this recently mean the agent is mid-execution (streaming, tool calls, thinking)
const ACTIVE_FRAME_MS = Math.max(Number(process.env.ZCODE_WEBUI_ACTIVE_FRAME_MS) || 120000, 15000);
// HTTP fallback bridge relays: bounded + idle-reaped. lastSeen is refreshed by
// /bridge/send and /bridge/poll, so an actively polling page never ages out.
const HTTP_RELAY_TTL_MS = Number(process.env.ZCODE_WEBUI_HTTP_RELAY_TTL_MS || 30 * 60 * 1000);
const HTTP_RELAY_MAX = Number(process.env.ZCODE_WEBUI_HTTP_RELAY_MAX || 8) || 0;   // 0 = unlimited
// upper bound for one /bridge/send body — legit RPC frames are far smaller, and
// without a cap a rogue client could buffer unbounded memory server-side
const BRIDGE_MAX_BODY_BYTES = Math.max(1, Number(process.env.ZCODE_WEBUI_BRIDGE_MAX_BODY_MB) || 32) * 1024 * 1024;

// ws keepalive leniency: ping every WS_PING_MS and terminate only after
// WS_PING_MAX_MISS consecutive unanswered pings. One missed pong used to be
// enough to kill the socket — a desktop browser tab parked in the background
// (timer/network throttling through proxies) regularly trips that within a
// minute, so the default now tolerates two misses (~60–90s) before detaching.
const WS_PING_MS = Math.max(5000, Number(process.env.ZCODE_WEBUI_WS_PING_MS) || 30000);
const WS_PING_MAX_MISS = Math.max(1, Number(process.env.ZCODE_WEBUI_WS_PING_MAX_MISS) || 2);

// Offline-gap replay: while a tab's renderer era is parked (socket gone, page
// still alive in the background), downstream frames destined to it — task-list
// events, call responses — are buffered per era and replayed when that tab
// hot-resumes, so the session list does not silently go stale ("had to refresh
// to see new sessions"). Bounded; an overflowed gap forces a page reload on the
// next resume instead of replaying a hole. Parking older than RESUME_PARK_MS
// disposes the era's host-side subscriptions (also fixes a slow leak of ghost
// event listeners for tabs that never return). 0 disables buffering entirely.
const RESUME_PARK_MS = Number(process.env.ZCODE_WEBUI_RESUME_PARK_MS) === 0
  ? 0
  : Math.max(30 * 1000, Number(process.env.ZCODE_WEBUI_RESUME_PARK_MS) || 10 * 60 * 1000);
const RESUME_BUF_MAX_BYTES = Math.max(64 * 1024, Number(process.env.ZCODE_WEBUI_RESUME_BUF_MAX_MB) || 16) * 1024 * 1024;
const RESUME_BUF_MAX_FRAMES = Math.max(16, Number(process.env.ZCODE_WEBUI_RESUME_BUF_MAX_FRAMES) || 2048);

function tasksIndexPath() {
  const zhome = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
  return path.join(zhome, 'v2', 'tasks-index.sqlite');
}

let sqliteWarningShown = false;
async function hasRunningTask(dbPath) {
  // true when the index says a task is running, or when the index cannot be read
  // (fail-safe: never reap when in doubt)
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE task_status = 'running' AND updated_at > ?"
      ).get(Date.now() - RUNNING_TASK_STALE_MS);
      return (row && row.n) > 0;
    } finally { db.close(); }
  } catch (_e) {
    if (!sqliteWarningShown) {
      sqliteWarningShown = true;
      console.error('[zcode-webui] auto-reap: cannot read tasks index (' + ((_e && _e.message) || _e) + '); reaping disabled (safe mode)');
    }
    return true;
  }
}

// Worktrees/workspace directories get deleted all the time (git worktree prune,
// rm -rf). The official zcode-server treats a missing workspace cwd as a fatal
// agent-spawn error and exits code=1, which drops the host and makes the page
// show "reconnecting". Prevent that by materializing any workspace directory
// referenced by zcode's own settings / task index / session db before spawning
// a host. We only create directories under the home directory.
async function ensureWorkspaceDirs() {
  const zhome = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
  const home = os.homedir();
  const seen = new Set();
  const add = (p) => {
    if (!p || typeof p !== 'string') return;
    let abs;
    try { abs = path.resolve(p); } catch (_e) { return; }
    if (abs !== home && !abs.startsWith(home + path.sep)) return;
    seen.add(abs);
  };

  try {
    const sf = path.join(zhome, 'v2', 'setting.json');
    if (existsSync(sf)) {
      const s = JSON.parse(readFileSync(sf, 'utf8'));
      for (const p of (s && s.recentProjects) || []) add(p);
      for (const e of (s && s.lastWorkspaceSession) || []) add(e && e.workspacePath);
    }
  } catch (_e) { /* ignore */ }

  const readDb = async (dbPath, sql) => {
    if (!existsSync(dbPath)) return;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare(sql).all();
        for (const r of rows) add(r.workspace_path || r.directory || r.p);
      } finally { db.close(); }
    } catch (_e) { /* ignore */ }
  };
  await readDb(path.join(zhome, 'v2', 'tasks-index.sqlite'),
    "SELECT DISTINCT workspace_path FROM tasks WHERE workspace_path IS NOT NULL" +
    " UNION SELECT DISTINCT workspace_path FROM off_peak_tasks WHERE workspace_path IS NOT NULL" +
    " UNION SELECT DISTINCT workspace_path FROM task_group_members WHERE workspace_path IS NOT NULL");
  await readDb(path.join(zhome, 'cli', 'db', 'db.sqlite'),
    "SELECT directory AS p FROM session WHERE directory IS NOT NULL" +
    " UNION SELECT path AS p FROM session WHERE path IS NOT NULL");

  for (const dir of seen) {
    if (existsSync(dir)) continue;
    try {
      mkdirSync(dir, { recursive: true });
      console.error('[zcode-webui] created missing workspace dir ' + dir);
    } catch (e) {
      console.error('[zcode-webui] cannot create missing workspace dir ' + dir + ': ' + e.message);
    }
  }
}

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
  '.wasm': 'application/wasm', '.webp': 'image/webp', '.avif': 'image/avif',
  '.csv': 'text/csv; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
// %zz and other malformed escapes must not take the process down
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (_e) { return s; }
}
function safeJoin(dir, rel) {
  const p = path.normalize(path.join(dir, rel));
  if (!p.startsWith(dir + path.sep) && p !== dir) return null;
  return p;
}
// Content-hashed renderer directories: filenames change on every upgrade, so they
// are safe to cache immutably — this is what keeps reloads from re-downloading the
// ~60MB renderer on every page load. Everything else revalidates via ETag (304).
const IMMUTABLE_PATH_PREFIXES = ['/assets/', '/material-icons/', '/pdfjs/'];
function serveFile(req, res, filePath, urlPath) {
  let st;
  try { st = statSync(filePath); } catch (_e) { return send(res, 404, 'not found'); }
  if (!st.isFile()) return send(res, 404, 'not found');
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const headers = {
    'Content-Type': mime,
    'Content-Length': String(st.size),
  };
  if (urlPath && IMMUTABLE_PATH_PREFIXES.some((p) => urlPath.startsWith(p))) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'no-cache';
    const etag = '"' + st.size.toString(16) + '-' + st.mtimeMs.toString(16) + '"';
    headers['ETag'] = etag;
    if (req && String(req.headers['if-none-match'] || '') === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
  }
  res.writeHead(200, headers);
  const stream = createReadStream(filePath);
  stream.on('error', () => { try { res.destroy(); } catch (_e) { /* ignore */ } });
  stream.pipe(res);
}

// ---------- index.html transform ----------
function readRendererIndex() {
  const p = path.join(RENDERER_DIR, 'index.html');
  if (!existsSync(p)) return null;
  let html = readFileSync(p, 'utf8');
  // NOTE: injected script srcs are RELATIVE (./__zcode_webui/...) so they resolve
  // under whatever public prefix the reverse proxy uses (code-server strips
  // /proxy/<port> before forwarding; absolute paths would escape the prefix).
  const assetVersion = ASSET_VERSION;
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
    // The deployed official renderer version. web/bootstrap.js needs it to pick the
    // right service-port handshake: >= 3.12 switches to an object message plus the
    // 'zcode:database-startup-state' startup channel, 3.11 and older take the bare
    // 'zcode:service-port' string.
    rendererVersion: currentRendererVersion(RENDERER_DIR),
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

// ---------- process monitor (official renderer page, fed from /proc) ----------
// The desktop app opens process-monitor.html in its own window; its preload
// exposes window.processMonitor.getProcessMetrics() backed by Electron's
// app.getAppMetrics(). The page itself is pure renderer, so we serve it
// unchanged and inject a shim (web/process-monitor-bridge.js) that pulls the
// same tree from /api/process-metrics. The tree is rooted at THIS server
// process and includes every descendant — the zcode host, agent sessions and
// the tools they spawn. Node shape must match what the page renders:
// {name, pid, cpu (percent), memory (KB), children[]}.
const PROC_CLK_TCK = 100;        // Linux USER_HZ: jiffies in /proc/<pid>/stat
const PROC_SAMPLE_CACHE_MS = 400; // several open tabs polling at 1s share one sample
let procLastSnapshot = null;     // {ts, tree}
const procCpuSamples = new Map(); // pid -> {jiffies, ts, start} ('start' guards pid reuse)

function readPidStat(pid) {
  let raw;
  try { raw = readFileSync('/proc/' + pid + '/stat', 'utf8'); } catch (_e) { return null; }
  // comm is wrapped in parens and may contain spaces or ')' itself — split on the LAST ')'
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 1 || close <= open) return null;
  const f = raw.slice(close + 2).split(' ');
  // f[0]=state(3) f[1]=ppid(4) ... f[11]=utime(14) f[12]=stime(15) f[19]=starttime(22)
  if (f.length < 20) return null;
  return { comm: raw.slice(open + 1, close), ppid: Number(f[1]), jiffies: Number(f[11]) + Number(f[12]), start: f[19] };
}

function readPidName(pid, fallback) {
  let raw;
  try { raw = readFileSync('/proc/' + pid + '/cmdline', 'utf8'); } catch (_e) { return fallback; }
  const argv = raw.split('\0').filter(Boolean);
  if (!argv.length) return fallback;
  let name = path.basename(argv[0]);
  // "node /…/zcode-server.cjs" reads better as "node zcode-server.cjs"
  if (/^node(\.exe)?$/.test(name) && argv[1]) name += ' ' + path.basename(argv[1]);
  return name.slice(0, 80) || fallback;
}

function readPidRssKb(pid) {
  let raw;
  try { raw = readFileSync('/proc/' + pid + '/status', 'utf8'); } catch (_e) { return 0; }
  const m = raw.match(/^VmRSS:\s+(\d+)\s+kB/m);
  return m ? Number(m[1]) : 0;
}

function processMetricsTree() {
  const now = Date.now();
  if (procLastSnapshot && now - procLastSnapshot.ts < PROC_SAMPLE_CACHE_MS) return procLastSnapshot.tree;
  let tree;
  if (process.platform === 'linux') {
    // one /proc sweep for stat (cheap), then cmdline/status only for our subtree
    const stats = new Map();
    let pids;
    try { pids = readdirSync('/proc').filter((s) => /^\d+$/.test(s)); } catch (_e) { pids = []; }
    for (const pidStr of pids) {
      const st = readPidStat(pidStr);
      if (st) stats.set(Number(pidStr), st);
    }
    const byPpid = new Map();
    for (const [pid, st] of stats) {
      if (!byPpid.has(st.ppid)) byPpid.set(st.ppid, []);
      byPpid.get(st.ppid).push(pid);
    }
    const build = (pid) => {
      const st = stats.get(pid);
      if (!st) return null;
      const prev = procCpuSamples.get(pid);
      let cpu = 0;
      if (prev && prev.start === st.start && now > prev.ts) {
        const dJ = st.jiffies - prev.jiffies;
        if (dJ >= 0) cpu = Math.max(0, (dJ / PROC_CLK_TCK) / ((now - prev.ts) / 1000) * 100);
      }
      procCpuSamples.set(pid, { jiffies: st.jiffies, ts: now, start: st.start });
      return {
        name: pid === process.pid ? 'zcode-webui' : readPidName(String(pid), st.comm),
        pid,
        cpu: Math.round(cpu * 10) / 10,
        memory: readPidRssKb(String(pid)),
        children: (byPpid.get(pid) || []).map(build).filter(Boolean),
      };
    };
    tree = build(process.pid);
    for (const pid of procCpuSamples.keys()) if (!stats.has(pid)) procCpuSamples.delete(pid);
  } else {
    // no /proc to walk (darwin/win32): report this process only
    const usage = process.cpuUsage();
    const totalUs = usage.user + usage.system;
    const prev = procCpuSamples.get(process.pid);
    let cpu = 0;
    if (prev && now > prev.ts) cpu = Math.max(0, (totalUs - prev.jiffies) / 1000 / ((now - prev.ts) / 1000) * 100);
    procCpuSamples.set(process.pid, { jiffies: totalUs, ts: now, start: '' });
    tree = {
      name: 'zcode-webui', pid: process.pid,
      cpu: Math.round(cpu * 10) / 10,
      memory: Math.round(process.memoryUsage().rss / 1024),
      children: [],
    };
  }
  procLastSnapshot = { ts: now, tree };
  return tree;
}

// same injection strategy as readRendererIndex, minus the zcode bridge: the
// process-monitor page never touches window.zcode, it only needs the metrics shim.
function readProcessMonitorPage() {
  const p = path.join(RENDERER_DIR, 'process-monitor.html');
  if (!existsSync(p)) return null;
  let html = readFileSync(p, 'utf8');
  const shim = '<script src="./__zcode_webui/process-monitor-bridge.js' + ASSET_VERSION + '"></script>';
  const metaViewport = '<meta name="viewport" content="width=device-width, initial-scale=1.0" />';
  if (html.includes(metaViewport)) {
    html = html.replace(metaViewport, metaViewport + shim);
  } else {
    html = html.replace(/<head([^>]*)>/i, (m, attrs) => '<head' + attrs + '>' + shim);
  }
  return html;
}

// ---------- update check (Help menu → 检查更新) ----------
// Compares the DEPLOYED official components (vendor/renderer + ~/.zcode/server)
// against the version published on the official ZCode pages — i.e. exactly
// what `zcode-webui upgrade` would download, unpack and deploy. Not related to
// the webui package's own npm/git version. Uses native fetch (NOT the
// readRemoteText helper in upgrade.mjs — that one shells out to curl via
// spawnSync, which would block the server's event loop and stall live
// sessions). Result is cached so menu re-opens don't refetch the pages.
const UPDATE_CHECK_CACHE_MS = 5 * 60 * 1000;
let updateCheckCache = null; // {ts, result}

function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// deployed official-component versions; null when missing/not installed
function deployedComponentVersions() {
  const renderer = currentRendererVersion(RENDERER_DIR);
  let server = null;
  try { server = serverRoot ? currentServerAppVersion(serverRoot) : null; } catch (_e) { /* ignore */ }
  return { renderer, server };
}

async function fetchOfficialLatest() {
  let lastErr = null;
  for (const url of LATEST_PAGE_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status + ' ' + url); continue; }
      const html = await res.text();
      let best = null;
      for (const v of parseVersionsFromPage(html)) {
        if (!best || semverGt(v, best)) best = v;
      }
      if (best) return { version: best, source: url };
      lastErr = new Error('no version found in page ' + url);
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('official pages unreachable');
}

function officialUpdateState() {
  const { renderer, server } = deployedComponentVersions();
  const current = renderer && server
    ? (semverGt(renderer, server) ? renderer : server)
    : (renderer || server || null);
  return fetchOfficialLatest().then(({ version, source }) => {
    const result = {
      current, latest: version, source,
      rendererVersion: renderer,
      serverVersion: server,
      hasUpdate: (renderer ? semverGt(version, renderer) : true) || (server ? semverGt(version, server) : true),
    };
    updateCheckCache = { ts: Date.now(), result };
    return result;
  }).catch((err) => {
    const result = {
      current, latest: null,
      rendererVersion: renderer,
      serverVersion: server,
      hasUpdate: false,
      error: String((err && err.message) || err),
    };
    updateCheckCache = { ts: Date.now(), result };
    return result;
  });
}

// ---------- guard observability ----------
// The api-cache-guard runs inside every HOST process (preload), not here, so it
// reports its stats through a small JSON file the server reads on demand.
function guardStatsSnapshot() {
  try {
    const j = JSON.parse(readFileSync(path.join(PATHS.dataHome, 'data', 'guard-stats', 'api-cache-guard.json'), 'utf8'));
    return { hits: j.hits || 0, misses: j.misses || 0, coalesced: j.coalesced || 0, backoffSkips: j.backoffSkips || 0, errors: j.errors || 0, at: j.at || null, pid: j.pid || null };
  } catch (_e) { return null; }
}

// quota-reset-guard state (chances seen, pool usage, signals, last decision,
// uses today) — written by the HOST process, read here for observability.
// `pools` is what the guard actually believed; a stale/absent pool entry there
// is the first thing to look at when a reset "should" have fired but did not.
const poolSnapshot = (b) => (!b ? null : {
  usedPct: typeof b.usedRatio === 'number' ? Math.round(b.usedRatio * 1000) / 10 : null,
  remaining: b.remaining ?? null, total: b.total ?? null,
  naturalResetAt: b.expiresAt ?? null, src: b.src || null, at: b.at ?? null,
});
// quota-reset runtime switch (the ♻ chip in the boost panel): a tiny JSON file
// in the shared guard-stats dir. The guard preloaded into every host process
// re-reads it within ~10s, so a flip reaches running hosts without a respawn.
// The file outranks the env baseline (ZCODE_WEBUI_QUOTA_RESET, default off).
const QUOTA_RESET_SWITCH_FILE = path.join(PATHS.dataHome, 'data', 'guard-stats', 'quota-reset-switch.json');
const QUOTA_RESET_MODES = new Set(['on', 'dry-run', 'off']);
function quotaResetSwitchState() {
  try {
    const j = JSON.parse(readFileSync(QUOTA_RESET_SWITCH_FILE, 'utf8'));
    const m = typeof j.mode === 'string' ? j.mode.trim().toLowerCase() : '';
    if (QUOTA_RESET_MODES.has(m)) return { mode: m, at: j.at || null, source: 'switch' };
  } catch (_e) { /* not written yet / unreadable → fall back to the env baseline */ }
  const env = (process.env.ZCODE_WEBUI_QUOTA_RESET || '').trim().toLowerCase();
  return QUOTA_RESET_MODES.has(env)
    ? { mode: env, at: null, source: 'env' }
    : { mode: 'off', at: null, source: 'default' };
}

function quotaResetSnapshot() {
  try {
    const j = JSON.parse(readFileSync(path.join(PATHS.dataHome, 'data', 'guard-stats', 'quota-reset-guard.json'), 'utf8'));
    return {
      mode: j.mode || null, at: j.at || null,
      switch: quotaResetSwitchState(),
      chances: {
        fiveHour: j.status ? (j.status.fiveHourResets || []).length : null,
        week: j.status ? (j.status.weekResets || []).length : null,
        statusAt: j.status ? j.status.at : null,
      },
      busy: typeof j.busy === 'boolean' ? j.busy : null,
      pools: {
        fiveHour: poolSnapshot(j.buckets && j.buckets.FIVE_HOUR),
        week: poolSnapshot(j.buckets && j.buckets.WEEK),
        at: (j.buckets && j.buckets.at) || null,
      },
      signals: j.exhaustion ? { at: j.exhaustion.at || 0, byType: j.exhaustion.byType || null, last: j.exhaustion.last || null } : null,
      stats: j.stats || null,
      usesToday: j.usesToday ?? null, lastUsedAt: j.lastUsedAt || null, lastUsedType: j.lastUsedType || null,
      confirmed: typeof j.confirmed === 'boolean' ? j.confirmed : null,
      lastDecision: j.lastDecision || null,
    };
  } catch (_e) { return null; }
}

// ---------- log export (Help menu → 导出日志) ----------
// Plain-text bundle: service snapshot + process tree + the service log tail.
// The browser side turns this into a downloaded file; the renderer's own toast
// flow just needs window.zcode.exportLogs() to resolve {success}.
function logExportBody() {
  const lines = [];
  lines.push('==== zcode-webui log export ====');
  lines.push('exportedAt: ' + new Date().toISOString());
  lines.push('');
  lines.push('==== service ====');
  lines.push('version: ' + pkgVersion);
  lines.push('node: ' + process.version + ' (' + process.platform + ' ' + process.arch + ')');
  lines.push('pid: ' + process.pid + '  uptime: ' + Math.round(process.uptime()) + 's');
  lines.push('workspace: ' + WORKSPACE);
  lines.push('serverRoot: ' + (serverRoot || '(unresolved)'));
  lines.push('dataHome: ' + PATHS.dataHome);
  const live = [...sessions.values()].filter((s) => !s.closed);
  lines.push('host sessions: ' + live.length + ' (views: ' + live.reduce((n, s) => n + s.views.size, 0) + ', http relays: ' + httpRelays.size + ')');
  const withHello = live.find((s) => s.hello);
  if (withHello) lines.push('hostVersion: ' + (withHello.hello.version || '?'));
  lines.push('');
  lines.push('==== process tree ====');
  const walk = (n, depth) => {
    lines.push('  '.repeat(depth) + n.pid + '  ' + n.cpu.toFixed(1) + '%  ' + (n.memory / 1024).toFixed(1) + 'MB  ' + n.name);
    for (const c of n.children || []) walk(c, depth + 1);
  };
  try { walk(processMetricsTree(), 0); } catch (_e) { lines.push('(unavailable)'); }
  lines.push('');
  lines.push('==== service log tail (zcode-webui.log, last 256 KiB) ====');
  const logPath = path.join(ROOT, 'zcode-webui.log');
  try {
    const st = statSync(logPath);
    const start = Math.max(0, st.size - 256 * 1024);
    const fh = openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      readSync(fh, buf, 0, buf.length, start);
      lines.push(start > 0 ? '(…truncated ' + start + ' bytes…)' : '');
      lines.push(buf.toString('utf8'));
    } finally { closeSync(fh); }
  } catch (e) {
    lines.push('(log file unreadable: ' + (e && e.message) + ')');
  }
  return lines.join('\n');
}

// ---------- login ----------
let loginRun = null; // {child, url(), output()}
let loginLog = '';

// ---------- host pipe (shared by WS transport and HTTP fallback transport) ----------
// Outbound proxy for host/agent cloud calls. BOTH transports must pass it: the
// session path (createSession) originally forgot it, so only HTTP-relay hosts
// honored config.hostProxy while every WS-spawned host went direct.
function hostExtraEnv() {
  return HOST_PROXY
    ? { ZCODE_HTTP_PROXY: HOST_PROXY, ZCODE_NO_PROXY: 'localhost,127.0.0.1' }
    : {};
}
async function openHostPipe() {
  await ensureWorkspaceDirs();
  const extraEnv = hostExtraEnv();
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

// ---------- host sessions (multi-device live view) ----------
// ONE host process per ACCOUNT (userKey). Every browser tab/device attaches as
// a VIEW of that session:
//   - the mux translates every view's renderer-local RPC ids (calls AND event
//     subscriptions) into a session-global space, because the host sees one
//     client while each fresh renderer restarts counting at 0;
//   - responses (201/202/203) and event fires (204) are routed to the view
//     that owns the id, so views never cross-contaminate;
//   - a session with zero views parks detached and keeps running its turns
//     (the reaper cleans idle ones); the first view to (re)attach adopts it.
const sessions = new Map();       // userKey -> session
const pendingSpawns = new Map();  // userKey -> Promise<session>: concurrent first-connects
                                  // coalesce onto ONE host instead of racing to spawn two
                                  // (the loser used to be overwritten in `sessions` and
                                  // became a host the reaper could never see again)
const httpRelays = new Map();     // id -> {pipe, queue, waiter, waiterTimer, lastSeen} (HTTP long-poll fallback)

// hand one server-synthesised payload to the next /bridge/poll of a relay,
// mirroring what pipe.onFrame does for host frames
function queueRelayFrame(entry, payload) {
  if (entry.waiter) {
    const w = entry.waiter;
    entry.waiter = null;
    clearTimeout(entry.waiterTimer);
    w(payload);
  } else {
    entry.queue.push(payload);
    if (entry.queue.length > 256) entry.queue.shift();
  }
}

function rpcLogOut(payload) {
  const l = rpcLogLine('RPC-out', payload);
  if (l) console.error('[rpc] ' + l);
}
function rpcLogIn(payload) {
  const l = rpcLogLine('RPC-in ', payload);
  if (l) console.error('[rpc] ' + l);
}

// One mux per session. The host sees exactly ONE client, but every fresh
// renderer restarts its request-id counter at 0 — without translation, the
// identical small ids from different views/eras alias inside the host (a
// renderer can even receive an event fired for a DIFFERENT subscription,
// crashing its handler). `pending` tracks calls awaiting a response, `events`
// tracks live host-side event subscriptions; both keyed by global id.
function makeMux() {
  return { next: 0x10000, pending: new Map(), events: new Map(), dropped: 0 };
}

// Pin is broken in the official renderer: a pinned session is moved into the
// "已置顶" group, which this web shell does not render next to the workspace
// list, so one stray click on the hover-only pin icon makes the session vanish
// from the task list. Pinning calls are answered with a synthetic success so the
// host-side pinned flag never flips; un-pin calls still go through, so a session
// that is pinned anyway can be restored from the UI. The guard lives in
// src/pin.mjs and is applied on BOTH transports — the WS path below and the
// HTTP long-poll relay (/bridge/send), which pushes straight into its own host
// pipe and would otherwise bypass this function.
function writeToHost(session, view, payload) {
  if (session.closed) return false;
  session.framesIn++;
  // protect the host: only forward payloads that look like serialized channel
  // messages (first byte is an RPC preset 0..6); drop flow-control JSON etc.
  if (!payload || payload.length === 0 || payload[0] > 6) {
    console.error('[bridge] dropped non-protocol inbound payload ' + payload.length + 'B first=' + (payload[0] ?? 'nil'));
    return true;
  }
  if (process.env.ZCODE_WEBUI_DEBUG_RPC === '1') rpcLogIn(payload);
  // mode-boost bookkeeping: remember which conversation the renderer is
  // actively driving (every v4 conversation command carries a sessionId) so a
  // mode push has the right target even mid-turn
  {
    const cmdSid = scanCommandSessionId(payload);
    if (cmdSid) session.activeConvSession = cmdSid;
  }
  {
    const pinnedCall = interceptPinRpc(payload);
    if (pinnedCall) {
      const ackId = session.mux ? ++session.mux.next : pinnedCall.id;
      const ack = pinAckFor(pinnedCall, ackId);
      console.error('[bridge] pin no-op (ws) id=' + pinnedCall.id + ' — acked without forwarding');
      if (session.mux) sendToView(session, { view, origId: pinnedCall.id }, { id: ackId }, ack);
      else if (view.ws && view.ws.readyState === 1) {
        try { view.ws.send(ack, { binary: true }); } catch (_e) { /* ignore */ }
      }
      return true;
    }
  }
  // mux: translate this view's renderer-local ids into the global space
  if (session.mux) {
    const hdr = decodeRpcHeader(payload);
    // A frame whose id cannot be rewritten is DROPPED, never forwarded raw:
    // an unrewritten local id would bypass the mux and alias inside the host.
    if (hdr && hdr.type === 100) {
      // call: remember ownership so the response can be routed back
      const gid = ++session.mux.next;
      const rewritten = rewriteRpcId(payload, gid);
      if (!rewritten) { session.mux.dropped++; return true; }
      view.sent.add(gid);
      session.mux.pending.set(gid, { view, origId: hdr.id, at: Date.now() });
      payload = rewritten;
    } else if (hdr && hdr.type === 101) {
      // cancel: renderer refers to its original id — find the global twin
      let gid = null;
      for (const [g, e] of session.mux.pending) if (e.view === view && e.origId === hdr.id) { gid = g; break; }
      if (gid === null) return true;                        // cancel for a dead era
      const rewritten = rewriteRpcId(payload, gid);
      if (!rewritten) { session.mux.dropped++; return true; }
      payload = rewritten;
    } else if (hdr && hdr.type === 102) {
      // event subscribe: same aliasing hazard as calls — map (view, localId) to
      // a global id, reusing the mapping if this exact subscription re-attaches
      let gid = null;
      for (const [g, e] of session.mux.events) if (e.view === view && e.origId === hdr.id) { gid = g; break; }
      if (gid === null) gid = ++session.mux.next;
      const rewritten = rewriteRpcId(payload, gid);
      if (!rewritten) { session.mux.dropped++; return true; }
      session.mux.events.set(gid, { view, origId: hdr.id });
      payload = rewritten;
    } else if (hdr && hdr.type === 103) {
      // event dispose: forward only when WE hold the mapping. A stale dispose
      // from a dead renderer era must be swallowed — forwarded raw it would
      // unsubscribe whatever other view now owns that same local id.
      let gid = null;
      for (const [g, e] of session.mux.events) if (e.view === view && e.origId === hdr.id) { gid = g; break; }
      if (gid === null) return true;
      const rewritten = rewriteRpcId(payload, gid);
      if (!rewritten) { session.mux.dropped++; return true; }
      session.mux.events.delete(gid);
      payload = rewritten;
    }
  }
  try { session.child.stdin.write(encodeFrame(payload)); return true; } catch (_e) { return false; }
}

function removeSession(session) {
  session.closed = true;
  sessions.delete(session.userKey);
}

// Push a collaboration-mode change for one conversation straight to the host,
// shaped exactly like a renderer call (see src/mode-boost.mjs for why the
// official dropdown cannot do this mid-turn). Returns the global id used, or
// null when the host pipe is gone.
function injectModeBoost(session, taskId, mode) {
  if (!session || session.closed || !session.mux || !session.child || session.child.exitCode !== null) return null;
  const gid = INJECTED_ID_BASE + (++session.injectedNext);
  session.mux.pending.set(gid, { view: null, origId: gid, at: Date.now(), injected: true });
  try {
    session.child.stdin.write(encodeFrame(buildSetModeCall(gid, taskId, mode)));
  } catch (_e) {
    session.mux.pending.delete(gid);
    return null;
  }
  console.error('[mode-boost] pushed mode=' + mode + ' task=' + taskId + ' (gid=' + gid + ')');
  return gid;
}

// Per-view snapshot for observability endpoints
function viewsSnapshot(session, exceptTab) {
  const now = Date.now();
  const out = [];
  for (const [tabId, v] of session.views) {
    if (exceptTab && tabId === exceptTab) continue;
    const age = v.lastFrameAt ? now - v.lastFrameAt : Infinity;
    out.push({ tabId: tabId.slice(0, 8), attached: true, lastFrameAgeSec: Number.isFinite(age) ? Math.round(age / 1000) : null, active: age < ACTIVE_FRAME_MS });
  }
  return { activeCount: out.filter((x) => x.active).length, hosts: out };
}

function terminateSession(session, reason) {
  if (!session || session.closed) return;
  session.closed = true;
  for (const [, v] of session.views) {
    try { v.ws.close(1011, 'host terminated'); } catch (_e) { /* ignore */ }
  }
  session.views.clear();
  const child = session.child;
  if (child && child.exitCode === null) {
    console.error('[zcode-webui] terminating host pid=' + child.pid + ' reason=' + reason);
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
  }
  sessions.delete(session.userKey);
}

// Deliver one downstream frame: responses (201/202/203) and event fires (204)
// go to the view that owns the id, host Initialize (200) and undecodable frames
// broadcast to every view.
function routeDownstream(session, payload) {
  const hdr = session.mux ? decodeRpcHeader(payload) : null;
  // mode-boost bookkeeping: the host streams conversation topic frames for
  // the active dialogue — a fallback target for a mode push
  {
    const topicSid = scanTopicSessionId(payload);
    if (topicSid) session.lastTopicSession = topicSid;
  }
  if (hdr && (hdr.type === 201 || hdr.type === 202 || hdr.type === 203)) {
    const entry = session.mux.pending.get(hdr.id);
    if (!entry) {
      session.mux.dropped++;
      if (session.mux.dropped <= 5 || session.mux.dropped % 50 === 0) {
        console.error('[mux] dropped stale response globalId=' + hdr.id +
          ' (' + hdr.channel + '.' + hdr.method + ') owner gone, total=' + session.mux.dropped);
      }
      return;
    }
    session.mux.pending.delete(hdr.id);
    // responses to calls this server injected itself (mode-boost): log the
    // ack and stop — there is no view to route them to
    if (entry.injected) {
      const ok = hdr.type === 201;
      console.error('[mode-boost] host ' + (ok ? 'acked' : 'rejected') + ' ' + hdr.channel + '.' + hdr.method +
        ' globalId=' + hdr.id + ' bodyBytes=' + payload.length);
      return;
    }
    entry.view.sent.delete(hdr.id);
    sendToView(session, entry, hdr, payload);
    return;
  }
  if (hdr && hdr.type === 204) {
    // event fire: unicast to the subscribing view with its local id restored.
    // Broadcasting raw would deliver host-global ids other views never
    // registered — and those collide with local handler ids (crash class:
    // "Cannot read properties of undefined (reading 'revision')").
    const entry = session.mux.events.get(hdr.id);
    if (!entry) {
      session.mux.dropped++;
      if (session.mux.dropped <= 5 || session.mux.dropped % 50 === 0) {
        console.error('[mux] dropped event globalId=' + hdr.id +
          ' (' + hdr.channel + '.' + hdr.method + ') no live subscriber, total=' + session.mux.dropped);
      }
      return;
    }
    sendToView(session, entry, hdr, payload);
    return;
  }
  // events without a mux, host Initialize and undecodable frames: broadcast
  for (const [, v] of session.views) {
    if (v.holdFrames) {                         // still mounting: buffer in order
      if (v.holdBuf.length < 512) v.holdBuf.push(Buffer.from(payload));
      continue;
    }
    const ws = v.ws;
    if (ws && ws.readyState === 1) {
      try { ws.send(payload, { binary: true }); } catch (_e) { /* ignore */ }
    }
  }
}

// Queue one downstream frame into a parked era's replay buffer (see
// RESUME_PARK_MS above). Returns false when buffering is disabled or the gap
// already overflowed — the frame is then simply lost, as it always was.
function bufferForResume(view, out) {
  if (!view.parkedAt || RESUME_PARK_MS <= 0 || view.resumeOverflow) return false;
  if (view.resumeBuf.length >= RESUME_BUF_MAX_FRAMES || view.resumeBytes + out.length > RESUME_BUF_MAX_BYTES) {
    view.resumeOverflow = true;
    view.resumeBuf.length = 0;
    view.resumeBytes = 0;
    console.error('[ws] resume gap buffer overflowed tab=' + view.tabId.slice(0, 8) +
      ' — the next resume of this tab will be forced to reload');
    return false;
  }
  view.resumeBuf.push(Buffer.from(out));
  view.resumeBytes += out.length;
  return true;
}

// Rewrite a downstream frame back into the owning view's local id space and
// deliver it. Three delivery regimes, in order:
//   mounting → holdBuf (fresh view, Initialize replay gated on port-ready);
//   live     → straight onto the socket;
//   parked   → resumeBuf, replayed when this tab hot-reconnects (resume=1), so
//              events fired while the page sat in the background are not lost.
// A view that is neither live nor parked belonged to a replaced renderer era —
// nothing of it survives, the frame is dropped.
function sendToView(session, entry, hdr, payload) {
  const view = entry.view;
  let out = payload;
  if (entry.origId !== hdr.id) out = rewriteRpcId(payload, entry.origId) || payload;
  if (view.holdFrames) {
    if (view.holdBuf.length < 512) view.holdBuf.push(Buffer.from(out));
    return;
  }
  if (session.views.get(view.tabId) === view) {
    const ws = view.ws;
    if (ws && ws.readyState === 1) {
      try { ws.send(out, { binary: true }); return; } catch (_e) { /* socket died mid-send — buffer below */ }
    }
    bufferForResume(view, out);                    // closed socket, close event not fired yet
    return;
  }
  if (view.parkedAt) bufferForResume(view, out);
}

// Tear down a view's host-side event subscriptions by sending EventDispose
// frames with the global ids the host knows. Used when a renderer era is
// replaced: the host never learns that the browser page died, so without this
// its emitter listeners pile up and keep firing for ghosts.
function disposeViewEvents(session, view) {
  if (!session.mux || session.closed || !session.child || session.child.exitCode !== null) return;
  for (const [gid, e] of session.mux.events) {
    if (e.view !== view) continue;
    session.mux.events.delete(gid);
    // EventDispose frame = header [103, gid] + undefined body (preset 0 byte),
    // exactly what the renderer's sendCancelOrDispose emits
    const frame = Buffer.concat([encodeRpcHeader([103, gid]), Buffer.from([0])]);
    try { session.child.stdin.write(encodeFrame(frame)); } catch (_e) { /* host gone */ }
  }
}

function releaseHold(view) {
  if (!view || !view.holdFrames) return;
  view.holdFrames = false;
  const ws = view.ws;
  if (ws && ws.readyState === 1) {
    for (const p of view.holdBuf.splice(0)) {
      try { ws.send(p, { binary: true }); } catch (_e) { break; }
    }
  } else {
    view.holdBuf.length = 0;
  }
}

async function createSession(userKey, tabId) {
  await ensureWorkspaceDirs();
  let child;
  try {
    const host = spawnHost({ serverRoot, log: (l) => console.error(l), extraEnv: hostExtraEnv() });
    child = host.child;
  } catch (err) {
    throw new Error('failed to spawn host: ' + err.message);
  }
  const session = {
    userKey, primaryTab: tabId, child, hello: null,
    views: new Map(),                       // tabId -> view (currently connected)
    eraByTab: new Map(),                    // tabId -> last view object, even after its ws closed (resume/rebind needs it)
    detachedAt: 0, lastFrameAt: 0,
    framesIn: 0, framesOut: 0,
    pendingInbound: [],                     // {view, payload} frames seen before the host handshake finished
    closed: false,
    firstDownstream: null, initForwarded: false,
    mux: MUX_ENABLED ? makeMux() : null,
    activeConvSession: '',                  // mode-boost: sessionId from the latest renderer conversation command
    lastTopicSession: '',                   // mode-boost: sessionId from the latest conversation topic frame
    injectedNext: 0,                        // mode-boost: counter for server-injected host calls
  };
  console.error('[zcode-webui] host spawned pid=' + child.pid + ' user=' + shortUserKey(userKey) + '/' + (tabId || '').slice(0, 8));
  sessions.set(userKey, session);

  // stdout must be drained forever — even with no view attached — so the pipe
  // never fills up and blocks the host while it keeps working in the background.
  // frameTimes keeps a bounded timestamp ring of outbound frames so /api/active
  // can tell "a turn is streaming" (dozens of frames per minute) apart from the
  // trickle an idle open page produces.
  const parser = new FrameParser((payload) => {
    session.framesOut++;
    session.lastFrameAt = Date.now();
    (session.frameTimes || (session.frameTimes = [])).push(session.lastFrameAt);
    if (session.frameTimes.length > 256) session.frameTimes.splice(0, session.frameTimes.length - 256);
    if (!session.firstDownstream) {
      // the host emits exactly one Initialize at startup; remember it so later
      // views can be replayed the full bootstrap
      session.firstDownstream = Buffer.from(payload);
    }
    if (process.env.ZCODE_WEBUI_DEBUG_RPC === '1') rpcLogOut(payload);
    // official startup sequencing: flush frames queued during the handshake only
    // after the Initialize has gone out (earlier flushes wedge the runtime) —
    // each queued frame goes back to the view that sent it (two devices can
    // connect within the handshake window)
    if (!session.initForwarded) {
      session.initForwarded = true;
      for (const e of session.pendingInbound.splice(0)) writeToHost(session, e.view, e.payload);
    }
    routeDownstream(session, payload);
  });
  session.parser = parser;
  child.on('exit', (code, signal) => {
    session.closed = true;
    for (const [, v] of session.views) {
      try { v.ws.close(1011, 'host exited'); } catch (_e) { /* ignore */ }
    }
    session.views.clear();
    console.error('[zcode-webui] host exited pid=' + child.pid + ' code=' + code + ' signal=' + signal);
    // Only remove the CURRENT session for this userKey. A slow-to-die host from
    // an older session can exit after a new session has already replaced it;
    // deleting by key unconditionally would untrack (and leak) the new host.
    if (sessions.get(session.userKey) === session) {
      sessions.delete(session.userKey);
    } else {
      console.error('[zcode-webui] stale host exit ignored pid=' + child.pid + ' (session already replaced)');
    }
  });

  handshake(child)
    .then(({ hello, rest }) => {
      if (session.closed) return;
      session.hello = hello;
      console.error('[zcode-webui] handshake ok pid=' + child.pid + ' host=' + hello.version);
      // 3.12+ agent CLI needs the builtin provider catalog next to it; the host has just
      // materialized its own copy, so hand it over before the first agent spawn
      // (otherwise `zcode.cjs app-server` dies with "无法定位 CLI ZCode Built-in Provider Config")
      ensureCliProviderConfig(serverRoot, { log: (l) => console.error(l) });
      // attach the stdout drain only after the handshake consumed the hello line —
      // otherwise the hello JSON would contaminate the frame parser's buffer
      parser.push(rest);
      child.stdout.on('data', (d) => parser.push(d));
    })
    .catch((err) => {
      console.error('[zcode-webui] handshake failed pid=' + child.pid + ': ' + err.message);
      terminateSession(session, 'handshake failed');
    });

  return session;
}

function rebindView(session, tabId) {
  session.primaryTab = tabId;
}

// Idle-session reaper: a session whose views have ALL gone away parks detached;
// after the TTL it is reaped unless it is verifiably still working (frames
// flowing, or a recent running task in the official index).
if (DETACHED_TTL_MS > 0) {
  setInterval(async () => {
    const now = Date.now();
    if (await hasRunningTask(tasksIndexPath())) return;   // global busy-guard
    for (const s of [...sessions.values()]) {
      if (s.closed || s.views.size > 0 || !s.detachedAt) continue;
      if (now - s.detachedAt <= DETACHED_TTL_MS) continue;
      if (s.lastFrameAt && now - s.lastFrameAt <= FRAME_QUIET_MS) continue;
      console.error('[zcode-webui] reaping idle detached host pid=' + s.child.pid +
        ' (detached ' + Math.round((now - s.detachedAt) / 1000) + 's, quiet ' +
        Math.round((now - s.lastFrameAt) / 1000) + 's)');
      terminateSession(s, 'idle reap');
    }
  }, 60000).unref();
}

// HTTP fallback relays are NOT protected by the sessions reaper above; without
// this every abandoned long-poll page would keep a full zcode-server host alive
// forever. Close relays whose client has not polled/sent recently.
if (HTTP_RELAY_TTL_MS > 0) {
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of httpRelays) {
      if (entry.pipe.closed) { httpRelays.delete(id); continue; }
      if (now - entry.lastSeen > HTTP_RELAY_TTL_MS) {
        console.error('[bridge] reaping idle http relay id=' + id +
          ' (idle ' + Math.round((now - entry.lastSeen) / 1000) + 's)');
        try { entry.pipe.close(); } catch (_e) { /* ignore */ }
        httpRelays.delete(id);
      }
    }
  }, 60000).unref();
}

// mux kill switch lives here so both parser and writer see one definition
const MUX_ENABLED = process.env.ZCODE_WEBUI_MUX !== '0';

// ---------- http server ----------
const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (err) {
    console.error('[http] handler error: ' + ((err && err.stack) || err));
    try { sendJson(res, 500, { ok: false, error: 'internal error' }); } catch (_e) { /* headers sent */ }
  }
});

// Pure polling endpoints whose successful GETs carry no signal — keep them out of
// the request log (they dominated the [http] volume; failures still surface via
// their own error paths).
const HTTP_LOG_SKIP = new Set(['/api/background', '/api/process-metrics', '/bridge/poll', '/api/health', '/api/update-check', '/api/login/status']);

function handleRequest(req, res) {
  // request logging (diagnostics)
  const logPathOnly = (req.url || '').split('?')[0];
  const skipHttpLog = req.method === 'GET' && HTTP_LOG_SKIP.has(logPathOnly);
  if (!skipHttpLog && !req.url.startsWith('/assets/') && !req.url.startsWith('/material-icons/') && !req.url.startsWith('/pdfjs/')) {
    console.error('[http] ' + new Date().toISOString() + ' ' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress) + ' ' + req.method + ' ' + req.url + ' UA=' + String(req.headers['user-agent'] || '').slice(0, 80));
  }
  // browser identity cookie: lets a re-opened tab adopt the host it left running
  if (!parseCookies(req.headers.cookie)[CLIENT_COOKIE]) {
    res.setHeader('Set-Cookie', CLIENT_COOKIE + '=' + randomUUID() + '; Path=/; SameSite=Lax; HttpOnly; Max-Age=31536000');
  }
  let urlPath = safeDecode((req.url || '/').split('?')[0]);
  if (base) {
    if (urlPath === base) {
      res.writeHead(302, { Location: base + '/' });
      return res.end();
    }
    if (!urlPath.startsWith(base + '/')) return send(res, 404, 'not found (outside base path)');
    urlPath = urlPath.slice(base.length) || '/';
  }
  if (!urlPath.startsWith('/')) urlPath = '/' + urlPath;

  // ---- access-token gate (only when ACCESS_TOKEN is configured) ----
  // Unauthenticated HTML requests get the gate page served IN PLACE (200, same
  // URL): a plain reload after the cookie is set keeps working behind
  // prefix-stripping proxies (code-server /proxy/<port>), where this server
  // cannot know the public URL an absolute redirect would need. API/bridge
  // paths and asset-ish extensions get a plain 401; /api/health answers a
  // minimal payload so monitoring probes keep working.
  if (ACCESS_TOKEN && !hasAccess(req)
      && urlPath !== '/api/health'
      && !(urlPath === '/api/access' && req.method === 'POST')) {
    if (urlPath.startsWith('/api/') || urlPath.startsWith('/bridge/')) {
      noteAccessFailure(req);
      return sendJson(res, 401, { ok: false, error: 'access token required' });
    }
    const ext = path.extname(urlPath).toLowerCase();
    if (ext && ext !== '.html' && ext !== '.ico') {
      return send(res, 401, 'unauthorized');
    }
    return serveAccessPage(res);
  }

  // api
  if (urlPath === '/api/access' && req.method === 'POST') {
    if (!ACCESS_TOKEN) return sendJson(res, 400, { ok: false, error: 'access token not configured' });
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let token = '';
      try { token = String((JSON.parse(body) || {}).token || ''); } catch (_e) { /* malformed body */ }
      if (tokenMatches(token)) {
        accessFailures = 0;
        send(res, 200, JSON.stringify({ ok: true }), {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': ACCESS_COOKIE + '=' + accessCookieValue + '; Path=/; SameSite=Lax; HttpOnly; Max-Age=2592000',
        });
      } else {
        noteAccessFailure(req);
        sendJson(res, 401, { ok: false, error: 'invalid token' });
      }
    });
    return;
  }

  if (urlPath === '/api/health') {
    if (ACCESS_TOKEN && !hasAccess(req)) {
      // probes only need a 200; the detailed snapshot stays behind the gate
      return sendJson(res, 200, { ok: true, authRequired: true });
    }
    const all = [...sessions.values()];
    const withHello = all.find((s) => !s.closed && s.hello);
    return sendJson(res, 200, {
      ok: true, name: 'zcode-webui', version: pkgVersion, base,
      dataHome: PATHS.dataHome,
      rendererLoaded: existsSync(path.join(RENDERER_DIR, 'index.html')),
      serverRoot: serverRoot || null, workspace: WORKSPACE,
      login: loginState(),
      hostVersion: withHello ? (withHello.hello.version || null) : null,
      nodeVersion: process.version,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      sessions: {
        total: all.filter((s) => !s.closed).length,
        views: all.reduce((n, s) => n + (s.closed ? 0 : s.views.size), 0),
        detached: all.filter((s) => !s.closed && s.views.size === 0).length,
      },
      reaper: { enabled: DETACHED_TTL_MS > 0, ttlMs: DETACHED_TTL_MS },
      httpRelays: httpRelays.size,
      bindHost: BIND_HOST,
      accessGate: !!ACCESS_TOKEN,
      guards: { apiCache: guardStatsSnapshot(), quotaReset: quotaResetSnapshot() },
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
        httpRelays.delete(id);
      };
      if (HTTP_RELAY_MAX > 0) {
        let oldest = null;
        for (const [rid, e] of httpRelays) {
          if (!oldest || e.lastSeen < oldest.entry.lastSeen) oldest = { id: rid, entry: e };
        }
        if (oldest && httpRelays.size >= HTTP_RELAY_MAX) {
          console.error('[bridge] closing oldest http relay id=' + oldest.id + ' (max ' + HTTP_RELAY_MAX + ' reached)');
          try { oldest.entry.pipe.close(); } catch (_e) { /* ignore */ }
          httpRelays.delete(oldest.id);
        }
      }
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
    let bodyBytes = 0;
    let overflowed = false;
    req.on('data', (d) => {
      bodyBytes += d.length;
      if (bodyBytes <= BRIDGE_MAX_BODY_BYTES) { chunks.push(d); return; }
      if (!overflowed) {
        overflowed = true;
        console.error('[bridge] inbound body exceeds ' + BRIDGE_MAX_BODY_BYTES + 'B, rejecting');
        try { send(res, 413, 'payload too large'); } catch (_e) { /* socket may be gone */ }
      }
      req.destroy();
    });
    req.on('end', () => {
      if (overflowed) return;
      const payload = Buffer.concat(chunks);
      // same pin no-op as the WS path: this relay pushes straight into its own
      // host pipe, so without this check a page on the HTTP fallback could still
      // pin a task (and lose it from the list)
      const pinnedCall = interceptPinRpc(payload);
      if (pinnedCall) {
        console.error('[bridge] pin no-op (http relay) id=' + pinnedCall.id + ' — acked without forwarding');
        queueRelayFrame(entry, pinAckFor(pinnedCall, pinnedCall.id));
        return sendJson(res, 200, { ok: true });
      }
      const ok = entry.pipe.push(payload);
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
    if (entry.waiter) {                     // a previous poll never resolved (client
      const w = entry.waiter;               // raced a second one in) — complete it
      entry.waiter = null;                  // empty so that client re-polls at once
      clearTimeout(entry.waiterTimer);
      w(Buffer.alloc(0));
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
    // ops endpoint: terminate every host session (attached + detached) immediately.
    // ?user=1 limits it to the CALLER's account hosts, and &keepTab=<tabId>
    // spares the caller's own live page (used by the "stop background execution"
    // banner action so a second device can clear a duplicate driver safely).
    const url2 = new URL(req.url, 'http://x');
    const scopeUser = url2.searchParams.get('user') === '1';
    const keepTab = (url2.searchParams.get('keepTab') || '').slice(0, 128);
    let targets = [...sessions.values()];
    if (scopeUser) {
      const clientKey = parseCookies(req.headers.cookie)[CLIENT_COOKIE] || '';
      const callerKey = resolveUserKey(clientKey);
      targets = targets.filter((s) => s.userKey === callerKey && !(keepTab && s.views.has(keepTab)));
    }
    for (const s of targets) terminateSession(s, scopeUser ? 'user terminate' : 'api terminate');
    if (!scopeUser) {
      for (const [, entry] of httpRelays) {
        try { entry.pipe.close(); } catch (_e) { /* ignore */ }
      }
      httpRelays.clear();
    }
    return sendJson(res, 200, { ok: true, terminated: targets.length });
  }

  // background-execution visibility for the current account: lets a freshly
  // loaded second device learn whether another host is still mid-turn
  if (urlPath === '/api/background' && req.method === 'GET') {
    const q2 = new URL(req.url, 'http://x').searchParams;
    const clientKey = parseCookies(req.headers.cookie)[CLIENT_COOKIE] || '';
    const userKey = resolveUserKey(clientKey);
    const sess = sessions.get(userKey);
    // background-execution signal: a session with NO attached views whose host
    // streamed frames recently = a task running on a device that has left
    let background = [];
    if (sess && !sess.closed && sess.views.size === 0 && sess.framesIn > 0 &&
        sess.lastFrameAt && Date.now() - sess.lastFrameAt < ACTIVE_FRAME_MS) {
      background = [{ pid: sess.child.pid, lastFrameAgeSec: Math.round((Date.now() - sess.lastFrameAt) / 1000) }];
    }
    return sendJson(res, 200, { activeCount: background.length, hosts: background });
  }

  // Restart-safety signal: is ANY agent turn running right now? This is the
  // authoritative pre-restart check — /api/background only counts DETACHED
  // hosts (a task whose tab is attached is invisible to it), and the tasks
  // index has documented blind spots (an errored turn keeps its row at 'error'
  // with no updated_at writes while it retries). Combined here (fail-safe when
  // the index cannot be read):
  //   1. heavy streaming: >=30 host frames in the trailing minute (a turn in
  //      flight streams continuously; an idle open page only trickles a few
  //      polling frames per minute);
  //   2. a DETACHED session with frames inside ACTIVE_FRAME_MS — a turn
  //      running on a device that already left (subsumes /api/background);
  //   3. tasks-index: running rows inside the 2h staleness window, or error
  //      rows written within the last 30 min (the retry limbo writes nothing).
  if (urlPath === '/api/active' && req.method === 'GET') {
    const now = Date.now();
    const streaming = [];
    const detachedBusy = [];
    for (const s of sessions.values()) {
      if (s.closed || !s.lastFrameAt) continue;
      let burst = 0;
      for (const t of s.frameTimes || []) if (now - t <= 60_000) burst++;
      if (burst >= 30) streaming.push({ pid: s.child.pid, views: s.views.size, framesLastMin: burst });
      if (s.views.size === 0 && now - s.lastFrameAt < ACTIVE_FRAME_MS) {
        detachedBusy.push({ pid: s.child.pid, lastFrameAgeSec: Math.round((now - s.lastFrameAt) / 1000) });
      }
    }
    const tasks = [];
    let indexOk = true;
    try {
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
      const db = new DatabaseSync(tasksIndexPath(), { readOnly: true });
      try {
        const rows = db.prepare(
          "SELECT task_id, task_status, updated_at, title FROM tasks WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 12"
        ).all(now - RUNNING_TASK_STALE_MS);
        for (const r of rows) {
          tasks.push({
            taskId: r.task_id, status: r.task_status,
            ageSec: Math.round((now - r.updated_at) / 1000),
            title: String(r.title || '').slice(0, 60),
          });
        }
      } finally { db.close(); }
    } catch (_e) { indexOk = false; }
    // error rows: the retry limbo writes NOTHING (verified live: a turn ran 26min
    // past its error transition) — keep the restart-safety window generous
    const busy = tasks.filter((t) => t.status === 'running' || (t.status === 'error' && t.ageSec <= 30 * 60));
    const reasons = [];
    if (streaming.length > 0) reasons.push(streaming.length + ' host(s) streaming hard (' + streaming[0].framesLastMin + ' frames/min)');
    if (detachedBusy.length > 0) reasons.push(detachedBusy.length + ' detached host(s) mid-turn');
    for (const t of busy) reasons.push('task ' + String(t.taskId).slice(0, 18) + ' ' + t.status + ' ' + Math.max(1, Math.round(t.ageSec / 60)) + 'min ago');
    if (!indexOk) reasons.push('tasks-index unreadable (fail-safe)');
    return sendJson(res, 200, {
      ok: true,
      active: streaming.length > 0 || detachedBusy.length > 0 || busy.length > 0 || !indexOk,
      reasons, streaming, detachedBusy, indexOk, tasks,
    });
  }

  // instant collaboration-mode push for the conversation the user is looking
  // at (see src/mode-boost.mjs): POST {mode:'yolo'|'完全访问'|…, taskId?}.
  // The host maps the mode and runs the v4 switchCollaborationMode command
  // with its own CAS retry, so the agent applies it on the very next step.
  if (urlPath === '/api/mode-boost' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch (_e) {}
      const mode = normalizeBoostMode(j.mode);
      if (!mode) return sendJson(res, 400, { ok: false, error: 'unsupported mode ' + JSON.stringify(j.mode) });
      const clientKey = parseCookies(req.headers.cookie)[CLIENT_COOKIE] || '';
      const sess = sessions.get(resolveUserKey(clientKey));
      if (!sess || sess.closed) return sendJson(res, 503, { ok: false, error: 'no host session (open the app first)' });
      const taskId = typeof j.taskId === 'string' && j.taskId.startsWith('sess_') && j.taskId.length < 128
        ? j.taskId : (sess.activeConvSession || sess.lastTopicSession || '');
      if (!taskId) return sendJson(res, 409, { ok: false, error: 'no active conversation yet (send a prompt first)' });
      const gid = injectModeBoost(sess, taskId, mode);
      if (!gid) return sendJson(res, 502, { ok: false, error: 'host pipe unavailable' });
      return sendJson(res, 200, { ok: true, taskId, mode, gid });
    });
    return;
  }

  // quota-reset auto-use switch (the ♻ chip next to the ⚡ one): the guard
  // preloaded in every host process polls the switch file, so flipping it takes
  // effect within seconds and needs no restart. GET reports the state the hosts
  // will resolve; POST {mode:'on'|'off'|'dry-run'} (or {enabled:boolean}) writes it.
  if (urlPath === '/api/quota-reset' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, ...quotaResetSwitchState() });
  }
  if (urlPath === '/api/quota-reset' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch (_e) {}
      let mode = typeof j.mode === 'string' ? j.mode.trim().toLowerCase() : '';
      if (!mode && typeof j.enabled === 'boolean') mode = j.enabled ? 'on' : 'off';
      if (!QUOTA_RESET_MODES.has(mode)) {
        return sendJson(res, 400, { ok: false, error: 'unsupported mode ' + JSON.stringify(j.mode) + ' (on|off|dry-run)' });
      }
      try {
        mkdirSync(path.dirname(QUOTA_RESET_SWITCH_FILE), { recursive: true });
        const tmp = QUOTA_RESET_SWITCH_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify({ at: Date.now(), mode, by: 'ui' }) + '\n');
        renameSync(tmp, QUOTA_RESET_SWITCH_FILE);
        console.error('[quota-reset] switch → ' + mode + ' (ui)');
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
      }
      return sendJson(res, 200, { ok: true, ...quotaResetSwitchState() });
    });
    return;
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

  // directory listing for the web directory picker — clamped to the workspace
  // and the user's home so the endpoint cannot be used to map the whole disk
  const FS_LIST_ROOTS = [...new Set(
    [WORKSPACE, os.homedir()].map((p) => { try { return path.resolve(p); } catch (_e) { return ''; } }).filter(Boolean)
  )];
  const fsUnderRoot = (p) => FS_LIST_ROOTS.some((r) => p === r || p.startsWith(r + path.sep));
  if (urlPath === '/api/fs/list' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    let p = (q.get('path') || WORKSPACE || os.homedir()).trim();
    if (!p || !path.isAbsolute(p)) p = os.homedir();
    p = path.resolve(p);
    if (!fsUnderRoot(p)) {
      return sendJson(res, 403, { ok: false, error: 'outside the allowed roots (workspace / home)' });
    }
    // clamp upward navigation: when dirname leaves the roots (p IS a root), stop
    // showing a ".." row instead of erroring on the next click
    let parent = path.dirname(p);
    if (!fsUnderRoot(parent)) parent = p;
    try {
      const entries = readdirSync(p, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
      sendJson(res, 200, { ok: true, path: p, parent, dirs });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
    }
    return;
  }

  // process tree for the official renderer's process-monitor page (see shim in
  // web/process-monitor-bridge.js); response body IS the tree root, unwrapped
  if (urlPath === '/api/process-metrics' && req.method === 'GET') {
    return sendJson(res, 200, processMetricsTree());
  }

  // official-component update state for the Help menu's 检查更新 (cached server-side)
  if (urlPath === '/api/update-check' && req.method === 'GET') {
    if (updateCheckCache && Date.now() - updateCheckCache.ts < UPDATE_CHECK_CACHE_MS) {
      return sendJson(res, 200, updateCheckCache.result);
    }
    officialUpdateState().then((result) => sendJson(res, 200, result));
    return;
  }

  // log bundle download for the Help menu's 导出日志
  if (urlPath === '/api/logs/export' && req.method === 'GET') {
    const fname = 'zcode-webui-logs-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.txt';
    return send(res, 200, logExportBody(), {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + fname + '"',
      'Cache-Control': 'no-store',
    });
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
    return f ? serveFile(req, res, f, urlPath) : send(res, 404, 'not found');
  }

  // access-token gate page (canonical URL; the gate itself serves this page in
  // place on any unauthenticated HTML request — see the gate block above)
  if (urlPath === '/access') {
    if (!ACCESS_TOKEN || hasAccess(req)) {
      res.writeHead(302, { Location: './' });   // relative — safe behind stripping proxies
      return res.end();
    }
    return serveAccessPage(res);
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

  // official renderer's process monitor page, with the metrics shim injected
  if (urlPath === '/process-monitor.html') {
    const html = readProcessMonitorPage();
    if (!html) return send(res, 404, 'process-monitor.html missing (run npm run fetch-renderer)');
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  // official renderer
  if (urlPath === '/' || urlPath === '/index.html') {
    const html = readRendererIndex();
    if (!html) return send(res, 503, 'renderer missing: run npm run fetch-renderer');
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  const f = safeJoin(RENDERER_DIR, urlPath.slice(1));
  return f ? serveFile(req, res, f, urlPath) : send(res, 404, 'not found');
}

// ---------- websocket ----------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  (async () => {
    try {
      handleUpgrade(req, socket, head);
    } catch (err) {
      console.error('[ws] upgrade error: ' + ((err && err.stack) || err));
      try { socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n'); } catch (_e) { /* ignore */ }
      socket.destroy();
    }
  })();
});

function handleUpgrade(req, socket, head) {
  let urlPath = safeDecode((req.url || '/').split('?')[0]);
  if (base) {
    if (urlPath === base) urlPath = base + '/';
    if (!urlPath.startsWith(base + '/')) return socket.destroy();
    urlPath = urlPath.slice(base.length) || '/';
  }
  if (urlPath !== '/ws') return socket.destroy();
  if (!hasAccess(req)) {
    console.error('[ws] rejected upgrade without access cookie from ' + req.socket.remoteAddress);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  const q = new URL(req.url, 'http://x').searchParams;
  const token = q.get('token');
  if (token !== WS_TOKEN) {
    console.error('[ws] rejected upgrade with bad/missing token from ' + req.socket.remoteAddress);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  // Multi-device live view: every page of an account attaches as a VIEW of the
  // account's single running host (events broadcast, responses routed by
  // ownership). resume=1 marks the SAME renderer page hot-reconnecting after an
  // app switch — its mux era continues and frames buffered while it was away
  // are replayed, so nothing is lost and nothing needs a reload.
  const clientKey = parseCookies(req.headers.cookie)[CLIENT_COOKIE] || '';
  const userKey = resolveUserKey(clientKey);
  const tabId = (q.get('tab') || '').slice(0, 128);
  const resume = q.get('resume') === '1';
  if (process.env.ZCODE_WEBUI_DEBUG_RPC === '1') console.error('[wsdbg] upgrade tab=' + tabId.slice(0, 8) + ' resume=' + resume + ' userKey=' + shortUserKey(userKey) + ' cookie=' + String(req.headers.cookie || 'none').slice(0, 24));

  (async () => {
    // CONTINUITY POLICY: every page of an account attaches as a VIEW of that
    // account's single running host — switching devices keeps the live stream on
    // the same pid, previous pages simply keep working as additional viewers.
    // Only when the account has NO live session does this page spawn a fresh one.
    const prev = sessions.get(userKey);
    let session = prev && !prev.closed && prev.child && prev.child.exitCode === null ? prev : null;
    let adopted = false;
    if (session) {
      adopted = true;
      if (MUX_ENABLED && !session.mux) { session.mux = makeMux(); session.eraByTab ??= new Map(); }
      rebindView(session, tabId);
      session.detachedAt = 0;
      console.error('[zcode-webui] view attached pid=' + session.child.pid +
        ' tab=' + tabId.slice(0, 8) + ' (user ' + shortUserKey(userKey) + ', views=' + session.views.size +
        ', last frame ' + (session.lastFrameAt ? Math.round((Date.now() - session.lastFrameAt) / 1000) + 's ago' : 'never') + ')');
    } else {
      // Coalesce concurrent first-connects onto ONE host: createSession yields
      // (ensureWorkspaceDirs I/O) between the map lookup and its sessions.set,
      // so two tabs opening at the same moment used to spawn two hosts — the
      // overwritten one then lived outside `sessions` where no reaper could
      // ever see it again.
      let createdHere = false;
      let spawnPromise = pendingSpawns.get(userKey);
      if (!spawnPromise) {
        createdHere = true;
        spawnPromise = createSession(userKey, tabId);
        pendingSpawns.set(userKey, spawnPromise);
        const clear = () => pendingSpawns.delete(userKey);
        spawnPromise.then(clear, clear);
      }
      try {
        session = await spawnPromise;
      } catch (err) {
        console.error('[ws] host spawn failed: ' + err.message);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        return socket.destroy();
      }
      // a coalesced waiter attaches to a host it did not spawn: treat it exactly
      // like any late-joining view (Initialize replay + hold gating)
      if (!createdHere) adopted = true;
      if (session.closed) {          // spawned, but already died again (handshake failed)
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        return socket.destroy();
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, session, { adopted, tabId, resume });
    });
  })();
}

wss.on('connection', (ws, req, session, meta) => {
  const adopted = !!(meta && meta.adopted);
  const tabId = ((meta && meta.tabId) || 'tab-unknown').slice(0, 128);
  const resume = !!(meta && meta.resume);
  console.error('[ws] connected from ' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress) + ' UA=' + String(req.headers['user-agent'] || '').slice(0, 80));

  // resume=1 means the page instance already bootstrapped once, so its event
  // subscriptions are "live" from its point of view and it will NEVER re-send
  // EventListen. If this session holds no era of this tab (server restart, host
  // reaped and re-spawned by another page), those subscriptions can never be
  // restored — events would silently stop. Force the clean path instead:
  // bootstrap.js reloads the page on close code 4000 and re-bootstraps fresh.
  if (resume && !session.eraByTab.get(tabId)) {
    console.error('[ws] stale-era resume rejected tab=' + tabId.slice(0, 8) + ' — forcing page reload');
    try { ws.close(4000, 'era gone'); } catch (_e) { /* ignore */ }
    return;
  }

  // ---- build this page's view ----
  const view = {
    ws, tabId,
    sent: new Set(),                       // globalIds this renderer is awaiting
    holdFrames: false, holdBuf: [], holdSkipOnce: false, replayInitOnCapture: false,
    lastFrameAt: 0,
    missed: 0,                             // consecutive unanswered keepalive pings
    parkedAt: 0,                           // ws closed, era parked in eraByTab (resume replay active)
    resumeBuf: [], resumeBytes: 0, resumeOverflow: false,
  };
  // prevView is the previous renderer era of this tab — looked up in eraByTab
  // because the ws close handler may already have removed it from views (the
  // close of a hot-reconnecting socket always races the reconnect)
  const prevView = session.eraByTab.get(tabId) || null;
  // A resume whose offline gap overflowed the replay buffer cannot be bridged:
  // the renderer would see a hole in its event stream and quietly go stale. Send
  // it down the established recovery path instead (close 4000 → page reload).
  // Checked BEFORE any state mutation so the half-attached view leaves no trace.
  if (resume && prevView && prevView.resumeOverflow) {
    console.error('[ws] resume rejected tab=' + tabId.slice(0, 8) + ' — offline gap overflowed the replay buffer, forcing reload');
    try { ws.close(4000, 'gap overflow'); } catch (_e) { /* ignore */ }
    return;
  }
  if (adopted && !resume) {
    // fresh renderer bootstrapping against a mid-stream host: gate downstream
    // until its port-ready ack (or failsafe) so it sees Initialize first
    view.holdFrames = true;
    view.holdBuf = [];
    if (session.firstDownstream) view.holdBuf.push(Buffer.from(session.firstDownstream));
    else view.replayInitOnCapture = true;
    setTimeout(() => releaseHold(view), 8000).unref();
  }
  if (session.mux && prevView && prevView !== view) {
    if (resume) {
      // hot reconnect of the SAME live renderer: its era continues — re-point
      // the ownership records at the new socket or responses/fires for its
      // in-flight calls and subscriptions would be dropped forever
      for (const [, e] of session.mux.pending) if (e.view === prevView) e.view = view;
      for (const [, e] of session.mux.events) if (e.view === prevView) e.view = view;
    } else {
      // fresh renderer era of this tab: the old renderer is gone without the
      // host ever noticing, so explicitly unsubscribe its events (calls just
      // expire — their stale responses are dropped by the mux)
      disposeViewEvents(session, prevView);
      for (const [gid, e] of session.mux.pending) if (e.view === prevView) {
        session.mux.pending.delete(gid);
        prevView.sent.delete(gid);
      }
      prevView.sent.clear();
      prevView.holdBuf.length = 0;           // eraByTab keeps the object alive — drop its buffers
      prevView.resumeBuf.length = 0;         // a fresh era replays nothing from the old one
      prevView.resumeBytes = 0;
    }
  }
  session.views.set(tabId, view);
  session.eraByTab.set(tabId, view);
  session.detachedAt = 0;
  // resume replay: flush the frames buffered while this tab's socket was gone
  // BEFORE any new downstream frame can be sent — per-socket send ordering then
  // preserves the era's original sequence. (prevView parked buffers only; the
  // new view starts with an empty one.)
  if (resume && prevView && prevView !== view) {
    const gap = prevView.resumeBuf.splice(0);
    const gapBytes = prevView.resumeBytes;
    prevView.resumeBytes = 0;
    if (gap.length > 0) {
      console.error('[ws] resume replay tab=' + tabId.slice(0, 8) + ': ' + gap.length +
        ' buffered frame(s), ' + gapBytes + 'B, covering the offline gap');
      for (const p of gap) { try { ws.send(p, { binary: true }); } catch (_e) { break; } }
    }
    // Calls this tab had in flight when its socket dropped, whose responses
    // never made it out (emitted into the dying socket) would hang the
    // renderer FOREVER — the official client has no per-call timeout on this
    // path, and consumers like the file tree dedup further clicks on a
    // `loading` flag that only a completed response clears ("folder won't
    // open until refresh"). Answer them with a synthesized timeout error: the
    // renderer surfaces a retryable error instead, and the host's (possibly
    // late) real response is dropped by the mux as stale. Calls queued while
    // offline arrive AFTER this point (fresh pending.at) and are untouched.
    if (session.mux && prevView.parkedAt) {
      const stale = [];
      for (const [gid, e] of session.mux.pending) {
        if (e.view === view && !e.injected && e.at && e.at <= prevView.parkedAt) stale.push([gid, e]);
      }
      if (stale.length > 0) {
        console.error('[ws] resume tab=' + tabId.slice(0, 8) + ': synthesizing timeout errors for ' +
          stale.length + ' in-flight call(s) lost across the disconnect');
        for (const [gid, e] of stale) {
          session.mux.pending.delete(gid);
          view.sent.delete(gid);
          session.mux.dropped++;
          try { sendToView(session, e, { id: gid }, errorAckFor(gid, 'zcode-webui: response lost during disconnect (synthesized timeout)')); } catch (_e) { /* view may close again immediately */ }
        }
      }
    }
  }

  // listeners FIRST (a client answering the ready signal instantly must not
  // lose its first frame), announcements after
  ws.on('message', (data, isBinary) => {
    if (session.closed) return;
    if (!isBinary) {
      if (String(data) === '{"kind":"zcode-webui-port-ready"}') releaseHold(view);
      return;
    }
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (view.lastFrameAt === 0) view.lastFrameAt = Date.now();
    if (session.hello) writeToHost(session, view, payload);
    else session.pendingInbound.push({ view, payload });   // flushed with its owner (see FrameParser callback)
  });
  ws.on('close', () => {
    if (session.views.get(tabId) !== view) return;     // superseded by a newer view
    session.views.delete(tabId);
    view.sent.clear();
    view.holdBuf.length = 0;               // eraByTab keeps the object alive — drop its buffers
    view.holdFrames = false;               // never mounted or still holding: parked buffering takes over
    view.parkedAt = Date.now();            // era parks: downstream frames buffer for resume replay
    if (session.views.size === 0) {
      if (session.framesIn === 0 && session.framesOut === 0) {
        console.error('[ws] closed before traffic, terminating host pid=' + session.child.pid);
        terminateSession(session, 'closed before traffic');
        return;
      }
      session.detachedAt = Date.now();
      console.error('[ws] DETACHED (host keeps running) pid=' + session.child.pid + ' views=0 frames in=' + session.framesIn + ' out=' + session.framesOut);
    } else {
      console.error('[ws] view gone tab=' + tabId.slice(0, 8) + ' — ' + session.views.size + ' viewer(s) remain');
    }
  });
  ws.on('error', () => { /* onclose follows */ });
  ws.on('pong', () => { view.alive = true; view.missed = 0; });
  view.alive = true;
  view.missed = 0;
  view.parkedAt = 0;

  try { ws.send(WS_READY); } catch (_e) { /* ignore */ }
  const announce = (line) => {
    try { if (ws.readyState === 1) ws.send(String(line)); } catch (_e) { /* ignore */ }
  };
  announce((adopted ? '[zcode-webui] host adopted pid=' : '[zcode-webui] host spawned pid=') + session.child.pid +
    (session.views.size > 1 ? ' (viewers: ' + session.views.size + ')' : ''));
  if (session.views.size > 1) {
    console.error('[zcode-webui] multi-view: ' + session.views.size + ' devices watching user ' + shortUserKey(session.userKey));
  }
});

// ws keepalive: ping attached clients every WS_PING_MS and terminate the socket
// only after WS_PING_MAX_MISS consecutive pings went unanswered (phone app
// frozen in background, dead network, throttled tab). Terminating DETACHES the
// host cleanly — it parks in the background and the client hot-reconnects (and
// re-adopts the same host, with the offline gap replayed) when the user comes
// back.
setInterval(() => {
  for (const s of [...sessions.values()]) {
    for (const v of s.views.values()) {
      const ws = v.ws;
      if (!ws || ws.readyState !== 1) continue;
      if (v.alive === false) {
        v.missed = (v.missed || 0) + 1;
        if (v.missed >= WS_PING_MAX_MISS) {
          console.error('[ws] client unresponsive (no pong for ' + v.missed + ' ping(s)), terminating socket tab=' + v.tabId.slice(0, 8));
          ws.terminate();                       // close event removes the view; era parks with replay
          continue;
        }
      } else {
        v.missed = 0;
      }
      v.alive = false;
      try { ws.ping(); } catch (_e) { /* ignore */ }
    }
  }
}, WS_PING_MS).unref();

// Parked-era expiry: a tab whose socket closed buffers downstream frames for a
// resume that may never come. After RESUME_PARK_MS the era is retired — its
// host-side event subscriptions are disposed (a tab that never returns would
// otherwise keep ghost listeners firing forever) and its replay buffer freed.
// The eraByTab entry goes too, so a late resume=1 from that tab takes the
// clean reload path instead of pretending nothing was lost.
if (RESUME_PARK_MS > 0) {
  setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (s.closed || !s.eraByTab) continue;
      for (const [tabId, era] of s.eraByTab) {
        if (s.views.get(tabId) === era || !era.parkedAt) continue;
        if (now - era.parkedAt <= RESUME_PARK_MS) continue;
        disposeViewEvents(s, era);
        if (s.mux) {
          for (const [gid, e] of s.mux.pending) if (e.view === era) s.mux.pending.delete(gid);
        }
        era.resumeBuf.length = 0;
        era.resumeBytes = 0;
        era.resumeOverflow = false;
        era.parkedAt = 0;
        s.eraByTab.delete(tabId);
        console.error('[ws] parked era expired tab=' + tabId.slice(0, 8) +
          ' after ' + Math.round(RESUME_PARK_MS / 1000) + 's — subscriptions disposed, late resume will reload');
      }
    }
  }, 30000).unref();
}

// Stale-call sweeper: a mux pending entry whose host never answered would
// otherwise live forever (tiny leak, but it also pins the view's `sent` set).
const PENDING_CALL_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (!s.mux) continue;
    let reaped = 0;
    for (const [gid, e] of s.mux.pending) {
      if (!e.at || now - e.at <= PENDING_CALL_TTL_MS) continue;
      s.mux.pending.delete(gid);
      if (e.view && e.view.sent) e.view.sent.delete(gid);
      s.mux.dropped++;
      reaped++;
    }
    if (reaped > 0) console.error('[mux] reaped ' + reaped + ' pending call(s) with no response in ' + Math.round(PENDING_CALL_TTL_MS / 1000) + 's (host pid ' + (s.child && s.child.pid) + ')');
  }
}, 60000).unref();

// ---------- log overflow guard ----------
// zcode-service.sh rotates by size on every start; this is the safety net for
// very long uptimes. O_APPEND (the shell's >> redirect) makes truncating safe —
// later writes land at the new EOF. The last 8 MiB are preserved in
// zcode-webui.log.overflow for forensics before the truncate.
const LOG_MAX_BYTES = Number(process.env.ZCODE_WEBUI_LOG_MAX_MB) > 0
  ? Number(process.env.ZCODE_WEBUI_LOG_MAX_MB) * 1024 * 1024
  : 200 * 1024 * 1024;
setInterval(() => {
  const logPath = path.join(ROOT, 'zcode-webui.log');
  try {
    const st = statSync(logPath);
    if (st.size <= LOG_MAX_BYTES) return;
    const start = Math.max(0, st.size - 8 * 1024 * 1024);
    const fh = openSync(logPath, 'r');
    let tail;
    try {
      tail = Buffer.alloc(st.size - start);
      readSync(fh, tail, 0, tail.length, start);
    } finally { closeSync(fh); }
    writeFileSync(logPath + '.overflow', tail);
    truncateSync(logPath, 0);
    console.error('[zcode-webui] log self-rotation: kept an 8MiB tail in zcode-webui.log.overflow, truncated '
      + st.size + ' bytes (tune with ZCODE_WEBUI_LOG_MAX_MB)');
  } catch (_e) { /* best-effort — never take the service down over logging */ }
}, 15 * 60 * 1000).unref();

// ---------- start ----------
// Bind failures (EADDRINUSE…) are STARTUP errors: unlike request-path faults
// they leave a process that can never serve, so exit loudly instead of relying
// on the keep-running guard below.
server.on('error', (err) => {
  console.error('[zcode-webui] fatal server error: ' + ((err && err.stack) || err));
  process.exit(2);
});
server.listen(PORT, BIND_HOST, () => {
  console.log('[zcode-webui] listening on http://' + BIND_HOST + ':' + PORT + base + '/');
  console.log('[zcode-webui] base path : ' + (base || '(root)'));
  console.log('[zcode-webui] access gate: ' + (ACCESS_TOKEN
    ? 'ENABLED — enter the token at ' + joinBase('/access') + ' (cookie ' + ACCESS_COOKIE + ')'
    : 'disabled (set accessToken / ZCODE_WEBUI_ACCESS_TOKEN to enable)'));
  console.log('[zcode-webui] data home : ' + PATHS.dataHome);
  console.log('[zcode-webui] workspace  : ' + WORKSPACE);
  console.log('[zcode-webui] serverRoot : ' + (serverRoot || '(missing)'));
  console.log('[zcode-webui] renderer   : ' + (existsSync(path.join(RENDERER_DIR, 'index.html')) ? 'ready' : 'MISSING (run: npm run fetch-renderer)'));
  // self-heal the 3.12+ CLI provider catalog on every start (see ensureCliProviderConfig):
  // covers runtime upgrades and a wiped ~/.zcode/v2 without waiting for the first session
  if (serverRoot) ensureCliProviderConfig(serverRoot, { log: (l) => console.log(l) });
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Stall watchdog: if wall-clock jumps far ahead of the timer cadence, the whole
// process was frozen (system suspend, SIGSTOP, VM pause). Logged so that
// "session stopped" reports can be correlated with real suspend windows.
{
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const drift = now - lastTick - 60000;
    if (drift > 30000) {
      console.error('[zcode-webui] process stall of ~' + Math.round(drift / 1000) +
        's detected (system suspend/VM pause?) ended at ' + new Date(now).toISOString() +
        ' — in-flight agent turns may have been interrupted');
    }
    lastTick = now;
  }, 60000).unref();
}


// Last-resort guards: log unexpected errors but keep serving — crashing would
// take every background task down with it. Realistic error sources (malformed
// URLs, fs races) are already handled locally; this is the safety net.
process.on('uncaughtException', (err) => {
  console.error('[zcode-webui] uncaught exception (service keeps running): ' + ((err && err.stack) || err));
});
process.on('unhandledRejection', (reason) => {
  console.error('[zcode-webui] unhandled rejection (service keeps running): ' + ((reason && reason.stack) || reason));
});

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
