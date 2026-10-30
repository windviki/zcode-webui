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
// inbound call (100) is answered with a response (201) — except methods 'hold'
// and 'holdbig', which are remembered unanswered; a 'go' call answers everything
// held first. 'holdbig' answers with a 2 MiB body so the parked-era buffer has
// to skip an oversized RESPONSE frame instead of dropping the whole gap.
const FAKE_HOST = `
const path = require('path');
(async () => {
  const { encodeRpcHeader } = await import(require('url').pathToFileURL(path.join(process.env.ZWEBUI_FAKE_HOST_ROOT, 'src', 'rpclog.mjs')).href);
  const enc = (payload) => { const b = Buffer.alloc(13 + payload.length); b.writeUInt8(1, 0); b.writeUInt32BE(0, 1); b.writeUInt32BE(0, 5); b.writeUInt32BE(payload.length, 9); payload.copy(b, 13); return b; };
  const body = Buffer.from([0]);
  const bigBody = Buffer.alloc(2 * 1024 * 1024, 0x41);
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
      if (hdr[3] === 'hold' || hdr[3] === 'holdbig') { held.push(hdr); continue; }
      if (hdr[3] === 'go') {
        for (const c of held) {
          const payloadBody = c[3] === 'holdbig' ? bigBody : body;
          process.stdout.write(enc(Buffer.concat([encodeRpcHeader([201, c[1], c[2], c[3]]), payloadBody])));
        }
        held.length = 0;
      }
      process.stdout.write(enc(Buffer.concat([encodeRpcHeader([201, hdr[1], hdr[2], hdr[3]]), body])));
    }
  });
})();
`;

async function makeSandbox(prefix) {
  const sandbox = mkdtempSync(prefix);
  for (const d of ['home', 'zcode/v2', 'data/vendor/renderer']) mkdirSync(path.join(sandbox, d), { recursive: true });
  writeFileSync(path.join(sandbox, 'zcode/v2/credentials.json'),
    JSON.stringify({ 'oauth:bigmodel:access_token': 't', 'oauth:bigmodel:user_info': '{"id":"resumetest"}' }));
  // /api/active reads the tasks index (read-only); give it a valid empty one
  try {
    const { createRequire } = await import('node:module');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(path.join(sandbox, 'zcode/v2/tasks-index.sqlite'));
    db.exec('CREATE TABLE IF NOT EXISTS tasks (task_id TEXT, task_status TEXT, updated_at INTEGER, title TEXT)');
    db.close();
  } catch (_e) { console.log('WARN sandbox tasks-index fixture failed:', _e.message); }
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

// HTTP relay client (bootstrap.js's fallback transport): /bridge/open attaches
// this page as a VIEW, /bridge/send carries uplink frames, /bridge/poll returns
// length-prefixed downlink frames.
async function relayClient(base, id, tab, resume) {
  const r = await fetch(base + 'bridge/open?tab=' + encodeURIComponent(tab) + (resume ? '&resume=1' : ''), {
    method: 'POST', headers: { cookie: id.cookie },
  });
  const o = await r.json();
  if (!o.ok) return { open: o, frames: [], failed: true };
  const client = {
    open: o, id: o.id, frames: [], texts: [],
    async sendLine(idNum, method) {
      const body = Buffer.concat([encodeRpcHeader([100, idNum, 'zwebui-test', method]), Buffer.from([0])]);
      const res = await fetch(base + 'bridge/send?id=' + o.id, {
        method: 'POST', headers: { cookie: id.cookie, 'content-type': 'application/octet-stream' }, body,
      });
      return res.status;
    },
    async sendText(text) {
      const res = await fetch(base + 'bridge/send?id=' + o.id, {
        method: 'POST', headers: { cookie: id.cookie, 'content-type': 'application/octet-stream' }, body: Buffer.from(text),
      });
      return res.status;
    },
    async pollOnce() {
      const res = await fetch(base + 'bridge/poll?id=' + o.id, { headers: { cookie: id.cookie } });
      if (!res.ok) return [];
      const buf = Buffer.from(await res.arrayBuffer());
      const out = [];
      let off = 0;
      while (off + 4 <= buf.length) {
        const len = buf.readUInt32BE(off);
        off += 4;
        if (off + len > buf.length) break;
        const payload = buf.subarray(off, off + len);
        off += len;
        out.push(payload);
        if (payload.length > 1 && payload[0] === 0x7b) { client.texts.push(payload.toString('utf8')); continue; }
        const hdr = decodeRpc(payload);
        if (hdr) client.frames.push({ hdr, raw: Buffer.from(payload) });
      }
      return out;
    },
    async close() {
      await fetch(base + 'bridge/close?id=' + o.id, { method: 'POST', headers: { cookie: id.cookie } });
    },
  };
  return client;
}

let sandbox = null, server = null, sandbox2 = null, server2 = null, sandbox3 = null, server3 = null, sandbox4 = null, server4 = null;
function cleanup() {
  for (const s of [server, server2, server3, server4]) { try { if (s && s.exitCode === null) s.kill('SIGKILL'); } catch (_e) { /* ignore */ } }
  for (const s of [sandbox, sandbox2, sandbox3, sandbox4]) { try { if (s) rmSync(s, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

try {
  // ============================== Part A ==============================
  sandbox = await makeSandbox('/tmp/zwebui-resume.XXXXXX');
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

  // ---- /api/active: restart-safety signal. At this moment the session is
  // ATTACHED and only trickling handshake frames (well under the streaming
  // threshold), and the sandbox index is empty — the all-clear state.
  const active = await (await fetch(base + 'api/active')).json();
  check('A: /api/active answers with a boolean + detail', active && typeof active.active === 'boolean'
    && Array.isArray(active.reasons) && Array.isArray(active.tasks), JSON.stringify(active).slice(0, 140));
  check('A: attached-but-idle session reports NOT active', active.active === false && active.indexOk === true,
    'reasons=' + JSON.stringify(active.reasons));

  t1b.close(); t2.close();
  await sleep(200);

  // ---- lost-call synthesis: a call whose response never arrived before the
  // disconnect must be answered with a synthesized 202 on resume — otherwise
  // the renderer's promise hangs forever and consumers like the file tree
  // wedge on their `loading` dedup ("folder won't open until refresh")
  const t3 = await wsClient(base, id, 'tab-A3', false);
  t3.portReady();
  await sleep(250);
  t3.sendCall(1, 'hold');                    // the fake host never answers holds
  await sleep(250);
  t3.close();                                // era parks with the call in flight
  await sleep(400);
  const t3b = await wsClient(base, id, 'tab-A3', true);
  await sleep(400);
  const lost = t3b.frames.find((f) => f.hdr && f.hdr.type === 202 && f.hdr.id === 1);
  check('A: in-flight call lost across the gap answered with synthesized 202', !!lost,
    lost ? JSON.stringify(lost.hdr) : 'none received');
  check('A: synthesis logged', server.log.some((l) => l.includes('synthesizing timeout errors')));
  // calls made AFTER the resume are untouched (fresh pending.at > parkedAt)
  t3b.sendCall(2, 'hold');
  await sleep(400);
  const lateSynth = t3b.frames.find((f) => f.hdr && f.hdr.type === 202 && f.hdr.id === 2);
  check('A: post-resume calls are not synthesized away', !lateSynth);
  t3b.close();
  await sleep(200);

  // after the last tab leaves, a DETACHED session with fresh frames reads as
  // active (it may be mid-turn with the viewer gone — exactly what the
  // restart guard must respect)
  const activeAfter = await (await fetch(base + 'api/active')).json();
  check('A: detached session with fresh frames reads as active',
    activeAfter.active === true && activeAfter.detachedBusy.length === 1,
    'reasons=' + JSON.stringify(activeAfter.reasons));

  // ============================== Part B ==============================
  sandbox2 = await makeSandbox('/tmp/zwebui-ka.XXXXXX');
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

  // ============================== Part C ==============================
  // Presence lease + oversized response: a live page keeps its detached host
  // and parked era past the TTL; a single huge RESPONSE frame is skipped (not
  // the whole gap) and answered with a retryable 202 on resume.
  sandbox3 = await makeSandbox('/tmp/zwebui-presence.XXXXXX');
  mkdirSync(path.join(sandbox3, 'zcode/server'), { recursive: true });
  symlinkSync(process.execPath, path.join(sandbox3, 'zcode/server/node'));
  writeFileSync(path.join(sandbox3, 'zcode/server/zcode-server.cjs'), FAKE_HOST);

  const port3 = 3700 + Math.floor(Math.random() * 200);
  const base3 = 'http://127.0.0.1:' + port3 + '/';
  const TTL = 900, REAP = 250, PARK = 500, LEASE = 2500;
  server3 = startServer(sandbox3, port3, {
    ZCODE_WEBUI_DETACHED_TTL_MS: String(TTL),
    ZCODE_WEBUI_REAP_INTERVAL_MS: String(REAP),
    ZCODE_WEBUI_RESUME_PARK_MS: String(PARK),
    ZCODE_WEBUI_PRESENCE_LEASE_MS: String(LEASE),
    ZCODE_WEBUI_FRAME_QUIET_MS: '100',
    ZCODE_WEBUI_RESUME_BUF_MAX_MB: '1',
    ...(process.env.RESUME_TEST_DEBUG ? { ZCODE_WEBUI_DEBUG_RPC: '1' } : {}),
  });
  check('C: sandbox server up (presence/oversized env)', await waitHealth(base3));

  const id3 = await identity(base3);
  const sendPresence = (tab, closing, ttlMs) => fetch(base3 + 'api/presence', {
    method: 'POST',
    headers: { cookie: id3.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ tab, state: 'visible', closing: !!closing, ...(ttlMs ? { ttlMs } : {}) }),
  }).then((r) => r.json());

  const c1 = await wsClient(base3, id3, 'tab-C1', false);
  await sleep(300);
  c1.sendCall(1, 'holdbig');                 // host remembers it, answers only on 'go'
  await sleep(250);
  await sendPresence('tab-C1');              // page is alive before the socket drops
  c1.close();
  await sleep(100);
  // Renew the lease beyond DETACHED_TTL_MS and RESUME_PARK_MS. The host and the
  // parked era must both survive: this is the "long background, same tab" case.
  for (let i = 0; i < 8; i++) { await sendPresence('tab-C1'); await sleep(300); }
  const alive3 = await (await fetch(base3 + 'api/health')).json();
  check('C: live presence lease keeps the detached host alive past TTL', alive3.sessions.total === 1, JSON.stringify(alive3.sessions));
  check('C: live presence lease keeps the parked era (not retired)',
    !server3.log.some((l) => l.includes('parked era retired tab=tab-C1')));

  // Another viewer triggers the held call while tab C1 is parked. Its response is
  // 2 MiB > the 1 MiB replay cap: skip the response, keep the gap.
  const c2 = await wsClient(base3, id3, 'tab-C2', false);
  c2.portReady();
  await sleep(250);
  c2.sendCall(1, 'go');
  await sleep(700);
  check('C: oversized response skipped', server3.log.some((l) => l.includes('skipped oversized response tab=tab-C1')));
  check('C: oversized response did NOT overflow the whole gap',
    !server3.log.some((l) => l.includes('resume gap buffer overflowed tab=tab-C1')));
  if (process.env.RESUME_TEST_DEBUG) {
    console.log('--- server3 log (tail) ---');
    console.log(server3.log.slice(-60).join('\n'));
  }

  const c1b = await wsClient(base3, id3, 'tab-C1', true);
  await sleep(500);
  const synthBig = c1b.frames.find((f) => f.hdr && f.hdr.type === 202 && f.hdr.id === 1);
  check('C: resumed tab gets a retryable 202 for the skipped response', !!synthBig,
    synthBig ? JSON.stringify(synthBig.hdr.body).slice(0, 160) : 'none');
  check('C: synthesized error explains the oversized response',
    !!(synthBig && synthBig.hdr.body && /too large for the offline replay buffer/.test(String(synthBig.hdr.body.message || ''))));
  c1b.close(); c2.close();
  await sleep(100);

  // Stop renewing the lease: after LEASE + TTL the host is reaped again.
  await sleep(LEASE + TTL + REAP * 4);
  const gone3 = await (await fetch(base3 + 'api/health')).json();
  check('C: expired lease lets the detached host be reaped', gone3.sessions.total === 0, JSON.stringify(gone3.sessions));

  // A frozen/bfcache page sends one long-ttl lease instead of the 45 s
  // heartbeat. It must survive beyond the normal lease, then still expire.
  const FROZEN_TTL = LEASE * 3;
  const c3 = await wsClient(base3, id3, 'tab-C3', false);
  await sleep(250);
  await sendPresence('tab-C3', false, FROZEN_TTL);
  c3.close();
  await sleep(LEASE + TTL + REAP * 2);
  const frozenAlive = await (await fetch(base3 + 'api/health')).json();
  check('C: frozen-tab long lease survives past the normal lease', frozenAlive.sessions.total === 1, JSON.stringify(frozenAlive.sessions));
  await sleep(FROZEN_TTL - LEASE + TTL + REAP * 4);
  const frozenGone = await (await fetch(base3 + 'api/health')).json();
  check('C: frozen-tab long lease expires and the host is reaped', frozenGone.sessions.total === 0, JSON.stringify(frozenGone.sessions));
  // ============================== Part D ==============================
  // HTTP fallback transport must be a VIEW of the account's one host, not a
  // second host of its own. A second host never received the renderer's
  // conversation handshake, so after a mid-session ws→http switch every
  // zcode-agent.* call failed with fault.connection.handshakeRequired — the
  // "handshake is required" send failure behind the composer doing nothing.
  sandbox4 = await makeSandbox('/tmp/zwebui-relay.XXXXXX');
  mkdirSync(path.join(sandbox4, 'zcode/server'), { recursive: true });
  symlinkSync(process.execPath, path.join(sandbox4, 'zcode/server/node'));
  writeFileSync(path.join(sandbox4, 'zcode/server/zcode-server.cjs'), FAKE_HOST);

  const port4 = 3900 + Math.floor(Math.random() * 200);
  const base4 = 'http://127.0.0.1:' + port4 + '/';
  server4 = startServer(sandbox4, port4);
  check('D: sandbox server up (relay adoption)', await waitHealth(base4));
  const id4 = await identity(base4);

  const d1 = await wsClient(base4, id4, 'tab-D1', false);
  await sleep(300);
  const before = await (await fetch(base4 + 'api/health')).json();
  check('D: ws page spawned ONE host', before.sessions.total === 1, JSON.stringify(before.sessions));

  // a cold relay page (booted straight into http mode) joins the SAME host
  const relay1 = await relayClient(base4, id4, 'tab-D2', false);
  check('D: relay open succeeded', !relay1.failed, JSON.stringify(relay1.open));
  const afterOpen = await (await fetch(base4 + 'api/health')).json();
  check('D: relay did NOT spawn a second host', afterOpen.sessions.total === 1, JSON.stringify(afterOpen.sessions));
  check('D: relay attached as a second view', afterOpen.sessions.views === 2, JSON.stringify(afterOpen.sessions));
  check('D: relay adopted the running host', server4.log.some((l) => l.includes('http session opened') && l.includes('(adopted)')));
  await relay1.sendText('{"kind":"zcode-webui-port-ready"}');
  await sleep(300);
  await relay1.pollOnce();
  check('D: adopted relay got the Initialize replay', relay1.frames.some((f) => f.hdr && f.hdr.type === 200));

  // uplink frames reach the host, responses come back through /bridge/poll with
  // the renderer-LOCAL id restored (the mux translated it on the way in)
  const st = await relay1.sendLine(7, 'pingme');
  check('D: relay send accepted', st === 200, 'status=' + st);
  await sleep(400);
  await relay1.pollOnce();
  const relayResp = relay1.frames.find((f) => f.hdr && f.hdr.type === 201 && f.hdr.method === 'pingme');
  check('D: relay got its response back', !!relayResp, relayResp ? JSON.stringify(relayResp.hdr).slice(0, 120) : 'none');
  check('D: response carries the renderer-local id', relayResp && relayResp.hdr.id === 7, 'id=' + (relayResp && relayResp.hdr.id));

  // THE regression: a page booted over ws loses its socket and flips to the
  // relay. The SAME host must answer it (same era, same mux ids) — proof the
  // transport swap no longer strands the page on a host that never received the
  // conversation handshake ("handshake is required" on send).
  const d2 = await wsClient(base4, id4, 'tab-D4', false);
  await sleep(250);
  d2.sendCall(1, 'hold');                    // in flight when the socket dies
  await sleep(250);
  d2.close();
  await sleep(250);
  // the parked era's buffered response (a call ANSWERED while the tab was away)
  // must be replayed over the relay: d1's 'go' makes the fake host answer 'hold'
  d1.sendCall(9, 'go');
  await sleep(400);
  const relay2 = await relayClient(base4, id4, 'tab-D4', true);
  check('D: mid-session relay switch succeeded', !relay2.failed && !relay2.open.staleEra, JSON.stringify(relay2.open));
  const swapped = await (await fetch(base4 + 'api/health')).json();
  check('D: transport swap kept the SAME host', swapped.sessions.total === 1, JSON.stringify(swapped.sessions));
  await relay2.pollOnce();
  const held = relay2.frames.find((f) => f.hdr && f.hdr.type === 201 && f.hdr.method === 'hold');
  check('D: response buffered while parked replayed over the relay', !!held, held ? JSON.stringify(held.hdr).slice(0, 120) : 'none');
  check('D: replayed response kept the renderer-local id', held && held.hdr.id === 1, 'id=' + (held && held.hdr.id));
  // and the swapped page can keep working through the relay (mux ids allocated
  // after the swap still round-trip)
  const stSwap = await relay2.sendLine(2, 'after-swap');
  await sleep(400);
  await relay2.pollOnce();
  check('D: calls sent after the swap round-trip over the relay',
    stSwap === 200 && relay2.frames.some((f) => f.hdr && f.hdr.type === 201 && f.hdr.method === 'after-swap' && f.hdr.id === 2),
    'status=' + stSwap);

  // a call that is STILL unanswered when the socket dies cannot be left hanging:
  // the swapped page gets the synthesized retryable 202 on the relay
  const d3 = await wsClient(base4, id4, 'tab-D5', false);
  await sleep(250);
  d3.sendCall(5, 'hold');                    // never answered
  await sleep(250);
  d3.close();
  await sleep(250);
  const relay3 = await relayClient(base4, id4, 'tab-D5', true);
  await sleep(200);
  await relay3.pollOnce();
  const synth = relay3.frames.find((f) => f.hdr && f.hdr.type === 202 && f.hdr.id === 5);
  check('D: unanswered in-flight call gets a synthesized 202 on the relay', !!synth,
    synth ? JSON.stringify(synth.hdr.body || {}).slice(0, 120) : 'none');
  await relay3.close();
  await sleep(200);

  // pagehide / reload of the relay page only drops the VIEW: a running turn on
  // the shared host must survive
  const viewsBefore = (await (await fetch(base4 + 'api/health')).json()).sessions.views;
  await relay1.close();
  await sleep(300);
  const afterClose = await (await fetch(base4 + 'api/health')).json();
  check('D: relay close kept the host alive', afterClose.sessions.total === 1, JSON.stringify(afterClose.sessions));
  check('D: relay close detached only that view', afterClose.sessions.views === viewsBefore - 1,
    'viewsBefore=' + viewsBefore + ' after=' + JSON.stringify(afterClose.sessions));

  // a page that already booted cannot silently land on a host without its era:
  // the server says so and bootstrap reloads (clean re-bootstrap)
  const stale = await relayClient(base4, id4, 'tab-never-seen', true);
  check('D: stale-era relay resume is rejected with staleEra', !!stale.failed && stale.open.staleEra === true, JSON.stringify(stale.open));

  await relay2.close();
  try { d1.close(); } catch (_e) { /* ignore */ }

} catch (e) {
  console.log('FAIL  ' + (e && e.message ? e.message : e));
  checks.push(false);
}

cleanup();
const failed = checks.filter((c) => !c).length;
console.log(failed === 0 ? 'RESUME-REPLAY OK' : 'RESUME-REPLAY FAILED (' + failed + ')');
process.exit(failed ? 1 : 0);
