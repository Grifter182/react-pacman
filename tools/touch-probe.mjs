/**
 * Mobile control acceptance test.
 *
 *   PW_CHROMIUM=/opt/pw-browsers/chromium node tools/touch-probe.mjs
 *
 * Touch input cannot be checked by eye from a desktop, and it has already
 * broken twice in ways a screenshot cannot show, so it gets a measurement
 * harness of its own.
 *
 * TWO TRAPS THIS FILE EXISTS TO AVOID — both of them produced confident, wrong
 * conclusions before it was written:
 *
 *  1. THIS BOX RENDERS AT ABOUT 1 FPS under SwiftShader. A "hold the stick for
 *     700ms" test therefore spans less than one simulation step, the player
 *     moves ~0.1 m, and a perfectly wired stick reads as completely dead. Every
 *     hold below runs for fourteen seconds and reports the frame count it
 *     actually got, so a null result can be told apart from a slow one.
 *  2. PLAYWRIGHT SETS `navigator.webdriver`, and the HUD treats that as
 *     "headless: skip the front end". Without `?frontend=1` the title screen
 *     never appears, so the menu/DEPLOY half of this test would silently pass
 *     over an empty screen.
 *
 * Everything is driven through `document.elementFromPoint` and the real
 * touchscreen, not by calling handlers directly: the last mobile bug was a
 * `pointer-events: none` container swallowing every gesture, which only a real
 * hit-test can catch.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const EXEC = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const PORT = 5200 + Math.floor(Math.random() * 3000);
const HOLD_MS = 14000;

const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('vite did not start')), 30000);
  proc.stdout.on('data', (d) => {
    if (/Local:|ready in/i.test(String(d))) { clearTimeout(t); setTimeout(res, 600); }
  });
});

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});
// A real phone: coarse pointer, no hover, landscape. That combination is what
// gates TouchControls into existence.
const ctx = await browser.newContext({
  viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1,
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}?quality=low&frontend=1`, { waitUntil: 'load' });
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
await page.waitForFunction(() => !!document.querySelector('.bl-menu.on .bl-btn'), null, { timeout: 240000 });
await page.waitForTimeout(2000);

const results = {};
const say = (k, v) => { results[k] = v; console.log(`[${k}] ${JSON.stringify(v)}`); };

const fps = await page.evaluate(async () => {
  const f0 = window.__engine.frame;
  await new Promise((r) => setTimeout(r, 3000));
  return +((window.__engine.frame - f0) / 3).toFixed(2);
});
console.log(`[fps] ${fps} — holds below run ${HOLD_MS / 1000}s to contain real frames`);

/* --- 1. the front end must be reachable with a thumb ---------------------- */
say('deployTappable', await page.evaluate(() => {
  const d = [...document.querySelectorAll('.bl-menu .bl-btn')].find((n) => /DEPLOY/i.test(n.textContent || ''));
  if (!d) return { found: false };
  const r = d.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  window.__deployPt = [r.left + r.width / 2, r.top + r.height / 2];
  return {
    found: true,
    // If the touch layer's full-screen drag surface stacks over the menu, this
    // is the tc-surface and no tap can ever reach DEPLOY.
    topElement: top ? `${top.tagName}.${top.className}` : null,
    reachable: !!top && (top === d || d.contains(top)),
    touchLayerHidden: getComputedStyle(document.querySelector('.bl-touch')).display === 'none',
  };
}));

const [dx, dy] = await page.evaluate(() => window.__deployPt);
await page.touchscreen.tap(dx, dy);
await page.waitForTimeout(3000);
say('deployed', await page.evaluate(() => ({
  hudState: window.__engine.get('hud').state,
  menuClosed: !document.querySelector('.bl-menu.on'),
  touchVisible: getComputedStyle(document.querySelector('.bl-touch')).display !== 'none',
})));

/* --- 2. park the world so only the stick can move the body ---------------- */
const park = () => page.evaluate(() => {
  const e = window.__engine, s = e.get('player').state;
  const ai = e.get('ai');
  if (ai?.actors) for (const a of ai.actors) { a.alive = false; if (a.mesh) a.mesh.visible = false; }
  s.health = 1e9; s.maxHealth = 1e9;
  s.position.set(0, 1.0, 20); s.velocity.set(0, 0, 0); s.yaw = Math.PI; s.pitch = 0;
});

/**
 * Hold the floating stick from `from` toward `to` and report the displacement.
 *
 * THE GESTURE IS REAL TOUCH, NOT A SYNTHETIC EVENT. This used to dispatch
 * `PointerEvent`s with `el.dispatchEvent`, which proves the handlers work when
 * handed events but says nothing about whether a device delivers them — it
 * skips hit-testing against `touch-action`, gesture disambiguation and
 * `pointercancel`. The shipped layer now takes native touch events on any
 * device that has them, so a synthetic PointerEvent would not even reach the
 * stick and this test would fail while the game worked. Both reasons point the
 * same way: drive CDP `Input.dispatchTouchEvent` and let Chromium's real touch
 * pipeline do the delivering.
 *
 * The touch is NOT re-sent while held. A resting thumb sends nothing, so the
 * stick has to latch on its own, and a probe that keeps nudging the finger hides
 * a latch bug.
 */
const holdStick = async (fromX, fromY, toX, toY) => {
  await park();
  await page.waitForTimeout(1200);
  const before = await page.evaluate(() => {
    const s = window.__engine.get('player').state;
    window.__peak = { move: 0, speed: 0 };
    return { x: s.position.x, z: s.position.z, frame: window.__engine.frame };
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y: fromY, id: 7 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: toX, y: toY, id: 7 }] });
  const deadline = Date.now() + HOLD_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const e = window.__engine, s = e.get('player').state, inp = e.get('player').input;
      window.__peak.move = Math.max(window.__peak.move, Math.hypot(inp.moveX, inp.moveY));
      window.__peak.speed = Math.max(window.__peak.speed, Math.hypot(s.velocity.x, s.velocity.z));
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return page.evaluate(({ before }) => {
    const e = window.__engine, s = e.get('player').state;
    return {
      hitElement: (document.elementFromPoint(180, 250) || {}).className || '(none)',
      frames: e.frame - before.frame,
      peakInputMove: +window.__peak.move.toFixed(2), peakSpeed: +window.__peak.speed.toFixed(2),
      dx: +(s.position.x - before.x).toFixed(2), dz: +(s.position.z - before.z).toFixed(2),
      metres: +Math.hypot(s.position.x - before.x, s.position.z - before.z).toFixed(2),
    };
  }, { before });
};

// yaw = PI, so forward is +Z and right is -X.
say('stickForward', await holdStick(180, 250, 180, 180));
say('stickRight', await holdStick(180, 250, 250, 250));

/* --- 3. look drag on the right half -------------------------------------- */
await park();
await page.waitForTimeout(800);
const look0 = await page.evaluate(() => {
  const s = window.__engine.get('player').state;
  return { yaw: s.yaw, pitch: s.pitch, el: (document.elementFromPoint(640, 200) || {}).className || '(none)' };
});
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 640, y: 200, id: 8 }] });
for (let i = 1; i <= 10; i++) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 640 + i * 12, y: 200 - i * 4, id: 8 }] });
  await page.waitForTimeout(90);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(2500);
say('lookDrag', await page.evaluate(({ look0 }) => {
  const s = window.__engine.get('player').state;
  return { hitElement: look0.el, yawDelta: +(s.yaw - look0.yaw).toFixed(3), pitchDelta: +(s.pitch - look0.pitch).toFixed(3) };
}, { look0 }));

/* --- 4. action buttons ---------------------------------------------------- */
say('buttons', await page.evaluate(async () => {
  const st = window.__engine.get('player').state;
  const out = {};
  const press = (sel) => {
    const n = document.querySelector(sel);
    n.dispatchEvent(new PointerEvent('pointerdown',
      { pointerId: 9, clientX: 1, clientY: 1, bubbles: true, pointerType: 'touch', isPrimary: true }));
    return n;
  };
  const release = (n) => n.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, bubbles: true, pointerType: 'touch' }));
  let fired = 0; window.__engine.bus.on('weapon:fire', () => fired++);
  const f = press('#tc-fire'); await new Promise((r) => setTimeout(r, 2500)); release(f);
  out.shotsFired = fired;
  const y0 = st.position.y; const j = press('#tc-jump');
  await new Promise((r) => setTimeout(r, 1200)); release(j);
  out.jumpRise = +(st.position.y - y0).toFixed(3);
  let ads = null; window.__engine.bus.on('input:ads', ({ down }) => { ads = down; });
  release(press('#tc-ads')); await new Promise((r) => setTimeout(r, 300));
  out.adsLatched = ads;
  return out;
}));

/* --- 5. the way back into the menu --------------------------------------- */
const [mx, my] = await page.evaluate(() => {
  const r = document.querySelector('#tc-menu').getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
});
await page.touchscreen.tap(mx, my);
await page.waitForTimeout(2000);
say('menuButton', await page.evaluate(() => {
  const resume = [...document.querySelectorAll('.bl-menu .bl-btn')].find((n) => /RESUME/i.test(n.textContent || ''));
  const r = resume?.getBoundingClientRect();
  const top = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  return {
    hudState: window.__engine.get('hud').state,
    menuOpen: !!document.querySelector('.bl-menu.on'),
    touchLayerHidden: getComputedStyle(document.querySelector('.bl-touch')).display === 'none',
    resumeReachable: !!top && (top === resume || resume.contains(top)),
  };
}));

const verdict = {
  frontEndReachable: results.deployTappable.reachable === true && results.deployed.hudState === 'live',
  moveWorks: results.stickForward.dz > 2 && results.stickForward.peakInputMove > 0.8,
  strafeWorks: Math.abs(results.stickRight.dx) > 2,
  lookWorks: Math.abs(results.lookDrag.yawDelta) > 0.05 && Math.abs(results.lookDrag.pitchDelta) > 0.02,
  fireWorks: results.buttons.shotsFired > 0,
  jumpWorks: results.buttons.jumpRise > 0.1,
  adsWorks: results.buttons.adsLatched === true,
  menuReturnWorks: results.menuButton.hudState === 'pause' && results.menuButton.resumeReachable,
  noPageErrors: errors.length === 0,
};
console.log('\nVERDICT ' + JSON.stringify(verdict, null, 2));
if (errors.length) console.log('page errors:\n' + errors.join('\n'));

await browser.close();
proc.kill();
process.exit(Object.values(verdict).every(Boolean) ? 0 : 1);
