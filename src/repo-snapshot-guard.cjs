// Repo-snapshot (workspace checkpoint) upload kill switch for the official runtime.
//
// Background — ZCode 3.x captures a "workspace snapshot" around prompts: the runtime
// asks the vendor API for an upload credential
// (GET /api/v1/snapshot/upload-credential?workspace_id=<hash>), then scans the
// workspace — with .git/ exempted from BOTH the secret-name filter and the size cap —
// packs it, encrypts it with a server-supplied RSA public key (only the server can
// decrypt) and uploads the ciphertext to the vendor's OSS bucket. Ciphertext and
// plaintext manifests pile up under ~/.zcode/v2/checkpoints/<workspace-hash>/. The
// official setting `repoSnapshotIndexingEnabled` does NOT gate this path: verified on
// 3.12.3 it is only a schema default plus a settings-name list entry, and this box had
// it `false` while snapshots were still captured and accepted. There is no opt-out.
// See blog.ferstar.org/posts/zcode-silent-workspace-snapshot-upload/ for the original
// forensics.
//
// This guard is preloaded into the host process (NODE_OPTIONS --require, injected by
// src/host.mjs) and makes the capture path inert, in four layers:
//   1. the credential request is answered locally with { code: 0, data: null }, which
//      RepoSnapshotUploadClient.getUploadCredential() maps to "no credential issued";
//      captureBeforePromptUnsafe() then returns before scanning, packing or encrypting
//      anything (zcode-server.cjs: getUploadKey() null => return). The request goes
//      through the host API transport, which still calls globalThis.fetch on 3.11.2 and
//      3.12.3 alike — this is the layer that fires in practice (21 live hits on this box);
//   2. uploads of the snapshot artifact are refused (HTTP 403) — recognized by the OSS
//      form fields (`file` named repo-snapshot.tar.gz.enc, `key` containing
//      repo-snapshot) or by x-oss-signature headers. This also covers the proxy
//      transport (settings.httpProxy) and credentials cached in memory. NOTE: 3.12.3
//      changed the object upload to the runtime's BUNDLED undici fetch
//      (`objectUploadFetch ?? import_undici.fetch`), which a preload cannot patch, so on
//      that version this layer only fires if the runtime hands the transport in; layer 2b
//      below is the transport-independent replacement;
//   2b. reads of the payload file itself (openAsBlob backs the POST body,
//      createReadStream the PUT variant) are refused for
//      ~/.zcode/v2/checkpoints/*/{pending,tmp}/* — without the artifact in hand no
//      upload can be built, whatever fetch implementation is in play;
//   3. writes under ~/.zcode/v2/checkpoints/*/{pending,tmp,manifests,extra-manifests}/
//      are refused, so no artifact can be produced locally either. `state.json` stays
//      writable on purpose — the state repo keeps working and the host stays healthy.
//
// Re-verify after every official runtime update with:
//   node scripts/dev/repo-snapshot-guard-status.mjs
//
// Every block is logged to stderr, which lands in zcode-webui.log as "[host:stderr]
// [zcode-webui] repo-snapshot-guard: ...", so the disable stays auditable.
// Escape hatch: ZCODE_WEBUI_ALLOW_REPO_SNAPSHOT=1 (host.mjs then drops the preload
// entirely) restores the vendor behaviour.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const STATE_KEY = Symbol.for('zcode-webui.repo-snapshot-guard');
const ENABLED = process.env.ZCODE_WEBUI_ALLOW_REPO_SNAPSHOT !== '1';
const CREDENTIAL_PATH = '/api/v1/snapshot/upload-credential';
const ARTIFACT_MARKER = 'repo-snapshot';
const ARTIFACT_FILE = 'repo-snapshot.tar.gz.enc';
const ARTIFACT_SUBDIRS = ['pending', 'tmp', 'manifests', 'extra-manifests'];
// The payload itself lives in pending/ (ciphertext) and tmp/ (plaintext tarball); refusing to
// read those two is transport-independent, unlike the layer-2 fetch fingerprint below — 3.12.3
// switched the object upload from globalThis.fetch to the runtime's bundled undici fetch, which a
// preload cannot patch (see the header note).
const ARTIFACT_READ_SUBDIRS = ['pending', 'tmp'];
const CHECKPOINT_ROOT = path.join(
  process.env.ZCODE_HOME ? path.join(process.env.ZCODE_HOME, 'v2') : path.join(os.homedir(), '.zcode', 'v2'),
  'checkpoints',
);

const STATS = { credential: 0, upload: 0, write: 0, read: 0 };

function log(message) {
  try { process.stderr.write('[zcode-webui] repo-snapshot-guard: ' + message + '\n'); } catch (_e) { /* ignore */ }
}

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

// Multipart form field as string (FormData#get returns File for `file`, string for `key`).
function formField(init, name) {
  const body = init && init.body;
  if (!body || typeof body.get !== 'function') return '';
  try {
    const value = body.get(name);
    if (typeof value === 'string') return value;
    if (value && typeof value.name === 'string') return value.name;
  } catch (_e) { /* not a FormData-compatible body */ }
  return '';
}

function isCredentialRequest(url) {
  return url.indexOf(CREDENTIAL_PATH) >= 0;
}

function isArtifactUpload(init) {
  if (formField(init, 'file').indexOf(ARTIFACT_MARKER) >= 0) return true;
  if (formField(init, 'key').indexOf(ARTIFACT_MARKER) >= 0) return true;
  const headers = init && init.headers;
  if (headers && typeof headers.get === 'function') {
    try {
      if (headers.get('x-oss-signature') && String(headers.get('x-oss-signature-version') || '').length > 0) return true;
    } catch (_e) { /* not a Headers-like object */ }
  }
  return false;
}

// Mirrors what the vendor API answers when it decides not to collect: the client treats
// a null payload as "no credential" and skips the capture entirely (no error, no retry).
function credentialBlockedResponse(url) {
  STATS.credential += 1;
  log('blocked upload-credential request #' + STATS.credential + ' (' + url + ') — capture stays inert');
  return new Response(JSON.stringify({ code: 0, msg: 'repo snapshot upload disabled by zcode-webui', data: null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function uploadBlockedResponse(url) {
  STATS.upload += 1;
  log('blocked snapshot artifact upload #' + STATS.upload + ' (' + url + ')');
  return new Response('repo snapshot upload disabled by zcode-webui', { status: 403, statusText: 'Forbidden' });
}

function installFetchGuard() {
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;
  globalThis.fetch = function guardedFetch(input, init) {
    if (ENABLED) {
      const url = urlOf(input);
      if (isCredentialRequest(url)) return Promise.resolve(credentialBlockedResponse(url));
      if (isArtifactUpload(init)) return Promise.resolve(uploadBlockedResponse(url));
    }
    return original(input, init);
  };
}

// --- layer 1b: credential requests over node:http / node:https -------------------------
// The open-source tree (v3.14.3) shows the official host's API layer runs on the
// runtime's bundled undici (nodeApiNetwork.ts) and its OSS uploader on plain
// node:http/https request + createReadStream — NEITHER passes through the
// globalThis.fetch patch above. The deployed snapshot bundle currently still
// uses fetch (layer 1 keeps firing in production), but if it ever follows the
// same pattern, this layer fails the credential call before it connects: a
// failed credential request leaves the capture pipeline inert exactly like a
// null credential (the runtime swallows the failure itself).
function requestUrlOf(args) {
  const a = args && args[0];
  try {
    if (typeof a === 'string') return a;
    if (a instanceof URL) return a.href;
    if (a && typeof a === 'object') {
      const host = a.hostname || a.host || '';
      const proto = a.protocol || (a.secureEndpoint ? 'https:' : 'http:');
      return proto + '//' + host + (a.path || a.pathname || '/');
    }
  } catch (_e) { /* never break traffic over parsing */ }
  return '';
}

function blockedHttpRequest(mod, modName, originalRequest) {
  STATS.credential += 1;
  log('blocked upload-credential request #' + STATS.credential + ' (' + modName + ') — failing the call before connect');
  // A genuine ClientRequest against an unroutable target, destroyed on the next
  // tick with our error: callers keep a real request object (on/error/destroy),
  // and the failure surfaces exactly like a network error.
  let req = null;
  try { req = originalRequest.call(mod, { host: '127.0.0.1', port: 1, path: '/', method: 'GET' }); } catch (_e) { /* fall through */ }
  if (req) {
    process.nextTick(() => { try { req.destroy(new Error('repo snapshot upload disabled by zcode-webui')); } catch (_e) { /* ignore */ } });
    return req;
  }
  throw new Error('repo snapshot upload disabled by zcode-webui');
}

function installHttpGuard() {
  for (const [name, mod] of [['http', require('node:http')], ['https', require('node:https')]]) {
    const originalRequest = mod.request;
    const originalGet = mod.get;
    if (typeof originalRequest !== 'function' || PATCHED.has(originalRequest)) continue;
    PATCHED.add(originalRequest);
    mod.request = function guardedHttpRequest(...args) {
      if (ENABLED && isCredentialRequest(requestUrlOf(args))) {
        return blockedHttpRequest(mod, name, originalRequest);
      }
      return originalRequest.apply(mod, args);
    };
    if (typeof originalGet === 'function' && !PATCHED.has(originalGet)) {
      PATCHED.add(originalGet);
      mod.get = function guardedHttpGet(...args) {
        if (ENABLED && isCredentialRequest(requestUrlOf(args))) {
          const req = blockedHttpRequest(mod, name, originalRequest);
          if (req && typeof req.end === 'function') { try { req.end(); } catch (_e) { /* ignore */ } }
          return req;
        }
        return originalGet.apply(mod, args);
      };
    }
  }
}

// --- layer 3: checkpoint artifact writes ---------------------------------------------

const PATCHED = new WeakSet();

function guardedPath(target) {
  let abs;
  try { abs = path.resolve(String(target)); } catch (_e) { return null; }
  if (abs !== CHECKPOINT_ROOT && abs.indexOf(CHECKPOINT_ROOT + path.sep) !== 0) return null;
  const parts = path.relative(CHECKPOINT_ROOT, abs).split(path.sep);
  return parts.length >= 2 && ARTIFACT_SUBDIRS.indexOf(parts[1]) >= 0 ? abs : null;
}

// The payload file itself (pending/<x>.tar.gz.enc, tmp/<x>.tar.gz), as opposed to the
// plaintext manifest/state files the runtime legitimately reads around it.
function guardedArtifact(target) {
  const abs = guardedPath(target);
  if (!abs || abs === CHECKPOINT_ROOT) return null;
  const parts = path.relative(CHECKPOINT_ROOT, abs).split(path.sep);
  return parts.length >= 3 && ARTIFACT_READ_SUBDIRS.indexOf(parts[1]) >= 0 ? abs : null;
}

function denyWrite(abs, api) {
  STATS.write += 1;
  log('refused checkpoint artifact write #' + STATS.write + ' (' + api + ' -> ' + abs + ')');
  const error = new Error('repo snapshot artifacts are disabled by zcode-webui (' + api + ': ' + abs + ')');
  error.code = 'EACCES';
  return error;
}

function denyRead(abs, api) {
  STATS.read += 1;
  log('refused snapshot artifact read #' + STATS.read + ' (' + api + ' -> ' + abs + ')');
  const error = new Error('repo snapshot artifacts are disabled by zcode-webui (' + api + ': ' + abs + ')');
  error.code = 'EACCES';
  return error;
}

function deny(abs, api, kind) {
  return kind === 'read' ? denyRead(abs, api) : denyWrite(abs, api);
}

// Denied-call delivery that keeps both flavours of the fs API honest: callback callers
// get the error through their callback, sync callers (and stream factories) get a throw.
function failDenied(name, args, abs, { async: async_, kind = 'write' } = {}) {
  const error = deny(abs, name, kind);
  if (async_) return Promise.reject(error);
  const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
  if (callback) {
    process.nextTick(callback, error);
    return undefined;
  }
  throw error;
}

function patch(target, name, wrap) {
  const original = target[name];
  if (typeof original !== 'function' || PATCHED.has(original)) return;
  PATCHED.add(original);
  target[name] = wrap(original);
}

function patchWrite(target, name, { async: async_, destIndex = 0 } = {}) {
  patch(target, name, (original) => function (...args) {
    if (ENABLED) {
      const abs = guardedPath(args[destIndex]);
      if (abs) return failDenied(name, args, abs, { async: async_ });
    }
    return original.apply(this, args);
  });
}

// Artifact readers: openAsBlob() backs the POST upload body, createReadStream() backs the PUT
// variant. Blocking these makes layer 2 independent of which fetch implementation the runtime
// happens to use (3.12.3 switched to its bundled undici, which a preload cannot reach).
function patchRead(target, name, { async: async_ } = {}) {
  patch(target, name, (original) => function (...args) {
    if (ENABLED) {
      const abs = guardedArtifact(args[0]);
      if (abs) return failDenied(name, args, abs, { async: async_, kind: 'read' });
    }
    return original.apply(this, args);
  });
}

function patchOpen(target, name, { async: async_ } = {}) {
  patch(target, name, (original) => function (...args) {
    const flags = typeof args[1] === 'string' ? args[1] : typeof args[1] === 'number' ? String(args[1]) : '';
    if (ENABLED) {
      const artifact = guardedArtifact(args[0]);
      if (artifact) return failDenied(name, args, artifact, { async: async_, kind: 'read' });
      if (/[wa]|\+/.test(flags)) {
        const abs = guardedPath(args[0]);
        if (abs) return failDenied(name, args, abs, { async: async_ });
      }
    }
    return original.apply(this, args);
  });
}

function installFsGuard() {
  for (const name of ['createWriteStream', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync']) {
    patchWrite(fs, name);
  }
  for (const name of ['writeFile', 'appendFile']) {
    patchWrite(fsp, name, { async: true });
  }
  // rename/copyFile move bytes into a destination — only the destination is policed, so
  // discarding (moving out of) an artifact still works.
  for (const name of ['rename', 'renameSync', 'copyFile', 'copyFileSync']) {
    patchWrite(fs, name, { destIndex: 1 });
  }
  for (const name of ['rename', 'copyFile']) {
    patchWrite(fsp, name, { async: true, destIndex: 1 });
  }
  patchOpen(fs, 'open');
  patchOpen(fs, 'openSync');
  patchOpen(fsp, 'open', { async: true });
  // Layer 2b: the artifact body cannot be read for upload at all, whichever fetch
  // implementation the runtime picked (openAsBlob => POST body, createReadStream => PUT body).
  patchRead(fs, 'openAsBlob', { async: true });
  patchRead(fsp, 'openAsBlob', { async: true });
  patchRead(fs, 'createReadStream');
}

function install() {
  installFetchGuard();
  installHttpGuard();
  installFsGuard();
  if (ENABLED) {
    log('armed — repo-snapshot capture/upload disabled (checkpoint root: ' + CHECKPOINT_ROOT
      + '); ZCODE_WEBUI_ALLOW_REPO_SNAPSHOT=1 restores vendor behaviour');
  } else {
    log('skipped — ZCODE_WEBUI_ALLOW_REPO_SNAPSHOT=1, vendor snapshot upload path left untouched');
  }
}

if (globalThis[STATE_KEY]) {
  log('already installed in this process, nothing to do');
} else {
  globalThis[STATE_KEY] = { enabled: ENABLED, checkpointRoot: CHECKPOINT_ROOT, stats: STATS };
  install();
}

module.exports = { enabled: ENABLED, checkpointRoot: CHECKPOINT_ROOT, artifactFile: ARTIFACT_FILE, stats: STATS };
