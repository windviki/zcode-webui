// Spawn the official in-container zcode host service (zcode-server.cjs) and drive the
// stdio handshake: server prints {"type":"zcode-hello",...} to stdout, we answer with
// {"type":"zcode-hello-ack",...} on stdin, then the stdio pipe carries ZCode Protocol
// channel frames (see frame.mjs).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VERSION } from './upgrade.mjs';
import { resolveDataHome } from './dirs.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Version stamp written by scripts/fetch-renderer.sh, so the host env always matches
// the fetched renderer version without editing code.
export function rendererVersion(fallback = '') {
  try {
    const v = readFileSync(path.join(PROJECT_ROOT, 'vendor', 'renderer', '.version'), 'utf8').trim();
    if (v) return v;
  } catch (_e) { /* ignore */ }
  return fallback;
}

// Official 3.12+ expects the builtin provider catalog next to the CLI entry
// (agents/glm/provider/zcode-builtin.json) — the desktop app ships it there, the
// standalone server runtime does NOT. Without it EVERY `zcode.cjs` invocation that
// matters dies with "无法定位 CLI ZCode Built-in Provider Config": no login
// (`zcode.cjs login`) and no agent turn (the host spawns `zcode.cjs app-server
// --stdio` per session). The host materializes its own copy of the same JSON under
// <dataRoot>/v2/runtime/provider/bundled/zcode-builtin.json when it starts, so once
// the host has run we can hand that content to the CLI. Idempotent: writes only when
// the destination is missing, so a runtime-provided file is never clobbered.
export function ensureCliProviderConfig(serverRoot, { log = () => {} } = {}) {
  try {
    const dest = path.join(serverRoot, 'agents', 'glm', 'provider', 'zcode-builtin.json');
    if (existsSync(dest)) return dest;
    const dataRoot = process.env.ZCODE_HOME
      ? path.join(process.env.ZCODE_HOME, 'v2')
      : path.join(os.homedir(), '.zcode', 'v2');
    const src = path.join(dataRoot, 'runtime', 'provider', 'bundled', 'zcode-builtin.json');
    if (!existsSync(src)) return null;
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest);
    log('[zcode-webui] cli provider config materialized: ' + dest);
    return dest;
  } catch (_e) {
    return null; // never block host startup on this
  }
}

// Default runtime location follows the official data directory convention:
// ZCODE_SERVER_RUNTIME_ROOT > ZCODE_HOME/server > ~/.zcode/server. Honoring
// ZCODE_HOME matters for sandboxing/tests and matches src/login.mjs.
export function resolveServerRoot(override) {
  const fallback = process.env.ZCODE_HOME
    ? path.join(process.env.ZCODE_HOME, 'server')
    : path.join(os.homedir(), '.zcode', 'server');
  const root = (override || process.env.ZCODE_SERVER_RUNTIME_ROOT || fallback).trim();
  if (!existsSync(path.join(root, 'zcode-server.cjs'))) {
    throw new Error('zcode-server.cjs not found under ' + root + ' (run zcode-webui setup to install it, or set ZCODE_SERVER_RUNTIME_ROOT)');
  }
  return root;
}

// Environment for the host service. NOTE: we deliberately do NOT set
// ZCODE_SERVICE_AUTHORITY_MODE=desktop-attached-remote — in that mode the host
// waits for the CLIENT to push a provider registry over the protocol (the desktop
// does that; our renderer does not), which makes every session reject with
// "no usable model provider". Without the mode, the host uses its own local
// registry (credentials + settings + api keys) and syncs it to the client.
export function buildHostEnv(serverRoot, extra = {}) {
  // The official desktop resolves the ZCode agent server through its Electron
  // runtime (process.execPath + agents/glm/zcode.cjs). zcode-webui runs
  // zcode-server.cjs under plain Node, so point the host at the bundled agent
  // entry explicitly — otherwise sessions fail with "ZCode agent server command
  // is not configured". Users may override both env vars.
  const agentCommand = process.env.ZCODE_AGENT_SERVER_COMMAND || path.join(serverRoot, 'node');
  const agentArgsJson = process.env.ZCODE_AGENT_SERVER_COMMAND
    ? process.env.ZCODE_AGENT_SERVER_ARGS_JSON
    : JSON.stringify([path.join(serverRoot, 'agents', 'glm', 'zcode.cjs'), 'app-server', '--stdio']);
  const env = {
    ...process.env,
    ZCODE_SERVER_RUNTIME_ROOT: serverRoot,
    ZCODE_ENV: 'production',
    ZCODE_BASE_URL: process.env.ZCODE_BASE_URL || 'https://zcode.z.ai',
    ZAI_OAUTH_ORIGIN: process.env.ZAI_OAUTH_ORIGIN || 'https://chat.z.ai',
    ZAI_BUSINESS_BASE_URL: process.env.ZAI_BUSINESS_BASE_URL || 'https://api.z.ai',
    ZAI_OAUTH_CLIENT_ID: process.env.ZAI_OAUTH_CLIENT_ID || 'client_P8X5CMWmlaRO9gyO-KSqtg',
    ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED: '0',
    ZCODE_APP_VERSION: process.env.ZCODE_APP_VERSION || rendererVersion(DEFAULT_VERSION),
    ZCODE_AGENT_SERVER_COMMAND: agentCommand,
    ...(process.env.ZCODE_AGENT_SERVER_COMMAND ? {} : { ZCODE_AGENT_SERVER_ARGS_JSON: agentArgsJson }),
    // where the preloaded api-cache-guard reports its stats so the server can
    // surface them in /api/health (same data home the server itself resolves)
    ZCODE_WEBUI_GUARD_STATS_DIR: path.join(resolveDataHome(PROJECT_ROOT), 'data', 'guard-stats'),
    ...extra,
  };
  // Host-process preloads (they also reach every child the host spawns, through the
  // inherited NODE_OPTIONS):
  //   repo-snapshot-guard — kill switch for the vendor's silent workspace-snapshot upload
  //                         (opt out with ZCODE_WEBUI_ALLOW_REPO_SNAPSHOT=1);
  //   api-cache-guard     — coalesces the renderer's plan/quota polling and backs off on
  //                         HTTP 429, which is what made the settings panel show
  //                         "套餐查询失败" (opt out with ZCODE_WEBUI_BILLING_CACHE_TTL_MS=0);
  //   quota-reset-guard   — auto-uses coding-plan reset chances only when they are
  //                         actually needed (pool nearly gone with tasks running, or
  //                         the chance itself about to lapse). OFF by default;
  //                         flipped at runtime from the web panel's ♻ chip
  //                         (POST /api/quota-reset → switch file polled by the
  //                         guard), ZCODE_WEBUI_QUOTA_RESET=on|dry-run is only
  //                         the pre-switch baseline.
  const preload = (file) => {
    const guard = path.join(PROJECT_ROOT, 'src', file);
    if (existsSync(guard) && !String(env.NODE_OPTIONS || '').includes(guard)) {
      env.NODE_OPTIONS = [env.NODE_OPTIONS, '--require=' + guard].filter(Boolean).join(' ');
    }
  };
  if (env.ZCODE_WEBUI_ALLOW_REPO_SNAPSHOT !== '1') preload('repo-snapshot-guard.cjs');
  preload('api-cache-guard.cjs');
  preload('quota-reset-guard.cjs');
  return env;
}

export function spawnHost({ serverRoot, log = console.error.bind(console), extraEnv = {} } = {}) {
  const root = resolveServerRoot(serverRoot);
  const nodeBin = path.join(root, 'node');
  const serverJs = path.join(root, 'zcode-server.cjs');
  const child = spawn(nodeBin, [serverJs], {
    cwd: os.homedir(),
    env: buildHostEnv(root, extraEnv),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderrTail = '';
  // Vendor stderr is chatty and highly repetitive (provider sync loops re-log the
  // same blocks every minute). First occurrences pass through unchanged; exact
  // repeats within a minute are counted and flushed as one summary line. Chunks
  // longer than 4KB (multi-KB revision dumps) are clipped. `stderrTail` keeps the
  // raw stream for exit diagnostics either way.
  const repeats = new Map();          // key (first 200 chars) -> { n, until, seen }
  const REPEAT_WINDOW_MS = 60000;
  const CLIP_BYTES = 4000;
  const flushRepeats = () => {
    const now = Date.now();
    for (const [k, e] of repeats) {
      if (e.n > 0) log('[host:stderr] … suppressed ' + e.n + ' repeat(s): ' + k.replace(/\s+/g, ' ').slice(0, 120));
      if (now >= e.until) repeats.delete(k);
      else e.n = 0;
    }
    if (repeats.size > 128) {          // bound the tracker itself
      for (const k of repeats.keys()) { repeats.delete(k); if (repeats.size <= 64) break; }
    }
  };
  const flushTimer = setInterval(flushRepeats, 30000);
  if (flushTimer.unref) flushTimer.unref();
  child.stderr.on('data', (d) => {
    const text = d.toString();
    stderrTail = (stderrTail + text).slice(-8000);
    const now = Date.now();
    const key = text.slice(0, 200);
    let e = repeats.get(key);
    if (!e || now >= e.until) {
      e = { n: 0, until: now + REPEAT_WINDOW_MS, seen: false };
      repeats.set(key, e);
    }
    if (e.seen) { e.n++; return; }     // repeat inside the window: count only
    e.seen = true;
    log('[host:stderr] ' + (text.length > CLIP_BYTES ? text.slice(0, CLIP_BYTES) + ' …[clipped ' + text.length + 'B]' : text));
  });
  child.on('error', (err) => log('[host] spawn error: ' + err.message));
  child.on('exit', (code, signal) => {
    clearInterval(flushTimer);
    flushRepeats();
    const tail = stderrTail.trim();
    if (tail) log('[host] exited code=' + code + ' signal=' + signal + '\n' + tail.slice(-3000));
    else log('[host] exited code=' + code + ' signal=' + signal);
  });
  return { child, getStderrTail: () => stderrTail, nodeBin, serverJs, root };
}

// Wait for the hello line, answer with hello-ack, then resolve with the leftover bytes.
// On any failure the half-started child is killed so failed handshakes never leave
// orphaned hosts behind.
export function handshake(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { clearTimeout(timeout); child.stdout.removeListener('data', onData); };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { if (child.exitCode === null) child.kill('SIGKILL'); } catch (_e) { /* ignore */ }
      reject(err);
    };
    const timeout = setTimeout(() => fail(new Error('host handshake timeout (no zcode-hello within 10s)')), 10000);
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = buf.subarray(0, nl).toString('utf8').trim();
      const rest = buf.subarray(nl + 1);
      let hello;
      try {
        hello = JSON.parse(line);
      } catch (_e) {
        return fail(new Error('host hello is not valid JSON: ' + line.slice(0, 200)));
      }
      if (!hello || hello.type !== 'zcode-hello') {
        return fail(new Error('unexpected first stdout line: ' + line.slice(0, 200)));
      }
      settled = true;
      cleanup();
      const ack = JSON.stringify({
        type: 'zcode-hello-ack',
        version: String(hello.version || ''),
        clientId: 'zcode-webui-' + randomUUID(),
      }) + '\n';
      try { child.stdin.write(ack); } catch (_e) { /* stdio gone — exit handler will clean up */ }
      resolve({ hello, rest });
    };
    child.stdout.on('data', onData);
  });
}
