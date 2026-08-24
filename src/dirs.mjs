// Shared path resolution for the zcode-webui package and CLI.
//
// The package directory (where src/ and web/ live) is read-only when installed
// from npm, so all mutable state — config.json, the downloaded official renderer
// and the device id — lives in a separate data home:
//
//   1. $ZCODE_WEBUI_HOME when set (explicit override)
//   2. the package directory itself when it looks like a git checkout
//      (config.json or vendor/renderer exists next to the package) — backward
//      compatible with the clone-and-run deployment
//   3. ~/.zcode-webui otherwise (installed package)

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveDataHome(packageRoot) {
  const env = (process.env.ZCODE_WEBUI_HOME || '').trim();
  if (env) return path.resolve(env);
  const local = path.resolve(packageRoot);
  if (
    existsSync(path.join(local, 'config.json')) ||
    existsSync(path.join(local, 'vendor', 'renderer', 'index.html'))
  ) {
    return local;
  }
  return path.join(os.homedir(), '.zcode-webui');
}

export function resolvePaths(packageRoot) {
  const dataHome = resolveDataHome(packageRoot);
  return {
    packageRoot: path.resolve(packageRoot),
    dataHome,
    configFile: path.join(dataHome, 'config.json'),
    rendererDir: path.join(dataHome, 'vendor', 'renderer'),
    deviceFile: path.join(dataHome, 'data', 'device-id.json'),
  };
}
