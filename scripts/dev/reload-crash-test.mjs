// Regression test for the reload/reattach crash: the official renderer registers
// window-controller events on a protocol pipe that is single-client; sharing the
// pipe with a second renderer made stale error replies crash it
// ("Cannot read properties of undefined (reading 'kind')"). Now every page load
// gets a FRESH host, so a reload must stay clean.
// Usage: node scripts/dev/reload-crash-test.mjs [baseURL]
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/').replace(/\/?$/, '/');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror] ' + e.message.slice(0, 200)); });
page.on('console', (m) => { if (m.type() === 'error' && /reading 'kind'|Uncaught/.test(m.text())) { errors.push(m.text()); console.log('[console.error] ' + m.text().slice(0, 200)); } });

const checks = [];
const check = (n, ok, extra) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  (' + extra + ')' : '')); };

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(10000);
  await page.keyboard.press('Escape').catch(() => {});
  const first = await page.evaluate(() => ({
    root: document.getElementById('root') ? document.getElementById('root').children.length : -1,
    ready: document.body.className.includes('zcode-startup-ready'),
  }));
  check('first load renders', first.root > 0 && first.ready, JSON.stringify(first));

  // the repro: idle a while, then reload — the old renderer's channel state must
  // never leak into the new page (fresh host per load)
  await page.waitForTimeout(8000);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(12000);
  const second = await page.evaluate(() => ({
    root: document.getElementById('root') ? document.getElementById('root').children.length : -1,
    ready: document.body.className.includes('zcode-startup-ready'),
    banner: document.getElementById('zcode-webui-error') ? document.getElementById('zcode-webui-error').textContent.slice(0, 200) : null,
    parked: (document.body.innerText || '').includes('已被另一个标签页接管'),
  }));
  check('reload renders without parking', second.root > 0 && second.ready && !second.parked, JSON.stringify(second).slice(0, 140));
  const kindErrors = errors.filter((e) => /reading 'kind'/.test(e));
  check('no "reading kind" crash after reload', kindErrors.length === 0, kindErrors[0] || 'clean');
} catch (e) {
  console.log('FAIL  ' + (e && e.message ? e.message : e));
  checks.push(false);
}

await browser.close();
const failed = checks.filter((c) => !c).length;
console.log(failed === 0 ? 'RELOAD-CRASH OK' : 'RELOAD-CRASH FAILED (' + failed + ')');
process.exit(failed ? 1 : 0);
