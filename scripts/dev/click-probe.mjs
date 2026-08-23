import { chromium } from 'playwright-core';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => console.log('[console.' + m.type() + '] ' + m.text().slice(0, 250)));
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 250)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
const before = await page.evaluate(() => ({
  dialogs: document.querySelectorAll('[role="dialog"]').length,
  paletteInput: !!document.querySelector('input[placeholder*="搜索"]'),
  newTaskButtons: document.querySelectorAll('[data-testid="task-new-button"]').length,
  textHead: (document.body.innerText || '').slice(0, 80),
}));
console.log('BEFORE ' + JSON.stringify(before));
await page.locator('[data-testid="task-new-button"]').first().click();
await page.waitForTimeout(1500);
const after = await page.evaluate(() => ({
  dialogs: document.querySelectorAll('[role="dialog"]').length,
  paletteInput: !!document.querySelector('input[placeholder*="搜索"]'),
  textHead: (document.body.innerText || '').slice(0, 80),
  visibleButtons: Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent !== null).slice(0, 20).map((b) => (b.textContent || '').trim().slice(0, 20)).filter(Boolean),
}));
console.log('AFTER ' + JSON.stringify(after, null, 1));
await browser.close();
