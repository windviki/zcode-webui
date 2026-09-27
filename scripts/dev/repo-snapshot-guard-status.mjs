// Guard health check: is the repo-snapshot kill switch still effective against the
// runtime that is actually deployed right now?
//
// Answers three questions in one shot:
//   1. what versions are running (app / official runtime / renderer stamp),
//   2. do the guard's hooks still line up with the official runtime bundle
//      (credential endpoint, "no credential => abort" early return, artifact
//      fingerprints, checkpoint paths, transport via globalThis.fetch),
//   3. is the guard actually loaded in the live host process, has it blocked
//      anything lately, and did any checkpoint artifact appear *after* the guard
//      was armed (which would mean the switch is leaking).
//
// Usage: node scripts/dev/repo-snapshot-guard-status.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(PROJECT_ROOT, 'src', 'repo-snapshot-guard.cjs');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { return null; }
}

function get(port, route) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (_e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const ok = (label, value, detail) => console.log(`  ${value ? 'OK  ' : 'WARN'}  ${label}${detail ? '  — ' + detail : ''}`);

const port = (readJson(path.join(PROJECT_ROOT, 'config.json')) || {}).port || 3102;
const health = await get(port, '/api/health');
console.log('versions');
ok('zcode-webui answering on port ' + port, Boolean(health), health ? 'app ' + health.version + ', runtime ' + (health.hostVersion || '(no host yet)') : 'no /api/health');
const rendererStamp = (() => { try { return fs.readFileSync(path.join(PROJECT_ROOT, 'vendor', 'renderer', '.version'), 'utf8').trim(); } catch (_e) { return null; } })();
console.log('  renderer stamp: ' + (rendererStamp || '(missing)'));

// ---- 2. do the guard hooks still match the deployed runtime bundle? ----
const serverRoot = (health && health.serverRoot) || path.join(os.homedir(), '.zcode', 'server');
const bundlePath = path.join(serverRoot, 'zcode-server.cjs');
console.log('\nruntime hooks (' + bundlePath + ')');
let bundle = null;
try { bundle = fs.readFileSync(bundlePath, 'utf8'); } catch (_e) { /* handled below */ }
if (!bundle) {
  console.log('  WARN  cannot read the runtime bundle');
} else if (!['repoSnapshot', 'captureBeforePrompt', '/api/v1/snapshot/upload-credential', 'repo-snapshot.tar.gz.enc']
    .some((m) => bundle.includes(m))) {
  // Verified on 3.14.3 (2026-09-27): the vendor REMOVED the whole silent
  // workspace-snapshot pipeline — repoSnapshot/captureBeforePrompt/openAsBlob/
  // repo-snapshot.tar.gz.enc all absent from zcode-server.cjs and zcode.cjs
  // (the two remaining upload-credential hits belong to feedback attachments).
  // No capture code => nothing to hook: report OK instead of a wall of
  // "pattern not found" WARNs that would force a pointless rollback.
  console.log('  OK    snapshot capture code absent from the runtime — vendor removed the feature; the guard has nothing to hook (harmless if still preloaded)');
} else {
  const hooks = [
    ['credential endpoint /api/v1/snapshot/upload-credential', bundle.includes('/api/v1/snapshot/upload-credential')],
    ['layer 1: null credential aborts the capture', /if \(!uploadKey\)\s*\{\s*return;/.test(bundle) || /if \(!uploadKey\) return;/.test(bundle)],
    ['layer 1: credential request goes through globalThis.fetch', bundle.includes('globalThis.fetch')],
    ['layer 2: artifact name repo-snapshot.tar.gz.enc', bundle.includes('repo-snapshot.tar.gz.enc')],
    ['layer 2: OSS form fields (x-oss-signature / security token)', bundle.includes('x-oss-signature') && bundle.includes('x-oss-security-token')],
    ['layer 2b: artifact read hooks exist (openAsBlob / createReadStream)', bundle.includes('openAsBlob') && bundle.includes('createReadStream')],
    ['layer 3: checkpoint artifact dirs tmp/ pending/', bundle.includes('"tmp", `${groupId}.tar.gz`') && bundle.includes('"pending", `${groupId}.tar.gz.enc`')],
  ];
  for (const [label, present] of hooks) ok(label, present, present ? '' : 'pattern not found — re-verify the guard');
  // 3.12.3 uploads the artifact with the runtime's BUNDLED undici fetch, which a preload cannot
  // patch: the fetch-fingerprint half of layer 2 cannot fire there, layers 1/2b/3 carry the load.
  const bundledUndiciUpload = /objectUploadFetch \?\? import_undici\w*\.fetch/.test(bundle) || /objectUploadFetch \?\? import_undici\w*\.fetch/.test(bundle);
  console.log('  note  object upload transport: ' + (bundledUndiciUpload
    ? 'runtime bundled undici (layer 2 fetch fingerprint inactive -> layers 1/2b/3 are load-bearing)'
    : 'globalThis.fetch (layer 2 fetch fingerprint active)'));
  const inert = (bundle.match(/repoSnapshotIndexingEnabled/g) || []).length;
  console.log(`  note  repoSnapshotIndexingEnabled occurrences: ${inert} (schema/patch/name-list only => the official setting is still a no-op)`);
  if (health && health.hostVersion) {
    const host = health.hostVersion;
    const cmd = `grep -c "snapshot/upload-credential" "${bundlePath}"`;
    try {
      const n = execFileSync('bash', ['-lc', cmd], { encoding: 'utf8' }).trim();
      console.log(`  note  runtime ${host}: snapshot endpoint occurrences: ${n}`);
    } catch (_e) { /* ignore */ }
  }
}

// ---- 3. live host: preload loaded? blocks logged? artifacts after arming? ----
console.log('\nlive host');
let hostPid = null;
try {
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline = '';
    try { cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8'); } catch (_e) { continue; }
    if (cmdline.includes('zcode-server.cjs')) { hostPid = entry; break; }
  }
} catch (_e) { /* not linux */ }
if (!hostPid) {
  console.log('  note  no host process right now (it is spawned on the first client connect)');
} else {
  let env = '';
  try { env = fs.readFileSync(`/proc/${hostPid}/environ`, 'utf8'); } catch (_e) { /* ignore */ }
  ok(`host pid ${hostPid} has the guard preloaded (NODE_OPTIONS)`, env.includes(GUARD), env.includes(GUARD) ? '' : 'NODE_OPTIONS missing — restart the service');
}

const logPath = path.join(PROJECT_ROOT, 'zcode-webui.log');
let armedAt = null;
let blocked = 0;
let lastBlocked = null;
if (fs.existsSync(logPath)) {
  const size = fs.statSync(logPath).size;
  const from = Math.max(0, size - 8 * 1024 * 1024);
  const fd = fs.openSync(logPath, 'r');
  const buf = Buffer.alloc(size - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  let lastTs = null;
  for (const line of buf.toString('utf8').split('\n')) {
    const ts = line.match(/\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\.\d+\]/);
    if (ts) lastTs = ts[1];
    if (line.includes('repo-snapshot-guard:')) {
      if (line.includes('armed')) armedAt = lastTs;
      if (line.includes('blocked upload-credential')) { blocked++; lastBlocked = { at: lastTs, line: line.trim().slice(0, 150) }; }
    }
  }
}
console.log('\nguard activity (last 8 MiB of the service log)');
ok('guard armed in at least one host', Boolean(armedAt), armedAt ? 'last armed at ' + armedAt : 'no armed line found');
console.log(`  note  blocked upload-credential requests: ${blocked}`);
if (lastBlocked) console.log('        last: [' + lastBlocked.at + '] ' + lastBlocked.line.replace(/^\[host:stderr\]\s*/, ''));

// Any checkpoint artifact newer than the last "armed" line means the switch leaked.
const checkpoints = path.join(process.env.ZCODE_HOME ? path.join(process.env.ZCODE_HOME, 'v2') : path.join(os.homedir(), '.zcode', 'v2'), 'checkpoints');
let newest = null;
try {
  for (const dir of fs.readdirSync(checkpoints)) {
    const full = path.join(checkpoints, dir);
    let stat;
    try { stat = fs.statSync(full); } catch (_e) { continue; }
    if (!stat.isDirectory()) continue;
    for (const sub of ['manifests', 'extra-manifests', 'pending', 'tmp']) {
      const p = path.join(full, sub);
      let files = [];
      try { files = fs.readdirSync(p); } catch (_e) { continue; }
      for (const file of files) {
        const fp = path.join(p, file);
        let fstat;
        try { fstat = fs.statSync(fp); } catch (_e) { continue; }
        if (!newest || fstat.mtime > newest.mtime) newest = { mtime: fstat.mtime, file: fp };
      }
    }
  }
} catch (_e) { /* no checkpoints dir */ }
if (newest) {
  console.log('  note  newest checkpoint artifact: ' + newest.mtime.toISOString() + '  ' + newest.file);
  const armedDate = armedAt ? new Date(armedAt.replace(' ', 'T') + 'Z') : null;
  const freshArtifactAfterArming = armedDate && newest.mtime.getTime() > armedDate.getTime() + 60_000;
  ok('no snapshot artifact written after the guard was armed', !freshArtifactAfterArming,
    freshArtifactAfterArming ? 'artifact is newer than the last arming — investigate' : '');
} else {
  console.log('  note  no checkpoint artifacts found');
}

console.log('\nreminder: layer 1 fires per prompt; a fresh host starts the counter at #1, so after your next');
console.log('chat turn you should see "blocked upload-credential request #1" here (or no line at all if the');
console.log('client stopped asking). Escape hatch: ZCODE_WEBUI_ALLOW_REPO_SNAPSHOT=1.');
