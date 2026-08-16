import * as THREE from 'three';
import { Config, QualityTier } from '../core/Config.js';
import { makeMaterial, getMaterialCatalog } from '../materials/TextureFactory.js';
import {
  Kit, chamferBox, chamferWedge, loft, lathe, tube, cyl, knurl, octagon,
  roundRect, ngon, picatinny, mlokSlots, flutes, panelLine, recessPanel,
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
 * Everything static is merged into one multi-material buffer (five draw groups
 * — receiver, rail, barrel, polymer, rubber); anything that animates is its own
 * Object3D with a recorded rest transform. A complete viewmodel is twelve
 * meshes and about nineteen draw calls.
 *
 * The hip pose is *solved*, not authored — see `solveHipPose`. Three constants
 * cannot frame three weapons that differ by a factor of two in length, and the
 * previous ones put the buttstock behind the near plane on all of them.
 */

/**
 * Material slots inside the merged body geometry.
 *
 * A real rifle is an *assembly*: a phosphated steel receiver, a hard-anodised
 * aluminium rail and handguard, a nitrided barrel, moulded polymer furniture
 * and rubber contact surfaces. Painting all of that from one 'steel' instance
 * is the single loudest tell that a weapon was generated rather than built —
 * every part shares one grain, one roughness and one wear pattern, so the eye
 * reads a single extruded object instead of parts that were manufactured
 * separately and bolted together. Seven slots is seven draw groups on one
 * merged mesh, which is cheaper than the two extra meshes it replaces.
 */
const S_RECV = 0, S_RAIL = 1, S_BARREL = 2, S_POLY = 3, S_RUBBER = 4, S_GLASS = 5, S_LENS = 6;

/**
 * Angular radius of the reticle quad, in radians, per optic family. The module
 * scales the plane by this times its collimated distance, so the pattern holds
 * a constant subtended angle wherever the geometry puts it. See `makeReticle`
 * for why these are sized against the *glow* rather than against the dot.
 *   reddot  7.1 mrad halo  ->  ~16 px at 1080p, 4 px core
 *   reflex 11.8 mrad quad  ->  ~60 MOA horseshoe with a 3 px dot
 *   scope  30.0 mrad quad  ->  a compact duplex for the ADS transition
 */
const RETICLE_ANGLE = { reddot: 7.1e-3, reflex: 1.18e-2, scope: 3.0e-2 };

/** Core radius as a fraction of the quad, per family. */
const RETICLE_CORE = { reddot: 0.25, reflex: 0.13, scope: 0.085 };

/**
 * Ask the materials library for a preset by name; if it has not published one
 * yet, take the closest recipe it *has* got and shim it into place.
 *
 * Two things this must not do. It must not call `makeMaterial` with a name the
 * library does not know — `resolveRecipe` silently substitutes *concrete*, so a
 * missing 'barrel_nitride' would paint the barrel with pavement. And it must
 * not apply the shim when the real preset exists: `shim` compensates for the
 * fallback recipe being the wrong material (darkening it, roughening it,
 * making it a conductor), and applying that on top of a purpose-built recipe
 * would double the correction and land somewhere worse than either.
 */
let _catalog = null;
function preset(name, fallback, opts = {}, shim = null) {
  if (!_catalog) {
    try { _catalog = new Set(getMaterialCatalog().map((e) => e.id)); }
    catch { _catalog = new Set(); }
  }
  if (_catalog.has(name)) return makeMaterial(name, opts);
  const merged = Object.assign({}, opts, shim || {});
  merged.material = Object.assign({}, opts.material, shim && shim.material);
  return makeMaterial(fallback, merged);
}

/**
 * The weapon's material set. Requested by name from the materials library;
 * `gunmetal` / `polymer` / `rubber` are the fallbacks that exist today.
 */
export function weaponMaterials() {
  const size = Config.gfx.textureSize >= 1024 ? 1024 : 512;
  const half = Math.min(512, size);

  // Receiver: manganese phosphate over forged aluminium. Matte dielectric,
  // ~0.05 albedo, wear only on the arrises. This is the reference surface, and
  // `gunmetal` already is exactly this recipe — no shim needed.
  const receiver = preset('receiver_phosphate', 'gunmetal', {
    seed: 91, size, detailStrength: 0.42,
  });

  // Rail, handguard and optic housings: type-III hard anodising. Darker than
  // the receiver and markedly rougher — anodising is a ceramic oxide, not a
  // coating, and it scatters rather than reflecting. Finer grain too, because
  // these are small extruded sections rather than a forging.
  const rail = preset('rail_anodised', 'gunmetal', {
    seed: 137, size: half, detailStrength: 0.58,
  }, {
    worldScale: 0.20,
    envMapIntensity: 0.70,
    material: { color: new THREE.Color(0.62, 0.63, 0.66), roughness: 1.22, metalnessMap: null, metalness: 0.08 },
  });

  // Barrel, gas block and muzzle device: nitrided steel. Near-black, and the
  // only part of the gun with a genuinely hard specular — a barrel carries a
  // moving highlight down its length that nothing else on the weapon does.
  const barrel = preset('barrel_nitride', 'gunmetal', {
    seed: 211, size: half, detailStrength: 0.26,
  }, {
    worldScale: 0.26,
    envMapIntensity: 1.75,
    material: { color: new THREE.Color(0.80, 0.82, 0.87), roughness: 0.46, metalnessMap: null, metalness: 0.62 },
  });

  const poly = preset('furniture_polymer', 'polymer', { seed: 43, size: half });
  const rubber = preset('grip_rubber', 'rubber', { seed: 12, size: 256 });

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

  return [receiver, rail, barrel, poly, rubber, glass, lens];
}

function detailLevel() {
  if (Config.quality === QualityTier.LOW) return 0;
  if (Config.quality === QualityTier.MEDIUM) return 1;
  return 2;
}

/**
 * Radial segment counts, by detail tier and by how large the part is on screen.
 *
 * A viewmodel barrel is 200 px of screen at hip and fills a third of the frame
 * when aimed. Twelve segments there is a 30-degree facet: a visible flat, a
 * visible arris, and a specular that snaps from one facet to the next as the
 * weapon sways. These numbers are the smallest that stop the silhouette
 * reading as a prism, not an arbitrary bump — the whole weapon at tier 2 is
 * still well under 40k triangles.
 */
const SEG = {
  //         LOW  MED  HIGH
  barrel:   [10,  18,  28],
  hguard:   [ 8,  14,  20],
  optic:    [12,  22,  36],
  small:    [ 8,  12,  18],
  tiny:     [ 6,  10,  14],
};
function seg(kind, D) { return SEG[kind][D]; }

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

  /* The shell is built as a narrowed core plus two bolted-on flank walls,
   * because without CSG that is the only way to get a *hole*. The right flank
   * is emitted as four bars around the ejection-port rectangle, so the port is
   * an opening through a 4.5 mm wall with the core shell visible 4.5 mm behind
   * it and the bolt face behind that. Every other approach — a recessed plate,
   * a lipped frame — is geometry that sits at or above the surface and reads as
   * a sticker, which is exactly what the last pass shipped. */
  const flankT = 0.0045;
  const wCore = w - flankT * 2;
  const flankX = w * 0.5 - flankT * 0.5;
  const shellH = h * 0.78;

  kit.add(loft(octagon(wCore, shellH, 0.0022), [
    { z: front, scale: 0.94, scaleY: 0.90 },
    { z: front + 0.0022, scale: 1 },
    { z: back - 0.010, scale: 1 },
    { z: back, scale: 0.96, scaleY: 0.94 },
  ]), S_RECV, { pos: [0, 0.004, 0] });

  const portZ = zc - 0.030, portLen = 0.052, portH = 0.026;
  const flankZ0 = front + 0.004, flankZ1 = back - 0.006;
  const flankLen = flankZ1 - flankZ0, flankZc = (flankZ0 + flankZ1) * 0.5;
  const flankH = shellH * 0.94;
  const flankY = 0.004;                       // flank centred on the shell
  const yTop = flankY + flankH * 0.5, yBot = flankY - flankH * 0.5;
  const pTop = 0.006 + portH * 0.5, pBot = 0.006 - portH * 0.5;
  const zF = portZ - portLen * 0.5, zB = portZ + portLen * 0.5;

  // Left flank: one continuous plate.
  kit.add(chamferBox(flankT, flankH, flankLen, 0.0012), S_RECV, { pos: [-flankX, flankY, flankZc] });
  // Right flank: four bars framing the port opening.
  kit.add(chamferBox(flankT, yTop - pTop, flankLen, 0.0012), S_RECV, { pos: [flankX, (yTop + pTop) * 0.5, flankZc] });
  kit.add(chamferBox(flankT, pBot - yBot, flankLen, 0.0012), S_RECV, { pos: [flankX, (pBot + yBot) * 0.5, flankZc] });
  kit.add(chamferBox(flankT, portH, zF - flankZ0, 0.0012), S_RECV, { pos: [flankX, 0.006, (flankZ0 + zF) * 0.5] });
  kit.add(chamferBox(flankT, portH, flankZ1 - zB, 0.0012), S_RECV, { pos: [flankX, 0.006, (zB + flankZ1) * 0.5] });

  // Rail riser and the rail itself — anodised aluminium, not receiver steel.
  const deckY = h * 0.40 + 0.002;
  kit.add(chamferBox(w * 0.62, 0.010, len - 0.004, 0.0012), S_RAIL, { pos: [0, deckY, zc] });
  kit.addParts(picatinny(len - 0.006, { detail: D >= 1 ? 1 : 0 }), S_RAIL, { pos: [0, deckY + 0.005, zc] });

  // Charging-handle raceway: a recessed channel in the rear of the upper, so
  // the handle rides *in* something instead of floating behind the receiver.
  const raceY = h * 0.24;
  kit.add(chamferBox(w * 0.84, 0.020, 0.038, 0.0014), S_RECV, { pos: [0, raceY, back - 0.012] });
  // Frame stands proud of the raceway roof, so the handle sits in a channel.
  kit.addParts(recessPanel(0.021, 0.036, 0.0050, { lip: 0.0020 }), S_RECV,
    { pos: [0, raceY + 0.010, back - 0.012] });
  // Receiver-extension boss at the rear.
  kit.add(lathe([[0, back + 0.030], [0.0155, back + 0.030], [0.0175, back + 0.028],
    [0.0175, back - 0.006], [0, back - 0.006]], seg('small', D)), S_RECV, { pos: [0, -0.004, 0] });

  // Milled relief above and below the opening — the proud lips a real port
  // carries, which is what catches the light and announces the hole.
  const portX = w * 0.5;
  kit.add(chamferBox(0.0044, 0.0034, portLen + 0.012, 0.0008), S_RECV, { pos: [portX - 0.0004, pTop + 0.0018, portZ] });
  kit.add(chamferBox(0.0044, 0.0034, portLen + 0.012, 0.0008), S_RECV, { pos: [portX - 0.0004, pBot - 0.0018, portZ] });

  // Brass deflector — the wedge behind the port that keeps cases off the face.
  kit.add(chamferWedge(0.013, 0.004, 0.020, 0.026, 0.0010), S_RECV,
    { pos: [portX - 0.004, 0.012, portZ + portLen * 0.5 + 0.016], rot: [0, 0, -0.35] });

  // Forward assist: a plunger in a boss, just behind the deflector.
  kit.add(cyl(0.0072, 0.0060, 0.014, seg('tiny', D)), S_RECV,
    { pos: [portX - 0.002, 0.016, portZ + portLen * 0.5 + 0.014], rot: [0, -Math.PI / 2, 0] });
  kit.add(cyl(0.0050, 0.0050, 0.005, seg('tiny', D)), S_RECV,
    { pos: [portX + 0.010, 0.016, portZ + portLen * 0.5 + 0.014], rot: [0, -Math.PI / 2, 0] });

  if (D >= 1) {
    // Takedown pins and the moulding seam along both flanks.
    kit.mirrored((k) => {
      k.add(panelLine(len - 0.02, { width: 0.0014, depth: 0.0010 }), S_RECV, { pos: [w * 0.5 - 0.0004, -h * 0.30, zc] });
      k.add(cyl(0.0055, 0.0042, 0.005, seg('tiny', D)), S_RECV, { pos: [w * 0.5 - 0.001, -0.012, back - 0.020], rot: [0, -Math.PI / 2, 0] });
      k.add(cyl(0.0055, 0.0042, 0.005, seg('tiny', D)), S_RECV, { pos: [w * 0.5 - 0.001, -0.012, front + 0.022], rot: [0, -Math.PI / 2, 0] });
    });
  }
  return { front, back, portZ, portLen, portH, deckY, raceY };
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
  kit.add(well, S_RECV, { pos: [0, topY, zc - 0.020] });

  // Body around the fire-control group.
  kit.add(chamferBox(w, h, 0.088, 0.0020), S_RECV, { pos: [0, topY - h * 0.5 + 0.006, zc + 0.030] });

  // Trigger guard: a swept rounded-U, not a box with a hole punched in it.
  const steps = D >= 1 ? 10 : 6;
  const guardRings = [];
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI * (i / steps);
    guardRings.push({ z: -Math.cos(a) * 0.021, dy: -Math.abs(Math.sin(a)) * 0.019 });
  }
  kit.add(loft(octagon(0.0075, 0.0060, 0.0012), guardRings), S_RECV,
    { pos: [0, topY - 0.021, zc + 0.052] });

  // Magazine release (right) and its fence; bolt-catch boss (left).
  kit.add(cyl(0.0060, 0.0048, 0.0068, seg('tiny', D)), S_RECV, { pos: [w * 0.5 - 0.001, topY - 0.014, zc + 0.006], rot: [0, -Math.PI / 2, 0] });
  kit.add(chamferBox(0.004, 0.014, 0.014, 0.0008), S_RECV, { pos: [w * 0.5, topY - 0.014, zc + 0.006] });
  kit.add(cyl(0.0072, 0.0072, 0.0040, seg('tiny', D)), S_RECV, { pos: [-w * 0.5 + 0.001, topY - 0.017, zc + 0.052], rot: [0, Math.PI / 2, 0] });

  // Sling loop at the rear of the lower.
  kit.add(new THREE.TorusGeometry(0.0062, 0.0016, 8, 18), S_RECV,
    { pos: [-w * 0.5 - 0.002, topY - 0.012, zc + 0.076], rot: [0, Math.PI / 2, 0] });

  return { topY, zc, w };
}

/* ------------------------------------------------------------- handguard */

/** Free-float handguard: an n-gon shell with M-LOK rows and a top rail. */
function handguard(kit, M, D, frontZ) {
  const hg = M.handguard;
  const z0 = frontZ, z1 = frontZ - hg.len;
  const r = hg.radius;

  // Twelve sides at 24 mm radius is a 12 mm flat with a hard arris between
  // every pair — at viewmodel range the handguard was reading as a hexagonal
  // extrusion with a rotating band of specular steps. Twenty sides puts the
  // facet under 8 mm and the highlight travels instead of snapping.
  const N = seg('hguard', D);
  kit.add(loft(ngon(r, N, Math.PI / N), [
    { z: z1, scale: 0.90 },
    { z: z1 + 0.004, scale: 0.98 },
    { z: z1 + 0.010, scale: 1.00 },
    { z: z0 - 0.026, scale: 1.00 },
    { z: z0 - 0.020, scale: 1.07 },     // barrel-nut collar
    { z: z0, scale: 1.07 },
  ]), S_RAIL, { pos: [0, 0.010, 0] });

  // Faces of an n-gon sit at the apothem, not the circumscribed radius. Rows
  // and ribs are placed on the face or they float / sink around the section.
  const face = r * Math.cos(Math.PI / N);

  // The top rail runs continuous with the receiver's — a monolithic upper.
  kit.addParts(picatinny(hg.len - 0.016, { detail: D >= 1 ? 1 : 0 }), S_RAIL,
    { pos: [0, 0.010 + face - 0.0012, (z0 + z1) * 0.5] });

  if (D >= 1) {
    // M-LOK rows at 3, 6 and 9 o'clock. These slots are what break up the long
    // featureless tube the left hand spends the entire match holding.
    const pitch = 0.032;
    const n = Math.max(1, hg.slots);
    const zs = (z0 + z1) * 0.5 - ((n - 1) * pitch) * 0.5;
    // Each row is rotated so its frame stands out along the shell's outward
    // normal: rotZ maps +Y onto that direction.
    const rows = [[1, 0, -Math.PI / 2], [-1, 0, Math.PI / 2], [0, -1, Math.PI]];
    for (const [nx, ny, rot] of rows) {
      kit.addParts(mlokSlots(n, { pitch, z0: 0 }), S_RAIL, {
        m: new THREE.Matrix4()
          .makeTranslation(nx * (face - 0.0003), 0.010 + ny * (face - 0.0003), zs)
          .multiply(new THREE.Matrix4().makeRotationZ(rot)),
      });
    }
    // QD sling socket, front left.
    kit.add(cyl(0.0055, 0.0030, 0.0045, seg('tiny', D)), S_RAIL, { pos: [-face + 0.001, 0.010, z1 + 0.030], rot: [0, Math.PI / 2, 0] });
    // Anti-rotation index tab and the barrel-nut clamp screws at the rear.
    kit.mirrored((k) => k.add(cyl(0.0026, 0.0022, 0.004, seg('tiny', D)), S_RAIL,
      { pos: [face * 0.72, 0.010 - face * 0.66, z0 - 0.012], rot: [0, -Math.PI / 2, 0] }));
  }

  // Heat-shield ribs on the underside, visible whenever the gun is canted.
  if (D >= 2) {
    for (let i = 0; i < 4; i++) {
      kit.add(panelLine(hg.len - 0.03, { width: 0.0016, depth: 0.0016 }), S_RAIL,
        { pos: [(i - 1.5) * 0.006, 0.010 - face + 0.0006, (z0 + z1) * 0.5] });
    }
  }
  return { z0, z1, radius: r, face };
}

/* ---------------------------------------------------------------- barrel */

/** Barrel, gas system and muzzle device. */
function barrelAssembly(kit, M, D, hg) {
  const b = M.barrel;
  const zB = 0.010;                    // breech face
  const zM = zB - b.len;               // muzzle crown
  const sgB = SEG.barrel[D];
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
  ], sgB), S_BARREL, { pos: [0, 0.010, 0] });

  if (b.fluted && D >= 1) {
    const flen = (zB - zM) * 0.5;
    kit.addParts(flutes(6, R + 0.0004, flen), S_BARREL, { pos: [0, 0.010, zB - 0.10 - flen * 0.5] });
  }

  /* --- gas block and front sight ----------------------------------------
   * The gas block was previously a bare box parked *inside* the handguard at
   * `hg.z1 + 0.030` — i.e. behind the shell that hides it — and there was no
   * front sight anywhere on any of the three weapons. Both are load-bearing
   * silhouette: the exposed journal between handguard and muzzle device is the
   * step that tells the eye where the barrel narrows, and a sight post standing
   * off the top of the barrel is the single most recognisable vertical on a
   * rifle. They now sit *ahead* of the handguard where they can be seen. */
  if (b.gasBlock) {
    // Centre it in the exposed run between handguard mouth and muzzle crown,
    // clamped off both so it never grows into either.
    const gz = THREE.MathUtils.clamp((hg.z1 + zM) * 0.5, zM + 0.019, hg.z1 - 0.015);
    const gw = R * 2.05, gh = R * 2.25;
    // Low-profile block: a chamfered saddle with a tapered front ramp.
    kit.add(loft(octagon(gw, gh, 0.0016), [
      { z: gz + 0.015, scale: 0.86, scaleY: 0.90 },
      { z: gz + 0.012, scale: 1.00 },
      { z: gz - 0.012, scale: 1.00 },
      { z: gz - 0.016, scale: 0.80, scaleY: 0.84 },
    ]), S_BARREL, { pos: [0, 0.010 + gh * 0.16, 0] });
    // Gas tube running back over the barrel and under the handguard.
    kit.add(cyl(0.0025, 0.0025, Math.abs(gz - (hg.z0 - 0.010)), seg('tiny', D)), S_BARREL,
      { pos: [0, 0.010 + gh * 0.44, gz] });
    if (D >= 1) {
      // Two set screws in the side of the block.
      kit.mirrored((k) => k.add(cyl(0.0022, 0.0018, 0.0022, seg('tiny', D)), S_BARREL,
        { pos: [gw * 0.5, 0.010 + gh * 0.16, gz], rot: [0, -Math.PI / 2, 0] }));
    }

    // Front sight: a base on the block, two protective ears and a round post
    // between them, with the classic detent drum at its foot.
    const baseY = 0.010 + gh * 0.60;
    const postH = R * 2.6;
    kit.add(chamferBox(gw * 0.80, 0.0040, 0.020, 0.0010), S_BARREL, { pos: [0, baseY, gz] });
    kit.mirrored((k) => k.add(loft(octagon(0.0034, postH, 0.0008), [
      { z: gz + 0.008, scale: 0.85, scaleY: 0.72 },
      { z: gz + 0.006, scale: 1.00, scaleY: 0.94 },
      { z: gz - 0.006, scale: 1.00, scaleY: 1.00 },
      { z: gz - 0.008, scale: 0.85, scaleY: 0.88 },
    ]), S_BARREL, { pos: [gw * 0.28, baseY + postH * 0.5, 0] }));
    kit.add(cyl(0.0016, 0.0013, postH * 0.92, seg('tiny', D)), S_BARREL,
      { pos: [0, baseY, gz], rot: [-Math.PI / 2, 0, 0] });
    kit.add(cyl(0.0034, 0.0034, 0.0035, seg('tiny', D)), S_BARREL,
      { pos: [0, baseY + 0.0005, gz], rot: [-Math.PI / 2, 0, 0] });
  }

  // Muzzle device.
  let tipZ;
  if (M.muzzle === 'flashhider') {
    tipZ = zM - 0.040;
    kit.add(lathe([
      [0, zM + 0.001], [R * 1.35, zM + 0.001], [R * 1.35, zM - 0.006],
      [R * 1.20, zM - 0.008], [R * 1.20, tipZ], [R * 0.62, tipZ],
      [R * 0.62, tipZ + 0.016], [0, tipZ + 0.016],
    ], seg), S_BARREL, { pos: [0, 0.010, 0] });
    // Four prongs with the classic open slots between them.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      kit.add(chamferBox(0.0042, 0.0042, 0.030, 0.0008), S_BARREL, {
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
    ], seg), S_BARREL, { pos: [0, 0.010, 0] });
    for (let i = 0; i < 3; i++) {
      kit.mirrored((k) => k.add(chamferBox(0.0016, 0.010, 0.0042, 0.0004), S_BARREL,
        { pos: [R * 1.4, 0.010, zM - 0.006 - i * 0.007] }));
    }
  } else {
    tipZ = zM - 0.052;
    kit.add(lathe([
      [0, zM + 0.001], [R * 1.60, zM + 0.001], [R * 1.60, tipZ + 0.004], [R * 1.25, tipZ],
      [R * 0.55, tipZ], [R * 0.55, tipZ + 0.018], [0, tipZ + 0.018],
    ], seg), S_BARREL, { pos: [0, 0.010, 0] });
    for (let i = 0; i < 3; i++) {
      kit.mirrored((k) => k.add(chamferBox(0.0022, 0.014, 0.0060, 0.0005), S_BARREL,
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

  kit.add(cyl(tubeR, tubeR, tubeLen, seg('small', D)), S_RECV, { pos: [0, -0.004, backZ] });
  if (D >= 1) {
    for (let i = 0; i < 6; i++) {              // length-of-pull notches
      kit.add(chamferBox(0.008, 0.0035, 0.0060, 0.0006), S_RECV,
        { pos: [0, -0.004 - tubeR + 0.0015, backZ + 0.030 + i * 0.020] });
    }
  }

  if (kind === 'folding') {
    kit.mirrored((k) => k.add(chamferBox(0.005, 0.006, 0.090, 0.0010), S_RECV,
      { pos: [0.016, -0.006, backZ + 0.070], rot: [0, 0.10, 0] }));
    kit.add(chamferBox(0.046, 0.030, 0.008, 0.0014), S_RUBBER, { pos: [0, -0.008, backZ + 0.116] });
    return { buttZ: backZ + 0.120, cheekY: 0.010 };
  }

  if (kind === 'precision') {
    kit.add(chamferBox(0.034, 0.052, 0.150, 0.0022), S_POLY, { pos: [0, -0.006, backZ + 0.082] });
    kit.add(chamferBox(0.040, 0.014, 0.086, 0.0016), S_POLY, { pos: [0, 0.026, backZ + 0.070] });      // cheek riser
    kit.mirrored((k) => k.add(chamferBox(0.006, 0.014, 0.030, 0.0008), S_RECV, { pos: [0.014, 0.014, backZ + 0.070] }));
    kit.add(chamferBox(0.020, 0.026, 0.060, 0.0014), S_POLY, { pos: [0, -0.036, backZ + 0.058], rot: [0.12, 0, 0] }); // toe hook
    kit.add(chamferBox(0.046, 0.062, 0.012, 0.0018), S_RUBBER, { pos: [0, -0.004, backZ + 0.160] });
    kit.add(new THREE.TorusGeometry(0.0060, 0.0016, 8, 18), S_RECV, { pos: [0, -0.032, backZ + 0.140], rot: [0, Math.PI / 2, 0] });
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
  kit.mirrored((k) => k.add(chamferBox(0.0030, 0.012, m.depth * 0.8, 0.0006), 1,
    { pos: [m.width * 0.5 - 0.001, 0.004, 0] }));

  // Body and ribs are moulded polymer; floorplate and feed lips are steel.
  const mesh = new THREE.Mesh(kit.build(), [mats[S_POLY], mats[S_RECV]]);
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
  // The optic bell is a 40 mm circle held 100 mm from the eye — it subtends
  // more of the frame than any other single part and it is the one shape the
  // player stares through. Twenty segments made it a visible polygon; 36 puts
  // the facet under 10 degrees, below where the silhouette reads as straight
  // edges. Turrets and rings step up with it.
  const seg = SEG.optic[D];
  const sgS = SEG.small[D];

  if (kind === 'scope') {
    const axisY = railY + 0.030;
    const zR = zc + 0.075, zF = zc - 0.115;
    for (const z of [zc + 0.020, zc - 0.045]) {           // mount rings
      kit.add(cyl(0.0205, 0.0205, 0.014, sgS), S_RAIL, { pos: [0, axisY, z - 0.007] });
      kit.add(chamferBox(0.022, 0.026, 0.018, 0.0012), S_RAIL, { pos: [0, axisY - 0.022, z] });
    }
    // Closed annular section: ocular bell, 30 mm body, objective bell, then
    // back down the bore so the shooter can actually see through it.
    kit.add(lathe([
      [0.0215, zR], [0.0215, zR - 0.026], [0.0160, zR - 0.034],
      [0.0160, zc + 0.030], [0.0175, zc + 0.026], [0.0175, zc - 0.050],
      [0.0155, zc - 0.054], [0.0155, zF + 0.048], [0.0250, zF + 0.030],
      [0.0250, zF],
      [0.0136, zF], [0.0136, zR], [0.0215, zR],
    ], seg), S_RAIL, { pos: [0, axisY, 0] });
    kit.add(cyl(0.0125, 0.0110, 0.016, sgS), S_RAIL, { pos: [0, axisY + 0.014, zc - 0.010], rot: [-Math.PI / 2, 0, 0] });
    kit.add(cyl(0.0110, 0.0098, 0.014, sgS), S_RAIL, { pos: [0.014, axisY, zc - 0.010], rot: [0, -Math.PI / 2, 0] });
    kit.add(cyl(0.0195, 0.0195, 0.020, sgS), S_RAIL, { pos: [0, axisY, zR - 0.050] });
    if (D >= 1) kit.addParts(knurl(D >= 2 ? 20 : 14, 0.0198, 0.018), S_RAIL, { pos: [0, axisY, zR - 0.041] });
    return { axisY, rearZ: zR - 0.028, frontZ: zF + 0.004, glassR: 0.0132, eyeRelief: 0.130 };
  }

  if (kind === 'reflex') {
    const axisY = railY + 0.017;
    // Open-emitter reflex: shroud arms, a canted lens, an emitter housing.
    kit.mirrored((k) => k.add(chamferBox(0.0040, 0.030, 0.044, 0.0010), S_RAIL, { pos: [0.0165, axisY + 0.002, zc - 0.002] }));
    kit.add(chamferBox(0.037, 0.005, 0.044, 0.0010), S_RAIL, { pos: [0, axisY + 0.016, zc - 0.002] });
    kit.add(chamferBox(0.037, 0.016, 0.020, 0.0012), S_RAIL, { pos: [0, axisY - 0.017, zc + 0.008] });
    kit.add(chamferBox(0.028, 0.010, 0.014, 0.0010), S_RAIL, { pos: [0, axisY - 0.011, zc - 0.026] });
    kit.add(chamferBox(0.030, 0.008, 0.032, 0.0010), S_RAIL, { pos: [0, axisY - 0.026, zc] });  // rail clamp
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
  ], seg), S_RAIL, { pos: [0, axisY, 0] });
  kit.add(tube(0.0192, 0.0176, zF, zF - 0.013, seg), S_RAIL, { pos: [0, axisY, 0] });   // sun hood
  kit.add(chamferBox(0.020, 0.024, 0.048, 0.0014), S_RAIL, { pos: [0, axisY - 0.021, zc] });
  kit.add(chamferBox(0.030, 0.008, 0.030, 0.0012), S_RAIL, { pos: [0, axisY - 0.032, zc] });
  kit.add(cyl(0.0080, 0.0064, 0.011, sgS), S_RAIL, { pos: [0.013, axisY - 0.026, zc], rot: [0, -Math.PI / 2, 0] });
  kit.add(cyl(0.0085, 0.0072, 0.012, sgS), S_RAIL, { pos: [0, axisY + 0.015, zc + 0.002], rot: [-Math.PI / 2, 0, 0] });
  kit.add(cyl(0.0075, 0.0064, 0.010, sgS), S_RAIL, { pos: [0.015, axisY, zc + 0.002], rot: [0, -Math.PI / 2, 0] });
  if (D >= 1) {
    kit.addParts(knurl(D >= 2 ? 18 : 12, 0.0086, 0.010), S_RAIL, { pos: [0, axisY + 0.020, zc + 0.002], rot: [-Math.PI / 2, 0, 0] });
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

  /* Charging handle. The old one was a 30 mm slab tucked at the rear of the
   * receiver with its latch buried inside the buffer-tube boss — present in the
   * scene graph, invisible in every frame, which is why the review recorded it
   * as missing. It is now the real thing: a shaft riding the raceway, a T-body
   * standing proud of the upper, and a hinged latch running out to the left
   * with a serrated grip face. It reads at any distance because it breaks the
   * receiver's top line, which nothing else back there does. */
  const chKit = new Kit();
  chKit.add(chamferBox(0.019, 0.0075, 0.062, 0.0010), 0, { pos: [0, 0, -0.004] });   // shaft, riding the channel
  chKit.add(chamferBox(0.040, 0.013, 0.014, 0.0012), 0, { pos: [0, 0.0026, 0.031] }); // T-body
  chKit.add(chamferBox(0.052, 0.0085, 0.010, 0.0010), 0, { pos: [-0.014, 0.0030, 0.036] }); // latch arm, left
  chKit.add(chamferBox(0.014, 0.0130, 0.011, 0.0012), 0, { pos: [-0.036, 0.0030, 0.036] }); // latch paddle
  for (let i = 0; i < 4; i++) {                       // serrations on the paddle
    chKit.add(chamferBox(0.0016, 0.0140, 0.0016, 0.0003), 0, { pos: [-0.0405 + i * 0.0030, 0.0030, 0.0405] });
  }
  chKit.add(cyl(0.0022, 0.0022, 0.014, seg('tiny', D)), 0,
    { pos: [-0.0075, 0.0030, 0.036], rot: [0, Math.PI / 2, 0] });                     // latch pivot pin
  const charge = new THREE.Mesh(chKit.build(), mats[S_RECV]);
  charge.name = 'charging';
  charge.position.set(0, up.raceY + 0.0125, up.back - 0.014);
  track('charge', charge);

  // Bolt carrier. Now that the ejection port is a genuine opening this is the
  // thing seen through it, so it gets a face worth looking at: carrier body,
  // bolt head with extractor claw, and the cam pin boss.
  const boltKit = new Kit();
  boltKit.add(cyl(0.0102, 0.0092, 0.040, seg('small', D)), 0, { pos: [0, 0, -0.020] });
  boltKit.add(cyl(0.0072, 0.0072, 0.008, seg('small', D)), 0, { pos: [0, 0, 0.004] });
  boltKit.add(chamferBox(0.0075, 0.0060, 0.016, 0.0006), 0, { pos: [0.0072, 0.0052, -0.002] }); // extractor
  boltKit.add(cyl(0.0032, 0.0032, 0.006, seg('tiny', D)), 0, { pos: [0, 0.0090, -0.014], rot: [-Math.PI / 2, 0, 0] });
  const bolt = new THREE.Mesh(boltKit.build(), mats[S_RECV]);
  bolt.name = 'bolt';
  // Ride the carrier out against the right wall rather than on the centreline.
  // The core shell is solid, so a bolt sitting on the bore axis is buried
  // inside it and the new port opening would frame nothing but a flat recess;
  // pushed outboard, its curved face sits *in* the opening where the eye
  // expects the carrier, and the rest of it hides inside the receiver.
  bolt.position.set(M.receiverW * 0.5 - 0.0122, 0.008, up.portZ);
  track('bolt', bolt);

  // Ejection-port cover, hinged on its lower edge.
  const coverKit = new Kit();
  coverKit.add(chamferBox(0.0030, up.portH - 0.002, up.portLen, 0.0008), 0, { pos: [0, (up.portH - 0.002) * 0.5, 0] });
  coverKit.add(chamferBox(0.0050, 0.0035, up.portLen * 0.4, 0.0006), 0, { pos: [0.0012, up.portH - 0.004, 0] });
  const cover = new THREE.Mesh(coverKit.build(), mats[S_RECV]);
  cover.name = 'portCover';
  cover.position.set(M.receiverW * 0.5 - 0.0012, 0.006 - up.portH * 0.5, up.portZ);
  track('cover', cover, 'rotation');

  const trig = new THREE.Mesh(chamferBox(0.006, 0.020, 0.006, 0.0008), mats[S_RECV]);
  trig.name = 'trigger';
  trig.position.set(0, low.topY - 0.022, low.zc + 0.050);
  trig.rotation.x = 0.25;
  track('trigger', trig, 'rotation');

  // Safety selector: rotates about its own axis between safe and fire.
  const selKit = new Kit();
  selKit.add(cyl(0.0060, 0.0060, 0.006, 10), 0);
  selKit.add(chamferBox(0.0060, 0.020, 0.0045, 0.0008), 0, { pos: [0, -0.009, 0.004] });
  const sel = new THREE.Mesh(selKit.build(), mats[S_RECV]);
  sel.name = 'selector';
  sel.position.set(-low.w * 0.5, low.topY - 0.014, low.zc + 0.040);
  sel.rotation.y = Math.PI / 2;           // local +Z points to the shooter's left
  track('selector', sel, 'rotation');

  // Bolt catch paddle, pressed on an empty reload.
  const catchKit = new Kit();
  catchKit.add(chamferBox(0.005, 0.014, 0.022, 0.0008), 0);
  catchKit.add(chamferBox(0.006, 0.008, 0.008, 0.0006), 0, { pos: [0, -0.008, -0.008] });
  const boltCatch = new THREE.Mesh(catchKit.build(), mats[S_RECV]);
  boltCatch.name = 'boltCatch';
  boltCatch.position.set(-low.w * 0.5 - 0.002, low.topY - 0.016, low.zc - 0.004);
  track('boltCatch', boltCatch);

  /* --- optics ------------------------------------------------------------ */
  const sightGroup = new THREE.Group();
  sightGroup.position.set(0, optic.axisY, optic.rearZ);
  root.add(sightGroup);

  // The lens edge is the same circle as the bell it sits in; if the disc is
  // coarser than the housing the glass reads as a polygon inside a tube.
  const glassGeo = new THREE.CircleGeometry(optic.glassR, seg('optic', D) + 4);
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
  // ADS is derived, not authored, and it is derived from *the same object* the
  // optical axis is measured from: put the weapon root wherever it takes to
  // land `sightGroup` on the camera's own -Z axis at the correct eye relief.
  // Reading `sightGroup.position` rather than re-deriving `optic.axisY` /
  // `optic.rearZ` means the pose cannot silently disagree with the optic if
  // either is ever changed. Rotation is identity, so the group's world
  // position at full blend is exactly (0, 0, -eyeRelief): dead centre, to the
  // pixel, at any FOV or aspect.
  const adsPose = {
    pos: new THREE.Vector3(
      -sightGroup.position.x,
      -sightGroup.position.y,
      -sightGroup.position.z - optic.eyeRelief,
    ),
    rot: new THREE.Euler(0, 0, 0),
  };

  // Everything that will actually be drawn: the merged body plus the magazine,
  // which hangs 17 cm below the bore and is the part that decides where the
  // bottom of the frame falls.
  const hipPose = solveHipPose([
    { array: bodyGeo.attributes.position.array, offset: null },
    { array: mag.geometry.attributes.position.array, offset: mag.position },
  ], muzzle.position, { rx: 0, ry: 0.26, rz: 0.045 });

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
      // Angular radius of the reticle quad, in radians (see RETICLE_ANGLE).
      reticleAngle: RETICLE_ANGLE[def.optic] ?? RETICLE_ANGLE.reddot,
    },
    anchors, hipPose, adsPose,
    triangles: bodyGeo.attributes.position.count / 3,
    dispose() {
      bodyGeo.dispose();
      for (const k of Object.keys(parts)) parts[k]?.geometry?.dispose?.();
      glassGeo.dispose();
      reticle.geometry.dispose();
      reticle.userData.disposeTexture?.dispose();
      reticle.material.dispose();
      reticle.parent?.remove(reticle);
    },
  };
}

/* ------------------------------------------------------------- hip framing */

/**
 * Solve the hip pose against the frame instead of hand-tuning three numbers.
 *
 * The previous pose was authored for the receiver alone and it failed in four
 * separate ways once a whole weapon was hung off it, all of which the review
 * caught:
 *
 *  - **The yaw was the wrong sign.** A negative yaw swings the *muzzle*
 *    outboard and the *butt* inboard, so the gun crossed the frame as a
 *    diagonal band with its stock in the middle of the screen. The muzzle has
 *    to come inboard toward the point of aim and the stock has to go out to
 *    the corner; that is a positive yaw about +Y.
 *  - **The stock was inside the near plane.** With the root 272 mm out and a
 *    600 mm weapon, the butt pad landed 4 mm *behind* the camera. Geometry
 *    clipped by the 5 mm near plane is what ate the bottom edge of all ten
 *    frames.
 *  - **The magazine hung 80% of a screen height below the bottom edge.**
 *  - **It was one constant for three weapons** 380, 600 and 760 mm long.
 *
 * So the pose is solved from the weapon's own geometry against the actual
 * viewmodel frustum:
 *   1. push it out until the rearmost vertex clears the eye by `BUTT_CLEAR`;
 *   2. raise it until *every* vertex clears the bottom edge;
 *   3. slide it right until the muzzle sits just inboard of centre — the bore
 *      converging toward the point of aim, which is what hip fire looks like —
 *      but no further right than keeps every vertex inside the right edge,
 *      leaving the receiver, magwell and stock filling the bottom-right
 *      quadrant behind it.
 *
 * Steps 2 and 3 are solved over the real vertices, not over the bounding box.
 * A rifle's AABB corner at (lowest y, rearmost z) is the magazine floor
 * teleported back to the butt pad — a point that exists on no part of the gun,
 * two hundred millimetres nearer the eye than the thing it claims to bound. In
 * perspective that error is not conservative in a useful direction: it lifts
 * the whole weapon a third of a screen. Both constraints are linear in the
 * offset being solved (`ndc = (t + p)/(tan * depth)`, and depth depends only on
 * `tz`), so the exact answer is a single max/min over vertices — one pass, no
 * iteration, ~50k points at build time.
 *
 * Screen targets are in NDC, so they hold at any aspect and any FOV.
 */
function solveHipPose(meshes, muzzleLocal, rot) {
  const BUTT_CLEAR = 0.175;   // metres from the eye to the rearmost vertex
  const BOTTOM_NDC = -1.05;   // lowest vertex, a hair past the bottom edge
  const RIGHT_NDC = 0.99;     // rightmost vertex, just inside the right edge
  const MUZZLE_NDC = -0.06;   // muzzle a touch inboard of the crosshair
  const NEAR = 0.02;

  const fovY = THREE.MathUtils.degToRad(Config.camera.viewmodelFov);
  const tanY = Math.tan(fovY * 0.5);
  // Aspect is unknown at build time and the harness shoots 16:9; solving X in
  // NDC against a 16:9 frustum keeps the muzzle inboard on wider screens too.
  const tanX = tanY * (16 / 9);

  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot.rx, rot.ry, rot.rz, 'YXZ'));
  const v = new THREE.Vector3();
  const each = (fn) => {
    for (const { array, offset } of meshes) {
      for (let i = 0; i < array.length; i += 3) {
        v.set(array[i], array[i + 1], array[i + 2]).applyQuaternion(q);
        if (offset) v.add(offset);
        fn(v);
      }
    }
  };

  let maxZ = -Infinity;
  each((p) => { if (p.z > maxZ) maxZ = p.z; });
  const tz = -(maxZ + BUTT_CLEAR);

  let ty = -Infinity, txCap = Infinity;
  each((p) => {
    const d = -(tz + p.z);
    if (d < NEAR) return;
    const y = BOTTOM_NDC * tanY * d - p.y;
    if (y > ty) ty = y;
    const x = RIGHT_NDC * tanX * d - p.x;
    if (x < txCap) txCap = x;
  });

  // The muzzle crown itself, not a bounding-box corner: X is aimed at the bore
  // line, so a wide optic or stock cannot drag the point of aim sideways.
  const front = muzzleLocal.clone().applyQuaternion(q);
  const dFront = Math.max(NEAR, -(tz + front.z));
  const tx = Math.min(MUZZLE_NDC * tanX * dFront - front.x, txCap);

  return {
    pos: new THREE.Vector3(tx, Number.isFinite(ty) ? ty : 0, tz),
    rot: new THREE.Euler(rot.rx, rot.ry, rot.rz, 'YXZ'),
  };
}

/* ------------------------------------------------------------------ reticle */

/**
 * The reticle, and why the last one photographed as clear glass.
 *
 * It was authored to subtend a physically honest angle: a 0.5-unit disc at
 * 5.8e-4 rad per unit is a 2 MOA dot. Two MOA is 0.033 degrees. At the
 * viewmodel's 55-degree vertical FOV on a 1080-line frame that is **0.6 of one
 * pixel** — a triangle smaller than a sample, drawn with no coverage-based
 * antialiasing, into a buffer the bloom pass has already finished with (the
 * viewmodel is composited *after* post, so an over-range emissive colour buys
 * nothing). A physically exact reticle is an invisible reticle.
 *
 * Every shipped optic solves this the same way, and so does this one: the dot
 * is drawn as a *glow* — a small saturated core inside a wide soft halo — and
 * sized to a target in pixels rather than in minutes of angle. The core lands
 * at about 4 px and the halo at about 14 px at 1080p, which is what a bright
 * emitter looks like through a camera and through an eye alike. The pattern
 * lives in a texture rather than in geometry so the falloff is smooth instead
 * of faceted, and one quad replaces the twelve plates the old cross needed.
 *
 * `RETICLE_ANGLE` still sets the scale, so the pattern remains angle-locked:
 * it does not grow or shrink as the maths moves the plane along the axis.
 */
function makeReticle(def, mat, D) {
  const kind = def.optic === 'scope' || def.optic === 'reflex' ? def.optic : 'reddot';
  const size = D >= 1 ? 128 : 64;
  const tex = reticleTexture(kind, size);

  // One unit of quad = one `RETICLE_ANGLE`, so the plane is 2x2 and the module's
  // `scale = distance * angle` puts the halo edge exactly on that angle.
  const geo = new THREE.PlaneGeometry(2, 2);

  // The reticle owns its material: the map differs per optic family, and the
  // module writes `opacity` per frame for the eyebox falloff. The colour is
  // deliberately over range — the core clips to a warm white and the falloff
  // walks out through orange into red, which is how a bright emitter reads to
  // a camera and to an eye. Tone mapping is off, so the clip is the point.
  const m = mat.clone();
  m.map = tex;
  m.color = kind === 'scope'
    ? new THREE.Color(0.55, 2.60, 1.20)
    : new THREE.Color(3.20, 0.90, 0.35);
  m.needsUpdate = true;

  const mesh = new THREE.Mesh(geo, m);
  mesh.name = 'reticle';
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;
  mesh.userData.disposeTexture = tex;
  return mesh;
}

/**
 * Procedural reticle map: RGBA, premultiplied-ish intensity in all channels so
 * the additive blend needs no alpha test. Drawn analytically per texel with a
 * smooth radial falloff, which is what makes a 4 px dot read as a light source
 * rather than as four lit pixels.
 */
function reticleTexture(kind, N) {
  const coreR = RETICLE_CORE[kind] ?? 0.25;
  const data = new Uint8Array(N * N * 4);
  const c = (N - 1) * 0.5;
  const inv = 1 / c;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px = (x - c) * inv, py = (y - c) * inv;   // -1..1 across the quad
      const r = Math.hypot(px, py);
      let v = 0;

      // Core: saturated, hard-edged but antialiased over the last 28%.
      v = Math.max(v, 1 - smooth(r, coreR * 0.72, coreR));
      // Halo: the bloom the emitter would have produced, baked in.
      v = Math.max(v, Math.pow(Math.max(0, 1 - r), 3.2) * 0.55);

      if (kind === 'reflex') {
        // 35 MOA horseshoe, open at the bottom.
        const a = Math.atan2(py, px);
        const ring = 1 - smooth(Math.abs(r - 0.74), 0.028, 0.055);
        const gap = a < -Math.PI * 0.72 || a > -Math.PI * 0.28 ? 1 : 0;
        v = Math.max(v, ring * gap * 0.95);
      } else if (kind === 'scope') {
        // Duplex cross: fine inside, heavy outside, with a floating centre dot.
        const fine = (1 - smooth(Math.abs(py), 0.010, 0.020)) * (Math.abs(px) < 0.62 ? 1 : 0)
                   + (1 - smooth(Math.abs(px), 0.010, 0.020)) * (Math.abs(py) < 0.62 ? 1 : 0);
        const heavy = (1 - smooth(Math.abs(py), 0.030, 0.045)) * (Math.abs(px) > 0.62 ? 1 : 0)
                    + (1 - smooth(Math.abs(px), 0.030, 0.045)) * (Math.abs(py) > 0.62 ? 1 : 0);
        v = Math.max(v, Math.min(1, fine + heavy) * 0.9);
      }

      const b = Math.round(Math.min(1, v) * 255);
      const i = (y * N + x) * 4;
      data[i] = b; data[i + 1] = b; data[i + 2] = b; data[i + 3] = b;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function smooth(x, a, b) {
  const t = THREE.MathUtils.clamp((x - a) / Math.max(1e-6, b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
