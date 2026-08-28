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
    env: { ...process.env, ZCODE_WEBUI_HOME: path.join(sandbox, 'data'), ZCODE_HOME: path.join(sandbox, 'zcode'), HOME: path.join(sandbox, 'home') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
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
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));

const checks = [];
const check = (n, ok, extra) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  (' + extra + ')' : '')); };

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(12000);                       // renderer boot
  await page.keyboard.press('Escape').catch(() => {});

  await page.evaluate(() => { window.__zwebui_marker = 'LIVE'; });

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
} catch (e) {
  console.log('FAIL  ' + (e && e.message ? e.message : e));
  checks.push(false);
}

await browser.close();
const failed = checks.filter((c) => !c).length;
console.log(failed === 0 ? 'HOT-RECONNECT OK' : 'HOT-RECONNECT FAILED (' + failed + ')');
process.exit(failed ? 1 : 0);
