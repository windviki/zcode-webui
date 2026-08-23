import { chromium } from 'playwright-core';
import path from 'node:path';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
// directory the test navigates to inside the picker (basename of the given path)
const TEST_DIR = process.env.ZCODE_WEBUI_TEST_DIR || process.cwd();
const TEST_NAME = path.basename(TEST_DIR);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || t.indexOf('zcode-webui') >= 0 || t.indexOf('workspace') >= 0) console.log('[console.' + m.type() + '] ' + t.slice(0, 220)); });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 220)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(400);

const add = page.locator('[data-testid="project-add"]').first();
await add.click();
await page.waitForTimeout(1000);
const openFolder = page.locator('text=打开文件夹').first();
console.log('open-folder count=' + (await openFolder.count()));
if (!(await openFolder.count())) { await browser.close(); console.log('ABORT-NO-MENU-ITEM'); process.exit(3); }
const popupPromise = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
await openFolder.click();
const popup = await popupPromise;
console.log('popup=' + (popup ? popup.url() : 'NONE'));
if (!popup) { await browser.close(); console.log('ABORT-NO-POPUP'); process.exit(3); }
await popup.waitForLoadState('domcontentloaded').catch(() => {});
await popup.waitForTimeout(2000);
// navigate into the target directory
const row = popup.locator('.row', { hasText: TEST_NAME }).first();
console.log(TEST_NAME + ' row count=' + (await row.count()));
if (await row.count()) {
  await row.click();
  await popup.waitForTimeout(1500);
}
const pathVal = await popup.locator('#path').inputValue();
console.log('picker path=' + pathVal);
await popup.locator('#ok').click();
console.log('clicked ok');
await page.waitForTimeout(10000);
const after = await page.evaluate((name) => ({
  wsItems: Array.from(document.querySelectorAll('[data-testid^="workspace-item"]')).map(e => e.getAttribute('data-testid')),
  trig: (document.querySelector('[data-testid="composer-workspace-trigger"]') || {}).textContent || null,
  recent: Array.from(document.querySelectorAll('*')).filter(e => e.children.length === 0 && (e.textContent || '').includes(name)).length,
}), TEST_NAME);
console.log('AFTER wsItems=' + JSON.stringify(after.wsItems));
console.log('AFTER trigger=' + JSON.stringify(after.trig));
await browser.close();
console.log('DONE');
