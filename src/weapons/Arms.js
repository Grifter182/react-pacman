import * as THREE from 'three';
import { Config, QualityTier } from '../core/Config.js';
import { makeMaterial } from '../materials/TextureFactory.js';
import { Kit, loft, roundRect, chamferBox, cyl } from './GunGeo.js';
import { VIEWMODEL_MAGNIFY } from './Gunsmith.js';

/**
 * OWNER: weapons agent.
 *
 * First-person arms. Blocked out rather than sculpted, but built to real
 * proportions and — more importantly — *placed* by construction rather than by
 * guessed Euler triples.
 *
 * HAND FRAME. Getting this wrong is how arms end up inside the receiver, so
 * it is stated once and obeyed everywhere:
 *
 *     +X  across the palm, little finger -> thumb
 *     +Y  the palm normal — the direction the fingers curl toward
 *     +Z  distal, along the fingers; the forearm leaves from the wrist at -Z
 *
 * THE PLACEMENT RULE. A hand does not sit *at* an anchor, it *closes around*
 * one. The curled fingers and the palm face enclose a channel; the axis of that
 * channel is what has to land on the thing being held. So the build is:
 *
 *   1. measure the thing being held, off the weapon's own merged buffer
 *      (`graspRadius`, `underside`, `supportStation`) — never off a constant
 *      copied out of Gunsmith, which is not exported and moves without notice;
 *   2. place the channel in hand space, one radius off the palm face and just
 *      proximal of the knuckles (`graspCentre`), and close each finger onto it
 *      until its *surface* touches (`solveCurl`);
 *   3. build a frame from the channel *axis* and one free roll angle about it
 *      (`seat`);
 *   4. translate the hand so the channel centre lands on the anchor.
 *
 * WHAT THE CHANNEL IS DIFFERS BETWEEN THE TWO HANDS, and that is the substance
 * of this pass rather than a detail of it. The firing hand closes on the pistol
 * grip, which fits inside a hand. The support hand does NOT close on the
 * handguard, because a 56 x 57 mm rail does not fit inside a hand: it closes on
 * a channel of its own girth, hung on the handguard's measured underside. See
 * `HAND_R` for the measurement, and `SUPPORT_ROLL` for why no amount of rolling
 * the old wrap could have saved it.
 *
 * CURRENT MEASUREMENTS. The sight picture is `tools/sightline-probe.mjs` at full
 * ADS through the real animator — the only number anyone may quote for it — and
 * it now reads, on both the rifle and the SMG:
 *
 *   BLOCKED 0%, bands centre->rim 0/0/0/0, no clock position obstructed,
 *   no blockers listed at all, fan 0/37 rays, axis clear.
 *   (Was: rifle 25.2% blocked, bands 0/6/31/33, 82% at 6 o'clock, all of it
 *   `leftHand/fingers`; SMG 14.0%; DMR 21.5%.)
 *
 * Note the disc it passes on is BIGGER than the disc it used to fail on — the
 * front element went from 18.5 mm to 21.3 mm and the picture from 13.7% to 19.2%
 * of frame height while this was being fixed. That was the ordering risk, and it
 * is why the hand was taken out of the bore line entirely instead of tuned to
 * miss the old radius.
 *
 * The rest is geometry, measured in node with a three-mesh-bvh signed distance
 * from every glove vertex to the merged body, all three weapons:
 *
 *   highest support vertex forward
 *     of the optic                   11-13 mm BELOW the bore line (was 58 above)
 *   support hand to body             0.0-0.2 mm nearest, worst -1.7 mm
 *   firing hand to body              0.0-0.1 mm nearest, worst -4.0 mm
 *
 * Negative numbers are glove modelled inside the shell. Everything left is
 * inside the glove's own 5 mm wall, i.e. leather squashed against polymer, which
 * is what contact looks like when neither surface can deform. The figures it
 * replaces were -9.8 mm and 576-649 vertices on the firing hand alone.
 *
 * Anatomy note on the curl: the three phalanges do not flex equally.
 * Proximal : middle : distal runs about 1 : 1.2 : 1.4 of the MCP angle, which
 * is why a relaxed grip reads as a spiral rather than a hinge.
 *
 * Anatomy note on the palm: it is not one slab. The metacarpal shield lies flat
 * on the backstrap and the heel breaks away from it at the carpal arch, which
 * is the only reason a wrist can be behind and below a grip instead of sticking
 * straight out sideways from it. `palmBend` is that break.
 */

const GLOVE = 0, SLEEVE = 1, PAD = 2;

/**
 * THE GLOVE'S CAMOUFLAGE IS THE AO MAP, and it is measured, not deduced.
 *
 * Dumping all three arm bakes and taking 8-bit statistics over the whole tile:
 *
 *              albedo mean / sd      AO mean / sd      AO range
 *   glove          47 / 6.5          139 / 86.8         31-255
 *   sleeve         88 / 6.8          168 / 101.2        31-255
 *   pad            52 / 2.3          152 / 68.2         31-255
 *
 * The albedo of every one of them is flat — a standard deviation of 2 to 7 counts
 * carries no pattern at all. The AO channel has a standard deviation of 68 to 101
 * counts and hits both rails, and viewing it as an image settles it: it is hard
 * black-and-white noise at the texel, a checkerboard on the glove and a
 * thresholded grid on the sleeve. That is not shading, it is a print, and it is
 * the same defect `VIEWMODEL_AO` in Gunsmith.js documents for the receiver —
 * `ambientOcclusion` multiplies indirect diffuse, indirect diffuse is nearly all
 * a matte dark surface shows under a sky, so multiplying it by a binary mask
 * prints camouflage in the literal sense.
 *
 * It is worse here than on the gun for a reason worth writing down: `canvas` bakes
 * with the highest `aoStrength` in the recipe library (1.1) and derives it from a
 * thread lattice, so the field it produces is already binary before anything
 * magnifies it. Turning the intensity down is therefore not a compromise between
 * looks and correctness — the channel contains no usable occlusion to lose. What
 * genuinely occludes on a hand is the gaps between the fingers and the shadow
 * under the cuff, and both of those are geometry, which is already there.
 *
 * So each surface keeps only as much AO as its relief can physically cast:
 * essentially none for a 1.5 mm moulded pebble grain, a little for a woven cloth
 * whose threads really do shade each other, more for a moulded knuckle plate with
 * a millimetre of relief and a hard edge.
 *
 * THE PAD IS NOT THE PATCH, and it is worth saying so because it looks like it
 * is. The knuckle armour, cuff and gauntlet read as pale blocks in a capture, and
 * the obvious diagnosis — a 0.74 tint on a black glove — is wrong: through the
 * sRGB decode its 52-count bake times 0.74 lands at 0.025 linear against the
 * glove's 0.026, i.e. the same value to within 5%. What makes them read bright is
 * that the polymer bake is the glossiest of the three (roughness 0.62 against the
 * glove's 0.84), so they carry the speculars — which is correct for a moulded
 * plate on a suede glove and is exactly the separation-by-gloss a tactical glove
 * has. So the tint is left alone and only the AO comes down. Turning the pad dark
 * to "fix" the blocks would have swapped a bright patch for a dark one.
 *
 * The sleeve genuinely IS too bright, and that is measurable rather than a
 * matter of taste: 88 counts of albedo decode to 0.099 linear, and even under the
 * 0.42 tint it stood at 0.042 against the glove's 0.026 — 1.6 times the value of
 * the thing it is sewn to, on the surface nearest the camera. At 0.30 it sits at
 * 1.13 times, which is the right relationship for cotton duck next to leather.
 * The tint is a multiplier, not a new bake: the weave, the slubs and the abrasion
 * all survive it.
 */
export function armMaterials() {
  const M = VIEWMODEL_MAGNIFY * 0.7;
  const glove = makeMaterial('rubber', {
    seed: 71, size: 512, detailStrength: 0.38, repeat: M,
    material: { aoMapIntensity: 0.05 },
  });
  const sleeve = makeMaterial('canvas', {
    seed: 33, size: 512, repeat: 2 * M,
    material: { color: new THREE.Color(0.30, 0.31, 0.25), aoMapIntensity: 0.10 },
  });
  // Knuckle plate, cuff band and gauntlet: the same polymer bake as the weapon's
  // furniture, at the glove's own value and the bake's own roughness, so the two
  // separate by gloss rather than by tone.
  const pad = makeMaterial('polymer', {
    seed: 88, size: 256, repeat: M,
    material: { color: new THREE.Color(0.74, 0.74, 0.76), aoMapIntensity: 0.16 },
  });
  return [glove, sleeve, pad];
}

function detail() {
  if (Config.quality === QualityTier.LOW) return 0;
  if (Config.quality === QualityTier.MEDIUM) return 1;
  return 2;
}

const _ORIGIN = new THREE.Vector3();
const _va = new THREE.Vector3();

/** Orientation whose +Z is `dir` and whose +Y leans toward `palmUp`. */
function frame(dir, palmUp) {
  return new THREE.Matrix4().lookAt(
    dir instanceof THREE.Vector3 ? dir : new THREE.Vector3(...dir),
    _ORIGIN,
    palmUp instanceof THREE.Vector3 ? palmUp : new THREE.Vector3(...palmUp)
  );
}

const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
const RX = (a) => new THREE.Matrix4().makeRotationX(a);
const RY = (a) => new THREE.Matrix4().makeRotationY(a);

/* --------------------------------------------------- measuring the weapon */

/**
 * Radial extent of the weapon body about an axis, over an axial band, at a
 * chosen percentile.
 *
 * This is how the hands find out how thick the thing they are holding is. The
 * alternative — copying `hg.radius` or the grip's profile constants out of
 * Gunsmith — makes the arms silently wrong the moment the gunsmith retunes a
 * part, and those constants are not exported anyway.
 *
 * `pct` is not a taste knob and the default is not the right answer everywhere.
 * A percentile below the maximum exists because the band inevitably catches a
 * rail tooth, a sling loop or the edge of the magwell, and one outlier must not
 * push the whole hand off the weapon. But a LOW percentile is the radius of the
 * part's narrow places, and fingers solved against that close inside its wide
 * ones — see the 0.95 at the pistol grip and the 576 vertices of glove that were
 * inside the lower receiver at the median.
 */
function graspRadius(geo, origin, axis, t0, t1, rMax, fallback, pct = 0.6) {
  const pos = geo?.attributes?.position;
  if (!pos) return fallback;
  const d = axis.clone().normalize();
  const rs = [];
  for (let i = 0; i < pos.count; i++) {
    _va.fromBufferAttribute(pos, i).sub(origin);
    const t = _va.dot(d);
    if (t < t0 || t > t1) continue;
    const r = _va.addScaledVector(d, -t).length();
    if (r <= rMax) rs.push(r);
  }
  if (rs.length < 64) return fallback;
  rs.sort((a, b) => a - b);
  return rs[Math.min(rs.length - 1, Math.floor(rs.length * pct))];
}

/**
 * The underside of the weapon at the station the support hand works: the lowest
 * body vertex in a narrow column around the anchor, in weapon space.
 *
 * This replaces a `riseAbove` that existed to lift the support anchor onto the
 * handguard's *axis*, i.e. to wrap the hand around the handguard's girth — see
 * the note above `SUPPORT_ROLL` for the measurement that killed that idea. What
 * the hand needs now is the underside, and it needs it as a true minimum rather
 * than a percentile: this is a CLEARANCE, and a 90th-percentile clearance is one
 * that a tenth of the shell pokes through. (`graspRadius` above wants the
 * opposite and takes a median for it; the two are not interchangeable.)
 *
 * The windows are tight, and the floor is tighter still. The z window keeps the
 * receiver out of it; `reach` keeps the MAGWELL out of it. That last one is not
 * belt-and-braces: on the SMG the support anchor sits only 40 mm ahead of the
 * lower, and a magazine well hangs 65 mm below the bore in a continuous column
 * with no gap to detect, so an unbounded minimum measured the bottom of the
 * MAGWELL and hung the hand in the air 60 mm under the gun. The bound is sound
 * because of what the anchor IS: Gunsmith publishes it *inside* the handguard
 * shell, near its bottom, so the surface the hand bears on cannot be much below
 * it, and anything that is belongs to another part.
 */
function underside(geo, p, halfZ, reach, fallback) {
  const pos = geo?.attributes?.position;
  if (!pos) return fallback;
  const floor = p.y - reach;
  let bottom = 1e9, n = 0;
  for (let i = 0; i < pos.count; i++) {
    _va.fromBufferAttribute(pos, i);
    if (Math.abs(_va.z - p.z) > halfZ || _va.y > p.y || _va.y < floor) continue;
    if (Math.abs(_va.x) > 0.020) continue;
    n++;
    bottom = Math.min(bottom, _va.y);
  }
  return n < 64 ? Math.max(fallback, floor) : bottom;
}

/**
 * Where along the bore the support hand can actually sit.
 *
 * The anchor names a station on the handguard, but a hand is 90 mm across and
 * hangs a hand's depth below whatever it holds, so the station has to be clear
 * BELOW for that whole footprint — and on the SMG it is not: Gunsmith puts the
 * support anchor 40 mm ahead of the lower, where a magazine well and a stock
 * column hang 65 mm below the bore, and a fist placed there is modelled straight
 * through the magwell (measured: 389 glove vertices up to 8.9 mm inside it).
 *
 * So the station walks forward, a rail tooth at a time, until nothing hangs
 * deeper under the hand's own footprint than the shell it is gripping does. On
 * the rifle and the DMR that is a no-op — the published anchor is already out on
 * open handguard. On the SMG it slides the hand forward onto the handguard,
 * which is where it belonged.
 */
function supportStation(geo, p, reach) {
  const step = 0.008;
  for (let k = 0; k < 14; k++) {
    const at = { x: 0, y: p.y, z: p.z - k * step };
    const shell = underside(geo, at, 0.025, reach, p.y - reach);
    // Same column, but as deep and as wide as the hand itself.
    const deep = underside(geo, at, 0.045, 0.120, shell);
    if (deep >= shell - 0.004) return { z: at.z, under: shell };
  }
  return { z: p.z, under: underside(geo, p, 0.025, reach, p.y - reach) };
}

/* ------------------------------------------------------------ the grasp */

const FLEX = [1.0, 1.2, 1.4];
const SEG = [0.42, 0.32, 0.26];

/**
 * WHICH WAY A HAND WRAPS, and why the support hand used to stand in the sight.
 *
 * `seat` builds the frame as X = Y x Z with the thumb at +X, the palm normal at
 * +Y and the fingers at +Z. In a right-handed frame the right thumb is `f x n`,
 * i.e. at -X — so the hand this file builds is anatomically a LEFT hand, and
 * `mirror` turns it into a right one. That is not cosmetic. The wrap always runs
 * from the palm, through the fingers' own +Z, round to the palm normal, so the
 * side the palm sits on decides which way round the object the fingers travel:
 *
 *   left hand,  palm on the object's left  -> fingers cross the TOP
 *   left hand,  palm UNDER the object      -> fingers climb the FAR side
 *
 * Both are real; try them on a broom handle. The old pass built the support hand
 * mirrored — a right hand on the left arm — which forced the first case, and the
 * first case cannot work on this weapon. Measured: the handguard's section under
 * the support anchor is 56 mm wide and 57 mm tall, the optic axis is 65 mm above
 * the bore, and the sight cone (eye, through the rim of the front element, and
 * onward) is already 33 mm in radius by the time it reaches the hand — so the
 * bottom of the sight picture passes 42 mm above the bore, one millimetre above
 * the handguard's own rail. A hand outside a 32 mm channel carries its knuckle
 * line at 41 mm and the back of its palm at 64 mm from that channel's axis, so
 * fingers crossing the top stand 24 mm inside the sight cone before anyone poses
 * anything. That is the measured 25.2% of the sight picture at 5, 6, 7 and 8
 * o'clock, 0.45-0.51 m out with the front lens at 0.31 m. No roll fixes it: with
 * the wrist on the left — the only place a left elbow can be — the wrap crosses
 * the top for every roll angle.
 *
 * So the support hand is built unmirrored, as the left hand it is, seated on an
 * axis pointing down the bore instead of back out of the stock. That reverses
 * the wrap: the palm lies flat under the handguard, the fingers climb its right
 * side, the thumb still runs forward and the wrist still comes off to the left.
 * `SUPPORT_ARC` then stops the climb at the bore line.
 */

/**
 * The support hand's own grip, rather than the handguard's girth.
 *
 * A 56 x 57 mm rail does not fit inside a hand: the fingers cannot meet round it,
 * so the only contact a hand can make with a face that wide is FLAT — the palm
 * on the underside. Sizing the channel to the shell (the old `graspRadius` call
 * did, at 32 mm) therefore did not buy contact, it just put every knuckle 41 mm
 * off the axis and swung them through the sight. So the channel is sized to the
 * hand — 24 mm is the hole through a loose fist, plus the glove — and *placed* so
 * the palm's contact plane lands on the measured underside.
 *
 * Placing it is then one line: the channel axis goes ON the measured underside.
 * That is not a fudge factor, it is the only height at which a fist this size
 * both touches and clears. A closed hand's outermost surface stands
 * radius + girth off its own channel axis, so with the axis on the underside the
 * top of the wrap bears on the shell while the palm hangs a hand's depth below
 * it — which is what a support hand under a rail this wide actually does, and
 * why nothing needs to be capped or clamped. `SUPPORT_ROLL` then tilts the whole
 * fist a few degrees so the bearing surface is the fingers' backs and the
 * knuckle armour rather than one tangent line.
 *
 * Measured on all three weapons at full ADS: 0.0% of the sight picture blocked,
 * every clock position clear, the highest glove vertex forward of the optic
 * 11-13 mm BELOW the bore line (52-55 mm below the bottom of the sight picture),
 * nearest body surface 0.0-2.5 mm with no vertex more than 1.3 mm inside the
 * shell — contact, not intersection.
 */
const HAND_R = 0.024;
const SUPPORT_ROLL = 0.26;
/** Palm half-thickness (the contact face) and knuckle row, in hand space. */
const PALM_TOP = 0.016, PALM_ZM = 0.082;

/** The middle finger's joint chain, projected into the hand's YZ plane. */
function fingerChain(curl, len, y0, z0) {
  const pts = [[y0, z0]];
  let a = 0;
  for (let i = 0; i < 3; i++) {
    a += curl * FLEX[i];
    const L = len * SEG[i];
    const p = pts[pts.length - 1];
    pts.push([p[0] + Math.sin(a) * L, p[1] + Math.cos(a) * L]);
  }
  return pts;
}

function segDist(py, pz, a, b) {
  const dy = b[0] - a[0], dz = b[1] - a[1];
  const L2 = dy * dy + dz * dz || 1e-9;
  let t = ((py - a[0]) * dy + (pz - a[1]) * dz) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(py - (a[0] + dy * t), pz - (a[1] + dz * t));
}

/** Distance from a point to the finger's joint chain, in the hand's YZ plane. */
function clearance(chain, y, z) {
  let r = 1e9;
  for (let s = 0; s < chain.length - 1; s++) r = Math.min(r, segDist(y, z, chain[s], chain[s + 1]));
  return r;
}

/**
 * Where the held cylinder sits in hand space.
 *
 * Both coordinates are forced rather than searched, because both are physically
 * determined and searching for them produced nonsense (the first attempt let the
 * solver slide the object down to the wrist, where it is trivially far from the
 * fingers and trivially not being held). The object rests *on the palm face*, so
 * its axis is exactly one radius above it; and it sits in the hollow just
 * proximal of the knuckle row, because that is where the fingers rise off the
 * metacarpals. Everything else follows from those two.
 */
function graspCentre(radius, palmY, zM) {
  return { y: palmY + radius, z: zM - 0.012 };
}

/**
 * MCP flexion that closes one finger onto the held cylinder until its *surface*
 * touches — not its joint centreline. Missing the girth term is worth about
 * 10 mm of flexion and is precisely how the last pass got fingers modelled
 * inside the polymer: the chain was tangent, so the finger was 10 mm in.
 *
 * Solved per finger rather than once for the hand: an 82 mm middle finger and a
 * 64 mm little finger do not reach the same cylinder at the same angle, and the
 * difference between them is most of what makes a closed hand look closed.
 * Clearance falls monotonically with flexion across the useful range, so plain
 * bisection is enough.
 */
function solveCurl(radius, len, girth, palmY, zM, y0 = 0.002) {
  const g = graspCentre(radius, palmY, zM);
  const want = radius + girth * 0.48;
  let lo = 0.30, hi = 1.20;
  for (let i = 0; i < 14; i++) {
    const c = (lo + hi) * 0.5;
    if (clearance(fingerChain(c, len, y0, zM), g.y, g.z) > want) lo = c; else hi = c;
  }
  return Math.min(1.24, Math.max(0.42, lo));
}

/* -------------------------------------------------------------- geometry */

/**
 * One finger: three tapered segments hinged in a spiral about the palm normal,
 * with a knuckle bulge at every joint and a rounded pad at the tip. The bulges
 * are what let a finger read as a finger at 20 px wide — a smooth taper at this
 * size is a sausage.
 *
 * The section is narrower than it is deep, and that is the fix for the hand
 * reading as a mitten. Real fingers do touch each other, but they touch along a
 * crease, and a crease is what the eye actually uses to count them. Measured on
 * the old numbers: MCP spacing 16.8 mm against section widths of 19.5, 19.3, 18.1
 * and 16.5 mm, so every neighbouring pair overlapped by 2.6 mm — the four lofts
 * fused into one slab with no crease anywhere on it. Taking 10% off the width and
 * putting it back into the depth keeps the girth a finger's girth in silhouette
 * and leaves about a millimetre of air between neighbours for the shading to find.
 */
function finger(kit, base, len, girth, curl, spread, D, pads) {
  const c = D >= 1 ? 3 : 1;
  let m = base.clone().multiply(RY(spread));
  for (let i = 0; i < 3; i++) {
    m = m.multiply(RX(-curl * FLEX[i]));
    const L = len * SEG[i];
    const g0 = girth * (1 - i * 0.13);
    const g1 = girth * (1 - (i + 1) * 0.13);
    const k = g1 / g0;
    const prof = roundRect(g0 * 0.90, g0 * 0.98, g0 * 0.34, c);
    const rings = [
      { z: 0, scale: 1.08, scaleY: 1.04 },         // joint bulge
      { z: L * 0.22, scale: 0.98, scaleY: 0.99 },
      { z: L * 0.74, scale: k * 1.02, scaleY: k * 1.02 },
    ];
    if (i === 2) {
      rings.push({ z: L * 0.90, scale: k * 0.92, scaleY: k * 0.96, dy: -g0 * 0.02 });
      rings.push({ z: L, scale: k * 0.52, scaleY: k * 0.66, dy: -g0 * 0.05 });
    } else {
      rings.push({ z: L, scale: k, scaleY: k });
    }
    kit.add(loft(prof, rings), GLOVE, { m: m.clone() });

    if (pads && D >= 2 && i < 2) {
      // Knuckle armour sits on the back of the hand: -Y, opposite the curl.
      kit.add(chamferBox(g0 * 0.80, g0 * 0.30, L * (i === 0 ? 0.62 : 0.46), g0 * 0.11), PAD, {
        m: m.clone().multiply(T(0, -g0 * 0.52, L * 0.34)),
      });
    }
    m = m.multiply(T(0, 0, L));
  }
}

/**
 * Build one hand, its cuff and its forearm in the canonical right-hand frame.
 *
 * `opts.radius` is the held cylinder, which every finger solves itself against;
 * everything else is pose. `opts.forearm` is a *direction in this hand's local
 * frame* — the caller decides where the elbow belongs in weapon space and
 * rotates it in through `intoHand`, so the forearm keeps aiming at a body even
 * after the gunsmith moves an anchor.
 */
function buildHand(mats, opts, D) {
  const kit = new Kit(1 / 0.22);
  const palmW = 0.086, palmT = PALM_TOP * 2;
  const top = PALM_TOP;                          // the face that meets the weapon
  const zM = PALM_ZM;                            // knuckle row
  const zH = 0.036;                              // carpal arch: where the palm breaks
  const bend = opts.palmBend ?? 0.45;
  const c = D >= 1 ? 3 : 1;

  // Heel of the hand, hinged away from the contact plane at the carpal arch.
  const heel = T(0, 0, zH).multiply(RX(-bend)).multiply(T(0, 0, -zH));

  kit.label = 'palm';
  // Metacarpal shield: flat where it meets the weapon, crowned on the back.
  kit.add(loft(roundRect(palmW, palmT, 0.012, c), [
    { z: zH - 0.008, scale: 0.96, scaleY: 0.94 },
    { z: zH + 0.010, scale: 1.00, scaleY: 1.00 },
    { z: zM - 0.014, scale: 0.99, scaleY: 0.96, dy: -0.001 },
    { z: zM + 0.004, scale: 0.90, scaleY: 0.80, dy: -0.003 },
  ]), GLOVE);

  kit.label = 'heel';
  kit.add(loft(roundRect(palmW * 0.94, palmT, 0.012, c), [
    { z: 0.002, scale: 0.66, scaleY: 0.80 },     // the wrist is narrower than the palm
    { z: 0.020, scale: 0.92, scaleY: 0.94 },
    { z: zH + 0.006, scale: 1.00, scaleY: 1.00 },
  ]), GLOVE, { m: heel.clone() });

  kit.label = 'thenar';
  // Thenar eminence — the muscle at the base of the thumb, on the +X side. It
  // is the pad that actually bears on the backstrap, so it stands proud of the
  // shield rather than being flush with it.
  // It is deliberately *not* on the heel's side of the arch: it has to stay
  // welded to the thumb's root, which sits level with the held cylinder, and a
  // bend between the two opens a gap where the web of the hand should be.
  kit.add(loft(roundRect(0.032, 0.028, 0.010, 2), [
    { z: 0.006, scale: 0.62 }, { z: 0.030, scale: 1.00 }, { z: 0.062, scale: 0.84 },
  ]), GLOVE, { m: T(palmW * 0.27, 0.002, 0.004) });
  // Hypothenar: the ulnar pad, smaller and lower.
  kit.add(loft(roundRect(0.024, 0.024, 0.009, 2), [
    { z: 0.004, scale: 0.70 }, { z: 0.024, scale: 1.00 }, { z: 0.048, scale: 0.76 },
  ]), GLOVE, { m: heel.clone().multiply(T(-palmW * 0.30, -0.001, 0.006)) });

  // Seams. A tactical glove is cut and sewn, and at this range the stitching is
  // most of what says "garment" rather than "moulding": two side seams where the
  // palm panel meets the back panel, and one across the knuckle line where the
  // stretch panel is let in. They are 2 mm piping in the glove's own material, so
  // they read as a shading break rather than as a stripe — which is the whole
  // point, since a stripe is what the AO map was already doing wrong.
  if (D >= 2) {
    kit.label = 'seam';
    const sL = zM - zH + 0.014;
    for (const sx of [-1, 1]) {
      kit.add(chamferBox(0.0024, 0.0026, sL, 0.0007), GLOVE, {
        m: T(sx * palmW * 0.465, 0, (zH + zM) * 0.5 + 0.002),
      });
    }
    kit.add(chamferBox(palmW * 0.84, 0.0024, 0.0026, 0.0007), GLOVE, {
      m: T(0, -palmT * 0.46, zM - 0.012),
    });
  }

  // Four fingers: index nearest the thumb (+X), little finger at -X. Each one
  // closes onto the held cylinder on its own, at its own length.
  kit.label = 'fingers';
  const R = opts.radius ?? 0.023;
  const lens = [0.074, 0.082, 0.078, 0.064];
  const girths = [0.0195, 0.0193, 0.0181, 0.0165];
  // Height of the MCP row in the palm's own thickness. The default puts it on
  // the mid-plane, which is right for a fist round a pistol grip. A hand bearing
  // on a FLAT face wants it up on the contact plane instead: with the row 14 mm
  // below the palm's face the proximal phalanges start 44 mm off the channel
  // axis instead of 38, and a 82 mm finger swung from 6 mm further out reaches
  // 13 mm further across the gun before it has curled at all.
  const fy = opts.fingerY ?? 0.002;
  // Spacing widened from 0.195 to 0.215 of the palm for the same reason the
  // section narrowed: at 16.8 mm the MCPs were closer together than the fingers
  // were wide.
  for (let i = 0; i < 4; i++) {
    const x = palmW * (0.32 - i * 0.215);
    let base = T(x, fy - Math.abs(i - 1.2) * 0.0012, zM - 0.004);
    let f = solveCurl(R, lens[i], girths[i], top, zM, fy);
    let spread = (i - 1.5) * 0.075;
    if (i === 0 && opts.trigger !== undefined) {
      // The trigger finger leaves the front strap: it extends, rolls out of the
      // wrap plane, and reaches forward instead of closing. It is the one finger
      // that is not solved against the grip, because it is not on the grip.
      kit.label = 'trigger-finger';
      f = opts.trigger;
      spread = opts.triggerSpread ?? 0.18;
      base = base.multiply(new THREE.Matrix4().makeRotationZ(opts.triggerRoll ?? -0.30));
    }
    finger(kit, base, lens[i], girths[i], f, spread, D, true);
    if (i === 0) kit.label = 'fingers';
  }

  // Thumb: rooted on the thenar side, opposed across the object. Its MCP has to
  // sit level with the held cylinder — rooted down at the wrist it can point
  // anywhere it likes and never come within 20 mm of the thing it is opposing.
  kit.label = 'thumb';
  const tb = opts.thumbBase ?? [0.40, 0.008, 0.046];
  const thumb = T(palmW * tb[0], tb[1], tb[2])
    .multiply(RY(opts.thumbYaw ?? 1.05))
    .multiply(RX(-(opts.thumbLift ?? 0.35)));
  finger(kit, thumb, 0.064, 0.0225, opts.thumbCurl ?? 0.55, 0, D, false);

  /* --- wrist, cuff and forearm ------------------------------------------ */
  // The forearm is most of what sells the grip: a hand with nothing behind it
  // reads as a prop hanging in the air no matter how well it is posed. It runs
  // from the wrist — which the palm break has already put behind and below the
  // weapon — out of the bottom of the frame toward the shoulder.
  kit.label = 'forearm';
  const wristPt = new THREE.Vector3(0, 0, 0.004).applyMatrix4(heel);
  const fdir = (opts.forearm ? opts.forearm.clone() : new THREE.Vector3(0, -0.3, -1)).normalize();
  const fup = Math.abs(fdir.y) > 0.94 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const arm = T(wristPt.x, wristPt.y, wristPt.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion().setFromRotationMatrix(frame(fdir, fup))
    ));
  const L = opts.forearmLen ?? 0.30;

  // The taper is not linear and the axis is not straight: a forearm swells
  // through the belly of the flexors and bows toward the ulnar side.
  kit.add(loft(roundRect(0.052, 0.046, 0.017, c), [
    { z: -0.010, scale: 0.86, scaleY: 0.84 },
    { z: 0.014, scale: 0.94, scaleY: 0.92, roll: 0.06 },
    { z: L * 0.24, scale: 1.24, scaleY: 1.20, dx: -0.004, roll: 0.16 },
    { z: L * 0.60, scale: 1.46, scaleY: 1.40, dx: -0.010, roll: 0.26 },
    { z: L, scale: 1.52, scaleY: 1.44, dx: -0.016, roll: 0.30 },
  ]), SLEEVE, { m: arm.clone() });

  // Cuff: the raised band where the glove ends and the sleeve begins, plus the
  // strap over it. Without this the glove just stops, and the eye reads the
  // stop as a modelling error rather than as a piece of kit.
  kit.label = 'cuff';
  kit.add(loft(roundRect(0.062, 0.050, 0.018, c), [
    { z: -0.016, scale: 0.92, scaleY: 0.90 },
    { z: -0.006, scale: 1.04, scaleY: 1.02 },
    { z: 0.016, scale: 1.06, scaleY: 1.04 },
    { z: 0.024, scale: 0.94, scaleY: 0.92 },
  ]), PAD, { m: arm.clone() });
  if (D >= 1) {
    kit.add(chamferBox(0.020, 0.013, 0.008, 0.0016), PAD, { m: arm.clone().multiply(T(-0.027, -0.022, 0.006)) });
    kit.add(cyl(0.0055, 0.0055, 0.010, 8), PAD, { m: arm.clone().multiply(T(-0.033, -0.019, 0.002)) });
  }
  // Gauntlet: the glove's own back plate, bridging knuckles to cuff.
  if (D >= 2) {
    kit.label = 'gauntlet';
    kit.add(loft(roundRect(0.062, 0.010, 0.004, 2), [
      { z: zH - 0.006, scale: 0.86 }, { z: zH + 0.014, scale: 1.00 }, { z: zM - 0.018, scale: 0.94 },
    ]), PAD, { m: T(0, -palmT * 0.48, 0) });
  }

  const geo = kit.build();
  if (opts.mirror) mirrorGeometry(geo);
  const mesh = new THREE.Mesh(geo, mats);
  mesh.frustumCulled = false;
  return mesh;
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

/**
 * Seat a built hand on a grasp axis.
 *
 * `axis` is the direction from the little finger toward the thumb — i.e. the
 * axis of the channel the fingers closed around. `roll` spins the hand about
 * that axis, and it is the only free parameter left once the axis is known:
 * everything else (which way the fingers point, which way the palm faces) falls
 * out of it, because a hand closed around a cylinder has exactly one degree of
 * freedom left.
 */
function seat(axis, seed, roll, grasp) {
  const X = axis.clone().normalize();
  // Reference finger direction: `seed` made perpendicular to the axis.
  const d0 = seed.clone().addScaledVector(X, -seed.dot(X)).normalize();
  const dir = d0.applyAxisAngle(X, roll);
  const palmUp = new THREE.Vector3().crossVectors(dir, X).normalize();
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(frame(dir, palmUp));
  // Put the grasp channel on the anchor. The channel centre is on the hand's
  // YZ plane, so mirroring (which only negates x) leaves it where it is.
  const offset = new THREE.Vector3(0, grasp.y, grasp.z).applyQuaternion(quaternion).negate();
  return { quaternion, offset, dir, palmUp };
}

/**
 * A weapon-space direction expressed in the hand's own local frame, ready to be
 * built into the buffer.
 *
 * `mirror` is not cosmetic here. The left hand is built as a right hand and
 * mirrored across x *after* the Kit is merged, so a direction that must end up
 * pointing at the left elbow has to be fed in pointing at the right one.
 */
function intoHand(dirWeapon, pose, mirror) {
  const v = dirWeapon.clone().applyQuaternion(pose.quaternion.clone().invert()).normalize();
  if (mirror) v.x = -v.x;
  return v;
}

/**
 * Assemble both arms and place them on a built weapon.
 * Returns `{ root, left, right, rest }`; `rest` holds the neutral local
 * transforms the animator layers its offsets on top of.
 */
export function buildArms(weapon, mats) {
  const D = detail();
  const A = weapon.anchors;
  const body = weapon.body?.geometry;

  const root = new THREE.Group();
  root.name = 'Arms';
  // The hands live inside the viewmodel camera's near volume and are posed
  // every frame from the weapon's anchors, so their world bounds move faster
  // than a cached bounding sphere can follow. Culling is switched off all the
  // way down the chain rather than only on the leaf meshes.
  root.frustumCulled = false;

  const GLOVE_T = 0.005;                          // glove wall between skin and steel

  /* --- firing hand ----------------------------------------------------- */
  // The channel axis is the grip axis, which is the grip's rake and nothing
  // else. The hand rolls about it until the wrist ends up behind and below the
  // weapon rather than sticking out to the right of it.
  const gripDown = new THREE.Vector3(0, -1, 0)
    .applyEuler(new THREE.Euler(A.rightRake || 0, 0, 0)).normalize();
  const gripUp = gripDown.clone().negate();
  // 0.95, not the median. A pistol grip is not a cylinder — it is a raked,
  // tapered moulding with a palm swell and a beavertail — so a median radius is
  // the radius of its NARROW places and the fingers close 5-10 mm inside its wide
  // ones. Measured with the median: 576 glove vertices up to 9.8 mm inside the
  // lower receiver. At the 95th percentile the same fingers sit 0.0-4.0 mm off
  // it, i.e. within the glove's own 5 mm wall — squashed leather, not steel.
  const rGrip = graspRadius(body, A.rightHand, gripDown, -0.012, 0.030, 0.045, 0.0175, 0.95) + GLOVE_T;
  const gripSolve = graspCentre(rGrip, PALM_TOP, PALM_ZM);

  const right = new THREE.Group();
  right.name = 'rightArm';
  right.frustumCulled = false;
  const rPose = seat(gripUp, new THREE.Vector3(-1, 0, 0), -0.45, gripSolve);

  // Where the forearm has to go, given in weapon space and rotated into the
  // hand before the buffer is built. Mostly down, partly back: the firing elbow
  // is at the ribs, and a forearm aimed straight at the shoulder passes through
  // the lens when the weapon comes up to the eye.
  const rh = buildHand(mats, {
    // The thumb rolls further over the top and further round the grip than it
    // did, and the trigger finger extends rather than curling: both were
    // modelled through the receiver — 138 thumb and 246 trigger-finger vertices
    // up to 9.8 mm inside it — because they are the two digits NOT solved
    // against the grip, so nothing was stopping them.
    radius: rGrip, thumbCurl: 1.00, thumbYaw: 0.60, thumbLift: 0.55,
    trigger: 0.60, triggerSpread: 0.02, triggerRoll: 0.26, palmBend: 0.50,
    forearm: intoHand(new THREE.Vector3(0.30, -0.92, 0.25), rPose, false),
    forearmLen: 0.30,
  }, D);
  rh.name = 'rightHand';        // named for the sight-line probe's hit list
  rh.quaternion.copy(rPose.quaternion);
  rh.position.copy(rPose.offset);
  right.position.copy(A.rightHand);
  right.add(rh);
  root.add(right);

  /* --- support hand ---------------------------------------------------- */
  // The channel axis is the bore, ON the measured underside — see `HAND_R`. The
  // old code lifted the published anchor by 34% of a measured shell height to get
  // it onto the handguard's own axis, so the hand could encircle the handguard;
  // that is the thing that was standing in the sight.
  const station = supportStation(body, A.leftHand, 0.012);
  const rHand = HAND_R + GLOVE_T;
  const hgAxis = new THREE.Vector3(0, station.under, station.z);
  const hgSolve = graspCentre(rHand, PALM_TOP, PALM_ZM);

  const left = new THREE.Group();
  left.name = 'leftArm';
  left.frustumCulled = false;
  // See the note above `SUPPORT_ROLL`. The buffer is a left hand already, so this
  // one is NOT mirrored — it used to be, which made the support hand a right hand
  // on a left arm and forced the wrap over the top of the handguard. The axis
  // points DOWN the bore rather than back out of the stock, which is what keeps
  // the thumb (at the buffer's +X) running forward and the index finger the
  // forwardmost of the four now that the mirror is gone. The roll is then just
  // the tilt of the fist: `seat` puts the contact patch 90 degrees anticlockwise
  // of the finger direction on an unmirrored hand, so a small positive roll means
  // fingers across the bore and the palm a few degrees off straight down.
  const lPose = seat(new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), SUPPORT_ROLL, hgSolve);
  const lh = buildHand(mats, {
    radius: rHand, fingerY: 0.0072,
    thumbCurl: 0.30, thumbYaw: 1.30, thumbLift: 0.02, palmBend: 0.34,
    forearm: intoHand(new THREE.Vector3(-0.46, -0.80, 0.39), lPose, false),
    forearmLen: 0.34,
  }, D);
  lh.name = 'leftHand';
  lh.quaternion.copy(lPose.quaternion);
  lh.position.copy(lPose.offset);
  left.position.copy(hgAxis);
  left.add(lh);
  root.add(left);

  const rest = {
    right: { pos: right.position.clone(), rot: right.rotation.clone() },
    left: { pos: left.position.clone(), rot: left.rotation.clone() },
  };

  return {
    root, left, right, rest,
    /** What the pose was solved against — read by the geometry probe. */
    measured: {
      gripRadius: rGrip, gripGrasp: [gripSolve.y, gripSolve.z],
      underside: station.under, supportZ: station.z, anchorZ: A.leftHand.z,
      supportRadius: rHand, supportAxis: hgAxis.toArray(), supportGrasp: [hgSolve.y, hgSolve.z],
    },
    dispose() { rh.geometry.dispose(); lh.geometry.dispose(); },
  };
}
