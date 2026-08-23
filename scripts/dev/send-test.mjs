import { chromium } from 'playwright-core';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || t.indexOf('zcode-webui') >= 0 || t.indexOf('v4-draft-readiness') >= 0 || t.indexOf('readiness') >= 0 || t.indexOf('admission') >= 0) console.log('[console.' + m.type() + '] ' + t.slice(0, 250)); });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);

// find the composer input
const candidates = [];
for (const sel of ['textarea', '[contenteditable="true"]', '[role="textbox"]']) {
  const n = await page.locator(sel).count();
  candidates.push(sel + '=' + n);
}
console.log('input candidates: ' + candidates.join(' '));

const ed = page.locator('[contenteditable="true"]').first();
if (await ed.count()) {
  await ed.click();
  await page.keyboard.type('你好，帮我列出当前目录的文件', { delay: 20 });
  console.log('typed into composer');
  const send = page.locator('[data-testid="chat-send-button"]').first();
  if (await send.count()) { await send.click(); console.log('clicked send'); }
  await page.waitForTimeout(45000);
  const st = await page.evaluate(() => ({
    text: (document.body.innerText || '').slice(0, 400),
    banner: document.getElementById('zcode-webui-error') ? document.getElementById('zcode-webui-error').textContent.slice(0, 300) : null,
    calls: (window.__zb_bridge_calls || []).slice(-12),
  }));
  console.log('AFTER-SEND text=' + JSON.stringify(st.text));
  console.log('AFTER-SEND banner=' + st.banner);
  console.log('RECENT BRIDGE CALLS:');
  st.calls.forEach((c) => console.log('  ' + c));
}
await browser.close();
