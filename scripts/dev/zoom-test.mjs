// Desktop-style zoom regression for the browser shim:
// ctrl+wheel (Chrome pinch, debounced hybrid pipeline), two-finger pinch
// recognizer with midpoint anchoring + scroll compensation, normal wheel
// untouched, CSS zoom committed on <html>, transform cleaned up, and the
// official zoom subscription channel.
// Usage: node scripts/dev/zoom-test.mjs [baseURL]
// Safety: refuses :3102 (the usual production port) unless
// ZOOM_TEST_ALLOW_PROD=1 — a stray test page load would ADOPT (and demote!)
// your live session under the new continuity model.
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/').replace(/\/?$/, '/');
if (/:(3102)\//.test(BASE) && process.env.ZOOM_TEST_ALLOW_PROD !== '1') {
  console.log('FAIL  refusing to run against :' + 3102 + ' (production?) — set ZOOM_TEST_ALLOW_PROD=1 to override');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));

const checks = [];
const check = (n, ok, extra) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  (' + extra + ')' : '')); };
const raf = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(12000);
  await page.keyboard.press('Escape').catch(() => {});

  const z0 = await page.evaluate(() => window.__zwebui_zoom.get());
  check('initial zoom is 1', z0 === 1, 'zoom=' + z0);

  // ctrl+wheel (trackpad/touchscreen pinch): hybrid pipeline commits after a
  // short idle debounce — wait past it before reading the channel
  await page.evaluate(() => window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(400);
  const z1 = await page.evaluate(() => window.__zwebui_zoom.get());
  check('ctrl+wheel zooms in one notch (debounced commit)', z1 > 1 && z1 < 1.2, 'zoom=' + z1);

  // normal wheel must stay untouched
  await page.evaluate(() => window.__zwebui_zoom.set(1));
  await page.waitForTimeout(300);
  const wheelOk = await page.evaluate(() => {
    const ev = new WheelEvent('wheel', { deltaY: 120, ctrlKey: false, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented === false;
  });
  const zAfter = await page.evaluate(() => window.__zwebui_zoom.get());
  check('normal wheel untouched (scroll preserved)', wheelOk && zAfter === 1);

  // two-finger pinch via pointer events: 2x spread commits exactly 2x zoom
  await page.evaluate(() => {
    const mk = (type, id, x, y) => window.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, isPrimary: id === 1, bubbles: true, cancelable: true }));
    mk('pointerdown', 1, 400, 400);
    mk('pointerdown', 2, 500, 400);
    mk('pointermove', 1, 350, 400);
    mk('pointermove', 2, 550, 400);
    mk('pointerup', 1, 350, 400);
    mk('pointerup', 2, 550, 400);
  });
  const z2 = await page.evaluate(() => window.__zwebui_zoom.get());
  check('two-finger pinch zooms', z2 > 1 && z2 <= 2, 'zoom=' + z2);

  const css = await page.evaluate(() => document.documentElement.style.zoom);
  check('CSS zoom applied on <html>', parseFloat(css) === z2, 'css=' + css);

  // anchor + cleanup: on a scrollable page, zooming in around a focal point must
  // scroll-compensate so the content under the fingers stays put, and the
  // transform preview must be fully cleaned up after commit
  await page.evaluate(() => window.__zwebui_zoom.set(1));
  const anchor = await page.evaluate(async () => {
    const sp = document.createElement('div');
    sp.id = 'zwebui-anchor-spacer';
    sp.style.cssText = 'height:6000px;width:10px;';
    document.body.appendChild(sp);
    window.scrollTo(0, 1000);
    await new Promise((r) => setTimeout(r, 50));
    const before = { scrollY: window.scrollY, zoom: window.__zwebui_zoom.get() };
    const mk = (type, id, x, y) => window.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, isPrimary: id === 1, bubbles: true, cancelable: true }));
    mk('pointerdown', 1, 400, 400);
    mk('pointerdown', 2, 500, 400);
    mk('pointermove', 1, 350, 400);
    mk('pointermove', 2, 550, 400);
    mk('pointerup', 1, 350, 400);
    mk('pointerup', 2, 550, 400);
    await new Promise((r) => setTimeout(r, 120));
    const after = {
      scrollY: window.scrollY,
      zoom: window.__zwebui_zoom.get(),
      transform: document.documentElement.style.transform,
      willChange: document.documentElement.style.willChange,
      spacer: !!document.getElementById('zwebui-anchor-spacer'),
    };
    sp.remove();
    return { before, after };
  });
  const zExp = Math.min(2, Math.max(0.5, anchor.before.zoom * 2));
  // committed zoom is rounded to 3 decimals
  const ratio = anchor.after.zoom / anchor.before.zoom;
  const expectedScroll = (400 + anchor.before.scrollY) * ratio - 400;
  check('anchor scroll compensation', Math.abs(anchor.after.scrollY - expectedScroll) <= 2,
    'scrollY=' + anchor.after.scrollY + ' expected≈' + expectedScroll.toFixed(1));
  check('transform preview cleaned up after commit', anchor.after.transform === '' && anchor.after.willChange === '',
    'transform=' + JSON.stringify(anchor.after.transform) + ' willChange=' + JSON.stringify(anchor.after.willChange));
  check('commit zoom within clamp', Math.abs(anchor.after.zoom - zExp) < 0.01, 'zoom=' + anchor.after.zoom);
  check('touch-action injected (native pinch disabled)', await page.evaluate(() => {
    for (const s of document.querySelectorAll('style')) if (s.textContent.includes('touch-action: pan-x pan-y')) return true;
    return false;
  }));

  // the official UI subscription channel (get/set/onChanged)
  await page.evaluate(() => window.__zwebui_zoom.set(1));
  const chan = await page.evaluate(() => new Promise((resolve) => {
    const got = [];
    const un = window.zcode.onDesktopZoomLevelChanged((e) => got.push(e.zoomLevel));
    window.zcode.getDesktopZoomLevel().then((e) => { got.push('get:' + e.zoomLevel); });
    window.zcode.setDesktopZoomLevel(1.5).then(() => {
      setTimeout(() => { un(); window.zcode.setDesktopZoomLevel(1); resolve(got); }, 200);
    });
  }));
  check('official zoom channel works', chan.includes('get:1') && chan.includes(1.5), JSON.stringify(chan));
} catch (e) {
  console.log('FAIL  ' + (e && e.message ? e.message : e));
  checks.push(false);
}

await page.evaluate(() => { window.__zwebui_zoom.set(1); try { localStorage.removeItem('zwebui-zoom'); } catch (e) { /* ignore */ } }).catch(() => {});
await browser.close();
const failed = checks.filter((c) => !c).length;
console.log(failed === 0 ? 'ZOOM OK' : 'ZOOM FAILED (' + failed + ')');
process.exit(failed ? 1 : 0);
