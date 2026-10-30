// ws → HTTP-relay mid-session switch (browser, sandboxed with the real runtime):
//
//   The page boots over ws, then every ws upgrade keeps failing (proxy hiccup) so
//   bootstrap.js falls back to the HTTP long-poll relay. The relay must ATTACH TO
//   THE SAME HOST: the page already did the renderer's one-shot conversation
//   handshake (helloConversationV4 / initializeConversationV4), and a host that
//   never received it answers every zcode-agent.* call with
//   `fault.connection.handshakeRequired` — which is what made the composer's send
//   button silently do nothing after such a switch (2026-10-30).
//
// Usage: node scripts/dev/relay-adopt-test.mjs [baseURL]
// Without a baseURL it spawns its own sandboxed server (isolated HOME /
// ZCODE_HOME / data-home, private port, synthetic credentials).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let BASE = null, sandbox = null, server = null, logPath = null;

if (process.argv[2] || process.env.ZCODE_WEBUI_TEST_URL) {
  BASE = (process.argv[2] || process.env.ZCODE_WEBUI_TEST_URL).replace(/\/?$/, '/');
  logPath = process.env.ZCODE_WEBUI_LOG || path.join(ROOT, 'zcode-webui.log');
} else {
  sandbox = mkdtempSync('/tmp/zwebui-relayadopt.XXXXXX');
  for (const d of ['home', 'zcode/v2', 'data/vendor']) mkdirSync(path.join(sandbox, d), { recursive: true });
  cpSync(path.join(os.homedir(), '.zcode/server'), path.join(sandbox, 'zcode/server'), { recursive: true });
  cpSync(path.join(ROOT, 'vendor/renderer'), path.join(sandbox, 'data/vendor/renderer'), { recursive: true });
  writeFileSync(path.join(sandbox, 'zcode/v2/credentials.json'),
    JSON.stringify({ 'oauth:bigmodel:access_token': 't', 'oauth:bigmodel:user_info': '{"id":"relayadopt"}' }));
  const port = 3300 + Math.floor(Math.random() * 300);
  server = spawn(process.execPath, [path.join(ROOT, 'src/server.mjs'), '--port', String(port)], {
    env: {
      ...process.env,
      ZCODE_WEBUI_HOME: path.join(sandbox, 'data'),
      ZCODE_HOME: path.join(sandbox, 'zcode'),
      HOME: path.join(sandbox, 'home'),
      // the sandbox must run its own runtime copy, never the production one
      ZCODE_SERVER_RUNTIME_ROOT: path.join(sandbox, 'zcode/server'),
      NODE_OPTIONS: '',
      ZCODE_WEBUI_DETACHED_TTL_MS: '600000',
      ZCODE_WEBUI_REAP_INTERVAL_MS: '1000',
      ZCODE_WEBUI_PRESENCE_LEASE_MS: '600000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.logLines = [];
  server.stderr.on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) server.logLines.push(l); });
  BASE = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + 'api/health'); if (r.ok) break; } catch (_e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function cleanup() {
  try { if (server && server.exitCode === null) server.kill('SIGKILL'); } catch (_e) { /* ignore */ }
  if (process.env.RELAY_TEST_DEBUG === '1') {
    try {
      const txt = server ? server.logLines.join('\n') : logText();
      writeFileSync('/tmp/relay-adopt-debug.log', txt);
      console.log('DEBUG log written to /tmp/relay-adopt-debug.log');
    } catch (_e) { /* ignore */ }
    return;                                    // keep the sandbox for inspection
  }
  try { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
if (/:3102\//.test(BASE) && process.env.ZOOM_TEST_ALLOW_PROD !== '1') {
  console.log('FAIL  refusing to run against :3102 (production?) — set ZOOM_TEST_ALLOW_PROD=1 to override');
  process.exit(1);
}

// server log: either the sandbox's stderr relay or the deployment's log file
let logOff = 0;
function logText() {
  if (server) return server.logLines.join('\n');
  try {
    const buf = readFileSync(logPath);
    return buf.subarray(Math.min(logOff, buf.length)).toString('utf8');
  } catch (_e) { return ''; }
}
try { if (!server && logPath) logOff = readFileSync(logPath).length; } catch (_e) { /* ignore */ }

const checks = [];
const check = (n, ok, extra) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  (' + extra + ')' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));
const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text().slice(0, 200)));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(14000);                      // renderer boot over ws
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => { window.__relayadopt_marker = 'LIVE'; });

  const healthBoot = await (await fetch(BASE + 'api/health')).json();
  const hostPids = (txt) => [...new Set([...txt.matchAll(/(?:host spawned pid=|http session opened [^\n]*pid=)(\d+)/g)].map((m) => m[1]))];
  const pidsBefore = hostPids(logText());
  check('ws page booted against one host', healthBoot.sessions.total === 1 && pidsBefore.length === 1,
    JSON.stringify(healthBoot.sessions) + ' pids=' + pidsBefore.join(','));
  if (!/helloConversationV4 OK/.test(logText())) {
    console.log('INFO  sandbox renderer did not open a conversation (no tasks), so the conversation handshake never fired here — the adoption check below is the real signal');
  }

  // 1) every NEW websocket fails to open; drop the live one → hot-retry ladder
  //    → after 5 failed opens bootstrap switches to the HTTP relay
  await page.evaluate(() => {
    let i = 0;
    function Failing(url) {
      const self = this;
      this.readyState = 0; this.url = url; this.binaryType = 'arraybuffer';
      this.close = function () { self.readyState = 3; if (self.onclose) self.onclose({ code: 1006 }); };
      this.send = function () {};
      this.addEventListener = function () {}; this.removeEventListener = function () {};
      setTimeout(function () {
        self.readyState = 3;                              // a failed upgrade ends CLOSED
        if (self.onclose) self.onclose({ code: 1006 });
        if (self.onerror) self.onerror({});
      }, 20 + (i++) * 5);
    }
    Failing.CONNECTING = 0; Failing.OPEN = 1; Failing.CLOSING = 2; Failing.CLOSED = 3;
    window.WebSocket = Failing;
  });
  await page.evaluate(() => { if (window.__zwebui_wsDrop) window.__zwebui_wsDrop(); });

  let switched = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (consoleLines.some((l) => l.indexOf('switching to http polling bridge') >= 0)) { switched = i + 1; break; }
  }
  check('page fell back to the HTTP relay transport', switched > 0, switched ? switched + 's' : 'never');
  await sleep(3000);

  const tail = logText();
  check('relay ADOPTED the running host (no second host)', /http session opened [^\n]*\(adopted\)/.test(tail));
  const pidsAfter = hostPids(tail);
  check('relay talks to the SAME host pid as the ws page', pidsAfter.length === 1 && pidsAfter[0] === pidsBefore[0],
    'before=' + pidsBefore.join(',') + ' after=' + pidsAfter.join(','));
  check('no handshakeRequired failure after the switch', !/fault\.connection\.handshakeRequired/.test(tail));
  const healthSwap = await (await fetch(BASE + 'api/health')).json();
  check('still exactly one host for the account', healthSwap.sessions.total === 1, JSON.stringify(healthSwap.sessions));
  check('relay counted as a view of that host', healthSwap.httpRelays >= 1 && healthSwap.sessions.views >= 1,
    JSON.stringify({ relays: healthSwap.httpRelays, sessions: healthSwap.sessions }));

  // 2) the switch must not reboot the page: the renderer stays mounted and keeps
  //    a live frame stream over the relay
  const marker = await page.evaluate(() => window.__relayadopt_marker || 'GONE');
  check('NO page reload during the transport switch', marker === 'LIVE', 'marker=' + marker);
  const mounted = await page.evaluate(() => {
    const root = document.getElementById('root');
    return !!(root && root.children.length > 0);
  });
  check('official UI still mounted after the switch', mounted);
} catch (e) {
  console.log('FAIL  ' + (e && e.message ? e.message : e));
  checks.push(false);
}

await browser.close();
const failed = checks.filter((c) => !c).length;
console.log(failed === 0 ? 'RELAY-ADOPT OK' : 'RELAY-ADOPT FAILED (' + failed + ')');
process.exit(failed ? 1 : 0);
