// Touch-swipe wedge probe: on phones a vertical swipe starting on a sidebar
// workspace group row can trip dnd-kit PointerSensor({distance:8}) — the row
// is draggable for reorder. If the gesture ends abnormally the DragOverlay
// snapshot can stay mounted: a frozen row copy that still runs click handlers
// (workspace activation!) but never re-renders (aria-expanded never flips).
// This probe drives the exact gesture on the sandbox renderer and checks:
//   1. after swipe: duplicate [aria-expanded] rows with the same label
//   2. click on the row position: does aria-expanded flip within 1.5s?
//   3. audit log (bootstrap v2) WEDGE lines with twins
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || 'http://127.0.0.1:3781/').replace(/\/?$/, '/');
const NAME = process.argv[3] || 'wsx-ws';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
// phone-like context
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36' });
const page = await ctx.newPage();
page.on('console', (m) => { const t = m.text(); if (/sidebar-audit|WEDGE/.test(t)) console.log('[console] ' + t.slice(0, 200)); });

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => !!document.querySelector('[data-workspace-sidebar-panel]'), null, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 6000));

async function rowInfo() {
  return page.evaluate((name) => {
    const out = [];
    for (const el of document.querySelectorAll('[aria-expanded]')) {
      const label = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      if (!label.startsWith(name)) continue;
      const r = el.getBoundingClientRect();
      let anc = [];
      let a = el;
      for (let i = 0; i < 4 && a; i++) { a = a.parentElement; if (a) anc.push(String(a.className).split(' ').slice(0, 2).join('.').slice(0, 40)); }
      out.push({ label, ae: el.getAttribute('aria-expanded'), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), connected: el.isConnected, anc: anc.join(' < ').slice(0, 100) });
    }
    return out;
  }, NAME);
}

let rows = await rowInfo();
console.log('boot rows: ' + JSON.stringify(rows));
const row = rows[0];
if (!row) { console.log('FAIL row not found'); process.exit(1); }

// ---- the gesture: touch down on the row, move down ~40px in steps, then up ----
console.log('\n== swipe down on the group row (scroll-style, 8px+ movement) ==');
await page.touchscreen.tap(row.x, row.y).catch(() => {});           // ensure page focus
await page.evaluate(({ x, y }) => {
  // synthetic PointerEvents with pointerType=touch drive dnd-kit's sensor the
  // same way a real finger does (it does not check isTrusted)
  const fire = (type, px, py) => {
    const ev = new PointerEvent(type, {
      pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
      clientX: px, clientY: py, button: 0, buttons: 1, view: window,
    });
    document.elementFromPoint(px, py).dispatchEvent(ev);
  };
  fire('pointerdown', x, y);
  let yy = y;
  const iv = setInterval(() => {
    yy += 6;                                   // crosses the 8px activation
    fire('pointermove', x, yy);
    if (yy >= y + 42) {
      clearInterval(iv);
      // abnormal end: no pointerup/pointercancel — the browser scroll claims the
      // gesture; dnd-kit sees pointercancel in real life, this probe just drops
      fire('pointercancel', x, yy);
    }
  }, 30);
}, { x: row.x, y: row.y });
await new Promise((r) => setTimeout(r, 2500));

rows = await rowInfo();
console.log('after swipe rows: ' + JSON.stringify(rows, null, 1));

// ---- does clicking still expand? ----
console.log('\n== click the row position twice (collapse/expand attempt) ==');
for (const tag of ['click1', 'click2']) {
  const before = (await rowInfo())[0];
  await page.touchscreen.tap(row.x, row.y).catch(async () => { await page.mouse.click(row.x, row.y); });
  await new Promise((r) => setTimeout(r, 1500));
  const after = (await rowInfo());
  console.log(tag + ': ' + (before ? before.ae : '?') + ' → ' + JSON.stringify(after.map((r) => r.ae)));
}

await browser.close();
