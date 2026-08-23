import { chromium } from 'playwright-core';
const URL1 = process.env.ZCODE_WEBUI_PROXY_URL || 'http://127.0.0.1:8080/proxy/3102/?zbdebug=1';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 160)));
page.on('console', (m) => {
  const t = m.text();
  if (t.indexOf('[zb-debug]') >= 0 || t.indexOf('[zcode-webui]') >= 0 || m.type() === 'error') console.log('[' + m.type() + '] ' + t.slice(0, 200));
});
await page.goto(URL1, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('goto err: ' + e.message));
await page.waitForTimeout(12000);
const st = await page.evaluate(() => ({
  rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
  text: (document.body.innerText || '').slice(0, 120),
  banner: document.getElementById('zcode-webui-error') ? document.getElementById('zcode-webui-error').textContent.slice(0, 500) : null,
}));
console.log('STATE ' + JSON.stringify(st, null, 1));
await browser.close();
