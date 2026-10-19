#!/usr/bin/env node
// Settings / usage-stats regression: 3.15 added a close-to-tray capability
// lookup to the settings shell. The generic window.zcode Proxy fallback
// resolved `undefined`, the renderer stored it and then read `capability.supported`
// without a null guard, crashing the whole settings section with
// "Cannot read properties of undefined (reading 'supported')". This test opens
// the real renderer, enters Settings, opens 使用统计 and asserts the section
// renders without the error boundary.
//
// Read-only page interaction. Usage: node scripts/dev/settings-usage-test.mjs [baseUrl]
// Production is only touched when ZOOM_TEST_ALLOW_PROD=1 is set.
const BASE = (process.argv[2] || process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/').replace(/\/?$/, '/');
if (/127\.0\.0\.1:3102/.test(BASE) && process.env.ZOOM_TEST_ALLOW_PROD !== '1') {
  console.log('SKIP  生产地址需要 ZOOM_TEST_ALLOW_PROD=1 确认（本测试会打开浏览器并创建视图，但不改设置）');
  process.exit(3);
}

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch (_e) { console.log('SKIP  playwright-core 未安装'); process.exit(3); }

let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
} catch (e) {
  console.log('SKIP  无法启动 Chromium: ' + String(e.message || e).slice(0, 200));
  process.exit(3);
}

const checks = [];
const check = (name, ok, extra) => {
  checks.push(ok);
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e.stack || e.message).slice(0, 1200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 1200)); });

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  check('页面已加载并绘制', (await page.locator('[data-testid="v4-composer-input"]').count()) > 0);

  await page.locator('[data-testid="task-settings-button"]').click({ timeout: 8000 });
  await page.waitForTimeout(2000);
  let text = await page.locator('body').innerText();
  check('设置页出现「使用统计」入口', /使用统计/.test(text), text.slice(0, 80).replace(/\n/g, ' '));
  check('设置页没有 error boundary',
    !/Cannot read properties|ran into a problem|This section ran into a problem/.test(text));

  const usage = page.getByText('使用统计', { exact: false }).first();
  if (await usage.count().catch(() => 0)) {
    await usage.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2500);
    text = await page.locator('body').innerText();
    check('使用统计内容已渲染（应用用量 / Token 活动）',
      /应用用量|Token 活动|累计 Token/.test(text), text.slice(0, 120).replace(/\n/g, ' '));
    check('使用统计页没有 error boundary',
      !/Cannot read properties|ran into a problem|This section ran into a problem/.test(text));
  } else {
    check('使用统计入口可点击', false);
  }

  const relevant = errors.filter((e) => /supported|ran into a problem|Cannot read properties/.test(e));
  check('没有 settings / usage 相关页面错误', relevant.length === 0, relevant.slice(0, 2).join(' | '));
} catch (e) {
  console.log('FAIL  ' + String((e && e.stack) || e).slice(0, 1200));
  checks.push(false);
}

await browser.close();
const failed = checks.filter((c) => !c).length;
console.log(failed === 0 ? 'SETTINGS-USAGE OK' : 'SETTINGS-USAGE FAILED (' + failed + ')');
process.exit(failed === 0 ? 0 : 1);
