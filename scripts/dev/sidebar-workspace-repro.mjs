// Sandbox reproduction of "after each refresh, the FIRST workspace directory
// clicked in the sidebar collapses fine but can never be expanded again, while
// other directories keep toggling normally".
//
// Fully ISOLATED from the production deployment (never touches its hosts,
// sessions or shared setting.json):
//   - private ZCODE_HOME with a COPY of credentials/setting/tasks-index
//     (VACUUM INTO for a consistent sqlite snapshot) and a symlinked real
//     runtime (<sb>/zcode/server -> ~/.zcode/server)
//   - private ZCODE_WEBUI_HOME with a symlinked renderer
//   - random port, NODE_OPTIONS cleared (we usually run INSIDE the production
//     process tree whose guard preloads and runtime overrides leak via env)
//
// Drives the official renderer in headless chromium: restore -> click sequence
// (collapse / expand / repeat / other rows) with per-step row states,
// localStorage expansion map and renderer console/page errors captured.
//
// Usage: node scripts/dev/sidebar-workspace-repro.mjs [--keep]
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- sandbox layout ----
const PROD_ZHOME = '/home/coder/.zcode';            // read-only source of truth
const sb = mkdtempSync('/tmp/zwebui-wsx.');
mkdirSync(path.join(sb, 'zcode/v2'), { recursive: true });
mkdirSync(path.join(sb, 'zcode/cli'), { recursive: true });
mkdirSync(path.join(sb, 'data/vendor'), { recursive: true });
mkdirSync(path.join(sb, 'home'), { recursive: true });

function copyIf(src, dest) { if (existsSync(src)) copyFileSync(src, dest); }
copyIf(path.join(PROD_ZHOME, 'v2/credentials.json'), path.join(sb, 'zcode/v2/credentials.json'));
copyIf(path.join(PROD_ZHOME, 'v2/config.json'), path.join(sb, 'zcode/v2/config.json'));   // device/keys — credential decryption needs it
copyIf(path.join(PROD_ZHOME, 'v2/onboarding-record.json'), path.join(sb, 'zcode/v2/onboarding-record.json'));
copyIf(path.join(PROD_ZHOME, 'v2/provider_config.json'), path.join(sb, 'zcode/v2/provider_config.json'));
copyIf(path.join(PROD_ZHOME, 'v2/coding-plan-cache.json'), path.join(sb, 'zcode/v2/coding-plan-cache.json'));
copyIf(path.join(PROD_ZHOME, 'cli/config.json'), path.join(sb, 'zcode/cli/config.json'));
// consistent snapshot of the task index (the live file has -wal companions)
try {
  const { createRequire } = await import('node:module');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(path.join(PROD_ZHOME, 'v2/tasks-index.sqlite'), { readOnly: true });
  db.prepare('VACUUM INTO ?').run(path.join(sb, 'zcode/v2/tasks-index.sqlite'));
  db.close();
  console.log('[sandbox] tasks-index snapshotted via VACUUM INTO');
} catch (e) {
  console.log('[sandbox] WARN VACUUM INTO failed (' + e.message + '), falling back to raw copy');
  copyIf(path.join(PROD_ZHOME, 'v2/tasks-index.sqlite'), path.join(sb, 'zcode/v2/tasks-index.sqlite'));
}
// sandbox-only workspace with a controlled nested layout (zero contact with the
// user's real projects); WS_REPRO_FULL=1 restores the verbatim production tabs
{
  const raw = JSON.parse(readFileSync(path.join(PROD_ZHOME, 'v2/setting.json'), 'utf8'));
  let ws, activeIdx;
  if (process.env.WS_REPRO_FULL === '1') {
    ws = raw.lastWorkspaceSession.filter((e) => e.kind === 'local').map((e) => e.workspacePath);
    activeIdx = raw.lastActiveTabIndex || 0;
  } else {
    const fake = path.join(sb, 'wsx-ws');
    for (const d of ['', 'alpha', 'beta', 'alpha/one', 'alpha/two', 'beta/deep', 'src']) {
      mkdirSync(path.join(fake, d), { recursive: true });
      writeFileSync(path.join(fake, d, 'note.md'), '# ' + (d || 'root') + '\n');
    }
    ws = [fake];
    activeIdx = 0;
  }
  raw.lastWorkspaceSession = ws.map((p) => ({ kind: 'local', workspacePath: p, workspacePurpose: 'project' }));
  raw.lastActiveTabIndex = activeIdx;
  writeFileSync(path.join(sb, 'zcode/v2/setting.json'), JSON.stringify(raw, null, 1));
  globalThis.WS_LIST = ws;
  globalThis.ACTIVE_WS = ws[Math.min(activeIdx, ws.length - 1)];
}
symlinkSync(path.join(PROD_ZHOME, 'server'), path.join(sb, 'zcode/server'));
symlinkSync(path.join(ROOT, 'vendor/renderer'), path.join(sb, 'data/vendor/renderer'));
// parts of the runtime resolve HOME/.zcode directly (not via ZCODE_HOME), so the
// sandbox HOME must land on the SAME tree — otherwise a fresh empty v2 is
// created there and the renderer gates on a logged-out host
symlinkSync(path.join(sb, 'zcode'), path.join(sb, 'home/.zcode'));

// ---- isolated server ----
const port = 3600 + Math.floor(Math.random() * 300);
const base = 'http://127.0.0.1:' + port + '/';
const server = spawn(process.execPath, [path.join(ROOT, 'src/server.mjs'), '--port', String(port)], {
  env: {
    ...process.env,
    ZCODE_WEBUI_HOME: path.join(sb, 'data'),
    ZCODE_HOME: path.join(sb, 'zcode'),
    ZCODE_SERVER_RUNTIME_ROOT: path.join(sb, 'zcode/server'),
    ZCODE_WEBUI_GUARD_STATS_DIR: path.join(sb, 'data/guard-stats'),
    NODE_OPTIONS: '',
    HOME: path.join(sb, 'home'),           // the host cwd; real HOME stays reachable via paths
    ZCODE_AGENT_SERVER_COMMAND: '',
    ZCODE_AGENT_SERVER_ARGS_JSON: '',
    // credentials.json is AES-GCM encrypted with a key derived from
    // platform:homedir:username — pin the PRODUCTION secret so the copied
    // credential decrypts (the sandbox HOME would otherwise derive another key)
    ZCODE_CREDENTIAL_SECRET: process.env.ZCODE_CREDENTIAL_SECRET || 'zcode-credential-fallback:linux:/home/coder:coder',
    ZCODE_WEBUI_WORKSPACE: globalThis.WS_LIST[0],
    ...(process.env.WS_REPRO_RPC === '1' ? { ZCODE_WEBUI_DEBUG_RPC: '1' } : {}),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const rpcLogFile = '/tmp/zwebui-wsx-rpc.log';
const rpcLog = (await import('node:fs')).createWriteStream(rpcLogFile, { flags: 'w' });
server.stderr.on('data', (d) => {
  for (const l of d.toString().split('\n')) {
    const t = l.trim();
    if (!t) continue;
    if (/^\[rpc\]/.test(t)) { rpcLog.write(t + '\n'); continue; }
    if (/sidebar|repro|ERROR|error/i.test(t)) console.log('[server] ' + t.slice(0, 220));
  }
});
function cleanup() {
  try { if (server.exitCode === null) server.kill('SIGKILL'); } catch (_e) { /* ignore */ }
  if (!KEEP) { try { rmSync(sb, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  else console.log('[sandbox] kept at ' + sb);
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

let up = false;
for (let i = 0; i < 90; i++) {
  try { const r = await fetch(base + 'api/health'); if (r.ok) { up = true; break; } } catch (_e) { /* retry */ }
  await sleep(300);
}
if (!up) { console.log('FAIL  sandbox server did not come up'); process.exit(1); }
console.log('[sandbox] server up at ' + base);

// ---- browser ----
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const conlog = [];
const VERBOSE = process.env.WS_REPRO_VERBOSE === '1';
page.on('console', (m) => {
  const t = m.text();
  if (VERBOSE || /\[Root\]|\[useTabPersistence\]|\[WorkspaceSidebar|error|Error|unavailab|恢复|expand/i.test(t)) conlog.push(t.slice(0, 300));
});
page.on('pageerror', (e) => conlog.push('[pageerror] ' + e.message.slice(0, 400)));
page.on('requestfailed', (r) => conlog.push('[net-fail] ' + r.url().slice(-80) + ' ' + (r.failure() || {}).errorText));

const EXPANSION_KEY = 'zcode-workspace-expansion';
async function rows() {
  const out = await page.evaluate((names) => {
    const res = [];
    const dbg = [];
    // the sidebar workspace-group trigger renders as a DIV[aria-expanded]
    // (Radix CollapsibleTrigger asChild), not a <button>; the composer's
    // workspace chip and other dropdowns are excluded by container
    for (const b of document.querySelectorAll('[aria-expanded]')) {
      if (b.closest('.chat-composer-input-surface,[data-radix-popper-content-wrapper],[role=menu]')) continue;
      const txt = (b.innerText || '').replace(/\s+/g, ' ').trim();
      const base = (n) => n.split('/').pop();
      const hit = names.find((n) => txt === base(n) || txt.startsWith(base(n) + ' '))
        || names.find((n) => txt.startsWith(base(n)) || txt.includes(n));
      if (!hit) continue;
      const r = b.getBoundingClientRect();
      dbg.push({ tag: b.tagName, txt: txt.slice(0, 30), ae: b.getAttribute('aria-expanded'), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) });
      if (!b.closest('[data-state]')) continue;         // needs a collapsible wrapper to be a group row
      res.push({ name: hit, label: txt.slice(0, 40), expanded: b.getAttribute('aria-expanded') === 'true', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    }
    return { res, dbg };
  }, globalThis.WS_LIST);
  if (out.res.length === 0) console.log('[rows-debug] candidates: ' + JSON.stringify(out.dbg));
  return out.res;
}
async function snapshot(tag) {
  const rs = await rows();
  const ls = await page.evaluate((k) => localStorage.getItem(k), EXPANSION_KEY);
  console.log('[' + tag + '] ' + rs.map((r) => r.label.split(' ')[0] + '=' + (r.expanded ? 'open' : 'CLOSED')).join('  ')
    + '   ls=' + (ls === null ? 'null' : ls));
  return rs;
}

async function bootAndSettle() {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForFunction(() => !!document.querySelector('[data-workspace-sidebar-panel]'), null, { timeout: 90000 });
  } catch (e) {
    const diag = await page.evaluate(() => ({
      title: document.title,
      rootChildren: (document.getElementById('root') || {}).childElementCount,
      banner: (document.getElementById('zcode-webui-error') || {}).textContent || null,
      bodyText: (document.body.innerText || '').slice(0, 300),
    })).catch((e2) => ({ evalFailed: String(e2) }));
    console.log('[boot-failed] ' + JSON.stringify(diag, null, 1));
    await page.screenshot({ path: '/tmp/zwebui-wsx-boot.png' }).catch(() => {});
    throw e;
  }
  await sleep(7000);   // tab restore (active-first) + deferred inactive restore + task lists
}

// ---- file-tree exploration (v0.8.2 class: folder expand wedges on `loading` dedup) ----
async function treeRows() {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[role="treeitem"], [data-file-tree-row], [data-workspace-file-tree-row]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      const exp = el.getAttribute('aria-expanded');
      out.push({
        label: (el.textContent || '').trim().slice(0, 30), expanded: exp, kind: exp === null ? 'file' : 'dir',
        x: Math.round(r.left + Math.min(r.width / 2, 30)), y: Math.round(r.top + r.height / 2),
      });
    }
    return out.slice(0, 25);
  });
}
async function openFileTree() {
  // the workspace row's file action is hover-mounted; label: 查看文件 / Show files
  const rs = await rows();
  const row = rs[0];
  if (row) {
    await page.mouse.move(row.x, row.y);
    await sleep(600);
  }
  const opened = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button,[role=button]')];
    const b = btns.find((x) => {
      const t = ((x.getAttribute('aria-label') || '') + ' ' + (x.title || '') + ' ' + (x.textContent || '')).toLowerCase();
      return /查看文件|show files|showfile/.test(t);
    });
    if (!b) return false;
    b.click();
    return true;
  });
  await sleep(2000);
  return opened;
}

async function clickRow(name, tag) {
  const rs = await rows();
  const row = rs.find((r) => r.name === name);
  if (!row) { console.log('[' + tag + '] row not found for ' + name); return; }
  if (row.y > 820 || row.y < 80) {            // virtualized list: off-screen groups are not in the DOM
    await page.evaluate((y) => {
      const scroller = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 40 && d.clientHeight > 200 && d.getBoundingClientRect().right < 360);
      if (scroller) scroller.scrollTop += y - 400;
    }, row.y).catch(() => {});
    await sleep(400);
    const rs2 = await rows();
    const row2 = rs2.find((r) => r.name === name);
    if (!row2) { console.log('[' + tag + '] row scrolled out after adjust'); return; }
    Object.assign(row, row2);
  }
  await page.mouse.click(row.x, row.y);
  await sleep(1200);
}

try {
  await bootAndSettle();
  await snapshot('boot');

  // ================= file-tree wedge hunt (v0.8.2 class regression) =================
  // simulate a RUNNING session writing files (the production differentiator: the
  // user has live agent turns churning the workspace → file-watcher events race
  // in-flight readdir requests → `loading` dedup can wedge a directory forever)
  const churnTarget = path.join(globalThis.ACTIVE_WS, 'alpha');   // sandbox workspace only
  mkdirSync(churnTarget, { recursive: true });
  globalThis.WSX_CHURN = true;
  const churn = spawn('/bin/sh', ['-c', 'i=0; while [ "$WSX_CHURN_FILE" = "on" ]; do i=$((i+1)); echo "$i $(date +%s%N)" > "$WSX_CHURN_DIR/f$i.log" 2>/dev/null; echo x >> "$WSX_CHURN_DIR/heartbeat.log" 2>/dev/null; sleep 0.15; done'], {
    env: { ...process.env, WSX_CHURN_DIR: churnTarget, WSX_CHURN_FILE: 'on' },
    stdio: 'ignore',
  });
  globalThis.WSX_CHURN_PROC = churn;

  const treeOpen = await openFileTree();
  console.log('[file-tree] opened: ' + treeOpen);
  let trs = await treeRows();
  console.log('[file-tree] rows: ' + JSON.stringify(trs.slice(0, 8)));
  if (treeOpen && trs.filter((r) => r.kind === 'dir').length >= 2) {
    const dirs = trs.filter((r) => r.kind === 'dir');
    const D1 = dirs[0], D2 = dirs[1];
    for (const [tag, d] of [['D1-first', D1], ['D1-again', null], ['D2', D2], ['D1-third', null]]) {
      let row = d;
      if (!row) {
        const cur = (await treeRows()).find((r) => r.label === (tag.includes('D1') ? D1.label : D2.label) && r.kind === 'dir');
        if (!cur) { console.log('[' + tag + '] row gone'); continue; }
        row = cur;
      }
      await page.mouse.click(row.x, row.y);
      await sleep(1400);
      const after = (await treeRows()).find((r) => r.label === row.label && r.kind === 'dir');
      console.log('[file-tree ' + tag + '] ' + row.label + ' → expanded=' + (after ? after.expanded : 'GONE'));
    }
  }

  // ================= workspace group rows under the same churn =================
  const A = globalThis.ACTIVE_WS;    // the workspace the user sits in — natural first click
  const B = globalThis.WS_LIST[0];   // the top group in the sidebar

  await clickRow(A, 'click1-collapse');
  await snapshot('after collapse A');
  await clickRow(A, 'click2-expand');
  const s2 = await snapshot('after expand A  <-- bug shows here if still CLOSED');
  await clickRow(A, 'click3-expand-retry');
  await snapshot('after retry A');

  await clickRow(B, 'click4-B-collapse');
  await snapshot('after collapse B');
  await clickRow(B, 'click5-B-expand');
  await snapshot('after expand B');

  // reload flow: clear persisted expansion so every group starts open, then the
  // FIRST click of the fresh page lands on A again
  await page.evaluate((k) => localStorage.removeItem(k), EXPANSION_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.querySelector('[data-workspace-sidebar-panel]'), null, { timeout: 90000 });
  await sleep(7000);
  await snapshot('reload-boot');
  await clickRow(A, 'r1-collapse');
  await snapshot('reload after collapse A');
  await clickRow(A, 'r2-expand');
  await snapshot('reload after expand A  <-- first-clicked-after-refresh case');
} catch (e) {
  console.log('FAIL  ' + (e && e.message ? e.message : e));
}

console.log('---- renderer console (filtered) ----');
for (const l of conlog.slice(-60)) console.log('  ' + l);

try { globalThis.WSX_CHURN_PROC.kill('SIGKILL'); } catch (_e) { /* ignore */ }
try { rmSync(churnTarget, { recursive: true, force: true }); } catch (_e) { /* best effort in user's real dir */ }
await browser.close();
cleanup();
process.exit(0);
