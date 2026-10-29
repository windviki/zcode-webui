// Spawn the official in-container zcode host service (zcode-server.cjs) and drive the
// stdio handshake: server prints {"type":"zcode-hello",...} to stdout, we answer with
// {"type":"zcode-hello-ack",...} on stdin, then the stdio pipe carries ZCode Protocol
// channel frames (see frame.mjs).

import { fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VERSION } from './upgrade.mjs';
import { encodeFrame, FrameParser } from './frame.mjs';
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
  const legacy = existsSync(path.join(root, 'zcode-server.cjs'));
  const host16 = existsSync(path.join(root, 'app', 'out', 'host', 'index.js'));
  if (!legacy && !host16) {
    throw new Error('no zcode host runtime found under ' + root +
      ' (expected zcode-server.cjs for <= 3.15 or app/out/host/index.js for >= 3.16;' +
      ' run zcode-webui setup, or set ZCODE_SERVER_RUNTIME_ROOT)');
  }
  return root;
}

// Which host generation lives in this runtime directory. The two generations
// speak different transports, so the LAYOUT — not a version string — decides:
//   <= 3.15  standalone zcode-server.cjs, driven over 13-byte stdio frames
//   >= 3.16  the desktop's own host bundle (app/out/host/index.js), which expects
//            an Electron-style parentPort plus a transferred MessagePort
export function detectRuntimeLayout(serverRoot) {
  const root = resolveServerRoot(serverRoot);
  const host16Entry = path.join(root, 'app', 'out', 'host', 'index.js');
  if (existsSync(host16Entry)) {
    return { kind: 'host16', root, entry: host16Entry, version: readBuildMetaVersion(root) };
  }
  return { kind: 'legacy', root, entry: path.join(root, 'zcode-server.cjs'), version: '' };
}

// app/out/metadata/build-meta.json is the only version stamp a 3.16 install
// carries (there is no `zcode-server.cjs --version` to ask any more).
export function readBuildMetaVersion(serverRoot) {
  try {
    const meta = JSON.parse(readFileSync(path.join(serverRoot, 'app', 'out', 'metadata', 'build-meta.json'), 'utf8'));
    return String(meta.appVersion || '');
  } catch (_e) {
    return '';
  }
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

// ---------------------------------------------------------------------------
// ZCode >= 3.16 host transport
// ---------------------------------------------------------------------------
// The 3.16 desktop forked `out/host/index.js` as an Electron utilityProcess and
// drove it through `process.parentPort` (structured messages) with a MessagePort
// transferred for the renderer channel. src/port-shim.mjs recreates that contract
// under plain Node; this module owns the parent end of it.
//
// Differences from the <= 3.15 path that matter:
//   * control traffic (database-startup-state, structured logs, telemetry) is NOT
//     part of the frame stream any more — it travels as separate objects;
//   * the renderer channel carries RAW payloads (one message per payload); the
//     13-byte frame header is only for stream transports;
//   * the host resolves its agent runtime by walking up from cwd looking for
//     apps/zcode-cli/packages/cli/dist/zcode.cjs, so the install layout provides
//     that path (see installHost16) and the host runs with cwd = runtime root.
const HOST16_PORT_ID = 'renderer-1';
const HOST_VERBOSE = process.env.ZCODE_WEBUI_HOST_VERBOSE === '1';
const PORT_SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'port-shim.mjs');

function createHost16LogSink(log) {
  // The 3.16 host is chatty on stdout/stderr; keep first occurrences and count
  // exact repeats inside a minute (same idea as the legacy stderr relay).
  const seen = new Map();
  const CLIP = 600;
  return (channel, text) => {
    const line = String(text).replace(/\s+$/, '');
    if (!line) return;
    const key = channel + '|' + line.slice(0, 160);
    const now = Date.now();
    const entry = seen.get(key);
    if (entry && now < entry.until) { entry.n++; return; }
    if (entry && entry.n > 0) log('[host16:' + channel + '] … ' + entry.n + ' repeat(s) of: ' + entry.key);
    seen.set(key, { n: 0, until: now + 60000, key: line.slice(0, 120) });
    if (seen.size > 200) {
      for (const k of seen.keys()) { seen.delete(k); if (seen.size <= 100) break; }
    }
    log('[host16:' + channel + '] ' + (line.length > CLIP ? line.slice(0, CLIP) + ' …[clipped]' : line));
  };
}

export function buildHost16Env(serverRoot, extra = {}) {
  const env = {
    ...process.env,
    ZCODE_SERVER_RUNTIME_ROOT: serverRoot,
    ZCODE_ENV: 'production',
    ZCODE_BASE_URL: process.env.ZCODE_BASE_URL || 'https://zcode.z.ai',
    ZAI_OAUTH_ORIGIN: process.env.ZAI_OAUTH_ORIGIN || 'https://chat.z.ai',
    ZAI_BUSINESS_BASE_URL: process.env.ZAI_BUSINESS_BASE_URL || 'https://api.z.ai',
    ZAI_OAUTH_CLIENT_ID: process.env.ZAI_OAUTH_CLIENT_ID || 'client_P8X5CMWmlaRO9gyO-KSqtg',
    ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED: '0',
    ZCODE_APP_VERSION: process.env.ZCODE_APP_VERSION || readBuildMetaVersion(serverRoot) || rendererVersion(DEFAULT_VERSION),
    ZCODE_WEBUI_GUARD_STATS_DIR: path.join(resolveDataHome(PROJECT_ROOT), 'data', 'guard-stats'),
    ...extra,
  };
  // 3.15-era overrides point at the OLD agent binary and, worse, put the host on
  // its "external command" branch which drops supportsStorageStartup — the local
  // startup then dies with preparing_session_storage: unsupported_runtime. The
  // 3.16 host resolves its own agent runtime, so these must not leak in.
  for (const k of ['ZCODE_AGENT_SERVER_COMMAND', 'ZCODE_AGENT_SERVER_ARGS_JSON',
                   'ZCODE_AGENT_SERVER_CWD', 'GLM_BINARY_PATH', 'ZCODE_DESKTOP_AGENT_BYTECODE']) {
    delete env[k];
  }
  // Same guard preloads as the legacy path (they also reach every child the host
  // spawns through the inherited NODE_OPTIONS).
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

// Fork the 3.16 host and wire the control channel + relay port. Resolves once the
// preload is installed (the host itself boots asynchronously and reports progress
// through database-startup-state).
export function createHost16({
  serverRoot, layout, log = console.error.bind(console), extraEnv = {},
  startupId, deviceId = '', locale = 'zh-CN', workspace = '',
}) {
  const root = layout.root;
  const child = fork(layout.entry, [], {
    cwd: root,
    execArgv: ['--import', PORT_SHIM, '--no-warnings'],
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: buildHost16Env(root, extraEnv),
  });

  const pipe = {
    kind: 'host16',
    child,
    root,
    startupId,
    hello: { type: 'zcode-hello', version: layout.version || '' },
    onFrame: null,
    onStartupState: null,
    onControl: null,
    closed: false,
    framesIn: 0,
    framesOut: 0,
    lastStartupState: null,
  };

  const sink = createHost16LogSink(log);
  child.stdout.on('data', (d) => sink('stdout', d.toString()));
  child.stderr.on('data', (d) => sink('stderr', d.toString()));

  child.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.__z === 'ready') { pipe.preloadReady = true; return; }
    if (m.__z === 'pp') {
      const msg = m.msg || {};
      // observed on the wire as both 'database-startup-state' (3.16.x host) and
      // the namespaced form used by the renderer-side channel
      if (msg.type === 'database-startup-state' || msg.type === 'zcode:database-startup-state') {
        pipe.lastStartupState = msg.state || null;
        if (pipe.onStartupState) { try { pipe.onStartupState(pipe.lastStartupState); } catch (_e) { /* ignore */ } }
        return;
      }
      if (msg.type === 'log') {
        // structured host logs: errors/warnings only, the info stream is huge —
        // unless ZCODE_WEBUI_HOST_VERBOSE=1 (used to trace a slow command: the
        // host's own info lines show what it waits on between two RPCs)
        if (msg.level && (msg.level !== 'info' || HOST_VERBOSE)) {
          sink('log', '[' + msg.level + '] ' + String(msg.message || ''));
        }
        return;
      }
      if (pipe.onControl) { try { pipe.onControl(msg); } catch (_e) { /* ignore */ } }
      return;
    }
    if (m.__z === 'port') {
      pipe.framesOut++;
      const buf = Buffer.isBuffer(m.d) ? m.d : Buffer.from(m.d);
      if (pipe.onFrame && !pipe.closed) { try { pipe.onFrame(buf); } catch (_e) { /* ignore */ } }
      return;
    }
    if (m.__z === 'port-close') {
      log('[host16] renderer channel closed by host pid=' + child.pid);
    }
  });

  child.on('exit', (code, signal) => {
    pipe.closed = true;
    if (pipe.onExit) { try { pipe.onExit(code, signal); } catch (_e) { /* ignore */ } }
  });
  child.on('error', (err) => log('[host16] spawn error: ' + err.message));

  pipe.push = (payload) => {
    if (pipe.closed || !child.connected) return false;
    pipe.framesIn++;
    try { child.send({ __z: 'port-in', id: HOST16_PORT_ID, d: payload }); return true; } catch (_e) { return false; }
  };
  pipe.close = () => {
    pipe.closed = true;
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
    }
  };

  // The preload must be listening before init-local is posted; both sides race
  // the spawn, so wait for its 'ready' ping (2 s is plenty — the module is tiny).
  pipe.ready = new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (pipe.preloadReady) { clearInterval(timer); resolve(true); return; }
      if (pipe.closed || Date.now() - started > 2000) { clearInterval(timer); resolve(pipe.preloadReady === true); }
    }, 20);
    timer.unref?.();
  }).then((ok) => {
    if (!ok || pipe.closed) {
      log('[host16] preload did not report ready, sending init-local anyway');
    }
    const builtin = path.join(root, 'config', 'provider', 'zcode-builtin.json');
    const initMsg = {
      type: 'init-local',
      databaseStartupId: startupId,
      deviceMid: deviceId || undefined,
      workspacePath: workspace || undefined,
      agentWarmupTargets: workspace ? [{ workspacePath: workspace }] : undefined,
      agentSpawnFallbackCwd: workspace || process.cwd(),
      locale: locale || undefined,
      runtimeProcessEnvPatch: {},
      ...(existsSync(builtin) ? { zcodeBuiltinProviderConfigFilePath: builtin } : {}),
    };
    try {
      child.send({ __z: 'pp', msg: initMsg, ports: [HOST16_PORT_ID] });
    } catch (err) {
      log('[host16] failed to send init-local: ' + err.message);
    }
    return pipe;
  });

  return pipe;
}

// One entry point for both generations: returns a pipe with a uniform interface
// (child, hello, push, close, onFrame, onStartupState, startupId) so the bridge
// code in server.mjs never has to care which runtime it is talking to.
export async function createHostPipe({
  serverRoot, log = console.error.bind(console), extraEnv = {},
  startupId, deviceId = '', locale = 'zh-CN', workspace = '',
}) {
  const layout = detectRuntimeLayout(serverRoot);
  if (layout.kind === 'host16') {
    const pipe = createHost16({ serverRoot, layout, log, extraEnv, startupId, deviceId, locale, workspace });
    await pipe.ready;
    return pipe;
  }

  const host = spawnHost({ serverRoot: layout.root, log, extraEnv });
  const { child } = host;
  const { hello, rest } = await handshake(child);
  const parser = new FrameParser((payload) => {
    pipe.framesOut++;
    if (pipe.onFrame && !pipe.closed) { try { pipe.onFrame(Buffer.from(payload)); } catch (_e) { /* ignore */ } }
  });
  const pipe = {
    kind: 'legacy',
    child,
    root: layout.root,
    hello,
    startupId: null,
    onFrame: null,
    onStartupState: null,
    onControl: null,
    closed: false,
    framesIn: 0,
    framesOut: 0,
    lastStartupState: null,
    push: (payload) => {
      if (pipe.closed) return false;
      pipe.framesIn++;
      try { child.stdin.write(encodeFrame(payload)); return true; } catch (_e) { return false; }
    },
    close: () => {
      pipe.closed = true;
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
      }
    },
  };
  parser.push(rest);
  child.stdout.on('data', (d) => parser.push(d));
  child.on('exit', (code, signal) => {
    pipe.closed = true;
    if (pipe.onExit) { try { pipe.onExit(code, signal); } catch (_e) { /* ignore */ } }
  });
  return pipe;
}
