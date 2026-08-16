import * as THREE from 'three';
import { Config, QualityTier } from '../core/Config.js';
import { makeMaterial } from '../materials/TextureFactory.js';
import { Kit, loft, roundRect, chamferBox, cyl } from './GunGeo.js';
import { VIEWMODEL_AO, VIEWMODEL_MAGNIFY } from './Gunsmith.js';

/**
 * OWNER: weapons agent.
 *
 * First-person arms. Blocked out rather than sculpted, but built to real
 * proportions and — more importantly — *placed* correctly: the right hand's
 * web sits under the beavertail with the trigger finger on the shoe, and the
 * left hand wraps the handguard at the point the gunsmith published as its
 * support-hand anchor. Hands that float near a weapon instead of holding it
 * are the most common tell of a placeholder viewmodel.
 *
 * HAND FRAME. Getting this wrong is how arms end up inside the receiver, so
 * it is stated once and obeyed everywhere:
 *
 *     +X  across the palm, little finger -> thumb
 *     +Y  the palm normal — the direction the fingers curl toward
 *     +Z  distal, along the fingers; the forearm runs out along -Z
 *
 * Placement is therefore not a guessed Euler triple but a frame built from two
 * vectors: where the fingers point, and which way the palm faces. `Matrix4.
 * lookAt(dir, ORIGIN, palmUp)` produces exactly that basis.
 *
 * Anatomy note on the curl: the three phalanges do not flex equally.
 * Proximal : middle : distal runs about 1 : 1.2 : 1.4 of the MCP angle, which
 * is why a relaxed grip reads as a spiral rather than a hinge.
 */

const GLOVE = 0, SLEEVE = 1, PAD = 2;

/**
 * The hands sit closer to the camera than any part of the weapon and they take
 * up more of the hip-fire frame than the receiver does, so they get the same
 * two viewmodel corrections the gunsmith applies to the gun — and for the same
 * measured reason. See `VIEWMODEL_AO` in Gunsmith.js: the recipes bake an
 * ambient-occlusion channel off a micro height field, `ambientOcclusion`
 * multiplies indirect diffuse, and on a surface this close that reads as a
 * printed camouflage pattern rather than as dirt in the creases. Fixing the gun
 * and leaving the gloves camouflaged would have moved the defect, not removed
 * it: they are the same defect and they share the constant that names it.
 *
 * `repeat` is scaled less aggressively here than on the gun. A glove and a
 * canvas sleeve genuinely do have a coarser weave than a machined receiver has
 * grain, and the arms Kit already projects at a tighter tile (0.22 m against
 * the body's 0.35 m), so part of the correction is paid for by the projection.
 */
export function armMaterials() {
  const AO = { aoMapIntensity: VIEWMODEL_AO };
  const M = VIEWMODEL_MAGNIFY * 0.7;
  const glove = makeMaterial('rubber', {
    seed: 71, size: 512, detailStrength: 0.55, repeat: M, material: AO,
  });
  const sleeve = makeMaterial('canvas', {
    seed: 33, size: 512, repeat: 2 * M, material: AO,
  });
  const pad = makeMaterial('polymer', { seed: 88, size: 256, repeat: M, material: AO });
  return [glove, sleeve, pad];
}

function detail() {
  if (Config.quality === QualityTier.LOW) return 0;
  if (Config.quality === QualityTier.MEDIUM) return 1;
  return 2;
}

const _ORIGIN = new THREE.Vector3();

/** Orientation whose +Z is `dir` and whose +Y leans toward `palmUp`. */
function frame(dir, palmUp) {
  return new THREE.Matrix4().lookAt(
    dir instanceof THREE.Vector3 ? dir : new THREE.Vector3(...dir),
    _ORIGIN,
    palmUp instanceof THREE.Vector3 ? palmUp : new THREE.Vector3(...palmUp)
  );
}

/**
 * One finger: three tapered segments hinged in a spiral about the palm normal.
 * @param base   Matrix4 placing the MCP joint (finger extends along +Z)
 * @param curl   MCP flexion in radians; the joints scale off it
 * @param spread abduction about the palm normal
 */
function finger(kit, base, len, girth, curl, spread, D) {
  const seg = [0.42, 0.32, 0.26];
  const flex = [1.0, 1.2, 1.4];
  let m = base.clone().multiply(new THREE.Matrix4().makeRotationY(spread));
  for (let i = 0; i < 3; i++) {
    m = m.multiply(new THREE.Matrix4().makeRotationX(-curl * flex[i]));
    const L = len * seg[i];
    const g0 = girth * (1 - i * 0.13);
    const g1 = girth * (1 - (i + 1) * 0.13);
    const k = g1 / g0;
    kit.add(loft(roundRect(g0, g0 * 0.88, g0 * 0.34, D >= 1 ? 2 : 1), [
      { z: 0, scale: 1, scaleY: 1 },
      { z: L * 0.55, scale: k, scaleY: k },
      { z: L, scale: k * 0.86, scaleY: k * 0.90 },
    ]), GLOVE, { m: m.clone() });
    if (D >= 2 && i === 0) {
      // Knuckle armour sits on the back of the hand: -Y, opposite the curl.
      kit.add(chamferBox(g0 * 0.92, g0 * 0.30, L * 0.60, g0 * 0.10), PAD, {
        m: m.clone().multiply(new THREE.Matrix4().makeTranslation(0, -g0 * 0.46, L * 0.32)),
      });
    }
    m = m.multiply(new THREE.Matrix4().makeTranslation(0, 0, L));
  }
}

/**
 * Mirror a built hand across the YZ plane, *in the buffer*.
 *
 * `mesh.scale.x = -1` is the obvious way to turn a right hand into a left one
 * and it is why the support hand did not appear in a single captured frame: a
 * negative scale reverses the winding of every triangle, so with the default
 * `FrontSide` material every face on the hand becomes a back face and is
 * culled. The mesh is in the graph, its bounds are correct, it draws nothing.
 *
 * Mirroring the vertices and swapping two corners of each triangle back
 * restores the winding, so the left hand is a real left hand rather than an
 * inside-out right one. (`Kit.build` does exactly this for `mirrored()` parts;
 * this is the same fix applied to a finished geometry.)
 */
function mirrorGeometry(geo) {
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal ? geo.attributes.normal.array : null;
  const uv = geo.attributes.uv ? geo.attributes.uv.array : null;
  const n = geo.attributes.position.count;
  for (let i = 0; i < n; i++) { pos[i * 3] = -pos[i * 3]; if (nrm) nrm[i * 3] = -nrm[i * 3]; }
  const swap = (arr, k, a, b) => {
    for (let c = 0; c < k; c++) {
      const t = arr[a * k + c]; arr[a * k + c] = arr[b * k + c]; arr[b * k + c] = t;
    }
  };
  for (let t = 0; t < n; t += 3) {
    swap(pos, 3, t + 1, t + 2);
    if (nrm) swap(nrm, 3, t + 1, t + 2);
    if (uv) swap(uv, 2, t + 1, t + 2);
  }
  geo.attributes.position.needsUpdate = true;
  if (geo.attributes.normal) geo.attributes.normal.needsUpdate = true;
  if (geo.attributes.uv) geo.attributes.uv.needsUpdate = true;
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** Build one hand + forearm in the canonical right-hand frame. */
function buildHand(mats, opts, D) {
  const kit = new Kit(1 / 0.22);
  const palmW = 0.082, palmT = 0.034, palmL = 0.086;

  // The palm is a wedge, not a slab: thick at the thenar eminence, thin at the
  // ulnar edge. That asymmetry is what makes a blocked-out hand read as a hand.
  kit.add(loft(roundRect(palmW, palmT, 0.011, D >= 1 ? 3 : 1), [
    { z: -0.006, scale: 0.88, scaleY: 0.86 },
    { z: 0.010, scale: 1.00, scaleY: 1.00 },
    { z: palmL * 0.62, scale: 0.99, scaleY: 0.94 },
    { z: palmL, scale: 0.90, scaleY: 0.82 },
  ]), GLOVE);

  // Thenar pad — the muscle at the base of the thumb, on the +X side.
  kit.add(loft(roundRect(0.028, 0.026, 0.009, 2), [
    { z: 0, scale: 0.70 }, { z: 0.020, scale: 1.00 }, { z: 0.044, scale: 0.78 },
  ]), GLOVE, { pos: [palmW * 0.26, 0.004, 0.006] });

  // Four fingers: index nearest the thumb (+X), little finger at -X.
  const curl = opts.curl ?? 1.05;
  const lens = [0.072, 0.080, 0.076, 0.062];
  for (let i = 0; i < 4; i++) {
    const x = palmW * (0.30 - i * 0.20);
    const base = new THREE.Matrix4().makeTranslation(x, 0.002, palmL - 0.006);
    const c = (i === 0 && opts.trigger !== undefined) ? opts.trigger : curl * (1 + (i - 1.5) * 0.05);
    finger(kit, base, lens[i], 0.019 - i * 0.0011, c, (i - 1.5) * 0.045, D);
  }

  // Thumb: rooted on the thenar side, opposed across the palm.
  const thumb = new THREE.Matrix4()
    .makeTranslation(palmW * 0.44, 0.006, 0.022)
    .multiply(new THREE.Matrix4().makeRotationY(1.05))
    .multiply(new THREE.Matrix4().makeRotationX(-0.35));
  finger(kit, thumb, 0.062, 0.022, opts.thumbCurl ?? 0.55, 0, D);

  // --- wrist and forearm ------------------------------------------------
  // The wrist is not straight. Both a firing grip and a C-clamp carry 30-40
  // degrees of deviation, and without it the forearm leaves along the exact
  // reverse of the fingers — which sends the firing arm up through the middle
  // of the frame instead of back toward the shoulder.
  const wrist = new THREE.Matrix4().makeRotationX(opts.wrist ?? 0);
  kit.add(loft(roundRect(0.050, 0.044, 0.015, D >= 1 ? 3 : 1), [
    { z: 0.000, scale: 0.82, scaleY: 0.80 },
    { z: -0.028, scale: 1.00, scaleY: 1.00 },
    { z: -0.100, scale: 1.30, scaleY: 1.28 },
    { z: -0.175, scale: 1.42, scaleY: 1.40 },
  ]), SLEEVE, { m: wrist.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.008)) });

  // Cuff: a raised band where the glove meets the sleeve, plus its strap.
  kit.add(cyl(0.031, 0.033, 0.020, D >= 1 ? 12 : 8), PAD, { m: wrist.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.026)) });
  if (D >= 1) kit.add(chamferBox(0.048, 0.010, 0.007, 0.0012), PAD, { m: wrist.clone().multiply(new THREE.Matrix4().makeTranslation(0, -0.026, -0.018)) });

  const geo = kit.build();
  if (opts.mirror) mirrorGeometry(geo);
  const mesh = new THREE.Mesh(geo, mats);
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Assemble both arms and place them on a built weapon.
 * Returns `{ root, left, right, rest }`; `rest` holds the neutral local
 * transforms the animator layers its offsets on top of.
 */
export function buildArms(weapon, mats) {
  const D = detail();
  const root = new THREE.Group();
  root.name = 'Arms';
  // The hands live inside the viewmodel camera's near volume and are posed
  // every frame from the weapon's anchors, so their world bounds move faster
  // than a cached bounding sphere can follow. Culling is switched off all the
  // way down the chain rather than only on the leaf meshes.
  root.frustumCulled = false;

  /* --- firing hand ----------------------------------------------------- */
  // Fingers run forward and down around the grip's front strap; the palm
  // faces back and up into the grip, which puts the forearm on the line back
  // to the shoulder and the thumb over the left side of the receiver.
  const right = new THREE.Group();
  right.name = 'rightArm';
  right.frustumCulled = false;
  const rh = buildHand(mats, { curl: 1.30, thumbCurl: 0.85, trigger: 0.62, wrist: -0.55 }, D);
  rh.quaternion.setFromRotationMatrix(frame(
    [-0.08, -0.30 - weapon.anchors.rightRake * 0.30, -0.94],
    [0.08, 0.92, -0.38]
  ));
  right.add(rh);
  right.position.copy(weapon.anchors.rightHand);
  right.position.x += 0.010;
  right.position.z += 0.006;
  root.add(right);

  /* --- support hand ---------------------------------------------------- */
  // Comes in from below and left, fingers wrapping up and over the handguard
  // with the thumb across the top — the modern C-clamp. The forearm therefore
  // exits down-left-back, out of the centre of the frame.
  const left = new THREE.Group();
  left.name = 'leftArm';
  left.frustumCulled = false;
  const lh = buildHand(mats, { curl: 1.24, thumbCurl: 0.30, wrist: 0.38, mirror: true }, D);
  lh.quaternion.setFromRotationMatrix(frame([0.62, 0.72, -0.30], [-0.42, 0.10, -0.90]));
  left.add(lh);
  left.position.copy(weapon.anchors.leftHand);
  left.position.x -= 0.026;
  left.position.y -= 0.016;
  root.add(left);

  const rest = {
    right: { pos: right.position.clone(), rot: right.rotation.clone() },
    left: { pos: left.position.clone(), rot: left.rotation.clone() },
  };

  return {
    root, left, right, rest,
    dispose() { rh.geometry.dispose(); lh.geometry.dispose(); },
  };
}
