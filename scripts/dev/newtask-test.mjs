import { chromium } from 'playwright-core';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
const OUT = new URL('.', import.meta.url).pathname;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error] ' + m.text().slice(0, 200)); });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
// click the 新建任务 button (data-testid)
const btn = page.locator('[data-testid="task-new-button"]').first();
console.log('new-task button count: ' + await page.locator('[data-testid="task-new-button"]').count());
if (await btn.count()) {
  await btn.click();
  console.log('clicked new-task');
}
await page.waitForTimeout(10000);
const st = await page.evaluate(() => ({
  text: (document.body.innerText || '').slice(0, 300),
  banner: document.getElementById('zcode-webui-error') ? document.getElementById('zcode-webui-error').textContent.slice(0, 300) : null,
  calls: window.__zb_bridge_calls || [],
}));
console.log('STATE text=' + JSON.stringify(st.text));
console.log('STATE banner=' + st.banner);
console.log('BRIDGE CALLS (' + st.calls.length + '):');
st.calls.forEach((c) => console.log('  ' + c));
await page.screenshot({ path: OUT + 'shot-newtask.png' });
await browser.close();
