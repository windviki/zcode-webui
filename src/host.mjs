// Spawn the official in-container zcode host service (zcode-server.cjs) and drive the
// stdio handshake: server prints {"type":"zcode-hello",...} to stdout, we answer with
// {"type":"zcode-hello-ack",...} on stdin, then the stdio pipe carries ZCode Protocol
// channel frames (see frame.mjs).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function resolveServerRoot(override) {
  const root = (override || process.env.ZCODE_SERVER_RUNTIME_ROOT || path.join(os.homedir(), '.zcode', 'server')).trim();
  if (!existsSync(path.join(root, 'zcode-server.cjs'))) {
    throw new Error('zcode-server.cjs not found under ' + root + ' (run the ZCode desktop remote connect once, or set ZCODE_SERVER_RUNTIME_ROOT)');
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
  return {
    ...process.env,
    ZCODE_SERVER_RUNTIME_ROOT: serverRoot,
    ZCODE_ENV: 'production',
    ZCODE_BASE_URL: process.env.ZCODE_BASE_URL || 'https://zcode.z.ai',
    ZAI_OAUTH_ORIGIN: process.env.ZAI_OAUTH_ORIGIN || 'https://chat.z.ai',
    ZAI_BUSINESS_BASE_URL: process.env.ZAI_BUSINESS_BASE_URL || 'https://api.z.ai',
    ZAI_OAUTH_CLIENT_ID: process.env.ZAI_OAUTH_CLIENT_ID || 'client_P8X5CMWmlaRO9gyO-KSqtg',
    ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED: '0',
    ZCODE_APP_VERSION: process.env.ZCODE_APP_VERSION || rendererVersion('3.8.1'),
    ...extra,
  };
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
  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-8000);
    log('[host:stderr] ' + d.toString());
  });
  child.on('error', (err) => log('[host] spawn error: ' + err.message));
  child.on('exit', (code, signal) => {
    const tail = stderrTail.trim();
    if (tail) log('[host] exited code=' + code + ' signal=' + signal + '\n' + tail.slice(-3000));
    else log('[host] exited code=' + code + ' signal=' + signal);
  });
  return { child, getStderrTail: () => stderrTail, nodeBin, serverJs, root };
}

// Wait for the hello line, answer with hello-ack, then resolve with the leftover bytes.
export function handshake(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('host handshake timeout (no zcode-hello within 10s)')), 10000);
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
        clearTimeout(timeout);
        child.stdout.removeListener('data', onData);
        reject(new Error('host hello is not valid JSON: ' + line.slice(0, 200)));
        return;
      }
      if (!hello || hello.type !== 'zcode-hello') {
        clearTimeout(timeout);
        child.stdout.removeListener('data', onData);
        reject(new Error('unexpected first stdout line: ' + line.slice(0, 200)));
        return;
      }
      const ack = JSON.stringify({
        type: 'zcode-hello-ack',
        version: String(hello.version || ''),
        clientId: 'zcode-webui-' + randomUUID(),
      }) + '\n';
      child.stdin.write(ack);
      clearTimeout(timeout);
      child.stdout.removeListener('data', onData);
      resolve({ hello, rest });
    };
    child.stdout.on('data', onData);
  });
}
