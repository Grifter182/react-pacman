import * as THREE from 'three';
import { Config, QualityTier } from '../core/Config.js';
import { makeMaterial, getMaterialCatalog } from '../materials/TextureFactory.js';
import {
  Kit, chamferBox, chamferWedge, loft, lathe, tube, boredTube, cyl, knurl, octagon,
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
 * Metres per texture tile for the merged body's shared UV projection. Every
 * material slot is baked against this and tiled back to its own feature size
 * with `repeat` — see the note in `weaponMaterials`.
 */
const BODY_TILE = 0.35;

/**
 * How much finer than its authored scale a viewmodel surface is displayed.
 *
 * This is the fix for the digital camouflage, and getting to it took ruling out
 * three plausible-sounding causes with actual measurements (`src/weapons/probe.mjs`
 * plus `src/weapons/uv-audit.mjs`, both of which now exist for the next person):
 *
 *  - NOT the UVs. Per-part audit of the merged body: every part lands inside
 *    a 0.6 UV span, zero degenerate UV triangles, and texel density across all
 *    metal parts sits in a 2.4-3.0 texels/mm band. There is no seam and no
 *    density cliff to blame.
 *  - NOT the bake resolution. The probe reports every slot `ready` at its full
 *    allocation (1024/512/256) and the camouflage is still there.
 *  - NOT the metalness map. At full bake the conductor mask covers 2.8% of the
 *    receiver in 8 mm blobs on the arrises, which is what holster wear looks
 *    like. (The viewmodel forces `metalness: 0` anyway — see `DIELECTRIC`.)
 *
 * It is the AMBIENT OCCLUSION channel of the ARM map — see `VIEWMODEL_AO`,
 * which is the actual fix. Feature size is the secondary half of it: the recipe
 * sizes its fields in metres against `worldScale` — 22 mm forging form, 18 mm
 * wear cells, 90 mm contact zones — which is right for a prop seen at three
 * metres and is a field of thumbnail-sized patches on a receiver held 500 mm
 * from the eye. Tiling the map `VIEWMODEL_MAGNIFY` times tighter than it was
 * baked pulls those to 8 mm, 6 mm and 32 mm, so what survives reads as grain
 * rather than as a pattern. The recipe itself is left alone; it is right, it is
 * simply being shown at the wrong magnification.
 *
 * Note this is deliberately NOT paired with a matching `worldScale`. Pairing
 * them (bake at W, tile back by BODY_TILE/W) is the right move when the goal is
 * to preserve a recipe's authored feature size across a mismatched projection —
 * that is what the rail comment below describes. Here the goal is the opposite:
 * to shrink the authored size, because the authoring assumption is wrong for a
 * surface this close to the camera. Setting both cancels out to a no-op, which
 * is worth knowing before "fixing" this by adding the worldScale back.
 */
export const VIEWMODEL_MAGNIFY = 2.4;

/**
 * Ambient-occlusion strength on the viewmodel. THIS is the digital camouflage.
 *
 * Proven by substitution in `src/weapons/probe.mjs`: with `aoMapIntensity = 0`
 * and nothing else changed, the receiver reads as clean parkerised steel with
 * bright polish only on the arrises. Put it back and the blue-black patchwork
 * returns exactly as captured. Flattening the whole ARM map removes it too, but
 * that test cannot say which of the three packed channels did it; the AO scalar
 * can, because it is separable without a second texture.
 *
 * The mechanism: the recipe derives AO from the curvature of its height field,
 * and that field is dominated by 22 mm forging form and 18 mm worley dings. So
 * the AO channel is a ~20 mm blotch field, and `ambientOcclusion` multiplies
 * *indirect diffuse* — which under a sky environment is most of what a matte
 * black surface shows. Multiplying a dark diffuse surface by a 20 mm noise mask
 * is a recipe for camouflage in the literal sense: it is how camouflage is
 * printed.
 *
 * Turning it down rather than off is the physically honest answer, and the
 * recipe agrees with it in its own comment — a 0.5 mm bead-blast texture
 * occludes essentially nothing. What genuinely occludes on a rifle is the
 * geometry (magwell, ejection port, under the rail), and that is already there
 * as geometry. Polymer keeps more, because a moulded stipple with 1 mm relief
 * really does self-shadow in its valleys.
 */
export const VIEWMODEL_AO = 0.22;

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
 * Material overrides forced onto every metal slot on the weapon, whatever
 * recipe the library ends up publishing for it.
 *
 * **The receiver must never carry a metalness map.** The recipe is right that
 * holster wear polishes phosphate back to bare conductor on the arrises, and at
 * full bake resolution that is a few per cent of the part. But a viewmodel is
 * the one surface in the game that is *magnified* — 300 mm of receiver across
 * 250 px means the eye reads individual texels of the wear mask — and the mask
 * is derived from curvature, which is meaningless until the height field is
 * resolved. Every intermediate resolution therefore paints large patches of
 * metalness 1, and metalness 1 under a sky environment is a mirror: the
 * blue-black blocks the review read as digital camouflage are literally
 * sky-coloured conductor blocks in the ARM map's blue channel.
 *
 * Parkerising is a dielectric conversion coating. Making the receiver a
 * dielectric everywhere is both the physically correct answer and the only one
 * that cannot degrade into camouflage: the polished arrises still read, because
 * roughness — which survives low resolution as a smooth field rather than a
 * thresholded one — still drops to a hard gloss on them.
 */
const DIELECTRIC = { metalnessMap: null, metalness: 0.0 };

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
  // `gunmetal` already is exactly this recipe. The only override is
  // `DIELECTRIC` — see the note on that constant; it is a viewmodel policy, not
  // a fallback shim, so it rides in `opts.material` where it survives the
  // library publishing a real `receiver_phosphate` preset later.
  //
  // `aoMapIntensity` and `repeat` are the other half of that policy — see
  // `VIEWMODEL_AO` and `VIEWMODEL_MAGNIFY` for the measurements behind them.
  // The roughness multiplier lifts the recipe's 0.17 gloss floor to about 0.32,
  // so a polished arris catches the sun as a sheen rather than as a picture of
  // the sky, while the matte majority saturates at 1.0. Below about 0.25 the
  // wear speckle comes back as hard blue rectangles — a smaller version of the
  // same defect, which is why this is not tuned to taste.
  const receiver = preset('receiver_phosphate', 'gunmetal', {
    seed: 91, size, detailStrength: 0.42,
    repeat: VIEWMODEL_MAGNIFY,
    envMapIntensity: 0.58,
    material: Object.assign({ roughness: 1.90, aoMapIntensity: VIEWMODEL_AO }, DIELECTRIC),
  });

  /* Rail, handguard and optic housings: type-III hard anodising. Darker than
   * the receiver and markedly rougher — anodising is a ceramic oxide, not a
   * coating, and it scatters rather than reflecting.
   *
   * READ THIS BEFORE CHANGING THE COLOUR HERE, BECAUSE IT IS NOT WHAT IT LOOKS
   * LIKE. The fourth argument is a SHIM and `preset` deliberately DROPS IT when
   * the named recipe exists. `getMaterialCatalog()` publishes `rail_anodised`
   * today — checked, in Node, against the live catalog — so the whole of the
   * object below is dead on every code path the game takes, and the rail's
   * rendered colour and roughness come out of `Recipes.rail_anodised`:
   * `C_ANODISE = srgb(0.210, 0.208, 0.211)`, i.e. 0.0345 linear, type-III
   * black, at roughness 0.86 and `metalness 0`. That is already near-black
   * hardcoat with no bright-steel wear anywhere, which is what the part is.
   *
   * A review of this line read `new THREE.Color(0.62, 0.63, 0.66)` as "a light
   * neutral grey", and it is worth being precise about why that reading is
   * wrong even on the dead path: `material.color` MULTIPLIES the recipe's
   * albedo map, and `gunmetal` bakes at 0.04-0.06. 0.62 x 0.05 is 0.031 linear
   * — darker than the receiver next to it, not lighter. There has never been a
   * bare-aluminium rail on this weapon; there was a number that looked like one
   * if you read it as an absolute.
   *
   * What the shim IS still for is the day someone unpublishes the recipe. So it
   * is kept, and its numbers are now the fallback that lands closest to the
   * live recipe rather than an older guess. The colour multiplier is 0.70 x
   * `gunmetal`'s 0.05 = 0.035 linear against C_ANODISE's 0.0345, biased warm by
   * about 9% (a loaded oxide goes slightly brown, never blue — the old figure
   * was biased the wrong way, which is the one substantive thing about it that
   * was wrong). The roughness multiplier is 3.0 rather than 1.22: gunmetal's
   * gloss floor is 0.17 and the receiver's x1.90 lifts it to 0.32, which leaves
   * the fallback rail GLOSSIER than the recipe's 0.86 — the opposite of
   * hardcoat. x3.0 puts the floor at 0.51 and saturates the matte majority, so
   * the rail stays the flattest metal on the gun on either path.
   *
   * `worldScale` / `repeat`: `worldScale` is the frequency the recipe BAKES at,
   * and the contract in TextureFactory is that a UV-mapped caller sets its UV
   * scale to match. The Kit projects the whole weapon at one scale
   * (1/BODY_TILE) because the parts share a merged buffer and a single UV
   * channel, so the only way to give a slot its own metres-per-tile is to tile
   * its texture. `rail_anodised` bakes at 0.35 m for exactly this reason and
   * therefore needs no `repeat` at all — see the worldScale table in Recipes.js,
   * and note that changing `repeat` here obliges a matching change there.
   */
  const rail = preset('rail_anodised', 'gunmetal', {
    seed: 137, size: half, detailStrength: 0.58,
  }, {
    worldScale: 0.20,
    repeat: (BODY_TILE / 0.20) * VIEWMODEL_MAGNIFY * 0.55,
    envMapIntensity: 0.70,
    material: Object.assign(
      { color: new THREE.Color(0.70, 0.67, 0.64), roughness: 3.00, aoMapIntensity: VIEWMODEL_AO },
      DIELECTRIC),
  });

  // Barrel, gas block and muzzle device: nitrided steel. Near-black, and the
  // only part of the gun with a genuinely hard specular — a barrel carries a
  // moving highlight down its length that nothing else on the weapon does.
  // Nitriding IS a conductor surface, so this one keeps its metalness — but as
  // a uniform scalar, never a thresholded map.
  const barrel = preset('barrel_nitride', 'gunmetal', {
    seed: 211, size: half, detailStrength: 0.26,
  }, {
    worldScale: 0.26,
    repeat: (BODY_TILE / 0.26) * VIEWMODEL_MAGNIFY * 0.55,
    envMapIntensity: 1.75,
    material: {
      color: new THREE.Color(0.80, 0.82, 0.87), roughness: 0.46,
      aoMapIntensity: VIEWMODEL_AO, metalnessMap: null, metalness: 0.62,
    },
  });

  // Furniture and contact surfaces get the same magnification correction as the
  // receiver. Polymer bakes at BODY_TILE already, so `repeat` is the whole
  // adjustment; rubber bakes at 0.5 m and needs the projection correction on
  // top of it, which is the one place the two factors legitimately multiply.
  const poly = preset('furniture_polymer', 'polymer', {
    seed: 43, size: half, repeat: VIEWMODEL_MAGNIFY * 0.85,
    material: { aoMapIntensity: VIEWMODEL_AO * 2.0 },
  });
  // Rubber is the one slot where the two factors legitimately multiply: it bakes
  // at 0.5 m, so it needs the projection correction (BODY_TILE/0.5) *and* the
  // viewmodel magnification. At 256px it was also the texel-density outlier on
  // the whole weapon — 0.9 texels/mm against the receiver's 7 — which reads as
  // a soft patch where the buttpad meets the stock. 512px brings it in band.
  const rubber = preset('grip_rubber', 'rubber', {
    seed: 12, size: half, repeat: (BODY_TILE / 0.5) * VIEWMODEL_MAGNIFY * 1.6,
    material: { aoMapIntensity: VIEWMODEL_AO * 2.0 },
  });

  // Optic glass. THE SIGHT HAS TO BE SEE-THROUGH — that is the whole function
  // of the part, and it outranks how the coating looks.
  //
  // This was previously authored as a look rather than as an aperture: two
  // discs at 0.34 opacity over a near-black tint, so only ~44% of the world's
  // light survived the stack, with a 2.4x environment specular and full
  // clearcoat laid on top. The result was a lens you saw *instead of* the
  // target — aiming showed the coating, not the scene behind it.
  //
  // A real AR-coated lens passes better than 90% of the light; the coating is
  // visible as a faint tint and an off-axis bloom, never as a filter. At 0.10
  // the two discs together still pass ~81%, which keeps the target readable
  // while leaving enough surface for the specular to catch and read as glass.
  const glass = new THREE.MeshPhysicalMaterial({
    name: 'lensGlass',
    color: 0x14201c, roughness: 0.045, metalness: 0.0,
    transparent: true, opacity: 0.10, depthWrite: false,
    clearcoat: 1.0, clearcoatRoughness: 0.05,
    // The specular has to stay a highlight, not a veil: at 2.4 the reflection
    // alone was brighter than the transmitted image on any lit surface.
    envMapIntensity: 0.9, side: THREE.DoubleSide,
  });

  // Emissive reticle: unlit, additive, outside the tone mapper so the bloom
  // pass sees a genuinely over-range value and blooms it like a real emitter.
  const lens = new THREE.MeshBasicMaterial({
    name: 'reticleEmitter',
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
 * A viewmodel barrel is 200 px of screen at hip and the optic bell is the
 * largest single shape in the frame when aimed. The rule used here is that a
 * facet must subtend less than about a pixel and a half of *chord sag* at the
 * distance the part is actually seen from. For a cylinder of radius r at
 * distance d, an n-gon's sag is r(1 - cos(pi/n)); with the bell at r = 19 mm
 * and d = 200 mm, 36 segments leaves 0.7 mm of sag — three pixels — and the
 * silhouette reads as a polygon against the sky. 56 brings it under a pixel.
 * The barrel and handguard step up with it because they are seen at 300 mm.
 *
 * These are the smallest counts that stop the silhouette reading as a prism,
 * not an arbitrary bump — the whole weapon at tier 2 is still under 30k
 * triangles, and the merge means the extra geometry costs no extra draw calls.
 */
const SEG = {
  //         LOW  MED  HIGH
  barrel:   [14,  28,  48],
  hguard:   [12,  20,  32],
  optic:    [20,  40,  64],
  small:    [10,  18,  28],
  tiny:     [ 6,  12,  20],
};
function seg(kind, D) { return SEG[kind][D]; }

/* ----------------------------------------------------------------- upper */

/** Upper receiver: flat-top with rail, forward assist, port, brass deflector. */
function upperReceiver(kit, M, D) {
  kit.label = 'upper';
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
    { pos: [portX - 0.002, 0.016, portZ + portLen * 0.5 + 0.014], rot: [0, Math.PI / 2, 0] });
  kit.add(cyl(0.0050, 0.0050, 0.005, seg('tiny', D)), S_RECV,
    { pos: [portX + 0.011, 0.016, portZ + portLen * 0.5 + 0.014], rot: [0, Math.PI / 2, 0] });

  if (D >= 1) {
    // Takedown pins and the moulding seam along both flanks.
    kit.mirrored((k) => {
      k.add(panelLine(len - 0.02, { width: 0.0014, depth: 0.0010 }), S_RECV, { pos: [w * 0.5 - 0.0004, -h * 0.30, zc] });
      k.add(cyl(0.0055, 0.0042, 0.005, seg('tiny', D)), S_RECV, { pos: [w * 0.5 - 0.001, -0.012, back - 0.020], rot: [0, Math.PI / 2, 0] });
      k.add(cyl(0.0055, 0.0042, 0.005, seg('tiny', D)), S_RECV, { pos: [w * 0.5 - 0.001, -0.012, front + 0.022], rot: [0, Math.PI / 2, 0] });
    });
  }
  return { front, back, portZ, portLen, portH, deckY, raceY };
}

/* ----------------------------------------------------------------- lower */

/** Lower receiver: magwell, trigger guard, controls, grip mount. */
function lowerReceiver(kit, M, D) {
  kit.label = 'lower';
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
  kit.add(cyl(0.0060, 0.0048, 0.0068, seg('tiny', D)), S_RECV, { pos: [w * 0.5 - 0.001, topY - 0.014, zc + 0.006], rot: [0, Math.PI / 2, 0] });
  kit.add(chamferBox(0.004, 0.014, 0.014, 0.0008), S_RECV, { pos: [w * 0.5, topY - 0.014, zc + 0.006] });
  kit.add(cyl(0.0072, 0.0072, 0.0040, seg('tiny', D)), S_RECV, { pos: [-w * 0.5 + 0.001, topY - 0.017, zc + 0.052], rot: [0, -Math.PI / 2, 0] });

  // Sling loop at the rear of the lower.
  kit.add(new THREE.TorusGeometry(0.0062, 0.0016, 8, 18), S_RECV,
    { pos: [-w * 0.5 - 0.002, topY - 0.012, zc + 0.076], rot: [0, Math.PI / 2, 0] });

  return { topY, zc, w };
}

/* ------------------------------------------------------------- handguard */

/** Free-float handguard: an n-gon shell with M-LOK rows and a top rail. */
function handguard(kit, M, D, frontZ) {
  kit.label = 'handguard';
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

  // End cap at the muzzle end — the shell's front is otherwise a bare loft cap,
  // and the ring of shadow inside a real handguard mouth is what tells the eye
  // the tube is hollow rather than a solid dowel.
  kit.add(tube(r * 0.905, r * 0.905 - 0.0040, z1 + 0.0005, z1 + 0.0060, N), S_RAIL, { pos: [0, 0.010, 0] });
  if (D >= 1) {
    // Castellated barrel nut under the rear collar.
    kit.addParts(knurl(D >= 2 ? 18 : 10, r * 1.045, 0.0095, { width: 0.0030, depth: 0.0022 }),
      S_RAIL, { pos: [0, 0.010, z0 - 0.0145] });
  }

  // The top rail runs continuous with the receiver's — a monolithic upper.
  const railBase = 0.010 + face - 0.0012;
  const railLen = hg.len - 0.016;
  kit.addParts(picatinny(railLen, { detail: D >= 1 ? 1 : 0 }), S_RAIL,
    { pos: [0, railBase, (z0 + z1) * 0.5] });
  // Top of the teeth and the forward end of the row: the optic's sight line has
  // to clear both, and this is the tallest thing downrange of the sight.
  const railTopY = railBase + 0.0032 + 0.0044;
  const railFrontZ = (z0 + z1) * 0.5 - railLen * 0.5;

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
    kit.add(cyl(0.0055, 0.0030, 0.0045, seg('tiny', D)), S_RAIL, { pos: [-face + 0.001, 0.010, z1 + 0.030], rot: [0, -Math.PI / 2, 0] });
    // Anti-rotation index tab and the barrel-nut clamp screws at the rear.
    kit.mirrored((k) => k.add(cyl(0.0026, 0.0022, 0.004, seg('tiny', D)), S_RAIL,
      { pos: [face * 0.72, 0.010 - face * 0.66, z0 - 0.012], rot: [0, Math.PI / 2, 0] }));
  }

  // Heat-shield ribs on the underside, visible whenever the gun is canted.
  if (D >= 2) {
    for (let i = 0; i < 4; i++) {
      kit.add(panelLine(hg.len - 0.03, { width: 0.0016, depth: 0.0016 }), S_RAIL,
        { pos: [(i - 1.5) * 0.006, 0.010 - face + 0.0006, (z0 + z1) * 0.5] });
    }
  }
  return { z0, z1, radius: r, face, railTopY, railFrontZ };
}

/* ---------------------------------------------------------------- barrel */

/** Barrel, gas system and muzzle device. */
function barrelAssembly(kit, M, D, hg, opticFitted) {
  kit.label = 'barrel';
  const b = M.barrel;
  const zB = 0.010;                    // breech face
  const zM = zB - b.len;               // muzzle crown
  const sgB = SEG.barrel[D];
  const R = b.radius;
  /**
   * Everything forward of the receiver that stands up into the sight line, as
   * `{ y, z }` samples of its highest point. `opticAssembly` solves the mount
   * height against these — see `SIGHT_CLEAR`. Without them the optic is placed
   * from a constant and the gun's own gas block and muzzle device end up inside
   * the sight picture, which is the bug this list exists to close.
   */
  const skyline = [];

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
        { pos: [gw * 0.5 - 0.0004, 0.010 + gh * 0.16, gz], rot: [0, Math.PI / 2, 0] }));
    }

    // Front sight: a base on the block, two protective ears and a round post
    // between them, with the classic detent drum at its foot.
    //
    // THE POST AND EARS ONLY EXIST WHEN NOTHING IS MOUNTED ABOVE THEM. They
    // stand about 4R off the bore, which puts them directly across the optic's
    // line of sight — aiming produced a sight picture full of the rifle's own
    // front sight instead of the target, which is why looking through the
    // scope showed nothing useful. Every optic-equipped rifle solves this the
    // same way: the irons fold flat and the optic owns the sight line. The
    // base stays, because a bare gas block with no sight base on top reads as
    // an unfinished barrel.
    const baseY = 0.010 + gh * 0.60;
    const postH = R * 2.6;
    kit.add(chamferBox(gw * 0.80, 0.0040, 0.020, 0.0010), S_BARREL, { pos: [0, baseY, gz] });
    skyline.push({ y: baseY + 0.0020 + (opticFitted ? 0.0061 : postH), z: gz });

    if (!opticFitted) {
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
    } else {
      // Folded: the sight lies along the base, so the silhouette keeps a step
      // at the gas block without anything standing up into the sight line.
      kit.add(chamferBox(gw * 0.44, 0.0052, 0.026, 0.0010), S_BARREL,
        { pos: [0, baseY + 0.0035, gz - 0.004] });
    }
  }

  /* --- muzzle device -----------------------------------------------------
   * THE MUZZLE DEVICE HAD NO BODY. All three of these `lathe()` calls passed
   * `seg` — the module-level *function* `seg(kind, D)` — where the radial
   * segment count goes. `THREE.LatheGeometry` does `segments = Math.floor(
   * segments)`, `Math.floor(aFunction)` is NaN, and its build loop is
   * `for (i = 0; i <= segments; i++)`, which never runs against NaN. Verified
   * in isolation: `new LatheGeometry(pts, () => 1)` yields a geometry with
   * ZERO vertices, against 50 for the same profile at 24 segments.
   *
   * So every weapon shipped with the flash hider / compensator / brake BODY
   * absent and only its prongs and ports present — four 4 mm bars floating in
   * space off the end of a barrel that stopped at the crown. That is the whole
   * of "the muzzle is not in frame": it was in frame, it was not there. It is
   * `sgB` (= SEG.barrel[D]) that belongs here, the same count the barrel itself
   * is turned at, so the device and the barrel share a silhouette.
   *
   * `muzzleTop` was computed from the intended radii and pushed onto `skyline`
   * regardless, so the sight cone has always cleared a device that was not
   * being drawn; nothing about the optic's height changes with this fix. */
  let tipZ, muzzleTop;
  if (M.muzzle === 'flashhider') {
    tipZ = zM - 0.040;
    muzzleTop = 0.010 + R * 1.16 + 0.0030;
    kit.add(lathe([
      [0, zM + 0.001], [R * 1.35, zM + 0.001], [R * 1.35, zM - 0.006],
      [R * 1.20, zM - 0.008], [R * 1.20, tipZ], [R * 0.62, tipZ],
      [R * 0.62, tipZ + 0.016], [0, tipZ + 0.016],
    ], sgB), S_BARREL, { pos: [0, 0.010, 0] });
    // Four prongs with the classic open slots between them.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      kit.add(chamferBox(0.0042, 0.0042, 0.030, 0.0008), S_BARREL, {
        m: new THREE.Matrix4().makeTranslation(0, 0.010, zM - 0.024)
          .multiply(new THREE.Matrix4().makeRotationZ(a))
          .multiply(new THREE.Matrix4().makeTranslation(0, R * 1.16, 0)),
      });
    }
    // Crush washer behind the shroud: the joint that says the device is threaded
    // onto a barrel rather than continuous with it. A `tube` rather than an open
    // lathe strip, so its section is closed, and its bore is set INSIDE the
    // barrel's 0.93R shank so the inner wall is buried rather than floating.
    kit.add(tube(R * 1.28, R * 0.90, zM + 0.0015, zM + 0.0075, sgB), S_BARREL, { pos: [0, 0.010, 0] });
  } else if (M.muzzle === 'compensator') {
    tipZ = zM - 0.028;
    muzzleTop = 0.010 + R * 1.45;
    kit.add(lathe([
      [0, zM + 0.001], [R * 1.45, zM + 0.001], [R * 1.45, tipZ + 0.002], [R * 1.10, tipZ],
      [R * 0.55, tipZ], [R * 0.55, tipZ + 0.012], [0, tipZ + 0.012],
    ], sgB), S_BARREL, { pos: [0, 0.010, 0] });
    for (let i = 0; i < 3; i++) {
      kit.mirrored((k) => k.add(chamferBox(0.0016, 0.010, 0.0042, 0.0004), S_BARREL,
        { pos: [R * 1.4, 0.010, zM - 0.006 - i * 0.007] }));
    }
    // Two upward gas ports — a compensator vents up, that is what it is for,
    // and they are the detail the muzzle flash lights from inside.
    for (let i = 0; i < 2; i++) {
      kit.add(chamferBox(0.0075, 0.0016, 0.0042, 0.0004), S_BARREL,
        { pos: [0, 0.010 + R * 1.40, zM - 0.008 - i * 0.009] });
    }
    kit.add(tube(R * 1.34, R * 0.90, zM + 0.0015, zM + 0.0075, sgB), S_BARREL, { pos: [0, 0.010, 0] });
  } else {
    tipZ = zM - 0.052;
    muzzleTop = 0.010 + R * 1.62;
    kit.add(lathe([
      [0, zM + 0.001], [R * 1.60, zM + 0.001], [R * 1.60, tipZ + 0.004], [R * 1.25, tipZ],
      [R * 0.55, tipZ], [R * 0.55, tipZ + 0.018], [0, tipZ + 0.018],
    ], sgB), S_BARREL, { pos: [0, 0.010, 0] });
    for (let i = 0; i < 3; i++) {
      kit.mirrored((k) => k.add(chamferBox(0.0022, 0.014, 0.0060, 0.0005), S_BARREL,
        { pos: [R * 1.55, 0.010, zM - 0.010 - i * 0.012], rot: [0.22, 0, 0] }));
    }
    // Baffle slots cut through the top of the can, between the side ports. A
    // brake with solid walls between its ports reads as a machined slug; these
    // are the openings the eye needs to believe gas leaves through them.
    for (let i = 0; i < 3; i++) {
      kit.add(chamferBox(0.0090, 0.0018, 0.0055, 0.0004), S_BARREL,
        { pos: [0, 0.010 + R * 1.56, zM - 0.016 - i * 0.012] });
    }
    kit.add(tube(R * 1.48, R * 0.90, zM + 0.0015, zM + 0.0085, sgB), S_BARREL, { pos: [0, 0.010, 0] });
  }
  // The muzzle device is the furthest thing downrange, so it needs the least
  // height to intrude on the sight line — sample it at both ends of its body.
  skyline.push({ y: muzzleTop, z: zM }, { y: muzzleTop, z: tipZ });
  return { zB, zM, tipZ, skyline };
}

/* ------------------------------------------------------------------ grip */

/** Pistol grip: raked, palm-swelled, finger grooves, beavertail, rubber plug. */
function pistolGrip(kit, M, D, anchor) {
  kit.label = 'grip';
  const rake = 0.36;
  const g = loft(roundRect(0.030, 0.038, 0.008, D >= 2 ? 5 : D >= 1 ? 3 : 2), [
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

/**
 * Stock: carbine (adjustable), folding (wire) or precision (chassis).
 *
 * **The rear third of the stock is not in the viewmodel.** A buttstock is a
 * shoulder interface; it exists behind the shooter's eye, and a first-person
 * camera sits roughly where the shooter's eye is. Modelling it at full length
 * and then framing the weapon so it fits means either the butt pad is a
 * hand's width from the lens — where it is the nearest, largest, flattest
 * object in the frame, exactly the "large untextured block on the right" the
 * review recorded — or the whole weapon has to be pushed so far forward that
 * the gun reads as a toy held at arm's length.
 *
 * Every shipped first-person weapon resolves this the same way: the stock is
 * foreshortened. `VM_STOCK` compresses everything behind the receiver toward
 * the receiver, so the shape still reads as a stocked rifle in the lower-right
 * of the frame, the butt pad and its detail still exist to catch the light,
 * and the mass that used to sit 300 mm from the eye is gone. The world-model
 * silhouette is unaffected because there is no world model — this geometry is
 * only ever seen from here.
 */
const VM_STOCK = 0.55;

function stockAssembly(kit, M, D, backZ) {
  kit.label = 'stock';
  const kind = M.stock;
  const tubeR = 0.0155;
  // `z(d)` places something `d` metres behind the receiver in real-gun terms
  // and returns where it belongs in the foreshortened viewmodel.
  const z = (d) => backZ + d * VM_STOCK;
  const len = (d) => d * VM_STOCK;
  const tubeLen = len(kind === 'folding' ? 0.055 : 0.155);

  kit.add(cyl(tubeR, tubeR, tubeLen, seg('small', D)), S_RECV, { pos: [0, -0.004, backZ] });
  if (D >= 1) {
    for (let i = 0; i < 6; i++) {              // length-of-pull notches
      kit.add(chamferBox(0.008, 0.0035, 0.0060, 0.0006), S_RECV,
        { pos: [0, -0.004 - tubeR + 0.0015, z(0.030 + i * 0.020)] });
    }
    // Castle nut and receiver end plate — the joint the eye looks for where a
    // buffer tube leaves a receiver, and the thing that stops the tube reading
    // as a length of pipe glued on.
    kit.add(cyl(0.0182, 0.0182, 0.0055, seg('small', D)), S_RECV, { pos: [0, -0.004, backZ + 0.0005] });
    kit.add(chamferBox(0.036, 0.040, 0.0030, 0.0008), S_RECV, { pos: [0, -0.004, backZ - 0.0010] });
    // Ambidextrous QD sling sockets through the end plate — the attachment
    // point a modern carbine actually uses, and two more highlights on the one
    // flat plate at the back of the frame.
    kit.mirrored((k) => k.add(cyl(0.0044, 0.0036, 0.0060, seg('small', D)), S_RECV,
      { pos: [0.0150, 0.0060, backZ - 0.0025], rot: [0, Math.PI / 2, 0] }));
    if (D >= 2) kit.addParts(knurl(12, 0.0176, 0.0050), S_RECV, { pos: [0, -0.004, backZ + 0.0005] });
  }

  if (kind === 'folding') {
    kit.mirrored((k) => k.add(chamferBox(0.005, 0.006, len(0.090), 0.0010), S_RECV,
      { pos: [0.016, -0.006, z(0.070)], rot: [0, 0.10, 0] }));
    kit.add(chamferBox(0.046, 0.030, 0.008, 0.0014), S_RUBBER, { pos: [0, -0.008, z(0.116)] });
    return { buttZ: z(0.120), cheekY: 0.010 };
  }

  if (kind === 'precision') {
    kit.add(chamferBox(0.034, 0.052, len(0.150), 0.0022), S_POLY, { pos: [0, -0.006, z(0.082)] });
    kit.add(chamferBox(0.040, 0.014, len(0.086), 0.0016), S_POLY, { pos: [0, 0.026, z(0.070)] });      // cheek riser
    kit.mirrored((k) => k.add(chamferBox(0.006, 0.014, len(0.030), 0.0008), S_RECV, { pos: [0.014, 0.014, z(0.070)] }));
    kit.add(chamferBox(0.020, 0.026, len(0.060), 0.0014), S_POLY, { pos: [0, -0.036, z(0.058)], rot: [0.12, 0, 0] }); // toe hook
    kit.add(chamferBox(0.046, 0.062, 0.012, 0.0018), S_RUBBER, { pos: [0, -0.004, z(0.160)] });
    kit.add(new THREE.TorusGeometry(0.0060, 0.0016, 8, 18), S_RECV, { pos: [0, -0.032, z(0.140)], rot: [0, Math.PI / 2, 0] });
    return { buttZ: z(0.166), cheekY: 0.033 };
  }

  // Carbine: slim body clamped on the tube, cheek weld on top, rubber pad.
  // Rounded section, not an octagon: at 45 mm across, held 300 mm from the eye,
  // an eight-sided stock reads as exactly what it is.
  kit.add(loft(roundRect(0.042, 0.048, 0.0075, D >= 2 ? 4 : D >= 1 ? 3 : 1), [
    { z: z(0.030), scale: 0.72, scaleY: 0.80 },
    { z: z(0.046), scale: 0.90, scaleY: 0.92 },
    { z: z(0.110), scale: 1.00, scaleY: 1.00 },
    { z: z(0.132), scale: 1.00, scaleY: 1.06 },
    { z: z(0.138), scale: 0.92, scaleY: 1.00 },
  ]), S_POLY, { pos: [0, -0.006, 0] });
  kit.add(chamferBox(0.044, 0.052, 0.014, 0.0016), S_RUBBER, { pos: [0, -0.008, z(0.145)] });
  kit.add(chamferBox(0.012, 0.020, len(0.030), 0.0010), S_POLY, { pos: [0, -0.036, z(0.060)], rot: [-0.25, 0, 0] });
  kit.mirrored((k) => k.add(chamferBox(0.004, 0.016, len(0.016), 0.0008), S_POLY, { pos: [0.022, -0.010, z(0.106)] }));

  if (D >= 1) {
    // The flat left flank of a carbine stock is the largest unbroken plane on
    // the weapon and it faces the camera at hip. Give it the two things a real
    // one has: the adjustment-lever slot down its underside and a sling loop
    // through the heel. Without them it photographs as a slab.
    kit.mirrored((k) => k.addParts(recessPanel(0.010, len(0.058), 0.0022, { lip: 0.0014 }), S_POLY, {
      m: new THREE.Matrix4().makeTranslation(0.0212, -0.006, z(0.092))
        .multiply(new THREE.Matrix4().makeRotationZ(-Math.PI / 2)),
    }));
    kit.add(chamferBox(0.020, 0.012, len(0.044), 0.0010), S_POLY, { pos: [0, -0.030, z(0.086)] });   // release lever
    kit.mirrored((k) => k.add(chamferBox(0.0035, 0.014, 0.010, 0.0008), S_POLY, { pos: [0.019, -0.018, z(0.128)] }));
    kit.add(new THREE.TorusGeometry(0.0055, 0.0018, 6, 14), S_RECV, { pos: [0, -0.028, z(0.126)], rot: [0, Math.PI / 2, 0] });
  }
  return { buttZ: z(0.152), cheekY: 0.020 };
}

/* ------------------------------------------------------------- magazine */

/** Magazine — its own mesh so it can drop free during a reload. */
function magazineMesh(M, mats, D) {
  const kit = new Kit();
  const m = M.mag;
  // A magazine hangs below the bore in every hip frame and it is the biggest
  // uninterrupted curve on the weapon, so it gets rings and corner segments
  // rather than the 12-point section that read as a folded slab.
  const N = D >= 2 ? 11 : D >= 1 ? 8 : 4;
  const curveAt = (t) => Math.sin(t * 1.25) * m.curve;

  const rings = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // Curved box: the spine sweeps rearward as it descends. That curve is the
    // most recognisable single element of a rifle's silhouette.
    rings.push({ z: t * m.len, dy: curveAt(t), scale: 1 - t * 0.03, scaleY: 1 - t * 0.02 });
  }
  const body = loft(roundRect(m.width, m.depth, 0.0055, D >= 2 ? 4 : D >= 1 ? 3 : 1), rings);
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
  if (D >= 1) {
    // Witness holes down the spine and the floorplate catch button. Both are
    // tiny and both are the kind of thing whose ABSENCE reads as "prop".
    for (let i = 0; i < 4; i++) {
      const t = 0.30 + i * 0.17;
      kit.add(cyl(0.0022, 0.0019, 0.0016, D >= 2 ? 10 : 6), 0,
        { pos: [0, -t * m.len, curveAt(t) + m.depth * 0.5 - 0.0004], rot: [0, 0, 0] });
    }
    kit.add(chamferBox(0.0075, 0.0045, 0.0035, 0.0008), 1,
      { pos: [0, -m.len - 0.0025, curveAt(1) - m.depth * 0.5 - 0.0012] });
  }

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
 * `eyeRelief` is not the manufacturer's figure and it is not a cheek weld. It
 * is the distance that sets the optic's APPARENT SIZE, and it is solved
 * backwards from a target: the housing's outside diameter should subtend about
 * a fifth of the frame height, which is where a shipped red dot sits and where
 * enough of the world stays visible around the tube to fight with it.
 *
 *   subtend = 2 * rHousing / relief,  frame height = 2 * tan(fov/2)
 *   relief  = rHousing / ( FRAME_FRAC * tan(fov/2) )
 *
 * The previous figures targeted a third of the frame height and, at 105 mm,
 * put a 38 mm bell across 37% of it — the single largest object in the ADS
 * frame, with the target hidden behind its own sight. Pushing the optic out
 * costs nothing (the ADS pose is derived from this number, so the whole weapon
 * simply sits further forward) and it is what the eye expects, because a
 * shooter's own optic is never that close to the cornea either.
 */

/**
 * THE SIGHT PICTURE — the clear half-angle, in radians, of the cone the player
 * has to be able to see the world through.
 *
 * WHY THIS CONSTANT EXISTS, AND WHAT IT REPLACED
 *
 * "Aiming down the sight does not work" survived three passes of alignment
 * fixes because it was never an alignment bug. Measured with
 * `src/weapons/aperture-probe.mjs` — 49 rays fanned out from the eye through
 * the aperture at full ADS, on the shipped geometry:
 *
 *   rifle  22/49 rays blocked   optic 40 hits, upper 2, handguard 16, barrel 1
 *   smg    12/49 rays blocked   optic 16 hits, handguard 3
 *   dmr    49/49 rays blocked   optic 226 hits, handguard 13
 *
 * Three separate defects, all of them geometry:
 *
 *  1. **The bores were cylinders.** The eye is a point, so the pencil of rays
 *     that reaches it through a tube widens downrange. A straight bore of
 *     radius r and length L with the eye d behind it clips the cone at the
 *     FRONT rim — half-angle r/(d+L), not r/d. `boredTube` now lays every bore
 *     ON the cone instead, which is exactly why a real objective bell is wider
 *     than its ocular.
 *  2. **The scope's rings and its ocular bell were solid `cyl()` plugs**
 *     centred on the optical axis — three capped cylinders straight across the
 *     bore. That is the entire 226-hit figure, and it is why the DMR could not
 *     be aimed at all.
 *  3. **The mounts were far too short.** A 21 mm axis-over-rail on a 30 mm tube
 *     leaves 2 mm of mount, which is not a mount; more to the point it puts the
 *     rifle's own handguard rail, gas block and muzzle device inside the sight
 *     cone. Mount height is now SOLVED against the gun's own skyline rather
 *     than picked, which is why `handguard()` and `barrelAssembly()` report
 *     where their tallest points are.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS 0.084 AND NOT 0.060, AND WHAT THAT COST
 *
 * At 0.060 the bore was clear and the sight was still not usable, because a
 * clear bore is only half the question — the other half is HOW BIG the hole is,
 * and 0.060 made it far too small to identify a target in. The screen-space
 * probe (`tools/sightline-probe.mjs`, output in `shots/sightline/sightline.json`)
 * measured the rendered rim at 61.7 px radius on all three weapons: a sight
 * picture 13.7% of the frame height, about a sixth of the frame, at 1600x900.
 *
 * That figure is not a coincidence of three different optics landing on the
 * same number, and it is not governed by eye relief or by the optic's internal
 * diameter. Every clear radius on this weapon is derived from the cone, so
 * `rClear = SIGHT_CLEAR * d` at every plane, and the projected radius of any of
 * them is
 *
 *     discDiameterPct = 100 * SIGHT_CLEAR / tan(fovAds / 2)
 *
 * — the distance cancels. Eye relief cancels. The bell diameter cancels. THE
 * SIGHT PICTURE IS THIS CONSTANT AND THE ADS FIELD OF VIEW, AND NOTHING ELSE.
 * (Checked against the probe: 100 * 0.060 / tan(23.65 deg) = 13.71, and the
 * probe reported 13.7 on rifle, SMG and DMR alike.) The ADS FOV is
 * `Config.camera.viewmodelFov * 0.86` and lives in CameraRig, so on this side
 * of the fence SIGHT_CLEAR is the only lever there is.
 *
 * 0.084 puts the picture at 19.2% of frame height — a shipped-console-optic
 * sight picture rather than a peephole — and it is paid for in two places:
 *
 *  1. THE OPTIC IS BIGGER ON SCREEN. It has to be. The housing subtends
 *     `OPTIC_FRAME_FRAC`; the picture inside it subtends this constant over
 *     tan(fovAds/2). Their ratio is fixed, so a 19.2% picture inside a 19%
 *     housing is a tube with zero wall thickness — algebraically impossible,
 *     which is why the frame fractions below had to go up with it. The red dot
 *     now reads 23.5% of frame height instead of 19%, with the ring around the
 *     picture 2.2% of frame height (~19 px at 900p) per side.
 *  2. THE RISER IS TALLER. The cone DROPS at this angle as it runs downrange,
 *     so the axis has to clear the gun's own handguard rail, gas block and
 *     muzzle device by 40% more at every z. Measured, HIGH tier, rail deck to
 *     optical axis:
 *
 *                    riser         over bore    eye relief
 *       rifle  35.7 -> 44.0 mm  65 -> 73 mm   238 -> 184 mm
 *       smg    34.8 -> 42.7 mm  62 -> 70 mm   210 -> 188 mm
 *       dmr    38.0 -> 53.0 mm  70 -> 86 mm   182 -> 191 mm
 *
 *     1.73" of riser on the carbine sits between the two heights a real one
 *     actually ships with (1.54" and 1.93"), so it reads as a deliberate mount
 *     rather than a stilt. The DMR's 2.09" is the expensive one — its 255 mm
 *     handguard carries a full-length rail a long way downrange, where the cone
 *     has dropped furthest — and a high scope mount on a marksman rifle is
 *     still a thing that exists. The riser is drawn, not implied: `solveOpticAxis`
 *     feeds the column and clamp foot, so a taller answer builds a taller part.
 *
 * Do not "fix" this back down without re-reading the identity above: lowering
 * it shrinks the sight picture proportionally and nothing else changes.
 */
export const SIGHT_CLEAR = 0.084;

/**
 * Fraction of the frame HEIGHT the optic housing may subtend when aimed. A
 * scope is allowed more because the player is meant to be looking *through* it;
 * a red dot is meant to be looked *past*.
 *
 * THESE ARE A TARGET, NOT A GUARANTEE, and the reason matters. The clear picture
 * inside the housing subtends `SIGHT_CLEAR / tan(fovAds/2)` of the frame height —
 * 19.2% at the default 55-degree viewmodel FOV — so a fraction at or below that
 * describes a housing thinner than its own aperture, which is not a look, it is
 * an impossibility. `Config.camera.viewmodelFov` is a PLAYER SETTING with a
 * 35-90 degree range (`InputMap`), and at the narrow end everything subtends
 * more of the frame: at 35 degrees the picture alone is 31% of frame height and
 * no fraction below that can be honoured. `eyeReliefForWall` therefore treats
 * these as a floor on the housing and lets it grow when the FOV demands it — see
 * `WALL_RATIO_MIN` there. It must not throw: this runs inside `buildWeapon`
 * during `WeaponModule.init`, and a throw there is a black screen.
 */
const OPTIC_FRAME_FRAC = { reddot: 0.235, reflex: 0.26, scope: 0.30 };

/**
 * Housing wall between the clear aperture and the outside of the optic, at the
 * plane nearest the eye — the ocular rim of a tube, the rear frame of a reflex.
 *
 * THIS IS THE AUTHORED NUMBER AND THE RADIUS IS DERIVED FROM IT, not the other
 * way round, for the same reason the bell's outside is derived from its bore:
 * with the aperture solved from the sight cone, authoring the outside diameter
 * means the wall thickness is whatever is left over, and at a wide enough cone
 * what is left over is negative. A 30 mm red-dot body really is about 3.4 mm of
 * aluminium at the ocular; a scope ocular bell is much thicker; a reflex's rear
 * frame is a 4.2 mm rail plus clearance.
 */
const OPTIC_WALL = { reddot: 0.0034, reflex: 0.0056, scope: 0.0077 };

/**
 * Solve eye relief from the housing WALL thickness rather than from its outside
 * radius, so the solve cannot be circular.
 *
 * Measured against the ADS field of view, not the hip one: CameraRig narrows
 * the viewmodel FOV by `ADS_FOV_SCALE` while aiming, and that is the frame the
 * optic is actually judged in. Getting this wrong by that factor is a 16% error
 * in the only number the complaint was about.
 *
 * The algebra. Let `F = FRAME_FRAC * tan(fovAds/2)` and `k = SIGHT_CLEAR`. The
 * housing's outer radius at the eye-side plane must satisfy `rOuter / E = F`
 * (that is what the frame fraction means) and its aperture `rClear / E = k`
 * (that is what the cone means), so
 *
 *     wall / E = F - k     ->     E = wall / (F - k)
 *
 * and the outer radius falls out as `k * E + wall`. Authoring `rOuter` instead
 * and solving `E = rOuter / F` — which is what this used to do — quietly
 * disagrees with the cone by `k * E`, and once `k` grew that disagreement was
 * larger than the wall: the red dot's bore came out WIDER than its own housing.
 *
 * `setback` is the distance from the rear GLASS plane (where eye relief is
 * measured, because that is where `sightGroup` sits and therefore what the ADS
 * pose is derived from) forward to the eye-side RIM of the housing, which is
 * the ring that actually subtends the frame fraction. On a scope that is 28 mm
 * of ocular bell and ignoring it made the tube 17% larger on screen than the
 * fraction claimed.
 *
 * `F - k` is a difference of two numbers that are close together and one of them
 * is under the player's control, so it can go to zero or negative — see the note
 * on OPTIC_FRAME_FRAC. `WALL_RATIO_MIN` floors it. It is expressed as a fraction
 * of `SIGHT_CLEAR` rather than as an absolute so it means the same thing at every
 * FOV: "the housing wall is at least this fraction of the aperture radius". 0.18
 * is a little under what the authored fractions give at the default 55-degree FOV
 * (0.22), so at 55 degrees this floor is inactive and the fractions above are
 * exactly honoured; below about 47 degrees it takes over and the optic simply
 * gets bigger on screen, which is what a narrower FOV means.
 */
const ADS_FOV_SCALE = 0.86;
const WALL_RATIO_MIN = 0.18;
/**
 * Shortest eye relief the solve may return, at the wide end of the FOV slider.
 *
 * At 90 degrees the frame fraction alone asks for 37 mm, which would put the
 * rear glass 37 mm from the camera and shrink the whole optic to a 12 mm tube.
 * The geometry stays self-consistent there (the housing is derived from the cone
 * at whatever relief it gets) but 50 mm is about the shortest a real cheek weld
 * ever is, so this floors it and lets the optic subtend more than its fraction
 * instead. Inactive at any FOV at or below about 70 degrees.
 */
const EYE_RELIEF_MIN = 0.075;
function adsTanY() {
  return Math.tan(THREE.MathUtils.degToRad(Config.camera.viewmodelFov * ADS_FOV_SCALE) * 0.5);
}
function eyeReliefForWall(kind, setback = 0) {
  const F = (OPTIC_FRAME_FRAC[kind] ?? OPTIC_FRAME_FRAC.reddot) * adsTanY();
  const wall = OPTIC_WALL[kind] ?? OPTIC_WALL.reddot;
  const room = Math.max(F - SIGHT_CLEAR, SIGHT_CLEAR * WALL_RATIO_MIN);
  return Math.max(wall / room, EYE_RELIEF_MIN) + setback;
}

/** Bore radius carried over the cone, so a facet chord never eats into it. */
const BORE_SLACK = 0.0007;

/** Vertical gap the cone keeps over the gun's own skyline. */
const CONE_CLEAR = 0.0020;

/** Shortest riser that still reads as a mount: rail deck to housing underside. */
const MOUNT_MIN = 0.0055;

/**
 * Where the optical axis has to sit for the sight to be a sight.
 *
 * `drop` is the housing's underside relative to the axis, so the first term is
 * simply "the optic clears the rail with a mount under it". The rest is the
 * real constraint: for every obstacle at `(y, z)` on the weapon's own skyline,
 * the bottom of the sight cone at that z must pass over it. That is linear in
 * axis height, so the answer is one max — no iteration, and it re-solves itself
 * for free when a handguard or a muzzle device changes.
 */
function solveOpticAxis(railY, zEye, drop, skyline) {
  let y = railY + MOUNT_MIN + drop;
  for (const o of skyline) y = Math.max(y, o.y + CONE_CLEAR + SIGHT_CLEAR * (zEye - o.z));
  return y;
}

function opticAssembly(kit, M, D, kind, railY, zc, skyline = []) {
  kit.label = 'optic';
  // The optic bell is the largest single shape in the ADS frame and it is the
  // one the player stares through, so it carries the highest segment count on
  // the weapon: 64 puts the facet under 6 degrees, well below where a rim viewed
  // almost down its own axis starts reading as a polygon.
  const seg = SEG.optic[D];
  const sgS = SEG.small[D];
  const sgT = SEG.tiny[D];

  if (kind === 'scope') {
    const zR = zc + 0.075, zF = zc - 0.115;
    const rearZ = zR - 0.028, frontZ = zF + 0.006;
    const eyeRelief = eyeReliefForWall('scope', zR - rearZ);
    const zEye = rearZ + eyeRelief;
    const cone = (z) => SIGHT_CLEAR * (zEye - z);
    /* The bore is the cone everywhere EXCEPT inside the ocular, where it opens
     * back out toward the eye. Nothing downstream of the last element can widen
     * the field, so the flare buys no extra sight picture — what it buys is the
     * look. A cylindrical bore behind a wide ocular presents a ring of wall
     * seen almost exactly end-on, which shades to black and reads as a plugged
     * scope; a bell catches the same light at 25 degrees and reads as the
     * inside of an eyepiece, which is what it is.
     *
     * The flare is stated as a clearance INSIDE the ocular rim rather than as
     * an absolute radius. Authored absolutely (it was 19.3 mm) it silently
     * became a stop the moment the cone grew past it, i.e. a black ring inside
     * the eyepiece — the exact defect the cone was introduced to remove. */
    const rOc = cone(zR) + OPTIC_WALL.scope;
    // The flare peaks 3.8 mm inside the rim — half the 7.7 mm ocular wall, less
    // the 0.7 mm of BORE_SLACK the tube carries, so the rim keeps ~3 mm of metal.
    const bore = (z) => Math.max(cone(z), rOc - 0.0038 - (zR - z) * 0.45);

    // Stations along the tube. The ocular's outside radius is the one the ADS
    // frame is sized against — it is the nearest and therefore largest-
    // subtending ring on the optic, so it sets the silhouette and everything
    // below is derived from the cone.
    const zOc1 = zR - 0.026, zT0 = zR - 0.036;
    const zS0 = zc + 0.006, zS1 = zc - 0.026, zT1 = zS1 - 0.006;
    const zB0 = zF + 0.050, zB1 = zF + 0.026;
    const rTubeR = cone(zS0) + 0.0024;
    const rSad = cone(zS1) + 0.0058;
    const rTubeF = cone(zB0) + 0.0024;
    const rBell = cone(zF) + 0.0032;

    const ringR = rTubeF + 0.0063;
    const axisY = solveOpticAxis(railY, zEye, ringR, skyline);

    kit.add(boredTube([
      [rOc, zR], [rOc, zOc1], [rTubeR, zT0], [rTubeR, zS0],
      [rSad, zS0 - 0.004], [rSad, zS1 + 0.004], [rTubeF, zT1],
      [rTubeF, zB0], [rBell, zB1], [rBell, zF],
    ], bore, seg, BORE_SLACK), S_RAIL, { pos: [0, axisY, 0] });

    /* Mount rings. These used to be `cyl()` — solid, capped cylinders of
     * radius 20.5 mm sitting on the optical axis, i.e. three discs straight
     * across the bore. They are annular now, which is what a scope ring is. */
    for (const [z0, z1, rIn] of [[zS0, zS0 + 0.014, rTubeR], [zT1 - 0.023, zT1 - 0.009, rTubeF]]) {
      const inner = rIn + 0.0003;
      kit.add(tube(inner + 0.0060, inner, z0, z1, sgS), S_RAIL, { pos: [0, axisY, 0] });
      // Ring cap with its four screws, and the cantilever foot down to the rail.
      kit.add(chamferBox(0.020, 0.0060, (z1 - z0) * 0.86, 0.0010), S_RAIL,
        { pos: [0, axisY + inner + 0.0038, (z0 + z1) * 0.5] });
      if (D >= 1) {
        kit.mirrored((k) => {
          k.add(cyl(0.0018, 0.0016, 0.0030, sgT), S_RAIL, { pos: [0.0072, axisY + inner + 0.0060, (z0 + z1) * 0.5 - 0.0034], rot: [-Math.PI / 2, 0, 0] });
          k.add(cyl(0.0018, 0.0016, 0.0030, sgT), S_RAIL, { pos: [0.0072, axisY + inner + 0.0060, (z0 + z1) * 0.5 + 0.0034], rot: [-Math.PI / 2, 0, 0] });
        });
      }
      const footTop = axisY - inner - 0.0030;
      const footH = Math.max(0.004, footTop - railY);
      kit.add(chamferBox(0.021, footH, (z1 - z0) + 0.006, 0.0014), S_RAIL,
        { pos: [0, railY + footH * 0.5, (z0 + z1) * 0.5] });
      kit.add(chamferBox(0.033, 0.0090, (z1 - z0) + 0.010, 0.0012), S_RAIL,
        { pos: [0, railY + 0.0045, (z0 + z1) * 0.5] });
      if (D >= 1) {
        kit.add(chamferBox(0.0090, footH * 0.66, 0.0110, 0.0010), S_RAIL,
          { pos: [0.0135, railY + footH * 0.5, (z0 + z1) * 0.5] });     // QD throw lever
      }
    }

    // Turret saddle: elevation on top, windage right, parallax left, each a
    // knurled cap on a shoulder rather than a bare peg.
    kit.add(cyl(0.0128, 0.0112, 0.017, sgS), S_RAIL, { pos: [0, axisY + rSad - 0.001, zc - 0.010], rot: [-Math.PI / 2, 0, 0] });
    kit.add(cyl(0.0112, 0.0100, 0.015, sgS), S_RAIL, { pos: [rSad - 0.001, axisY, zc - 0.010], rot: [0, Math.PI / 2, 0] });
    kit.add(cyl(0.0108, 0.0096, 0.013, sgS), S_RAIL, { pos: [-rSad + 0.001, axisY, zc - 0.010], rot: [0, -Math.PI / 2, 0] });
    if (D >= 1) {
      kit.addParts(knurl(D >= 2 ? 20 : 12, 0.0114, 0.014), S_RAIL, { pos: [0, axisY + rSad + 0.002, zc - 0.010], rot: [-Math.PI / 2, 0, 0] });
      kit.addParts(knurl(D >= 2 ? 18 : 10, 0.0100, 0.012), S_RAIL, { pos: [rSad + 0.008, axisY, zc - 0.010], rot: [0, Math.PI / 2, 0] });
    }

    // Magnification collar with a throw lever, and the dioptre ring behind it.
    kit.add(tube(rTubeR + 0.0044, rTubeR + 0.0002, zR - 0.056, zR - 0.040, sgS), S_RAIL, { pos: [0, axisY, 0] });
    kit.add(tube(rOc + 0.0022, rOc - 0.0004, zR - 0.007, zR - 0.001, sgS), S_RAIL, { pos: [0, axisY, 0] });
    if (D >= 1) {
      kit.addParts(knurl(D >= 2 ? 26 : 14, rTubeR + 0.0046, 0.014), S_RAIL, { pos: [0, axisY, zR - 0.048] });
      kit.add(chamferBox(0.0075, 0.020, 0.0090, 0.0010), S_RAIL,
        { pos: [0, axisY + rTubeR + 0.0130, zR - 0.048], rot: [0, 0, 0.30] });   // throw lever
    }
    return {
      axisY, rearZ, frontZ,
      glassR: SIGHT_CLEAR * eyeRelief,
      frontGlassR: SIGHT_CLEAR * (zEye - frontZ),
      housingR: rOc, eyeRelief,
    };
  }

  if (kind === 'reflex') {
    /* A CLOSED-EMITTER REFLEX — glass at BOTH ends, which is the fix for the
     * measurement trap the sight-line probe fell into on this weapon.
     *
     * It used to be an open emitter: a shroud with one canted reflector at the
     * rear and nothing at the front. `tools/sightline-probe.mjs` reported
     * `rimPlane: "sight group origin (no lensFront mesh found)"` for it and fell
     * back to measuring the sight picture at the REAR glass, on a plane 42 mm
     * behind the one that actually clips the view. Every other weapon was
     * measured at its front element. Two of the three optics being measurable
     * and one not is how three rounds of wrong conclusions happened, and the
     * cure is not a special case in the probe — it is for every optic on the
     * gun to have the same two planes.
     *
     * A closed emitter (Aimpoint ACRO, Steiner MPS, Holosun 509T) is the real
     * part that has them: the same reflector, sealed behind a front window, in a
     * box rather than an open frame. So the shroud gets a floor and a front
     * element, and `frontGlassR` is published like the tube optics'. */
    const rearZ = zc + 0.020, frontZ = zc - 0.022;
    // The rear frame IS the eye-side rim on a reflex — no ocular bell to set
    // back through, unlike the tube optics.
    const eyeRelief = eyeReliefForWall('reflex', 0);
    const zEye = rearZ + eyeRelief;
    const bore = (z) => SIGHT_CLEAR * (zEye - z);

    // The window is the rectangle framed by the shroud. Size it on the cone at
    // the FRONT of the shroud, which is where the cone is widest and where the
    // old arms were 4 mm too close in.
    const zS0 = zc + 0.020, zS1 = zc - 0.026;
    const w = bore(zS1) + 0.0014;
    // Underside of the sealed body: floor plate, then the emitter block under it.
    const FLOOR = 0.0052, EMIT = 0.0110;
    const drop = w + FLOOR + EMIT;
    const axisY = solveOpticAxis(railY, zEye, drop, skyline);
    const zSc = (zS0 + zS1) * 0.5, zSl = zS0 - zS1;

    kit.mirrored((k) => {
      // 2.1x rather than 1.9x: the front window is a circle of the cone's
      // radius at that plane, and at 1.9 the glass overhung the side walls.
      k.add(chamferBox(0.0042, w * 2.1, zSl, 0.0010), S_RAIL, { pos: [w + 0.0021, axisY, zSc] });
      if (D >= 1) k.add(cyl(0.0020, 0.0017, 0.0026, sgT), S_RAIL, { pos: [w + 0.0042, axisY - w * 0.55, zSc + 0.012], rot: [0, Math.PI / 2, 0] });
    });
    kit.add(chamferBox(w * 2 + 0.0104, 0.0052, zSl, 0.0010), S_RAIL, { pos: [0, axisY + w + 0.0026, zSc] });
    // Floor plate: what makes this a sealed body rather than an open frame, and
    // what the front window needs to seat against.
    kit.add(chamferBox(w * 2 + 0.0104, FLOOR, zSl, 0.0010), S_RAIL, { pos: [0, axisY - w - FLOOR * 0.5, zSc] });
    kit.add(chamferBox(w * 2 + 0.0070, EMIT, 0.021, 0.0012), S_RAIL, { pos: [0, axisY - w - FLOOR - EMIT * 0.5, zc + 0.008] });   // emitter block
    kit.add(chamferBox(w * 2 + 0.0040, 0.0070, 0.012, 0.0010), S_RAIL, { pos: [0, axisY - w - FLOOR - 0.0035, zc - 0.026] });    // front hood lip
    if (D >= 1) {
      kit.add(cyl(0.0058, 0.0050, 0.0075, sgT), S_RAIL, { pos: [w + 0.0030, axisY - w - FLOOR - EMIT * 0.5, zc + 0.014], rot: [0, Math.PI / 2, 0] });  // battery cap
      kit.mirrored((k) => k.add(chamferBox(0.0028, 0.0060, 0.0028, 0.0006), S_RAIL, { pos: [0.0075, axisY - w - FLOOR - EMIT, zc + 0.012] }));          // adjust buttons
    }

    // Riser: a clamp foot on the rail and a column up to the emitter housing.
    const bodyBot = axisY - w - FLOOR - EMIT;
    const riseH = Math.max(0.004, bodyBot - railY);
    kit.add(chamferBox(0.019, riseH, 0.030, 0.0014), S_RAIL, { pos: [0, railY + riseH * 0.5, zc + 0.004] });
    kit.add(chamferBox(0.031, 0.0085, 0.034, 0.0012), S_RAIL, { pos: [0, railY + 0.0042, zc + 0.004] });
    if (D >= 1) kit.add(chamferBox(0.0085, riseH * 0.62, 0.0105, 0.0010), S_RAIL, { pos: [0.0128, railY + riseH * 0.5, zc + 0.010] });

    return {
      axisY, rearZ, frontZ,
      glassR: SIGHT_CLEAR * eyeRelief,
      frontGlassR: SIGHT_CLEAR * (zEye - frontZ),
      housingR: w + 0.0042, eyeRelief,
      // `flat` no longer means "one element" — it means "no tube", i.e. the rear
      // element is a canted reflector in a box rather than a lens in a bore.
      // The front window exists either way; see `frontGlassR` above.
      flat: true,
    };
  }

  // ----------------------------------------------------------- 30 mm red dot
  const zR = zc + 0.038, zF = zc - 0.040, zH = zF - 0.014;
  const rearZ = zR - 0.004, frontZ = zF + 0.004;
  const eyeRelief = eyeReliefForWall('reddot', zR - rearZ);
  const zEye = rearZ + eyeRelief;
  const cone = (z) => SIGHT_CLEAR * (zEye - z);
  // Ocular rim: derived from the cone plus its wall, never authored — see
  // `eyeReliefForWall`. The flare behind it is likewise stated as a clearance
  // inside the rim rather than as an absolute radius, so it can never become a
  // stop when the cone grows.
  const rOc = cone(zR) + OPTIC_WALL.reddot;
  // Flare peaks 2.2 mm inside the rim, against a 3.4 mm wall and 0.7 mm of
  // BORE_SLACK: about 1.5 mm of metal at the very rim, which is what a 30 mm
  // red-dot body actually is there.
  const bore = (z) => Math.max(cone(z), rOc - 0.0022 - (zR - z) * 0.35);

  /* Tube, turret saddle and sun hood as ONE closed surface of revolution.
   *
   * Two rules hold this shape together. The first is the old one and it still
   * applies: a single profile cannot z-fight itself, and every version that
   * butted a separate hood onto the front either made two annular caps coplanar
   * or ran two walls a fraction of a millimetre apart — which, on the largest
   * curved thing in the ADS frame viewed almost down its own axis, showed up as
   * a stippled, eaten-away bell rim.
   *
   * The second is: the OUTSIDE is derived from the inside, not the other way
   * round. Each station's wall thickness is added to the clear cone at that z,
   * so the housing widens toward the objective exactly as fast as the sight
   * picture does. That now includes the ocular rim, which used to be the one
   * exception at an authored 19 mm — and which, once the cone widened, was
   * NARROWER than its own bore. `eyeReliefForWall` inverts the relation so the
   * rim is `cone + wall` and the eye relief is what makes that rim land on its
   * frame fraction; see the algebra there. */
  const rBody0 = cone(zc + 0.014) + 0.0024;
  const rSad = cone(zc) + 0.0034;
  const rBody1 = cone(zc - 0.016) + 0.0024;
  const rObj = cone(zF) + 0.0030;
  const rHood = cone(zH) + 0.0030;
  const axisY = solveOpticAxis(railY, zEye, rSad, skyline);

  kit.add(boredTube([
    [rOc, zR], [rOc, zR - 0.006], [rBody0, zR - 0.011],
    [rBody0, zc + 0.014], [rSad, zc + 0.010], [rSad, zc - 0.012],
    [rBody1, zc - 0.016], [rBody1, zF + 0.016], [rObj, zF + 0.008],
    [rHood, zF], [rHood, zH],
  ], bore, seg, BORE_SLACK), S_RAIL, { pos: [0, axisY, 0] });

  // Riser mount. The tube now sits high enough that the mount is a real part
  // rather than a 2 mm shim — a column, a clamp foot on the rail, a cross bolt
  // and a QD throw lever, all of which the old flush mount had no room for.
  const mountTop = axisY - rSad + 0.0014;
  const mountH = Math.max(0.004, mountTop - railY);
  kit.add(chamferBox(0.0205, mountH, 0.046, 0.0016), S_RAIL, { pos: [0, railY + mountH * 0.5, zc] });
  kit.add(chamferBox(0.032, 0.0090, 0.036, 0.0012), S_RAIL, { pos: [0, railY + 0.0045, zc] });
  if (D >= 1) {
    kit.add(chamferBox(0.0090, mountH * 0.66, 0.0115, 0.0010), S_RAIL, { pos: [0.0135, railY + mountH * 0.52, zc + 0.013] });
    kit.add(cyl(0.0052, 0.0052, 0.0115, sgT), S_RAIL, { pos: [0.0100, railY + 0.0060, zc - 0.012], rot: [0, Math.PI / 2, 0] });
    kit.mirrored((k) => k.add(panelLine(0.040, { width: 0.0012, depth: 0.0010 }), S_RAIL, { pos: [0.0104, railY + mountH * 0.70, zc] }));
  }

  // Turret caps and the battery compartment, each standing on the saddle rather
  // than sunk into it — the old ones were placed at a fixed 15 mm and ended up
  // inside the tube once the tube grew.
  kit.add(cyl(0.0086, 0.0072, 0.0125, sgS), S_RAIL, { pos: [0, axisY + rSad - 0.0012, zc + 0.002], rot: [-Math.PI / 2, 0, 0] });
  kit.add(cyl(0.0078, 0.0066, 0.0110, sgS), S_RAIL, { pos: [rSad - 0.0012, axisY, zc + 0.002], rot: [0, Math.PI / 2, 0] });
  kit.add(cyl(0.0092, 0.0080, 0.0095, sgS), S_RAIL, { pos: [-rSad + 0.0012, axisY - 0.0010, zc + 0.002], rot: [0, -Math.PI / 2, 0] });
  if (D >= 1) {
    kit.addParts(knurl(D >= 2 ? 18 : 12, 0.0074, 0.0105), S_RAIL, { pos: [0, axisY + rSad + 0.0040, zc + 0.002], rot: [-Math.PI / 2, 0, 0] });
    kit.addParts(knurl(D >= 2 ? 16 : 10, 0.0082, 0.0080), S_RAIL, { pos: [-rSad - 0.0055, axisY - 0.0010, zc + 0.002], rot: [0, -Math.PI / 2, 0] });
    /* Brightness rocker on the left of the saddle. Placed against the cone at
     * its OWN FORWARD END, not against `rSad`.
     *
     * `rSad` is the saddle radius at `zc`, and this part runs 8 mm forward of
     * there, where the cone is wider — so a face set at `rSad - 0.0006` was
     * 1.1 mm inside the bore at its front corner. The fan probe caught it as a
     * single blocked ray at 9 o'clock on the outermost ring, hitting the optic
     * at 0.234 m, and it is the same failure the turret caps carried before
     * they were moved onto the saddle: a part positioned from a radius measured
     * at a different z. Anything mounted on this tube has to be placed against
     * `cone()` sampled where the part actually is. */
    const zRk = zc - 0.020, lRk = 0.0165;
    kit.add(chamferBox(0.0030, 0.0140, lRk, 0.0006), S_RAIL,
      { pos: [-(cone(zRk - lRk * 0.5) + 0.0030), axisY + 0.0060, zRk] });
  }
  return {
    axisY, rearZ, frontZ,
    glassR: SIGHT_CLEAR * eyeRelief,
    frontGlassR: SIGHT_CLEAR * (zEye - frontZ),
    housingR: rOc, eyeRelief,
  };
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
  // An optic on the rail owns the sight line, so the irons fold flat.
  const bar = barrelAssembly(kit, M, D, hg, !!def.optic);
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
  // Everything downrange that could stand up into the sight cone. The optic
  // solves its own mount height against this instead of taking a constant —
  // see `solveOpticAxis`. `hg.railTopY` is the dominant term on every weapon:
  // a handguard rail is only a few millimetres below the receiver's, and it
  // runs a quarter of a metre closer to the muzzle, where the cone has dropped.
  const skyline = [
    { y: hg.railTopY, z: hg.railFrontZ },
    { y: hg.railTopY, z: hg.z1 },
    ...bar.skyline,
  ];
  const optic = opticAssembly(kit, M, D, def.optic, railY, 0.018, skyline);

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

  // A curved trigger bow. The flat plate this replaces sat in the one place on
  // the weapon the eye is trained to look at and had no shape at all.
  const trigKit = new Kit();
  {
    // Origin is the trigger pin, because that is what the Animator rotates
    // about; the blade hangs below it and bows forward toward the finger.
    const steps = D >= 1 ? 7 : 3;
    const bow = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      bow.push({ z: 0.0035 + t * 0.019, dy: -Math.sin(t * 1.9) * 0.0034, scale: 1 - t * 0.14 });
    }
    const blade = loft(octagon(0.0062, 0.0044, 0.0009), bow);
    blade.rotateX(Math.PI / 2);          // sweep +Z downward, bow toward -Z
    trigKit.add(blade, 0);
    trigKit.add(chamferBox(0.0060, 0.0080, 0.0062, 0.0010), 0, { pos: [0, -0.0010, 0] });   // shoe
    if (D >= 1) {
      for (let i = 0; i < 4; i++) {      // serrations on the face
        trigKit.add(chamferBox(0.0058, 0.0013, 0.0013, 0.0003), 0,
          { pos: [0, -0.0130 - i * 0.0032, -0.0030 - i * 0.0004] });
      }
    }
  }
  const trig = new THREE.Mesh(trigKit.build(), mats[S_RECV]);
  trig.name = 'trigger';
  trig.position.set(0, low.topY - 0.014, low.zc + 0.050);
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
  sightGroup.name = 'sight';
  sightGroup.position.set(0, optic.axisY, optic.rearZ);
  root.add(sightGroup);

  // The lens edge is the same circle as the bell it sits in; if the disc is
  // coarser than the housing the glass reads as a polygon inside a tube.
  //
  // The two discs are NOT the same size any more, and that is the point. The
  // bore is a cone now, so the objective is a bigger circle than the ocular —
  // a shared radius meant either an objective that stopped the sight cone down
  // (a black ring inside the bell) or an ocular disc overhanging its own rim.
  const glassGeo = new THREE.CircleGeometry(optic.glassR, seg('optic', D) + 4);
  const rearGlass = new THREE.Mesh(glassGeo, mats[S_GLASS]);
  // Named, because "is anything but glass in the aperture?" is a question the
  // sight-line probe answers by NAME (tools/sightline-probe.mjs). An unnamed
  // mesh on the optical axis makes the answer a guess from its distance.
  rearGlass.name = 'lensRear';
  rearGlass.rotation.x = optic.flat ? -0.16 : 0;    // reflex lenses are canted
  rearGlass.renderOrder = 4;
  rearGlass.frustumCulled = false;
  sightGroup.add(rearGlass);

  /* EVERY OPTIC GETS A FRONT ELEMENT. It used to be gated on `!optic.flat`, so
   * the SMG's reflex had glass at one end only — and the screen-space probe,
   * which finds the rim of the sight picture by looking for a mesh called
   * `lensFront`, silently fell back to the sight group origin and measured that
   * weapon's picture on a plane 42 mm behind the one that clips it. An optic
   * that cannot be measured the same way as its neighbours is a trap, not a
   * design choice; the reflex is a closed emitter now and has the window. */
  const frontGeo = new THREE.CircleGeometry(optic.frontGlassR ?? optic.glassR, seg('optic', D) + 4);
  const frontGlass = new THREE.Mesh(frontGeo, mats[S_GLASS]);
  frontGlass.name = 'lensFront';
  frontGlass.position.z = optic.frontZ - optic.rearZ;
  frontGlass.renderOrder = 3;
  frontGlass.frustumCulled = false;
  sightGroup.add(frontGlass);

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

  // Everything that will actually be drawn: the merged body plus the magazine.
  // The magazine is `soft` — it hangs 17 cm below the bore and a shipped
  // viewmodel lets it run off the bottom edge, where the trigger guard and grip
  // must not. See the target table in `solveHipPose`.
  const hipPose = solveHipPose([
    { array: bodyGeo.attributes.position.array, offset: null },
    { array: mag.geometry.attributes.position.array, offset: mag.position, soft: true },
  ], muzzle.position, sightGroup.position, { rx: 0, ry: 0.26, rz: 0.045 });

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
      /**
       * Clear radius at the FRONT element, and the plane it belongs to.
       *
       * `glassR` is the cone's radius at the REAR glass, next to the eye.
       * `frontGlassR` is its radius at the front element, further down the same
       * widening cone. THEY ARE DIFFERENT PLANES AND DIFFERENT NUMBERS, and the
       * rim of the sight picture — what the player actually looks through — is
       * the front one.
       *
       * This was computed by `opticAssembly` and then not exported, so every
       * consumer that reached for `sight.frontGlassR` got `undefined`, fell back
       * to the rear radius, and measured the front plane with a disc 23-46%
       * too small. That is the bug that reported a clear aperture with a sixth
       * of the bore dead, and it cost three rounds of wrong conclusions. If a
       * radius is published here it names its plane; do not add one that does not.
       */
      frontGlassR: optic.frontGlassR ?? null,
      frontZ: optic.frontZ, rearZ: optic.rearZ,
      /**
       * The clear half-angle of the sight cone, in radians — `SIGHT_CLEAR`.
       *
       * Published so anything that has to stay OUT of the sight line can solve
       * against the same number the optic was placed with, instead of guessing
       * from a lens radius. The cone's bottom edge at any weapon-space z is
       *
       *     y = sight.group.position.y - clearAngle * (zEye - z)
       *     zEye = sight.rearZ + sight.eyeRelief
       *
       * and its half-width at that z is `clearAngle * (zEye - z)`. THE SUPPORT
       * HAND IS THE CURRENT CONSUMER: the screen-space probe measures 25% of the
       * rifle's sight picture as 'leftHand/fingers' at 5-8 o'clock, with hit
       * distances of 0.45-0.51 m against a front lens at 0.31 m, i.e. fingers
       * standing up through the line of sight forward of the optic.
       */
      clearAngle: SIGHT_CLEAR,
      /**
       * Housing radius, and the reference the EYEBOX is measured in — see
       * `collimate`. It has to be separate from `glassR` now that the clear
       * aperture is solved from the sight cone rather than authored: the
       * scope's lens went from 13.2 mm to 10.9 mm when its bore became a real
       * cone, and an eyebox pegged to the lens would have silently tightened by
       * the same 17% and put the reticle back inside the window where the last
       * pass proved it was being switched off mid-transition.
       */
      eyeboxR: optic.housingR,
      scoped: def.optic === 'scope',
      // Angular radius of the reticle quad, in radians (see RETICLE_ANGLE).
      reticleAngle: RETICLE_ANGLE[def.optic] ?? RETICLE_ANGLE.reddot,
    },
    anchors, hipPose, adsPose,
    triangles: bodyGeo.attributes.position.count / 3,
    dispose() {
      bodyGeo.dispose();
      for (const k of Object.keys(parts)) parts[k]?.geometry?.dispose?.();
      glassGeo.dispose();
      frontGeo?.dispose();
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
 *   1. push it out until the OPTIC sits `SIGHT_DIST` from the eye, never
 *      letting the rearmost vertex come nearer than `BUTT_MIN`, and then FURTHER
 *      if that is what it takes to keep the top of the optic off the crosshair;
 *   2. raise it until the body clears the bottom edge and the magazine — which
 *      is allowed past it — clears its own looser floor;
 *   3. slide it right until the muzzle sits just inboard of centre — the bore
 *      converging toward the point of aim, which is what hip fire looks like —
 *      but no further right than keeps every vertex inside the right edge,
 *      leaving the receiver, magwell and stock filling the bottom-right
 *      quadrant behind it.
 *
 * Every step is solved over the real vertices, not over the bounding box. A
 * rifle's AABB corner at (lowest y, rearmost z) is the magazine floor
 * teleported back to the butt pad — a point that exists on no part of the gun,
 * two hundred millimetres nearer the eye than the thing it claims to bound. In
 * perspective that error is not conservative in a useful direction: it lifts
 * the whole weapon a third of a screen.
 *
 * Steps 2 and 3 are exact in one pass, because both are linear in the offset
 * being solved (`ndc = (t + p)/(tan * depth)`, and depth depends only on `tz`) —
 * a single max/min over vertices, no search. Step 1's extra push is the one
 * place a search is needed, because the top constraint couples `ty` and `tz`;
 * see the note on the bisection below.
 *
 * Screen targets are in NDC, so they hold at any aspect and any FOV.
 */
function solveHipPose(meshes, muzzleLocal, sightLocal, rot) {
  /* THE TARGETS. Measured before and after with a node probe that projects
   * every drawn triangle to NDC against the real viewmodel frustum at 16:9 and
   * rasterises the silhouette into a 160x90 grid, so "how much of the frame"
   * is a number rather than an impression. At HIGH tier, hip rest pose:
   *
   *              BEFORE (x range / y range / frame coverage)
   *   rifle   x[ 0.02, 0.48]  y[-1.03, -0.06]   4.7%
   *   smg     x[ 0.02, 0.31]  y[-1.03, -0.04]   3.3%
   *   dmr     x[ 0.01, 0.61]  y[-1.03,  0.00]   6.6%
   *
   * Two things in that table, and they point in OPPOSITE directions.
   *
   * The weapon does not eat the frame. It covers 3-7% of it; a shipped console
   * viewmodel covers rather more. Moving it further out to "fit" would make a
   * gun that already reads small read smaller, so depth is NOT the control used
   * below — and `SIGHT_DIST` stays where it was.
   *
   * What is actually wrong is the VERTICAL placement, at both ends:
   *
   *  - The top. The DMR's scope reaches y = 0.00 — the tube crosses the
   *    horizontal centreline, i.e. the HUD crosshair sits on the optic at hip
   *    fire. (This got worse, not better, when the sight picture was widened:
   *    a wider clear cone needs a taller riser, so the optic climbed.) That is
   *    the constraint that has to be solved, and none of the old three targets
   *    expressed it.
   *  - The bottom. `BOTTOM_NDC` was -1.03: the solver deliberately pushed the
   *    lowest vertex 3% of the frame height PAST the bottom edge. Note what it
   *    did and did not do, because the obvious reading is wrong — the target
   *    only ever moved `ty`, so it never made the weapon larger or nearer; it
   *    simply cut the magazine floor off.
   *
   * So the bottom is now two constraints instead of one, split by what the part
   * is. A shipped viewmodel DOES run its magazine off the bottom edge — that is
   * what anchors the weapon to the frame instead of floating it — but it never
   * cuts the trigger guard or the grip. `meshes` entries marked `soft` (the
   * magazine) get the loose floor; the body gets the strict one. Splitting them
   * is what buys the ~0.13 NDC of vertical room the top cap needs, WITHOUT
   * pushing the weapon away and shrinking it.
   */
  const SIGHT_DIST = 0.56;    // metres from the eye to the optical axis origin
  const BUTT_MIN = 0.20;      // rearmost vertex may come no nearer than this
  const BOTTOM_NDC = -0.99;   // lowest vertex of the BODY, just inside the edge
  const MAG_FLOOR_NDC = -1.18; // the magazine may hang off; not more than this
  const TOP_NDC = -0.09;      // nothing above this — keeps the crosshair clear
  const RIGHT_NDC = 0.86;     // keep the silhouette just inside the right edge
  const MUZZLE_NDC = 0.06;    // muzzle sits fractionally right of the crosshair
  const PUSH_MAX = 0.34;      // metres the top cap may push the weapon out by
  const NEAR = 0.02;

  const fovY = THREE.MathUtils.degToRad(Config.camera.viewmodelFov);
  const tanY = Math.tan(fovY * 0.5);
  // Aspect is unknown at build time and the harness shoots 16:9; solving X in
  // NDC against a 16:9 frustum keeps the muzzle inboard on wider screens too.
  const tanX = tanY * (16 / 9);

  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot.rx, rot.ry, rot.rz, 'YXZ'));

  /* Rotate every vertex ONCE into a flat buffer. The solve below reads the set
   * a couple of dozen times (see the bisection) and re-rotating 25k vertices
   * per pass would turn a 1 ms build step into a 30 ms one.
   *
   * A MESH'S OWN POSITION IS ROTATED WITH IT. This used to read
   * `applyQuaternion(q)` and *then* `add(offset)`, which is the wrong order —
   * the world position of a magazine vertex is `q * (vert + magPos) + t`, not
   * `q * vert + magPos`. With a 24 mm offset and a 15-degree yaw that put every
   * magazine vertex about 2 mm from where it actually renders, so the bottom
   * constraint was solved against a magazine that does not exist. */
  let total = 0;
  for (const m of meshes) total += m.array.length;
  const P = new Float32Array(total);
  const SOFT = new Uint8Array(total / 3);
  {
    const v = new THREE.Vector3();
    let w = 0, s = 0;
    for (const { array, offset, soft } of meshes) {
      const flag = soft ? 1 : 0;
      for (let i = 0; i < array.length; i += 3) {
        v.set(array[i], array[i + 1], array[i + 2]);
        if (offset) v.add(offset);
        v.applyQuaternion(q);
        P[w++] = v.x; P[w++] = v.y; P[w++] = v.z;
        SOFT[s++] = flag;
      }
    }
  }
  const N = SOFT.length;

  let maxZ = -Infinity;
  for (let i = 2; i < total; i += 3) if (P[i] > maxZ) maxZ = P[i];
  const sightZ = sightLocal.clone().applyQuaternion(q).z;

  /* Raise the weapon until BOTH floors are satisfied. Linear in `ty` for a
   * fixed `tz`, so it is still one exact max over vertices — no search. */
  const solveTy = (tz) => {
    let ty = -Infinity;
    for (let i = 0, j = 0; i < N; i++, j += 3) {
      const d = -(tz + P[j + 2]);
      if (d < NEAR) continue;
      const y = (SOFT[i] ? MAG_FLOOR_NDC : BOTTOM_NDC) * tanY * d - P[j + 1];
      if (y > ty) ty = y;
    }
    return Number.isFinite(ty) ? ty : 0;
  };
  const topAt = (tz, ty) => {
    let top = -Infinity;
    for (let i = 0, j = 0; i < N; i++, j += 3) {
      const d = -(tz + P[j + 2]);
      if (d < NEAR) continue;
      const t = (P[j + 1] + ty) / (tanY * d);
      if (t > top) top = t;
    }
    return top;
  };

  /* Depth. The near limit is the authored one — the optic at `SIGHT_DIST`, with
   * butt clearance as a floor because geometry inside the 5 mm near plane eats
   * the bottom of the frame. If the top cap is violated there, push out.
   *
   * This is the one place the solve needs a search rather than a max, and the
   * reason is that the top constraint couples the two unknowns: `ty` depends on
   * `tz` through the floors, and the top NDC depends on both. It is monotone —
   * further away is always a lower top, because the bottom stays pinned to the
   * edge while the angular span shrinks — so bisection is exact to the limit of
   * the iteration count, and 26 halvings of a 340 mm interval resolves to five
   * microns. Two passes over 25k vertices per halving is about 1 ms at build. */
  const tzNear = Math.min(-(sightZ + SIGHT_DIST), -(maxZ + BUTT_MIN));
  let tz = tzNear;
  if (topAt(tzNear, solveTy(tzNear)) > TOP_NDC) {
    let lo = tzNear, hi = tzNear - PUSH_MAX;      // hi is FURTHER (more negative)
    if (topAt(hi, solveTy(hi)) > TOP_NDC) {
      tz = hi;                                   // cannot be satisfied; take the best
    } else {
      for (let i = 0; i < 26; i++) {
        const mid = (lo + hi) * 0.5;
        if (topAt(mid, solveTy(mid)) > TOP_NDC) lo = mid; else hi = mid;
      }
      tz = hi;
    }
  }
  const ty = solveTy(tz);

  // Slide right until the muzzle sits just off the crosshair, but never so far
  // that the silhouette crosses the right edge. The muzzle CROWN is the target,
  // not a bounding-box corner: X is aimed at the bore line, so a wide optic or
  // a stock cannot drag the point of aim sideways.
  let txCap = Infinity;
  for (let i = 0, j = 0; i < N; i++, j += 3) {
    const d = -(tz + P[j + 2]);
    if (d < NEAR) continue;
    const x = RIGHT_NDC * tanX * d - P[j];
    if (x < txCap) txCap = x;
  }
  const front = muzzleLocal.clone().applyQuaternion(q);
  const dFront = Math.max(NEAR, -(tz + front.z));
  const tx = Math.min(MUZZLE_NDC * tanX * dFront - front.x, txCap);

  return {
    pos: new THREE.Vector3(tx, ty, tz),
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

/* --------------------------------------------------------------- collimate */

const _cG = new THREE.Vector3();
const _cA = new THREE.Vector3();
const _cP = new THREE.Vector3();
const _cQ = new THREE.Quaternion();
const _cQ2 = new THREE.Quaternion();

/**
 * Place a build's reticle where a collimator would put it, and say what it did.
 *
 * WHY THE LAST TWO RETICLES PHOTOGRAPHED AS CLEAR GLASS
 *
 * Not the size, and not the material — both were fixed last round and both are
 * fine. It was the eyebox gate. The dot was hidden whenever the sight axis
 * missed the rear lens centre by more than `glassR * 0.92`, with the fade
 * starting at 55% of that — a 13.6 mm window on a 30 mm optic, which is
 * tighter than a real one and, far more importantly, tighter than the ADS
 * transition ever gets inside.
 *
 * Work it through with the numbers the capture actually runs at. The harness
 * holds a shot for ~520 ms; under software rasterisation that is three frames,
 * and the aim spring is still around 85% blended when the shutter opens. At
 * 85% the sight axis is 0.04 rad off and the lens sits 0.20 m out, so the axis
 * misses the lens centre by 21 mm — 1.5 apertures. `visible` evaluated to
 * exactly zero, every time, in every ADS frame ever captured. The reticle was
 * being placed correctly, scaled correctly, and then switched off.
 *
 * The replacement keeps the physics and drops the cliff:
 *
 *  - **The dot is never repositioned.** An earlier revision clamped it onto the
 *    aperture so it parked at the rim instead of vanishing mid-transition. That
 *    was wrong and it was measured wrong: the dot rendered 34 px — 1.8 degrees —
 *    from the point of aim. A collimated reticle is parallax-free, so its
 *    direction is the optical axis and moving it anywhere else makes the sight
 *    lie about where the barrel points. Losing sight of the dot outside the
 *    eyebox is the fade's job, not the geometry's. See the note at the clamp
 *    site below.
 *  - **The fade is measured against the tube, not the lens.** A dot is lost
 *    when the eye leaves the eyebox, which for a tube sight is when the axis
 *    walks out past the housing — a couple of apertures, not 0.9 of one. At hip
 *    fire the axis misses by 15 apertures, so the dot is still correctly gone
 *    and the HUD crosshair is still the only hip reference.
 *
 * @param build     a `buildWeapon` result
 * @param cam       the viewmodel camera the reticle is parented to
 * @param adsBlend  0..1 aim blend, for the brightness trim only
 * @param scope     optional ScopeOverlay
 * @returns diagnostics — the numbers a test asserts on instead of a screenshot
 */
export function collimate(build, cam, adsBlend = 0, scope = null) {
  cam.updateMatrixWorld(true);

  const sight = build.sight.group;
  const ret = build.reticle;
  const G = _cG.setFromMatrixPosition(sight.matrixWorld);
  cam.worldToLocal(G);

  const camQi = cam.getWorldQuaternion(_cQ).invert();
  const A = _cA.set(0, 0, -1)
    .applyQuaternion(sight.getWorldQuaternion(_cQ2))
    .applyQuaternion(camQi)
    .normalize();

  const t = G.dot(A);
  if (!(t > 0.01)) {
    ret.visible = false;
    scope?.update(0, 0, 0);
    return { visible: false, reason: 'behind', t, off: 0, opacity: 0, scale: 0 };
  }

  const P = _cP.copy(A).multiplyScalar(t);
  const off = P.distanceTo(G);
  const R = build.sight.glassR;

  // NO POSITIONAL CLAMP. There used to be one here, pulling `P` back onto the
  // glass whenever the axis wandered off it, justified as "the objective forms
  // the dot, so the dot cannot appear outside it".
  //
  // That confuses VISIBILITY with POSITION. It is true that you cannot SEE the
  // dot once your eye leaves the eyebox — which is what the fade below is for.
  // It is not true that the dot moves: a collimated reticle is parallax-free by
  // construction, its apparent direction is the sight's optical axis and nothing
  // else, which is the entire reason `P` is placed along `A`. Dragging `P`
  // toward the glass centre steers the dot off that axis, so the sight stops
  // indicating where the barrel points.
  //
  // Measured cost of the clamp: the dot rendered 34 px from the point of aim —
  // 1.8 degrees, a 3.1 m miss at 100 m — parked 7 px inside the edge of the
  // glass, having previously measured 0.8 px off the optic axis. It traded an
  // honest dot that disappears for a visible one that lies, and a sight that
  // confidently points 1.8 degrees away from the impact is worse than no sight.
  //
  // If the dot is off the glass, the eyebox fade is the mechanism that removes
  // it. Leave the geometry alone.

  // Eyebox falloff, measured in apertures. Full brightness while the axis is
  // anywhere on the glass, gone once it is well outside the housing.
  //
  // The window is deliberately wider than the previous 1.05-2.6, and the reason
  // is a measurement rather than a preference. Sweeping the aim blend in the
  // probe: at 0.80 blend the sight axis misses the lens centre by 2.9
  // apertures, at 0.85 by 2.1. The capture harness holds a shot for ~520 ms,
  // which under software rasterisation is a handful of frames with the aim
  // spring still short of settled — so every ADS frame ever captured was taken
  // inside the band the old curve had already faded to nothing, or nearly.
  // A dot that is correct at blend 1.0 and invisible at 0.85 is a dot nobody
  // ever sees. The window is stated in HOUSING radii (`eyeboxR`) rather than
  // lens radii, so it is the same absolute 21-56 mm band it was measured at
  // even though the clear aperture is now solved rather than authored; at the
  // hip the axis still misses by 15-plus housings and the dot is correctly gone.
  const H = build.sight.eyeboxR || R;
  const fade = 1 - THREE.MathUtils.smoothstep(off, H * 1.05, H * 2.85);
  const scale = t * (build.sight.reticleAngle || 5.8e-4);

  ret.position.copy(P);
  ret.quaternion.identity();
  ret.scale.setScalar(scale);

  // Bright while aiming; trimmed a little at the hip so a dot parked at the rim
  // of the glass never competes with the HUD crosshair.
  let opacity = fade * (0.78 + 0.22 * adsBlend);

  if (scope) {
    const scoped = build.sight.scoped;
    const k = R > 0 ? 1 / R : 0;
    scope.update(scoped ? Math.pow(adsBlend, 1.6) : 0,
      (P.x - G.x) * k * 0.42, (P.y - G.y) * k * 0.42);
    // The etched overlay reticle replaces the 3D one once the eye is in.
    if (scoped) opacity *= 1 - Math.pow(adsBlend, 3);
  }

  ret.material.opacity = opacity;
  ret.visible = opacity > 0.01;
  return {
    visible: ret.visible, reason: 'ok', t, off, offApertures: off / R,
    opacity, scale, pos: P.toArray(),
  };
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
