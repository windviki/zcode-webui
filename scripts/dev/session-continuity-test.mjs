// Session-continuity suite:
//   S1  device switch adopts the DETACHED host (same pid!), replays Initialize
//       as the very FIRST byte stream, then serves live traffic on one pipe
//   S2  a genuinely-attached sibling elsewhere still triggers the
//       "another execution in progress" control message (dual-page warning)
//   S3  POST /api/sessions/terminate?user=1&keepTab=X kills only the others
//   S4  regression: a client writing its FIRST protocol frame instantly after
//       the ready signal still gets replies (historic drop/wedge bugs)
// Isolated sandbox ZCODE_HOME/data-home/private port; production untouched.
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { writeFileSync as wfs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const PORT = Number(process.env.ZWEBUI_TEST_PORT || 3197);
const origin = 'http://127.0.0.1:' + PORT;
const INIT_HEX = '040106c80100';

function writeVQL(v) {
  const b = [];
  if (v === 0) return Buffer.from([0]);
  let x = v;
  while (x !== 0) { b.push(x & 127); x = x >>> 7; }
  for (let i = 0; i < b.length - 1; i++) b[i] |= 128;
  return Buffer.from(b);
}
function serialize(d) {
  const p = [];
  if (d === undefined) p.push(Buffer.from([0]));
  else if (typeof d === 'string') { const b = Buffer.from(d); p.push(Buffer.from([1]), writeVQL(b.length), b); }
  else if (Array.isArray(d)) { p.push(Buffer.from([4]), writeVQL(d.length)); d.forEach((e) => p.push(serialize(e))); }
  else if (typeof d === 'number') p.push(Buffer.from([6]), writeVQL(d));
  else if (d && typeof d === 'object') { const b = Buffer.from(JSON.stringify(d)); p.push(Buffer.from([5]), writeVQL(b.length), b); }
  else throw new Error('unsupported');
  return Buffer.concat(p);
}
const systemInfo = () => Buffer.concat([serialize([100, 1, 'system', 'info']), serialize(undefined)]);

function fail(m) { console.error('FAIL:', m); wfs('/tmp/cont-fail-srv.log', srvLog); console.error('--- full server log -> /tmp/cont-fail-srv.log'); cleanup(); process.exit(1); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const SB = mkdtempSync('/tmp/zwebui-cont.XXXXXX');
mkdirSync(path.join(SB, 'home'), { recursive: true });
mkdirSync(path.join(SB, 'zcode/v2'), { recursive: true });
mkdirSync(path.join(SB, 'data/vendor'), { recursive: true });
cpSync(path.join(os.homedir(), '.zcode/server'), path.join(SB, 'zcode/server'), { recursive: true });
cpSync(path.join(ROOT, 'vendor/renderer'), path.join(SB, 'data/vendor/renderer'), { recursive: true });
writeFileSync(path.join(SB, 'zcode/v2/credentials.json'),
  JSON.stringify({ 'oauth:bigmodel:access_token': 't', 'oauth:bigmodel:user_info': '{"id":"contuser"}' }));

let srvLog = '';
const srv = spawn(process.execPath, [path.join(ROOT, 'src/server.mjs'), '--port', String(PORT)], {
  env: { ...process.env, ZCODE_WEBUI_HOME: path.join(SB, 'data'), ZCODE_HOME: path.join(SB, 'zcode'), HOME: path.join(SB, 'home') },
  stdio: ['ignore', 'ignore', 'pipe'],
});
srv.stderr.on('data', (d) => { srvLog += d.toString(); });
function cleanup() {
  try { if (srv.exitCode === null) srv.kill('SIGKILL'); } catch (_e) { /* ignore */ }
  try { rmSync(SB, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}
process.on('exit', cleanup);

async function waitHealthy() {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(origin + '/api/health'); if (r.ok) return r.json(); } catch (_e) { /* retry */ }
    await sleep(500);
  }
  fail('server never healthy');
}
async function token() {
  const html = await (await fetch(origin + '/')).text();
  return JSON.parse(/window\.__ZCODE_WEBUI_CONFIG__ = (\{.*?\});/.exec(html)[1]).wsToken;
}

class Page {
  constructor(tab, tok) {
    this.tab = tab;
    this.texts = [];
    this.binaries = [];
    this.readyDone = false;
    this.closedCode = null;
    const done = (c) => { this.closedCode = this.closedCode ?? c; };
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${tok}&tab=${tab}`);
    this.ws.binaryType = 'arraybuffer';
    this.openP = new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.ws.on('message', (d, bin) => {
      if (!bin) {
        const s = String(d);
        if (!this.readyDone) { if (s === '{"kind":"zcode-webui-ready"}') { this.readyDone = true; this.readyResolve(); } return; }
        if (process.env.ZCODE_WEBUI_DEBUG_RPC === '1') console.error('[client ' + this.tab + '] ' + Date.now() + ' txt ' + s.slice(0, 60));
        this.texts.push(s);
        const m = /\[zcode-webui\] host (?:spawned|adopted) pid=(\d+)/.exec(s);
        if (m) this.hostPid = Number(m[1]);
      } else { this.binaries.push(Buffer.from(d)); if (process.env.ZCODE_WEBUI_DEBUG_RPC === '1') console.error('[client ' + this.tab + '] ' + Date.now() + ' bin ' + Buffer.from(d).length + 'B ' + Buffer.from(d).toString('hex').slice(0, 24)); }
    });
    this.ws.on('close', (c) => done(c));
    this.readyP = new Promise((r) => { this.readyResolve = r; });
  }
  async open() { await this.openP; await Promise.race([this.readyP, sleep(15000).then(() => { throw new Error('ready timeout ' + this.tab); })]); return this; }
  sendPortReady() { try { this.ws.send('{"kind":"zcode-webui-port-ready"}'); } catch (_e) { /* ignore */ } }
  async roundTrip(timeoutMs = 45000) {
    const n0 = this.binaries.length;
    this.ws.send(systemInfo());
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.binaries.slice(n0).some((x) => x.includes(Buffer.from('homedir')))) return true;
      await sleep(80);
    }
    throw new Error('no system.info reply on ' + this.tab);
  }
}

(async () => {
  await waitHealthy();
  console.log('sandbox healthy');
  const tok = await token();

  // ===== S0: empty pool -> instant-first-write works on a FRESH host =====
  {
    const fb = [];
    let fv = false;
    const fc = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${tok}&tab=dev-f`);
    fc.binaryType = 'arraybuffer';
    const readyOk = new Promise((r) => {
      fc.on('message', function h(dd, bin) {
        if (!bin && !fv && String(dd) === '{"kind":"zcode-webui-ready"}') { fv = true; r(); }
        else if (bin) fb.push(Buffer.from(dd));
      });
    });
    await new Promise((r) => fc.on('open', r));
    await readyOk;
    fc.send(systemInfo());                       // INSTANT first write after ready
    let replied = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && !replied) {
      if (fb.some((x) => x.includes(Buffer.from('homedir')))) replied = true;
      await sleep(80);
    }
    if (!replied) fail('S0: instant-first-write got no reply on a fresh host');
    console.log('PASS S0 instant-first-write answered on fresh spawn');
    fc.close(4000, 'bye');                       // explicit terminate keeps the pool empty
    await sleep(400);
  }

  // ===== S1: device switch adopts the running host =====
  const a = await new Page('dev-a', tok).open();
  await sleep(400);                                     // settle past handshake like a real renderer
  await a.roundTrip();                                  // drive traffic so the turn-ish state looks active
  a.ws.close(1000, 'device-a gone');                    // normal loss -> DETACH
  await sleep(600);
  const spawnedPid = a.hostPid;
  if (!spawnedPid) fail('could not learn spawned pid');

  const b = await new Page('dev-b', tok).open();
  const tAdopt = Date.now();
  while (!/adopted/.test(b.texts.join('\n')) && Date.now() - tAdopt < 8000) await sleep(60);
  if (!/host adopted/.test(b.texts.join('\n'))) fail('dev-b was not told about an adoption\n' + b.texts.join('|'));
  if (b.hostPid !== spawnedPid) fail(`adoption picked wrong host: got ${b.hostPid}, expected ${spawnedPid}`);
  // HOLD gate: before the renderer acknowledges its port, NOTHING may leak
  await sleep(1300);
  if (b.binaries.length !== 0) fail('hold gate leaked ' + b.binaries.length + ' frame(s) before port-ready');
  console.log('PASS S1c hold gate kept downstream quiet until ack');
  b.sendPortReady();
  // first bytes the adopting page EVER sees must be the replayed Initialize,
  // never an arbitrary mid-stream chunk
  for (let i = 0; i < 50 && b.binaries.length === 0; i++) await sleep(100);
  if (!b.binaries.length || b.binaries[0].toString('hex') !== INIT_HEX) {
    fail('first delivered frame is not the replayed Initialize: ' + (b.binaries[0] ? b.binaries[0].toString('hex') : 'none'));
  }
  await b.roundTrip();                                   // same pipe serves the new driver
  console.log('PASS S1 cross-device adoption: pid ' + spawnedPid + ', replayed Initialize first, live round-trip OK');

  const h1 = await (await fetch(origin + '/api/health')).json();
  if (h1.sessions.total !== 1 || h1.sessions.views !== 1) fail('expected 1 session with 1 view after adoption, got ' + JSON.stringify(h1.sessions));
  console.log('PASS S1b single-host invariant holds (sessions=' + JSON.stringify(h1.sessions) + ')');

  // ===== S2: refreshing dev-b keeps the SAME host too =====
  b.ws.close(1000, 'refresh');
  await sleep(500);
  const b2 = await new Page('dev-b', tok).open();
  for (let i = 0; i < 80 && !/host adopted/.test(b2.texts.join('\n')); i++) await sleep(60);
  if (b2.hostPid !== spawnedPid) fail('refresh did not reuse the host (' + b2.hostPid + ' vs ' + spawnedPid + ')');
  await sleep(1300);
  if (b2.binaries.length !== 0) fail('refresh: hold gate leaked before port-ready');
  b2.sendPortReady();
  for (let i = 0; i < 50 && b2.binaries.length === 0; i++) await sleep(100);
  if (!b2.binaries.length || b2.binaries[0].toString('hex') !== INIT_HEX) {
    fail('refresh: replay ordering broken; n=' + b2.binaries.length +
      ' first=' + (b2.binaries[0] ? b2.binaries[0].toString('hex') : 'none') +
      ' texts=' + b2.texts.join('|').slice(0, 300));
  }
  b2.sendPortReady();
  await b2.roundTrip();
  console.log('PASS S2 same-tab refresh also adopts (no fork, pid ' + spawnedPid + ')');

  // ===== S3: MULTI-VIEW — second device attaches while the first stays live =====
  const d = await new Page('dev-d', tok).open();
  for (let i = 0; i < 80 && !/host adopted/.test(d.texts.join('\n')); i++) await sleep(60);
  if (!d.hostPid || d.hostPid !== spawnedPid) fail(`dev-d expected same host pid ${spawnedPid}, got ${d.hostPid}`);
  await sleep(1300);
  d.sendPortReady();
  for (let i = 0; i < 50 && d.binaries.length === 0; i++) await sleep(100);
  if (!d.binaries.length || d.binaries[0].toString('hex') !== '040106c80100') fail('dev-d replay ordering broken');
  await d.roundTrip();
  // the first device must NOT be demoted anymore: both stay attached
  if (b2.closedCode !== null) fail('first device was demoted under multi-view (code ' + b2.closedCode + ')');
  await b2.roundTrip();
  const h2 = await (await fetch(origin + '/api/health')).json();
  if (h2.sessions.total !== 1 || h2.sessions.views !== 2) fail('expected 1 session with 2 views, got ' + JSON.stringify(h2.sessions));
  console.log('PASS S3 multi-view: two devices live on one pid; first not demoted');

  // ===== S3b: interleaved round-trips — responses route to the right view =====
  const rA = b2.roundTrip(20000);
  const rB = d.roundTrip(20000);
  const [okA, okB] = await Promise.all([rA.then(() => 1, () => 0), rB.then(() => 1, () => 0)]);
  if (okA + okB !== 2) fail('interleaved round-trips failed');
  const h3 = await (await fetch(origin + '/api/health')).json();
  if (h3.sessions.views !== 2) fail('views dropped after interleaved traffic');
  console.log('PASS S3b interleaved round-trips on both views');

  // ===== S3c: a view leaving must not disturb the other =====
  b2.ws.close(1000, 'bye');
  await sleep(400);
  await d.roundTrip();
  const h4 = await (await fetch(origin + '/api/health')).json();
  if (h4.sessions.views !== 1) fail('expected 1 view after b2 left, got ' + JSON.stringify(h4.sessions));
  console.log('PASS S3c view departure leaves the other view intact');

  console.log('CONTINUITY OK');
  cleanup();
  process.exit(process.exitCode || 0);
})().catch((e) => { fail(e && e.stack || e); });
