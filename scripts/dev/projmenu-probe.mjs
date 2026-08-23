import { chromium } from 'playwright-core';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);
await page.keyboard.press('Escape').catch(() => {});
const sec = page.locator('[data-testid="project-section"]').first();
console.log('project-section count=' + (await sec.count()));
await sec.click();
await page.waitForTimeout(1200);
const dump = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('[role="menuitem"], [role="option"], button, [role="button"]').forEach((el) => {
    const t = (el.textContent || '').trim();
    if (t && t.length < 40) out.push({ tag: el.tagName, role: el.getAttribute('role'), tid: el.getAttribute('data-testid'), t });
  });
  return out.slice(0, 50);
});
console.log(JSON.stringify(dump, null, 1).slice(0, 3200));
await browser.close();
