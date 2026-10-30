// Reaper safety regression (protocol-level, no real runtime):
//
//   A — a detached host that is still streaming frames must NOT be reaped, and
//       its parked-era event subscriptions must not be disposed at the old
//       10-minute / RESUME_PARK_MS boundary (that disposal removed the reaper's
//       only liveness signal and caused the 2026-10-18 mid-turn interruptions).
//   B — a detached host with no frames but a recent official-CLI DB write must
//       not be reaped; once the write is old it is reaped normally.
//   C — an unmatched model.request.started in the official CLI log (a slow SSE
//       call can be silent for 27+ minutes) must keep the host alive; appending
//       its completion makes the host reapable again.
//   D — /bridge/close during an active HTTP relay must defer the close instead
//       of killing the turn; the relay is closed once it goes idle.
//
// All cases use a scripted fake host; no real ZCode runtime, network or API
// quota is touched. Usage: node scripts/dev/reaper-guard-test.mjs
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Scripted host: hello + Initialize, answers every call with 201, and can emit
// downstream frames on demand (or automatically for the relay test).
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
  let ticker = null;
  function startTicks(ms) {
    if (ticker) return;
    ticker = setInterval(() => {
      try { process.stdout.write(enc(Buffer.concat([encodeRpcHeader([204, 0, 'zwebui-test', 'tick']), body]))); } catch (e) { /* ignore */ }
    }, ms || 200);
    if (ticker.unref) ticker.unref();
  }
  function stopTicks() { if (ticker) { clearInterval(ticker); ticker = null; } }
  if (process.env.ZWEBUI_FAKE_TICKS === '1') {
    setTimeout(() => startTicks(Number(process.env.ZWEBUI_FAKE_TICK_MS) || 150), 100);
    const forMs = Number(process.env.ZWEBUI_FAKE_TICK_FOR_MS) || 0;
    if (forMs > 0) setTimeout(stopTicks, forMs);
  }
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
      if (hdr[3] === 'startTicks') { startTicks(Number(process.env.ZWEBUI_FAKE_TICK_MS) || 200); continue; }
      if (hdr[3] === 'stopTicks') { stopTicks(); continue; }
      process.stdout.write(enc(Buffer.concat([encodeRpcHeader([201, hdr[1], hdr[2], hdr[3]]), body])));
    }
  });
  process.on('exit', stopTicks);
  process.stdin.on('end', stopTicks);
  process.stdin.on('close', () => process.exit(0));
  process.stdout.on('error', () => process.exit(0));
})();
`;

function makeSandbox(prefix) {
  const sandbox = mkdtempSync(prefix);
  for (const d of ['home', 'zcode/v2', 'zcode/server', 'zcode/cli/db', 'zcode/cli/log', 'data/vendor/renderer']) {
    mkdirSync(path.join(sandbox, d), { recursive: true });
  }
  writeFileSync(path.join(sandbox, 'zcode/v2/credentials.json'),
    JSON.stringify({ 'oauth:bigmodel:access_token': 't', 'oauth:bigmodel:user_info': '{"id":"reapertest"}' }));
  writeFileSync(path.join(sandbox, 'zcode/server/zcode-server.cjs'), FAKE_HOST);
  symlinkSync(process.execPath, path.join(sandbox, 'zcode/server/node'));
  writeFileSync(path.join(sandbox, 'data/vendor/renderer/index.html'),
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head><body><div id="root"></div></body></html>');
  // A readable, empty tasks index is required: an unreadable one deliberately
  // disables reaping (fail-safe), which would make every negative test vacuous.
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const tasksDb = new DatabaseSync(path.join(sandbox, 'zcode/v2/tasks-index.sqlite'));
  try {
    tasksDb.exec('CREATE TABLE IF NOT EXISTS tasks (task_id TEXT, task_status TEXT, updated_at INTEGER, title TEXT)');
  } finally { tasksDb.close(); }
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
      ZCODE_SERVER_RUNTIME_ROOT: path.join(sandbox, 'zcode/server'),
      ZCODE_WEBUI_DETACHED_TTL_MS: '1500',
      ZCODE_WEBUI_FRAME_QUIET_MS: '800',
      ZCODE_WEBUI_REAP_INTERVAL_MS: '1200',
      ZCODE_WEBUI_RESUME_PARK_MS: '1000',
      ZCODE_WEBUI_AGENT_WRITE_ACTIVE_MS: '1000',
      ZCODE_WEBUI_HTTP_RELAY_TTL_MS: '1500',
      ZCODE_WEBUI_DEFERRED_RELAY_CLOSE_IDLE_MS: '800',
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
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + 'api/health'); if (r.ok) return await r.json(); } catch (_e) { /* retry */ }
    await sleep(200);
  }
  throw new Error('server did not become healthy');
}

async function identity(base) {
  const res = await fetch(base);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const html = await res.text();
  const cfg = JSON.parse(html.match(/window\.__ZCODE_WEBUI_CONFIG__ = (\{.*?\});/)[1]);
  return { cookie, wsToken: cfg.wsToken };
}

function wsClient(base, { cookie, wsToken }, tab) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + 'ws?token=' + wsToken + '&tab=' + tab,
      { headers: { cookie } });
    let verified = false;
    ws.on('message', (data, isBinary) => {
      if (!isBinary && !verified && String(data) === '{"kind":"zcode-webui-ready"}') {
        verified = true;
        resolve({ ws, close: () => { try { ws.close(); } catch (_e) { /* ignore */ } } });
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws verify timeout')), 8000);
  });
}

const servers = [];
const sandboxes = [];
function cleanup() {
  for (const s of servers) { try { if (s && s.exitCode === null) s.kill('SIGKILL'); } catch (_e) { /* ignore */ } }
  for (const s of sandboxes) { try { if (s) rmSync(s, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

try {
  // ---------- A: frames from a parked host keep it alive ----------
  {
    const sb = makeSandbox('/tmp/zwebui-reaper-a.XXXXXX');
    sandboxes.push(sb);
    const port = 3400 + Math.floor(Math.random() * 300);
    const base = 'http://127.0.0.1:' + port + '/';
    const srv = startServer(sb, port, {
      ZWEBUI_FAKE_TICKS: '1',
      ZWEBUI_FAKE_TICK_MS: '150',
    });
    servers.push(srv);
    await waitHealth(base);
    const id = await identity(base);
    const c = await wsClient(base, id, 'tab-A');
    await sleep(300);
    c.close();
    await sleep(3200);
    const health = await (await fetch(base + 'api/health')).json();
    check('A: detached host with live frames is NOT reaped', health.sessions.total === 1, JSON.stringify(health.sessions));
    check('A: parked-era subscriptions were not retired while active', !srv.log.some((l) => l.includes('parked era retired')));
  }

  // ---------- B: fresh CLI DB write keeps a silent host alive ----------
  {
    const sb = makeSandbox('/tmp/zwebui-reaper-b.XXXXXX');
    sandboxes.push(sb);
    // Build the activity DB before the server starts (the reaper seeds from it).
    const { createRequire } = await import('node:module');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const dbPath = path.join(sb, 'zcode/cli/db/db.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
    db.exec('CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
    db.exec('CREATE TABLE session_entry (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m1', 'sess_test', Date.now(), Date.now(), '{}');
    db.close();
    const port = 3700 + Math.floor(Math.random() * 200);
    const base = 'http://127.0.0.1:' + port + '/';
    const srv = startServer(sb, port, { ZCODE_WEBUI_AGENT_WRITE_ACTIVE_MS: '5000' });
    servers.push(srv);
    await waitHealth(base);
    const id = await identity(base);
    const c = await wsClient(base, id, 'tab-B');
    await sleep(300);
    c.close();
    await sleep(2000);
    let health = await (await fetch(base + 'api/health')).json();
    check('B: silent host with a recent CLI DB write is NOT reaped', health.sessions.total === 1, JSON.stringify(health.sessions));

    const db2 = new DatabaseSync(dbPath);
    db2.prepare('UPDATE message SET time_updated=? WHERE id=?').run(Date.now() - 60 * 60 * 1000, 'm1');
    db2.close();
    await sleep(6000);
    health = await (await fetch(base + 'api/health')).json();
    check('B: same host is reaped after the write window lapses', health.sessions.total === 0, JSON.stringify(health.sessions));
    check('B: reaper log explains the idle reap', srv.log.some((l) => l.includes('reaping idle detached host')));
  }

  // ---------- C: in-flight model request in the CLI log ----------
  {
    const sb = makeSandbox('/tmp/zwebui-reaper-c.XXXXXX');
    sandboxes.push(sb);
    const day = new Date().toISOString().slice(0, 10);
    const logPath = path.join(sb, 'zcode/cli/log', 'zcode-' + day + '.jsonl');
    const started = { timestamp: new Date().toISOString(), event: 'model.request.started', turnId: 'turn_C', sessionId: 'sess_C', context: { queryId: 'q_C' } };
    writeFileSync(logPath, JSON.stringify(started) + '\n');
    const port = 3900 + Math.floor(Math.random() * 90);
    const base = 'http://127.0.0.1:' + port + '/';
    const srv = startServer(sb, port);
    servers.push(srv);
    await waitHealth(base);
    const id = await identity(base);
    const c = await wsClient(base, id, 'tab-C');
    await sleep(300);
    c.close();
    await sleep(2200);
    let active = await (await fetch(base + 'api/active')).json();
    check('C: /api/active sees the in-flight model request', active.active === true && active.modelRequestActive === true, JSON.stringify(active.reasons));
    let health = await (await fetch(base + 'api/health')).json();
    check('C: silent host with a model request in flight is NOT reaped', health.sessions.total === 1, JSON.stringify(health.sessions));

    appendFileSync(logPath, JSON.stringify({ timestamp: new Date().toISOString(), event: 'model.request.completed', turnId: 'turn_C', sessionId: 'sess_C', context: { queryId: 'q_C' } }) + '\n');
    await sleep(6500);
    active = await (await fetch(base + 'api/active')).json();
    check('C: /api/active clears after the completion line', active.modelRequestActive === false);
    health = await (await fetch(base + 'api/health')).json();
    check('C: host is reaped after the request completes', health.sessions.total === 0, JSON.stringify(health.sessions));
  }

  // ---------- D: pagehide close defers while the relay is active ----------
  {
    const sb = makeSandbox('/tmp/zwebui-reaper-d.XXXXXX');
    sandboxes.push(sb);
    const port = 4100 + Math.floor(Math.random() * 90);
    const base = 'http://127.0.0.1:' + port + '/';
    const srv = startServer(sb, port, {
      ZWEBUI_FAKE_TICKS: '1',
      ZWEBUI_FAKE_TICK_MS: '150',
      ZWEBUI_FAKE_TICK_FOR_MS: '1800',
    });
    servers.push(srv);
    await waitHealth(base);
    const id = await identity(base);
    const opened = await (await fetch(base + 'bridge/open', { method: 'POST', headers: { cookie: id.cookie } })).json();
    check('D: HTTP relay opened', opened.ok === true && !!opened.id);
    let health = await (await fetch(base + 'api/health')).json();
    check('D: relay attached as a view of the account host', health.sessions.total === 1 && health.sessions.views === 1,
      JSON.stringify(health.sessions));
    await sleep(350);
    // pagehide / reload: the relay VIEW goes away, the host (mid-turn) does not.
    // This used to be "defer the close while the agent is busy"; now the close
    // can never touch the host at all, so the turn keeps running either way.
    await fetch(base + 'bridge/close?id=' + encodeURIComponent(opened.id), { method: 'POST', headers: { cookie: id.cookie } });
    await sleep(500);
    health = await (await fetch(base + 'api/health')).json();
    check('D: close drops the relay view', health.httpRelays === 0, 'httpRelays=' + health.httpRelays);
    check('D: close keeps the host (an active turn is not killed)', health.sessions.total === 1, JSON.stringify(health.sessions));
    check('D: close is logged as "host kept"', srv.log.some((l) => l.includes('host kept')));
    await sleep(4000);
    health = await (await fetch(base + 'api/health')).json();
    // the sandbox TTL is short: the IDLE REAPER (not the page close) is what
    // eventually reclaims it
    check('D: the host is reclaimed later by the idle reaper, not by the page close',
      health.sessions.total === 0 && srv.log.some((l) => l.includes('reaping idle detached host')),
      JSON.stringify(health.sessions));
  }
} catch (e) {
  console.log('FAIL  ' + (e && e.stack ? e.stack : e));
  checks.push(false);
}

cleanup();
const failed = checks.filter((c) => !c).length;
console.log(failed === 0 ? 'REAPER-GUARD OK' : 'REAPER-GUARD FAILED (' + failed + ')');
process.exit(failed ? 1 : 0);
