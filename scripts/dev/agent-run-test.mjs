import { chromium } from 'playwright-core';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || t.indexOf('zcode-webui') >= 0) console.log('[console.' + m.type() + '] ' + t.slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));
page.on('close', () => console.log('[page-closed]'));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(500);

const ed = page.locator('[data-testid="v4-composer-input"]').first();
console.log('v4-composer count=' + (await ed.count()));
await ed.click();
await page.keyboard.type('请只回复一行：列出当前目录的文件名', { delay: 15 });
await page.waitForTimeout(800);

const sendSel = '[data-testid="v4-composer-send"], [data-testid="chat-send-button"]';
const send = page.locator(sendSel).first();
let count = await send.count();
let tries = 0;
while (count === 0 && tries < 10) { await page.waitForTimeout(1000); count = await send.count(); tries++; }
console.log('send count=' + count);
if (!count) { await browser.close(); console.log('ABORT-NO-SEND'); process.exit(3); }
const disabled = await send.isDisabled().catch(() => true);
console.log('send disabled=' + disabled);
tries = 0;
while (disabled && tries < 10) { await page.waitForTimeout(1000); tries++; if (!(await send.isDisabled().catch(() => true))) break; }
await send.click();
console.log('clicked send');
for (let i = 0; i < 20; i++) {
  try { await page.waitForTimeout(10000); } catch (e) { console.log('BROWSER DIED at T+' + ((i + 1) * 10) + 's'); break; }
  const st = await page.evaluate(() => ({
    text: (document.body.innerText || ''),
    banner: document.getElementById('zcode-webui-error') ? document.getElementById('zcode-webui-error').textContent.slice(0, 200) : null,
  }));
  console.log('T+' + ((i + 1) * 10) + 's len=' + st.text.length + ' tail=' + JSON.stringify(st.text.slice(-300)));
  if (st.banner) console.log('BANNER: ' + st.banner);
}
try { await browser.close(); } catch (e) {}
console.log('DONE');
