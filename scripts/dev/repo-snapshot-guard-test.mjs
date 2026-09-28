// Unit tests for the repo-snapshot kill switch (src/repo-snapshot-guard.cjs).
//
// The guard is a preload, so the tests exercise it exactly the way the host loads it:
// a plain Node process started with `--require <guard>` (that is what src/host.mjs
// injects through NODE_OPTIONS). Covered:
//   - the upload-credential request is answered locally with { code: 0, data: null }
//     (the shape the runtime maps to "no credential issued" => capture aborts);
//   - artifact uploads matching the snapshot fingerprint are refused with 403;
//   - unrelated requests still go to the network (nothing else is swallowed);
//   - checkpoint artifact writes (pending/tmp/manifests/extra-manifests) fail with
//     EACCES while state.json keeps working;
//   - ZCODE_WEBUI_ALLOW_REPO_SNAPSHOT=1 disarms everything.
//
// Usage: node scripts/dev/repo-snapshot-guard-test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'repo-snapshot-guard.cjs');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok || detail === undefined ? '' : '  [' + detail + ']'));
}

function runProbe(script, env = {}) {
  const res = spawnSync(process.execPath, ['--require', GUARD, '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const line = res.stdout.trim().split('\n').filter(Boolean).pop() || '';
  let json = null;
  try { json = JSON.parse(line); } catch (_e) { /* left null, reported below */ }
  return { json, stdout: res.stdout, stderr: res.stderr, status: res.status };
}

// ---------- network layer ----------
const credentialProbe = `
(async () => {
  const response = await fetch('https://zcode.z.ai/api/v1/snapshot/upload-credential?workspace_id=deadbeef', {
    headers: { authorization: 'Bearer test-token' },
  });
  console.log(JSON.stringify({ status: response.status, body: await response.json() }));
})().catch((error) => console.log(JSON.stringify({ error: String((error && error.message) || error) })));
`;
const credential = runProbe(credentialProbe);
check('upload-credential is answered locally', credential.json && credential.json.status === 200 && credential.json.body && credential.json.body.code === 0 && credential.json.body.data === null,
  JSON.stringify(credential.json));
check('block is logged to stderr', /blocked upload-credential request/.test(credential.stderr), credential.stderr.trim().split('\n').slice(-1)[0]);
check('guard announces itself as armed', /repo-snapshot-guard: armed/.test(credential.stderr));

const passthroughProbe = `
fetch('http://127.0.0.1:9/health').then((r) => console.log(JSON.stringify({ status: r.status })))
  .catch((error) => console.log(JSON.stringify({ network_error: String((error && error.cause && error.cause.code) || (error && error.message) || error) })));
`;
const passthrough = runProbe(passthroughProbe);
check('unrelated URL still hits the network', passthrough.json && typeof passthrough.json.network_error === 'string',
  JSON.stringify(passthrough.json));

const uploadProbe = `
(async () => {
  const form = new FormData();
  form.set('file', new Blob(['x']), 'repo-snapshot.tar.gz.enc');
  form.set('key', 'repo-snapshot/aa/bb.tar.gz.enc');
  const response = await fetch('https://bucket.oss-cn-hangzhou.aliyuncs.com/', { method: 'POST', body: form });
  console.log(JSON.stringify({ status: response.status }));
})().catch((error) => console.log(JSON.stringify({ error: String((error && error.message) || error) })));
`;
const upload = runProbe(uploadProbe);
check('snapshot artifact upload is refused with 403', upload.json && upload.json.status === 403, JSON.stringify(upload.json));

// ---------- filesystem layer ----------
const ZCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-webui-guard-'));
const wsRoot = path.join(ZCODE_HOME, 'v2', 'checkpoints', '0d8c5c9c184e');
for (const dir of ['pending', 'tmp', 'manifests', 'extra-manifests']) fs.mkdirSync(path.join(wsRoot, dir), { recursive: true });
// Payload + manifest fixtures are written by the UNGUARDED parent process: the guarded child
// must not be able to create them itself, but must be able to read the manifest and must be
// unable to read the payload (layer 2b).
fs.writeFileSync(path.join(wsRoot, 'pending', 'a.tar.gz.enc'), 'ciphertext-fixture');
fs.writeFileSync(path.join(wsRoot, 'tmp', 'a.tar.gz'), 'tarball-fixture');
fs.writeFileSync(path.join(wsRoot, 'manifests', 'm.json'), '{}');

const fsProbe = `
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const root = path.join(process.env.ZCODE_HOME, 'v2', 'checkpoints', '0d8c5c9c184e');
(async () => {
  const out = {};
  const attempt = async (key, fn) => { try { await fn(); out[key] = 'allowed'; } catch (error) { out[key] = error.code || String(error.message); } };
  await attempt('pendingSync', () => fs.writeFileSync(path.join(root, 'pending', 'a.tar.gz.enc'), 'x'));
  await attempt('tmpAsync', () => fsp.writeFile(path.join(root, 'tmp', 'a.tar.gz'), 'x'));
  await attempt('manifestSync', () => fs.writeFileSync(path.join(root, 'manifests', 'm.json'), '{}'));
  await attempt('extraManifestStream', () => { fs.createWriteStream(path.join(root, 'extra-manifests', 'e.json')); });
  await attempt('openForWrite', () => fs.openSync(path.join(root, 'pending', 'b.enc'), 'w'));
  await attempt('renameIntoPending', () => { fs.writeFileSync(path.join(root, 'scratch'), 'x'); fs.renameSync(path.join(root, 'scratch'), path.join(root, 'pending', 'c.enc')); });
  await attempt('stateWrite', () => fs.writeFileSync(path.join(root, 'state.json'), '{"ok":true}'));
  await attempt('readBack', () => { const v = fs.readFileSync(path.join(root, 'state.json'), 'utf8'); if (v !== '{"ok":true}') throw new Error('unexpected'); });
  await attempt('manifestRead', () => { fs.readFileSync(path.join(root, 'manifests', 'm.json'), 'utf8'); });
  await attempt('outsideWrite', () => fs.writeFileSync(path.join(process.env.ZCODE_HOME, 'other.json'), '{}'));
  // layer 2b: the payload cannot be read for upload, whichever fetch implementation is used
  await attempt('artifactOpenAsBlob', () => fs.openAsBlob(path.join(root, 'pending', 'a.tar.gz.enc')));
  await attempt('artifactReadStream', () => { const s = fs.createReadStream(path.join(root, 'pending', 'a.tar.gz.enc')); s.destroy(); });
  await attempt('artifactOpenRead', () => fsp.open(path.join(root, 'tmp', 'a.tar.gz'), 'r'));
  console.log(JSON.stringify(out));
})();
`;
const fsRun = runProbe(fsProbe, { ZCODE_HOME });
const fsResult = fsRun.json || {};
for (const key of ['pendingSync', 'tmpAsync', 'manifestSync', 'extraManifestStream', 'openForWrite', 'renameIntoPending']) {
  check('artifact write blocked: ' + key, fsResult[key] === 'EACCES', String(fsResult[key]));
}
for (const key of ['artifactOpenAsBlob', 'artifactReadStream', 'artifactOpenRead']) {
  check('artifact read blocked (layer 2b): ' + key, fsResult[key] === 'EACCES', String(fsResult[key]));
}
check('state.json stays writable (host health)', fsResult.stateWrite === 'allowed', String(fsResult.stateWrite));
check('reading state.json works', fsResult.readBack === 'allowed', String(fsResult.readBack));
check('reading manifests works (delta base)', fsResult.manifestRead === 'allowed', String(fsResult.manifestRead));
check('writes outside checkpoints/ are untouched', fsResult.outsideWrite === 'allowed', String(fsResult.outsideWrite));

// ---------- node:http/https layer (1b) ----------
// The official host's own API layer runs on bundled undici and its OSS uploader
// on plain node:http/https — neither sees the globalThis.fetch patch. If the
// deployed snapshot bundle ever moves the credential call there, the guard must
// fail it before connect (a failed credential keeps the capture inert).
const httpProbe = `
const http = require('node:http');
(async () => {
  const out = {};
  const attempt = (path) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 9, path, method: 'GET' });
    req.on('error', (e) => resolve('error:' + String((e && e.message) || e).slice(0, 60)));
    req.on('response', (r) => resolve('response:' + r.statusCode));
    req.end();
  });
  out.blocked = await attempt('/api/v1/snapshot/upload-credential?x=1');
  out.passthrough = await attempt('/health');
  out.getBlocked = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: 9, path: '/api/v1/snapshot/upload-credential' }, (r) => resolve('response:' + r.statusCode))
      .on('error', (e) => resolve('error:' + String((e && e.message) || e).slice(0, 60)));
  });
  console.log(JSON.stringify(out));
})();
`;
const httpRun = runProbe(httpProbe);
check('node:http credential request is failed by the guard', httpRun.json && /^error:/.test(httpRun.json.blocked) && /zcode-webui/.test(httpRun.json.blocked), JSON.stringify(httpRun.json));
check('node:http credential block is logged', /blocked upload-credential request #\d+ \(http\)/.test(httpRun.stderr));
check('node:http unrelated request still reaches the real stack', httpRun.json && /^error:/.test(httpRun.json.passthrough) && !/zcode-webui/.test(httpRun.json.passthrough), JSON.stringify(httpRun.json));
check('node:http.get credential request is failed too', httpRun.json && /^error:/.test(httpRun.json.getBlocked) && /zcode-webui/.test(httpRun.json.getBlocked), JSON.stringify(httpRun.json));

// ---------- escape hatch ----------
const disarmed = runProbe(passthroughProbe.replace('http://127.0.0.1:9/health', 'http://127.0.0.1:9/api/v1/snapshot/upload-credential?workspace_id=x'), {
  ZCODE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-webui-guard-off-')),
  ZCODE_WEBUI_ALLOW_REPO_SNAPSHOT: '1',
});
check('ZCODE_WEBUI_ALLOW_REPO_SNAPSHOT=1 leaves the vendor path alone', disarmed.json && typeof disarmed.json.network_error === 'string',
  JSON.stringify(disarmed.json));
check('disarmed guard says so', /repo-snapshot-guard: skipped/.test(disarmed.stderr));

fs.rmSync(ZCODE_HOME, { recursive: true, force: true });
console.log(failures === 0 ? '\nall repo-snapshot guard checks passed' : '\n' + failures + ' check(s) failed');
process.exit(failures ? 1 : 0);
