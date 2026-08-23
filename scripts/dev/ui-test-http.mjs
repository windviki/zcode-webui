import { chromium } from 'playwright-core';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/?transport=http&zbdebug=1';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => console.log('[' + m.type() + '] ' + m.text().slice(0, 240)));
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 300)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(5000);
  const st = await page.evaluate(() => ({
    root: document.getElementById('root') ? document.getElementById('root').children.length : -1,
    text: (document.body.innerText || '').slice(0, 120),
    banner: document.getElementById('zcode-webui-error') ? document.getElementById('zcode-webui-error').textContent.slice(0, 200) : null,
  }));
  console.log('>>> state@' + i + ' root=' + st.root + ' text=' + JSON.stringify(st.text) + ' banner=' + st.banner);
  if (st.root > 0 && st.text) break;
}
await browser.close();
