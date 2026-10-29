#!/usr/bin/env node
// Bound the "browser ambient context" capture in a ZCode >= 3.16 host.
//
// Root cause of the ~30 s first-message stall (measured 2026-10-29):
//   out/host/index.js:  async function XA(executor, target) { if (!executor) return; … }
// is awaited by BOTH prompt paths before the command reaches the agent:
//   * sendConversationCommandV4:  let je = await XA(e?.browserControlExecutor, {…})
//   * sendPrompt:                 oe = y.browserAmbientContext ?? await XA(…)
// When a browser-control executor is registered but no in-app browser answers
// (this deployment is a headless web UI: there is no iab tab), `executor.list()`
// / `executor.execute()` sit on their backend timeout and hold the prompt for
// ~30 s while nothing logs anything on either side. Evidence: the same send took
// 30,049 ms before this patch; with the capture skipped it took 53–1,872 ms, and
// an end-to-end headless run went 33.6 s → 3.4 s (Enter → stop button).
//
// The patch keeps the feature but bounds it: the original body still runs, and
// whatever it returns after 800 ms is replaced by `undefined` (no ambient
// context) so the prompt is never held hostage by a missing browser.
//
// Usage:
//   node scripts/patch-316-browser-ctx.mjs [runtimeRoot] [--revert] [--dry-run]
import { existsSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARK = '/*webui:browser-ctx-bounded*/';
const START = 'async function XA(e,t){';
const BUDGET_MS = 800;

const args = process.argv.slice(2);
const revert = args.includes('--revert');
const dryRun = args.includes('--dry-run');
const rootArg = args.find((a) => !a.startsWith('--'));

const zcodeHome = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
const root = path.resolve(rootArg || process.env.ZCODE_SERVER_RUNTIME_ROOT || path.join(zcodeHome, 'server'));
const file = path.join(root, 'app', 'out', 'host', 'index.js');

if (!existsSync(file)) {
  console.error('[patch-316-browser] not a 3.16 runtime: ' + file + ' is missing');
  process.exit(2);
}
const src = readFileSync(file, 'utf8');
const already = src.includes(MARK);

if (revert) {
  // the pre-patch file is the .bak-xa-* written when this script last patched
  const dir = path.dirname(file);
  const backups = readdirSync(dir)
    .filter((n) => n.startsWith('index.js.bak-xa-'))
    .sort()
    .map((n) => path.join(dir, n));
  if (backups.length === 0) { console.log('[patch-316-browser] no .bak-xa-* backup to restore from'); process.exit(0); }
  if (!already) { console.log('[patch-316-browser] not patched, nothing to revert'); process.exit(0); }
  const newest = backups[backups.length - 1];
  if (dryRun) { console.log('[patch-316-browser] would restore ' + newest + ' over ' + file); process.exit(0); }
  copyFileSync(newest, file);
  console.log('[patch-316-browser] reverted from ' + newest);
  process.exit(0);
}

if (already) { console.log('[patch-316-browser] already patched: ' + file); process.exit(0); }

const start = src.indexOf(START);
if (start < 0) {
  console.error('[patch-316-browser] XA() not found — inspect this build before patching');
  process.exit(3);
}
if (src.indexOf(START, start + 1) >= 0) {
  console.error('[patch-316-browser] XA() is not unique — refusing to patch');
  process.exit(3);
}
// find the matching closing brace of the function body
let depth = 0, i = start + START.length - 1, quote = null;
for (; i < src.length; i++) {
  const ch = src[i];
  if (quote) {
    if (ch === '\\') { i++; continue; }
    if (ch === quote) quote = null;
    continue;
  }
  if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth === 0) break; }
}
if (depth !== 0) { console.error('[patch-316-browser] could not find the end of XA()'); process.exit(3); }
const originalBody = src.slice(start + START.length, i); // everything inside the braces
const patched =
  `async function XA(e,t){if(!e)return;${MARK}` +
  `const __xaT=new Promise(r=>setTimeout(()=>r(void 0),${BUDGET_MS}));` +
  `const __xaW=(async()=>{${originalBody}})();` +
  `return await Promise.race([__xaW,__xaT])}`;

if (dryRun) { console.log('[patch-316-browser] would patch ' + file + ' (budget ' + BUDGET_MS + 'ms)'); process.exit(0); }
copyFileSync(file, file + '.bak-xa-' + Date.now());
writeFileSync(file, src.slice(0, start) + patched + src.slice(i + 1));
console.log('[patch-316-browser] patched: ' + file);
console.log('[patch-316-browser] effect : browser ambient-context capture capped at ' + BUDGET_MS + 'ms (was unbounded, ~30s with no browser)');
