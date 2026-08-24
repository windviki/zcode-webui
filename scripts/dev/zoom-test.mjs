// Desktop-style zoom regression for the browser shim:
// ctrl+wheel (Chrome pinch), two-finger pinch recognizer, normal wheel untouched,
// CSS zoom applied, and the official zoom subscription channel.
// Usage: node scripts/dev/zoom-test.mjs [baseURL]
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/').replace(/\/?$/, '/');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message.slice(0, 200)));

const checks = [];
const check = (n, ok, extra) => { checks.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  (' + extra + ')' : '')); };

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(12000);
  await page.keyboard.press('Escape').catch(() => {});

  const z0 = await page.evaluate(() => window.__zwebui_zoom.get());
  check('initial zoom is 1', z0 === 1, 'zoom=' + z0);

  // ctrl+wheel (what Chrome reports for trackpad/touchscreen pinch), ~12%/notch
  await page.evaluate(() => window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })));
  const z1 = await page.evaluate(() => window.__zwebui_zoom.get());
  check('ctrl+wheel zooms in one notch', z1 > 1 && z1 < 1.2, 'zoom=' + z1);

  // normal wheel must stay untouched
  await page.evaluate(() => window.__zwebui_zoom.set(1));
  const wheelOk = await page.evaluate(() => {
    const ev = new WheelEvent('wheel', { deltaY: 120, ctrlKey: false, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented === false;
  });
  const zAfter = await page.evaluate(() => window.__zwebui_zoom.get());
  check('normal wheel untouched (scroll preserved)', wheelOk && zAfter === 1);

  // two-finger pinch via pointer events (works over touch-action:none regions)
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

await page.evaluate(() => { window.__zwebui_zoom.set(1); try { localStorage.removeItem('zwebui-zoom'); } catch (e) { /* ignore */ } });
await browser.close();
const failed = checks.filter((c) => !c).length;
console.log(failed === 0 ? 'ZOOM OK' : 'ZOOM FAILED (' + failed + ')');
process.exit(failed ? 1 : 0);
