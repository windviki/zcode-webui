// Offline-gap replay + keepalive leniency regression (protocol level, no browser):
//
//   Part A — resume replay: while a tab's socket is gone, downstream frames for
//   its parked era (call responses, task-list events) must be BUFFERED server
//   side and replayed when the tab hot-resumes (resume=1), so the session list
//   does not silently go stale ("had to refresh to see new sessions"). Driven
//   against a scripted fake host (ZCODE_HOME/server/zcode-server.cjs) whose
//   responses can be held and released on demand — no real runtime needed.
//
//   Part B — keepalive leniency: a raw client that never answers pings must
//   survive the FIRST missed ping and be terminated only after
//   ZCODE_WEBUI_WS_PING_MAX_MISS consecutive misses (the old code killed the
//   socket on the first miss, detaching backgrounded tabs within ~30s).
//
// Usage: node scripts/dev/resume-replay-test.mjs   (fully sandboxed, private port)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { encodeRpcHeader, decodeRpc } from '../../src/rpclog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---- the scripted fake host (speaks the stdio frame protocol) ----
// Handshake (zcode-hello line) + one Initialize (200) frame at boot. Every
// inbound call (100) is answered with a response (201) — except method 'hold',
// which is remembered unanswered; a 'go' call answers everything held first.
const FAKE_HOST = `
const path = require('path');
(async () => {
  const { encodeRpcHeader } = await import(require('url').pathToFileURL(path.join(process.env.ZWEBUI_FAKE_HOST_ROOT, 'src', 'rpclog.mjs')).href);
  const enc = (payload) => { const b = Buffer.alloc(13 + payload.length); b.writeUInt8(1, 0); b.writeUInt32BE(0, 1); b.writeUInt32BE(0, 5); b.writeUInt32BE(payload.length, 9); payload.copy(b, 13); return b; };
  const body = Buffer.from([0]);
  process.stdout.write(JSON.stringify({ type: 'zcode-hello', version: 'fake-host-1' }) + '\\n');
  setTimeout(() => {
    process.stdout.write(enc(Buffer.concat([encodeRpcHeader([200, 1, 'zwebui-init', 'initialize']), body])));
  }, 50);
  function readVQL(b, o) { let v = 0, n = 0; for (;;) { const x = b[o++]; v |= (x & 127) << n; if (!(x & 128)) return [v >>> 0, o]; n += 7; } }
  function readStr(b, o) { const [len, o2] = readVQL(b, o); return [b.subarray(o2, o2 + len).toString('utf8'), o2 + len]; }
  function readHdr(p) {
    try {
      if (p[0] !== 4) return null;
      const [alen, o] = readVQL(p, 1);
      if (alen !== 4) return null;
      if (p[o] !== 6) return null; const [type, o1] = readVQL(p, o + 1);
      if (p[o1] !== 6) return null; const [id, o2] = readVQL(p, o1 + 1);
      if (p[o2] !== 1) return null; const [channel, o3] = readStr(p, o2 + 1);
      if (p[o3] !== 1) return null; const [method] = readStr(p, o3 + 1);
      return [type, id, channel, method];
    } catch (e) { return null; }
  }
  let buf = Buffer.alloc(0), sawAck = false;
  const held = [];
  process.stdin.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!sawAck) { const nl = buf.indexOf(0x0a); if (nl < 0) return; buf = buf.subarray(nl + 1); sawAck = true; }
    for (;;) {
      if (buf.length < 13) return;
      const len = buf.readUInt32BE(9);
      if (buf.length < 13 + len) return;
      const payload = buf.subarray(13, 13 + len);
      buf = buf.subarray(13 + len);
      const hdr = readHdr(payload);
      if (!hdr || hdr[0] !== 100) continue;
      if (hdr[3] === 'hold') { held.push(hdr); continue; }
      if (hdr[3] === 'go') {
        for (const c of held) process.stdout.write(enc(Buffer.concat([encodeRpcHeader([201, c[1], c[2], c[3]]), body])));
        held.length = 0;
      }
      process.stdout.write(enc(Buffer.concat([encodeRpcHeader([201, hdr[1], hdr[2], hdr[3]]), body])));
    }
  });
})();
`;

function makeSandbox(prefix) {
  const sandbox = mkdtempSync(prefix);
  for (const d of ['home', 'zcode/v2', 'data/vendor/renderer']) mkdirSync(path.join(sandbox, d), { recursive: true });
  writeFileSync(path.join(sandbox, 'zcode/v2/credentials.json'),
    JSON.stringify({ 'oauth:bigmodel:access_token': 't', 'oauth:bigmodel:user_info': '{"id":"resumetest"}' }));
  // minimal renderer index: readRendererIndex only needs the viewport meta to inject into
  writeFileSync(path.join(sandbox, 'data/vendor/renderer/index.html'),
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head><body><div id="root"></div></body></html>');
  return sandbox;
}

const checks = [];
const check = (n, ok, extra) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  (' + extra + ')' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(sandbox, port, extraEnv = {}) {
  const server = spawn(process.execPath, [path.join(ROOT, 'src/server.mjs'), '--port', String(port)], {
    env: {
      ...process.env,
      ZCODE_WEBUI_HOME: path.join(sandbox, 'data'),
      ZCODE_HOME: path.join(sandbox, 'zcode'),
      HOME: path.join(sandbox, 'home'),
      ZWEBUI_FAKE_HOST_ROOT: ROOT,
      // the sandbox must run the FAKE host: this test often executes inside the
      // production server's process tree, where ZCODE_SERVER_RUNTIME_ROOT and
      // the guard NODE_OPTIONS leak in through the environment
      ZCODE_SERVER_RUNTIME_ROOT: path.join(sandbox, 'zcode/server'),
      NODE_OPTIONS: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const log = [];
  server.stderr.on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) log.push(l); });
  server.log = log;
  return server;
}

async function waitHealth(base) {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(base + 'api/health'); if (r.ok) return true; } catch (_e) { /* retry */ }
    await sleep(300);
  }
  return false;
}

async function identity(base) {
  const res = await fetch(base);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const html = await res.text();
  const cfg = JSON.parse(html.match(/window\.__ZCODE_WEBUI_CONFIG__ = (\{.*?\});/)[1]);
  return { cookie, wsToken: cfg.wsToken };
}

// a thin client that mirrors bootstrap.js: verify WS_READY, decode RPC frames
function wsClient(base, { cookie, wsToken }, tab, resume) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + 'ws?token=' + wsToken + '&tab=' + tab + (resume ? '&resume=1' : ''),
      { headers: { cookie } });
    const frames = [];
    const texts = [];
    let verified = false;
    const done = new Promise((v) => { ws.on('close', () => v()); });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (!verified && String(data) === '{"kind":"zcode-webui-ready"}') { verified = true; resolve(client); }
        else texts.push(String(data));
        return;
      }
      const hdr = decodeRpc(Buffer.from(data));
      frames.push({ raw: Buffer.from(data), hdr });
    });
    ws.on('error', reject);
    const client = {
      ws, frames, texts, closed: done,
      sendCall(id, method) {
        ws.send(Buffer.concat([encodeRpcHeader([100, id, 'zwebui-test', method]), Buffer.from([0])]), { binary: true });
      },
      portReady() { ws.send('{"kind":"zcode-webui-port-ready"}'); },
      close() { try { ws.close(); } catch (_e) { /* ignore */ } },
    };
    setTimeout(() => reject(new Error('ws verify timeout')), 8000);
  });
}

let sandbox = null, server = null, sandbox2 = null, server2 = null;
function cleanup() {
  for (const s of [server, server2]) { try { if (s && s.exitCode === null) s.kill('SIGKILL'); } catch (_e) { /* ignore */ } }
  for (const s of [sandbox, sandbox2]) { try { if (s) rmSync(s, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

try {
  // ============================== Part A ==============================
  sandbox = makeSandbox('/tmp/zwebui-resume.XXXXXX');
  // fake runtime: ZCODE_HOME/server is the default runtime root (resolveServerRoot)
  mkdirSync(path.join(sandbox, 'zcode/server'), { recursive: true });
  symlinkSync(process.execPath, path.join(sandbox, 'zcode/server/node'));
  writeFileSync(path.join(sandbox, 'zcode/server/zcode-server.cjs'), FAKE_HOST);

  const port = 3300 + Math.floor(Math.random() * 200);
  const base = 'http://127.0.0.1:' + port + '/';
  server = startServer(sandbox, port);
  check('A: sandbox server up (fake host)', await waitHealth(base));

  const id = await identity(base);

  const t1 = await wsClient(base, id, 'tab-A1', false);
  await sleep(400);                                          // Initialize arrives
  check('A: tab1 got the host Initialize', t1.frames.some((f) => f.hdr && f.hdr.type === 200));

  t1.sendCall(1, 'hold');                                    // host remembers, does not answer
  await sleep(300);
  check('A: held call not answered yet (sanity)', !t1.frames.some((f) => f.hdr && f.hdr.type === 201));

  t1.close();                                                // era parks
  await sleep(400);

  const t2 = await wsClient(base, id, 'tab-A2', false);      // second tab adopts the session
  t2.portReady();
  await sleep(300);
  check('A: tab2 (adopter) got the Initialize replay', t2.frames.some((f) => f.hdr && f.hdr.type === 200));

  t2.sendCall(1, 'go');                                      // host answers the held call + this one
  await sleep(400);
  check('A: tab2 got its own response', t2.frames.some((f) => f.hdr && f.hdr.type === 201 && f.hdr.method === 'go'));

  const t1b = await wsClient(base, id, 'tab-A1', true);      // tab1 hot-resumes
  await sleep(400);
  const replayed = t1b.frames.find((f) => f.hdr && f.hdr.type === 201 && f.hdr.method === 'hold');
  check('A: offline-gap response REPLAYED to the resumed tab', !!replayed, replayed ? 'local id=' + replayed.hdr.id : 'none');
  check('A: replay restored the renderer-local id', replayed && replayed.hdr.id === 1, 'id=' + (replayed && replayed.hdr.id));
  check('A: server logged the replay', server.log.some((l) => l.includes('resume replay tab=tab-A1')));

  const health = await (await fetch(base + 'api/health')).json();
  check('A: both tabs attached as views', health.sessions.views === 2, JSON.stringify(health.sessions));

  t1b.close(); t2.close();
  await sleep(200);

  // ============================== Part B ==============================
  sandbox2 = makeSandbox('/tmp/zwebui-ka.XXXXXX');
  mkdirSync(path.join(sandbox2, 'zcode/server'), { recursive: true });
  symlinkSync(process.execPath, path.join(sandbox2, 'zcode/server/node'));
  writeFileSync(path.join(sandbox2, 'zcode/server/zcode-server.cjs'), FAKE_HOST);

  const port2 = 3500 + Math.floor(Math.random() * 200);
  const base2 = 'http://127.0.0.1:' + port2 + '/';
  const PING_MS = 4000, MAX_MISS = 2;
  server2 = startServer(sandbox2, port2, {
    ZCODE_WEBUI_WS_PING_MS: String(PING_MS),
    ZCODE_WEBUI_WS_PING_MAX_MISS: String(MAX_MISS),
  });
  check('B: sandbox server up (leniency env)', await waitHealth(base2));

  const id2 = await identity(base2);
  const first = await wsClient(base2, id2, 'tab-B1', false); // keepalive: raw no-pong client below
  await sleep(300);
  first.close();

  // raw upgrade, then NEVER answer pings — old code killed this at the first
  // missed ping (~PING_MS); the new default tolerates MAX_MISS misses
  const t0 = Date.now();
  const dead = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    setTimeout(() => finish(-1), 30000).unref();           // hard fallback, upgrade or not
    const key = randomBytes(16).toString('base64');   // ws validates the 22+== base64 shape
    const req = http.get(base2.replace(/\/$/, '') + '/ws?token=' + id2.wsToken + '&tab=tab-B2', {
      headers: {
        cookie: id2.cookie,
        connection: 'upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
      },
    });
    req.on('upgrade', (res, socket) => {
      // swallow everything (incl. pings) — never send a pong
      socket.on('data', () => {});
      socket.on('close', () => finish(Date.now() - t0));
      socket.on('error', () => finish(Date.now() - t0));
    });
    req.on('response', () => finish(-3));               // non-101 answer: surface it
    req.on('error', () => finish(-2));
  });
  const aliveAtFirstMiss = dead > PING_MS * 1.6;             // survived one full unanswered ping cycle
  const deadEventually = dead > 0 && dead < PING_MS * (MAX_MISS + 2);
  check('B: no-pong client survived the FIRST missed ping (leniency)', aliveAtFirstMiss, 'closed after ' + dead + 'ms');
  check('B: no-pong client terminated after ~' + MAX_MISS + ' misses', deadEventually, 'closed after ' + dead + 'ms');
  check('B: unresponsive log names the miss count', server2.log.some((l) => l.includes('no pong for')));
} catch (e) {
  console.log('FAIL  ' + (e && e.message ? e.message : e));
  checks.push(false);
}

cleanup();
const failed = checks.filter((c) => !c).length;
console.log(failed === 0 ? 'RESUME-REPLAY OK' : 'RESUME-REPLAY FAILED (' + failed + ')');
process.exit(failed ? 1 : 0);
