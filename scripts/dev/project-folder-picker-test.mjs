// Project folder picker regression (read-only, browser):
//
//   会话栏 → 新建项目 → 选择文件夹 used to die with
//   `TypeError: Cannot read properties of undefined (reading 'length')` because
//   3.16's project editor calls platform.selectDirectories() and reads `.length`
//   on the result, while the shim only implemented the single-pick
//   selectDirectory — the generic Proxy fallback answered with undefined.
//
// Usage: node scripts/dev/project-folder-picker-test.mjs [baseURL]
// Defaults to the local deployment; set ZOOM_TEST_ALLOW_PROD=1 to allow :3102.
import { chromium } from 'playwright-core';
const BASE = (process.argv[2] || process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/').replace(/\/?$/, '/');
if (/:3102\//.test(BASE) && process.env.ZOOM_TEST_ALLOW_PROD !== '1') {
  console.log('SKIP  refusing to run against :3102 (production?) — set ZOOM_TEST_ALLOW_PROD=1 to override');
  process.exit(0);
}
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const checks = [];
const check = (n, ok, extra) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  (' + extra + ')' : '')); };
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 300)); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12000);
await page.keyboard.press('Escape').catch(() => {});

const add = page.locator('[data-testid="virtual-project-add"]').first();
console.log('virtual-project-add count=' + (await add.count()));
if (await add.count()) { await add.click(); await page.waitForTimeout(800); }
else {
  const sec = page.locator('text=项目').first();
  if (await sec.count()) { await sec.click(); await page.waitForTimeout(600); }
  if (await add.count()) { await add.click(); await page.waitForTimeout(800); }
}
const menu = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"],[role="dialog"] button,[role="dialog"] [role="button"]'))
  .map((e) => (e.textContent || '').trim()).filter((t) => t && t.length < 40).slice(0, 30));
console.log('MENU=' + JSON.stringify(menu));

for (const label of ['新建项目', '创建项目', 'New project', '新项目']) {
  const loc = page.locator('text=' + label).first();
  if (await loc.count()) { console.log('opening dialog via ' + label); await loc.click(); await page.waitForTimeout(1200); break; }
}
const dialog = await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return null;
  const btns = Array.from(d.querySelectorAll('button,[role="button"]')).map((b) => (b.textContent || '').trim()).filter(Boolean);
  return { text: (d.textContent || '').slice(0, 240), btns: btns.slice(0, 20) };
});
console.log('DIALOG=' + JSON.stringify(dialog));

// the folder button in the 3.16 project editor
const folderBtn = page.locator('[role="dialog"] button', { hasText: /选择文件夹|添加文件夹|Browse|Select Folder|Choose folder/ }).first();
console.log('folder button count=' + (await folderBtn.count()));
if (await folderBtn.count()) {
  await folderBtn.click();
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => ({
    overlay: !!document.querySelector('.zwebui-ovl-frame'),
    banner: (document.getElementById('zcode-webui-error') || {}).textContent || null,
    dialogText: (document.querySelector('[role="dialog"]') || {}).textContent || '',
  }));
  console.log('AFTER-CLICK=' + JSON.stringify({ overlay: state.overlay, banner: state.banner }));
  if (state.overlay) {
    const frame = page.frameLocator('.zwebui-ovl-frame');
    // the picker lists directories over /api/fs/list — wait for that first click
    // to land before driving it
    await frame.locator('#ok').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    console.log('picker path=' + JSON.stringify(await frame.locator('#path').inputValue().catch(() => null)));
    await frame.locator('#cancel').click({ timeout: 5000 }).catch((e) => console.log('cancel click: ' + e.message.slice(0, 120)));
    await page.waitForTimeout(1000);
  }
  const after = await page.evaluate(() => ({
    overlay: !!document.querySelector('.zwebui-ovl-frame'),
    banner: (document.getElementById('zcode-webui-error') || {}).textContent || null,
    dialogOpen: !!document.querySelector('[role="dialog"]'),
  }));
  console.log('AFTER-CANCEL=' + JSON.stringify(after));
  check('picker overlay closed on cancel', !after.overlay);
  check('project dialog still usable after cancelling the picker', after.dialogOpen);
}
const typeErrors = errors.filter((e) => /length|TypeError/.test(e));
console.log('TYPE-LENGTH-ERRORS=' + JSON.stringify(typeErrors));
console.log('ALL-ERRORS=' + JSON.stringify(errors.slice(-6)));
await page.keyboard.press('Escape').catch(() => {});
await page.screenshot({ path: '/tmp/picker-verify.png' });
await browser.close();
check('no TypeError / "reading length" error anywhere', typeErrors.length === 0, JSON.stringify(typeErrors.slice(0, 3)));
const failed = checks.filter((c) => !c).length;
console.log(failed === 0 ? 'PROJECT-PICKER OK' : 'PROJECT-PICKER FAILED (' + failed + ')');
process.exit(failed ? 1 : 0);
