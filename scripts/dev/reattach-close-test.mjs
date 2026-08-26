// Close-tab-mid-turn test: the exact scenario the user reported.
// Start a real turn, CLOSE the page, open a NEW page: the new tab gets a FRESH
// host (pipes are never shared between renderers) and the background turn keeps
// running to completion.
// Costs one tiny model call. Usage: node scripts/dev/reattach-close-test.mjs
import { chromium } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
const DB_PATH = process.env.ZCODE_HOME
  ? path.join(process.env.ZCODE_HOME, 'cli', 'db', 'db.sqlite')
  : path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const STARTED_AT = Date.now();

// the background turn must eventually persist an assistant "44" text part
async function replyInDb() {
  try {
    const d = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const row = d.prepare(`
        SELECT COUNT(*) AS n FROM part p
        JOIN message m ON m.id = p.message_id
        WHERE m.time_created > ? AND p.data LIKE '%44%'
      `).get(STARTED_AT - 60000);
      return (row && row.n > 0);
    } finally { d.close(); }
  } catch (_e) { return false; }
}

await fetch(BASE + 'api/sessions/terminate', { method: 'POST' }).catch(() => {});

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

const logs = [];
function attachConsole(page, tag) {
  page.on('console', (m) => {
    const t = m.text();
    logs.push(tag + ' ' + t);
    if (t.indexOf('zcode-webui') >= 0 || m.type() === 'error') console.log('[' + tag + ':' + m.type() + '] ' + t.slice(0, 180));
  });
  page.on('pageerror', (e) => console.log('[' + tag + ':pageerror] ' + e.message.slice(0, 200)));
}

const checks = [];
function check(name, ok, extra) {
  checks.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
}

try {
  const page = await ctx.newPage();
  attachConsole(page, 'tab1');
  console.log('>>> tab1 goto');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(12000);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);

  const ed = page.locator('[data-testid="v4-composer-input"]').first();
  await ed.click();
  await page.keyboard.type('请只回复数字 44，不要做任何其他操作。', { delay: 12 });
  await page.waitForTimeout(800);
  const send = page.locator('[data-testid="v4-composer-send"], [data-testid="chat-send-button"]').first();
  let tries = 0;
  while ((await send.count()) === 0 && tries < 10) { await page.waitForTimeout(1000); tries++; }
  if (!(await send.count())) { check('send button present', false); throw new Error('no send button'); }
  let disabled = await send.isDisabled().catch(() => true);
  tries = 0;
  while (disabled && tries < 10) { await page.waitForTimeout(1000); tries++; if (!(await send.isDisabled().catch(() => true))) break; }
  await send.click();
  console.log('>>> sent, waiting 6s, then CLOSING the tab mid-turn');
  await page.waitForTimeout(6000);

  // ---- close the tab completely (the host must keep running detached) ----
  const beforeClose = (await fetch(BASE + 'api/health').then((r) => r.json())).sessions;
  await page.close();
  await new Promise((r) => setTimeout(r, 3000));
  const h1 = await fetch(BASE + 'api/health').then((r) => r.json());
  check('host detached (kept alive) after tab close', h1.sessions.detached >= beforeClose.detached + 1, JSON.stringify(h1.sessions));

  // ---- open a brand new tab: it must get a FRESH host (no pipe sharing) ----
  const page2 = await ctx.newPage();
  attachConsole(page2, 'tab2');
  console.log('>>> tab2 goto (fresh host expected)');
  await page2.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  let spawned = false;
  for (let i = 0; i < 60 && !spawned; i++) {
    await page2.waitForTimeout(1000);
    spawned = logs.some((t) => t.indexOf('tab2') >= 0 && t.indexOf('host spawned') >= 0);
  }
  check('new tab got a fresh host', spawned);

  await page2.waitForTimeout(8000);
  const st = await page2.evaluate(() => ({
    root: document.getElementById('root') ? document.getElementById('root').children.length : -1,
    ready: document.body.className.indexOf('zcode-startup-ready') >= 0,
    parked: (document.body.innerText || '').indexOf('已被另一个标签页接管') >= 0,
    banner: document.getElementById('zcode-webui-error') ? document.getElementById('zcode-webui-error').textContent.slice(0, 200) : null,
    text: (document.body.innerText || '').slice(0, 400),
  }));
  check('new tab UI rendered', st.root > 0 && st.ready && !st.parked && !st.banner, JSON.stringify(st).slice(0, 160));

  // the background turn keeps running; assert its reply is persisted in the shared
  // session db (the new tab can then open the task from the task panel to see it)
  let completed = false;
  for (let i = 0; i < 30; i++) {
    await page2.waitForTimeout(5000);
    completed = await replyInDb();
    console.log('T+' + ((i + 1) * 5) + 's replyInDb=' + completed);
    if (completed) break;
  }
  check('background turn completed after the tab was closed', completed);

  await page2.close();
} catch (e) {
  console.log('FAIL  ' + (e && e.message ? e.message : e));
  checks.push({ name: 'exception', ok: false });
}

await fetch(BASE + 'api/sessions/terminate', { method: 'POST' }).catch(() => {});
try { await browser.close(); } catch (e) { /* ignore */ }
const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0 ? 'REATTACH-CLOSE OK' : 'REATTACH-CLOSE FAILED (' + failed + ')');
process.exit(failed === 0 ? 0 : 1);
