// E2E verification for the mode-boost fast lane (run against a RESTARTED
// service that carries src/mode-boost.mjs + the bridge switch).
//
// Scenario (mirrors the user report): a build-mode turn runs three sequential
// write commands. Before the fix the user had to click 允许 on all three cards
// (the composer with the mode dropdown is REPLACED by each card, so flipping
// to 完全访问 mid-turn is practically impossible). Now:
//   1. card #1 shows up (proves build mode asks);
//   2. the shim's ⚡ button is clicked WHILE THE CARD IS PENDING;
//   3. card #1 gets auto-allowed, commands #2 and #3 run with NO further card;
//   4. all three files exist; the task index shows mode=yolo.
import { existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASE = process.argv[2] || 'http://127.0.0.1:3102/';
const OUT = new URL('.', import.meta.url).pathname;
for (const f of ['/tmp/zb-1.txt', '/tmp/zb-2.txt', '/tmp/zb-3.txt']) { try { unlinkSync(f); } catch (_e) {} }
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { const t = m.text(); if (t.includes('mode-boost')) console.log('   [page] ' + t.slice(0, 160)); });
const sleep = (ms) => page.waitForTimeout(ms);
const bodyText = () => page.evaluate(() => (document.body.innerText) || '');
let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); } };

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
for (let i = 0; i < 45; i++) { if ((await bodyText()).length > 500) break; await sleep(2000); }
await sleep(3000);

const boostBtn = page.locator('.zwebui-boost').first();
check('shim ⚡ button present', (await boostBtn.count()) === 1);
check('⚡ button starts OFF', /切完全访问/.test(await boostBtn.innerText()));

const composer = page.locator('[data-testid="v4-composer-input"]').first();
for (let i = 0; i < 15 && (await composer.isVisible()) === false; i++) await sleep(1500);
await composer.click();
await composer.fill('请依次执行这三条 Bash 命令，一条执行完再执行下一条，不要合并：\necho a > /tmp/zb-1.txt\necho b > /tmp/zb-2.txt\necho c > /tmp/zb-3.txt\n全部完成后单独回复一行：ZB-DONE');
await page.keyboard.press('Enter');
console.log('prompt sent (build mode)');

const cardVisible = () => page.evaluate(() => {
  for (const b of document.querySelectorAll('button')) {
    const t = (b.innerText || '').replace(/\s+/g, '');
    if (t.includes('允许仅允许这一次')) return true;
  }
  return false;
});

// wait for the FIRST card — proof that build mode asks
let firstCard = false;
const t0 = Date.now();
while (Date.now() - t0 < 120000) {
  await sleep(1500);
  if (await cardVisible()) { firstCard = true; break; }
  if (existsSync('/tmp/zb-3.txt')) break;
}
check('permission card #1 raised in build mode', firstCard);

if (firstCard) {
  // THE FIX UNDER TEST: flip the shim switch while the card is pending
  await boostBtn.click();
  console.log('⚡ clicked while card pending');
  await sleep(1000);
  check('⚡ button shows ON', /已生效/.test(await boostBtn.innerText()));
}

// now watch the rest of the turn: card #1 auto-allowed, #2/#3 must NOT ask
let extraCards = 0;
let lastSeenCard = false;
for (let i = 0; i < 120 && Date.now() - t0 < 300000; i++) {
  const c = await cardVisible();
  if (c && !lastSeenCard) extraCards++;
  lastSeenCard = c;
  if (existsSync('/tmp/zb-3.txt')) break;
  await sleep(1000);
}
await sleep(4000);
const files = [1, 2, 3].filter((n) => existsSync('/tmp/zb-' + n + '.txt'));
check('all three commands executed', files.length === 3, 'files=' + files.join(','));
check('no permission card needed human action after the switch', extraCards === 0, 'cards after switch=' + extraCards);
check('card #1 was auto-allowed (composer area shows no pending card)', !(await cardVisible()));

await page.screenshot({ path: OUT + 'mode-boost-verify.png' }).catch(() => {});

// task index should record yolo for this conversation
try {
  const mode = execSync(`python3 -c "import sqlite3;c=sqlite3.connect('/home/coder/.zcode/v2/tasks-index.sqlite');r=list(c.execute(\\"select mode from tasks where task_id=(select task_id from tasks order by updated_at desc limit 1)\\"));print(r[0][0] if r else 'none')"`, { encoding: 'utf8' }).trim();
  check('task index mode=yolo', mode === 'yolo', 'mode=' + mode);
} catch (e) { check('task index mode=yolo', false, String(e.message).slice(0, 80)); }

// restore: switch back OFF (pushes the official dropdown's mode)
await boostBtn.click().catch(() => {});
await sleep(800);

await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
