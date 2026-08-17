/**
 * STAIR PROFILE — where exactly does a flight stop being walkable?
 *
 * Two of the level's six staircases strand the player about halfway up, and
 * they are the only two that reach a roof: the west row's 6.4 m exterior flight
 * and the east row's 5.5 m roof stair. The flights themselves are shallow
 * (rise 0.175, going 0.29, so about 31 degrees) and each has a single ramp
 * collision proxy, so the slope is not the problem.
 *
 * So this walks the flight's centreline in small steps and, at each one, casts a
 * ray DOWN to find the surface the player would stand on and a ray UP from head
 * height to find whatever is above it. A flight that is fine in geometry but
 * blocked by a slab, an awning or its own landing shows up immediately as either
 * a break in the ascending profile or a ceiling that drops below head height.
 *
 * Both rays go through the real collision BVH — the same geometry the capsule
 * sweeps against — not through the render meshes.
 *
 *   PW_CHROMIUM=/opt/pw-browsers/chromium node tools/stair-profile.mjs
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
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}?quality=low&nofrontend=1`, { waitUntil: 'load' });
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 300000 });
await page.waitForTimeout(1500);

// The two failing flights, plus one that works as a control.
const FLIGHTS = [
  { name: 'west row exterior -> 6.4 m landing', x: -32.4, z: 14.0, yaw: -Math.PI / 2, height: 6.4, width: 2.4 },
  { name: 'east row -> roof (5.5 m)', x: 10.7, z: 0, yaw: 0, height: 5.5, width: 1.5 },
  { name: 'CONTROL souk house -> mezzanine (3.2 m)', x: -24.4, z: -11.6, yaw: 0, height: 3.2, width: 1.5 },
];

for (const f of FLIGHTS) {
  const out = await page.evaluate((f) => {
    const e = window.__engine;
    const col = e.get('collision');
    const rc = col._raycaster;
    const V3 = e.camera.position.constructor;
    const target = col.collider || col.mesh || col.root;
    if (!target) return { error: 'no collider mesh on the collision module' };

    // The flight ascends along its local +Z, rotated by yaw. rise/going come
    // from the kit's SCALE, so len is steps * going.
    const RISE = 0.175, GOING = 0.29;
    const steps = Math.max(1, Math.round(f.height / RISE));
    const len = steps * GOING;
    const dirX = -Math.sin(f.yaw), dirZ = -Math.cos(f.yaw);   // local -Z in world
    const PLAYER_H = 1.74;

    const rows = [];
    // `along` runs DOWNHILL: measurement showed the ramp's top at along 0 and
    // its base at along = len, so the ramp surface is height * (1 - t/len).
    //
    // HEADROOM MUST BE MEASURED FROM THE RAMP, NOT FROM THE TOPMOST SURFACE.
    // The first version of this probe cast its up-ray from whatever a downward
    // ray hit first, which for the upper half of the flight is the LANDING
    // ABOVE IT — so it measured the sky over the landing and reported infinite
    // headroom over a stair the player cannot fit through. The ramp surface is
    // computed analytically and the down-ray is used only to CHECK that model.
    for (let t = 0; t <= len; t += 0.35) {
      const s = t - len / 2;
      const wx = f.x + dirX * s, wz = f.z + dirZ * s;
      const yRamp = f.height * (1 - t / len);

      // Check the analytic ramp against the collider: start below anything that
      // could be overhead and look down.
      rc.set(new V3(wx, yRamp + 1.60, wz), new V3(0, -1, 0));
      rc.far = 4;
      rc.firstHitOnly = true;
      const down = rc.intersectObject(target, true)[0];
      const surf = down ? +(yRamp + 1.60 - down.distance).toFixed(2) : null;

      // Headroom above the ramp the player actually walks on.
      rc.set(new V3(wx, yRamp + 0.12, wz), new V3(0, 1, 0));
      rc.far = 14;
      const up = rc.intersectObject(target, true)[0];
      const head = up ? +(up.distance + 0.12).toFixed(2) : null;

      rows.push({
        alongM: +t.toFixed(2),
        at: [+wx.toFixed(1), +wz.toFixed(1)],
        rampY: +yRamp.toFixed(2),
        surfaceY: surf,
        headroomM: head,
      });
    }
    return { steps, lenM: +len.toFixed(2), slopeDeg: +((Math.atan2(f.height, len) * 180) / Math.PI).toFixed(1), rows };
  }, f);

  console.log(`\n=== ${f.name} ===`);
  if (out.error) { console.log('  ' + out.error); continue; }
  console.log(`  ${out.steps} steps, ${out.lenM} m long, ${out.slopeDeg} deg`);
  const PLAYER_H = 1.74;
  console.log('  along   at             rampY  colliderY  headroom');
  let blocked = [], modelOff = [];
  for (const r of out.rows) {
    const low = r.headroomM != null && r.headroomM < PLAYER_H;
    const off = r.surfaceY != null && Math.abs(r.surfaceY - r.rampY) > 0.35;
    console.log(`  ${String(r.alongM).padStart(5)}  ${JSON.stringify(r.at).padEnd(13)} ${String(r.rampY).padStart(6)}  ${String(r.surfaceY).padStart(9)}  ${String(r.headroomM).padStart(7)}`
      + `${low ? `  <-- BLOCKED, needs ${PLAYER_H} m` : ''}${off ? '  <-- ramp model disagrees with collider' : ''}`);
    if (low) blocked.push(r.alongM);
    if (off) modelOff.push(r.alongM);
  }
  if (modelOff.length) {
    console.log(`  NOTE: analytic ramp disagrees with the collider at along = ${modelOff.slice(0, 6).join(', ')}${modelOff.length > 6 ? ' ...' : ''}`);
    console.log('        (so treat the headroom column there as unverified)');
  }
  if (blocked.length) {
    const lo = Math.min(...blocked), hi = Math.max(...blocked);
    console.log(`  ==> HEADROOM BELOW ${PLAYER_H} m from along ${lo} m to ${hi} m `
      + `(ramp y ${(out.rows.find((r) => r.alongM === hi)?.rampY)} .. ${(out.rows.find((r) => r.alongM === lo)?.rampY)})`);
  } else {
    console.log('  ==> headroom is clear for the whole flight');
  }
}

await browser.close();
proc.kill();
process.exit(0);
