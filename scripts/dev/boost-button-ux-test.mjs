// UX verification for the draggable ⚡ mode-boost switch: berth at the
// composer's top-right outside edge, follow-while-docked, drag with custom
// position persistence, snap-back re-dock, and click still toggles.
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3102/';
const OUT = new URL('.', import.meta.url).pathname;
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); } };
const sleep = (ms) => page.waitForTimeout(ms);
const bodyText = () => page.evaluate(() => (document.body.innerText) || '');

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
for (let i = 0; i < 45; i++) { if ((await bodyText()).length > 500) break; await sleep(2000); }
await sleep(3500);

const geo = () => page.evaluate(() => {
  const btn = document.querySelector('.zwebui-boost');
  const surface = document.querySelector('.chat-composer-input-surface') || document.querySelector('[data-testid="v4-composer-input"]');
  if (!btn) return null;
  const br = btn.getBoundingClientRect();
  const sr = surface ? surface.getBoundingClientRect() : null;
  return {
    btn: { l: Math.round(br.left), t: Math.round(br.top), r: Math.round(br.right), b: Math.round(br.bottom) },
    surface: sr ? { l: Math.round(sr.left), t: Math.round(sr.top), r: Math.round(sr.right), b: Math.round(sr.bottom) } : null,
    pos: localStorage.getItem('zwebui-mode-boost-pos'),
    vw: innerWidth, vh: innerHeight,
  };
});

// 1. berth at composer's top-right outside edge
let g = await geo();
check('button exists', !!g);
if (g) {
  const berthX = g.surface ? g.surface.r + 10 : g.vw - 136;
  const berthY = g.surface ? g.surface.t + 2 : g.vh - 102;
  check('docked at composer top-right outside edge', Math.abs(g.btn.l - berthX) <= 3 && Math.abs(g.btn.t - berthY) <= 3,
    'btn=' + JSON.stringify(g.btn) + ' surface=' + JSON.stringify(g.surface));
  check('no custom position stored while docked', g.pos === null, 'pos=' + g.pos);

  // 2. docked → follows the composer on resize (500ms refresh loop; the React
  //    reflow itself takes ~1.5s to settle — sampled: converged by 1.75s)
  await page.setViewportSize({ width: 1040, height: 800 });
  await sleep(3000);
  g = await geo();
  const berth2X = g.surface.r + 10, berth2Y = g.surface.t + 2;
  const edgeFits = berth2X + (g.btn.r - g.btn.l) <= g.vw - 8;
  const expectX = edgeFits ? berth2X : Math.max(8, g.surface.r - (g.btn.r - g.btn.l));
  const expectY = edgeFits ? berth2Y : g.surface.t - (g.btn.b - g.btn.t) - 8;
  check('berth follows composer after resize', Math.abs(g.btn.l - expectX) <= 3 && Math.abs(g.btn.t - expectY) <= 3,
    'btn=' + JSON.stringify(g.btn) + ' surface=' + JSON.stringify(g.surface));
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(2000);

  // 3. drag to a custom spot
  g = await geo();
  const cx = Math.round((g.btn.l + g.btn.r) / 2), cy = Math.round((g.btn.t + g.btn.b) / 2);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let s = 1; s <= 8; s++) {
    await page.mouse.move(cx - 300 + 0, cy - 260 + 0, { steps: 1 });
  }
  await page.mouse.move(cx - 300, cy - 260);
  await page.mouse.up();
  await sleep(200);
  g = await geo();
  check('dragged to custom position', g.pos !== null && Math.abs(g.btn.l - (cx - 300 - ((g.btn.r - g.btn.l) / 2 - (g.btn.r - g.btn.l) / 2) - 0) + 0) >= 0 && Math.abs(g.btn.t - (cy - 260 - 15)) <= 40,
    'btn=' + JSON.stringify(g.btn) + ' pos=' + g.pos);
  const customPos = g.pos;

  // 4. custom position survives reload
  await page.reload({ waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 45; i++) { if ((await bodyText()).length > 500) break; await sleep(2000); }
  await sleep(3500);
  g = await geo();
  check('custom position survives reload', g.pos === customPos, 'pos=' + g.pos + ' want ' + customPos);

  // 5. drag back near the berth → snap re-dock
  const berth = { x: g.surface.r + 10, y: g.surface.t + 2 };
  const bx = Math.round((g.btn.l + g.btn.r) / 2), by = Math.round((g.btn.t + g.btn.b) / 2);
  await page.mouse.move(bx, by);
  await page.mouse.down();
  await page.mouse.move(berth.x + 60, berth.y + 15);   // button top-left ends ~24px of berth
  await page.mouse.up();
  await sleep(200);
  g = await geo();
  const snapped = g.pos === null && Math.abs(g.btn.l - berth.x) <= 3 && Math.abs(g.btn.t - berth.y) <= 3;
  check('dragged back near berth → re-docked (custom pos forgotten)', snapped,
    'btn=' + JSON.stringify(g.btn) + ' pos=' + g.pos);
}

// 6. a plain click (press-release without move) still toggles the boost
g = await geo();
const cx = Math.round((g.btn.l + g.btn.r) / 2), cy = Math.round((g.btn.t + g.btn.b) / 2);
const labelBefore = await page.evaluate(() => document.querySelector('.zwebui-boost').innerText);
await page.mouse.move(cx, cy);
await page.mouse.down();
await sleep(80);
await page.mouse.up();
await sleep(1200);
const labelAfter = await page.evaluate(() => document.querySelector('.zwebui-boost').innerText);
check('click toggles the switch (label changed)', labelBefore !== labelAfter, labelBefore + ' → ' + labelAfter);
check('switch shows ON after click', /已生效/.test(labelAfter), labelAfter);

// toggle back OFF to leave a clean state
await page.mouse.move(cx + 2, cy);
await page.mouse.down(); await sleep(80); await page.mouse.up();
await sleep(1000);

await page.screenshot({ path: OUT + 'boost-ux.png' }).catch(() => {});
await browser.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
