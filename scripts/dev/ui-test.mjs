// Drive the real official renderer in headless Chromium against the local server,
// capture all console output, page errors and final DOM state.
import { chromium } from 'playwright-core';

const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
const OUT = new URL('.', import.meta.url).pathname;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => {
  const line = '[' + m.type() + '] ' + m.text().slice(0, 400);
  logs.push(line);
  console.log(line);
});
page.on('pageerror', (e) => {
  const line = '[pageerror] ' + String(e.message || e).slice(0, 400);
  logs.push(line);
  console.log(line);
});
page.on('requestfailed', (r) => {
  console.log('[requestfailed] ' + r.url().slice(0, 140) + ' ' + (r.failure() && r.failure().errorText));
});

console.log('>>> goto ' + BASE);
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('goto error: ' + e.message));

for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(4000);
  const state = await page.evaluate(() => ({
    t: Date.now(),
    bodyClass: document.body.className,
    rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
    rootHtmlLen: document.getElementById('root') ? document.getElementById('root').innerHTML.length : -1,
    rootHtmlHead: document.getElementById('root') ? document.getElementById('root').innerHTML.slice(0, 400) : '',
    hasZcode: typeof window.zcode,
    zcodeKeys: window.zcode ? Object.keys(window.zcode).length : 0,
    banner: document.getElementById('zcode-webui-error') ? document.getElementById('zcode-webui-error').textContent.slice(0, 300) : null,
    wsOpen: window.__zb_ws_state || null,
  }));
  console.log('>>> state@' + i + ' ' + JSON.stringify(state, null, 1).replace(/\n/g, ' '));
  if (state.rootChildren > 0 && state.bodyClass.includes('zcode-startup-ready')) break;
}

await page.screenshot({ path: OUT + '/shot-main.png' });
console.log('>>> screenshot ' + OUT + '/shot-main.png');

// ---- login page ----
const page2 = await ctx.newPage();
page2.on('console', (m) => console.log('[login console] ' + m.type() + ' ' + m.text().slice(0, 300)));
page2.on('pageerror', (e) => console.log('[login pageerror] ' + e.message));
await page2.goto(BASE + 'login', { waitUntil: 'domcontentloaded' });
await page2.click('#btn');
for (let i = 0; i < 5; i++) {
  await page2.waitForTimeout(4000);
  const st = await page2.evaluate(() => ({ state: document.getElementById('state').textContent.slice(0, 600), url: document.getElementById('url').href }));
  console.log('>>> login@' + i + ' ' + JSON.stringify(st).slice(0, 700));
  if (st.url && st.url !== location.href) break;
}
await page2.screenshot({ path: OUT + '/shot-login.png' });

await browser.close();
console.log('done');
