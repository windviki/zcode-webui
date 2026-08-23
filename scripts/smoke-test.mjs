// Smoke test: static serving, base path, and a full bidirectional ZCode Protocol
// round-trip over the WS bridge (Initialize frame + crafted createSession request).
// Usage: node scripts/smoke-test.mjs [basePath] [port]
import WebSocket from 'ws';

const base = process.argv[2] || '';
const port = Number(process.argv[3] || 3102);
const origin = 'http://127.0.0.1:' + port;

// ---- Minimal ZCode channel message writer for tests (mirrors the official wire format) ----
function writeVQL(value) {
  const bytes = [];
  if (value === 0) { bytes.push(0); return Buffer.from(bytes); }
  let v = value;
  while (v !== 0) { bytes.push(v & 127); v = v >>> 7; }
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 128;
  return Buffer.from(bytes);
}
function serialize(data) {
  const parts = [];
  if (data === undefined) {
    parts.push(Buffer.from([0]));
  } else if (typeof data === 'string') {
    const b = Buffer.from(data, 'utf8');
    parts.push(Buffer.from([1]), writeVQL(b.length), b);
  } else if (Array.isArray(data)) {
    parts.push(Buffer.from([4]), writeVQL(data.length));
    for (const el of data) parts.push(serialize(el));
  } else if (typeof data === 'number' && (data | 0) === data) {
    parts.push(Buffer.from([6]), writeVQL(data));
  } else if (data && typeof data === 'object') {
    const b = Buffer.from(JSON.stringify(data), 'utf8');
    parts.push(Buffer.from([5]), writeVQL(b.length), b);
  } else {
    throw new Error('unsupported value: ' + data);
  }
  return Buffer.concat(parts);
}
function message(header, body) {
  return Buffer.concat([serialize(header), serialize(body)]);
}
function frame(payload) {
  const h = Buffer.alloc(13);
  h.writeUInt8(1, 0);
  h.writeUInt32BE(0, 1);
  h.writeUInt32BE(0, 5);
  h.writeUInt32BE(payload.length, 9);
  return Buffer.concat([h, payload]);
}

async function get(path) {
  const res = await fetch(origin + path);
  const text = await res.text();
  return { status: res.status, text };
}

const checks = [];
function check(name, ok, extra) {
  checks.push({ name, ok, extra });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
}

const health = await get(base + '/api/health');
check('health endpoint', health.status === 200, 'status=' + health.status);
const hjson = JSON.parse(health.text);
check('renderer loaded', hjson.rendererLoaded === true);
check('serverRoot present', !!hjson.serverRoot);

const index = await get(base + '/');
check('index served', index.status === 200 && index.text.includes('__ZCODE_WEBUI_CONFIG__'), 'status=' + index.status);
const entryMatch = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(index.text);
check('index references official renderer assets', !!entryMatch, entryMatch ? entryMatch[0] : 'no assets/index-*.js found');
check('index has bridge injection', index.text.includes('zcode-bridge.js') && index.text.includes('bootstrap.js'));
check('index has trailing-slash redirect', index.text.includes('location.replace'));
// extract the per-run ws token from the injected config
let wsToken = '';
{
  const m = /window\.__ZCODE_WEBUI_CONFIG__ = (\{.*?\});/.exec(index.text);
  if (m) { try { wsToken = JSON.parse(m[1]).wsToken || ''; } catch (_e) { /* ignore */ } }
}
check('ws token extracted', wsToken.length > 0);

const asset = await get(base + '/' + entryMatch[0]);
check('renderer asset served under base', asset.status === 200 && asset.text.length > 1000, 'status=' + asset.status + ' size=' + asset.text.length);

const shim = await get(base + '/__zcode_webui/zcode-bridge.js');
check('shim served', shim.status === 200 && shim.text.includes('window.zcode'));

const loginPage = await get(base + '/login');
check('login page served', loginPage.status === 200 && loginPage.text.includes('登录'));

// ---- full WS round-trip ----
const wsResult = await new Promise((resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:' + port + base + '/ws?token=' + wsToken);
  const log = [];
  let initialized = false;
  let replied = false;
  const timer = setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ ok: false, log, reason: 'timeout' }); }, 25000);

  ws.on('open', () => log.push('open'));
  ws.on('message', (data, isBinary) => {
    if (!isBinary) { log.push('text: ' + String(data).slice(0, 60)); return; }
    // each binary WS message is exactly one protocol payload (the 13-byte stdio frame
    // header exists only on the server's stdio side)
    const payload = Buffer.from(data);
    log.push('payload ' + payload.length + 'B hex=' + payload.toString('hex').slice(0, 40));
    if (!initialized) {
      // Initialize message = serialize([200]) -> 04 01 06 c8 01 00
      initialized = payload.toString('hex') === '040106c80100';
      if (initialized) {
        log.push('got Initialize, sending system.info request');
        // header [100 Promise, id=1, channelName, method]; body = undefined.
        // IMPORTANT: the WS carries raw payloads only — the server bridge adds the
        // 13-byte stdio frame header (the official renderer behaves the same way).
        const req = message([100, 1, 'system', 'info'], undefined);
        try { ws.send(req); } catch (e) { log.push('send error ' + e.message); }
      }
    } else if (!replied) {
      replied = true;
      log.push('got reply to system.info (round-trip OK)');
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      resolve({ ok: true, log });
    }
  });
  ws.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, log, reason: 'ws error: ' + err.message }); });
  ws.on('close', () => { if (!replied) { clearTimeout(timer); resolve({ ok: false, log, reason: 'closed before reply' }); } });
});
check('ws bridge Initialize', wsResult.log.some((l) => l === 'got Initialize, sending system.info request'));
check('ws bridge system.info round-trip', wsResult.ok, wsResult.reason || '');
wsResult.log.slice(0, 14).forEach((l) => console.log('       ' + l));

// ---- HTTP fallback bridge round-trip (for proxies that block WebSocket upgrades) ----
const hbResult = await new Promise((resolve) => {
  const log = [];
  (async () => {
    try {
      const open = await fetch(origin + base + '/bridge/open', { method: 'POST' }).then((r) => r.json());
      log.push('open: ' + JSON.stringify(open).slice(0, 140));
      if (!open.ok || !open.id) return resolve({ ok: false, log, reason: 'open failed' });
      const id = open.id;
      const req = message([100, 1, 'system', 'info'], undefined);
      const sendResp = await fetch(origin + base + '/bridge/send?id=' + id, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: req }).then((r) => r.json());
      log.push('send: ' + JSON.stringify(sendResp));
      if (!sendResp.ok) return resolve({ ok: false, log, reason: 'send failed' });
      // poll repeatedly: first poll may only return the queued Initialize frame
      let ok = false;
      let bytesSeen = 0;
      for (let attempt = 0; attempt < 10 && !ok; attempt++) {
        const pollResp = await fetch(origin + base + '/bridge/poll?id=' + id);
        const buf = Buffer.from(await pollResp.arrayBuffer());
        bytesSeen += buf.length;
        let off = 0;
        while (off + 4 <= buf.length) {
          const len = buf.readUInt32BE(off);
          off += 4;
          if (len === 0 || off + len > buf.length) break;
          const payload = buf.subarray(off, off + len);
          off += len;
          if (payload.includes(Buffer.from('homedir'))) ok = true;
        }
      }
      log.push('polls done, bytes=' + bytesSeen + ' ok=' + ok);
      await fetch(origin + base + '/bridge/close?id=' + id, { method: 'POST' }).catch(() => {});
      resolve({ ok, log, reason: ok ? '' : 'no homedir frame in poll responses' });
    } catch (e) {
      resolve({ ok: false, log, reason: String(e.message || e) });
    }
  })();
});
check('http bridge round-trip', hbResult.ok, hbResult.reason || '');
hbResult.log.forEach((l) => console.log('       ' + l));

const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0 ? 'SMOKE OK' : 'SMOKE FAILED (' + failed + ')');
process.exit(failed === 0 ? 0 : 1);
