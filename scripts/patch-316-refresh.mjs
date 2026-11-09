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
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// 3.16 anchor (minified identifiers Be/rW). 3.17 renamed them (De/az) and moved
// the rest of the file around, so match structurally instead of by literal text:
//   <a>.refreshRegistry&&await <a>.client.request(<b>.providerRefreshRegistry,{reason:<a>.reason},<c>)
const ANCHOR_RE = /([A-Za-z_$][\w$]*)\.refreshRegistry&&await \1\.client\.request\(([A-Za-z_$][\w$]*)\.providerRefreshRegistry,\{reason:\1\.reason\},([A-Za-z_$][\w$]*)\)/;
const PATCHED_RE = /([A-Za-z_$][\w$]*)\.refreshRegistry&&await Promise\.race\(\[\1\.client\.request\(([A-Za-z_$][\w$]*)\.providerRefreshRegistry,\{reason:\1\.reason\},([A-Za-z_$][\w$]*)\)\.catch\(\(\)=>\{\}\),new Promise\(r=>setTimeout\(r,1500\)\)\]\)/;
// NOTE: a function replacer receives (match, p1, p2, ...) — NOT an array.
const toPatched = (m, a, b, c) => a + '.refreshRegistry&&await Promise.race([' + a + '.client.request(' + b +
  '.providerRefreshRegistry,{reason:' + a + '.reason},' + c + ').catch(()=>{}),new Promise(r=>setTimeout(r,1500))])';
const toAnchor = (m, a, b, c) => a + '.refreshRegistry&&await ' + a + '.client.request(' + b +
  '.providerRefreshRegistry,{reason:' + a + '.reason},' + c + ')';
// Refuse to write a bundle that no longer parses: a bad replacement here bricks
// every host spawn, and the damage is invisible until the next restart.
function assertParses(text) {
  const tmp = file + '.patchcheck.mjs';
  writeFileSync(tmp, text);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    try { unlinkSync(tmp); } catch (_e) { /* ignore */ }
    console.error('[patch-316] patched bundle does not parse — refusing to write: ' + String(e.stderr || e.message).slice(0, 300));
    process.exit(4);
  }
  try { unlinkSync(tmp); } catch (_e) { /* ignore */ }
}

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
const anchorMatches = [...src.matchAll(new RegExp(ANCHOR_RE.source, 'g'))];
const patchedMatches = [...src.matchAll(new RegExp(PATCHED_RE.source, 'g'))];
const hasAnchor = anchorMatches.length === 1;
const hasPatch = patchedMatches.length === 1;

if (revert) {
  if (!hasPatch) { console.log('[patch-316] not patched, nothing to revert'); process.exit(0); }
  if (dryRun) { console.log('[patch-316] would revert ' + file); process.exit(0); }
  copyFileSync(file, file + '.bak-' + Date.now());
  writeFileSync(file, src.replace(PATCHED_RE, toAnchor));
  console.log('[patch-316] reverted: ' + file);
  process.exit(0);
}

if (hasPatch) { console.log('[patch-316] already patched: ' + file); process.exit(0); }
if (!hasAnchor) {
  console.error('[patch-316] anchor not found (' + anchorMatches.length + ' match(es)) — this build changed, inspect it before patching:\n  ' +
    '<a>.refreshRegistry&&await <a>.client.request(<b>.providerRefreshRegistry,{reason:<a>.reason},<c>)');
  process.exit(3);
}

if (dryRun) { console.log('[patch-316] would patch ' + file); process.exit(0); }

const backup = file + '.bak-' + Date.now();
copyFileSync(file, backup);
const patchedSrc = src.replace(ANCHOR_RE, toPatched);
assertParses(patchedSrc);
writeFileSync(file, patchedSrc);
console.log('[patch-316] patched: ' + file);
console.log('[patch-316] backup : ' + backup);
console.log('[patch-316] effect : provider-registry refresh no longer blocks a send for 30 s (capped at 1.5 s)');
