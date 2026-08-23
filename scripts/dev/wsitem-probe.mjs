import { chromium } from 'playwright-core';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
// workspace whose item DOM we inspect (data-testid="workspace-item-<dir>")
const TEST_DIR = process.env.ZCODE_WEBUI_TEST_DIR || process.cwd();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);
const dump = await page.evaluate((dir) => {
  const out = {};
  const item = document.querySelector('[data-testid="workspace-item-' + dir + '"]');
  if (item) {
    out.itemHtml = item.outerHTML.slice(0, 1800);
    out.role = item.getAttribute('role');
    out.tabindex = item.getAttribute('tabindex');
    const kids = [];
    item.querySelectorAll('*').forEach((el) => {
      if (kids.length < 20) kids.push(el.tagName + (el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '') + (el.getAttribute('data-testid') ? '[tid=' + el.getAttribute('data-testid') + ']' : '') + ' t="' + (el.textContent || '').trim().slice(0, 24) + '"');
    });
    out.kids = kids;
    const parent = item.parentElement;
    if (parent) out.parentHtml = parent.outerHTML.slice(0, 800);
  } else {
    out.missing = true;
    out.all = Array.from(document.querySelectorAll('[data-testid^="workspace-item"]')).map(e => e.getAttribute('data-testid'));
  }
  return out;
}, TEST_DIR);
console.log(JSON.stringify(dump, null, 1).slice(0, 3800));
await browser.close();
