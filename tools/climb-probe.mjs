/**
 * CAN THE PLAYER GET UPSTAIRS?
 *
 * The navmesh says bots can reach 16 m2 of the level's 1922 m2 of elevated
 * surface. But the navmesh is the AI's structure — it is voxelised for a 0.42 m
 * agent with a 0.46 m step — and the PLAYER has a mantle. So "bots cannot" is
 * not yet "you cannot", and the player's complaint was about the player.
 *
 * This walks the real controller up each of the level's five staircases and
 * measures the height gained. It also drops the player into the narrowest slot
 * the level probe found and checks whether they can walk back out.
 *
 * THE SIMULATION IS STEPPED BY HAND, and that is the whole reason this probe is
 * trustworthy. This box draws at ~1.5 fps under SwiftShader, and the engine
 * advances the fixed step at most 8 times per frame, so waiting on the frame
 * loop accrues about 0.1 s of simulation per wall second. The first version of
 * this probe held W for 3.5 s of wall clock, got a third of a second of
 * simulation, and reported four of six staircases as unclimbable — when what it
 * had actually measured was a player who never walked the three metres to the
 * bottom step. Stubbing the render module did not help either: with nothing
 * drawing, requestAnimationFrame stops being scheduled and the loop stalls
 * outright.
 *
 * So the probe calls every module's `fixedUpdate(1/120)` itself, in a tight
 * loop, with no dependence on rAF or on the frame rate. 720 steps is six
 * seconds of simulation and takes no measurable time.
 *
 * A CONTROL RUNS FIRST: hold W on open ground for one simulated second and
 * check the player covers roughly a walk speed of ground. If that fails, every
 * "did not climb" below is a broken harness rather than a broken staircase, and
 * the probe says so instead of producing a table of false failures.
 *
 *   PW_CHROMIUM=/opt/pw-browsers/chromium node tools/climb-probe.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

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

// Park the world, make the player untouchable, and install a hand-driven step.
const prep = await page.evaluate(() => {
  const e = window.__engine;
  const ai = e.get('ai');
  if (ai?.actors) for (const a of ai.actors) { a.alive = false; if (a.mesh) a.mesh.visible = false; }
  const m = e.get('match'); if (m) m.paused = true;
  const s = e.get('player').state; s.health = 1e9; s.maxHealth = 1e9;

  /** Advance the simulation `sec` seconds, independent of the frame loop. */
  window.__step = (sec) => {
    const dt = 1 / 120;
    const n = Math.round(sec / dt);
    for (let i = 0; i < n; i++) {
      for (const { module } of e._order) {
        if (typeof module.fixedUpdate === 'function') module.fixedUpdate(dt, e);
      }
    }
    return n;
  };
  window.__hold = (code, down) => window.dispatchEvent(
    new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
  return { steppable: typeof window.__step === 'function', modules: e._order.length };
});

// CONTROL: one simulated second of walking on open ground.
const control = await page.evaluate(() => {
  const e = window.__engine;
  const p = e.get('player'), s = p.state;
  s.position.set(0, 1.4, 20); s.velocity.set(0, 0, 0); s.yaw = Math.PI; s.pitch = 0;
  p.controller.reset(s.position.clone());
  window.__step(0.5);
  const p0 = { x: s.position.x, z: s.position.z };
  window.__hold('KeyW', true);
  const steps = window.__step(1.0);
  window.__hold('KeyW', false);
  return {
    steps,
    movedM: +Math.hypot(s.position.x - p0.x, s.position.z - p0.z).toFixed(2),
    grounded: s.grounded,
  };
});
console.log(`[prep] ${JSON.stringify(prep)}`);
console.log(`[control] 1.0 s of stepped simulation moved the player ${control.movedM} m (grounded ${control.grounded}, ${control.steps} steps)`);
if (control.movedM < 1.5) {
  console.log('\nCONTROL FAILED — the player is not walking under hand-stepping, so any');
  console.log('"did not climb" result below would be meaningless. Fix the harness first.');
  await browser.close(); proc.kill(); process.exit(2);
}

/* The level's real staircases, read out of LevelModule.js. `height` is the top
 * of the flight; the player's position.y is capsule CENTRE, about 0.87 m above
 * whatever they stand on, so success means position.y ~ height + 0.87. */
const STAIRS = [
  { name: 'west row exterior flight -> 6.4 m landing', x: -32.4, z: 14.0, height: 6.4, width: 2.4 },
  { name: 'souk house -> mezzanine', x: -24.4, z: -11.6, height: 3.2, width: 1.5 },
  { name: 'market hall podium south', x: 0, z: -10.35, height: 1.6, width: 4.2 },
  { name: 'market hall podium north', x: 0, z: 10.35, height: 1.6, width: 4.2 },
  { name: 'east row -> roof', x: 10.7, z: 0, height: 5.5, width: 1.5 },
  { name: 'garage -> mezzanine', x: 22.4, z: -4.6, height: 3.0, width: 1.3 },
];

const results = [];
for (const st of STAIRS) {
  // Try all four approaches rather than deducing the facing from the yaw the
  // builder was given: a wrong guess would report a working stair as broken.
  const attempts = [];
  for (const [label, ox, oz, yaw] of [
    ['from -Z', 0, -3.0, Math.PI],     // stand south of it, face +Z
    ['from +Z', 0, 3.0, 0],            // stand north, face -Z
    ['from -X', -3.0, 0, -Math.PI / 2],
    ['from +X', 3.0, 0, Math.PI / 2],
  ]) {
    const r = await page.evaluate(async ({ x, z, ox, oz, yaw }) => {
      const e = window.__engine;
      const p = e.get('player');
      const s = p.state;
      s.position.set(x + ox, 1.4, z + oz);
      s.velocity.set(0, 0, 0);
      s.yaw = yaw; s.pitch = 0;
      p.controller.reset(s.position.clone());
      window.__step(0.5);                       // settle onto the ground
      const y0 = s.position.y;
      const startXZ = { x: s.position.x, z: s.position.z };
      window.__hold('KeyW', true);
      // Eight simulated seconds, sampled every tenth of a second. A jump is
      // pulsed periodically because a real player hops at a step they catch on,
      // and the mantle only triggers against a ledge while airborne or pressed.
      let peak = y0, mantles = 0;
      for (let i = 0; i < 80; i++) {
        window.__step(0.1);
        if (s.position.y > peak) peak = s.position.y;
        if (s.mantling) mantles++;
        if (i % 12 === 11) { window.__hold('Space', true); window.__step(0.05); window.__hold('Space', false); }
      }
      window.__hold('KeyW', false);
      return {
        startY: +y0.toFixed(2), peakY: +peak.toFixed(2), gain: +(peak - y0).toFixed(2),
        mantleFrames: mantles,
        walkedM: +Math.hypot(s.position.x - startXZ.x, s.position.z - startXZ.z).toFixed(2),
        endPos: [+s.position.x.toFixed(1), +s.position.y.toFixed(2), +s.position.z.toFixed(1)],
      };
    }, { x: st.x, z: st.z, ox, oz, yaw });
    attempts.push({ approach: label, ...r });
  }
  const best = attempts.reduce((a, b) => (b.gain > a.gain ? b : a));
  // Standing on top means the capsule centre is ~0.87 above the surface.
  const climbed = best.peakY >= st.height + 0.5;
  results.push({ stair: st.name, targetHeight: st.height, widthM: st.width, best, climbed, attempts });
  console.log(`[stair] ${st.name}\n        target ${st.height} m, best gain ${best.gain} m (${best.approach}), peak y ${best.peakY} -> ${climbed ? 'CLIMBED' : 'DID NOT CLIMB'}`);
}

/* --- the narrow slot: can the player get in, and back out? --------------- */
const slot = await page.evaluate(async () => {
  const e = window.__engine;
  const p = e.get('player');
  const s = p.state;
  // The longest sub-metre slot the level probe found: 8.3 m long, 0.52 m wide.
  s.position.set(39.5, 1.4, -22.0);
  s.velocity.set(0, 0, 0); s.yaw = Math.PI; s.pitch = 0;
  p.controller.reset(s.position.clone());
  window.__step(0.6);
  const start = { x: s.position.x, z: s.position.z, y: s.position.y };
  const inside = Math.abs(s.position.x - 39.5) < 1.2 && Math.abs(s.position.z + 22.0) < 1.5;
  // Try to walk out in all four directions.
  const escapes = [];
  for (const [label, yaw] of [['+Z', Math.PI], ['-Z', 0], ['-X', -Math.PI / 2], ['+X', Math.PI / 2]]) {
    s.position.set(39.5, 1.4, -22.0); s.velocity.set(0, 0, 0); s.yaw = yaw;
    p.controller.reset(s.position.clone());
    window.__step(0.4);
    const p0 = { x: s.position.x, z: s.position.z };
    window.__hold('KeyW', true);
    window.__step(4.0);
    window.__hold('KeyW', false);
    escapes.push({
      dir: label,
      movedM: +Math.hypot(s.position.x - p0.x, s.position.z - p0.z).toFixed(2),
      end: [+s.position.x.toFixed(1), +s.position.z.toFixed(1)],
    });
  }
  return { spawnedInside: inside, settledAt: [+start.x.toFixed(1), +start.y.toFixed(2), +start.z.toFixed(1)], escapes };
});
console.log('\n[narrow slot at x 39.5, z -22 (8.3 m long, 0.52 m wide)]');
console.log(JSON.stringify(slot, null, 2));

await writeFile('shots/climb-probe.json', JSON.stringify({ control, results, slot }, null, 2));
const climbable = results.filter((r) => r.climbed).length;
console.log(`\n=== ${climbable}/${results.length} staircases are climbable by the player ===`);
for (const r of results) if (!r.climbed) console.log(`  UNREACHABLE: ${r.stair} (best gain ${r.best.gain} m of ${r.targetHeight} m)`);

await browser.close();
proc.kill();
process.exit(0);
