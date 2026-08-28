// Cross-device sequential-send regression (multi-view live model):
//   device A sends a long streaming turn; device B attaches MID-TURN and must
//   see live progress; B then sends the NEXT instruction while A's turn is
//   still running — the official runtime must QUEUE it and execute in order
//   on the single shared host (never two concurrent agents).
// Usage: node scripts/dev/cross-device-queue-test.mjs [baseURL]
// Without a baseURL it spawns its own sandboxed server with a REAL credentials
// copy (this test burns a small amount of real model quota).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fsMod from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fsExists = (f) => { try { return fsMod.existsSync(f); } catch (_e) { return false; } };

var BASE = null, sandbox = null, server = null;
if (process.argv[2] || process.env.ZCODE_WEBUI_TEST_URL) {
  BASE = (process.argv[2] || process.env.ZCODE_WEBUI_TEST_URL).replace(/\/?$/, '/');
} else {
  // NOTE: the official host reads credentials from $HOME/.zcode (it does not
  // honor ZCODE_HOME), so the state must land inside the sandbox HOME.
  sandbox = mkdtempSync('/tmp/zwebui-xdev.XXXXXX');
  const zh = path.join(sandbox, 'home', '.zcode');
  for (const d of [path.join(zh, 'v2'), path.join(zh, 'cli'), 'data/vendor']) mkdirSync(path.join(sandbox, d.startsWith('/') ? d : path.join(sandbox, d)), { recursive: true });
  cpSync(path.join(os.homedir(), '.zcode/server'), path.join(zh, 'server'), { recursive: true });
  cpSync(path.join(os.homedir(), '.zcode/v2'), path.join(zh, 'v2'), { recursive: true });
  if (fsExists(path.join(os.homedir(), '.zcode/cli/config.json'))) cpSync(path.join(os.homedir(), '.zcode/cli/config.json'), path.join(zh, 'cli/config.json'));
  cpSync(path.join(ROOT, 'vendor/renderer'), path.join(sandbox, 'data/vendor/renderer'), { recursive: true });
  for (const f of fsMod.readdirSync(os.homedir())) {
    if (f.startsWith('models_catalog')) { try { cpSync(path.join(os.homedir(), f), path.join(sandbox, 'home', f)); } catch (_e) { /* ignore */ } }
  }
  const port = 3196 + Math.floor(Math.random() * 300);
  server = spawn(process.execPath, [path.join(ROOT, 'src/server.mjs'), '--port', String(port)], {
    env: { ...process.env, ZCODE_WEBUI_HOME: path.join(sandbox, 'data'), ZCODE_HOME: path.join(sandbox, 'home', '.zcode'), HOME: path.join(sandbox, 'home') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  BASE = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(BASE + 'api/health'); if (r.ok) break; } catch (_e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function cleanup() {
  try { if (server && server.exitCode === null) server.kill('SIGKILL'); } catch (_e) { /* ignore */ }
  try { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

if (/:(3102)\//.test(BASE) && process.env.ZOOM_TEST_ALLOW_PROD !== '1') {
  console.log('FAIL  refusing to run against :' + 3102 + ' (production?)');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, hasTouch: true });
const checks = [];
const check = (n, ok, extra) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  (' + extra + ')' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitComposer(page, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await page.locator('[data-testid="v4-composer-input"]').count()) return true;
    await sleep(500);
  }
  return false;
}
async function sendPrompt(page, text) {
  const ed = page.locator('[data-testid="v4-composer-input"]').first();
  await ed.click();
  await page.keyboard.type(text, { delay: 5 });
  await sleep(600);
  const send = page.locator('[data-testid="v4-composer-send"], [data-testid="chat-send-button"]').first();
  for (let i = 0; i < 10 && (await send.count()) === 0; i++) await sleep(800);
  await send.click();
}

try {
  const pageA = await ctx.newPage();
  pageA.on('pageerror', (e) => console.log('[A pageerror] ' + e.message.slice(0, 160)));
  await pageA.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pageA.keyboard.press('Escape').catch(() => {});
  if (!(await waitComposer(pageA))) { check(false, 'A composer never appeared'); throw new Error('abort'); }
  await pageA.evaluate(() => { window.__zwebui_marker = 'A-LIVE'; });

  // device A sends the long streaming turn
  await sendPrompt(pageA, '请从 1 数到 400，每行输出一个数字，不要输出其他任何内容，不要使用任何工具。');
  // wait until the stream is visibly running
  let streaming = false, prevLen = 0;
  const tStream = Date.now();
  while (Date.now() - tStream < 45000) {
    const len = await pageA.evaluate(() => (document.body.innerText || '').length);
    if (len > prevLen + 200) { streaming = true; break; }
    prevLen = Math.max(prevLen, len);
    await sleep(500);
  }
  check('A: turn streaming', streaming);

  // device B attaches mid-turn
  const pageB = await ctx.newPage();
  pageB.on('pageerror', (e) => console.log('[B pageerror] ' + e.message.slice(0, 160)));
  await pageB.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pageB.keyboard.press('Escape').catch(() => {});
  if (!(await waitComposer(pageB))) { check(false, 'B composer never appeared'); throw new Error('abort'); }
  await pageB.evaluate(() => { window.__zwebui_marker = 'B-LIVE'; });

  const health = await (await fetch(BASE + 'api/health')).json();
  check('B attached: one host, two views', health.sessions.total === 1 && health.sessions.views === 2, JSON.stringify(health.sessions));

  // B sees LIVE progress (body grows while A's turn streams)
  const len1 = await pageB.evaluate(() => (document.body.innerText || '').length);
  await sleep(3000);
  const len2 = await pageB.evaluate(() => (document.body.innerText || '').length);
  check('B sees live progress (transcript growing on B)', len2 > len1, `len ${len1} -> ${len2}`);

  // B sends the next instruction WHILE turn 1 is still streaming (queued)
  await sendPrompt(pageB, '请从 1001 数到 1030，每行输出一个数字，不要输出其他任何内容，不要使用任何工具。');

  // wait for BOTH turns to complete (T1 end marker '400', T2 end marker '1030')
  const t0 = Date.now();
  let done = false, orderOk = false;
  while (Date.now() - t0 < 300000 && !done) {
    const tA = await pageA.evaluate(() => document.body.innerText || '');
    const tB = await pageB.evaluate(() => document.body.innerText || '');
    const t1done = /(^|\n)400(\n|$)/.test(tA) || /(^|\n)400(\n|$)/.test(tB);
    const t2done = /(^|\n)1030(\n|$)/.test(tA) || /(^|\n)1030(\n|$)/.test(tB);
    if (t1done && t2done) {
      const hay = tA.length >= tB.length ? tA : tB;
      const iEnd1 = hay.search(/(^|\n)400(\n|$)/);
      const iStart2 = hay.search(/(^|\n)1001(\n|$)/);
      done = true;
      orderOk = iEnd1 !== -1 && iStart2 !== -1 && iEnd1 < iStart2;
      if (!orderOk) console.log('order debug: iEnd1=' + iEnd1 + ' iStart2=' + iStart2);
    }
    await sleep(1500);
  }
  check('both turns completed (T1 to 400, T2 to 1030)', done);
  check('sequential execution: T1 finished before T2 started (queued, no concurrency)', orderOk);

  const mA = await pageA.evaluate(() => window.__zwebui_marker);
  const mB = await pageB.evaluate(() => window.__zwebui_marker);
  check('no reloads on either device', mA === 'A-LIVE' && mB === 'B-LIVE', `${mA}/${mB}`);
} catch (e) {
  console.log('FAIL  ' + (e && e.message ? e.message : e));
  checks.push(false);
}

cleanup();
await browser.close().catch(() => {});
const failed = checks.filter((c) => !c).length;
console.log(failed === 0 ? 'XDEV-QUEUE OK' : 'XDEV-QUEUE FAILED (' + failed + ')');
process.exit(failed ? 1 : 0);
