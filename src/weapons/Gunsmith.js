import * as THREE from 'three';
import { Config, QualityTier } from '../core/Config.js';
import { makeMaterial } from '../materials/TextureFactory.js';
import {
  Kit, chamferBox, chamferWedge, loft, lathe, tube, cyl, knurl, octagon,
  roundRect, ngon, picatinny, mlokSlots, flutes, panelLine,
} from './GunGeo.js';

/**
 * OWNER: weapons agent.
 *
 * The gunsmith. Builds a complete first-person weapon from a `model` spec:
 * receiver group, free-float handguard, barrel and muzzle device, stock, grip,
 * magazine, optic, and every small control the eye uses to read a shape as a
 * firearm — charging handle, ejection port and its cover, bolt catch, safety
 * selector, magazine release, sling loops.
 *
 * COORDINATE FRAME (weapon space)
 *   -Z is downrange, +Y is up, +X is the shooter's right.
 *   The origin sits on the receiver centreline at the middle of the upper,
 *   which puts the bore at y = +0.010 and the rail deck a little above +0.031.
 *
 * The optical axis is recorded at build time and the ADS pose is *derived* from
 * it rather than hand-tuned: aiming translates the weapon by exactly
 * `-sightPoint`, so the sight line passes through the camera origin and the
 * reticle lands on the screen centre to the pixel, whatever the optic's height
 * over bore turns out to be.
 *
 * Everything static is merged into one multi-material buffer (4 draw calls);
 * anything that animates is its own Object3D with a recorded rest transform.
 */

/* Material slots inside the merged body geometry. */
const S_STEEL = 0, S_POLY = 1, S_RUBBER = 2, S_GLASS = 3, S_LENS = 4;

/** Radians subtended per reticle unit, per optic family. */
const RETICLE_ANGLE = { reddot: 5.8e-4, reflex: 2.2e-3, scope: 1.5e-3 };

export function weaponMaterials() {
  const size = Config.gfx.textureSize >= 1024 ? 1024 : 512;
  const steel = makeMaterial('gunmetal', { seed: 91, size, detailStrength: 0.42 });
  const poly = makeMaterial('polymer', { seed: 43, size: Math.min(512, size) });
  const rubber = makeMaterial('rubber', { seed: 12, size: 256 });

  // Optic glass: an AR-coated lens reads as a dark surface with a green-magenta
  // bloom, never as a grey pane. No transmission — just a low-opacity
  // dielectric with a hard specular lobe off the environment map.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0a1512, roughness: 0.045, metalness: 0.0,
    transparent: true, opacity: 0.34, depthWrite: false,
    clearcoat: 1.0, clearcoatRoughness: 0.03,
    envMapIntensity: 2.4, side: THREE.DoubleSide,
  });

  // Emissive reticle: unlit, additive, outside the tone mapper so the bloom
  // pass sees a genuinely over-range value and blooms it like a real emitter.
  const lens = new THREE.MeshBasicMaterial({
    color: new THREE.Color(7.5, 0.42, 0.16),
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, depthTest: false, toneMapped: false, opacity: 1,
  });

  return [steel, poly, rubber, glass, lens];
}

function detailLevel() {
  if (Config.quality === QualityTier.LOW) return 0;
  if (Config.quality === QualityTier.MEDIUM) return 1;
  return 2;
}

/* ----------------------------------------------------------------- upper */

/** Upper receiver: flat-top with rail, forward assist, port, brass deflector. */
function upperReceiver(kit, M, D) {
  const w = M.receiverW, h = M.receiverH;
  // The receiver is a fixed fraction of the weapon's overall length, so the
  // three guns differ in the proportion the eye reads first — a stubby SMG
  // upper and a long DMR upper, not one shell with different furniture.
  const len = M.length * 0.59;
  const zc = 0.018;
  const front = zc - len * 0.5, back = zc + len * 0.5;

  // Main shell: a chamfered box whose top third is stepped in for the rail.
  kit.add(loft(octagon(w, h * 0.78, 0.0022), [
    { z: front, scale: 0.94, scaleY: 0.90 },
    { z: front + 0.0022, scale: 1 },
    { z: back - 0.010, scale: 1 },
    { z: back, scale: 0.96, scaleY: 0.94 },
  ]), S_STEEL, { pos: [0, 0.004, 0] });

  // Rail riser and the rail itself.
  const deckY = h * 0.40 + 0.002;
  kit.add(chamferBox(w * 0.62, 0.010, len - 0.004, 0.0012), S_STEEL, { pos: [0, deckY, zc] });
  kit.addParts(picatinny(len - 0.006, { detail: D >= 1 ? 1 : 0 }), S_STEEL, { pos: [0, deckY + 0.005, zc] });

  // Charging-handle raceway and the receiver-extension boss at the rear.
  kit.add(chamferBox(w * 0.80, 0.020, 0.030, 0.0014), S_STEEL, { pos: [0, h * 0.24, back - 0.008] });
  kit.add(lathe([[0, back + 0.030], [0.0155, back + 0.030], [0.0175, back + 0.028],
    [0.0175, back - 0.006], [0, back - 0.006]], D >= 1 ? 16 : 10), S_STEEL, { pos: [0, -0.004, 0] });

  // Ejection port: a recessed floor with a lipped frame, right side only.
  const portZ = zc - 0.030, portLen = 0.052, portH = 0.026;
  kit.add(chamferBox(0.004, portH, portLen, 0.0008), S_STEEL, { pos: [w * 0.5 - 0.004, 0.006, portZ] });
  kit.add(chamferBox(0.0035, 0.0030, portLen + 0.008, 0.0008), S_STEEL, { pos: [w * 0.5 - 0.0015, 0.006 + portH * 0.5, portZ] });
  kit.add(chamferBox(0.0035, 0.0030, portLen + 0.008, 0.0008), S_STEEL, { pos: [w * 0.5 - 0.0015, 0.006 - portH * 0.5, portZ] });

  // Brass deflector — the wedge behind the port that keeps cases off the face.
  kit.add(chamferWedge(0.013, 0.004, 0.020, 0.026, 0.0010), S_STEEL,
    { pos: [w * 0.5 - 0.004, 0.012, portZ + portLen * 0.5 + 0.016], rot: [0, 0, -0.35] });

  // Forward assist: a plunger in a boss, just behind the deflector.
  kit.add(cyl(0.0072, 0.0060, 0.014, D >= 1 ? 12 : 8), S_STEEL,
    { pos: [w * 0.5 - 0.002, 0.016, portZ + portLen * 0.5 + 0.014], rot: [0, -Math.PI / 2, 0] });

  if (D >= 1) {
    // Takedown pins and the moulding seam along both flanks.
    kit.mirrored((k) => {
      k.add(panelLine(len - 0.02, { width: 0.0014, depth: 0.0010 }), S_STEEL, { pos: [w * 0.5 - 0.0004, -h * 0.30, zc] });
      k.add(cyl(0.0055, 0.0042, 0.005, 10), S_STEEL, { pos: [w * 0.5 - 0.001, -0.012, back - 0.020], rot: [0, -Math.PI / 2, 0] });
      k.add(cyl(0.0055, 0.0042, 0.005, 10), S_STEEL, { pos: [w * 0.5 - 0.001, -0.012, front + 0.022], rot: [0, -Math.PI / 2, 0] });
    });
  }
  return { front, back, portZ, portLen, portH, deckY };
}

/* ----------------------------------------------------------------- lower */

/** Lower receiver: magwell, trigger guard, controls, grip mount. */
function lowerReceiver(kit, M, D) {
  const w = M.receiverW * 0.92, h = 0.040;
  const zc = 0.028;
  const topY = -M.receiverH * 0.34;

  // Magwell: a flared, tapered well swept downward, not a straight box.
  const well = loft(octagon(M.mag.width + 0.010, M.mag.depth + 0.010, 0.0022), [
    { z: 0.000, scale: 0.985, scaleY: 0.985 },
    { z: 0.042, scale: 1.000, scaleY: 1.000 },
    { z: 0.052, scale: 1.100, scaleY: 1.100 },   // flared mouth at the top
  ]);
  well.rotateX(Math.PI / 2);                     // +Z sweep becomes -Y
  kit.add(well, S_STEEL, { pos: [0, topY, zc - 0.020] });

  // Body around the fire-control group.
  kit.add(chamferBox(w, h, 0.088, 0.0020), S_STEEL, { pos: [0, topY - h * 0.5 + 0.006, zc + 0.030] });

  // Trigger guard: a swept rounded-U, not a box with a hole punched in it.
  const steps = D >= 1 ? 10 : 6;
  const guardRings = [];
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI * (i / steps);
    guardRings.push({ z: -Math.cos(a) * 0.021, dy: -Math.abs(Math.sin(a)) * 0.019 });
  }
  kit.add(loft(octagon(0.0075, 0.0060, 0.0012), guardRings), S_STEEL,
    { pos: [0, topY - 0.021, zc + 0.052] });

  // Magazine release (right) and its fence; bolt-catch boss (left).
  kit.add(cyl(0.0060, 0.0048, 0.0068, 12), S_STEEL, { pos: [w * 0.5 - 0.001, topY - 0.014, zc + 0.006], rot: [0, -Math.PI / 2, 0] });
  kit.add(chamferBox(0.004, 0.014, 0.014, 0.0008), S_STEEL, { pos: [w * 0.5, topY - 0.014, zc + 0.006] });
  kit.add(cyl(0.0072, 0.0072, 0.0040, 12), S_STEEL, { pos: [-w * 0.5 + 0.001, topY - 0.017, zc + 0.052], rot: [0, Math.PI / 2, 0] });

  // Sling loop at the rear of the lower.
  kit.add(new THREE.TorusGeometry(0.0062, 0.0016, 6, 14), S_STEEL,
    { pos: [-w * 0.5 - 0.002, topY - 0.012, zc + 0.076], rot: [0, Math.PI / 2, 0] });

  return { topY, zc, w };
}

/* ------------------------------------------------------------- handguard */

/** Free-float handguard: an n-gon shell with M-LOK rows and a top rail. */
function handguard(kit, M, D, frontZ) {
  const hg = M.handguard;
  const z0 = frontZ, z1 = frontZ - hg.len;
  const r = hg.radius;

  kit.add(loft(ngon(r, D >= 1 ? 12 : 8, Math.PI / 12), [
    { z: z1, scale: 0.90 },
    { z: z1 + 0.004, scale: 0.98 },
    { z: z1 + 0.010, scale: 1.00 },
    { z: z0 - 0.026, scale: 1.00 },
    { z: z0 - 0.020, scale: 1.07 },     // barrel-nut collar
    { z: z0, scale: 1.07 },
  ]), S_STEEL, { pos: [0, 0.010, 0] });

  // The top rail runs continuous with the receiver's — a monolithic upper.
  kit.addParts(picatinny(hg.len - 0.016, { detail: D >= 1 ? 1 : 0 }), S_STEEL,
    { pos: [0, 0.010 + r - 0.0012, (z0 + z1) * 0.5] });

  if (D >= 1) {
    // M-LOK rows at 3, 6 and 9 o'clock. These slots are what break up the long
    // featureless tube the left hand spends the entire match holding.
    const pitch = 0.032;
    const n = Math.max(1, hg.slots);
    const zs = (z0 + z1) * 0.5 - ((n - 1) * pitch) * 0.5;
    // Each row is rotated so the recess cuts inward: rotZ maps +Y onto the
    // row's outward normal.
    const rows = [[1, 0, -Math.PI / 2], [-1, 0, Math.PI / 2], [0, -1, Math.PI]];
    for (const [nx, ny, rot] of rows) {
      kit.addParts(mlokSlots(n, { pitch, z0: 0 }), S_STEEL, {
        m: new THREE.Matrix4()
          .makeTranslation(nx * (r - 0.0006), 0.010 + ny * (r - 0.0006), zs)
          .multiply(new THREE.Matrix4().makeRotationZ(rot)),
      });
    }
    // QD sling socket, front left.
    kit.add(cyl(0.0055, 0.0030, 0.0045, 12), S_STEEL, { pos: [-r + 0.001, 0.010, z1 + 0.030], rot: [0, Math.PI / 2, 0] });
  }

  // Heat-shield ribs on the underside, visible whenever the gun is canted.
  if (D >= 2) {
    for (let i = 0; i < 4; i++) {
      kit.add(panelLine(hg.len - 0.03, { width: 0.0016, depth: 0.0010 }), S_STEEL,
        { pos: [(i - 1.5) * 0.006, 0.010 - r + 0.0004, (z0 + z1) * 0.5] });
    }
  }
  return { z0, z1, radius: r };
}

/* ---------------------------------------------------------------- barrel */

/** Barrel, gas system and muzzle device. */
function barrelAssembly(kit, M, D, hg) {
  const b = M.barrel;
  const zB = 0.010;                    // breech face
  const zM = zB - b.len;               // muzzle crown
  const seg = D >= 1 ? 18 : 10;
  const R = b.radius;

  // Profile listed rear -> front: chamber shoulder, gas journal, pencil
  // section, thread relief, crown.
  kit.add(lathe([
    [0.0, zB],
    [R * 1.55, zB],
    [R * 1.55, zB - 0.030],
    [R * 1.18, zB - 0.036],
    [R * 1.18, zB - 0.075],
    [R * 1.00, zB - 0.082],
    [R * 1.00, zM + 0.022],
    [R * 0.93, zM + 0.018],
    [R * 0.93, zM],
    [R * 0.42, zM],
    [R * 0.42, zM + 0.014],
    [0.0, zM + 0.014],
  ], seg), S_STEEL, { pos: [0, 0.010, 0] });

  if (b.fluted && D >= 1) {
    const flen = (zB - zM) * 0.5;
    kit.addParts(flutes(6, R + 0.0004, flen), S_STEEL, { pos: [0, 0.010, zB - 0.10 - flen * 0.5] });
  }

  if (b.gasBlock) {
    const gz = hg.z1 + 0.030;
    kit.add(chamferBox(0.020, 0.021, 0.026, 0.0012), S_STEEL, { pos: [0, 0.012, gz] });
    kit.add(cyl(0.0026, 0.0026, Math.abs(0.020 - gz), 8), S_STEEL, { pos: [0, 0.0225, gz] });
  }

  // Muzzle device.
  let tipZ;
  if (M.muzzle === 'flashhider') {
    tipZ = zM - 0.040;
    kit.add(lathe([
      [0, zM + 0.001], [R * 1.35, zM + 0.001], [R * 1.35, zM - 0.006],
      [R * 1.20, zM - 0.008], [R * 1.20, tipZ], [R * 0.62, tipZ],
      [R * 0.62, tipZ + 0.016], [0, tipZ + 0.016],
    ], seg), S_STEEL, { pos: [0, 0.010, 0] });
    // Four prongs with the classic open slots between them.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      kit.add(chamferBox(0.0042, 0.0042, 0.030, 0.0008), S_STEEL, {
        m: new THREE.Matrix4().makeTranslation(0, 0.010, zM - 0.024)
          .multiply(new THREE.Matrix4().makeRotationZ(a))
          .multiply(new THREE.Matrix4().makeTranslation(0, R * 1.16, 0)),
      });
    }
  } else if (M.muzzle === 'compensator') {
    tipZ = zM - 0.028;
    kit.add(lathe([
      [0, zM + 0.001], [R * 1.45, zM + 0.001], [R * 1.45, tipZ + 0.002], [R * 1.10, tipZ],
      [R * 0.55, tipZ], [R * 0.55, tipZ + 0.012], [0, tipZ + 0.012],
    ], seg), S_STEEL, { pos: [0, 0.010, 0] });
    for (let i = 0; i < 3; i++) {
      kit.mirrored((k) => k.add(chamferBox(0.0016, 0.010, 0.0042, 0.0004), S_STEEL,
        { pos: [R * 1.4, 0.010, zM - 0.006 - i * 0.007] }));
    }
  } else {
    tipZ = zM - 0.052;
    kit.add(lathe([
      [0, zM + 0.001], [R * 1.60, zM + 0.001], [R * 1.60, tipZ + 0.004], [R * 1.25, tipZ],
      [R * 0.55, tipZ], [R * 0.55, tipZ + 0.018], [0, tipZ + 0.018],
    ], seg), S_STEEL, { pos: [0, 0.010, 0] });
    for (let i = 0; i < 3; i++) {
      kit.mirrored((k) => k.add(chamferBox(0.0022, 0.014, 0.0060, 0.0005), S_STEEL,
        { pos: [R * 1.55, 0.010, zM - 0.010 - i * 0.012], rot: [0.22, 0, 0] }));
    }
  }
  return { zB, zM, tipZ };
}

/* ------------------------------------------------------------------ grip */

/** Pistol grip: raked, palm-swelled, finger grooves, beavertail, rubber plug. */
function pistolGrip(kit, M, D, anchor) {
  const rake = 0.36;
  const g = loft(roundRect(0.030, 0.038, 0.008, D >= 1 ? 3 : 2), [
    { z: 0.000, scale: 1.00, scaleY: 1.00 },
    { z: 0.012, scale: 1.03, scaleY: 0.98 },
    { z: 0.040, scale: 0.94, scaleY: 0.92 },
    { z: 0.070, scale: 0.90, scaleY: 0.90 },
    { z: 0.086, scale: 0.95, scaleY: 0.96 },   // flare for the heel of the palm
    { z: 0.092, scale: 0.86, scaleY: 0.88 },
  ]);
  g.rotateX(Math.PI / 2);                      // sweep downward
  const base = new THREE.Matrix4().makeTranslation(anchor.x, anchor.y, anchor.z)
    .multiply(new THREE.Matrix4().makeRotationX(rake));
  kit.add(g, S_POLY, { m: base.clone() });

  if (D >= 1) {
    for (let i = 0; i < 3; i++) {              // finger grooves, front strap
      kit.add(new THREE.TorusGeometry(0.0060, 0.0022, 5, 10, Math.PI), S_POLY, {
        m: base.clone()
          .multiply(new THREE.Matrix4().makeTranslation(0, -0.026 - i * 0.019, -0.016))
          .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)),
      });
    }
    kit.add(chamferWedge(0.026, 0.004, 0.014, 0.020, 0.0010), S_POLY, {
      m: base.clone().multiply(new THREE.Matrix4().makeRotationX(-0.5))
        .multiply(new THREE.Matrix4().makeTranslation(0, 0.002, 0.016)),
    });                                        // beavertail
  }
  kit.add(chamferBox(0.026, 0.006, 0.032, 0.0012), S_RUBBER, {
    m: base.clone().multiply(new THREE.Matrix4().makeTranslation(0, -0.092, 0)),
  });

  const hand = new THREE.Vector3(0, -0.032, 0).applyEuler(new THREE.Euler(rake, 0, 0)).add(anchor);
  return { hand, rake };
}

/* ----------------------------------------------------------------- stock */

/** Stock: carbine (adjustable), folding (wire) or precision (chassis). */
function stockAssembly(kit, M, D, backZ) {
  const kind = M.stock;
  const tubeR = 0.0155;
  const tubeLen = kind === 'folding' ? 0.055 : 0.155;

  kit.add(cyl(tubeR, tubeR, tubeLen, D >= 1 ? 14 : 8), S_STEEL, { pos: [0, -0.004, backZ] });
  if (D >= 1) {
    for (let i = 0; i < 6; i++) {              // length-of-pull notches
      kit.add(chamferBox(0.008, 0.0035, 0.0060, 0.0006), S_STEEL,
        { pos: [0, -0.004 - tubeR + 0.0015, backZ + 0.030 + i * 0.020] });
    }
  }

  if (kind === 'folding') {
    kit.mirrored((k) => k.add(chamferBox(0.005, 0.006, 0.090, 0.0010), S_STEEL,
      { pos: [0.016, -0.006, backZ + 0.070], rot: [0, 0.10, 0] }));
    kit.add(chamferBox(0.046, 0.030, 0.008, 0.0014), S_RUBBER, { pos: [0, -0.008, backZ + 0.116] });
    return { buttZ: backZ + 0.120, cheekY: 0.010 };
  }

  if (kind === 'precision') {
    kit.add(chamferBox(0.034, 0.052, 0.150, 0.0022), S_POLY, { pos: [0, -0.006, backZ + 0.082] });
    kit.add(chamferBox(0.040, 0.014, 0.086, 0.0016), S_POLY, { pos: [0, 0.026, backZ + 0.070] });      // cheek riser
    kit.mirrored((k) => k.add(chamferBox(0.006, 0.014, 0.030, 0.0008), S_STEEL, { pos: [0.014, 0.014, backZ + 0.070] }));
    kit.add(chamferBox(0.020, 0.026, 0.060, 0.0014), S_POLY, { pos: [0, -0.036, backZ + 0.058], rot: [0.12, 0, 0] }); // toe hook
    kit.add(chamferBox(0.046, 0.062, 0.012, 0.0018), S_RUBBER, { pos: [0, -0.004, backZ + 0.160] });
    kit.add(new THREE.TorusGeometry(0.0060, 0.0016, 6, 14), S_STEEL, { pos: [0, -0.032, backZ + 0.140], rot: [0, Math.PI / 2, 0] });
    return { buttZ: backZ + 0.166, cheekY: 0.033 };
  }

  // Carbine: slim body clamped on the tube, cheek weld on top, rubber pad.
  kit.add(loft(octagon(0.042, 0.048, 0.0022), [
    { z: backZ + 0.030, scale: 0.72, scaleY: 0.80 },
    { z: backZ + 0.046, scale: 0.90, scaleY: 0.92 },
    { z: backZ + 0.110, scale: 1.00, scaleY: 1.00 },
    { z: backZ + 0.132, scale: 1.00, scaleY: 1.06 },
    { z: backZ + 0.138, scale: 0.92, scaleY: 1.00 },
  ]), S_POLY, { pos: [0, -0.006, 0] });
  kit.add(chamferBox(0.044, 0.052, 0.014, 0.0016), S_RUBBER, { pos: [0, -0.008, backZ + 0.145] });
  kit.add(chamferBox(0.012, 0.020, 0.030, 0.0010), S_POLY, { pos: [0, -0.036, backZ + 0.060], rot: [-0.25, 0, 0] });
  kit.mirrored((k) => k.add(chamferBox(0.004, 0.016, 0.016, 0.0008), S_POLY, { pos: [0.022, -0.010, backZ + 0.106] }));
  return { buttZ: backZ + 0.152, cheekY: 0.020 };
}

/* ------------------------------------------------------------- magazine */

/** Magazine — its own mesh so it can drop free during a reload. */
function magazineMesh(M, mats, D) {
  const kit = new Kit();
  const m = M.mag;
  const N = D >= 1 ? 7 : 4;
  const curveAt = (t) => Math.sin(t * 1.25) * m.curve;

  const rings = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // Curved box: the spine sweeps rearward as it descends. That curve is the
    // most recognisable single element of a rifle's silhouette.
    rings.push({ z: t * m.len, dy: curveAt(t), scale: 1 - t * 0.03, scaleY: 1 - t * 0.02 });
  }
  const body = loft(roundRect(m.width, m.depth, 0.004, D >= 1 ? 2 : 1), rings);
  body.rotateX(Math.PI / 2);          // +Z sweep -> -Y, profile +Y -> +Z
  kit.add(body, 0);

  if (D >= 1) {
    for (let i = 0; i < 4; i++) {     // reinforcing ribs down both flanks
      const t = 0.20 + i * 0.18;
      kit.mirrored((k) => k.add(chamferBox(0.0016, 0.010, m.depth * 0.72, 0.0004), 0,
        { pos: [m.width * 0.5, -t * m.len, curveAt(t)] }));
    }
  }
  // Floorplate with a finger lip, and the feed lips at the top.
  kit.add(chamferBox(m.width + 0.004, 0.010, m.depth + 0.004, 0.0014), 1,
    { pos: [0, -m.len - 0.004, curveAt(1)] });
  kit.add(chamferBox(m.width + 0.004, 0.006, 0.008, 0.0010), 1,
    { pos: [0, -m.len - 0.010, curveAt(1) + m.depth * 0.5] });
  kit.mirrored((k) => k.add(chamferBox(0.0030, 0.012, m.depth * 0.8, 0.0006), 0,
    { pos: [m.width * 0.5 - 0.001, 0.004, 0] }));

  const mesh = new THREE.Mesh(kit.build(), [mats[S_STEEL], mats[S_POLY]]);
  mesh.name = 'magazine';
  mesh.frustumCulled = false;
  return mesh;
}

/* ---------------------------------------------------------------- optics */

/**
 * Optic assembly. The housing merges into the body kit; the lenses and the
 * optical-axis reference come back out so the module can collimate the reticle
 * and derive the ADS pose.
 *
 * `eyeRelief` is not the manufacturer's figure. A 30 mm tube held at a real
 * 60 mm subtends 39 degrees against a 55-degree viewmodel FOV and swallows two
 * thirds of the screen; every shooter pushes the optic out until the housing
 * takes about a third of the frame height and the target stays visible around
 * it. These numbers are that distance, solved for each optic's own diameter.
 */
function opticAssembly(kit, M, D, kind, railY, zc) {
  const seg = D >= 1 ? 20 : 10;

  if (kind === 'scope') {
    const axisY = railY + 0.030;
    const zR = zc + 0.075, zF = zc - 0.115;
    for (const z of [zc + 0.020, zc - 0.045]) {           // mount rings
      kit.add(cyl(0.0205, 0.0205, 0.014, 14), S_STEEL, { pos: [0, axisY, z - 0.007] });
      kit.add(chamferBox(0.022, 0.026, 0.018, 0.0012), S_STEEL, { pos: [0, axisY - 0.022, z] });
    }
    // Closed annular section: ocular bell, 30 mm body, objective bell, then
    // back down the bore so the shooter can actually see through it.
    kit.add(lathe([
      [0.0215, zR], [0.0215, zR - 0.026], [0.0160, zR - 0.034],
      [0.0160, zc + 0.030], [0.0175, zc + 0.026], [0.0175, zc - 0.050],
      [0.0155, zc - 0.054], [0.0155, zF + 0.048], [0.0250, zF + 0.030],
      [0.0250, zF],
      [0.0136, zF], [0.0136, zR], [0.0215, zR],
    ], seg), S_STEEL, { pos: [0, axisY, 0] });
    kit.add(cyl(0.0125, 0.0110, 0.016, 14), S_STEEL, { pos: [0, axisY + 0.014, zc - 0.010], rot: [-Math.PI / 2, 0, 0] });
    kit.add(cyl(0.0110, 0.0098, 0.014, 14), S_STEEL, { pos: [0.014, axisY, zc - 0.010], rot: [0, -Math.PI / 2, 0] });
    kit.add(cyl(0.0195, 0.0195, 0.020, 14), S_STEEL, { pos: [0, axisY, zR - 0.050] });
    if (D >= 1) kit.addParts(knurl(14, 0.0198, 0.018), S_STEEL, { pos: [0, axisY, zR - 0.041] });
    return { axisY, rearZ: zR - 0.028, frontZ: zF + 0.004, glassR: 0.0132, eyeRelief: 0.130 };
  }

  if (kind === 'reflex') {
    const axisY = railY + 0.017;
    // Open-emitter reflex: shroud arms, a canted lens, an emitter housing.
    kit.mirrored((k) => k.add(chamferBox(0.0040, 0.030, 0.044, 0.0010), S_STEEL, { pos: [0.0165, axisY + 0.002, zc - 0.002] }));
    kit.add(chamferBox(0.037, 0.005, 0.044, 0.0010), S_STEEL, { pos: [0, axisY + 0.016, zc - 0.002] });
    kit.add(chamferBox(0.037, 0.016, 0.020, 0.0012), S_STEEL, { pos: [0, axisY - 0.017, zc + 0.008] });
    kit.add(chamferBox(0.028, 0.010, 0.014, 0.0010), S_STEEL, { pos: [0, axisY - 0.011, zc - 0.026] });
    kit.add(chamferBox(0.030, 0.008, 0.032, 0.0010), S_STEEL, { pos: [0, axisY - 0.026, zc] });  // rail clamp
    return { axisY, rearZ: zc + 0.020, frontZ: zc - 0.022, glassR: 0.0125, eyeRelief: 0.092, flat: true };
  }

  // 30 mm tube red dot with an integral mount, sun hood and turret caps.
  const axisY = railY + 0.021;
  const zR = zc + 0.038, zF = zc - 0.040;
  kit.add(lathe([
    [0.0190, zR], [0.0190, zR - 0.006], [0.0168, zR - 0.010],
    [0.0168, zc + 0.014], [0.0182, zc + 0.010], [0.0182, zc - 0.012],
    [0.0168, zc - 0.016], [0.0168, zF + 0.014], [0.0192, zF + 0.008],
    [0.0192, zF],
    [0.0152, zF], [0.0152, zR], [0.0190, zR],
  ], seg), S_STEEL, { pos: [0, axisY, 0] });
  kit.add(tube(0.0192, 0.0176, zF, zF - 0.013, seg), S_STEEL, { pos: [0, axisY, 0] });   // sun hood
  kit.add(chamferBox(0.020, 0.024, 0.048, 0.0014), S_STEEL, { pos: [0, axisY - 0.021, zc] });
  kit.add(chamferBox(0.030, 0.008, 0.030, 0.0012), S_STEEL, { pos: [0, axisY - 0.032, zc] });
  kit.add(cyl(0.0080, 0.0064, 0.011, 12), S_STEEL, { pos: [0.013, axisY - 0.026, zc], rot: [0, -Math.PI / 2, 0] });
  kit.add(cyl(0.0085, 0.0072, 0.012, 12), S_STEEL, { pos: [0, axisY + 0.015, zc + 0.002], rot: [-Math.PI / 2, 0, 0] });
  kit.add(cyl(0.0075, 0.0064, 0.010, 12), S_STEEL, { pos: [0.015, axisY, zc + 0.002], rot: [0, -Math.PI / 2, 0] });
  if (D >= 1) {
    kit.addParts(knurl(12, 0.0086, 0.010), S_STEEL, { pos: [0, axisY + 0.020, zc + 0.002], rot: [-Math.PI / 2, 0, 0] });
  }
  return { axisY, rearZ: zR - 0.004, frontZ: zF + 0.004, glassR: 0.0148, eyeRelief: 0.105 };
}

/* --------------------------------------------------------------- assembly */

/**
 * Build a complete weapon.
 * @returns {{root:THREE.Group, parts:object, muzzle:THREE.Object3D,
 *            ejectPort:THREE.Object3D, sight:object, anchors:object,
 *            hipPose:object, adsPose:object, dispose:Function}}
 */
export function buildWeapon(def, mats) {
  const M = def.model;
  const D = detailLevel();
  const kit = new Kit();

  const up = upperReceiver(kit, M, D);
  const low = lowerReceiver(kit, M, D);
  const hg = handguard(kit, M, D, up.front + 0.004);
  const bar = barrelAssembly(kit, M, D, hg);
  const gripAnchor = new THREE.Vector3(0, low.topY - 0.010, low.zc + 0.070);
  const grip = pistolGrip(kit, M, D, gripAnchor);
  stockAssembly(kit, M, D, up.back);

  if (M.foregrip) {
    // Angled foregrip under the handguard.
    const fg = loft(roundRect(0.022, 0.026, 0.006, 2), [
      { z: 0, scale: 1.00 }, { z: 0.030, scale: 0.92 },
      { z: 0.048, scale: 0.82 }, { z: 0.054, scale: 0.68 },
    ]);
    kit.add(fg, S_POLY, {
      m: new THREE.Matrix4().makeTranslation(0, 0.010 - hg.radius, hg.z1 + 0.058)
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2 - 0.42)),
    });
  }

  const railY = up.deckY + 0.005 + 0.0032 + 0.0044;
  const optic = opticAssembly(kit, M, D, def.optic, railY, 0.018);

  const bodyGeo = kit.build();
  const body = new THREE.Mesh(bodyGeo, mats);
  body.name = `${def.name}:body`;
  body.frustumCulled = false;

  const root = new THREE.Group();
  root.name = def.name;
  root.add(body);

  /* --- moving parts ----------------------------------------------------- */
  const parts = {};
  const track = (key, obj, kind = 'position') => {
    root.add(obj);
    obj.frustumCulled = false;
    parts[key] = obj;
    parts[`${key}Rest`] = kind === 'rotation' ? obj.rotation.clone() : obj.position.clone();
  };

  const mag = magazineMesh(M, mats, D);
  mag.position.set(0, low.topY - 0.002, low.zc - 0.020);
  track('mag', mag);

  // Charging handle: a T-latch riding the receiver raceway.
  const chKit = new Kit();
  chKit.add(chamferBox(0.030, 0.008, 0.052, 0.0010), 0);
  chKit.add(chamferBox(0.044, 0.010, 0.012, 0.0012), 0, { pos: [0, 0, 0.030] });
  chKit.mirrored((k) => k.add(chamferBox(0.008, 0.012, 0.018, 0.0008), 0, { pos: [0.018, 0, 0.030] }));
  const charge = new THREE.Mesh(chKit.build(), mats[S_STEEL]);
  charge.name = 'charging';
  charge.position.set(0, M.receiverH * 0.26, up.back - 0.004);
  track('charge', charge);

  // Bolt carrier: only its face is ever visible, through the port.
  const boltKit = new Kit();
  boltKit.add(cyl(0.0105, 0.0090, 0.032, 12), 0, { pos: [0, 0, -0.016] });
  boltKit.add(chamferBox(0.010, 0.006, 0.020, 0.0006), 0, { pos: [0.008, 0.006, 0] });
  const bolt = new THREE.Mesh(boltKit.build(), mats[S_STEEL]);
  bolt.name = 'bolt';
  bolt.position.set(0, 0.008, up.portZ);
  track('bolt', bolt);

  // Ejection-port cover, hinged on its lower edge.
  const coverKit = new Kit();
  coverKit.add(chamferBox(0.0030, up.portH - 0.002, up.portLen, 0.0008), 0, { pos: [0, (up.portH - 0.002) * 0.5, 0] });
  coverKit.add(chamferBox(0.0050, 0.0035, up.portLen * 0.4, 0.0006), 0, { pos: [0.0012, up.portH - 0.004, 0] });
  const cover = new THREE.Mesh(coverKit.build(), mats[S_STEEL]);
  cover.name = 'portCover';
  cover.position.set(M.receiverW * 0.5 - 0.0012, 0.006 - up.portH * 0.5, up.portZ);
  track('cover', cover, 'rotation');

  const trig = new THREE.Mesh(chamferBox(0.006, 0.020, 0.006, 0.0008), mats[S_STEEL]);
  trig.name = 'trigger';
  trig.position.set(0, low.topY - 0.022, low.zc + 0.050);
  trig.rotation.x = 0.25;
  track('trigger', trig, 'rotation');

  // Safety selector: rotates about its own axis between safe and fire.
  const selKit = new Kit();
  selKit.add(cyl(0.0060, 0.0060, 0.006, 10), 0);
  selKit.add(chamferBox(0.0060, 0.020, 0.0045, 0.0008), 0, { pos: [0, -0.009, 0.004] });
  const sel = new THREE.Mesh(selKit.build(), mats[S_STEEL]);
  sel.name = 'selector';
  sel.position.set(-low.w * 0.5, low.topY - 0.014, low.zc + 0.040);
  sel.rotation.y = Math.PI / 2;           // local +Z points to the shooter's left
  track('selector', sel, 'rotation');

  // Bolt catch paddle, pressed on an empty reload.
  const catchKit = new Kit();
  catchKit.add(chamferBox(0.005, 0.014, 0.022, 0.0008), 0);
  catchKit.add(chamferBox(0.006, 0.008, 0.008, 0.0006), 0, { pos: [0, -0.008, -0.008] });
  const boltCatch = new THREE.Mesh(catchKit.build(), mats[S_STEEL]);
  boltCatch.name = 'boltCatch';
  boltCatch.position.set(-low.w * 0.5 - 0.002, low.topY - 0.016, low.zc - 0.004);
  track('boltCatch', boltCatch);

  /* --- optics ------------------------------------------------------------ */
  const sightGroup = new THREE.Group();
  sightGroup.position.set(0, optic.axisY, optic.rearZ);
  root.add(sightGroup);

  const glassGeo = new THREE.CircleGeometry(optic.glassR, D >= 1 ? 24 : 12);
  const rearGlass = new THREE.Mesh(glassGeo, mats[S_GLASS]);
  rearGlass.rotation.x = optic.flat ? -0.16 : 0;    // reflex lenses are canted
  rearGlass.renderOrder = 4;
  rearGlass.frustumCulled = false;
  sightGroup.add(rearGlass);

  if (!optic.flat) {
    const frontGlass = new THREE.Mesh(glassGeo, mats[S_GLASS]);
    frontGlass.position.z = optic.frontZ - optic.rearZ;
    frontGlass.renderOrder = 3;
    frontGlass.frustumCulled = false;
    sightGroup.add(frontGlass);
  }

  // The reticle is deliberately NOT parented here. A collimated sight puts its
  // dot at optical infinity, so WeaponModule re-places it every frame on the
  // line from the eye along this group's -Z; `sightGroup` is that reference.
  const reticle = makeReticle(def, mats[S_LENS], D);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.010, bar.tipZ - 0.004);
  root.add(muzzle);

  const ejectPort = new THREE.Object3D();
  ejectPort.position.set(M.receiverW * 0.5 + 0.008, 0.010, up.portZ);
  root.add(ejectPort);

  /* --- poses ------------------------------------------------------------- */
  // ADS is derived, not authored: translate the weapon so the optical axis
  // passes through the camera origin at the correct eye relief.
  const adsPose = {
    pos: new THREE.Vector3(0, -optic.axisY, -optic.rearZ - optic.eyeRelief),
    rot: new THREE.Euler(0, 0, 0),
  };
  // Hip: the weapon is carried low and right, canted inboard so the muzzle
  // still converges on the crosshair. Distance is set so the receiver sits
  // about 28 cm from the eye — closer and the near plane starts eating the
  // stock, further and the gun stops reading as held.
  const hipPose = {
    pos: new THREE.Vector3(0.112, -0.108, -0.272),
    rot: new THREE.Euler(0.030, -0.085, 0.020),
  };

  const anchors = {
    rightHand: grip.hand.clone(),
    rightRake: grip.rake,
    leftHand: new THREE.Vector3(0, 0.010 - hg.radius * 0.62, hg.z1 + (M.foregrip ? 0.062 : 0.055)),
    magGrab: new THREE.Vector3(0, low.topY - 0.095, low.zc - 0.020),
  };

  return {
    root, body, parts, muzzle, ejectPort, reticle,
    sight: {
      group: sightGroup, glassR: optic.glassR, eyeRelief: optic.eyeRelief, flat: !!optic.flat,
      // Radians of subtended angle per reticle unit. The red dot's 0.5-unit
      // disc therefore reads as a 2 MOA dot; the reflex horseshoe as ~35 MOA.
      reticleAngle: RETICLE_ANGLE[def.optic] ?? 5.8e-4,
    },
    anchors, hipPose, adsPose,
    triangles: bodyGeo.attributes.position.count / 3,
    dispose() {
      bodyGeo.dispose();
      for (const k of Object.keys(parts)) parts[k]?.geometry?.dispose?.();
      glassGeo.dispose();
      reticle.geometry.dispose();
    },
  };
}

/**
 * Reticle geometry, authored in "reticle units" — the module scales the plane
 * by its collimated distance so the pattern subtends a constant angle wherever
 * the maths ends up placing it. A dot for the red dot, a dot-in-horseshoe for
 * the reflex, a mil-dot cross for the scope.
 */
function makeReticle(def, mat, D) {
  const parts = [];
  const push = (geo, x = 0, y = 0) => { if (x || y) geo.translate(x, y, 0); parts.push(geo); };

  if (def.optic === 'scope') {
    const th = 0.10;
    push(new THREE.PlaneGeometry(6.0, th));
    push(new THREE.PlaneGeometry(th, 6.0));
    for (let i = 1; i <= 3; i++) {
      push(new THREE.CircleGeometry(0.13, 8), i * 1.1, 0);
      push(new THREE.CircleGeometry(0.13, 8), -i * 1.1, 0);
      push(new THREE.CircleGeometry(0.13, 8), 0, -i * 1.1);
    }
    push(new THREE.CircleGeometry(0.10, 8));
  } else if (def.optic === 'reflex') {
    push(new THREE.CircleGeometry(0.42, D >= 1 ? 14 : 8));
    push(new THREE.RingGeometry(2.0, 2.35, 20, 1, Math.PI * 0.15, Math.PI * 1.70));
  } else {
    push(new THREE.CircleGeometry(0.5, D >= 1 ? 16 : 8));
  }

  const mesh = new THREE.Mesh(mergeSimple(parts), mat);
  mesh.name = 'reticle';
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;
  return mesh;
}

/** Minimal position-only merge for the flat reticle plates. */
function mergeSimple(geos) {
  const list = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}
