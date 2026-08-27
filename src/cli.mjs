#!/usr/bin/env node
// zcode-webui CLI: guided setup + day-to-day commands for the npm-installed
// (and repo-checkout) deployments. All mutable state lives in the data home
// (see src/dirs.mjs) so the installed package directory stays read-only.

import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from './dirs.mjs';
import { resolveServerRoot } from './host.mjs';
import {
  DEFAULT_VERSION,
  currentRendererVersion,
  currentServerAppVersion,
  fetchLatestVersion,
  installServerRuntime,
  platformKey,
  resolveUpgradeProxy,
  runFetchRenderer,
} from './upgrade.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATHS = resolvePaths(PACKAGE_ROOT);
const SERVER_JS = path.join(PACKAGE_ROOT, 'src', 'server.mjs');
const FETCH_SH = path.join(PACKAGE_ROOT, 'scripts', 'fetch-renderer.sh');
const CLI_SAMPLE = path.join(PACKAGE_ROOT, 'cli-config.example.json');

let pkg = { name: 'zcode-webui', version: '0.0.0' };
try { pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')); } catch (_e) { /* ignore */ }

// Behave like a normal unix CLI when stdout/stderr is a closed pipe
// (`zcode-webui status | head` must exit quietly instead of stack-tracing).
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) process.exit(0);
    throw err;
  });
}

const ZCODE_HOME = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
const CRED_FILE = path.join(ZCODE_HOME, 'v2', 'credentials.json');
const CLI_CONFIG = path.join(ZCODE_HOME, 'cli', 'config.json');
const DESKTOP_CONFIG = path.join(ZCODE_HOME, 'v2', 'config.json');
const SERVER_ROOT_DEFAULT = path.join(ZCODE_HOME, 'server');

// ---------- helpers ----------
function ask(question, def) {
  // stdin may be closed / non-interactive (CI, piped input): resolve with the
  // default instead of hanging forever — the historic --yes pitfall.
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { rl.close(); } catch (_e) { /* ignore */ } resolve(v); } };
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('close', () => finish(def));
    process.stdin.once('error', () => finish(def));
    process.stdin.once('end', () => finish(def));
    rl.question(question + (def !== undefined && def !== '' ? ' [' + def + '] ' : ' '), (a) => {
      finish((a || '').trim() === '' ? def : a.trim());
    });
  });
}
function flag(name, def = '') {
  const args = process.argv.slice(2);
  const eq = '--' + name + '=';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--' + name && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(eq)) return args[i].slice(eq.length);
  }
  return def;
}
function hasFlag(name) {
  // callers pass the full flag name including leading dashes (e.g. '--yes')
  return process.argv.slice(2).includes(name);
}
function log(line) { console.log(line); }
function ok(line) { console.log('✔ ' + line); }
function warn(line) { console.log('! ' + line); }
function fail(line) { console.log('✘ ' + line); }
function which(cmd) {
  // plain sh is more portable and faster than a login bash (-lc pulls in the
  // user profile, which can be slow or broken on exotic setups)
  const r = spawnSync('sh', ['-c', 'command -v "$1"', 'which', cmd], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}
// Resolve what "latest" means once per invocation so renderer and runtime stay
// aligned on the SAME version (mismatched versions break the official UI).
// Proxy precedence: --host-proxy flag > config hostProxy > ZCODE_HTTP_PROXY env.
function upgradeProxy() {
  const cfg = loadConfig();
  return resolveUpgradeProxy(flag('host-proxy', (cfg && cfg.hostProxy) || ''));
}
async function resolveTargetVersion({ log } = {}) {
  const explicit = (flag('version') || process.env.ZCODE_VERSION || '').trim();
  if (explicit) return { version: explicit, source: '--version / ZCODE_VERSION' };
  try {
    const found = await fetchLatestVersion({ log, proxy: upgradeProxy() });
    return found;
  } catch (e) {
    if (log) log('! 获取官网最新版本失败（' + e.message + '），改用内置默认版本 v' + DEFAULT_VERSION);
    return { version: DEFAULT_VERSION, source: '内置默认（官网不可达）' };
  }
}
function hasCredentials() {
  try {
    const raw = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
    return !!(raw && (raw['oauth:bigmodel:access_token'] || raw['oauth:zai:access_token'] || raw.zaiAccessToken || raw.zcodejwttoken));
  } catch (_e) { return false; }
}
function serverRootFound() {
  try { return resolveServerRoot(); } catch (_e) { return ''; }
}
function rendererReady() {
  return existsSync(path.join(PATHS.rendererDir, 'index.html'));
}
function serverRootTarget() {
  const cfg = loadConfig();
  return (process.env.ZCODE_SERVER_RUNTIME_ROOT || (cfg && cfg.serverRoot) || SERVER_ROOT_DEFAULT).trim() || SERVER_ROOT_DEFAULT;
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_e) { return false; }
}
function readPid() {
  try {
    const pid = Number(readFileSync(path.join(PATHS.dataHome, 'zcode-webui.pid'), 'utf8').trim());
    return pid > 0 ? pid : 0;
  } catch (_e) { return 0; }
}
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function sanePort(v, def = 3102) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? n : def;
}
async function healthInfo(port, base, timeoutMs = 3000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) { return null; }
}
async function waitHealthy(port, base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthInfo(port, base, 1500)) return true;
    sleepMs(400);
  }
  return false;
}

// Verify a PID really belongs to this service before signaling it — a stale
// pid file whose number was recycled by an unrelated process must not be killed.
function procCmdline(pid) {
  try {
    return readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').trim();
  } catch (_e) {
    try {
      const r = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
      return r.status === 0 ? (r.stdout || '').trim() : '';
    } catch (_e2) { return ''; }
  }
}
function pidIsOurs(pid) {
  const c = procCmdline(pid);
  if (!c) return false; // cannot verify → do not touch
  return c.includes('server.mjs') || c.includes('zcode-webui');
}

async function serviceRunningInfo() {
  const cfg = loadConfig();
  const port = sanePort(process.env.ZCODE_WEBUI_PORT || (cfg && cfg.port));
  const base = process.env.ZCODE_WEBUI_BASE_PATH || (cfg && cfg.basePath) || '';
  const body = await healthInfo(port, base, 2000);
  const pid = readPid();
  if (body) {
    return { running: true, via: 'HTTP :' + port + (pid ? ' (pid ' + pid + ')' : ''), pid: pid || null, port };
  }
  if (pid && pidAlive(pid)) return { running: true, via: 'pid ' + pid, pid, port };
  return { running: false, pid: null, port };
}
function stopRunningService(info) {
  if (info.pid && pidAlive(info.pid)) {
    if (!pidIsOurs(info.pid)) {
      warn('pid 文件里的进程不属于本服务（' + procCmdline(info.pid).slice(0, 80) + '），拒绝停止；请手动处理');
      return false;
    }
    try { process.kill(info.pid, 'SIGTERM'); } catch (_e) { /* ignore */ }
    for (let i = 0; i < 50; i++) {
      if (!pidAlive(info.pid)) break;
      sleepMs(100);
    }
    if (pidAlive(info.pid)) { try { process.kill(info.pid, 'SIGKILL'); } catch (_e) { /* ignore */ } sleepMs(200); }
    return !pidAlive(info.pid);
  }
  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'zcode-webui.service');
  if (existsSync(unit) && which('systemctl')) {
    const r = spawnSync('systemctl', ['--user', 'stop', 'zcode-webui'], { stdio: 'inherit' });
    return r.status === 0;
  }
  return false;
}
function startService(info) {
  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'zcode-webui.service');
  if (existsSync(unit) && which('systemctl')) {
    const r = spawnSync('systemctl', ['--user', 'start', 'zcode-webui'], { stdio: 'inherit' });
    if (r.status === 0) return true;
    // systemd may exist but not run a user session (WSL / containers) — fall back
    log('! systemctl --user start 失败（exit ' + r.status + '），改用后台方式启动');
  }
  if (info.port) {
    try {
      const { pid, logFile } = startDetached(info.port);
      ok('已启动服务 pid=' + pid + '（日志: ' + logFile + '）');
      return true;
    } catch (e) {
      fail('启动失败: ' + ((e && e.message) || e));
      return false;
    }
  }
  return false;
}
function loadConfig() {
  try { return JSON.parse(readFileSync(PATHS.configFile, 'utf8')); } catch (_e) { return null; }
}
async function httpGet(url, timeoutMs = 8000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    return { ok: res.ok, status: res.status };
  } catch (_e) { return { ok: false, status: String(_e && _e.name || 'error') }; }
}
function readPkgVersion() { return pkg.version; }

// ---------- runtime guidance ----------
// The official runtime (~/.zcode/server: zcode-server.cjs + bundled node + agents)
// is NOT shipped inside the desktop installer packages; the official desktop
// provisions it through its own remote-component channel on first run. So the
// wizard guides instead of guessing: install/run the official desktop once on a
// machine of the same platform, or copy an existing ~/.zcode/server directory
// over (scp/rsync), then point ZCODE_SERVER_RUNTIME_ROOT at it when needed.
function runtimeGuidance() {
  log('运行时来自官方桌面端首次运行时的自动部署，本向导不代为下载。任选其一：');
  log('  1. 在本机（或同平台机器）安装并运行一次官方 ZCode 桌面端 → 自动生成 ~/.zcode/server；');
  log('  2. 从已运行过桌面端的机器复制目录（含权限）：');
  log('     scp -r user@host:~/.zcode/server ~/.zcode/server');
  log('  3. 若运行时在其它路径，设置环境变量 ZCODE_SERVER_RUNTIME_ROOT 指向它。');
  log('完成后重跑: zcode-webui setup');
}

// ---------- CLI headless config (~/.zcode/cli/config.json) ----------
function desktopCodingPlanKey() {
  try {
    const d = JSON.parse(readFileSync(DESKTOP_CONFIG, 'utf8'));
    return (d && d.provider && d.provider['builtin:bigmodel-coding-plan'] &&
      d.provider['builtin:bigmodel-coding-plan'].options || {}).apiKey || '';
  } catch (_e) { return ''; }
}
function buildCliConfig() {
  try {
    const key = desktopCodingPlanKey();
    if (!key) return false;
    const sample = JSON.parse(readFileSync(CLI_SAMPLE, 'utf8'));
    delete sample._comment;
    sample.provider.bigmodel.options.apiKey = key;
    mkdirSync(path.dirname(CLI_CONFIG), { recursive: true });
    writeFileSync(CLI_CONFIG, JSON.stringify(sample, null, 2), { mode: 0o600 });
    return true;
  } catch (_e) { return false; }
}

// ---------- systemd user unit ----------
function writeSystemdUnit(port, basePath) {
  const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  const env = [];
  env.push(`Environment=ZCODE_WEBUI_HOME=${PATHS.dataHome}`);
  env.push(`Environment=ZCODE_WEBUI_PORT=${port}`);
  if (basePath) env.push(`Environment=ZCODE_WEBUI_BASE_PATH=${basePath}`);
  const unit = `[Unit]
Description=zcode-webui
After=network-online.target

[Service]
ExecStart=${process.execPath} ${SERVER_JS}
Restart=on-failure
${env.join('\n')}

[Install]
WantedBy=default.target
`;
  const file = path.join(dir, 'zcode-webui.service');
  writeFileSync(file, unit, { mode: 0o644 });
  return file;
}

// ---------- start (detached, used by setup) ----------
function startDetached(port) {
  const logFile = path.join(PATHS.dataHome, 'zcode-webui.log');
  mkdirSync(PATHS.dataHome, { recursive: true });
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, [SERVER_JS, '--port', String(port)], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ZCODE_WEBUI_HOME: PATHS.dataHome },
  });
  child.unref();
  writeFileSync(path.join(PATHS.dataHome, 'zcode-webui.pid'), String(child.pid), { mode: 0o600 });
  return { pid: child.pid, logFile };
}

// ---------- commands ----------
async function cmdSetup() {
  const yes = hasFlag('--yes');
  log('');
  log('zcode-webui ' + readPkgVersion() + ' · setup');
  log('数据目录 (data home): ' + PATHS.dataHome);
  mkdirSync(PATHS.dataHome, { recursive: true });

  // 0. hard prerequisites
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!(nodeMajor >= 18)) {
    fail('需要 Node.js ≥ 18（当前 ' + process.versions.node + '），请先升级 Node');
    process.exit(1);
  }

  // 1. target version — resolved ONCE so renderer and runtime stay aligned
  log('');
  log('— 目标版本 —');
  const target = await resolveTargetVersion({ log });
  let platform;
  try { platform = platformKey(flag('arch', process.arch)); } catch (e) { warn(e.message); platform = null; }
  log('v' + target.version + '（来源: ' + target.source + '）');

  // 2. local tools
  log('');
  log('— 环境检查 —');
  const curl = which('curl');
  const dpkg = which('dpkg-deb');
  const tarBin = which('tar');
  curl ? ok('curl: ' + curl) : warn('未找到 curl（下载官方资产需要）');
  dpkg ? ok('dpkg-deb: ' + dpkg) : warn('未找到 dpkg-deb（提取渲染层需要）');
  tarBin ? ok('tar: ' + tarBin) : warn('未找到 tar（解包官方运行时组件需要）');

  // 3. official runtime — auto-installed from the official component channel
  //    when missing (the historic gap: setup used to stop at a warning here)
  log('');
  log('— 官方运行时 (~/.zcode/server) —');
  const root = serverRootFound();
  if (root) {
    ok('已存在: ' + root);
    const cur = currentServerAppVersion(root);
    if (cur && cur !== target.version) {
      log('  当前 v' + cur + '，目标 v' + target.version + '；需要对齐时运行: zcode-webui upgrade');
    }
  } else if (hasFlag('--no-server')) {
    warn('已跳过官方运行时安装（--no-server）；没有它服务可以启动但无法开启会话');
  } else if (!platform) {
    warn('当前平台无官方运行时组件可自动安装');
    runtimeGuidance();
  } else {
    log('未找到官方运行时，自动安装中（官方组件清单 → SHA256 校验 → 原子落位）…');
    try {
      await installServerRuntime({
        serverRoot: serverRootTarget(),
        version: target.version,
        platform,
        proxy: upgradeProxy(),
        tmpDir: path.join(PATHS.dataHome, '.upgrade-tmp'),
        log,
      });
      ok('官方运行时就绪: ' + serverRootTarget());
    } catch (e) {
      fail('自动安装失败: ' + e.message);
      runtimeGuidance();
    }
  }

  // 4. credentials (cannot be automated — OAuth needs the user's browser)
  log('');
  log('— 登录凭据 (~/.zcode/v2/credentials.json) —');
  if (hasCredentials()) {
    ok('凭据已存在（与官方客户端共用）');
  } else {
    warn('尚未登录。部署完成后打开 <服务地址>/login 完成 OAuth 登录，或用 /export-credentials.html 从桌面端导出凭据导入');
  }

  // 5. renderer
  log('');
  log('— 官方渲染层资产 —');
  if (rendererReady() && !hasFlag('--fetch')) {
    const rv = currentRendererVersion(PATHS.rendererDir);
    ok('已就绪: ' + PATHS.rendererDir + (rv ? '（v' + rv + '）' : ''));
  } else if (hasFlag('--no-fetch')) {
    warn('已跳过（--no-fetch）；稍后可用 zcode-webui fetch-renderer 补齐');
  } else {
    if (!curl || !dpkg) {
      fail('下载渲染层需要 curl 与 dpkg-deb（apt/dnf 安装后重试）');
      process.exit(1);
    }
    log('从官方 CDN 下载并提取 v' + target.version + ' …');
    try {
      runFetchRenderer({ packageRoot: PACKAGE_ROOT, dataHome: PATHS.dataHome, version: target.version, force: hasFlag('--fetch'), proxy: upgradeProxy(), log });
      ok('渲染层就绪: ' + PATHS.rendererDir);
    } catch (e) {
      fail(e.message);
      process.exit(1);
    }
  }

  // 6. service config (merged over any existing values)
  log('');
  log('— 服务配置 —');
  const old = loadConfig() || {};
  const cfg = {
    port: sanePort(flag('port', old.port || 3102)),
    basePath: flag('base-path', old.basePath || ''),
    workspace: flag('workspace', old.workspace || os.homedir()),
    locale: flag('locale', old.locale || 'zh-CN'),
    oauthProxy: flag('oauth-proxy', old.oauthProxy || ''),
    hostProxy: flag('host-proxy', old.hostProxy || ''),
    serverRoot: flag('server-root', old.serverRoot || ''),
  };
  if (!yes) {
    cfg.port = Number(await ask('端口', String(cfg.port))) || cfg.port;
    cfg.workspace = await ask('默认工作区目录', cfg.workspace);
    cfg.locale = await ask('界面语言', cfg.locale);
    cfg.basePath = await ask('URL 前缀（code-server 代理模式留空）', cfg.basePath);
    cfg.oauthProxy = await ask('OAuth 登录代理（服务器无法直连 zcode.z.ai 时填写）', cfg.oauthProxy);
    cfg.hostProxy = await ask('运行时/模型 API 代理（容器出网受限时填写）', cfg.hostProxy);
  }
  cfg.port = sanePort(cfg.port);
  writeFileSync(PATHS.configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  ok('已写入: ' + PATHS.configFile);

  // 7. CLI headless config (optional, local convenience)
  if (!existsSync(CLI_CONFIG) && desktopCodingPlanKey()) {
    const doCli = yes ? true : String(await ask('顺带生成官方 CLI 直连配置 ~/.zcode/cli/config.json？(Y/n)', 'Y')).toLowerCase() !== 'n';
    if (doCli) {
      buildCliConfig() ? ok('已生成 CLI 配置: ' + CLI_CONFIG) : warn('CLI 配置生成失败，可稍后手动处理');
    }
  }

  // 8. systemd user unit (opt-in)
  const wantUnit = hasFlag('--systemd') ? true
    : (!yes && !hasFlag('--no-systemd')
      ? String(await ask('生成 systemd 用户单元（开机自启，免 sudo）？(y/N)', 'N')).toLowerCase().startsWith('y')
      : false);
  let started = false;
  if (wantUnit) {
    const unitFile = writeSystemdUnit(cfg.port, cfg.basePath);
    ok('已生成: ' + unitFile);
    if (which('systemctl')) {
      const r1 = spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
      const r2 = spawnSync('systemctl', ['--user', 'enable', '--now', 'zcode-webui'], { stdio: 'inherit' });
      if (r1.status === 0 && r2.status === 0) {
        started = true;
        ok('服务已由 systemd 启动并设为开机自启');
      } else {
        warn('systemd 启用失败；可用后台方式启动: zcode-webui start');
      }
    } else {
      log('启用: systemctl --user enable --now zcode-webui');
    }
  }

  // 9. start now (default) + health gate
  if (!started && !hasFlag('--no-start')) {
    const doStart = hasFlag('--start') || yes ||
      !(String(await ask('现在启动服务？(Y/n)', 'Y')).toLowerCase().startsWith('n'));
    if (doStart) started = startService({ port: cfg.port });
  }
  if (started) {
    if (await waitHealthy(cfg.port, cfg.basePath)) {
      ok('健康检查通过（日志: ' + path.join(PATHS.dataHome, 'zcode-webui.log') + '）');
    } else {
      warn('服务进程已启动但健康检查暂未通过；查看日志: cat ' + path.join(PATHS.dataHome, 'zcode-webui.log'));
    }
  }

  // 10. summary
  log('');
  if (!started) {
    log('下一步: zcode-webui start   # 前台运行');
  }
  log('访问地址: http://127.0.0.1:' + cfg.port + (cfg.basePath ? cfg.basePath + '/' : '/'));
  if (!hasCredentials()) {
    log('登录引导: 浏览器打开 http://127.0.0.1:' + cfg.port + (cfg.basePath ? cfg.basePath : '') + '/login 完成登录');
  }
  log('日常管理: status | doctor | stop | upgrade');
  log('');
}

function cmdStart() {
  log('[zcode-webui] data home: ' + PATHS.dataHome);
  log('[zcode-webui] starting (Ctrl-C to stop)…');
  const args = process.argv.slice(3);
  const child = spawn(process.execPath, [SERVER_JS, ...args], {
    stdio: 'inherit',
    env: { ...process.env, ZCODE_WEBUI_HOME: PATHS.dataHome },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { try { child.kill(sig); } catch (_e) { /* ignore */ } });
  }
}

function cmdFetch() {
  const r = spawnSync('bash', [FETCH_SH], {
    stdio: 'inherit',
    env: { ...process.env, ZCODE_WEBUI_HOME: PATHS.dataHome },
  });
  process.exit(r.status ?? 1);
}

async function cmdUpgrade() {
  const yes = hasFlag('--yes');
  const force = hasFlag('--force');
  const serverOnly = hasFlag('--server-only');
  const rendererOnly = hasFlag('--renderer-only');
  const noBackup = hasFlag('--no-backup');
  const doRestart = hasFlag('--restart');
  const arch = flag('arch', process.arch);

  log('');
  log('zcode-webui ' + readPkgVersion() + ' · upgrade');
  log('数据目录 (data home): ' + PATHS.dataHome);
  if (serverOnly && rendererOnly) {
    fail('--server-only 与 --renderer-only 不能同时使用');
    process.exit(2);
  }

  // 1. target version: explicit flag, or the latest from the official website
  const target = await resolveTargetVersion({ log });
  const version = target.version;
  const source = target.source;
  let platform;
  try { platform = platformKey(arch); } catch (e) { fail(e.message); process.exit(2); }
  log('目标版本: v' + version + ' (' + platform + '，来源: ' + source + ')');

  // 2. current state vs target
  const serverRoot = serverRootTarget();
  const curRenderer = currentRendererVersion(PATHS.rendererDir);
  const curServer = currentServerAppVersion(serverRoot);
  log('当前渲染层: ' + (curRenderer || '未安装'));
  log('当前运行时: ' + (curServer || '未安装') + '（' + serverRoot + '）');

  const needRenderer = !serverOnly && (force || curRenderer !== version);
  const needServer = !rendererOnly && (force || curServer !== version);
  if (!needRenderer && !needServer) {
    if (serverOnly) ok('运行时已是最新 v' + version + '（--server-only 已跳过渲染层）');
    else if (rendererOnly) ok('渲染层已是最新 v' + version + '（--renderer-only 已跳过运行时）');
    else ok('前端与运行时均已是 v' + version + '，无需升级（--force 可强制重装）');
    return;
  }
  if (!needRenderer) log('渲染层已是最新，跳过');
  if (!needServer) log('运行时已是最新，跳过');

  // 3. running service: upgrade replaces the runtime dir, so stop first when asked
  const info = await serviceRunningInfo();
  let stopped = false;
  if (info.running && needServer) {
    if (doRestart) {
      log('停止运行中的服务（--restart）…');
      stopped = stopRunningService(info);
      if (!stopped) warn('无法自动停止服务（前台运行请先 Ctrl-C），将继续升级，请稍后手动重启');
    } else if (!yes) {
      const ans = String(await ask('检测到服务正在运行（' + info.via + '）。升级运行时会中断任务；是否停止后继续？(y/N)', 'N')).toLowerCase();
      if (!ans.startsWith('y')) { log('已取消'); return; }
      stopped = stopRunningService(info);
      if (!stopped) warn('无法自动停止服务（前台运行请先 Ctrl-C），将继续升级，请稍后手动重启');
    } else {
      warn('服务正在运行（--yes 未停止），升级后请手动重启服务');
    }
  }

  // 4. renderer (frontend)
  if (needRenderer) {
    try {
      // fetch-renderer.sh skips when vendor/renderer/index.html already exists,
      // so force re-extraction whenever the stored renderer version differs.
      runFetchRenderer({ packageRoot: PACKAGE_ROOT, dataHome: PATHS.dataHome, version, force: force || curRenderer !== version, proxy: upgradeProxy(), log });
      ok('渲染层已升级到 v' + version);
    } catch (e) {
      fail(e.message);
      if (needServer) log('运行时升级已取消（可先修复网络，或使用 --server-only 仅升级运行时）');
      process.exit(1);
    }
  }

  // 5. official server runtime
  if (needServer) {
    try {
      const result = await installServerRuntime({
        serverRoot,
        version,
        platform,
        force,
        keepBackup: !noBackup,
        proxy: upgradeProxy(),
        tmpDir: path.join(PATHS.dataHome, '.upgrade-tmp'),
        log,
      });
      if (result.installed) ok('运行时已升级到 v' + version);
    } catch (e) {
      fail(e.message);
      if (stopped) {
        log('升级失败，尝试恢复服务…');
        startService(info);
      }
      process.exit(1);
    }
  }

  // 6. restart / next steps
  if (needServer) {
    if (doRestart) {
      if (stopped) {
        startService(info) ? ok('服务已重启') : warn('服务重启失败，请手动启动: zcode-webui start');
      } else {
        warn('未自动重启服务；请手动重启: zcode-webui start 或 systemctl --user restart zcode-webui');
      }
    } else {
      log('');
      log('下一步: 重启服务使新运行时生效');
      log('  zcode-webui start                       # 前台运行');
      log('  systemctl --user restart zcode-webui    # systemd');
    }
  } else if (needRenderer) {
    log('渲染层升级完成，刷新浏览器即可（无需重启服务）');
  }
  log('');
}

async function cmdDoctor() {
  log('zcode-webui ' + readPkgVersion() + ' · doctor');
  log('node: ' + process.version + ' | data home: ' + PATHS.dataHome);
  const curl = which('curl'); const dpkg = which('dpkg-deb');
  log(curl ? 'curl: ok' : 'curl: MISSING');
  log(dpkg ? 'dpkg-deb: ok' : 'dpkg-deb: MISSING');
  const root = serverRootFound();
  const serverV = root ? currentServerAppVersion(root) : null;
  if (root) {
    log('runtime (' + root + '): ok' + (serverV ? ' (v' + serverV + ')' : ''));
    const agentEntry = path.join(root, 'agents', 'glm', 'zcode.cjs');
    log(existsSync(agentEntry) ? 'agent server: ok (' + agentEntry + ')' : 'agent server: MISSING (重跑 zcode-webui upgrade 补齐运行时)');
  } else {
    log('runtime: MISSING (自动安装: zcode-webui setup，或安装官方桌面端)');
  }
  log(hasCredentials() ? 'credentials: ok' : 'credentials: MISSING (浏览器打开 /login 登录或导入)');
  const rendererV = currentRendererVersion(PATHS.rendererDir);
  log(rendererReady() ? 'renderer: ok' + (rendererV ? ' (v' + rendererV + ')' : '') : 'renderer: MISSING (zcode-webui fetch-renderer)');
  // renderer and runtime must be on the same official version or the UI breaks
  if (root && rendererReady()) {
    if (serverV && rendererV && serverV !== rendererV) {
      log('version alignment: MISMATCH (runtime v' + serverV + ' vs renderer v' + rendererV + ') — 运行 zcode-webui upgrade 对齐');
    } else {
      log('version alignment: ok');
    }
  }
  const cfg = loadConfig();
  const port = sanePort(process.env.ZCODE_WEBUI_PORT || (cfg && cfg.port));
  const base = process.env.ZCODE_WEBUI_BASE_PATH || (cfg && cfg.basePath) || '';
  const body = await healthInfo(port, base, 3000);
  body
    ? log(`service: running on :${port}${base}/`)
    : log('service: not running');
  if (hasFlag('--net')) {
    log('network checks (8s timeout)…');
    for (const [name, url] of [
      ['cdn-zcode.z.ai', 'https://cdn-zcode.z.ai/'],
      ['zcode.z.ai', 'https://zcode.z.ai/'],
      ['open.bigmodel.cn', 'https://open.bigmodel.cn/'],
    ]) {
      const r = await httpGet(url);
      // any HTTP status received means the host is reachable (403/404 on the
      // bare root are fine); only transport-level failures mean unreachable
      log(`  ${name}: ${typeof r.status === 'number' ? 'reachable (HTTP ' + r.status + ')' : 'unreachable (' + r.status + ')'}`);
    }
  }
}

async function cmdStatus() {
  const cfg = loadConfig();
  const port = sanePort(process.env.ZCODE_WEBUI_PORT || (cfg && cfg.port));
  const base = process.env.ZCODE_WEBUI_BASE_PATH || (cfg && cfg.basePath) || '';
  const body = await healthInfo(port, base, 3000);
  if (!body) {
    log('zcode-webui is not running (port ' + port + base + ')');
    process.exit(1);
  }
  log(JSON.stringify(body, null, 2));
}

async function cmdStop() {
  const info = await serviceRunningInfo();
  if (!info.running) {
    log('zcode-webui is not running');
    return;
  }
  if (!info.pid) {
    // running but we don't know the pid (systemd unit without pidfile / foreign instance)
    const stopped = stopRunningService(info);
    if (stopped) { ok('已停止 systemd 服务'); return; }
    fail('无法定位服务进程 pid（前台启动的请用 Ctrl-C 停止）');
    process.exit(1);
  }
  stopRunningService(info)
    ? ok('已停止 zcode-webui (pid ' + info.pid + ')')
    : (fail('停止失败'), process.exit(1));
}

function cmdHelp() {
  log(`zcode-webui ${readPkgVersion()} — run the official ZCode desktop UI in a browser

Usage: zcode-webui <command> [options]

Commands:
  setup            一键部署：环境检查 → 目标版本解析 → 官方运行时自动安装（缺失时）
                   → 凭据检查 → 渲染层下载 → 配置 → (可选 systemd) → 启动 + 健康检查
                   flags: --yes 全部默认并启动（配 --no-start 只装不启）
                          --port N  --workspace PATH  --locale L  --base-path P
                          --oauth-proxy URL  --host-proxy URL  --server-root DIR
                          --version X.Y.Z  --arch x64|arm64
                          --fetch 强制重下渲染层  --no-fetch  --no-server 跳过运行时安装
                          --systemd 生成用户单元  --no-systemd  --no-start
  start            前台启动服务（Ctrl-C 停止；等价于 node src/server.mjs）
  stop             停止后台/systemd 运行的服务（前台进程请 Ctrl-C）
  fetch-renderer   下载官方渲染层资产（ZCODE_VERSION/ZCODE_ARCH 可选覆盖）
  upgrade          自动升级：从官网获取最新版本，同步升级前端渲染层与官方运行时
                   flags: --yes 非交互(不重启)  --restart 升级后重启服务
                          --force 同版本强制重装  --version X.Y.Z  --arch x64|arm64
                          --renderer-only  --server-only  --no-backup
  doctor           环境与就绪状态检查，含渲染层/运行时版本对齐检查（--net 附带网络连通性检查）
  status           服务健康状态（未运行返回非 0）
  version          版本号
  help             本帮助

环境变量: ZCODE_WEBUI_HOME（数据目录，默认 ~/.zcode-webui）、ZCODE_WEBUI_PORT、
          ZCODE_WEBUI_BASE_PATH、ZCODE_WEBUI_WORKSPACE、ZCODE_WEBUI_OAUTH_PROXY、
          ZCODE_WEBUI_HOST_PROXY、ZCODE_SERVER_RUNTIME_ROOT、ZCODE_VERSION、ZCODE_ARCH`);
}

// ---------- main ----------
const cmd = process.argv[2] || 'help';
(async () => {
  switch (cmd) {
    case 'setup': await cmdSetup(); break;
    case 'start': cmdStart(); break;
    case 'stop': await cmdStop(); break;
    case 'fetch-renderer': cmdFetch(); break;
    case 'upgrade': await cmdUpgrade(); break;
    case 'doctor': await cmdDoctor(); break;
    case 'status': await cmdStatus(); break;
    case 'version': case '-v': case '--version': log(readPkgVersion()); break;
    case 'help': case '-h': case '--help': cmdHelp(); break;
    default: cmdHelp(); process.exit(cmd === 'help' ? 0 : 2);
  }
})();
