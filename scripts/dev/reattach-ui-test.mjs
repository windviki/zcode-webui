// Real-renderer test for session detachment/reattach:
// start a real turn, reload the page mid-turn, and verify that
// 1) the new page re-attaches to the SAME host ('host reattached' log),
// 2) the UI renders (no parked banner / no error banner),
// 3) the turn keeps running to completion and the reply is visible.
// Costs one tiny model call. Usage: node scripts/dev/reattach-ui-test.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';

// clean slate
await fetch(BASE + 'api/sessions/terminate', { method: 'POST' }).catch(() => {});

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => {
  const t = m.text();
  logs.push(t);
  if (t.indexOf('zcode-webui') >= 0 || t.indexOf('reattached') >= 0 || m.type() === 'error') console.log('[' + m.type() + '] ' + t.slice(0, 220));
});
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 300)));

const checks = [];
function check(name, ok, extra) {
  checks.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
}

try {
  console.log('>>> goto ' + BASE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(12000);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);

  const before = await page.evaluate(() => ({
    root: document.getElementById('root') ? document.getElementById('root').children.length : -1,
    ready: document.body.className.indexOf('zcode-startup-ready') >= 0,
  }));
  check('UI mounted before send', before.root > 0 && before.ready, JSON.stringify(before));

  const ed = page.locator('[data-testid="v4-composer-input"]').first();
  await ed.click();
  await page.keyboard.type('请只回复数字 43，不要做任何其他操作。', { delay: 12 });
  await page.waitForTimeout(800);
  const send = page.locator('[data-testid="v4-composer-send"], [data-testid="chat-send-button"]').first();
  let tries = 0;
  while ((await send.count()) === 0 && tries < 10) { await page.waitForTimeout(1000); tries++; }
  if (!(await send.count())) { check('send button present', false); throw new Error('no send button'); }
  let disabled = await send.isDisabled().catch(() => true);
  tries = 0;
  while (disabled && tries < 10) { await page.waitForTimeout(1000); tries++; if (!(await send.isDisabled().catch(() => true))) break; }
  await send.click();
  console.log('>>> sent, waiting for the turn to start...');
  await page.waitForTimeout(6000);

  // ---- reload mid-turn: the page must re-attach to the same host ----
  console.log('>>> reloading mid-turn');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  let reattached = false;
  for (let i = 0; i < 60 && !reattached; i++) {
    await page.waitForTimeout(1000);
    reattached = logs.some((t) => t.indexOf('host reattached') >= 0);
  }
  check('page re-attached to the same host', reattached);

  await page.waitForTimeout(5000);
  const afterReload = await page.evaluate(() => ({
    root: document.getElementById('root') ? document.getElementById('root').children.length : -1,
    ready: document.body.className.indexOf('zcode-startup-ready') >= 0,
    parked: (document.body.innerText || '').indexOf('已被另一个标签页接管') >= 0,
    banner: document.getElementById('zcode-webui-error') ? document.getElementById('zcode-webui-error').textContent.slice(0, 200) : null,
  }));
  check('UI rendered after reload', afterReload.root > 0 && afterReload.ready, JSON.stringify(afterReload).slice(0, 120));
  check('no parked notice after reload', !afterReload.parked);
  check('no error banner after reload', !afterReload.banner || afterReload.banner.indexOf('接管') >= 0, String(afterReload.banner).slice(0, 80));

  // ---- the turn must keep running and deliver its reply ----
  let replySeen = false;
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(5000);
    const text = await page.evaluate(() => document.body.innerText || '');
    console.log('T+' + ((i + 1) * 5) + 's textLen=' + text.length + ' tail=' + JSON.stringify(text.slice(-160)));
    if (/43/.test(text.slice(-400))) { replySeen = true; break; }
  }
  check('turn continued after reload and reply is visible', replySeen);
} catch (e) {
  console.log('FAIL  ' + (e && e.message ? e.message : e));
  checks.push({ name: 'exception', ok: false });
}

await fetch(BASE + 'api/sessions/terminate', { method: 'POST' }).catch(() => {});
try { await browser.close(); } catch (e) { /* ignore */ }
const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0 ? 'REATTACH-UI OK' : 'REATTACH-UI FAILED (' + failed + ')');
process.exit(failed === 0 ? 0 : 1);
