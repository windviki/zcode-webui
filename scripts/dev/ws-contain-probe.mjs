import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:3781/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => !!document.querySelector('[data-workspace-sidebar-panel]'), null, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 6000));
const out = await page.evaluate(() => {
  const res = { panelExists: !!document.querySelector('[data-workspace-sidebar-panel]') };
  const row = [...document.querySelectorAll('[aria-expanded]')].find((e) => (e.textContent || '').trim().startsWith('wsx-ws') && e.closest('[data-state]'));
  res.rowInPanel = row ? !!row.closest('[data-workspace-sidebar-panel]') : 'no-row';
  if (row) {
    // walk ALL the way up
    const chain = [];
    let a = row;
    while (a && a !== document.body) {
      const cls = String(a.className).split(' ')[0];
      if (a.getAttribute('data-workspace-sidebar-panel') !== null) { chain.push('***PANEL***'); break; }
      chain.push(cls.slice(0, 24) || a.tagName);
      a = a.parentElement;
    }
    res.chain = chain.slice(0, 14).join(' < ');
  }
  // composer chip for contrast
  const chip = [...document.querySelectorAll('[aria-expanded]')].find((e) => (e.textContent || '').trim().startsWith('wsx-ws') && !e.closest('[data-state]'));
  res.chipInPanel = chip ? !!chip.closest('[data-workspace-sidebar-panel]') : 'no-chip';
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
