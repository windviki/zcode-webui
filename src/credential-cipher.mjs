// Credential cipher — the "desktop main process" half of the >= 3.18 host's
// credential bridge.
//
// The 3.18 host runs as an Electron *utility process*: it hands every credential
// encrypt/decrypt to the main process over `process.parentPort`
// (`{type:'credential-cipher-request', requestId, operation, value}`) and waits
// for `{type:'credential-cipher-result', requestId, result:{ok,value|error}}`.
// `src/port-shim.mjs` recreates that port for us over the fork IPC channel, so
// those requests arrive here as `{__z:'pp', msg:{type:'credential-cipher-request'}}`
// — and before this module existed the server simply dropped them. The host then
// never finished `configRuntime.start()` / `oauth.restoreCachedSessionState`; the
// renderer's `isRestoringOAuthSession` stayed true and the UI sat on the startup
// spinner forever (2026-11-16, 3.18.2 trial).
//
// The key is the vendor's own headless fallback (there is no OS keyring on this
// box, and 3.17 used exactly this derivation to read the same store):
//
//   secret = ZCODE_CREDENTIAL_SECRET
//         ?? `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`
//   key    = sha256(secret)
//
// Envelope: `enc:v<n>[:env]:` + base64url(iv 12B) + '.' + base64url(tag 16B) + '.'
// + base64url(ciphertext), AES-256-GCM. Legacy `enc:v1:` entries (what <= 3.17
// wrote) decrypt with the same key, so a machine upgrading to 3.18 keeps its
// login; new writes go out as `enc:v2:env:` like the vendor's env-secret path.
import crypto from 'node:crypto';
import { copyFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const V1 = 'enc:v1:';
const V2_ENV = 'enc:v2:env:';
const GCM = 'aes-256-gcm';

export function credentialSecret() {
  const fromEnv = String(process.env.ZCODE_CREDENTIAL_SECRET || '').trim();
  if (fromEnv) return { secret: fromEnv, source: 'env' };
  let username = 'unknown';
  try { username = os.userInfo().username; } catch (_e) { /* ignore */ }
  return {
    secret: 'zcode-credential-fallback:' + os.platform() + ':' + os.homedir() + ':' + username,
    source: 'derived',
  };
}

function keyOf(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function cipherError(message, code) {
  return Object.assign(new Error(message), { code });
}

export function sealCredential(plain, secret = credentialSecret().secret) {
  const key = keyOf(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(GCM, key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return V2_ENV + [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function openCredential(value, secret = credentialSecret().secret) {
  const s = String(value);
  let prefix = null;
  if (s.startsWith(V1)) prefix = V1;
  else if (s.startsWith(V2_ENV)) prefix = V2_ENV;
  else if (s.startsWith('enc:v2:')) {
    // "os:" and friends are sealed by the OS keyring; this deployment has none
    // and must not pretend otherwise — the host turns this into a login prompt.
    throw cipherError('credential was sealed by the OS keyring, which this deployment does not have',
      'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE');
  } else if (s.startsWith('enc:')) {
    throw cipherError('unsupported credential envelope', 'CREDENTIAL_CIPHER_INVALID_PAYLOAD');
  } else {
    return s;                       // plaintext entries exist (vendor keeps some as-is)
  }
  const parts = s.slice(prefix.length).split('.');
  if (parts.length !== 3) throw cipherError('invalid credential payload', 'CREDENTIAL_CIPHER_INVALID_PAYLOAD');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16) throw cipherError('invalid credential payload', 'CREDENTIAL_CIPHER_INVALID_PAYLOAD');
  try {
    const decipher = crypto.createDecipheriv(GCM, keyOf(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (_e) {
    throw cipherError('credential decrypt failed', 'CREDENTIAL_DECRYPT_FAILED');
  }
}

// Answer one bridge request. Shape is what `vx(...).receive()` parses:
//   ok  → { ok: true, value: <ciphertext|plaintext> }
//   err → { ok: false, error: { message, code } }
export function handleCredentialCipherRequest(req, log = () => {}) {
  const id = req && typeof req.requestId === 'string' ? req.requestId : '';
  if (!id) return null;
  try {
    const { secret, source } = credentialSecret();
    const value = req.operation === 'encrypt'
      ? sealCredential(req.value, secret)
      : openCredential(req.value, secret);
    log('cipher ' + (req.operation || '?') + ' ok (key source: ' + source + ')');
    return { type: 'credential-cipher-result', requestId: id, result: { ok: true, value } };
  } catch (err) {
    const code = (err && err.code) || 'CREDENTIAL_CIPHER_FAILED';
    log('cipher ' + (req.operation || '?') + ' failed: ' + code);
    return {
      type: 'credential-cipher-result',
      requestId: id,
      result: { ok: false, error: { message: String((err && err.message) || err).slice(0, 300), code } },
    };
  }
}

// The 3.18 host migrates every `enc:v1:` entry to `enc:v2:env:` the first time it
// reads the store, which a rolled-back 3.17 cannot read. Keep one copy next to
// the original so a rollback is `mv credentials.json.bak-pre318 credentials.json`
// instead of "log in again" (the file holds the encrypted session, not keys).
export function credentialFilePath() {
  return path.join(os.homedir(), '.zcode', 'v2', 'credentials.json');
}

export function ensureCredentialBackup(log = () => {}) {
  const file = credentialFilePath();
  const backup = file + '.bak-pre318';
  try {
    if (!existsSync(file) || existsSync(backup)) return backup;
    copyFileSync(file, backup);
    log('credential store backed up to ' + backup + ' (3.18 migrates it to enc:v2)');
    return backup;
  } catch (_e) {
    return null;
  }
}
