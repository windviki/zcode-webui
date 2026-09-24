#!/usr/bin/env node
// UI boot gate: boot the deployed official renderer in headless Chromium and fail
// when it does not actually paint the app.
//
// Why this exists: protocol-level smoke tests (scripts/smoke-test.mjs) can pass while
// the renderer itself refuses to start. Official renderers >= 3.12, for example, wait
// for a desktop "database startup" channel (window message zcode:database-startup-state
// + a MessagePort) that web/bootstrap.js provides for the browser shim. If that wiring
// regresses, the page renders a "未能收到启动状态 / startup-channel-unavailable" failure
// screen — the bridge can be fine while the UI is dead. zcode-update.sh runs this gate
// after every update and reverts the update when it fails.
//
// Usage: node scripts/ui-boot-check.mjs [baseUrl] [screenshotPath]
// Exit: 0 = app booted, 1 = failed gate, 3 = skipped (playwright-core or browser missing)
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3102/';
const SHOT = process.argv[3] || '';
const TIMEOUT_MS = Number(process.env.ZCODE_UI_CHECK_TIMEOUT_MS || 45000);
const MIN_PAINTED_HTML = 20000; // a real app shell is >100 KB of DOM; a spinner is <5 KB
// Headless Chromium ignores the shell's HTTPS_PROXY (unlike curl), so on a box that
// needs a proxy for egress the official renderer's own outbound calls fail with
// ERR_EMPTY_RESPONSE and would be reported as page errors. Pass ZCODE_UI_CHECK_PROXY
// (or fall back to HTTPS_PROXY) to route the browser the same way.
const PROXY = (process.env.ZCODE_UI_CHECK_PROXY || process.env.HTTPS_PROXY || '').trim();

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch (_e) {
  console.log('SKIP  playwright-core 未安装（npm i -D playwright-core）');
  process.exit(3);
}

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(PROXY ? { proxy: { server: PROXY, bypass: 'localhost,127.0.0.1,::1' } } : {}),
  });
} catch (err) {
  console.log('SKIP  无法启动 Chromium: ' + String(err.message || err).slice(0, 200));
  process.exit(3);
}

const pageErrors = [];
const checks = [];
const check = (name, pass, extra) => {
  checks.push({ name, pass });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
};

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 240)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 240)); });

const snap = async () => {
  try {
    return await page.evaluate(() => {
      const root = document.getElementById('root');
      return {
        ready: document.body.className.includes('zcode-startup-ready'),
        rootHtmlLen: root ? root.innerHTML.length : -1,
        composer: document.querySelectorAll('[data-testid="v4-composer-input"]').length,
        text: (document.body.innerText || '').slice(0, 400),
      };
    });
  } catch (err) {
    // navigation/context torn down (e.g. the URL does not answer at all)
    return { ready: false, rootHtmlLen: -1, composer: 0, text: '', navError: String(err.message || err).slice(0, 160) };
  }
};

const started = Date.now();
let gotoErr = '';
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  .catch((e) => { gotoErr = String(e.message || e).slice(0, 200); });

let state = await snap();
let painted = false;
// fail fast when the page itself never loaded; otherwise wait for the app to paint
while (!gotoErr && Date.now() - started < TIMEOUT_MS) {
  state = await snap();
  painted = state.ready && state.rootHtmlLen >= MIN_PAINTED_HTML;
  if (painted) break;
  await page.waitForTimeout(2000);
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1) + 's';
if (SHOT) { try { writeFileSync(SHOT, await page.screenshot()); } catch (_e) { /* ignore */ } }

// the official renderer's own startup-failure screen (e.g. if the browser shim
// regresses and no longer supplies the desktop database-startup channel)
const failureScreen = /未能收到启动状态|无法完成启动准备|startup-channel-unavailable/.exec(state.text || '');

check('页面可加载', !gotoErr && state.rootHtmlLen >= 0, gotoErr || state.navError || '');
check('渲染层进入 startup-ready', state.ready === true, elapsed);
check('应用已完成绘制', painted, 'root=' + state.rootHtmlLen + 'B, composer=' + state.composer);
check('未出现官方启动失败页', !failureScreen, failureScreen ? failureScreen[0] : '');
check('无页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = checks.filter((c) => !c.pass).length;
console.log(failed === 0 ? 'UI CHECK OK' : 'UI CHECK FAILED (' + failed + ')');
if (failed !== 0 && state.text) console.log('页面文本片段: ' + JSON.stringify(state.text.slice(0, 200)));
process.exit(failed === 0 ? 0 : 1);
