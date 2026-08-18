/**
 * WHY CAN THE PLAYER NEVER FIND THE ENEMIES?
 *
 * The player: "the map barely feels playable, I can never find the enemies,
 * they are like ghosts." That is a report about an EXPERIENCE, and it has at
 * least six mechanically different causes, which is why it needs measuring
 * rather than theorising:
 *
 *   1. there are too few of them for the space
 *   2. they are far away nearly all the time
 *   3. they are near but behind geometry — the level is too occluding
 *   4. they are near and in the open but not RENDERED (culled, LOD'd, a
 *      `visible` flag, a material that never faded in) — literally ghosts
 *   5. they die and respawn so often that any contact evaporates
 *   6. they never move, so the player has to walk onto them
 *
 * Each leaves a different fingerprint, so this samples all of them at once:
 * how many are alive, how far away, whether the line of sight is clear, whether
 * the mesh is actually visible and in the frustum, how far they travel, and how
 * often they die.
 *
 * THE SIMULATION IS HAND-STEPPED. This box renders at ~1.5 fps and the engine
 * takes at most 8 fixed steps per frame, so waiting on the frame loop yields
 * about 0.1 s of game time per wall second — a minute of wall clock would be six
 * seconds of match, in which nothing happens and every count reads zero. Both
 * `fixedUpdate` and `update` are driven directly at their real cadences, which
 * is the same technique climb-probe.mjs needed and for the same reason.
 *
 * A CONTROL RUNS FIRST: the bots must actually travel some distance under
 * hand-stepping. If they do not, every "never seen" number below is a stalled
 * harness rather than a design fault, and the probe says so instead of
 * producing a confident table of zeroes.
 *
 *   PW_CHROMIUM=/opt/pw-browsers/chromium node tools/enemy-probe.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const PORT = 5200 + Math.floor(Math.random() * 3000);
const SIM_SECONDS = 60;

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
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}?quality=low&nofrontend=1&bots=${process.env.BOTS || 7}`, { waitUntil: 'load' });
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 300000 });
await page.waitForTimeout(1500);

await page.evaluate(() => {
  const e = window.__engine;
  // Drive the sim directly: fixed steps at 120 Hz, a variable update every 1/60.
  window.__step = (sec) => {
    const dt = 1 / 120;
    const n = Math.round(sec / dt);
    for (let i = 0; i < n; i++) {
      for (const { module } of e._order) if (module.fixedUpdate) module.fixedUpdate(dt, e);
      if (i % 2 === 1) {
        for (const { module } of e._order) if (module.update) module.update(1 / 60, e);
      }
    }
  };
  const s = e.get('player').state;
  s.health = 1e9; s.maxHealth = 1e9;
  // WHERE THE PLAYER STANDS IS PART OF THE MEASUREMENT. The first run parked
  // them at (0,0), which is the market hall podium and quite possibly inside
  // the hall — a position that would occlude the whole map and manufacture the
  // very result being looked for. So the sweep runs from several real places:
  // the team's own spawn, the close-quarters alley, the open motor yard, and
  // the plaza. A finding that survives all four is about the game; one that
  // only appears at (0,0) was about (0,0).
  window.__place = (x, z) => {
    const st = e.get('player').state;
    st.position.set(x, 1.0, z); st.velocity.set(0, 0, 0); st.yaw = Math.PI; st.pitch = 0;
    e.get('player').controller.reset(st.position.clone());
  };
});

const control = await page.evaluate(() => {
  const e = window.__engine;
  const ai = e.get('ai');
  if (!ai?.actors?.length) return { error: 'no actors' };
  const p0 = ai.actors.map((a) => ({ x: a.position.x, z: a.position.z }));
  window.__step(5);
  let moved = 0;
  ai.actors.forEach((a, i) => { moved += Math.hypot(a.position.x - p0[i].x, a.position.z - p0[i].z); });
  return { actors: ai.actors.length, totalTravelIn5s: +moved.toFixed(1) };
});
console.log('[control]', JSON.stringify(control));
if (control.error || control.totalTravelIn5s < 2) {
  console.log('\nCONTROL FAILED — bots are not moving under hand-stepping, so every');
  console.log('number below would be a harness artefact. Fix that before reading on.');
  await browser.close(); proc.kill(); process.exit(2);
}

const SPOTS = [
  ['team spawn (south)', 0, -40],
  ['the alley (close quarters)', -29, 0],
  ['motor yard (open lane)', 34, 0],
  ['plaza centre', 0, 0],
];
const all = [];
for (const [label, px, pz] of SPOTS) {
await page.evaluate(({ px, pz }) => window.__place(px, pz), { px, pz });
const out = await page.evaluate(async ({ SIM_SECONDS }) => {
  const e = window.__engine;
  const THREE_V3 = e.camera.position.constructor;
  const ai = e.get('ai');
  const col = e.get('collision');
  const cam = e.camera;
  const s = e.get('player').state;

  const samples = [];
  let deaths = 0;
  const wasAlive = new Map();
  const travel = new Map();
  const lastPos = new Map();
  for (const a of ai.actors) { lastPos.set(a, { x: a.position.x, z: a.position.z }); travel.set(a, 0); }

  const frustum = new (cam.projectionMatrix.constructor === Object ? Object : Object)();
  const steps = SIM_SECONDS / 0.5;
  for (let i = 0; i < steps; i++) {
    window.__step(0.5);
    cam.updateMatrixWorld(true);

    let alive = 0, visible = 0, inFov = 0, losClear = 0, nearest = Infinity;
    const dists = [];
    for (const a of ai.actors) {
      const was = wasAlive.get(a);
      if (was && !a.alive) deaths++;
      wasAlive.set(a, a.alive);
      const lp = lastPos.get(a);
      if (lp) travel.set(a, travel.get(a) + Math.hypot(a.position.x - lp.x, a.position.z - lp.z));
      lastPos.set(a, { x: a.position.x, z: a.position.z });
      if (!a.alive) continue;
      alive++;

      const d = Math.hypot(a.position.x - s.position.x, a.position.z - s.position.z);
      dists.push(d);
      if (d < nearest) nearest = d;

      // Is the mesh actually being drawn?
      const mesh = a.mesh || a.root;
      const meshVisible = !!mesh && mesh.visible !== false;
      if (meshVisible) visible++;

      // Is it in front of the player, within a generous FOV?
      const to = new THREE_V3(a.position.x - cam.position.x, 0, a.position.z - cam.position.z).normalize();
      const fwd = new THREE_V3(0, 0, -1).applyQuaternion(cam.quaternion);
      fwd.y = 0; fwd.normalize();
      const facing = to.dot(fwd) > Math.cos(0.9);   // ~103 deg cone
      if (facing) inFov++;

      // Is the line of sight actually clear of level geometry?
      if (facing && d < 60) {
        const origin = new THREE_V3(cam.position.x, cam.position.y, cam.position.z);
        const dir = new THREE_V3(a.position.x - cam.position.x,
          (a.position.y + 0.9) - cam.position.y, a.position.z - cam.position.z);
        const len = dir.length(); dir.normalize();
        const hit = col.raycast ? col.raycast(origin, dir, len - 0.6) : null;
        if (!hit) losClear++;
      }
    }
    dists.sort((x, y) => x - y);
    samples.push({
      alive, visible, inFov, losClear,
      nearest: nearest === Infinity ? null : +nearest.toFixed(1),
      median: dists.length ? +dists[Math.floor(dists.length / 2)].toFixed(1) : null,
    });
  }

  const n = samples.length;
  const sum = (f) => samples.reduce((acc, x) => acc + f(x), 0);
  const withLos = samples.filter((x) => x.losClear > 0).length;
  const near25 = samples.filter((x) => x.nearest != null && x.nearest < 25).length;
  const nearestAll = samples.map((x) => x.nearest).filter((x) => x != null).sort((a, b) => a - b);
  return {
    simSeconds: SIM_SECONDS,
    samples: n,
    rosterSize: ai.actors.length,
    meanAlive: +(sum((x) => x.alive) / n).toFixed(2),
    meanMeshVisible: +(sum((x) => x.visible) / n).toFixed(2),
    // The headline: how often is ANY enemy both in front of the player and not
    // behind a wall? That is the number that decides whether a match has fights.
    pctSamplesWithAClearShot: +((withLos / n) * 100).toFixed(1),
    pctSamplesWithSomeoneWithin25m: +((near25 / n) * 100).toFixed(1),
    nearestEnemyMedianM: nearestAll.length ? +nearestAll[Math.floor(nearestAll.length / 2)].toFixed(1) : null,
    nearestEnemyBestM: nearestAll.length ? +nearestAll[0].toFixed(1) : null,
    deaths,
    deathsPerMinute: +((deaths / SIM_SECONDS) * 60).toFixed(1),
    botTravelMedianM: (() => {
      const t = [...travel.values()].sort((a, b) => a - b);
      return t.length ? +t[Math.floor(t.length / 2)].toFixed(1) : null;
    })(),
  };
}, { SIM_SECONDS });
all.push({ where: label, ...out });
console.log(`[${label}] clearShot ${out.pctSamplesWithAClearShot}%  within25m ${out.pctSamplesWithSomeoneWithin25m}%  `
  + `nearestMedian ${out.nearestEnemyMedianM}m  nearestEver ${out.nearestEnemyBestM}m  `
  + `alive ${out.meanAlive} visible ${out.meanMeshVisible}  deaths/min ${out.deathsPerMinute}`);
}
await writeFile('shots/enemy-probe.json', JSON.stringify(all, null, 2));
console.log('\n=== READING ===');
const worstNear = Math.min(...all.map((a) => a.nearestEnemyBestM ?? 999));
const anyGhost = all.some((a) => a.meanAlive > 0 && a.meanMeshVisible < a.meanAlive - 0.5);
console.log(`closest any enemy ever came, across every position: ${worstNear} m`);
console.log(`living enemies with an undrawn mesh anywhere: ${anyGhost ? 'YES — literally ghosts' : 'no — they are drawn'}`);
console.log(`clear-shot share by position: ${all.map((a) => `${a.where} ${a.pctSamplesWithAClearShot}%`).join(' | ')}`);

await browser.close();
proc.kill();
process.exit(0);
