// Hot-reconnect regression (the "switch away to another app" scenario):
//   the page must NOT reload when the network drops in the background; the
//   websocket hot-reconnects, the server re-adopts the SAME running host, and
//   frames generated while offline are replayed on resume.
// Usage: node scripts/dev/hot-reconnect-test.mjs [baseURL]
// Without a baseURL it spawns its own sandboxed server (isolated HOME /
// ZCODE_HOME / data-home, private port, synthetic credentials).
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

var BASE = null, sandbox = null, server = null;

if (process.argv[2] || process.env.ZCODE_WEBUI_TEST_URL) {
  BASE = (process.argv[2] || process.env.ZCODE_WEBUI_TEST_URL).replace(/\/?$/, '/');
} else {
  sandbox = mkdtempSync('/tmp/zwebui-hotrec.XXXXXX');
  for (const d of ['home', 'zcode/v2', 'data/vendor']) mkdirSync(path.join(sandbox, d), { recursive: true });
  cpSync(path.join(os.homedir(), '.zcode/server'), path.join(sandbox, 'zcode/server'), { recursive: true });
  cpSync(path.join(ROOT, 'vendor/renderer'), path.join(sandbox, 'data/vendor/renderer'), { recursive: true });
  writeFileSync(path.join(sandbox, 'zcode/v2/credentials.json'),
    JSON.stringify({ 'oauth:bigmodel:access_token': 't', 'oauth:bigmodel:user_info': '{"id":"hotrec"}' }));
  const port = 3196 + Math.floor(Math.random() * 300);
  server = spawn(process.execPath, [path.join(ROOT, 'src/server.mjs'), '--port', String(port)], {
    env: {
      ...process.env,
      ZCODE_WEBUI_HOME: path.join(sandbox, 'data'),
      ZCODE_HOME: path.join(sandbox, 'zcode'),
      HOME: path.join(sandbox, 'home'),
      // Short reaper timings: if the presence lease does not keep the detached
      // host/era alive, this test's 2 s socket drop would reap it and force a
      // page reload — exactly the regression this configuration exposes.
      ZCODE_WEBUI_DETACHED_TTL_MS: '1200',
      ZCODE_WEBUI_REAP_INTERVAL_MS: '250',
      ZCODE_WEBUI_FRAME_QUIET_MS: '150',
      ZCODE_WEBUI_RESUME_PARK_MS: '1200',
      ZCODE_WEBUI_PRESENCE_LEASE_MS: '30000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.logLines = [];
  server.stderr.on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) server.logLines.push(l); });
  BASE = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(BASE + 'api/health'); if (r.ok) break; } catch (_e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function cleanup() {
  try { if (server && server.exitCode === null) server.kill('SIGKILL'); } catch (_e) { /* ignore */ }
  try { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
if (/:(3102)\//.test(BASE) && process.env.ZOOM_TEST_ALLOW_PROD !== '1') {
  console.log('FAIL  refusing to run against :' + 3102 + ' (production?) — set ZOOM_TEST_ALLOW_PROD=1 to override');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200) + '\n[pageerror:stack] ' + String(e.stack || '').split('\n').slice(0, 4).join(' | ')));

const checks = [];
const check = (n, ok, extra) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  (' + extra + ')' : '')); };

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(12000);                       // renderer boot
  await page.keyboard.press('Escape').catch(() => {});

  await page.evaluate(() => { window.__zwebui_marker = 'LIVE'; });

  // presence lease: the open page must have registered a lease server-side even
  // before any socket trouble (it is renewed over plain HTTP, independent of WS)
  const healthBoot = await (await fetch(BASE + 'api/health')).json();
  check('presence lease registered for the open page', healthBoot.sessions.presence >= 1,
    JSON.stringify(healthBoot.sessions));

  // the offline-gap / reconnect notice must be dismissible WITHOUT triggering
  // its action (the old banner only offered "重新同步", i.e. a reload)
  await page.evaluate(() => {
    window.__noticeAction = false;
    window.__zwebui_notice('连接已恢复，但离线期间的部分事件未能送达。界面无异常时可关闭此提示继续使用；若显示异常，请重新同步。',
      '重新同步', function () { window.__noticeAction = true; }, true);
  });
  await page.waitForTimeout(150);
  const notice = await page.evaluate(() => {
    const el = document.getElementById('zcode-webui-error');
    return el ? { text: el.textContent, buttons: Array.from(el.querySelectorAll('button')).map((b) => b.textContent) } : null;
  });
  check('gap notice offers 重新同步 + 关闭', !!notice && notice.buttons.indexOf('重新同步') >= 0 && notice.buttons.indexOf('关闭') >= 0,
    JSON.stringify(notice && notice.buttons));
  await page.locator('#zcode-webui-error button', { hasText: '关闭' }).click();
  await page.waitForTimeout(150);
  const afterClose = await page.evaluate(() => ({
    banner: !!document.getElementById('zcode-webui-error'),
    action: !!window.__noticeAction,
    marker: window.__zwebui_marker,
  }));
  check('close button dismisses the notice without reloading or firing the action',
    !afterClose.banner && !afterClose.action && afterClose.marker === 'LIVE', JSON.stringify(afterClose));

  // simulate the background drop (Android suspends the tab's network): close
  // the socket without a reload — the client must schedule a HOT reconnect
  await page.evaluate(() => window.__zwebui_wsDrop());
  await page.waitForTimeout(600);                         // close settles, client backs off
  const offlineDead = await page.evaluate(() => {
    const s = window.__zwebui_ws && window.__zwebui_ws();
    return !s || s > 1 || s === 0;
  });
  check('drop: socket closed (not yet reconnected)', offlineDead);

  // "network returns": the client's backoff timer hot-reconnects — NO reload
  await page.waitForTimeout(1400);
  await page.waitForFunction(() => {
    const s = window.__zwebui_ws && window.__zwebui_ws();
    return s === 1;
  }, null, { timeout: 20000 });
  check('online: hot reconnect re-opened the socket', true);

  const marker = await page.evaluate(() => window.__zwebui_marker);
  check('NO page reload happened (marker intact)', marker === 'LIVE', 'marker=' + marker);

  // the resumed session must be attached and the official UI still mounted
  const health = await (await fetch(BASE + 'api/health')).json();
  const mounted = await page.evaluate(() => !!document.querySelector('#root') && document.querySelector('#root').children.length > 0);
  check('session re-attached on the server', health.sessions.views >= 1, JSON.stringify(health.sessions));
  check('official UI still mounted (no reboot needed)', mounted);

  // second drop+resume round for stability
  await page.evaluate(() => window.__zwebui_wsDrop());
  await page.waitForTimeout(600);
  await page.waitForFunction(() => {
    const s = window.__zwebui_ws && window.__zwebui_ws();
    return s === 1;
  }, null, { timeout: 20000 });
  const marker2 = await page.evaluate(() => window.__zwebui_marker);
  check('second drop: still no reload', marker2 === 'LIVE');

  // ---- uplink replay: a frame the renderer sends while the socket is down must
  // reach the server after the hot reconnect (it used to vanish silently, so any
  // service call made during the gap never settled)
  await page.evaluate(() => window.__zwebui_wsDrop());
  await page.waitForTimeout(300);                       // socket fully closed
  await page.evaluate(() => window.__zwebui_send(new Uint8Array([0xaa, 0x42])));
  await page.waitForFunction(() => {
    const s = window.__zwebui_ws && window.__zwebui_ws();
    return s === 1;
  }, null, { timeout: 20000 });
  await page.waitForTimeout(400);                       // flush lands server-side
  const junkSeen = server.logLines.some((l) => l.includes('dropped non-protocol inbound payload 2B first=170'));
  check('uplink: frame sent while offline reached the server after reconnect', junkSeen);
  if (!junkSeen) {
    console.log('DBG ws state:', await page.evaluate(() => window.__zwebui_ws && window.__zwebui_ws()));
    console.log('DBG log tail:', JSON.stringify(server.logLines.slice(-15)));
  }

  // ---- transport stickiness: after the page has booted, transient ws open
  // failures must NOT flip the page onto the http polling bridge (a brand-new
  // host with no era continuity). Two fake failures, then the real socket.
  await page.evaluate(() => {
    window.__zwebui_wsDrop();
    const RealWS = window.WebSocket;
    let fails = 0;
    window.WebSocket = function (url) {
      if (fails++ < 2) {
        const f = { readyState: 0, binaryType: '', onopen: null, onclose: null, onerror: null, onmessage: null, send() {}, close() {} };
        setTimeout(() => { f.readyState = 3; try { if (f.onerror) f.onerror({}); } catch (e) {} try { if (f.onclose) f.onclose({ code: 1006 }); } catch (e) {} }, 50);
        return f;
      }
      window.WebSocket = RealWS;
      return new RealWS(url);
    };
  });
  await page.waitForFunction(() => {
    const s = window.__zwebui_ws && window.__zwebui_ws();
    return s === 1;
  }, null, { timeout: 25000 });
  const marker3 = await page.evaluate(() => window.__zwebui_marker);
  const httpFlipped = server.logLines.some((l) => l.includes('[bridge] http session opened'));
  check('failed ws opens: no http flip, no reload, recovered', marker3 === 'LIVE' && !httpFlipped,
    marker3 === 'LIVE' && !httpFlipped ? '' : 'marker=' + marker3 + ' flipped=' + httpFlipped);
  if (!(marker3 === 'LIVE' && !httpFlipped)) {
    console.log('DBG flip ws state:', await page.evaluate(() => window.__zwebui_ws && window.__zwebui_ws()));
    console.log('DBG flip log tail:', JSON.stringify(server.logLines.slice(-10)));
  }

  // ---- error banner must never block clicks (it floats over the sidebar's
  // bottom-left) and must self-remove after a while
  let bannerProbe = await page.evaluate(() => {
    console.error('banner-probe-zwebui');
    var el = document.getElementById('zcode-webui-error');
    return el ? 'shown' : 'none';
  });
  if (bannerProbe === 'none') {
    await page.waitForTimeout(300);
    bannerProbe = await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent('error', { message: 'banner-probe-zwebui-2' }));
      var el = document.getElementById('zcode-webui-error');
      return el ? 'shown' : 'none';
    });
  }
  if (bannerProbe === 'shown') {
    const pe = await page.evaluate(() => getComputedStyle(document.getElementById('zcode-webui-error')).pointerEvents);
    check('banner: never takes pointer events', pe === 'none', 'pointer-events=' + pe);
    const through = await page.evaluate(() => {
      const el = document.getElementById('zcode-webui-error');
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20));
      return hit === el ? 'banner' : hit ? (hit.id || hit.tagName) : 'nothing';
    });
    check('banner: clicks pass through to the app underneath', through !== 'banner', 'hit=' + through);
    const gone = await page.waitForFunction(() => !document.getElementById('zcode-webui-error'), null, { timeout: 25000 }).then(() => true, () => false);
    check('banner: self-removed after ~20s', gone);
  } else {
    console.log('SKIP  banner checks (report budget exhausted before the probe)');
  }
} catch (e) {
  console.log('FAIL  ' + (e && e.message ? e.message : e));
  checks.push(false);
}

await browser.close();
const failed = checks.filter((c) => !c).length;
console.log(failed === 0 ? 'HOT-RECONNECT OK' : 'HOT-RECONNECT FAILED (' + failed + ')');
process.exit(failed ? 1 : 0);
