// Real-touch swipe verification (CDP Input.dispatchTouchEvent = trusted events,
// same path as a phone): a downward swipe starting on a workspace group row
// must NOT toggle/collapse the group once the bridge shield is active, and
// taps must still toggle it. With SHIELD=off (baseline), the swipe is expected
// to reach dnd-kit's PointerSensor and flip the group.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const BASE = (process.argv[2] || 'http://127.0.0.1:3781/').replace(/\/?$/, '/');
const NAME = process.argv[3] || 'wsx-ws';
const SHIELD = process.argv[4] !== 'off';   // default: on

if (!SHIELD) {
  // temporarily neutralize the shield in the served bridge for a baseline run
  execSync("sed -i 's/if (ev.pointerType !== .touch.) return;/if (ev.pointerType !== \"touch\" || window.__NO_SHIELD__) return;/' web/zcode-bridge.js");
}
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
if (!SHIELD) await page.addInitScript(() => { window.__NO_SHIELD__ = true; });
const cdp = await ctx.newCDPSession(page);
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => !!document.querySelector('[data-workspace-sidebar-panel]'), null, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 6000));

async function rowAe() {
  return page.evaluate((name) => {
    const el = [...document.querySelectorAll('[aria-expanded]')]
      .find((e) => (e.textContent || '').trim().startsWith(name) && e.closest('[data-state]'));
    return el ? el.getAttribute('aria-expanded') : null;
  }, NAME);
}
async function rowPos() {
  return page.evaluate((name) => {
    const el = [...document.querySelectorAll('[aria-expanded]')]
      .find((e) => (e.textContent || '').trim().startsWith(name) && e.closest('[data-state]'));
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + 12) };
  }, NAME);
}

const before = await rowAe();
const p = await rowPos();
console.log('[' + (SHIELD ? 'SHIELD-ON' : 'BASELINE') + '] row ae=' + before + ' at ' + JSON.stringify(p));

// real touch swipe DOWN 42px starting on the row
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
for (let i = 1; i <= 7; i++) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y + i * 6 }] });
  await new Promise((r) => setTimeout(r, 25));
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await new Promise((r) => setTimeout(r, 1200));
const afterSwipe = await rowAe();
console.log('after swipe: ae=' + afterSwipe + (before !== afterSwipe ? '  <-- GROUP TOGGLED BY SWIPE (bug)' : '  (unchanged, good)'));

// tap: must toggle (click path unaffected by the shield)
await page.touchscreen.tap(p.x, p.y);
await new Promise((r) => setTimeout(r, 1000));
const afterTap = await rowAe();
console.log('after tap:   ae=' + afterTap + (afterTap !== afterSwipe ? '  (toggled, good)' : '  <-- TAP DEAD'));

await browser.close();
