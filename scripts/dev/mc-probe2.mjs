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
      const dump = (d) => {
        try {
          if (d === null) return 'null';
          if (d === undefined) return 'undefined';
          if (d instanceof ArrayBuffer) return 'ArrayBuffer(' + d.byteLength + ')';
          if (ArrayBuffer.isView(d)) return d.constructor.name + '(' + d.byteLength + ')';
          if (typeof d === 'object') return 'obj keys=[' + Object.keys(d).slice(0, 5).join(',') + '] ' + JSON.stringify(d).slice(0, 120);
          return typeof d + ' ' + String(d).slice(0, 60);
        } catch (e) { return 'dump-err ' + e.message; }
      };
      this.port1.addEventListener('message', (e) => console.log('[mc:' + tag + '] port1 <- ' + dump(e.data)));
      this.port2.addEventListener('message', (e) => console.log('[mc:' + tag + '] port2 <- ' + dump(e.data)));
    }
  };
  const OrigWS = window.WebSocket;
  window.WebSocket = class extends OrigWS {
    constructor(...args) {
      super(...args);
      const tag = Math.random().toString(36).slice(2, 6);
      this.addEventListener('message', (e) => {
        const d = e.data;
        const desc = typeof d === 'string' ? 'text ' + d.slice(0, 60) : d instanceof ArrayBuffer ? 'ArrayBuffer(' + d.byteLength + ')' : 'Blob?';
        console.log('[ws:' + tag + '] <- ' + desc);
      });
    }
  };
});
page.on('console', (m) => console.log('[' + m.type() + '] ' + m.text().slice(0, 260)));
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15000);
const st = await page.evaluate(() => ({ root: document.getElementById('root').children.length }));
console.log('root children:', st.root);
await browser.close();
