// Session lifecycle regression: ONE host per renderer for the host's whole life.
// All assertions are DELTA-based so the test coexists with real user tabs.
// 1. closing a ws detaches the host (kept alive)
// 2. reloading the same tab spawns a FRESH host (new pid, fresh Initialize) and
//    keeps the recently active old host in the background (no pipe sharing)
// 3. a second live tab gets its own fresh host
// 4. a second ws for the same tab parks the first (4001) and gets a fresh host
// 5. close code 4000 terminates the host
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
    const v = await fn();
    if (v) return v;
    await sleep(120);
  }
  throw new Error('timeout waiting for ' + label);
}
async function health() {
  return await fetch(BASE + 'api/health').then((r) => r.json());
}

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
  // ---- case 1: close -> detached (kept alive) ----
  const beforeA = (await health()).sessions;
  const wsA = openWs('t1', 'client-a');
  await wsA.openPromise;
  await waitFor(() => wsA.initSeen && wsA.replies > 0, 25000, 'wsA init+reply');
  const pidA = wsA.pid;
  check('wsA fresh host (pid=' + pidA + ')', !!pidA);
  wsA.close(1000, 'tab closed');
  await waitFor(async () => (await health()).sessions.detached >= beforeA.detached + 1, 8000, 'detach reflected in health');
  const h1 = await health();
  check('wsA close -> host detached (kept alive)', h1.sessions.detached >= beforeA.detached + 1, JSON.stringify(h1.sessions));

  // ---- case 2: reloading the tab spawns a FRESH host; the recently active old
  // host is kept in the background instead of being shared with the new renderer ----
  const beforeB = (await health()).sessions;
  const wsB = openWs('t1', 'client-a');
  await wsB.openPromise;
  await waitFor(() => wsB.ready && wsB.initSeen, 25000, 'wsB fresh host ready');
  check('wsB got a FRESH host (new pid)', !!wsB.pid && wsB.pid !== pidA, 'pidB=' + wsB.pid + ' pidA=' + pidA);
  await waitFor(async () => (await health()).sessions.total >= beforeB.total + 1, 8000, 'old host kept, new host added');
  const h2 = await health();
  check('old host kept in background (no pipe sharing)', h2.sessions.total >= beforeB.total + 1 && h2.sessions.detached >= 1, JSON.stringify(h2.sessions));
  check('wsB round-trip on fresh host', wsB.replies > 0);

  // ---- case 3: a second live tab is independent ----
  const beforeC = (await health()).sessions;
  const wsC = openWs('t2', 'client-a');
  await wsC.openPromise;
  await waitFor(() => wsC.ready && wsC.initSeen, 25000, 'wsC fresh host ready');
  await waitFor(async () => (await health()).sessions.attached >= beforeC.attached + 1, 8000, 'wsC host attached');
  check('second live tab gets its own fresh host', wsC.pid && wsC.pid !== wsB.pid && wsC.replies > 0, 'pidC=' + wsC.pid);
  wsC.close(4000, 'terminate');

  // ---- case 4: second ws for the same tab parks the first (4001) ----
  const wsD = openWs('t4', 'client-c');
  await wsD.openPromise;
  await waitFor(() => wsD.initSeen, 25000, 'wsD init');
  const wsE = openWs('t4', 'client-c');
  await wsE.openPromise;
  await waitFor(() => wsE.initSeen && wsD.closedCode !== null, 25000, 'wsD parked, wsE fresh');
  check('wsD was parked with 4001', wsD.closedCode === 4001, 'code=' + wsD.closedCode);
  check('wsE got a fresh host (no pipe sharing)', wsE.pid && wsE.pid !== wsD.pid, 'pidE=' + wsE.pid + ' pidD=' + wsD.pid);
  wsE.close(4000, 'terminate');

  // ---- case 5: code 4000 terminates ----
  const beforeF = (await health()).sessions;
  const wsF = openWs('t5', 'client-c');
  await wsF.openPromise;
  await waitFor(() => wsF.initSeen, 25000, 'wsF init');
  wsF.close(4000, 'terminate');
  await waitFor(async () => (await health()).sessions.total <= beforeF.total, 8000, 'host terminated');
  check('code 4000 terminates the host', true);

  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed === 0 ? 'REATTACH OK' : 'REATTACH FAILED (' + failed + ')');
  process.exit(failed === 0 ? 0 : 1);
} catch (e) {
  console.log('FAIL  ' + (e && e.message ? e.message : e));
  process.exit(1);
}
