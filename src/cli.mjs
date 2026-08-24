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

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATHS = resolvePaths(PACKAGE_ROOT);
const SERVER_JS = path.join(PACKAGE_ROOT, 'src', 'server.mjs');
const FETCH_SH = path.join(PACKAGE_ROOT, 'scripts', 'fetch-renderer.sh');
const CLI_SAMPLE = path.join(PACKAGE_ROOT, 'cli-config.example.json');

let pkg = { name: 'zcode-webui', version: '0.0.0' };
try { pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')); } catch (_e) { /* ignore */ }

const ZCODE_HOME = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
const CRED_FILE = path.join(ZCODE_HOME, 'v2', 'credentials.json');
const CLI_CONFIG = path.join(ZCODE_HOME, 'cli', 'config.json');
const DESKTOP_CONFIG = path.join(ZCODE_HOME, 'v2', 'config.json');
const SERVER_ROOT_DEFAULT = path.join(ZCODE_HOME, 'server');

// ---------- helpers ----------
function ask(question, def) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question + (def !== undefined && def !== '' ? ' [' + def + '] ' : ' '), (a) => {
      rl.close();
      resolve((a || '').trim() === '' ? def : a.trim());
    });
  });
}
function flag(name, def = '') {
  const args = process.argv.slice(2);
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
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
  const r = spawnSync('bash', ['-lc', 'command -v ' + cmd], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : '';
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

  // 1. prerequisites
  log('');
  log('— 环境检查 —');
  const curl = which('curl');
  const dpkg = which('dpkg-deb');
  curl ? ok('curl: ' + curl) : warn('未找到 curl（下载官方安装包需要）');
  dpkg ? ok('dpkg-deb: ' + dpkg) : warn('未找到 dpkg-deb（解包官方安装包需要）');

  // 2. official runtime
  log('');
  log('— 官方运行时 (~/.zcode/server) —');
  const root = serverRootFound();
  if (root) {
    ok('已存在: ' + root);
  } else {
    warn('未找到官方运行时（zcode-server.cjs）');
    runtimeGuidance();
  }

  // 3. credentials
  log('');
  log('— 登录凭据 (~/.zcode/v2/credentials.json) —');
  if (hasCredentials()) {
    ok('凭据已存在（与官方客户端共用）');
  } else {
    warn('尚未登录。启动后在浏览器打开 /login 完成 OAuth 登录，或用 /export-credentials.html 从桌面端导出凭据导入');
  }

  // 4. renderer
  log('');
  log('— 官方渲染层资产 —');
  if (rendererReady() && !hasFlag('--fetch')) {
    ok('已就绪: ' + PATHS.rendererDir);
  } else if (hasFlag('--no-fetch')) {
    warn('已跳过（--no-fetch）；稍后可用 zcode-webui fetch-renderer 补齐');
  } else {
    log('从官方 CDN 下载并提取（版本 ' + (process.env.ZCODE_VERSION || '3.8.1') + '，可用 ZCODE_VERSION 覆盖）…');
    const r = spawnSync('bash', [FETCH_SH], {
      stdio: 'inherit',
      env: { ...process.env, ZCODE_WEBUI_HOME: PATHS.dataHome },
    });
    if (r.status === 0) ok('渲染层就绪: ' + PATHS.rendererDir);
    else fail('渲染层下载失败（网络或磁盘问题），稍后重试: zcode-webui fetch-renderer');
  }

  // 5. config
  log('');
  log('— 服务配置 —');
  const old = loadConfig() || {};
  const cfg = {
    port: Number(flag('port', old.port || 3102)) || 3102,
    basePath: flag('base-path', old.basePath || ''),
    workspace: flag('workspace', old.workspace || os.homedir()),
    locale: flag('locale', old.locale || 'zh-CN'),
    oauthProxy: flag('oauth-proxy', old.oauthProxy || ''),
    hostProxy: flag('host-proxy', old.hostProxy || ''),
    serverRoot: old.serverRoot || '',
  };
  if (!yes) {
    cfg.port = Number(await ask('端口', String(cfg.port)));
    cfg.workspace = await ask('默认工作区目录', cfg.workspace);
    cfg.locale = await ask('界面语言', cfg.locale);
    cfg.basePath = await ask('URL 前缀（code-server 代理模式留空）', cfg.basePath);
    cfg.oauthProxy = await ask('OAuth 登录代理（服务器无法直连 zcode.z.ai 时填写）', cfg.oauthProxy);
    cfg.hostProxy = await ask('运行时/模型 API 代理（容器出网受限时填写）', cfg.hostProxy);
  }
  writeFileSync(PATHS.configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  ok('已写入: ' + PATHS.configFile);

  // 6. CLI headless config (optional, local convenience)
  if (!existsSync(CLI_CONFIG) && desktopCodingPlanKey()) {
    const doCli = yes ? true : String(await ask('顺带生成官方 CLI 直连配置 ~/.zcode/cli/config.json？(Y/n)', 'Y')).toLowerCase() !== 'n';
    if (doCli) {
      buildCliConfig() ? ok('已生成 CLI 配置: ' + CLI_CONFIG) : warn('CLI 配置生成失败，可稍后手动处理');
    }
  }

  // 7. systemd user unit
  if (!yes && !hasFlag('--no-systemd')) {
    const doUnit = String(await ask('生成 systemd 用户单元（开机自启，免 sudo）？(y/N)', 'N')).toLowerCase().startsWith('y');
    if (doUnit) {
      const unit = writeSystemdUnit(cfg.port, cfg.basePath);
      ok('已生成: ' + unit);
      log('启用: systemctl --user enable --now zcode-webui');
    }
  }

  // 8. start
  let started = false;
  if (!yes && !hasFlag('--no-start')) {
    const doStart = String(await ask('现在启动服务？(y/N)', 'N')).toLowerCase().startsWith('y');
    if (doStart) {
      const { pid, logFile } = startDetached(cfg.port);
      started = true;
      ok('已启动 pid=' + pid + '（日志: ' + logFile + '）');
    }
  }
  if (!started) {
    log('');
    log('下一步: zcode-webui start   # 前台运行');
    log('        systemctl --user enable --now zcode-webui   # 或使用 systemd');
  }
  log('访问地址: http://127.0.0.1:' + cfg.port + (cfg.basePath ? cfg.basePath + '/' : '/'));
  log('健康检查: zcode-webui status');
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

async function cmdDoctor() {
  log('zcode-webui ' + readPkgVersion() + ' · doctor');
  log('node: ' + process.version + ' | data home: ' + PATHS.dataHome);
  const curl = which('curl'); const dpkg = which('dpkg-deb');
  log(curl ? 'curl: ok' : 'curl: MISSING');
  log(dpkg ? 'dpkg-deb: ok' : 'dpkg-deb: MISSING');
  log(serverRootFound() ? 'runtime (~/.zcode/server): ok' : 'runtime: MISSING (安装官方桌面端或重跑 setup)');
  log(hasCredentials() ? 'credentials: ok' : 'credentials: MISSING (浏览器打开 /login 登录或导入)');
  log(rendererReady() ? 'renderer: ok' : 'renderer: MISSING (zcode-webui fetch-renderer)');
  const cfg = loadConfig();
  const port = Number(process.env.ZCODE_WEBUI_PORT || (cfg && cfg.port) || 3102);
  const base = process.env.ZCODE_WEBUI_BASE_PATH || (cfg && cfg.basePath) || '';
  const health = await httpGet(`http://127.0.0.1:${port}${base}/api/health`, 3000);
  health.ok ? log(`service: running on :${port}${base}/`) : log('service: not running');
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
  const port = Number(process.env.ZCODE_WEBUI_PORT || (cfg && cfg.port) || 3102);
  const base = process.env.ZCODE_WEBUI_BASE_PATH || (cfg && cfg.basePath) || '';
  const health = await httpGet(`http://127.0.0.1:${port}${base}/api/health`, 3000);
  if (!health.ok) {
    log('zcode-webui is not running (port ' + port + base + ')');
    process.exit(1);
  }
  const res = await fetch(`http://127.0.0.1:${port}${base}/api/health`);
  const body = await res.json();
  log(JSON.stringify(body, null, 2));
}

function cmdHelp() {
  log(`zcode-webui ${readPkgVersion()} — run the official ZCode desktop UI in a browser

Usage: zcode-webui <command> [options]

Commands:
  setup            交互式向导：环境检查 → 官方运行时 → 凭据 → 渲染层 → 配置 → (可选) systemd/启动
                   flags: --yes 全部采用默认值(不启动)  --port N  --workspace PATH  --locale L
                          --base-path P  --oauth-proxy URL  --host-proxy URL
                          --no-fetch  --fetch  --no-start  --no-systemd
  start            前台启动服务（Ctrl-C 停止；等价于 node src/server.mjs）
  fetch-renderer   下载官方渲染层资产（ZCODE_VERSION/ZCODE_ARCH 可选覆盖）
  doctor           环境与就绪状态检查（--net 附带网络连通性检查）
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
    case 'fetch-renderer': cmdFetch(); break;
    case 'doctor': await cmdDoctor(); break;
    case 'status': await cmdStatus(); break;
    case 'version': case '-v': case '--version': log(readPkgVersion()); break;
    case 'help': case '-h': case '--help': cmdHelp(); break;
    default: cmdHelp(); process.exit(cmd === 'help' ? 0 : 2);
  }
})();
