/**
 * REAL TOUCH PROBE — does a genuine touch drag move the player?
 *
 * WHY THIS EXISTS, AND WHY tools/touch-probe.mjs WAS NOT ENOUGH.
 *
 * That probe dispatches synthetic `PointerEvent`s with `el.dispatchEvent(...)`.
 * Listeners fire, so it proves the HANDLERS are correct when handed events. It
 * does NOT prove the browser hands them those events on a real device, because
 * a synthetic event skips the entire touch pipeline: hit-testing against
 * `touch-action`, gesture disambiguation, and — critically — `pointercancel`,
 * which a real browser fires when it decides a drag is a scroll or a system
 * gesture. The touch layer treats `pointercancel` as "thumb lifted" and zeroes
 * the stick, so on hardware the stick can die mid-drag while every synthetic
 * test passes. The player reported exactly that: the stick does nothing.
 *
 * So this drives CDP `Input.dispatchTouchEvent`, which goes through Chromium's
 * real touch handling and produces trusted events, and it COUNTS the pointer and
 * touch events the page actually receives — including cancels — rather than
 * inferring from the outcome.
 *
 * The simulation is hand-stepped between gesture frames (see climb-probe.mjs for
 * why): the box draws at ~1.5 fps, so waiting on the frame loop would confound
 * "input never arrived" with "no time to move".
 *
 *   PW_CHROMIUM=/opt/pw-browsers/chromium node tools/real-touch-probe.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 5200 + Math.floor(Math.random() * 3000);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('vite did not start')), 30000);
  proc.stdout.on('data', (d) => {
    if (/Local:|ready in/i.test(String(d))) { clearTimeout(t); setTimeout(res, 600); }
  });
});

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({
  viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}?quality=low&nofrontend=1`, { waitUntil: 'load' });
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 300000 });
await page.waitForTimeout(2000);

const cdp = await ctx.newCDPSession(page);

// Instrument: count every relevant event the page receives, on the surface and
// on window, so a missing event is distinguishable from a mishandled one.
await page.evaluate(() => {
  const e = window.__engine;
  window.__ev = {};
  const bump = (k) => { window.__ev[k] = (window.__ev[k] || 0) + 1; };
  const surf = document.querySelector('.tc-surface');
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel',
    'touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    if (surf) surf.addEventListener(t, () => bump('surface:' + t), { passive: true });
    window.addEventListener(t, () => bump('window:' + t), { passive: true });
  }
  // Hand-driven fixed step, so input delivery is not confounded with frame rate.
  window.__step = (sec) => {
    const dt = 1 / 120;
    for (let i = 0, n = Math.round(sec / dt); i < n; i++) {
      for (const { module } of e._order) {
        if (typeof module.fixedUpdate === 'function') module.fixedUpdate(dt, e);
      }
    }
  };
  const s = e.get('player').state;
  s.position.set(0, 1.0, 20); s.velocity.set(0, 0, 0); s.yaw = Math.PI; s.pitch = 0;
  s.health = 1e9; s.maxHealth = 1e9;
  const ai = e.get('ai');
  if (ai?.actors) for (const a of ai.actors) { a.alive = false; if (a.mesh) a.mesh.visible = false; }
  e.get('player').controller.reset(s.position.clone());
});

const snap = () => page.evaluate(() => {
  const e = window.__engine;
  const inp = e.get('player').input, hud = e.get('hud'), s = e.get('player').state;
  // WHERE IS THE RING? `.tc-stick` is position:fixed with NO default left/top,
  // so if it ever gets its `.on` class without those being assigned it parks at
  // the top-left corner, shifted further out by its own -66px margin. A player
  // seeing a ring stuck in the corner is seeing exactly that, so the element's
  // real geometry is reported rather than inferred from the handler state.
  const st = document.querySelector('#tc-stick');
  let ring = null;
  if (st) {
    const r = st.getBoundingClientRect();
    const cs = getComputedStyle(st);
    ring = {
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      inlineLeft: st.style.left || '(unset)',
      inlineTop: st.style.top || '(unset)',
      computed: `${cs.left} / ${cs.top}`,
      opacity: cs.opacity,
      hasOn: st.classList.contains('on'),
      position: cs.position,
    };
  }
  return {
    // Duplicate HUD layers would mean the positioned ring and the visible ring
    // are different elements, which looks identical to a positioning bug.
    counts: {
      stick: document.querySelectorAll('#tc-stick').length,
      surface: document.querySelectorAll('.tc-surface').length,
      touchLayer: document.querySelectorAll('.bl-touch').length,
    },
    ring,
    stick: hud.touch ? { ...hud.touch.move } : null,
    stickId: hud.touch ? hud.touch._stickId : null,
    move: [+inp.moveX.toFixed(2), +inp.moveY.toFixed(2)],
    pos: [+s.position.x.toFixed(2), +s.position.z.toFixed(2)],
    events: { ...window.__ev },
  };
});

// A real touch: land on the left half, drag upward in steps, hold, release.
const X = 180, Y0 = 250;
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart', touchPoints: [{ x: X, y: Y0, id: 1 }],
});
await page.evaluate(() => window.__step(0.1));
const afterDown = await snap();

for (let i = 1; i <= 6; i++) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x: X, y: Y0 - i * 12, id: 1 }],
  });
  await page.evaluate(() => window.__step(0.15));
}
const midHold = await snap();

// Hold still for two simulated seconds — a real thumb sends no events while
// resting, so the stick must latch.
await page.evaluate(() => window.__step(2.0));
const afterHold = await snap();

await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.evaluate(() => window.__step(0.2));
const afterUp = await snap();

const walked = Math.hypot(afterHold.pos[0] - afterDown.pos[0], afterHold.pos[1] - afterDown.pos[1]);

console.log('after touchStart :', JSON.stringify(afterDown));
console.log('after drag up    :', JSON.stringify(midHold));
console.log('after 2s hold    :', JSON.stringify(afterHold));
console.log('after touchEnd   :', JSON.stringify(afterUp));
console.log(`\nwalked during the hold: ${walked.toFixed(2)} m`);

const ev = afterUp.events;
console.log('\nevent tally:', JSON.stringify(ev, null, 2));
const cancels = (ev['window:pointercancel'] || 0) + (ev['surface:pointercancel'] || 0)
  + (ev['window:touchcancel'] || 0) + (ev['surface:touchcancel'] || 0);
console.log(`\nsurface got pointerdown: ${(ev['surface:pointerdown'] || 0) > 0 ? 'yes' : 'NO — real touch never reaches the hit layer'}`);
console.log(`pointermove delivered:   ${(ev['window:pointermove'] || 0)}`);
console.log(`CANCELS:                 ${cancels}${cancels ? '  <-- the browser stole the gesture' : ''}`);
console.log(`\nVERDICT: real touch ${walked > 2 ? 'WALKS the player' : 'DOES NOT move the player'}`);

await browser.close();
proc.kill();
process.exit(walked > 2 ? 0 : 1);
