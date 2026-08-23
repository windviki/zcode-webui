import { chromium } from 'playwright-core';
import path from 'node:path';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
// directory the test opens via the picker (basename of the given path)
const TEST_NAME = path.basename(process.env.ZCODE_WEBUI_TEST_DIR || process.cwd());
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || t.indexOf('zcode-webui') >= 0) console.log('[console.' + m.type() + '] ' + t.slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);
await page.keyboard.press('Escape').catch(() => {});

// 1. open folder -> pick the test directory
await page.locator('[data-testid="project-add"]').first().click();
await page.waitForTimeout(1000);
const openFolder = page.locator('text=打开文件夹').first();
console.log('open-folder count=' + (await openFolder.count()));
if (!(await openFolder.count())) { await browser.close(); console.log('ABORT-1'); process.exit(3); }
const popupPromise = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
await openFolder.click();
const popup = await popupPromise;
if (!popup) { await browser.close(); console.log('ABORT-2'); process.exit(3); }
await popup.waitForLoadState('domcontentloaded').catch(() => {});
await popup.waitForTimeout(2000);
const row = popup.locator('.row', { hasText: TEST_NAME }).first();
console.log(TEST_NAME + ' row=' + (await row.count()));
if (await row.count()) { await row.click(); await popup.waitForTimeout(1500); }
console.log('picker path=' + (await popup.locator('#path').inputValue()));
await popup.locator('#ok').click();
await page.waitForTimeout(8000);

// 2. send a prompt in the new workspace
const ed = page.locator('[data-testid="v4-composer-input"]').first();
await ed.click();
await page.keyboard.type('请只回复一行：这个目录叫什么名字', { delay: 15 });
await page.waitForTimeout(800);
const send = page.locator('[data-testid="v4-composer-send"], [data-testid="chat-send-button"]').first();
console.log('send count=' + (await send.count()) + ' disabled=' + (await send.isDisabled().catch(() => true)));
if (await send.count()) { await send.click(); console.log('clicked send'); }
else { await browser.close(); console.log('ABORT-3'); process.exit(3); }
for (let i = 0; i < 15; i++) {
  try { await page.waitForTimeout(10000); } catch (e) { console.log('BROWSER DIED'); break; }
  const st = await page.evaluate(() => ({ text: (document.body.innerText || '').slice(0, 700) }));
  console.log('T+' + ((i + 1) * 10) + 's tail=' + JSON.stringify(st.text.slice(-280)));
  if (st.text.length > 200) { console.log('REPLY-LIKELY-SEEN'); }
}
try { await browser.close(); } catch (e) {}
console.log('DONE');
