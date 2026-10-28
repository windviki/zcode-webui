// One-off DOM probe against a running sandbox webui (kept alive by the repro
// script's --keep) or any base URL: dumps every element whose text matches a
// workspace name, with ancestor class chains, to identify the sidebar group row.
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || 'http://127.0.0.1:3811/').replace(/\/?$/, '/');
const NAME = process.argv[3] || 'recabyss-editor';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => !!document.querySelector('[data-workspace-sidebar-panel]'), null, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 7000));
const out = await page.evaluate((name) => {
  const hits = [];
  const walk = (el) => {
    for (const c of el.children) {
      const own = [...c.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ');
      if (own === name) {
        const chain = [];
        let a = c;
        for (let i = 0; i < 6 && a; i++) { chain.push(a.tagName + '.' + String(a.className).split(' ').slice(0, 3).join('.') + (a.getAttribute('data-state') ? '[' + a.getAttribute('data-state') + ']' : '') + (a.getAttribute('aria-expanded') !== null ? '(ae=' + a.getAttribute('aria-expanded') + ')' : '')); a = a.parentElement; }
        hits.push({ tag: c.tagName, cls: String(c.className).slice(0, 80), chain });
      }
      walk(c);
    }
  };
  walk(document.body);
  return hits.slice(0, 12);
}, NAME);
for (const h of out) console.log(h.tag + ' ' + h.cls + '\n    ' + h.chain.join('\n    <- '));
await browser.close();
