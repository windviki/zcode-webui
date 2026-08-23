// Reattach/adopt/supersede tests for the host session registry:
// 1. close ws normally -> host is DETACHED (kept alive), same tab re-attaches to it
// 2. a new tab of the same browser adopts a detached host
// 3. a second ws for the same tab supersedes the first (4001)
// 4. close code 4000 terminates the host
// Usage: node scripts/dev/reattach-test.mjs [baseURL]
import WebSocket from 'ws';

const BASE = (process.argv[2] || process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/').replace(/\/?$/, '/');

function vql(v) { const b = []; if (v === 0) b.push(0); else { let x = v; while (x !== 0) { b.push(x & 127); x = x >>> 7; } for (let i = 0; i < b.length - 1; i++) b[i] |= 128; } return Buffer.from(b); }
function ser(d) { const p = []; if (d === undefined) p.push(Buffer.from([0])); else if (typeof d === 'string') { const b = Buffer.from(d); p.push(Buffer.from([1]), vql(b.length), b); } else if (Array.isArray(d)) { p.push(Buffer.from([4]), vql(d.length)); for (const e of d) p.push(ser(e)); } else if (typeof d === 'number') { p.push(Buffer.from([6]), vql(d)); } else if (d && typeof d === 'object') { const b = Buffer.from(JSON.stringify(d)); p.push(Buffer.from([5]), vql(b.length), b); } return Buffer.concat(p); }
const REQ = Buffer.concat([ser([100, 1, 'system', 'info']), ser(undefined)]);
const INIT_HEX = '040106c80100';

const checks = [];
function check(name, ok, extra) {
  checks.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await sleep(120);
  }
  throw new Error('timeout waiting for ' + label);
}
async function health() {
  return await fetch(BASE + 'api/health').then((r) => r.json());
}

// start from a clean slate (terminate any hosts left over from earlier runs)
await fetch(BASE + 'api/sessions/terminate', { method: 'POST' }).catch(() => {});
await sleep(500);

const idx = await fetch(BASE).then((r) => r.text());
const m = /window\.__ZCODE_WEBUI_CONFIG__ = (\{.*?\});/.exec(idx);
if (!m) { console.error('no injected config in index'); process.exit(2); }
const TOKEN = JSON.parse(m[1]).wsToken;

function openWs(tab, client) {
  const url = BASE.replace(/^http/, 'ws') + 'ws?token=' + TOKEN + '&tab=' + tab;
  const opts = client ? { headers: { Cookie: 'zwebui_client=' + client } } : undefined;
  const ws = new WebSocket(url, opts);
  ws.binaryType = 'arraybuffer';
  ws.texts = [];
  ws.ready = false;
  ws.initSeen = false;
  ws.replies = 0;
  ws.closedCode = null;
  ws.pid = '';
  const p = new Promise((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (e) => reject(new Error('ws error: ' + e.message)));
  });
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const t = String(data);
      ws.texts.push(t);
      if (t === '{"kind":"zcode-webui-ready"}') ws.ready = true;
      const pm = /pid=(\d+)/.exec(t);
      if (pm && !ws.pid) ws.pid = pm[1];
      return;
    }
    const payload = Buffer.from(data);
    // a fresh host pushes its Initialize frame first; any other binary payload is a reply
    if (!ws.initSeen && payload.toString('hex') === INIT_HEX) { ws.initSeen = true; ws.send(REQ); return; }
    if (payload.length > 0) ws.replies++;
  });
  ws.on('close', (code) => { ws.closedCode = code; });
  ws.openPromise = p;
  return ws;
}

try {
  // ---- case 1: detach + reattach on the same tab ----
  let wsA = openWs('t1', 'client-a');
  await wsA.openPromise;
  await waitFor(() => wsA.initSeen && wsA.replies > 0, 25000, 'wsA init+reply');
  const pidA = wsA.pid;
  check('wsA spawned host (pid=' + pidA + ')', !!pidA);
  wsA.close(1000, 'tab closed');
  await waitFor(async () => (await health()).sessions.detached >= 1, 8000, 'detach reflected in health');
  const h1 = await health();
  check('wsA close -> host detached (kept alive)', h1.sessions.total >= 1 && h1.sessions.detached >= 1 && h1.sessions.attached === 0, JSON.stringify(h1.sessions));

  const wsB = openWs('t1', 'client-a');
  await wsB.openPromise;
  await waitFor(() => wsB.ready, 10000, 'wsB ready');
  const reattachLine = wsB.texts.find((t) => t.includes('reattached'));
  check('wsB re-attached to the same host', !!reattachLine && wsB.pid === pidA, 'line=' + String(reattachLine));
  wsB.send(REQ);
  await waitFor(() => wsB.replies > 0, 25000, 'wsB round-trip');
  check('wsB can drive the re-attached host (round-trip)', wsB.replies > 0);
  wsB.close(4000, 'terminate');
  await waitFor(async () => (await health()).sessions.total === 0, 8000, 'terminate reflected in health');
  check('code 4000 terminates the host', true);

  // ---- case 2: another tab of the same browser adopts a detached host ----
  const wsC = openWs('t2', 'client-b');
  await wsC.openPromise;
  await waitFor(() => wsC.initSeen && wsC.replies > 0, 25000, 'wsC init+reply');
  const pidC = wsC.pid;
  wsC.close(1000, 'tab closed');
  await sleep(800);
  const wsD = openWs('t3', 'client-b'); // different tab, same browser cookie
  await wsD.openPromise;
  await waitFor(() => wsD.pid, 10000, 'wsD attached');
  check('new tab adopted the detached host', wsD.pid === pidC, 'pidD=' + wsD.pid + ' pidC=' + pidC);
  wsD.send(REQ);
  await waitFor(() => wsD.replies > 0, 25000, 'wsD round-trip');
  check('adopted host still answers', wsD.replies > 0);
  wsD.close(4000, 'terminate');

  // ---- case 3: second ws for the same tab supersedes the first ----
  const wsE = openWs('t4', 'client-c');
  await wsE.openPromise;
  await waitFor(() => wsE.initSeen, 25000, 'wsE init');
  const wsF = openWs('t4', 'client-c');
  await wsF.openPromise;
  await waitFor(() => wsF.pid, 10000, 'wsF attached');
  await waitFor(() => wsE.closedCode !== null, 8000, 'wsE closed by supersede');
  check('wsE was superseded with 4001', wsE.closedCode === 4001, 'code=' + wsE.closedCode);
  check('wsF took over the same host', wsF.pid === wsE.pid, 'pidF=' + wsF.pid + ' pidE=' + wsE.pid);
  wsF.close(4000, 'terminate');
  await waitFor(async () => (await health()).sessions.total === 0, 8000, 'cleanup');

  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed === 0 ? 'REATTACH OK' : 'REATTACH FAILED (' + failed + ')');
  process.exit(failed === 0 ? 0 : 1);
} catch (e) {
  console.log('FAIL  ' + (e && e.message ? e.message : e));
  process.exit(1);
}
