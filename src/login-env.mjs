// Seed the zcode host environment from the user's login shell.
//
// Why this exists: the official CLI does not run tool commands with the user's
// login environment. It builds a one-shot "shell snapshot" (functions, aliases,
// shell options and PATH, captured from ~/.bashrc / ~/.zshrc) and then every
// command runs in a shell that only sources that snapshot. Exported variables are
// NOT part of the snapshot (shell-init-snapshot.ts only writes `export PATH=…`),
// so when zcode-webui — a daemon, not a terminal — spawns the host, whatever is
// missing from the host env is also missing in every tool shell.
//
// Symptoms that came from that gap (2026-11-12):
//   * GVM overrides `cd` with an auto-switch function; replayed without GVM_ROOT
//     it aborted every `cd … && …` chain with "GVM_ROOT not set" (and, when
//     GVM_ROOT did leak in, every cd printed gvm `_encode` helper errors).
//   * ~/.cargo/bin, ~/.gvm/bin and sdkman dirs are prepended to PATH by the rc
//     files, so zcode sessions could not run cargo/go at all.
//
// The fix has two halves: this module restores the variables/PATH (so tool shells
// see what a terminal sees), and the user's rc files stop gvm from installing its
// cd() hook in non-interactive shells (the snapshot dialect drops gvm's private
// `_encode`/`_decode` helpers, so that hook can never work there). See AGENTS.md
// "GVM_ROOT 报错" for the full write-up.
//
// Opt out with ZCODE_WEBUI_LOGIN_ENV=0. The capture is memoized by the caller.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shell-internal / volatile variables that must never be copied from a one-shot
// capture shell into a long-lived daemon.
const SKIPPED_ENV_KEYS = new Set([
  '_', 'PWD', 'OLDPWD', 'SHLVL', 'RANDOM', 'SECONDS', 'LINENO', 'IFS', 'OPTIND',
  'PPID', 'UID', 'EUID', 'GID', 'EGID', 'FUNCNEST',
  'BASHOPTS', 'SHELLOPTS', 'BASH_VERSINFO', 'BASH_VERSION',
  'ZSH_VERSION', 'ZSH_NAME', 'ZSH_SUBSHELL', 'ZSH_EVAL_CONTEXT',
  'ZSH_EXECUTION_STRING', 'ZSH_ARGZERO', 'ZSH_SCRIPT', 'ZSH_PATCHLEVEL',
  // SHELL decides which dialect zcode snapshots (bash when it says bash, zsh
  // otherwise). Seeding it would silently switch the dialect away from the one
  // this capture mirrored, so leave the host's own value alone.
  'SHELL',
]);

function isExecutable(file) {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch (_e) {
    return false;
  }
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

// Mirror the CLI's own choice (apps/zcode-cli/packages/adapters/src/exec/
// bash-shell-provider.ts preferredPosixShellKinds): bash first only when SHELL
// names bash, otherwise zsh first and bash as the fallback.
export function resolveSnapshotShell(env = process.env) {
  const shellName = env.SHELL ? path.basename(env.SHELL) : '';
  const kinds = shellName.includes('bash') ? ['bash', 'zsh'] : ['zsh', 'bash'];
  const dirs = [];
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir) dirs.push(dir);
  }
  dirs.push('/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin');
  const uniqueDirs = [...new Set(dirs)];
  for (const kind of kinds) {
    for (const dir of uniqueDirs) {
      const candidate = path.join(dir, kind);
      if (isExecutable(candidate)) return { kind, path: candidate };
    }
  }
  return null;
}

function configPathFor(kind, home) {
  if (kind === 'zsh') return path.join(home, '.zshrc');
  if (kind === 'bash') return path.join(home, '.bashrc');
  return path.join(home, '.profile');
}

function parseEnvDump(raw) {
  const vars = {};
  // `env -0` (GNU coreutils) keeps values with newlines intact; BSD/macOS env has
  // no -0, so the capture script falls back to newline-separated output.
  const parts = raw.includes('\0') ? raw.split('\0') : raw.split('\n');
  for (const item of parts) {
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    const key = item.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (SKIPPED_ENV_KEYS.has(key)) continue;
    vars[key] = item.slice(eq + 1);
  }
  return vars;
}

// Run the same shell zcode would snapshot and let it source its rc file once, then
// dump `env -0` into a temp file (rc chatter goes to /dev/null and is never parsed).
// Returns { vars, shell, error }; never throws.
export function captureLoginShellEnv({
  env = process.env,
  home = env.HOME || os.homedir(),
  timeoutMs = 5000,
  exec = execFileSync,
} = {}) {
  const shell = resolveSnapshotShell(env);
  if (!shell) return { vars: {}, shell: '', error: 'no zsh/bash found' };
  const config = configPathFor(shell.kind, home);
  if (!existsSync(config)) return { vars: {}, shell: shell.path, error: 'no rc file (' + config + ')' };

  const tmpFile = path.join(os.tmpdir(), 'zcode-login-env-' + process.pid + '-' + randomUUID() + '.bin');
  const script = [
    'if [ -f ' + shellQuote(config) + ' ]; then . ' + shellQuote(config) + ' >/dev/null 2>&1; fi',
    'command -p env -0 > ' + shellQuote(tmpFile) + ' 2>/dev/null || command -p env > ' + shellQuote(tmpFile),
    'exit 0',
  ].join('\n');

  let error = '';
  try {
    exec(shell.path, ['-c', '-l', script], {
      encoding: 'utf8',
      env,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch (err) {
    // A timed-out or failed capture may have written a partial environment (for
    // example half of PATH) — never seed from it.
    error = err && err.message ? String(err.message) : 'login shell failed';
  }

  let vars = {};
  try {
    if (!error) vars = parseEnvDump(readFileSync(tmpFile, 'utf8'));
  } catch (err) {
    if (!error) error = err && err.message ? String(err.message) : 'env dump unreadable';
  } finally {
    try { unlinkSync(tmpFile); } catch (_e) { /* ignore */ }
  }

  return { vars, shell: shell.path, error };
}

// Variables to merge into the host env: only keys the host does not already have,
// plus PATH (rc files prepend toolchain dirs; that is the whole point of the seed).
export function loginShellEnvSeed({ env = process.env, ...opts } = {}) {
  if (env.ZCODE_WEBUI_LOGIN_ENV === '0') {
    return { vars: {}, seed: {}, shell: '', error: 'disabled by ZCODE_WEBUI_LOGIN_ENV=0' };
  }
  const captured = captureLoginShellEnv({ env, ...opts });
  const seed = {};
  for (const [key, value] of Object.entries(captured.vars)) {
    if (!(key in env)) seed[key] = value;
  }
  if (captured.vars.PATH) seed.PATH = captured.vars.PATH;
  return { ...captured, seed };
}
