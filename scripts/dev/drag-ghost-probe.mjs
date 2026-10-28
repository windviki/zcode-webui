// Drag-ghost lifecycle probe: real pointer drag on a sidebar workspace group
// row (dnd-kit PointerSensor distance:8). Inspects the DOM DURING the drag
// (DragOverlay snapshot) and after an abnormal end (pointer cancel via ESC /
// far drop), then checks whether the row still toggles on click.
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || 'http://127.0.0.1:3781/').replace(/\/?$/, '/');
const NAME = process.argv[3] || 'wsx-ws';
const MODE = process.argv[4] || 'esc';   // esc | drop | cancel
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => !!document.querySelector('[data-workspace-sidebar-panel]'), null, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 6000));

async function dump(tag) {
  const rows = await page.evaluate((name) => {
    const out = [];
    for (const el of document.querySelectorAll('[aria-expanded]')) {
      const label = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      if (!label.startsWith(name)) continue;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      let anc = [];
      let a = el;
      for (let i = 0; i < 4 && a; i++) { a = a.parentElement; if (a) anc.push((String(a.className).split(' ')[0] || a.tagName).slice(0, 30)); }
      out.push({ ae: el.getAttribute('aria-expanded'), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), pe: st.pointerEvents, op: st.opacity, pos: st.position, anc: anc.join('<') });
    }
    return out;
  }, NAME);
  console.log('[' + tag + '] ' + JSON.stringify(rows));
  return rows;
}

const rows0 = await dump('boot');
const row = rows0.find((r) => r.w > 120);
if (!row) { console.log('FAIL group row not found'); process.exit(1); }
const cx = row.x + 40, cy = row.y + 12;

await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 6; i++) { await page.mouse.move(cx, cy + i * 4, { steps: 2 }); await new Promise((r) => setTimeout(r, 40)); }
await dump('mid-drag');
if (MODE === 'esc') {
  await page.keyboard.press('Escape');
  await page.mouse.up();
} else if (MODE === 'pointercancel') {
  // the phone case: mid-drag the browser claims the gesture for scrolling and
  // fires pointercancel — dnd-kit must unwind the drag; if it does not, the
  // frozen snapshot/ghost stays and the row stops following the store
  await page.evaluate(() => {
    document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'touch', bubbles: true, cancelable: true }));
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'touch', bubbles: true, cancelable: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.mouse.up();
} else if (MODE === 'cancel') {
  await page.mouse.up();   // drop far below (over another area) = reorder attempt
}
await new Promise((r) => setTimeout(r, 1500));
await dump('after-' + MODE);

// do clicks still toggle?
for (const tag of ['c1', 'c2', 'c3']) {
  await page.mouse.click(cx, cy);
  await new Promise((r) => setTimeout(r, 900));
  await dump(tag);
}
await browser.close();
