import { chromium } from 'playwright-core';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);
const dump = await page.evaluate(() => {
  const out = {};
  const ed = document.querySelector('[contenteditable="true"]');
  if (ed) {
    let host = ed;
    for (let i = 0; i < 12 && host; i++) {
      host = host.parentElement;
      if (host && (host.tagName === 'FORM' || host.closest && host.closest('form'))) break;
    }
    out.edHost = ed.parentElement ? ed.parentElement.tagName : null;
    const form = ed.closest('form');
    if (form) {
      out.formHtml = form.outerHTML.slice(0, 1200);
      const btns = [];
      form.querySelectorAll('button').forEach(b => btns.push({ t: b.type, tid: b.getAttribute('data-testid'), label: (b.getAttribute('aria-label') || '').slice(0, 30), disabled: b.disabled }));
      out.formButtons = btns;
    } else {
      out.noForm = true;
      out.edOuter = ed.outerHTML.slice(0, 400);
    }
  } else {
    out.noEditable = true;
  }
  const allSubmit = [];
  document.querySelectorAll('button[type=submit], [data-testid*="send"]').forEach(b => allSubmit.push({ t: b.type, tid: b.getAttribute('data-testid'), label: (b.getAttribute('aria-label') || b.textContent || '').slice(0, 30), disabled: b.disabled, visible: !!(b.offsetWidth || b.offsetHeight) }));
  out.allSubmit = allSubmit.slice(0, 10);
  return out;
});
console.log(JSON.stringify(dump, null, 2).slice(0, 3000));
await browser.close();
