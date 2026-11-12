// Unit tests for src/login-env.mjs — the login-shell env seed that gives zcode
// tool shells the variables/PATH the official CLI's shell snapshot does not carry.
//
// Usage: node scripts/dev/login-env-test.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureLoginShellEnv, loginShellEnvSeed } from '../../src/login-env.mjs';

let checks = 0;
let bad = 0;
function check(name, condition, detail = '') {
  checks++;
  if (condition) return;
  bad++;
  console.error('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

const home = mkdtempSync(path.join(os.tmpdir(), 'zcode-login-env-test-'));
const fakeBin = path.join(home, 'fakebin');
mkdirSync(fakeBin, { recursive: true });
writeFileSync(path.join(home, '.bashrc'), [
  'export ZCODE_LOGIN_ENV_TEST=from-rc',
  'export ZCODE_LOGIN_ENV_SHELL_PATH="$HOME/fakebin"',
  'export PATH="$HOME/fakebin:$PATH"',
  '',
].join('\n'));

const env = {
  ...process.env,
  HOME: home,
  SHELL: '/bin/bash',
};

try {
  // 1. capture: variables and PATH come from the rc file, shell internals do not.
  const captured = captureLoginShellEnv({ env, home });
  check('capture resolves a shell', Boolean(captured.shell), captured.error);
  check('capture reads rc export', captured.vars.ZCODE_LOGIN_ENV_TEST === 'from-rc', String(captured.vars.ZCODE_LOGIN_ENV_TEST));
  check('capture expands $HOME', captured.vars.ZCODE_LOGIN_ENV_SHELL_PATH === fakeBin, String(captured.vars.ZCODE_LOGIN_ENV_SHELL_PATH));
  check('capture prepends rc PATH', String(captured.vars.PATH).startsWith(fakeBin + path.delimiter), String(captured.vars.PATH).slice(0, 80));
  for (const key of ['PWD', 'OLDPWD', 'SHLVL', '_', 'SHELL']) {
    check('capture skips ' + key, !(key in captured.vars));
  }

  // 2. seed: does not override variables the host already has, but PATH wins
  //    (the point of the seed is the rc-prepended toolchain directories).
  const seeded = loginShellEnvSeed({ env: { ...env, ZCODE_LOGIN_ENV_TEST: 'host-value' }, home });
  check('seed keeps host variable', seeded.seed.ZCODE_LOGIN_ENV_TEST === undefined);
  check('seed replaces PATH', String(seeded.seed.PATH).startsWith(fakeBin + path.delimiter));
  check('seed carries new variable', seeded.seed.ZCODE_LOGIN_ENV_SHELL_PATH === fakeBin);

  // 3. opt-out.
  const disabled = loginShellEnvSeed({ env: { ...env, ZCODE_WEBUI_LOGIN_ENV: '0' }, home });
  check('opt-out seeds nothing', Object.keys(disabled.seed).length === 0);
  check('opt-out is reported', /disabled/.test(disabled.error));

  // 4. no rc file → clean failure, no partial seed.
  const emptyHome = mkdtempSync(path.join(os.tmpdir(), 'zcode-login-env-empty-'));
  try {
    const missing = captureLoginShellEnv({ env: { ...env, HOME: emptyHome }, home: emptyHome });
    check('missing rc reports error', /no rc file/.test(missing.error), missing.error);
    check('missing rc seeds nothing', Object.keys(missing.vars).length === 0);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }

  // 5. a failed/timed-out capture must not seed partial output.
  const failed = captureLoginShellEnv({
    env,
    home,
    exec: () => { throw new Error('synthetic-timeout'); },
  });
  check('failed capture reports error', /synthetic-timeout/.test(failed.error), failed.error);
  check('failed capture seeds nothing', Object.keys(failed.vars).length === 0);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(bad === 0
  ? 'ok ' + checks + ' checks passed'
  : bad + '/' + checks + ' checks failed');
process.exit(bad === 0 ? 0 : 1);
