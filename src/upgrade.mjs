// zcode-webui upgrade: fetch the latest official ZCode release and upgrade BOTH
// the browser renderer (vendor/renderer) and the official server runtime
// (~/.zcode/server) to matching versions.
//
// Version discovery
//   The official docs/changelog pages embed the current release version in a
//   Next.js flight payload as \"version\":\"X.Y.Z\". We parse the changelog page
//   (fallback: install page) and take the highest semver.
//
// Renderer
//   Same path as `zcode-webui fetch-renderer`: download the official .deb
//   installer from cdn-zcode.z.ai and extract out/renderer.
//
// Server runtime
//   The official desktop does NOT ship the server inside the installer; it
//   downloads per-version component tarballs listed in
//     https://cdn-zcode.z.ai/zcode/electron/releases/<ver>/manifest-<platform>.json
//   and materializes them under ~/.zcode/server. We replicate that layout:
//     server-bundle  -> zcode-server.cjs
//     node-runtime   -> node
//     node-pty       -> build/Release/pty.node
//     glm            -> agents/glm/ (zcode.cjs + packages/)
//     bfs/ripgrep/ugrep -> tools/<id>/<binary>
//   plus .asset-components/<id>.json markers and .version files, so doctor and
//   future upgrades can tell which version is installed.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CDN_BASE = 'https://cdn-zcode.z.ai/zcode/electron/releases';

// Pinned fallback when the website cannot be reached. JS callers import this so
// the default never drifts between modules; scripts/fetch-renderer.sh carries
// the same value for standalone shell usage — keep the two in sync.
export const DEFAULT_VERSION = '3.9.2';

const LATEST_PAGE_URLS = [
  'https://zcode.z.ai/cn/changelog',
  'https://zcode.z.ai/en/changelog',
  'https://zcode.z.ai/cn/docs/install',
  'https://zcode.z.ai/en/docs/install',
];

// component id -> where its tarball content lands inside ~/.zcode/server
const COMPONENT_TARGETS = {
  'server-bundle': '.',
  'node-runtime': '.',
  'node-pty': 'build/Release',
  'glm': 'agents/glm',
  'bfs': 'tools/bfs',
  'ripgrep': 'tools/ripgrep',
  'ugrep': 'tools/ugrep',
};

// files that must be executable after extraction (path relative to server root)
const EXECUTABLE_REL_PATHS = [
  'node',
  'zcode-server.cjs',
  'agents/glm/zcode.cjs',
  'tools/bfs/bfs',
  'tools/ripgrep/rg',
  'tools/ugrep/ugrep',
];

// ---------- helpers ----------

function logDefault(line) { console.log(line); }

let curlPathCache;
function curlBin() {
  if (curlPathCache === undefined) {
    const r = spawnSync('sh', ['-c', 'command -v "$1"', 'which', 'curl'], { encoding: 'utf8' });
    curlPathCache = r.status === 0 ? (r.stdout || '').trim() : '';
  }
  return curlPathCache;
}

// Effective proxy for ALL remote operations here. Precedence: explicit argument
// → ZCODE_HTTP_PROXY (the project-wide convention, honored by curl natively)
// → none. Plain fetch() ignores proxy env entirely, which silently breaks every
// download behind a filtering firewall — hence curl-first everywhere below.
export function resolveUpgradeProxy(explicit = '') {
  return (String(explicit || process.env.ZCODE_HTTP_PROXY || '')).trim();
}

// GET a text resource. curl first (honors --proxy, streams reliably),
// plain fetch as fallback when curl is unavailable.
async function readRemoteText(url, { proxy = '', timeoutMs = 20000 } = {}) {
  const bin = curlBin();
  if (bin) {
    const args = [bin, '-fsSL', '--max-time', String(Math.ceil(timeoutMs / 1000))];
    if (proxy) args.push('--proxy', proxy);
    args.push(url);
    const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.length > 0) return r.stdout;
    // fall through to fetch so transient curl/shell failures still get a chance
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return res.text();
}

export function platformKey(arch = process.arch) {
  if (process.platform !== 'linux') {
    throw new Error('upgrade 目前仅支持 Linux（官方运行时组件只发布 linux-x64 / linux-arm64）');
  }
  const a = String(arch).trim();
  if (a === 'x64' || a === 'arm64') return 'linux-' + a;
  throw new Error('不支持的架构: ' + arch + '（仅支持 x64 / arm64）');
}

function maxSemver(list) {
  let best = '';
  for (const v of list) {
    if (!/^\d+\.\d+\.\d+$/.test(v)) continue;
    if (!best || v.localeCompare(best, undefined, { numeric: true }) > 0) best = v;
  }
  return best || null;
}

export function parseVersionsFromPage(html) {
  // the official site embeds the releases as JSON inside a Next.js flight
  // payload, with quotes escaped as \" in the HTML source
  const re = /\\"version\\":\\"(\d+\.\d+\.\d+)\\"/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

// Latest version from the official website (changelog page, install page as fallback).
export async function fetchLatestVersion({ log = logDefault, proxy = '' } = {}) {
  let lastErr = null;
  for (const url of LATEST_PAGE_URLS) {
    try {
      log('查询官方最新版本: ' + url);
      const html = await readRemoteText(url, { proxy });
      const version = maxSemver(parseVersionsFromPage(html));
      if (version) return { version, source: url };
      lastErr = new Error('页面中未找到版本号: ' + url);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('无法从官网获取最新版本');
}

// Component manifest for a version+platform (the same file the official desktop uses).
export async function fetchManifest(version, platform = platformKey(), { proxy = '' } = {}) {
  const url = `${CDN_BASE}/${encodeURIComponent(version)}/manifest-${encodeURIComponent(platform)}.json`;
  let lastErr = null;
  // one retry for transient CDN/transport hiccups
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await readRemoteText(url, { proxy, timeoutMs: 30000 });
      const manifest = JSON.parse(text);
      if (!manifest || manifest.appVersion !== version || !Array.isArray(manifest.components)) {
        throw new Error('官方运行时清单格式异常: ' + url);
      }
      return manifest;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

// ---------- current state ----------

export function currentRendererVersion(rendererDir) {
  try {
    const v = readFileSync(path.join(rendererDir, '.version'), 'utf8').trim();
    return v || null;
  } catch (_e) { return null; }
}

export function readServerComponentMeta(serverRoot, id) {
  try {
    return JSON.parse(readFileSync(path.join(serverRoot, '.asset-components', id + '.json'), 'utf8'));
  } catch (_e) { return null; }
}

export function currentServerAppVersion(serverRoot) {
  const meta = readServerComponentMeta(serverRoot, 'server-bundle');
  if (meta && meta.version) {
    const m = /^v?(\d+\.\d+\.\d+)/.exec(meta.version);
    return m ? m[1] : meta.version;
  }
  // Older official-desktop installs keep no version in .asset-components;
  // ask the server bundle itself (the same check the desktop performs).
  try {
    const nodeBin = path.join(serverRoot, 'node');
    const serverJs = path.join(serverRoot, 'zcode-server.cjs');
    if (existsSync(nodeBin) && existsSync(serverJs)) {
      const r = spawnSync(nodeBin, [serverJs, '--version'], { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0) {
        const v = String(r.stdout || '').trim().split(/\s+/)[0];
        if (/^\d+\.\d+\.\d+$/.test(v)) return v;
      }
    }
  } catch (_e) { /* ignore */ }
  return null;
}

function runtimeUpToDate(serverRoot, manifest) {
  for (const c of manifest.components) {
    const meta = readServerComponentMeta(serverRoot, c.id);
    if (!meta || meta.version !== c.version || meta.sha256 !== c.sha256 || meta.platformArch !== manifest.platformArch) {
      return false;
    }
  }
  return true;
}

// ---------- renderer ----------

// Runs scripts/fetch-renderer.sh with the target version (and FORCE when the
// stored renderer version differs from the target). The proxy, when given, is
// also exported as standard https_proxy/http_proxy envs so the curl inside the
// shell script goes through it.
export function runFetchRenderer({ packageRoot, dataHome, version, force = false, proxy = '', log = logDefault }) {
  const script = path.join(packageRoot, 'scripts', 'fetch-renderer.sh');
  log('下载官方渲染层 v' + version + '（官方安装包 → out/renderer）…');
  const env = { ...process.env, ZCODE_WEBUI_HOME: dataHome, ZCODE_VERSION: version, FORCE: force ? '1' : '0' };
  if (proxy) {
    env.https_proxy = proxy;
    env.HTTPS_PROXY = proxy;
    env.http_proxy = proxy;
    env.HTTP_PROXY = proxy;
  }
  const r = spawnSync('bash', [script], { stdio: 'inherit', env });
  if (r.status !== 0) throw new Error('渲染层下载/解包失败（bash exit ' + r.status + '）');
}

// ---------- server runtime ----------

function writeServerComponentMeta(root, component, platform) {
  const dir = path.join(root, '.asset-components');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, component.id + '.json'),
    JSON.stringify({ id: component.id, version: component.version, sha256: component.sha256, platformArch: platform }, null, 2) + '\n',
    { mode: 0o644 },
  );
}

async function sha256File(file) {
  const h = createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', resolve);
  });
  return h.digest('hex');
}

async function downloadFile(url, dest, { label, log, proxy = '' }) {
  log('  ↓ ' + label);
  const bin = curlBin();
  if (bin) {
    const args = [bin, '--fail', '-L', '--retry', '3', '-sS', '--max-time', '900'];
    if (proxy) args.push('--proxy', proxy);
    args.push('-o', dest, url);
    const r = spawnSync(args[0], args.slice(1));
    if (r.status !== 0) throw new Error(label + ' 下载失败（curl exit ' + r.status + '）' + (proxy ? ' [proxy]' : ''));
    return;
  }
  // no curl on this box: fall back to streaming fetch (no proxy support)
  const res = await fetch(url, { signal: AbortSignal.timeout(600000), redirect: 'follow' });
  if (!res.ok) throw new Error(label + ' 下载失败: HTTP ' + res.status + ' ' + url);
  await new Promise((resolve, reject) => {
    const out = createWriteStream(dest);
    res.body.pipe(out);
    res.body.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });
}

// Verify a downloaded archive against the manifest's sha256. The desktop does
// the same; shipping without this check would silently accept truncated or
// tampered archives.
async function verifySha256(archive, expected, label) {
  const actual = await sha256File(archive);
  if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) {
    throw new Error(label + ' 清单缺少有效的 sha256，拒绝安装');
  }
  if (actual.toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(label + ' SHA256 校验失败（清单 ' + expected.slice(0, 12) + '… vs 实际 ' + actual.slice(0, 12) + '…）');
  }
}

// rename(2) fails with EXDEV when stage dir and target live on different
// filesystems; fall back to copy+delete so upgrades still complete.
function moveDir(src, dest) {
  try {
    renameSync(src, dest);
    return;
  } catch (err) {
    if (err && err.code !== 'EXDEV') throw err;
  }
  cpSync(src, dest, { recursive: true });
  rmSync(src, { recursive: true, force: true });
}

function extractTarGz(archive, destDir, label) {
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['-xzf', archive, '-C', destDir], { stdio: 'inherit' });
  if (r.error) throw new Error(label + ' 解包失败: ' + r.error.message);
  if (r.status !== 0) throw new Error(label + ' 解包失败（tar exit ' + r.status + '）');
}

function assertRuntimeLayout(stageRoot) {
  const required = [
    'zcode-server.cjs',
    'node',
    path.join('agents', 'glm', 'zcode.cjs'),
    path.join('build', 'Release', 'pty.node'),
  ];
  const missing = required.filter((rel) => !existsSync(path.join(stageRoot, rel)));
  if (missing.length) throw new Error('官方运行时组件不完整，缺少: ' + missing.join(', '));
}

function chmodExecutables(stageRoot) {
  for (const rel of EXECUTABLE_REL_PATHS) {
    const p = path.join(stageRoot, rel);
    try { if (existsSync(p)) chmodSync(p, 0o755); } catch (_e) { /* ignore */ }
  }
}

function pruneOldBackups(serverRoot, keep) {
  const dir = path.dirname(serverRoot);
  const prefix = path.basename(serverRoot) + '.bak-';
  let entries = [];
  try { entries = readdirSync(dir).filter((n) => n.startsWith(prefix)).map((n) => path.join(dir, n)); } catch (_e) { return; }
  for (const p of entries) {
    if (p === keep) continue;
    try { rmSync(p, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
}

// Downloads all official runtime components for `version`, verifies sha256,
// stages a brand-new server root, then atomically swaps it in (the previous
// root is kept as <root>.bak-<version>-<ts> unless keepBackup is false).
export async function installServerRuntime({
  serverRoot, version, platform = platformKey(), force = false,
  keepBackup = true, proxy = '',
  tmpDir = path.join(os.tmpdir(), 'zcode-webui-upgrade'), log = logDefault,
} = {}) {
  const manifest = await fetchManifest(version, platform, { proxy });

  if (!force && runtimeUpToDate(serverRoot, manifest)) {
    log('官方运行时已是最新（' + version + '），跳过');
    return { installed: false, manifest, backupPath: null };
  }

  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const stageBase = path.join(tmpDir, 'server-' + version + '-' + Date.now());
  const stageRoot = path.join(stageBase, 'root');
  mkdirSync(stageRoot, { recursive: true });

  try {
    for (const component of manifest.components) {
      const target = COMPONENT_TARGETS[component.id];
      if (!target) {
        log('  ! 未知组件 ' + component.id + '，跳过（请升级 zcode-webui 以支持新组件）');
        continue;
      }
      const url = CDN_BASE + '/' + component.artifactPath.split('/').map(encodeURIComponent).join('/');
      const archive = path.join(stageBase, component.id + '.tar.gz');
      await downloadFile(url, archive, { label: component.id + ' ' + component.version, log, proxy });
      await verifySha256(archive, component.sha256, component.id);
      log('  ✓ SHA256 校验通过');
      extractTarGz(archive, path.join(stageRoot, target), component.id);
      rmSync(archive, { force: true });
      writeServerComponentMeta(stageRoot, component, platform);
      if (component.id === 'glm') {
        writeFileSync(path.join(stageRoot, 'agents', 'glm', '.version'), component.version + '\n');
      }
      if (component.id === 'bfs' || component.id === 'ripgrep' || component.id === 'ugrep') {
        writeFileSync(path.join(stageRoot, 'tools', component.id, '.version'), component.version + '\n');
      }
    }

    chmodExecutables(stageRoot);
    assertRuntimeLayout(stageRoot);
    log('校验新运行时结构 … 完成');

    // atomic swap: old root -> backup, staged root -> serverRoot
    const backup = serverRoot + '.bak-' + version + '-' + Date.now();
    let moved = false;
    try {
      if (existsSync(serverRoot)) {
        moveDir(serverRoot, backup);
        moved = true;
      }
      moveDir(stageRoot, serverRoot);
    } catch (err) {
      if (moved && existsSync(backup) && !existsSync(serverRoot)) {
        try { moveDir(backup, serverRoot); } catch (_e) { /* keep the backup as recovery */ }
      }
      throw err;
    }
    if (moved && keepBackup) {
      pruneOldBackups(serverRoot, backup);
      log('旧运行时已备份: ' + backup + '（如需回滚可改名恢复）');
    } else if (moved && !keepBackup) {
      rmSync(backup, { recursive: true, force: true });
    }
    log('官方运行时已升级: ' + serverRoot + ' (v' + version + ')');
    return { installed: true, manifest, backupPath: moved && keepBackup ? backup : null };
  } finally {
    rmSync(stageBase, { recursive: true, force: true });
  }
}
