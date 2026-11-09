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
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// 3.16 anchor was a full literal (identifiers n/Jx); 3.17 renamed those inside
// the evict closure (r/YO) and kept the 1s de-dup window. Match the window
// itself, which is what the patch changes, and keep the surrounding identifiers.
const ANCHOR_RE = /,"evict"\),([A-Za-z_$][\w$]*)=1e3-\(Date\.now\(\)-([A-Za-z_$][\w$]*)\);/;
const PATCHED_RE = /,"evict"\),([A-Za-z_$][\w$]*)=45e3-\(Date\.now\(\)-([A-Za-z_$][\w$]*)\);/;
// NOTE: a function replacer receives (match, p1, p2, ...) — NOT an array.
const patchedFor = (m, a, b) => ',"evict"),' + a + '=45e3-(Date.now()-' + b + ');';
const anchorFor = (m, a, b) => ',"evict"),' + a + '=1e3-(Date.now()-' + b + ');';
// Refuse to write a bundle that no longer parses: a bad replacement here bricks
// every host spawn, and the damage is invisible until the next restart.
function assertParses(text) {
  const tmp = file + '.patchcheck.mjs';
  writeFileSync(tmp, text);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    try { unlinkSync(tmp); } catch (_e) { /* ignore */ }
    console.error('[patch-316-balance] patched bundle does not parse — refusing to write: ' + String(e.stderr || e.message).slice(0, 300));
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
  console.error('[patch-316-balance] not a 3.16 runtime: ' + file + ' is missing');
  process.exit(2);
}

const src = readFileSync(file, 'utf8');
const anchorMatches = [...src.matchAll(new RegExp(ANCHOR_RE.source, 'g'))];
const patchedMatches = [...src.matchAll(new RegExp(PATCHED_RE.source, 'g'))];
const hasAnchor = anchorMatches.length === 1;
const hasPatch = patchedMatches.length === 1;

if (revert) {
  if (!hasPatch) { console.log('[patch-316-balance] not patched, nothing to revert'); process.exit(0); }
  if (dryRun) { console.log('[patch-316-balance] would revert ' + file); process.exit(0); }
  copyFileSync(file, file + '.bak-bal-' + Date.now());
  writeFileSync(file, src.replace(PATCHED_RE, anchorFor));
  console.log('[patch-316-balance] reverted: ' + file);
  process.exit(0);
}

if (hasPatch) { console.log('[patch-316-balance] already patched: ' + file); process.exit(0); }
if (!hasAnchor) {
  console.error('[patch-316-balance] anchor not found (' + anchorMatches.length + ' match(es)) — inspect this build before patching');
  process.exit(3);
}
if (dryRun) { console.log('[patch-316-balance] would patch ' + file); process.exit(0); }

const backup = file + '.bak-bal-' + Date.now();
copyFileSync(file, backup);
const patchedSrc = src.replace(ANCHOR_RE, patchedFor);
assertParses(patchedSrc);
writeFileSync(file, patchedSrc);
console.log('[patch-316-balance] patched: ' + file);
console.log('[patch-316-balance] backup : ' + backup);
console.log('[patch-316-balance] effect : billing/balance de-dup window 1s -> 45s (one round trip instead of four)');
