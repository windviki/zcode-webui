import { chromium } from 'playwright-core';
const URL1 = process.env.ZCODE_WEBUI_NO_SLASH_URL || 'http://127.0.0.1:8080/proxy/3102'; // no trailing slash, via code-server proxy
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error] ' + m.text().slice(0, 200)); });
await page.goto(URL1, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('goto err: ' + e.message));
await page.waitForTimeout(6000);
console.log('final URL: ' + page.url());
const st = await page.evaluate(() => ({
  rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
  rootLen: document.getElementById('root') ? document.getElementById('root').innerHTML.length : -1,
  text: (document.body.innerText || '').slice(0, 150),
  banner: document.getElementById('zcode-webui-error') ? document.getElementById('zcode-webui-error').textContent.slice(0, 200) : null,
}));
console.log('STATE ' + JSON.stringify(st));
await browser.close();
