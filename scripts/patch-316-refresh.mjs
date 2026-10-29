#!/usr/bin/env node
// Patch a ZCode >= 3.16 runtime so a prompt is no longer blocked on the
// provider-registry sync.
//
// Background: 3.16's host, before dispatching a sendText command, runs
//   ensureAccountProviderConfigSynced({refreshRegistry:true})
// which posts the account provider config to the agent and then AWAITS
//   client.request(providerRefreshRegistry, {reason})
// with a ~30 s request timeout. Measured on this box (2026-10-29): five sends
// took 30,053 – 30,072 ms in `sendConversationCommandV4`, the agent only saw
// "v4 prompt admitted" at the very end, while every other RPC through the same
// port answered in 10–40 ms. So the prompt sat in the host for the whole
// timeout while the agent was busy elsewhere.
//
// The patch keeps the refresh (it still runs, unchanged) but stops blocking the
// command on it: the await becomes a 1.5 s race. The request keeps its original
// arguments — nothing about the RPC payload changes.
//
// Usage:
//   node scripts/patch-316-refresh.mjs [runtimeRoot] [--revert] [--dry-run]
//   runtimeRoot defaults to $ZCODE_HOME/server (or ~/.zcode/server), i.e. the
//   same directory the shim spawns the host from.
//
// The file is backed up next to itself as index.js.bak-<timestamp> before any
// write, and the patch is idempotent (a second run is a no-op).
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ANCHOR = 'y.refreshRegistry&&await y.client.request(Be.providerRefreshRegistry,{reason:y.reason},rW)';
const PATCHED = 'y.refreshRegistry&&await Promise.race([y.client.request(Be.providerRefreshRegistry,{reason:y.reason},rW).catch(()=>{}),new Promise(r=>setTimeout(r,1500))])';

const args = process.argv.slice(2);
const revert = args.includes('--revert');
const dryRun = args.includes('--dry-run');
const rootArg = args.find((a) => !a.startsWith('--'));

const zcodeHome = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
const root = path.resolve(rootArg || process.env.ZCODE_SERVER_RUNTIME_ROOT || path.join(zcodeHome, 'server'));
const file = path.join(root, 'app', 'out', 'host', 'index.js');

if (!existsSync(file)) {
  console.error('[patch-316] not a 3.16 runtime: ' + file + ' is missing');
  process.exit(2);
}

const src = readFileSync(file, 'utf8');
const hasAnchor = src.includes(ANCHOR);
const hasPatch = src.includes(PATCHED);

if (revert) {
  if (!hasPatch) { console.log('[patch-316] not patched, nothing to revert'); process.exit(0); }
  if (dryRun) { console.log('[patch-316] would revert ' + file); process.exit(0); }
  copyFileSync(file, file + '.bak-' + Date.now());
  writeFileSync(file, src.split(PATCHED).join(ANCHOR));
  console.log('[patch-316] reverted: ' + file);
  process.exit(0);
}

if (hasPatch) { console.log('[patch-316] already patched: ' + file); process.exit(0); }
if (!hasAnchor) {
  console.error('[patch-316] anchor not found — this build changed, inspect it before patching:\n  ' +
    'y.refreshRegistry&&await y.client.request(Be.providerRefreshRegistry,{reason:y.reason},rW)');
  process.exit(3);
}
if (src.split(ANCHOR).length !== 2) {
  console.error('[patch-316] anchor is not unique — refusing to patch');
  process.exit(3);
}

if (dryRun) { console.log('[patch-316] would patch ' + file); process.exit(0); }

const backup = file + '.bak-' + Date.now();
copyFileSync(file, backup);
writeFileSync(file, src.split(ANCHOR).join(PATCHED));
console.log('[patch-316] patched: ' + file);
console.log('[patch-316] backup : ' + backup);
console.log('[patch-316] effect : provider-registry refresh no longer blocks a send for 30 s (capped at 1.5 s)');
