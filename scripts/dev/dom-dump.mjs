import { chromium } from 'playwright-core';
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
const OUT = new URL('.', import.meta.url).pathname;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 300)));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12000);
const info = await page.evaluate(() => {
  const root = document.getElementById('root');
  const text = document.body.innerText || '';
  return {
    title: document.title,
    bodyClass: document.body.className,
    rootChildren: root ? root.children.length : -1,
    innerText: text.slice(0, 1500),
    buttons: document.querySelectorAll('button').length,
    inputs: document.querySelectorAll('input').length,
    textareas: document.querySelectorAll('textarea').length,
    rootHtml: root ? root.innerHTML.slice(0, 2500) : '',
  };
});
console.log('TITLE:', info.title);
console.log('BODYCLASS:', info.bodyClass);
console.log('ROOTCHILDREN:', info.rootChildren);
console.log('BUTTONS/INPUTS/TEXTAREAS:', info.buttons, info.inputs, info.textareas);
console.log('INNERTEXT:', JSON.stringify(info.innerText));
console.log('ROOTHTML:', info.rootHtml.slice(0, 2500));
await page.screenshot({ path: OUT + 'shot-main2.png' });
await browser.close();
