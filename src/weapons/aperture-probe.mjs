/**
 * OWNER: weapons agent.  Node-only, no browser, no GPU.
 *
 * THE SIGHT-PICTURE PROBE.
 *
 * Boots the gunsmith headlessly, places the eye exactly where full ADS puts it
 * (the ADS pose is derived, so the eye is on the optical axis at `eyeRelief`),
 * and casts a fan of rays forward through the optic aperture. Anything a ray
 * hits inside 0.6 m is something the player is looking at INSTEAD OF THE TARGET.
 *
 *   node src/weapons/aperture-probe.mjs [rifle|smg|dmr|all]
 *
 * Acceptance: the only hits are lens glass.
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
/* Every tier, because the tiers do not build the same gun: `detailLevel()`
 * drops whole parts at LOW and halves the radial segment counts, and a coarser
 * lathe is a *smaller* inscribed bore. A sight that is clear at HIGH and
 * plugged at LOW is still a broken sight for most of the players. */
const TIERS = [QualityTier.LOW, QualityTier.MEDIUM, QualityTier.HIGH];

/**
 * Which material slot a triangle of the merged body belongs to, from the draw
 * groups — that is how a hit on the merged mesh is named. `userData.parts` gives
 * the finer answer: which authored part the triangle came from.
 */
function describeHit(hit) {
  const g = hit.object.geometry;
  const vi = hit.face ? hit.face.a : -1;
  const parts = g.userData?.parts;
  if (parts) {
    for (const p of parts) {
      if (vi >= p.start && vi < p.start + p.count) return `${hit.object.name}/${p.label}[slot ${p.slot}]`;
    }
  }
  const m = hit.object.material;
  const name = Array.isArray(m) ? (m[hit.face?.materialIndex ?? 0]?.name ?? '?') : (m?.name ?? '?');
  return `${hit.object.name}(${name})`;
}

for (const tier of TIERS) {
Config.quality = tier;
for (const key of keys) {
  const def = WEAPONS[key];
  const build = buildWeapon(def, mats);
  const root = build.root;

  // Full ADS: the weapon root sits at `adsPose.pos` with identity rotation, so
  // the sight group lands at (0,0,-eyeRelief) in camera space.
  root.position.copy(build.adsPose.pos);
  root.rotation.copy(build.adsPose.rot);
  root.updateMatrixWorld(true);

  const sightW = new THREE.Vector3().setFromMatrixPosition(build.sight.group.matrixWorld);
  const R = build.sight.glassR;

  // The camera origin IS the eye. -Z is downrange.
  const eye = new THREE.Vector3(0, 0, 0);

  const rc = new THREE.Raycaster();
  rc.near = 0.0;
  // 0.6 m clears the receiver and the handguard; the muzzle device on the DMR
  // is 0.7 m out and is just as much in the way, so the ray runs the whole gun.
  rc.far = 1.6;
  rc.firstHitOnly = false;

  // A fan, not a single ray: the centre ray can thread a gap that the rest of
  // the sight picture does not have. 1 axial + 4 rings x 12 spokes, out to 96%
  // of the aperture radius, aimed through the rear glass plane.
  const targets = [[0, 0]];
  for (const f of [0.25, 0.5, 0.75, 0.96]) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      targets.push([Math.cos(a) * R * f, Math.sin(a) * R * f]);
    }
  }

  const tally = new Map();   // name -> { n, minD, maxD }
  let blocked = 0;
  const glassOnly = new Set();

  for (const [ox, oy] of targets) {
    const aim = new THREE.Vector3(sightW.x + ox, sightW.y + oy, sightW.z);
    const dir = aim.clone().sub(eye).normalize();
    rc.set(eye, dir);
    const hits = rc.intersectObject(root, true);
    let solid = false;
    for (const h of hits) {
      const name = describeHit(h);
      const isGlass = name.includes('slot 5') || name.includes('glass') || name.includes('reticle');
      if (isGlass) { glassOnly.add(name); continue; }
      solid = true;
      let t = tally.get(name);
      if (!t) { t = { n: 0, minD: Infinity, maxD: 0, pts: [] }; tally.set(name, t); }
      t.n++; t.minD = Math.min(t.minD, h.distance); t.maxD = Math.max(t.maxD, h.distance);
      // Weapon-space coordinates of the offending triangle, which is the only
      // thing that identifies WHICH part of a merged buffer is in the way.
      if (t.pts.length < 6) t.pts.push(root.worldToLocal(h.point.clone()).toArray().map((v) => v.toFixed(4)).join(','));
    }
    if (solid) blocked++;
  }

  const rows = [...tally.entries()].sort((a, b) => a[1].minD - b[1].minD);
  console.log(`\n=== ${key} (${def.name}, optic=${def.optic}) @ ${tier} ===`);
  console.log(`  eyeRelief ${build.sight.eyeRelief.toFixed(4)} m   apertureR ${R.toFixed(4)} m   `
    + `sight at ${sightW.toArray().map((v) => v.toFixed(4)).join(', ')}`);
  console.log(`  body triangles ${build.triangles}`);
  console.log(`  rays ${targets.length}, obstructed ${blocked}`);
  if (!rows.length) console.log('  CLEAR — nothing but glass in the aperture.');
  for (const [name, t] of rows) {
    console.log(`  BLOCKER  ${name.padEnd(34)} ${String(t.n).padStart(3)} rays  d=${t.minD.toFixed(3)}..${t.maxD.toFixed(3)} m`);
    console.log(`           at ${t.pts.join("  ")}`);
  }
  console.log(`  glass surfaces crossed: ${[...glassOnly].join(', ') || '(none)'}`);
  build.dispose();
}
}
