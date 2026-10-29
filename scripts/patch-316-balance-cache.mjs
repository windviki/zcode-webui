#!/usr/bin/env node
// Patch a ZCode >= 3.16 runtime so the pre-turn billing/balance check is not
// repeated for every caller.
//
// Background (measured 2026-10-29 09:56, host 3.16.3):
//   [usage-stats] billing/balance 请求完成 {durationMs: 10495}
//   [coding-plan-availability] billing/balance 请求完成 {durationMs: 10332}
//   [coding-plan-availability] billing/balance 请求完成 {durationMs: 10421}
//   [coding-plan-availability] billing/balance 请求完成 {durationMs: 5309}
// Four serial ~10 s calls, and the prompt was admitted only after the last one
// (sendConversationCommandV4 = 30,045 ms; the agent logged `v4 prompt admitted`
// at the end). Each caller funnels into fetchZaiStartPlanBalanceEnvelope, which
// de-duplicates identical (authorization, url) requests — but evicts the entry
// after 1000 ms, so a second caller one second later pays the full round trip
// again.
//
// The patch keeps the de-duplication, only the eviction window grows to 45 s
// (the same order as this repo's api-cache-guard, which already serves these
// GETs from a 30 s cache). An explicit refresh still passes force=true and
// evicts the entry immediately, so nothing becomes un-refreshable.
//
// Usage:
//   node scripts/patch-316-balance-cache.mjs [runtimeRoot] [--revert] [--dry-run]
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ANCHOR = 'let p=i(()=>{o?.get(n)===u&&(o.delete(n),o.size===0&&Jx.delete(e))},"evict"),f=1e3-(Date.now()-c);';
const PATCHED = 'let p=i(()=>{o?.get(n)===u&&(o.delete(n),o.size===0&&Jx.delete(e))},"evict"),f=45e3-(Date.now()-c);';

const args = process.argv.slice(2);
const revert = args.includes('--revert');
const dryRun = args.includes('--dry-run');
const rootArg = args.find((a) => !a.startsWith('--'));

const zcodeHome = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
const root = path.resolve(rootArg || process.env.ZCODE_SERVER_RUNTIME_ROOT || path.join(zcodeHome, 'server'));
const file = path.join(root, 'app', 'out', 'host', 'index.js');

if (!existsSync(file)) {
  console.error('[patch-316-balance] not a 3.16 runtime: ' + file + ' is missing');
  process.exit(2);
}

const src = readFileSync(file, 'utf8');
const hasAnchor = src.includes(ANCHOR);
const hasPatch = src.includes(PATCHED);

if (revert) {
  if (!hasPatch) { console.log('[patch-316-balance] not patched, nothing to revert'); process.exit(0); }
  if (dryRun) { console.log('[patch-316-balance] would revert ' + file); process.exit(0); }
  copyFileSync(file, file + '.bak-bal-' + Date.now());
  writeFileSync(file, src.split(PATCHED).join(ANCHOR));
  console.log('[patch-316-balance] reverted: ' + file);
  process.exit(0);
}

if (hasPatch) { console.log('[patch-316-balance] already patched: ' + file); process.exit(0); }
if (!hasAnchor) {
  console.error('[patch-316-balance] anchor not found — inspect this build before patching');
  process.exit(3);
}
if (src.split(ANCHOR).length !== 2) {
  console.error('[patch-316-balance] anchor is not unique — refusing to patch');
  process.exit(3);
}
if (dryRun) { console.log('[patch-316-balance] would patch ' + file); process.exit(0); }

const backup = file + '.bak-bal-' + Date.now();
copyFileSync(file, backup);
writeFileSync(file, src.split(ANCHOR).join(PATCHED));
console.log('[patch-316-balance] patched: ' + file);
console.log('[patch-316-balance] backup : ' + backup);
console.log('[patch-316-balance] effect : billing/balance de-dup window 1s -> 45s (one round trip instead of four)');
