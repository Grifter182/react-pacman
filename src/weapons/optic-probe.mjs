/**
 * OWNER: weapons agent.  Node-only, no browser, no GPU.
 *
 *   node src/weapons/optic-probe.mjs [rifle|smg|dmr|all]     (env TIERS=LOW,MED,HIGH)
 *
 * THE ACCEPTANCE TEST FOR THE OPTIC BORE AND THE HIP FRAMING.
 *
 * ------------------------------------------------------------------------
 * WHICH PLANE THIS SAMPLES, AND WHICH RADIUS BELONGS TO IT
 *
 * This is stated first and in full because getting it wrong is the specific
 * mistake that cost three rounds of wrong conclusions about this weapon.
 *
 * The eye is a point, so the pencil of rays that reaches it through an optic
 * WIDENS downrange: the clear radius at any plane a distance `d` from the eye is
 * `SIGHT_CLEAR * d`, not a constant. An optic therefore has at least two
 * different clear radii, on two different planes:
 *
 *   REAR GLASS   at d = eyeRelief             radius `sight.glassR`
 *   FRONT GLASS  at d = eyeRelief + tubeLen   radius `sight.frontGlassR`
 *
 * The rim of the SIGHT PICTURE — the hole the player looks through — is the
 * FRONT element, because that is the far end of the tube and therefore what
 * clips the view. So:
 *
 *   * stage A and stage B below sample THE FRONT ELEMENT PLANE, and they use
 *     `sight.frontGlassR`, which is the radius that belongs to that plane;
 *   * they assert that the mesh named `lensFront` is actually there, because a
 *     missing front element is how a measurement silently falls back to the
 *     rear plane;
 *   * the rear radius is printed alongside for contrast and is never used as
 *     the fan radius.
 *
 * The previous acceptance test (`aperture-probe.mjs`) fanned its rays at
 * `SIGHT_CLEAR * eyeRelief` — the REAR radius — while describing itself as a
 * test of the front element. That disc is 23-46% smaller than the one it claimed
 * to sample, which is why it reported 0/49 clear on every weapon at every tier
 * while a sixth of the sight picture was dead.
 *
 * ------------------------------------------------------------------------
 * WHAT IT REPORTS
 *
 *  A. SIGHT PICTURE, as a percentage of the ADS frame HEIGHT. Same quantity the
 *     screen-space probe calls `discDiameterPct` (tools/sightline-probe.mjs,
 *     output in shots/sightline/sightline.json), derived analytically so it can
 *     be checked without a GPU:
 *
 *         discDiameterPct = 100 * (rFront / dFront) / tan(fovAds / 2)
 *
 *     ACCEPTANCE: >= 18 on every weapon at every tier.
 *
 *  B. THE FAN: 4 rings x 12 spokes plus the axial ray, aimed at the front
 *     element disc. ACCEPTANCE: 0 blocked, and the axial ray crosses glass only.
 *
 *  C. THE MOUNT: rail-deck-to-axis riser, in mm and inches. Not an acceptance
 *     criterion — it is the PRICE of A, and it is printed so a future change to
 *     `SIGHT_CLEAR` shows its cost in the same breath as its benefit.
 *
 *  D. THE FRAMING: the hip pose projected to NDC against the real viewmodel
 *     frustum at 16:9 — full box, body-only bottom edge (the magazine is allowed
 *     past it), per-part boxes, the muzzle crown, and the silhouette's coverage
 *     of the frame rasterised into a 160x90 grid. ACCEPTANCE: the top of the
 *     weapon stays below y = -0.08 (the HUD crosshair is at 0), the body bottom
 *     stays above y = -1.00, the muzzle crown is inside the frame, and the
 *     nearest vertex clears the viewmodel camera's 5 mm near plane.
 */
import * as THREE from 'three';
import { Config, QualityTier } from '../core/Config.js';
import { WEAPONS } from './WeaponDefs.js';
import { buildWeapon } from './Gunsmith.js';

/* Stand-in material set: the geometry is what is being measured, and building
 * the real ones needs a canvas. Slot order matches `weaponMaterials()`. */
const NAMES = ['receiver', 'rail', 'barrel', 'polymer', 'rubber', 'glass', 'lens'];
const mats = NAMES.map((n) => Object.assign(new THREE.MeshBasicMaterial(), { name: n }));

const which = process.argv[2] || 'all';
const keys = which === 'all' ? ['rifle', 'smg', 'dmr'] : [which];
const TIER = { LOW: QualityTier.LOW, MED: QualityTier.MEDIUM, HIGH: QualityTier.HIGH };
/* Every tier, because the tiers do not build the same gun: `detailLevel()` drops
 * whole parts at LOW and halves the radial segment counts, and a coarser lathe
 * is a *smaller* inscribed bore. A sight that is clear at HIGH and plugged at
 * LOW is still a broken sight for most of the players. */
const TIERS = (process.env.TIERS || 'LOW,MED,HIGH').split(',');

/* CameraRig narrows the viewmodel FOV to this fraction while aiming
 * (`src/player/CameraRig.js`, `viewmodelFov * lerp(1, 0.86, ads)`), and the ADS
 * frame is the one the sight picture is judged in. */
const ADS_FOV_SCALE = 0.86;
const tanHip = Math.tan(THREE.MathUtils.degToRad(Config.camera.viewmodelFov) * 0.5);
const tanAds = Math.tan(THREE.MathUtils.degToRad(Config.camera.viewmodelFov * ADS_FOV_SCALE) * 0.5);
const ASPECT = 16 / 9;
const VM_NEAR = 0.005;               // Engine.js viewmodelCamera near plane

const PICTURE_MIN = 18;              // % of frame height
const TOP_MAX = -0.08;               // NDC: nothing above this at hip
const BODY_BOTTOM_MIN = -1.00;       // NDC: no body vertex below this at hip

const fails = [];
function check(ok, msg) { if (!ok) fails.push(msg); return ok ? '' : '   <-- FAIL'; }

/** Which authored part a triangle of the merged body came from. */
function partOf(geo, vertexIndex) {
  const parts = geo.userData?.parts;
  if (!parts) return null;
  for (const p of parts) {
    if (vertexIndex >= p.start && vertexIndex < p.start + p.count) return p;
  }
  return null;
}
function label(hit) {
  const p = hit.face ? partOf(hit.object.geometry, hit.face.a) : null;
  return p ? `${hit.object.name}/${p.label}[slot ${p.slot}]` : hit.object.name;
}

for (const tname of TIERS) {
  Config.quality = TIER[tname];
  for (const key of keys) {
    const def = WEAPONS[key];
    const b = buildWeapon(def, mats);
    const root = b.root;
    const s = b.sight;
    const id = `${key}/${tname}`;

    /* ---- A, B: put the eye exactly where full ADS puts it ---------------
     * The ADS pose is derived from the sight group, with identity rotation, so
     * at full blend the group sits at (0, 0, -eyeRelief) and the eye is the
     * origin, on the optical axis. */
    root.position.copy(b.adsPose.pos);
    root.rotation.copy(b.adsPose.rot);
    root.updateMatrixWorld(true);
    const eye = new THREE.Vector3(0, 0, 0);

    const front = s.group.children.find((o) => o.name === 'lensFront');
    const haveFront = !!front;
    // THE RADIUS MUST MATCH THE PLANE — see the header. `frontGlassR` belongs to
    // the front element and nothing else may be substituted for it.
    const rPlane = s.frontGlassR;
    let planePos = null, planeD = 0;
    if (haveFront) {
      front.updateMatrixWorld(true);
      planePos = new THREE.Vector3().setFromMatrixPosition(front.matrixWorld);
      planeD = eye.distanceTo(planePos);
    }
    const pct = haveFront && rPlane ? 100 * (rPlane / planeD) / tanAds : 0;

    const meshes = [];
    root.traverse((o) => { if (o.isMesh && !/lens|reticle/i.test(o.name)) meshes.push(o); });
    const rc = new THREE.Raycaster(eye, new THREE.Vector3(0, 0, -1), 0, 0.9);
    rc.firstHitOnly = false;
    const right = new THREE.Vector3(1, 0, 0), upv = new THREE.Vector3(0, 1, 0);
    let rays = 0, blocked = 0;
    const rings = [], blockers = {};
    if (haveFront) {
      for (const frac of [0, 0.3, 0.6, 0.9, 1.0]) {
        const n = frac === 0 ? 1 : 12;
        let rb = 0;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const t = planePos.clone()
            .addScaledVector(right, Math.cos(a) * rPlane * frac)
            .addScaledVector(upv, Math.sin(a) * rPlane * frac);
          rc.set(eye, t.clone().sub(eye).normalize());
          rays++;
          const hits = rc.intersectObjects(meshes, false);
          if (hits.length) {
            blocked++; rb++;
            // 12 o'clock is up, 3 is the shooter's right.
            const cl = ((Math.round((a + Math.PI / 2) / (Math.PI * 2) * 12) + 12) % 12) || 12;
            const k = `${label(hits[0])} @${hits[0].distance.toFixed(3)}m clock${cl}`;
            blockers[k] = (blockers[k] || 0) + 1;
          }
        }
        rings.push(`r${frac}:${rb}/${n}`);
      }
    }

    /* ---- C: the mount ------------------------------------------------- */
    // Rail deck, from `buildWeapon`: upper deck + riser + picatinny tooth.
    const railY = def.model.receiverH * 0.40 + 0.002 + 0.005 + 0.0032 + 0.0044;
    const riser = s.group.position.y - railY;

    /* ---- D: hip framing ----------------------------------------------- */
    root.position.copy(b.hipPose.pos);
    root.rotation.copy(b.hipPose.rot);
    root.updateMatrixWorld(true);
    const drawn = [];
    root.traverse((o) => { if (o.isMesh && !/reticle/i.test(o.name)) drawn.push(o); });

    const GW = 160, GH = 90;
    const cov = new Uint8Array(GW * GH);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    let bodyY0 = Infinity, near = Infinity, far = 0;
    const partBox = {};
    const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const nx = [0, 0, 0], ny = [0, 0, 0];
    for (const m of drawn) {
      const arr = m.geometry.attributes.position.array;
      const isMag = m.name === 'magazine';
      m.updateMatrixWorld(true);
      for (let i = 0; i < arr.length; i += 9) {
        let ok = true;
        for (let k = 0; k < 3; k++) {
          const o = i + k * 3;
          tri[k].set(arr[o], arr[o + 1], arr[o + 2]).applyMatrix4(m.matrixWorld);
          const d = -tri[k].z;
          if (d < near) near = d;
          if (d > far) far = d;
          if (d < 1e-3) { ok = false; continue; }
          nx[k] = tri[k].x / (tanHip * ASPECT * d);
          ny[k] = tri[k].y / (tanHip * d);
          if (nx[k] < x0) x0 = nx[k]; if (nx[k] > x1) x1 = nx[k];
          if (ny[k] < y0) y0 = ny[k]; if (ny[k] > y1) y1 = ny[k];
          if (!isMag && ny[k] < bodyY0) bodyY0 = ny[k];
        }
        if (!ok) continue;
        const p = partOf(m.geometry, i / 3);
        if (p) {
          const bx = partBox[p.label] || (partBox[p.label] = [Infinity, -Infinity, Infinity, -Infinity]);
          for (let k = 0; k < 3; k++) {
            if (nx[k] < bx[0]) bx[0] = nx[k]; if (nx[k] > bx[1]) bx[1] = nx[k];
            if (ny[k] < bx[2]) bx[2] = ny[k]; if (ny[k] > bx[3]) bx[3] = ny[k];
          }
        }
        // Rasterise the triangle so "how much of the frame" is a measurement.
        const sx = [0, 1, 2].map((k) => (nx[k] * 0.5 + 0.5) * GW);
        const sy = [0, 1, 2].map((k) => (-ny[k] * 0.5 + 0.5) * GH);
        const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
        if (Math.abs(area) < 1e-9) continue;
        const c0 = Math.max(0, Math.floor(Math.min(...sx))), c1 = Math.min(GW - 1, Math.ceil(Math.max(...sx)));
        const r0 = Math.max(0, Math.floor(Math.min(...sy))), r1 = Math.min(GH - 1, Math.ceil(Math.max(...sy)));
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const px = c + 0.5, py = r + 0.5;
            const w0 = ((sx[1] - px) * (sy[2] - py) - (sx[2] - px) * (sy[1] - py)) / area;
            const w1 = ((sx[2] - px) * (sy[0] - py) - (sx[0] - px) * (sy[2] - py)) / area;
            if (w0 >= 0 && w1 >= 0 && 1 - w0 - w1 >= 0) cov[r * GW + c] = 1;
          }
        }
      }
    }
    let covN = 0;
    for (let i = 0; i < cov.length; i++) covN += cov[i];
    const mw = b.muzzle.position.clone().applyMatrix4(root.matrixWorld);
    const mzD = -mw.z;
    const mz = [mw.x / (tanHip * ASPECT * mzD), mw.y / (tanHip * mzD)];

    const f2 = (n) => (n >= 0 ? ' ' : '') + n.toFixed(2);
    const mm = (n) => (n * 1000).toFixed(1);
    console.log(`\n=== ${id} — ${def.name}, optic=${def.optic} ===`);
    console.log(`  A  sight picture ${pct.toFixed(1)}% of frame height (>= ${PICTURE_MIN})`
      + check(pct >= PICTURE_MIN, `${id}: sight picture ${pct.toFixed(1)}% < ${PICTURE_MIN}%`));
    console.log(`       plane = FRONT ELEMENT at ${planeD.toFixed(3)} m, radius `
      + `sight.frontGlassR = ${rPlane != null ? mm(rPlane) + ' mm' : 'MISSING'}`
      + check(haveFront && rPlane != null, `${id}: no lensFront mesh / no frontGlassR published`));
    console.log(`       (rear plane for contrast: sight.glassR ${mm(s.glassR)} mm at `
      + `${mm(s.eyeRelief)} mm — NOT used as the fan radius)`);
    console.log(`  B  fan at the front element: ${blocked}/${rays} blocked   ${rings.join(' ')}`
      + check(blocked === 0, `${id}: ${blocked}/${rays} rays blocked at the front element`));
    if (blocked) for (const [k, v] of Object.entries(blockers)) console.log(`       ${v} x ${k}`);
    console.log(`  C  riser ${mm(riser)} mm (${(riser / 0.0254).toFixed(2)}") rail deck to axis;`
      + ` ${mm(s.group.position.y - 0.010)} mm over bore; eye relief ${mm(s.eyeRelief)} mm`);
    console.log(`  D  hip NDC x[${f2(x0)},${f2(x1)}] y[${f2(y0)},${f2(y1)}]`
      + `  body bottom ${f2(bodyY0)}  frame coverage ${(covN / (GW * GH) * 100).toFixed(1)}%`);
    console.log(`       top ${f2(y1)} <= ${TOP_MAX}`
      + check(y1 <= TOP_MAX, `${id}: weapon reaches y=${y1.toFixed(2)}, over the crosshair`)
      + `; body bottom ${f2(bodyY0)} >= ${BODY_BOTTOM_MIN}`
      + check(bodyY0 >= BODY_BOTTOM_MIN, `${id}: body bottom ${bodyY0.toFixed(2)} is off the frame`));
    console.log(`       muzzle crown NDC (${f2(mz[0])},${f2(mz[1])}) at ${mzD.toFixed(3)} m`
      + check(Math.abs(mz[0]) <= 1 && Math.abs(mz[1]) <= 1, `${id}: muzzle crown is outside the frame`));
    console.log(`       depth ${near.toFixed(3)}..${far.toFixed(3)} m, near plane ${VM_NEAR} m`
      + check(near > VM_NEAR, `${id}: nearest vertex ${near.toFixed(3)} m is inside the near plane`));
    for (const k of ['upper', 'lower', 'barrel', 'handguard', 'optic', 'stock', 'grip']) {
      const bx = partBox[k];
      if (bx) console.log(`       ${k.padEnd(10)} x[${f2(bx[0])},${f2(bx[1])}] y[${f2(bx[2])},${f2(bx[3])}]`);
    }
    b.dispose();
  }
}

console.log('');
if (fails.length) {
  console.log(`FAIL — ${fails.length} problem(s):`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('PASS — sight picture, front-element fan, hip framing and near plane all within target.');
}
