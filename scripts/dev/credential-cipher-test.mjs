#!/usr/bin/env node
// Offline tests for src/credential-cipher.mjs — the "desktop main process" half
// of the >= 3.18 credential bridge.
//
// Why this exists: the 3.18 host asks its parent process to encrypt/decrypt
// every credential (`credential-cipher-request`). Our fork IPC relay used to drop
// the request, so `configRuntime.start()` / `oauth.restoreCachedSessionState`
// never settled and the UI sat on the startup spinner (2026-11-16). These tests
// pin the wire shapes AND the on-disk envelope compatibility: the store written
// by <= 3.17 (`enc:v1:`) must stay readable, because that is the user's login.
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  credentialSecret, sealCredential, openCredential, handleCredentialCipherRequest,
  credentialFilePath,
} from '../../src/credential-cipher.mjs';

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '  [' + detail + ']')); }
}

const SECRET = 'test-secret-for-credential-cipher-0123456789';
const keyOf = (s) => crypto.createHash('sha256').update(s).digest();

// vendor-format seal (same AES-GCM envelope, chosen prefix)
function sealLike(prefix, plain, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return prefix + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

// --- round trip -----------------------------------------------------------
{
  const sealed = sealCredential('{"token":"abc"}', SECRET);
  check('sealCredential uses the enc:v2:env: envelope', sealed.startsWith('enc:v2:env:'), sealed.slice(0, 16));
  check('openCredential round-trips a v2 payload', openCredential(sealed, SECRET) === '{"token":"abc"}');
}

// --- backward compatibility with what <= 3.17 wrote ----------------------
{
  const v1 = sealLike('enc:v1:', 'legacy-plaintext', SECRET);
  check('openCredential still reads legacy enc:v1 (same key)', openCredential(v1, SECRET) === 'legacy-plaintext');
  check('plaintext entries pass through untouched', openCredential('just-a-value', SECRET) === 'just-a-value');
}

// --- failure modes --------------------------------------------------------
{
  const sealed = sealCredential('secret', SECRET);
  let wrongKey = null;
  try { openCredential(sealed, 'another-secret'); } catch (e) { wrongKey = e; }
  check('wrong key raises CREDENTIAL_DECRYPT_FAILED', wrongKey && wrongKey.code === 'CREDENTIAL_DECRYPT_FAILED', wrongKey && wrongKey.code);

  let osSealed = null;
  try { openCredential('enc:v2:os:AAAA.BBBB.CCCC', SECRET); } catch (e) { osSealed = e; }
  check('OS-keyring payloads are refused with a stable code',
    osSealed && osSealed.code === 'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE', osSealed && osSealed.code);

  let junk = null;
  try { openCredential('enc:v1:not-a-payload', SECRET); } catch (e) { junk = e; }
  check('malformed payloads are rejected', junk && junk.code === 'CREDENTIAL_CIPHER_INVALID_PAYLOAD', junk && junk.code);
}

// --- the bridge request/response contract --------------------------------
{
  const id = crypto.randomUUID();
  const enc = handleCredentialCipherRequest({ type: 'credential-cipher-request', requestId: id, operation: 'encrypt', value: 'hello' }, () => {});
  check('encrypt reply carries type + requestId', enc && enc.type === 'credential-cipher-result' && enc.requestId === id);
  check('encrypt reply is ok with a v2 value', enc.result.ok === true && String(enc.result.value).startsWith('enc:v2:env:'), JSON.stringify(enc.result).slice(0, 80));
  const dec = handleCredentialCipherRequest({ type: 'credential-cipher-request', requestId: crypto.randomUUID(), operation: 'decrypt', value: enc.result.value }, () => {});
  check('decrypt reply round-trips the ciphertext', dec.result.ok === true && dec.result.value === 'hello', JSON.stringify(dec.result).slice(0, 80));

  // the handler always uses the key this process would use (env secret or the
  // derived fallback), so seal with that same key here
  const own = credentialSecret().secret;
  const bad = handleCredentialCipherRequest({ type: 'credential-cipher-request', requestId: crypto.randomUUID(), operation: 'decrypt', value: sealCredential('x', own) }, () => {});
  check('a payload sealed with the process key answers ok', bad.result.ok === true, JSON.stringify(bad.result).slice(0, 80));

  const missing = handleCredentialCipherRequest({ type: 'credential-cipher-request', operation: 'encrypt', value: 'x' }, () => {});
  check('a request without requestId is ignored (null)', missing === null);

  const failing = handleCredentialCipherRequest({ type: 'credential-cipher-request', requestId: crypto.randomUUID(), operation: 'decrypt', value: 'enc:v2:os:AA.BB.CC' }, () => {});
  check('failure shape is {ok:false,error:{message,code}}',
    failing.result.ok === false && typeof failing.result.error.message === 'string' && failing.result.error.code === 'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE',
    JSON.stringify(failing.result));
}

// --- key derivation matches the vendor formula ---------------------------
{
  const saved = process.env.ZCODE_CREDENTIAL_SECRET;
  delete process.env.ZCODE_CREDENTIAL_SECRET;
  const { secret, source } = credentialSecret();
  const username = (() => { try { return os.userInfo().username; } catch { return 'unknown'; } })();
  const expected = 'zcode-credential-fallback:' + os.platform() + ':' + os.homedir() + ':' + username;
  check('derived secret matches the vendor fallback formula', secret === expected && source === 'derived', secret);
  process.env.ZCODE_CREDENTIAL_SECRET = SECRET;
  const envKey = credentialSecret();
  check('ZCODE_CREDENTIAL_SECRET wins over the derived fallback', envKey.secret === SECRET && envKey.source === 'env');
  if (saved === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET; else process.env.ZCODE_CREDENTIAL_SECRET = saved;
}

// --- rollback safety net --------------------------------------------------
{
  const p = credentialFilePath();
  check('credentialFilePath points at the host credential store',
    p === path.join(os.homedir(), '.zcode', 'v2', 'credentials.json'), p);
}

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
