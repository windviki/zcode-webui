// Z.ai CLI OAuth login, driven through the official CLI (zcode.cjs login --no-browser).
// The CLI prints the authorize URL on stdout, waits for the callback on its local
// HTTP server, then writes ~/.zcode/v2/credentials.json + ~/.zcode/cli/config.json.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CRED_PATH = () => process.env.ZCODE_HOME
  ? path.join(process.env.ZCODE_HOME, 'v2', 'credentials.json')
  : path.join(os.homedir(), '.zcode', 'v2', 'credentials.json');
const CONFIG_PATH = () => process.env.ZCODE_HOME
  ? path.join(process.env.ZCODE_HOME, 'cli', 'config.json')
  : path.join(os.homedir(), '.zcode', 'cli', 'config.json');

export function credentialsPath() {
  return CRED_PATH();
}

export function loginState() {
  const cred = existsSync(CRED_PATH());
  const cfg = existsSync(CONFIG_PATH());
  let user = null;
  if (cred) {
    try {
      const raw = JSON.parse(readFileSync(CRED_PATH(), 'utf8'));
      if (raw && (raw['oauth:bigmodel:access_token'] || raw['oauth:zai:access_token'] || raw.zaiAccessToken)) user = '(credential present)';
      else if (raw && Object.keys(raw).length > 0) user = '(unknown)';
    } catch (_e) { /* ignore */ }
  }
  return { loggedIn: cred && user !== null, credentialsPath: CRED_PATH(), configPath: CONFIG_PATH(), user };
}

export function startLogin({ serverRoot, oauthProxy = '', log = () => {} } = {}) {
  const nodeBin = path.join(serverRoot, 'node');
  const cliJs = path.join(serverRoot, 'agents', 'glm', 'zcode.cjs');
  const env = {
    ...process.env,
    ZCODE_ENV: 'production',
    ZCODE_BASE_URL: process.env.ZCODE_BASE_URL || 'https://zcode.z.ai',
    ZAI_OAUTH_ORIGIN: process.env.ZAI_OAUTH_ORIGIN || 'https://chat.z.ai',
    ZAI_BUSINESS_BASE_URL: process.env.ZAI_BUSINESS_BASE_URL || 'https://api.z.ai',
    ZAI_OAUTH_CLIENT_ID: process.env.ZAI_OAUTH_CLIENT_ID || 'client_P8X5CMWmlaRO9gyO-KSqtg',
  };
  if (oauthProxy) env.ZCODE_HTTP_PROXY = oauthProxy;
  const child = spawn(nodeBin, [cliJs, 'login', '--no-browser'], {
    cwd: os.homedir(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let url = null;
  child.stdout.on('data', (d) => {
    const text = d.toString();
    out = (out + text).slice(-8000);
    if (!url) {
      const m = text.match(/https:\/\/[^\s"'<>]+/);
      if (m) url = m[0];
    }
    log(text);
  });
  child.stderr.on('data', (d) => {
    out = (out + d.toString()).slice(-8000);
    log(d.toString());
  });
  const state = { child, url: () => url, output: () => out };
  return state;
}

export function stopLogin(state) {
  if (state && state.child && state.child.exitCode === null) {
    state.child.kill('SIGTERM');
  }
}
