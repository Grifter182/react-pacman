/**
 * SIGHT-LINE PROBE — does the player actually see through the optic?
 *
 * Boots the real game in Chromium (SwiftShader), forces full ADS through the
 * real animator (no pose faking), then casts a ray from the viewmodel camera
 * origin straight down its -Z axis and lists every viewmodel mesh the ray hits
 * inside 0.6 m, with the merged-buffer part label, material slot and distance.
 *
 * Acceptance: the only things on the axis are lens glass (and the collimated
 * reticle, which is drawn at optical infinity). Anything else — a rail, a gas
 * block, an iron sight, a hand — is sitting in the aperture.
 *
 * Every stage is a separate `page.evaluate` with its own node-side timing line,
 * because a single fat one hangs opaquely and tells you nothing about where.
 *
 *   PW_CHROMIUM=/opt/pw-browsers/chromium node tools/sightline-probe.mjs
 *   ... --weapon rifle,smg,dmr --out shots/sightline
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const OUT = path.resolve(arg('out', 'shots/sightline'));
const PORT = parseInt(arg('port', String(5200 + Math.floor(Math.random() * 3000))), 10);
const WEAPONS = arg('weapon', 'rifle,smg,dmr').split(',');
const FAR = parseFloat(arg('far', '0.6'));

const T0 = Date.now();
const say = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

async function startServer() {
  const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start in 30s')), 30000);
    proc.stdout.on('data', (d) => {
      if (/Local:|ready in/i.test(String(d))) { clearTimeout(timer); setTimeout(resolve, 400); }
    });
    proc.on('exit', (c) => { clearTimeout(timer); reject(new Error(`vite exited ${c}`)); });
  });
  return { url: `http://127.0.0.1:${PORT}`, kill: () => proc.kill('SIGTERM') };
}

await mkdir(OUT, { recursive: true });
const server = await startServer();
say(`vite up at ${server.url}`);

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage',
    '--no-sandbox', '--mute-audio',
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text()}`);
  if (/^\[probe]/.test(m.text())) say(`page: ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));

await page.goto(`${server.url}?quality=high`, { waitUntil: 'load', timeout: 120000 });
say('page loaded, waiting for first frame');
await page.waitForFunction(
  () => document.body.dataset.ready === '1' || document.querySelector('pre'),
  null, { timeout: 900000 },
).catch(() => logs.push('[probe] timed out waiting for first frame'));
say('first frame presented');

const boot = await page.evaluate(() => {
  const pre = document.querySelector('pre');
  return { failed: !!pre, message: pre ? pre.textContent : null };
});
if (boot.failed) {
  console.error('BOOT FAILURE:\n' + boot.message);
  await writeFile(path.join(OUT, 'BOOT-FAILURE.txt'), boot.message);
  await browser.close(); server.kill(); process.exit(1);
}

/* three is bundled, not global. Rather than loading a second copy (whose
 * classes would not be the ones the scene was built with), harvest the
 * constructors from live instances inside the running game, and install the
 * helpers every stage shares. */
const ready = await page.evaluate(() => {
  const e = window.__engine;
  const rc = e.get('collision')?._raycaster;
  if (!rc) return 'collision module has no raycaster to borrow';
  const V3 = e.camera.position.constructor;
  window.__T = { V3, Q: e.camera.quaternion.constructor, RC: rc.constructor };

  /** Meshes actually drawn in the viewmodel scene, this frame. */
  window.__vmMeshes = () => {
    const out = [];
    window.__engine.viewmodelScene.traverseVisible((o) => { if (o.isMesh) out.push(o); });
    return out;
  };

  /** Name a hit: mesh, authored part label from the merged buffer, slot, material. */
  window.__label = (h) => {
    const g = h.object.geometry;
    const parts = g.userData && g.userData.parts;
    const vi = h.face ? h.face.a : -1;
    let part = null;
    if (parts) for (const q of parts) if (vi >= q.start && vi < q.start + q.count) { part = q; break; }
    const m = h.object.material;
    const mat = Array.isArray(m) ? m[h.face ? h.face.materialIndex : 0] : m;
    const mesh = h.object.name || '(unnamed)';
    const material = (mat && (mat.name || (mat.userData && mat.userData.preset))) || '(unnamed)';
    const slot = part ? part.slot : (h.face ? h.face.materialIndex : null);
    // Optical classification. `glass` and `reticle` are what the player is
    // SUPPOSED to see through; `overlay` is the DMR's screen-space sight
    // picture, which is a quad on the camera rather than a part of the gun;
    // anything else is a solid object sitting in the aperture.
    let kind = 'BLOCKER';
    if (/^lens(Rear|Front)$/.test(mesh) || material === 'lensGlass' || slot === 5) kind = 'glass';
    else if (mesh === 'reticle' || material === 'reticleEmitter' || slot === 6) kind = 'reticle';
    else if (mesh === 'ScopeOverlay') kind = 'overlay';
    return { mesh, part: part ? part.label : null, slot, material, kind, distance: +h.distance.toFixed(4) };
  };

  /** The eye ray: viewmodel camera origin, straight down its own -Z. */
  window.__eyeRay = () => {
    const cam = window.__engine.viewmodelCamera;
    cam.updateMatrixWorld(true);
    const origin = new V3().setFromMatrixPosition(cam.matrixWorld);
    const dir = new V3(0, 0, -1)
      .applyQuaternion(cam.getWorldQuaternion(new window.__T.Q())).normalize();
    return { origin, dir };
  };
  return 'ok';
});
if (ready !== 'ok') { console.error(ready); await browser.close(); server.kill(); process.exit(1); }
say('page helpers installed');

const results = [];
for (const id of WEAPONS) {
  /* --- 1. equip ------------------------------------------------------- */
  await page.evaluate(async (w) => {
    const mod = window.__engine.get('weapons');
    if (mod.current !== w) { mod._equip(w, true); mod._switching = false; }
    await new Promise((r) => requestAnimationFrame(r));
  }, id);
  say(`${id}: equipped`);

  /* --- 2. force full ADS through the real animator --------------------- */
  const ads = await page.evaluate(async () => {
    const e = window.__engine;
    const w = e.get('weapons');
    const p = e.get('player');
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    let n = 0;
    const t0 = performance.now();
    while (n < 400 && performance.now() - t0 < 60000) {
      p.state.ads = true; p.state.sprinting = false; p.state.velocity.set(0, 0, 0);
      w.reloading = false; w._switching = false; w.firing = false;
      await frame();
      n++;
      if (w.animator.adsBlend >= 0.9999 && n > 30) break;
    }
    return { frames: n, adsBlend: +w.animator.adsBlend.toFixed(4), moduleBlend: +w._adsBlend.toFixed(4) };
  });
  say(`${id}: ADS blend ${ads.adsBlend} after ${ads.frames} frames`);

  /* --- 3. the axial ray ------------------------------------------------ */
  const axial = await page.evaluate((far) => {
    const T = window.__T;
    const { origin, dir } = window.__eyeRay();
    const rc = new T.RC(origin, dir, 0, far);
    rc.firstHitOnly = false;
    const hits = rc.intersectObjects(window.__vmMeshes(), false).map(window.__label);
    const b = window.__engine.get('weapons').weapon;
    return {
      origin: origin.toArray().map((v) => +v.toFixed(4)),
      direction: dir.toArray().map((v) => +v.toFixed(4)),
      eyeRelief: b.sight ? +b.sight.eyeRelief.toFixed(4) : null,
      apertureR: b.sight ? +b.sight.glassR.toFixed(4) : null,
      meshes: window.__vmMeshes().length,
      hits,
    };
  }, FAR);
  say(`${id}: axial ray hit ${axial.hits.length} mesh face(s) within ${FAR} m`);

  /* --- 4. the fan, as corroboration ------------------------------------ */
  const fan = await page.evaluate((far) => {
    const T = window.__T;
    const e = window.__engine;
    const w = e.get('weapons');
    const b = w.weapon;
    const { origin, dir } = window.__eyeRay();
    const cam = e.viewmodelCamera;
    const R = (b.sight && b.sight.glassR) || 0.010;
    // Aperture centre expressed in camera space, so the fan is aimed at the
    // glass rather than at a guessed direction.
    const gc = new T.V3().setFromMatrixPosition(b.sight.group.matrixWorld)
      .applyMatrix4(cam.matrixWorld.clone().invert());
    const meshes = window.__vmMeshes();
    const rc = new T.RC(origin, dir, 0, far);
    rc.firstHitOnly = false;
    const blockers = {};
    const rings = [];
    let rays = 0, blocked = 0;
    for (const f of [0, 0.3, 0.6, 0.9]) {
      const n = f === 0 ? 1 : 12;
      let ringBlocked = 0;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const target = new T.V3(gc.x + Math.cos(a) * R * f, gc.y + Math.sin(a) * R * f, gc.z)
          .applyMatrix4(cam.matrixWorld);
        rc.set(origin, target.sub(origin).normalize());
        rays++;
        let solid = false;
        for (const h of rc.intersectObjects(meshes, false).map(window.__label)) {
          if (h.kind !== 'BLOCKER') continue;
          solid = true;
          // Clock position, so "which part of the sight picture" is answerable:
          // 12 o'clock is up, 3 is the shooter's right.
          const clock = ((Math.round(((Math.PI / 2 - a) / (Math.PI * 2)) * 12) + 11) % 12) + 1;
          const k = `${h.mesh}/${h.part || '-'} @${h.distance.toFixed(3)}m`;
          const rec = blockers[k] || (blockers[k] = { rays: 0, clock: {}, frac: {} });
          rec.rays++; rec.clock[clock] = (rec.clock[clock] || 0) + 1;
          rec.frac[f] = (rec.frac[f] || 0) + 1;
        }
        if (solid) { blocked++; ringBlocked++; }
      }
      rings.push({ apertureFrac: f, rays: n, blocked: ringBlocked });
    }
    const i = e.renderer.info;
    return { rays, blocked, rings, blockers, apertureR: +R.toFixed(4), stats: { drawCalls: i.render.calls, triangles: i.render.triangles } };
  }, FAR);
  say(`${id}: fan ${fan.blocked}/${fan.rays} rays obstructed`);

  /* --- 5. the sight picture, in screen space --------------------------- */
  //
  // WHY THIS STAGE EXISTS. Stages 3 and 4 answer "is the bore clear" — they
  // cast rays at the glass disc, in metres, at the optic. That is not the
  // player's complaint. The player said "nothing renders through the scope",
  // which is a claim about PIXELS: of the screen area inside the optic's
  // rendered rim, how much shows the world and how much shows gun?
  //
  // The old fan reported a clear aperture while a sixth of the sight picture
  // was dead, because a cone aimed at the glass never touches the tube wall
  // that vignettes it further forward. This stage samples the disc the player
  // actually looks at, at the resolution they look at it, and it is the only
  // number that may be quoted as "the sight is usable".
  const picture = await page.evaluate((far) => {
    const T = window.__T;
    const e = window.__engine;
    const cam = e.viewmodelCamera;
    const b = e.get('weapons').weapon;
    cam.updateMatrixWorld(true);
    const origin = new T.V3().setFromMatrixPosition(cam.matrixWorld);
    const W = e.width, H = e.height;
    const toPx = (v) => {
      const n = v.clone().project(cam);
      return { x: (n.x * 0.5 + 0.5) * W, y: (-n.y * 0.5 + 0.5) * H, ndc: [n.x, n.y] };
    };

    // The rim of the sight picture is the FRONT element: it is the far end of
    // the tube, so it is what clips the view, not the rear glass at the eye.
    let front = null, reticle = null;
    e.viewmodelScene.traverseVisible((o) => {
      if (!o.isMesh) return;
      if (/lensFront/i.test(o.name)) front = o;
      if (/^reticle/i.test(o.name)) reticle = o;
    });
    const axis = b.sight ? b.sight.group : null;
    if (!axis) return { error: 'weapon has no sight group' };
    axis.updateMatrixWorld(true);
    const centreWorld = new T.V3().setFromMatrixPosition((front || axis).matrixWorld);
    // THE RADIUS MUST MATCH THE PLANE. `glassR` is SIGHT_CLEAR * eyeRelief —
    // the cone's radius at the REAR glass, next to the eye. The rim of the
    // sight picture is the FRONT element, further down the same widening cone,
    // where the radius is `frontGlassR`. Measuring the front plane with the
    // rear radius samples a disc smaller than the one the player looks through
    // and reports a clear picture while the rim is dead — which is exactly how
    // the earlier fan came back 0/49 clear with a sixth of the bore blocked.
    // ...and it must not be a config field, either. Only some weapons publish
    // `frontGlassR`; on the rest this fell back to the rear radius and measured
    // the front plane with the wrong disc all over again. Take the radius from
    // the front lens MESH — its own bounding sphere, in world units — so the
    // number describes the geometry actually on screen no matter what the
    // builder chose to export.
    const rimIsFront = !!front;
    let R = b.sight.glassR ?? 0.010;
    let rSource = 'sight.glassR (no front lens mesh)';
    if (front) {
      front.updateMatrixWorld(true);
      const g = front.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const s = new T.V3().setFromMatrixScale(front.matrixWorld);
      R = g.boundingSphere.radius * Math.max(s.x, s.y);
      rSource = 'lensFront mesh bounding sphere';
    } else if (b.sight.frontGlassR != null) {
      R = b.sight.frontGlassR; rSource = 'sight.frontGlassR';
    }
    const right = new T.V3(1, 0, 0).applyQuaternion(cam.getWorldQuaternion(new T.Q()));
    const c = toPx(centreWorld);
    const rim = toPx(centreWorld.clone().addScaledVector(right, R));
    const radiusPx = Math.hypot(rim.x - c.x, rim.y - c.y);

    // Sample the disc on a grid sized to land near 1200 interior samples: dense
    // enough that a spoke or a screw head cannot hide between samples, cheap
    // enough to finish under software rasterisation.
    const step = Math.max(1, radiusPx * 2 / 40);
    const meshes = window.__vmMeshes();
    const rc = new T.RC(origin, new T.V3(0, 0, -1), 0, far);
    rc.firstHitOnly = false;
    const bands = [0, 0, 0, 0], bandN = [0, 0, 0, 0];
    const clock = {}, clockN = {}, blockers = {};
    let n = 0, blocked = 0;
    for (let py = c.y - radiusPx; py <= c.y + radiusPx; py += step) {
      for (let px = c.x - radiusPx; px <= c.x + radiusPx; px += step) {
        const dx = px - c.x, dy = py - c.y;
        const rr = Math.hypot(dx, dy) / radiusPx;
        if (rr > 1) continue;
        const ndc = new T.V3((px / W) * 2 - 1, -((py / H) * 2 - 1), 0.5);
        rc.set(origin, ndc.unproject(cam).sub(origin).normalize());
        n++;
        const band = Math.min(3, Math.floor(rr * 4));
        bandN[band]++;
        // 12 o'clock is up, 3 is the shooter's right. Screen y grows downward.
        const cl = ((Math.round((Math.atan2(dx, -dy) / (Math.PI * 2)) * 12) + 12) % 12) || 12;
        clockN[cl] = (clockN[cl] || 0) + 1;
        let solid = null;
        for (const h of rc.intersectObjects(meshes, false).map(window.__label)) {
          if (h.kind === 'BLOCKER') { solid = h; break; }
        }
        if (solid) {
          blocked++; bands[band]++;
          clock[cl] = (clock[cl] || 0) + 1;
          const k = `${solid.mesh}/${solid.part || '-'}`;
          blockers[k] = (blockers[k] || 0) + 1;
        }
      }
    }

    // Where the reticle actually lands. At full ADS the optic axis is on the
    // screen centre by measurement, so any reticle offset from centre is the
    // reticle being mounted wrong, not the pose being wrong.
    const centreOff = { x: +(c.x - W / 2).toFixed(1), y: +(c.y - H / 2).toFixed(1) };
    const ret = reticle ? toPx(new T.V3().setFromMatrixPosition(reticle.matrixWorld)) : null;
    return {
      viewport: [W, H],
      rimPlane: rimIsFront ? 'front element' : 'sight group origin (no lensFront mesh found)',
      rimRadiusM: +R.toFixed(5),
      rimRadiusFrom: rSource,
      rearGlassR: +(b.sight.glassR ?? 0).toFixed(5),
      frontGlassR: b.sight.frontGlassR != null ? +b.sight.frontGlassR.toFixed(5) : null,
      discCentrePx: [+c.x.toFixed(1), +c.y.toFixed(1)],
      discRadiusPx: +radiusPx.toFixed(1),
      // A sight picture smaller than this is unusable regardless of occlusion:
      // you cannot identify a target through a 20-pixel hole.
      discDiameterPct: +((radiusPx * 2 / H) * 100).toFixed(1),
      samples: n,
      blockedPct: n ? +((blocked / n) * 100).toFixed(1) : null,
      byBandPct: bands.map((v, i) => (bandN[i] ? +((v / bandN[i]) * 100).toFixed(0) : null)),
      byClockPct: Object.fromEntries(Object.keys(clockN).sort((a, z) => a - z)
        .map((k) => [k, +(((clock[k] || 0) / clockN[k]) * 100).toFixed(0)])),
      blockers,
      opticAxisOffsetPx: centreOff,
      reticleOffsetPx: ret ? { x: +(ret.x - W / 2).toFixed(1), y: +(ret.y - H / 2).toFixed(1) } : null,
      reticleVsAxisPx: ret ? +Math.hypot(ret.x - c.x, ret.y - c.y).toFixed(1) : null,
    };
  }, FAR);
  say(`${id}: sight picture ${picture.discRadiusPx}px radius, ${picture.blockedPct}% blocked`);

  const r = { weapon: id, ...ads, ...axial, fan, picture };
  results.push(r);

  console.log(`\n=== ${id} — full ADS (animator blend ${r.adsBlend}) ===`);
  console.log(`  ray origin ${r.origin.join(', ')}   dir ${r.direction.join(', ')}`);
  console.log(`  eyeRelief ${r.eyeRelief} m   aperture radius ${r.apertureR} m   viewmodel meshes ${r.meshes}`);
  if (!r.hits.length) console.log(`  (no viewmodel mesh on the axis within ${FAR} m)`);
  for (const h of r.hits) {
    console.log(`  ${h.distance.toFixed(4)} m  ${h.kind.padEnd(8)} mesh=${h.mesh}  part=${h.part ?? '-'}  slot=${h.slot ?? '-'}  mat=${h.material}`);
  }
  const solids = r.hits.filter((h) => h.kind === 'BLOCKER');
  console.log(`  VERDICT: ${solids.length ? `BLOCKED by ${solids.map((h) => h.mesh).join(', ')}` : 'axis clear — glass and reticle only'}`);
  console.log(`  fan: ${fan.blocked}/${fan.rays} rays obstructed by something solid`);
  console.log(`       by ring: ${fan.rings.map((g) => `${(g.apertureFrac * 100).toFixed(0)}%:${g.blocked}/${g.rays}`).join('  ')}`);
  for (const [k, v] of Object.entries(fan.blockers)) {
    console.log(`       ${k}  ${v.rays} rays  clock ${Object.keys(v.clock).sort((a, b) => a - b).join(',')}  aperture ${Object.keys(v.frac).join(',')}`);
  }

  const q = r.picture;
  if (q.error) { console.log(`  sight picture: ${q.error}`); continue; }
  console.log(`  SIGHT PICTURE (what the player sees, ${q.viewport.join('x')}):`);
  console.log(`       rim = ${q.rimPlane}, radius ${q.rimRadiusM} m from ${q.rimRadiusFrom}`);
  console.log(`            (sight.glassR ${q.rearGlassR}, sight.frontGlassR ${q.frontGlassR})`);
  console.log(`       disc r=${q.discRadiusPx}px (${q.discDiameterPct}% of frame height), ${q.samples} samples`);
  console.log(`       BLOCKED ${q.blockedPct}%   centre->rim bands ${q.byBandPct.map((v) => `${v}%`).join(' ')}`);
  const hot = Object.entries(q.byClockPct).filter(([, v]) => v > 0)
    .sort((a, z) => z[1] - a[1]).map(([k, v]) => `${k}o'clock ${v}%`);
  console.log(`       worst clock: ${hot.length ? hot.slice(0, 5).join('  ') : 'nothing obstructing'}`);
  for (const [k, v] of Object.entries(q.blockers).sort((a, z) => z[1] - a[1])) {
    console.log(`       ${k}: ${((v / q.samples) * 100).toFixed(1)}% of the picture`);
  }
  console.log(`       optic axis off screen centre ${q.opticAxisOffsetPx.x}, ${q.opticAxisOffsetPx.y} px`);
  if (q.reticleOffsetPx) {
    console.log(`       reticle off screen centre ${q.reticleOffsetPx.x}, ${q.reticleOffsetPx.y} px  (${q.reticleVsAxisPx} px off the optic axis)`);
  }
  console.log(`       USABLE: ${q.blockedPct < 8 && q.discDiameterPct > 12 ? 'yes' : 'NO'}`);
}

await writeFile(path.join(OUT, 'sightline.json'), JSON.stringify({ far: FAR, results, logs }, null, 2));
await writeFile(path.join(OUT, 'console.log'), logs.join('\n') || '(no errors or warnings)');
if (logs.length) console.log(`\n--- page console (${logs.length}) ---\n` + logs.slice(0, 30).join('\n'));

await browser.close();
server.kill();
say('done');
