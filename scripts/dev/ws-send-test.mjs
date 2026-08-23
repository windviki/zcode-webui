import { chromium } from 'playwright-core';
import path from 'node:path';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
// directory the test switches to and asks the agent about
const TEST_DIR = process.env.ZCODE_WEBUI_TEST_DIR || process.cwd();
const TEST_NAME = path.basename(TEST_DIR);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);
await page.keyboard.press('Escape').catch(() => {});
// open the workspace switcher menu
const trig = page.locator('[data-testid="composer-workspace-trigger"]').first();
console.log('trigger count=' + (await trig.count()) + ' text=' + JSON.stringify(await trig.textContent().catch(() => null)));
await trig.click();
await page.waitForTimeout(1200);
const menuDump = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('[role="menuitem"], [role="option"], [data-testid]').forEach((el) => {
    const t = (el.textContent || '').trim();
    const tid = el.getAttribute('data-testid');
    if (tid && (tid.includes('workspace') || t)) out.push({ tag: el.tagName, role: el.getAttribute('role'), tid, t: t.slice(0, 30) });
  });
  return out.slice(0, 40);
});
console.log('menu=' + JSON.stringify(menuDump));
// click the test directory entry if present
const entry = page.locator('[role="menuitem"]', { hasText: TEST_NAME }).first();
console.log('entry count=' + (await entry.count()));
if (await entry.count()) {
  await entry.click();
  await page.waitForTimeout(4000);
}
console.log('trigger after=' + JSON.stringify(await trig.textContent().catch(() => null)));
// now send in the switched workspace
const ed = page.locator('[data-testid="v4-composer-input"]').first();
await ed.click();
await page.keyboard.type('这个工作区路径是什么？只回复路径', { delay: 12 });
await page.waitForTimeout(800);
const send = page.locator('[data-testid="v4-composer-send"], [data-testid="chat-send-button"]').first();
if (await send.count()) { await send.click(); console.log('clicked send'); }
else { await browser.close(); console.log('ABORT-NO-SEND'); process.exit(3); }
let done = false;
for (let i = 0; i < 12; i++) {
  try { await page.waitForTimeout(10000); } catch (e) { console.log('BROWSER DIED'); break; }
  const st = await page.evaluate(() => (document.body.innerText || ''));
  const tail = st.slice(-300);
  console.log('T+' + ((i + 1) * 10) + 's tail=' + JSON.stringify(tail));
  if (st.includes(TEST_DIR)) { console.log('PASS: reply references ' + TEST_DIR); done = true; break; }
}
console.log(done ? 'PASS' : 'INCONCLUSIVE');
try { await browser.close(); } catch (e) {}
console.log('DONE');
