// Collect zcode-webui SHIM performance telemetry from a real browser.
//
// Why the shim: "zcode-webui 最近很卡" cannot be answered from either side alone.
// The server knows frame counts but not the browser's main thread; the official
// renderer has its own memory log but nothing about the transport that feeds it.
// web/bootstrap.js now samples both (see the perf block there) and exposes:
//
//   window.__zwebui_perf()            -> snapshot object
//   window.__zwebui_perf_sample(ms)   -> Promise<fps stats> (rAF window)
//   window.__zwebui_perf_reset()      -> zero the counters
//
// It also posts one compact `kind=perf` line to the server log every 30 s, so
// `grep '| perf |' zcode-webui.log` is the timeline for the user's own device.
//
// Usage:
//   node scripts/dev/perf-collect.mjs                        # 60 s, ws transport
//   node scripts/dev/perf-collect.mjs 90                     # 90 s
//   node scripts/dev/perf-collect.mjs 60 --transport=http    # force the relay
//   node scripts/dev/perf-collect.mjs 30 --legacy-bootstrap=/tmp/bootstrap-old.js
//        Serve that bootstrap build instead of the deployed one (A/B a fix
//        without touching the live web/ directory).
//   node scripts/dev/perf-collect.mjs 60 --base=http://127.0.0.1:3102/
//
// The run is READ-ONLY: it loads the UI, never sends a prompt, never clicks a
// conversation. It does attach one extra VIEW to the running host (that is what
// opening the app does) and detaches on close.
//
// Port 3102 is the live deployment; the repo convention for hitting production
// is an explicit opt-in: ZOOM_TEST_ALLOW_PROD=1.
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else positional.push(a);
}
// positional args: [seconds] [base] — a bare number is the duration
const posNum = positional.filter((a) => /^\d+$/.test(a));
const posUrl = positional.filter((a) => !/^\d+$/.test(a));
const BASE = flags.base || posUrl[0] || 'http://127.0.0.1:3102/';
const SECONDS = Math.max(10, Number(flags.seconds || posNum[0] || 60));
const TRANSPORT = flags.transport || '';
const LEGACY = flags['legacy-bootstrap'] || '';
const SAMPLE_MS = Math.max(3000, Number(flags.sample || 8000));
// --open-task=<n|id-prefix> clicks one conversation in the sidebar first, so the
// numbers describe a real conversation frame instead of the empty landing view.
// Read-only: it opens the conversation, it never sends anything.
const OPEN_TASK = flags['open-task'] || '';
// --scroll[=ms] wheels up and down the transcript for ms (default 10 s) while a
// rAF window runs: long un-virtualized conversations show up here as jank even
// when the app is perfectly smooth while idle.
const SCROLL_MS = flags.scroll === undefined ? 0 : Math.max(2000, Number(flags.scroll) || 10000);
const OUT = flags.json || ('/tmp/zwebui-perf-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');

if (/:(3102|3001)\b/.test(BASE) && !process.env.ZOOM_TEST_ALLOW_PROD) {
  console.error('refusing to hit the live deployment without ZOOM_TEST_ALLOW_PROD=1 (base=' + BASE + ')');
  process.exit(2);
}

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const errors = [];
const shimWarns = [];
page.on('pageerror', (e) => errors.push({ type: 'pageerror', text: String(e.message).slice(0, 300) }));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errors.push({ type: 'console.error', text: t.slice(0, 300) });
  if (t.includes('[zcode-webui]')) shimWarns.push({ at: Date.now(), text: t.slice(0, 240) });
});

if (LEGACY) {
  // A/B: serve a different bootstrap build without touching web/
  const { readFileSync } = await import('node:fs');
  const body = readFileSync(LEGACY, 'utf8');
  await context.route('**/bootstrap.js*', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body }));
  console.log('[perf] serving legacy bootstrap from ' + LEGACY + ' (' + body.length + 'B)');
}

const url = BASE + (TRANSPORT ? (BASE.includes('?') ? '&' : '?') + 'transport=' + TRANSPORT : '');
console.log('[perf] loading ' + url + ' for ' + SECONDS + 's');
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

// wait for the shim's perf hooks + a mounted app
let ready = false;
for (let i = 0; i < 60; i++) {
  ready = await page.evaluate(() => {
    const root = document.getElementById('root');
    return !!(root && root.children.length > 0);
  }).catch(() => false);
  if (ready) break;
  await page.waitForTimeout(1000);
}
// the legacy build under A/B has no perf hooks: report it instead of stalling
const hasPerf = await page.evaluate(() => typeof window.__zwebui_perf === 'function').catch(() => false);
if (!hasPerf) console.log('[perf] this bootstrap build has no perf hooks (window.__zwebui_perf missing)');
const bootSec = Math.round((Date.now() - t0) / 1000);
console.log('[perf] app mounted=' + ready + ' after ' + bootSec + 's');
if (!ready) {
  const body = await page.evaluate(() => (document.body && document.body.innerText || '').slice(0, 400)).catch(() => '');
  console.log('[perf] body: ' + body.replace(/\s+/g, ' '));
}

if (OPEN_TASK) {
  const wanted = String(OPEN_TASK);
  const sel = /^\d+$/.test(wanted)
    ? '[data-testid^="task-item-"]'
    : '[data-testid*="task-item-' + wanted.replace(/"/g, '') + '"]';
  const loc = page.locator(sel).nth(/^\d+$/.test(wanted) ? Number(wanted) : 0);
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await loc.click({ timeout: 8000 });
    console.log('[perf] opened conversation via ' + sel + ' #' + (/^\d+$/.test(wanted) ? wanted : 'first match'));
    await page.waitForTimeout(5000);        // let the history render + settle
  } catch (e) {
    console.log('[perf] could not open a conversation: ' + String(e.message).slice(0, 160));
  }
}

if (hasPerf) await page.evaluate(() => { try { window.__zwebui_perf_reset(); } catch (e) { /* ignore */ } });

// progress line every 10 s so a long run reports something
const timeline = [];
const deadline = Date.now() + SECONDS * 1000;
while (Date.now() < deadline) {
  await page.waitForTimeout(Math.min(10000, Math.max(1000, deadline - Date.now())));
  if (!hasPerf) continue;
  const snap = await page.evaluate(() => (window.__zwebui_perf ? window.__zwebui_perf() : null)).catch(() => null);
  if (!snap) continue;
  timeline.push({ t: Math.round((Date.now() - t0) / 1000), snap });
  console.log('[perf] t=' + timeline[timeline.length - 1].t + 's ' + short(snap));
}

// final: one dedicated fps window (the periodic one is only 6 s every 30 s)
let fps = null;
if (hasPerf) {
  try { fps = await page.evaluate((ms) => window.__zwebui_perf_sample(ms), SAMPLE_MS); } catch (e) { fps = { error: String(e.message) }; }
}
const snap = hasPerf ? await page.evaluate(() => (window.__zwebui_perf ? window.__zwebui_perf() : null)).catch(() => null) : null;
if (snap && fps && !fps.error) snap.fpsMeasured = fps;

// ---- optional scroll-jank phase ----
let scrollResult = null;
if (SCROLL_MS && snap) {
  const fpsP = page.evaluate((ms) => window.__zwebui_perf_sample(ms), SCROLL_MS);
  const box = await page.evaluate(() => {
    const cands = [...document.querySelectorAll('div')].filter((el) => el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 300);
    cands.sort((a, b) => b.scrollHeight - a.scrollHeight);
    const el = cands[0];
    if (!el) return null;
    el.setAttribute('data-zwebui-scroll-probe', '1');
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, nodes: el.getElementsByTagName('*').length };
  });
  if (box) {
    await page.evaluate(() => { try { window.__zwebui_perf_reset(); } catch (e) { /* ignore */ } });
    await page.mouse.move(box.x, box.y);
    const until = Date.now() + SCROLL_MS - 1000;
    let dir = 1;
    while (Date.now() < until) {
      await page.mouse.wheel(0, dir * 700);
      await page.waitForTimeout(60);
      const pos = await page.evaluate(() => {
        const el = document.querySelector('[data-zwebui-scroll-probe]');
        return el ? { top: el.scrollTop, max: el.scrollHeight - el.clientHeight } : null;
      });
      if (pos && pos.top >= pos.max - 5) dir = -1;
      if (pos && pos.top <= 5) dir = 1;
    }
  } else {
    console.log('[perf] scroll: no scrollable transcript found');
  }
  const fpsS = await fpsP;
  const snap2 = await page.evaluate(() => window.__zwebui_perf());
  scrollResult = { box, fps: fpsS, snap: snap2 };
  console.log('[perf] scroll ' + (box ? (box.scrollHeight + 'px/' + box.nodes + ' nodes') : 'n/a') +
    ' fps p50=' + (fpsS && fpsS.p50) + ' p95=' + (fpsS && fpsS.p95) + ' max=' + (fpsS && fpsS.max) +
    ' jank>50=' + (fpsS && fpsS.jank50) + ' longTasks=' + snap2.totals.longTasks + '/' + snap2.totals.longTotalMs + 'ms');
}

const out = { at: new Date().toISOString(), scroll: scrollResult, base: BASE, transport: TRANSPORT || 'ws', seconds: SECONDS, legacyBootstrap: LEGACY || null, bootSec, ready, final: snap, timeline: timeline.map((x) => ({ t: x.t, snap: x.snap })), errors, shimWarns: shimWarns.slice(-40) };
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('\n[perf] wrote ' + OUT);

console.log('\n=== summary ===');
if (snap) {
  const tr = snap.totals || {};
  const fpsS = snap.fpsMeasured || snap.fps;
  console.log('transport        : ' + snap.transport + ' (ws opens=' + snap.ws.opens + ', fallbacks=' + snap.ws.fallbacks + ', reconnects=' + snap.ws.reconnects + ', pre-ready frames=' + snap.ws.preReadyFrames + ')');
  console.log('traffic totals   : in ' + tr.inFrames + 'f/' + mb(tr.inBytes) + ', out ' + tr.outFrames + 'f/' + mb(tr.outBytes));
  console.log('rate             : ' + (tr.inFrames / SECONDS).toFixed(1) + ' frames/s in, ' + (tr.inBytes / 1024 / SECONDS).toFixed(1) + ' kB/s in');
  console.log('biggest frame    : ' + mb(snap.frames.maxBytes) + ' ' + (snap.frames.maxHex || ''));
  console.log('top frames       : ' + (snap.frames.top || []).map((f) => mb(f.bytes)).join(', '));
  console.log('poll             : count=' + snap.poll.count + ' rtt p50/p95/max=' + snap.poll.p50 + '/' + snap.poll.p95 + '/' + snap.poll.maxMs + 'ms failed=' + snap.poll.failed + ' batchMax=' + snap.batches.maxFrames + 'f/' + mb(snap.batches.maxBytes));
  console.log('long tasks       : ' + tr.longTasks + ' total, ' + tr.longTotalMs + 'ms, max ' + tr.longMaxMs + 'ms');
  for (const lt of (snap.longTasks.top || []).slice(0, 5)) console.log('   ' + lt.ms + 'ms  ' + lt.name + ' ' + lt.src);
  if (fpsS) console.log('fps (rAF window) : p50=' + fpsS.p50 + 'ms p95=' + fpsS.p95 + 'ms max=' + fpsS.max + 'ms jank>50ms=' + fpsS.jank50 + ' >100ms=' + fpsS.jank100 + ' frames=' + fpsS.frames);
  if (snap.heap) console.log('js heap          : ' + snap.heap.usedMb + 'MB / ' + snap.heap.limitMb + 'MB');
  console.log('dom nodes        : ' + snap.domNodes);
  console.log('frame types      : ' + JSON.stringify(snap.traffic.types));
  if (scrollResult && scrollResult.fps) {
    const f = scrollResult.fps, t = scrollResult.snap.totals;
    console.log('scroll jank      : p50=' + f.p50 + 'ms p95=' + f.p95 + 'ms max=' + f.max + 'ms; frames >50ms=' + f.jank50 + ' >100ms=' + f.jank100 + ' >250ms=' + f.jank250 + '; long tasks ' + t.longTasks + '/' + t.longTotalMs + 'ms max' + t.longMaxMs);
  }
}
console.log('errors           : ' + errors.length);
for (const e of errors.slice(0, 8)) console.log('   [' + e.type + '] ' + e.text);
if (shimWarns.length) {
  console.log('shim notices     :');
  for (const w of shimWarns.slice(-8)) console.log('   ' + w.text);
}
const crash = errors.some((e) => /Cannot read properties of undefined \(reading '0'\)/.test(e.text));
console.log('\n[perf] RPC-client crash seen: ' + (crash ? 'YES (subagentsStore onBuffer)' : 'no'));

await browser.close();
process.exit(crash ? 1 : 0);

function mb(n) {
  if (!n) return '0B';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'kB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}
function short(s) {
  const tr = s.totals || {};
  return 'in=' + tr.inFrames + 'f/' + mb(tr.inBytes) + ' out=' + tr.outFrames + 'f lt=' + tr.longTasks + '/' + tr.longTotalMs + 'ms max' + tr.longMaxMs +
    (s.heap ? ' heap=' + s.heap.usedMb + 'MB' : '') + ' dom=' + s.domNodes + ' mode=' + s.transport;
}
