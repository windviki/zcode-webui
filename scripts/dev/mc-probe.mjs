import { chromium } from 'playwright-core';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  const OrigMC = window.MessageChannel;
  window.MessageChannel = class extends OrigMC {
    constructor(...args) {
      super(...args);
      const tag = Math.random().toString(36).slice(2, 6);
      this.port1.addEventListener('message', (e) => {
        const d = e.data;
        const sz = d && (d.byteLength !== undefined ? d.byteLength : d.length !== undefined ? d.length : 'obj');
        console.log('[mc:' + tag + '] port1 <- ' + typeof d + ' size=' + sz + (d && d.hex ? '' : ''));
      });
      this.port2.addEventListener('message', (e) => {
        const d = e.data;
        const sz = d && (d.byteLength !== undefined ? d.byteLength : d.length !== undefined ? d.length : 'obj');
        console.log('[mc:' + tag + '] port2 <- ' + typeof d + ' size=' + sz);
      });
    }
  };
});
page.on('console', (m) => console.log('[' + m.type() + '] ' + m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15000);
const st = await page.evaluate(() => ({ root: document.getElementById('root').children.length }));
console.log('root children:', st.root);
await browser.close();
