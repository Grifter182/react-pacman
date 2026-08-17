/**
 * MINIMAP ORIENTATION PROBE — does the drawn map agree with the world?
 *
 * The player reported "the map rotates the wrong direction according to my
 * movement". A rotating minimap has two things to get right and they fail in
 * ways that look alike on screen:
 *
 *   1. HANDEDNESS. A top-down plan is a view from ABOVE, which is a constraint,
 *      not a taste: looking down -Y, the screen basis must satisfy
 *      `right x up = +Y`. Break it and the plan is mirrored — every landmark on
 *      the wrong side, and turning spins it with you instead of against you.
 *   2. ROTATION SIGN. Even on a correct plan, rotating by +a instead of -a spins
 *      the world the wrong way.
 *
 * WHY THIS PROBE READS PIXELS. The obvious test — "does forward point up?" —
 * passes on a mirrored map at every yaw, which is exactly how the bug survived.
 * And a probe that re-implements the map's own projection can agree with itself
 * while disagreeing with what is drawn. So this asks the real HUD to render, and
 * then looks at the canvas:
 *
 *   - put a friendly blip at the player's true RIGHT (three.js supplies the
 *     vector; no algebra here), render, and see which half of the disc it lands
 *     in. It must be the right half.
 *   - put a blip dead ahead, render, turn the player RIGHT, render again, and
 *     check the blip travelled LEFT across the canvas.
 *
 * The floorplan and the blips are not separately at risk: the plan's raster maps
 * a world point to ((span-(X-ox))*s, (span-(Z-oz))*s) and the per-frame translate
 * subtracts the player's own value in the same form, so a point lands at
 * (-(X-px)*ppm, -(Z-pz)*ppm) — identical to the blip mapping. Testing the blip
 * path therefore tests the convention both use.
 *
 *   PW_CHROMIUM=/opt/pw-browsers/chromium node tools/map-orient-probe.mjs
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}?quality=low&nofrontend=1`, { waitUntil: 'load' });
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 300000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const e = window.__engine;
  const cam = e.camera;
  const V3 = cam.position.constructor;
  const Q = cam.quaternion.constructor;
  const map = e.get('hud').map;
  if (!map) return { error: 'no minimap' };

  map._resize();
  const S = map.canvas.width;
  if (S < 8) return { error: `minimap canvas is ${S}px — HUD not laid out` };
  const R = S / 2;
  const VIEW_RADIUS = 34;                 // must match Minimap.js
  const ppm = R / VIEW_RADIUS;
  const DIST = 14;                        // metres out; well inside the disc

  /** Render one frame of the map with a synthetic state and return the canvas. */
  const draw = (yaw, allies) => {
    const pos = new V3(0, 1.6, 0);
    map._yaw = yaw;                       // bypass the damping so the frame is exact
    map._blips.length = 0;
    map.update(1, { position: pos, yaw, alive: true, allies, actors: null, uavActive: false });
    return map.ctx.getImageData(0, 0, S, S).data;
  };

  /** Peak "ally blue" (120,206,255) inside a window, as a 0..1 score. */
  const scoreAt = (data, cx, cy, win = 7) => {
    let best = 0;
    for (let y = Math.round(cy - win); y <= Math.round(cy + win); y++) {
      for (let x = Math.round(cx - win); x <= Math.round(cx + win); x++) {
        if (x < 0 || y < 0 || x >= S || y >= S) continue;
        const i = (y * S + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        // The ally blip is the only strongly blue-dominant bright mark; the
        // view cone is far dimmer and sits at the top of the disc.
        if (b > 170 && g > 130 && r < 190 && b > r + 45) {
          const s = (b / 255) * ((b - r) / 255);
          if (s > best) best = s;
        }
      }
    }
    return +best.toFixed(4);
  };

  const rows = [];
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    cam.rotation.set(0, yaw, 0);
    cam.updateMatrixWorld(true);
    const q = cam.getWorldQuaternion(new Q());
    const right = new V3(1, 0, 0).applyQuaternion(q);
    const fwd = new V3(0, 0, -1).applyQuaternion(q);

    // One ally, standing on the player's true right, DIST metres away.
    const data = draw(yaw, [{ x: right.x * DIST, z: right.z * DIST }]);
    const onRight = scoreAt(data, R + DIST * ppm, R);
    const onLeft = scoreAt(data, R - DIST * ppm, R);
    rows.push({
      yawDeg: Math.round((yaw * 180) / Math.PI),
      worldRight: [+right.x.toFixed(2), +right.z.toFixed(2)],
      worldForward: [+fwd.x.toFixed(2), +fwd.z.toFixed(2)],
      blipScoreRightHalf: onRight,
      blipScoreLeftHalf: onLeft,
      drawnOn: onRight > onLeft ? 'RIGHT' : onLeft > onRight ? 'LEFT' : 'neither',
    });
  }

  /* --- turning right must sweep a forward landmark to the LEFT ------------ */
  // Turning right feeds a negative yaw delta: InputMap.drainLook negates the
  // pointer's X, so mouse-right decreases yaw.
  const yaw0 = Math.PI;                        // facing +Z
  cam.rotation.set(0, yaw0, 0); cam.updateMatrixWorld(true);
  const fwd0 = new V3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new Q()));
  const landmark = { x: fwd0.x * DIST, z: fwd0.z * DIST };

  const findBlipX = (yaw) => {
    const data = draw(yaw, [landmark]);
    let bx = null, best = 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (b > 170 && g > 130 && r < 190 && b > r + 45) {
          const s = (b / 255) * ((b - r) / 255);
          if (s > best) { best = s; bx = x; }
        }
      }
    }
    return bx === null ? null : +(bx - R).toFixed(1);
  };

  const track = [0, -0.4, -0.8].map((d) => ({ yawDelta: d, blipX: findBlipX(yaw0 + d) }));

  return {
    canvasPx: S,
    rows,
    turnRightTrack: track,
    rightAlwaysDrawnRight: rows.every((r) => r.drawnOn === 'RIGHT'),
    landmarkSweepsLeft: track[0].blipX !== null && track[2].blipX !== null
      && track[2].blipX < track[0].blipX - 4,
  };
});

console.log(JSON.stringify(out, null, 2));
if (out.error) { console.log('\nPROBE COULD NOT RUN: ' + out.error); }
else {
  console.log(`\nplayer's right drawn on the right at all yaws: ${out.rightAlwaysDrawnRight ? 'yes' : 'NO — MAP IS MIRRORED'}`);
  console.log(`landmark sweeps left on a right turn:            ${out.landmarkSweepsLeft ? 'yes' : 'NO — ROTATES WRONG WAY'}`);
}

await browser.close();
proc.kill();
process.exit(out.error || !out.rightAlwaysDrawnRight || !out.landmarkSweepsLeft ? 1 : 0);
