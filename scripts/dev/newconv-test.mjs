import { chromium } from 'playwright-core';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);
await page.keyboard.press('Escape').catch(() => {});
const newTask = page.locator('[data-testid="conversation-new-task"]').first();
console.log('conversation-new-task count=' + (await newTask.count()));
if (await newTask.count()) { await newTask.click(); console.log('clicked conversation-new-task'); await page.waitForTimeout(4000); }
const ed = page.locator('[data-testid="v4-composer-input"]').first();
console.log('composer count after=' + (await ed.count()));
await ed.click();
await page.keyboard.type('回复数字 42 即可', { delay: 12 });
await page.waitForTimeout(800);
const send = page.locator('[data-testid="v4-composer-send"], [data-testid="chat-send-button"]').first();
if (await send.count()) { await send.click(); console.log('clicked send'); }
else { await browser.close(); console.log('ABORT-NO-SEND'); process.exit(3); }
let done = false;
for (let i = 0; i < 12; i++) {
  try { await page.waitForTimeout(10000); } catch (e) { console.log('BROWSER DIED'); break; }
  const st = await page.evaluate(() => (document.body.innerText || ''));
  const tail = st.slice(-260);
  console.log('T+' + ((i + 1) * 10) + 's tail=' + JSON.stringify(tail));
  if (/42/.test(st)) { console.log('PASS: reply contains 42'); done = true; break; }
}
console.log(done ? 'PASS' : 'INCONCLUSIVE');
try { await browser.close(); } catch (e) {}
console.log('DONE');
