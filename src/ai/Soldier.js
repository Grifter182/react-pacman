import * as THREE from 'three';

/**
 * OWNER: AI agent (NPC models).
 *
 * A blocked-out soldier: helmet, plate carrier, pouches, limbs — all procedural
 * geometry, skinned to a real 19-bone skeleton.
 *
 * The mesh is built **once** in bind space and shared by every bot; only the
 * skeleton is per-instance. That is the whole reason this is a SkinnedMesh
 * rather than a hierarchy of rigid parts: one geometry, one upload, one draw
 * call per material, and elbows and knees that actually deform instead of
 * pulling apart.
 *
 * Bind space has its origin at the capsule centre (0.87 m off the ground), so a
 * bot's rig transform is exactly its collision capsule transform — no offset
 * bookkeeping anywhere else in the module.
 *
 * Skin weights are authored, not solved: every part declares which bone owns it
 * and whether it is rigid (helmet, plates) or soft (limb sleeves). Soft parts
 * blend to the parent bone over the first quarter of the bone's length, which is
 * what gives a clean elbow without a full heat-diffusion solve.
 *
 * ---------------------------------------------------------------------------
 * DESIGNED FOR THE RANGE IT IS SEEN AT, NOT FOR A TURNTABLE
 * ---------------------------------------------------------------------------
 * The contact measurements say the median nearest enemy is 27-66 m away. Project
 * the capsule through the live camera at 1600x900 and a soldier is 108 px tall
 * at 10 m, 42 px at 25 m and 20 px at 50 m — at 50 m his head is two pixels and
 * his shoulders are eight. Nothing finer than ~5 cm survives that, so this model
 * spends its triangles on the three things that do:
 *
 *   SILHOUETTE  square shoulder line, helmet with a brim and a rear counterweight,
 *               antenna, pack, thigh pockets, and a carbine held across the body.
 *               Those are the shapes a player reads as "armed man" at 40 px.
 *   VALUE       a deliberate three-band structure — near-black kit (albedo ~0.12
 *               sRGB), mid-olive fatigues (~0.33), dusted boots and a bare face.
 *               The measured market sand sits around 0.5, so the dark mass has
 *               ~0.4 of value separation against every lit surface on the map,
 *               and the mid band carries him against shadow.
 *   EDGE        a sky-tinted fresnel rim in the character materials only. It is
 *               the one term that separates a dark soldier from a dark doorway,
 *               and it costs no draw call and no triangle.
 *
 * Camouflage is deliberately weak here. The old four-tone pattern was authored
 * at 5.5, 13 and 27 cycles/m against a mesh whose median edge is 51 mm: two of
 * its three octaves were below the vertex spacing, so 45% of its amplitude was
 * per-vertex noise that averaged to a flat mid-grey at any range past ~8 m
 * while costing 20% of the model's value contrast. What is left is one coarse
 * octave that breaks up the fatigues in a knife fight and does not fight the
 * value structure at 30 m.
 *
 * ---------------------------------------------------------------------------
 * TEAMS
 * ---------------------------------------------------------------------------
 * Geometry is shared; the team lives in the material. Two per-vertex masks ride
 * in a `teamMask` attribute:
 *   .x  accent  — combat ID panels: helmet band, both brassards, chest and
 *                 shoulder panels. Replaced by the team colour in the shader and
 *                 given a little emissive so the team still reads in shade.
 *   .y  kit     — fatigues and armour, tinted per team so BRAVO reads dark olive
 *                 and ALPHA reads light sand. Value, not just hue, because value
 *                 is what survives 40 m and colour blindness.
 * Team colours are the HUD's own: --friend #63c8ff, --hostile #ff5a41
 * (src/ui/UiStyles.js). The chip on a man's shoulder is the same colour as his
 * dot on the minimap, which is the only way the association is free to learn.
 *
 * NOTE FOR THE MODULE OWNER: `createSoldierInstance(asset, team)` defaults to
 * team 1 (hostile), which is what every actor in AiModule is today. Friendly
 * bodies only need `createSoldierInstance(this.asset, a.team)` — or
 * `setSoldierTeam(inst, asset, team)` after the fact — and they will come out
 * light-sand with cyan panels. No geometry is duplicated either way.
 *
 * PROPORTIONS ARE UNCHANGED. BONE_DEFS, HITBOXES, MUZZLE_LOCAL and the capsule
 * are byte-for-byte what they were; Combat.js hit registration and headshot
 * geometry are unaffected. Nothing added here reaches outside a hitbox either:
 * the widest new part is the shoulder pad with its ID panel, whose outer face
 * is at x 0.292 m against the arm capsule's outer edge at 0.293 m (bone 0.205 +
 * offset 0.02 + radius 0.068). Every visible millimetre is still shootable.
 */

const HIP_Y = 0.87;                   // capsule centre height above the feet
const Y = (v) => v - HIP_Y;

/** name, parent, bind position (world, bind space), default tail direction. */
export const BONE_DEFS = [
  ['hips', null, [0, Y(0.94), 0]],
  ['spine', 'hips', [0, Y(1.10), 0]],
  ['chest', 'spine', [0, Y(1.28), 0]],
  ['neck', 'chest', [0, Y(1.48), 0.005]],
  ['head', 'neck', [0, Y(1.56), 0.01]],

  ['clavL', 'chest', [0.075, Y(1.42), 0]],
  ['armL', 'clavL', [0.205, Y(1.40), 0.005]],
  ['foreL', 'armL', [0.235, Y(1.115), 0.055]],
  ['handL', 'foreL', [0.245, Y(0.90), 0.195]],

  ['clavR', 'chest', [-0.075, Y(1.42), 0]],
  ['armR', 'clavR', [-0.205, Y(1.40), 0.005]],
  ['foreR', 'armR', [-0.235, Y(1.115), 0.055]],
  ['handR', 'foreR', [-0.245, Y(0.90), 0.195]],

  ['thighL', 'hips', [0.098, Y(0.90), 0]],
  ['shinL', 'thighL', [0.104, Y(0.49), 0.012]],
  ['footL', 'shinL', [0.106, Y(0.085), 0.005]],

  ['thighR', 'hips', [-0.098, Y(0.90), 0]],
  ['shinR', 'thighR', [-0.104, Y(0.49), 0.012]],
  ['footR', 'shinR', [-0.106, Y(0.085), 0.005]],
];

export const BONE_INDEX = new Map(BONE_DEFS.map((b, i) => [b[0], i]));

/** Muzzle crown, in the space of the right hand bone (see the carbine parts). */
export const MUZZLE_LOCAL = new THREE.Vector3(-0.002, 0.130, 0.725);

/**
 * Per-limb hitboxes, in the space of their bone. Damage multipliers come from
 * the weapon table via `limb`, so a leg hit costs the same here as it does when
 * the player is the one being shot.
 */
export const HITBOXES = [
  { bone: 'head', limb: 'head', offset: [0, 0.10, 0.01], radius: 0.125, half: 0.135 },
  { bone: 'neck', limb: 'neck', offset: [0, 0.04, 0], radius: 0.075, half: 0.085 },
  { bone: 'chest', limb: 'chest', offset: [0, 0.09, 0], radius: 0.185, half: 0.20 },
  { bone: 'spine', limb: 'stomach', offset: [0, 0.02, 0], radius: 0.165, half: 0.14 },
  { bone: 'hips', limb: 'stomach', offset: [0, -0.02, 0], radius: 0.155, half: 0.10 },
  { bone: 'armL', limb: 'arm', offset: [0.02, -0.14, 0.02], radius: 0.068, half: 0.15 },
  { bone: 'foreL', limb: 'arm', offset: [0.01, -0.10, 0.06], radius: 0.058, half: 0.13 },
  { bone: 'armR', limb: 'arm', offset: [-0.02, -0.14, 0.02], radius: 0.068, half: 0.15 },
  { bone: 'foreR', limb: 'arm', offset: [-0.01, -0.10, 0.06], radius: 0.058, half: 0.13 },
  { bone: 'thighL', limb: 'leg', offset: [0.005, -0.20, 0], radius: 0.088, half: 0.20 },
  { bone: 'shinL', limb: 'leg', offset: [0.002, -0.19, 0], radius: 0.070, half: 0.19 },
  { bone: 'thighR', limb: 'leg', offset: [-0.005, -0.20, 0], radius: 0.088, half: 0.20 },
  { bone: 'shinR', limb: 'leg', offset: [-0.002, -0.19, 0], radius: 0.070, half: 0.19 },
];

/* ------------------------------------------------------------------- teams */

/**
 * Team 0 = ALPHA (the player's side), team 1 = BRAVO (hostile).
 *
 * `accent` is the combat ID panel colour and matches the HUD.
 * `kit` multiplies the fatigues and armour: ALPHA is a light desert kit, BRAVO
 * a dark olive one, so the two sides differ in VALUE as well as hue. Measured
 * on the built geometry (front-facing triangles, area weighted): ALPHA sits at
 * 0.405 sRGB albedo, BRAVO at 0.301 — a 35% separation that still reads when
 * the figure is 40 px tall and the accent panels are down to a couple of
 * pixels. The panels themselves are 5.3% of the frontal area on both sides.
 */
export const TEAMS = {
  0: { name: 'ALPHA', accent: 0x63c8ff, accentGlow: 0.20, kit: [2.05, 1.92, 1.58] },
  1: { name: 'BRAVO', accent: 0xff5a41, accentGlow: 0.22, kit: [1.00, 1.00, 1.00] },
};

/** Sky-bounce rim. Tuned to read at 40 m without haloing at 3 m. */
const RIM = { color: 0x9dbad6, strength: 0.30, power: 3.6 };

/* ------------------------------------------------------------------ shared */

let _shared = null;

/** Build (once) the shared geometry + materials for every soldier. */
export function soldierAsset(detail = 2) {
  if (_shared) return _shared;

  const bind = computeBindPose();
  const builder = new PartBuilder(bind, detail);
  buildBody(builder, detail);

  const geometry = builder.finish();
  const byTeam = new Map();
  const asset = {
    geometry,
    bind,
    detail,
    /** Material set for a team, built on first use. */
    materialsFor(team) {
      const key = TEAMS[team] ? team : 1;
      let m = byTeam.get(key);
      if (!m) { m = buildMaterials(key); byTeam.set(key, m); }
      return m;
    },
    _byTeam: byTeam,
  };
  // Legacy field: the hostile set, which is what every actor uses today.
  asset.materials = asset.materialsFor(1);

  _shared = asset;
  return _shared;
}

export function disposeSoldierAsset() {
  if (!_shared) return;
  _shared.geometry.dispose();
  for (const set of _shared._byTeam.values()) for (const m of set) m.dispose();
  _shared = null;
}

/* --------------------------------------------------------------- materials */

/**
 * Three materials per team — cloth, hard gear, rubber — each patched with the
 * same small shader block:
 *
 *   1. team accent: `mix(albedo, uAccent, mask.x)`, plus a fraction of the
 *      accent added as emissive so an ID panel in shadow is still coloured
 *      rather than black. This is the only self-lit thing on the body.
 *   2. team kit tint: `albedo *= mix(1, uKit, mask.y)` — one multiply that
 *      turns the hostile kit into the friendly one.
 *   3. fresnel rim, added to `totalEmissiveRadiance` so it goes through the
 *      tonemapper like light rather than being pasted on afterwards.
 *
 * Everything rides on one extra vec2 attribute and five uniforms. No extra draw
 * calls, no extra materials beyond the second team's set, no texture.
 */
function buildMaterials(team) {
  const spec = TEAMS[team] || TEAMS[1];
  const mk = (opts) => patch(new THREE.MeshStandardMaterial({
    vertexColors: true, metalness: 0, roughness: 0.9, ...opts,
  }), spec, team);
  return [
    // Fatigues: dry cotton, no sheen.
    mk({ roughness: 0.94, metalness: 0.0, name: `botCloth${team}` }),
    // Hard gear: helmet shell, plates, buckles. Slight sheen, a touch of metal
    // so the rim light on a helmet reads at 40 m.
    mk({ roughness: 0.52, metalness: 0.20, name: `botGear${team}` }),
    // Rubber and leather: boots, gloves, sling. Darkest values in the frame.
    mk({ roughness: 0.70, metalness: 0.04, name: `botRubber${team}` }),
  ];
}

function patch(material, spec, team) {
  const accent = new THREE.Color(spec.accent);
  const rim = new THREE.Color(RIM.color);
  const uniforms = {
    uAccent: { value: accent },
    uAccentGlow: { value: spec.accentGlow },
    uKit: { value: new THREE.Vector3(...spec.kit) },
    uRim: { value: rim },
    uRimStrength: { value: RIM.strength },
    uRimPower: { value: RIM.power },
  };
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 teamMask;
        varying vec2 vTeamMask;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTeamMask = teamMask;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uAccent;
        uniform float uAccentGlow;
        uniform vec3 uKit;
        uniform vec3 uRim;
        uniform float uRimStrength;
        uniform float uRimPower;
        varying vec2 vTeamMask;`)
      // After <color_fragment>, diffuseColor already carries the vertex colour.
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // Keep the per-vertex grain on the ID panels: the panel's own vertex
          // colour is a neutral grey whose variation is exactly that grain.
          vec3 acc = uAccent * (0.80 + 0.55 * diffuseColor.g);
          diffuseColor.rgb = mix(diffuseColor.rgb, acc, vTeamMask.x);
          diffuseColor.rgb *= mix(vec3(1.0), uKit, vTeamMask.y);
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          float rimF = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
          rimF = pow(rimF, uRimPower);
          totalEmissiveRadiance += uRim * (rimF * uRimStrength);
          totalEmissiveRadiance += uAccent * (uAccentGlow * vTeamMask.x);
        }`);
  };
  // Force one program per team: the two sets differ only in uniform values, and
  // an identical cache key would be a bug magnet the day someone adds a define.
  material.customProgramCacheKey = () => `soldier-team-${team}`;
  return material;
}

/** Retint an already-built soldier for a different team. No geometry cost. */
export function setSoldierTeam(inst, asset, team) {
  const set = asset.materialsFor(team);
  inst.mesh.material = set;
  inst.team = team;
  return inst;
}

/** World-space bind positions for every bone, resolved from the hierarchy. */
function computeBindPose() {
  const pos = BONE_DEFS.map((b) => new THREE.Vector3().fromArray(b[2]));
  const children = BONE_DEFS.map(() => []);
  BONE_DEFS.forEach((b, i) => { if (b[1]) children[BONE_INDEX.get(b[1])].push(i); });

  // Tail = mean of children, or a continuation of the parent direction.
  const tail = pos.map((p, i) => {
    const ch = children[i];
    if (ch.length) {
      const t = new THREE.Vector3();
      for (const c of ch) t.add(pos[c]);
      return t.divideScalar(ch.length);
    }
    const parent = BONE_DEFS[i][1];
    if (parent) {
      const pp = pos[BONE_INDEX.get(parent)];
      return p.clone().add(p.clone().sub(pp).setLength(0.14));
    }
    return p.clone().add(new THREE.Vector3(0, 0.14, 0));
  });

  return { pos, tail, children };
}

/* ------------------------------------------------------------ construction */

/**
 * Accumulates transformed primitives into one non-indexed buffer, splitting
 * into three material groups and solving skin weights as it goes.
 */
class PartBuilder {
  constructor(bind, detail) {
    this.bind = bind;
    this.detail = detail;
    this.buckets = [[], [], []];     // one vertex-array set per material
    this._m3 = new THREE.Matrix3();
  }

  /**
   * @param geo    source BufferGeometry (consumed, disposed here)
   * @param mat    THREE.Matrix4 placing it in bind space
   * @param opts   { bone, group, colour, rigid, camo, wear, dust, accent, kit }
   */
  add(geo, mat, opts) {
    const bone = BONE_INDEX.get(opts.bone);
    const parent = BONE_DEFS[bone][1] != null ? BONE_INDEX.get(BONE_DEFS[bone][1]) : bone;
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (geo.index) geo.dispose();

    const src = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    this._m3.getNormalMatrix(mat);

    const head = this.bind.pos[bone];
    const tailV = this.bind.tail[bone];
    _axis.subVectors(tailV, head);
    const boneLen = Math.max(0.05, _axis.length());
    _axis.divideScalar(boneLen);

    // Every material group is a draw call *per shadow cascade* as well as in the
    // main pass, so below the top tiers the rubber group is folded into the hard
    // gear group: the roughness difference between a boot and a plate carrier is
    // not worth four extra shadow draws per bot.
    let group = opts.group ?? 0;
    if (this.detail < 2 && group === RUBBER) group = GEAR;
    const bucket = this.buckets[group];
    const base = new THREE.Color(opts.colour);
    const accent = opts.accent ? 1 : 0;
    const kit = opts.kit ? 1 : 0;

    for (let i = 0; i < src.count; i++) {
      _v.fromBufferAttribute(src, i).applyMatrix4(mat);
      _n.fromBufferAttribute(nrm, i).applyMatrix3(this._m3).normalize();

      // --- skinning -------------------------------------------------------
      let wp = 0;
      if (!opts.rigid && parent !== bone) {
        const s = _tmp.subVectors(_v, head).dot(_axis) / boneLen;
        // Soft falloff over the first quarter of the bone: half the influence
        // at the joint itself, none by 25% down the limb.
        wp = THREE.MathUtils.clamp(0.5 * (1 - s / 0.26), 0, 0.5);
      }

      // --- colour ---------------------------------------------------------
      _c.copy(base);
      if (opts.camo) applyCamo(_c, _v);
      if (opts.wear) {
        // Edge wear: upward-facing and outward faces of hard gear catch dust
        // and abrasion. Cheap ambient-occlusion-ish darkening in the creases.
        const up = THREE.MathUtils.clamp(_n.y, 0, 1);
        const dust = 0.08 * up;
        _c.r = _c.r * (1 - dust) + 0.30 * dust;
        _c.g = _c.g * (1 - dust) + 0.27 * dust;
        _c.b = _c.b * (1 - dust) + 0.21 * dust;
      }
      if (opts.dust) {
        // Ground dust climbs the boot and the shin. This is the value step that
        // stops the legs disappearing into their own shadow at the bottom of
        // the figure, which is where the eye looks for a stance.
        const h = THREE.MathUtils.clamp((0.42 - (_v.y + HIP_Y)) / 0.42, 0, 1);
        const d = h * h * 0.55;
        _c.r = _c.r * (1 - d) + 0.30 * d;
        _c.g = _c.g * (1 - d) + 0.255 * d;
        _c.b = _c.b * (1 - d) + 0.185 * d;
      }
      // Per-vertex value noise keeps large flat panels from reading as plastic.
      const grain = 0.92 + hash3(_v.x * 9.1, _v.y * 9.1, _v.z * 9.1) * 0.16;
      _c.multiplyScalar(grain);

      bucket.push(
        _v.x, _v.y, _v.z, _n.x, _n.y, _n.z, _c.r, _c.g, _c.b,
        bone, parent, wp, accent, kit,
      );
    }
    g.dispose();
  }

  finish() {
    const STRIDE = 14;
    let total = 0;
    for (const b of this.buckets) total += b.length / STRIDE;

    const position = new Float32Array(total * 3);
    const normal = new Float32Array(total * 3);
    const color = new Float32Array(total * 3);
    const teamMask = new Float32Array(total * 2);
    const skinIndex = new Uint16Array(total * 4);
    const skinWeight = new Float32Array(total * 4);
    const groups = [];

    let v = 0;
    for (let gi = 0; gi < this.buckets.length; gi++) {
      const bucket = this.buckets[gi];
      const start = v;
      for (let i = 0; i < bucket.length; i += STRIDE) {
        position[v * 3] = bucket[i]; position[v * 3 + 1] = bucket[i + 1]; position[v * 3 + 2] = bucket[i + 2];
        normal[v * 3] = bucket[i + 3]; normal[v * 3 + 1] = bucket[i + 4]; normal[v * 3 + 2] = bucket[i + 5];
        color[v * 3] = bucket[i + 6]; color[v * 3 + 1] = bucket[i + 7]; color[v * 3 + 2] = bucket[i + 8];
        const wp = bucket[i + 11];
        skinIndex[v * 4] = bucket[i + 9];
        skinIndex[v * 4 + 1] = bucket[i + 10];
        skinWeight[v * 4] = 1 - wp;
        skinWeight[v * 4 + 1] = wp;
        teamMask[v * 2] = bucket[i + 12];
        teamMask[v * 2 + 1] = bucket[i + 13];
        v++;
      }
      if (v > start) groups.push({ start, count: v - start, material: gi });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
    geo.setAttribute('teamMask', new THREE.BufferAttribute(teamMask, 2));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    for (const g of groups) geo.addGroup(g.start, g.count, g.material);
    geo.computeBoundingSphere();
    // The mesh never moves (the skeleton does), so the bounding sphere has to
    // cover wherever a bone may take it.
    geo.boundingSphere.radius = 3.2;
    return geo;
  }
}

const CLOTH = 0, GEAR = 1, RUBBER = 2;

/**
 * Values are quoted as approximate sRGB luminance, because that is the number
 * that decides whether a shape is visible against a background. The market's
 * lit sand measures ~0.50 and its shadows ~0.15, so the kit sits far below the
 * ground and the fatigues sit between the two.
 */
const PAL = {
  fatigue: 0x585440,        // 0.33 — mid olive, the body's main mass
  fatigueDark: 0x413f31,    // 0.25 — pack and shorts of the trouser
  plate: 0x1e2019,          // 0.12 — armour: the dark that reads against sand
  helmet: 0x262820,         // 0.15
  webbing: 0x4a4736,        // 0.28
  boot: 0x121110,           // 0.07
  glove: 0x1b1917,          // 0.10
  skin: 0x8a6a51,           // the one warm note; a face reads as a person
  lens: 0x121d19,
  panel: 0x8b8b8b,          // neutral base under the team accent (see patch())
  steel: 0x2b2c28,
};

function buildBody(B, detail) {
  const seg = detail >= 2 ? 3 : 2;
  const cylSeg = detail >= 2 ? 10 : 7;
  const hi = detail >= 2;

  /* --- torso ------------------------------------------------------------- */
  // Ribcage tapers to the waist: two stacked rounded boxes read as a torso far
  // better than one, and cost 40 triangles.
  B.add(rbox(0.40, 0.26, 0.23, 0.055, seg), place(0, Y(1.31), 0.005),
    { bone: 'chest', colour: PAL.fatigue, camo: true, rigid: true, group: CLOTH, kit: true });
  B.add(rbox(0.345, 0.24, 0.205, 0.05, seg), place(0, Y(1.10), 0),
    { bone: 'spine', colour: PAL.fatigue, camo: true, group: CLOTH, kit: true });
  B.add(rbox(0.33, 0.19, 0.20, 0.05, seg), place(0, Y(0.925), 0),
    { bone: 'hips', colour: PAL.fatigue, camo: true, group: CLOTH, kit: true });

  /* --- plate carrier ----------------------------------------------------- */
  B.add(rbox(0.335, 0.40, 0.075, 0.028, seg), place(0, Y(1.24), 0.115),
    { bone: 'chest', colour: PAL.plate, wear: true, rigid: true, group: GEAR, kit: true });
  B.add(rbox(0.335, 0.42, 0.07, 0.028, seg), place(0, Y(1.25), -0.11),
    { bone: 'chest', colour: PAL.plate, wear: true, rigid: true, group: GEAR, kit: true });
  // Cummerbund tying the two plates together.
  B.add(rbox(0.30, 0.11, 0.245, 0.03, 2), place(0, Y(1.09), 0.005),
    { bone: 'spine', colour: PAL.webbing, wear: true, group: GEAR, kit: true });

  // Shoulder yoke. The old version was a strap; this is a squared pad sitting on
  // the deltoid, because the single strongest "man in armour" cue at 40 px is a
  // straight, hard shoulder line above a narrow waist. The pad's outer face is
  // at 0.285 m — 12 mm outside the arm hitbox capsule and nothing more.
  for (const s of [1, -1]) {
    B.add(rbox(0.115, 0.075, 0.235, 0.026, 2), place(s * 0.2275, Y(1.436), 0.0),
      { bone: 'chest', colour: PAL.plate, wear: true, rigid: true, group: GEAR, kit: true });
    // Combat ID panel on the OUTER face of the pad — the face that is square-on
    // to another standing man, which is the only one that pays at 25 m. A panel
    // on TOP of the shoulder was tried and removed: at eye level it is
    // foreshortened to nothing, and the only place it showed was a four-metre
    // close-up, where it made the man look like he was wearing a bib.
    B.add(rbox(0.018, 0.062, 0.20, 0.008, 1), place(s * 0.283, Y(1.436), 0.0),
      { bone: 'chest', colour: PAL.panel, rigid: true, group: GEAR, accent: true });
    B.add(rbox(0.055, 0.07, 0.245, 0.02, 2), place(s * 0.135, Y(1.452), 0.0),
      { bone: 'chest', colour: PAL.webbing, rigid: true, group: GEAR, kit: true });
  }

  // Magazine pouches, front, in a row — the silhouette everyone reads as "kit".
  for (let i = 0; i < 3; i++) {
    B.add(rbox(0.082, 0.135, 0.07, 0.018, 2), place((i - 1) * 0.095, Y(1.115), 0.155),
      { bone: 'spine', colour: PAL.webbing, wear: true, rigid: true, group: GEAR, kit: true });
  }
  // Chest ID panel above the mag pouches.
  B.add(rbox(0.175, 0.100, 0.03, 0.012, 1), place(0.0, Y(1.30), 0.158),
    { bone: 'chest', colour: PAL.panel, rigid: true, group: GEAR, accent: true });

  // Radio on the left rear, with a whip antenna. The antenna is 3 mm of geometry
  // that adds 0.34 m of vertical silhouette — the cheapest read on the model.
  B.add(rbox(0.09, 0.15, 0.06, 0.016, 2), place(0.12, Y(1.20), -0.145),
    { bone: 'chest', colour: PAL.boot, rigid: true, group: RUBBER });
  B.add(new THREE.CylinderGeometry(0.007, 0.004, 0.40, 5), tilt(0.12, Y(1.47), -0.145, 0.24, 0, 0.08),
    { bone: 'chest', colour: PAL.boot, rigid: true, group: RUBBER });
  // Belt and a canteen on the right hip.
  B.add(rbox(0.345, 0.055, 0.215, 0.02, 2), place(0, Y(0.955), 0),
    { bone: 'hips', colour: PAL.webbing, wear: true, group: GEAR, kit: true });
  B.add(rbox(0.07, 0.12, 0.065, 0.02, 2), place(-0.17, Y(0.925), -0.04),
    { bone: 'hips', colour: PAL.webbing, rigid: true, group: GEAR, kit: true });
  // Dump pouch on the left hip: widens the waist outline on the other side, so
  // the figure is not symmetrical — asymmetry is what stops a walking man
  // reading as a lamppost.
  B.add(rbox(0.075, 0.135, 0.10, 0.03, 2), place(0.175, Y(0.90), -0.02),
    { bone: 'hips', colour: PAL.fatigueDark, rigid: true, group: CLOTH, kit: true });

  // Daypack with a rolled mat lashed across the top.
  B.add(rbox(0.30, 0.32, 0.145, 0.05, seg), place(0, Y(1.245), -0.19),
    { bone: 'chest', colour: PAL.fatigueDark, camo: true, rigid: true, group: CLOTH, kit: true });
  B.add(new THREE.CylinderGeometry(0.055, 0.055, 0.30, hi ? 8 : 6),
    tilt(0, Y(1.41), -0.205, 0, 0, Math.PI / 2),
    { bone: 'chest', colour: PAL.webbing, rigid: true, group: CLOTH, kit: true });

  /* --- head -------------------------------------------------------------- */
  // Balaclava'd head: a squashed sphere, so the helmet has something to sit on.
  B.add(sphere(0.098, hi ? 12 : 8, hi ? 9 : 6, [1, 1.12, 1.06]),
    place(0, Y(1.655), 0.005),
    { bone: 'head', colour: PAL.glove, rigid: true, group: CLOTH });
  // Jaw / face plane, so the head is not a ball.
  B.add(rbox(0.115, 0.085, 0.10, 0.03, 2), place(0, Y(1.605), 0.055),
    { bone: 'head', colour: PAL.skin, rigid: true, group: CLOTH });
  // Helmet: hemisphere with the bottom cut, plus a brim and a rail.
  B.add(sphere(0.135, hi ? 16 : 10, hi ? 8 : 5, [1, 0.92, 1.05], Math.PI * 0.56),
    place(0, Y(1.685), 0.004),
    { bone: 'head', colour: PAL.helmet, wear: true, rigid: true, group: GEAR, kit: true });
  B.add(new THREE.TorusGeometry(0.132, 0.014, 4, hi ? 16 : 10),
    tilt(0, Y(1.685), 0.004, Math.PI / 2, 0, 0),
    { bone: 'head', colour: PAL.helmet, wear: true, rigid: true, group: GEAR, kit: true });
  // Helmet band in the team colour, sitting just above the brim. A 20 mm band
  // is a pixel at 50 m and three at 25 m, but it is a pixel right beside the
  // head, which is the part of the silhouette a player is already fixated on.
  B.add(new THREE.TorusGeometry(0.1295, 0.0175, 4, hi ? 14 : 9),
    tilt(0, Y(1.714), 0.004, Math.PI / 2, 0, 0),
    { bone: 'head', colour: PAL.panel, rigid: true, group: GEAR, accent: true });
  // Rear counterweight pouch: breaks the back of the helmet so the head is not
  // a sphere in profile, which is the difference between "helmet" and "bald".
  B.add(rbox(0.10, 0.07, 0.06, 0.022, 1), place(0, Y(1.70), -0.115),
    { bone: 'head', colour: PAL.boot, rigid: true, group: RUBBER });
  // NVG mount and side rails — the shapes that make a helmet read as a helmet.
  B.add(rbox(0.048, 0.055, 0.045, 0.012, 1), place(0, Y(1.735), 0.125),
    { bone: 'head', colour: PAL.boot, rigid: true, group: RUBBER });
  for (const s of [1, -1]) {
    B.add(rbox(0.012, 0.026, 0.16, 0.005, 1), place(s * 0.128, Y(1.695), 0.0),
      { bone: 'head', colour: PAL.boot, rigid: true, group: RUBBER });
  }
  // Goggles across the brow.
  B.add(rbox(0.20, 0.048, 0.055, 0.018, 2), place(0, Y(1.655), 0.088),
    { bone: 'head', colour: PAL.lens, rigid: true, group: GEAR });

  /* --- arms -------------------------------------------------------------- */
  for (const s of [1, -1]) {
    const L = s > 0 ? 'L' : 'R';
    B.add(sphere(0.082, cylSeg, 6, [1, 0.9, 1]), place(s * 0.195, Y(1.415), 0.005),
      { bone: `arm${L}`, colour: PAL.fatigue, camo: true, rigid: true, group: CLOTH, kit: true });
    B.add(limb(0.072, 0.058, 0.30, cylSeg), between(
      [s * 0.205, Y(1.40), 0.005], [s * 0.235, Y(1.115), 0.055]),
      { bone: `arm${L}`, colour: PAL.fatigue, camo: true, group: CLOTH, kit: true });
    // Brassard: the team colour on the upper arm, where it is visible from the
    // front, the side and the back. Two of these plus the shoulder panels are
    // the accent area that has to survive 25 m.
    B.add(limb(0.081, 0.073, 0.115, cylSeg), between(
      [s * 0.212, Y(1.350), 0.018], [s * 0.220, Y(1.240), 0.036]),
      { bone: `arm${L}`, colour: PAL.panel, rigid: true, group: CLOTH, accent: true });
    B.add(limb(0.058, 0.047, 0.235, cylSeg), between(
      [s * 0.235, Y(1.115), 0.055], [s * 0.245, Y(0.90), 0.195]),
      { bone: `fore${L}`, colour: PAL.fatigue, camo: true, group: CLOTH, kit: true });
    // Elbow pad.
    B.add(rbox(0.085, 0.09, 0.085, 0.03, 2), place(s * 0.238, Y(1.115), 0.058),
      { bone: `fore${L}`, colour: PAL.plate, wear: true, rigid: true, group: GEAR, kit: true });
    // Glove.
    B.add(rbox(0.062, 0.10, 0.085, 0.024, 2), place(s * 0.247, Y(0.875), 0.215),
      { bone: `hand${L}`, colour: PAL.glove, rigid: true, group: RUBBER });
  }

  /* --- carbine ----------------------------------------------------------- */
  // Rigidly skinned to the right hand, so it costs no extra draw call and the
  // arms drive it exactly like a real rig would. The barrel is NOT moved:
  // MUZZLE_LOCAL is measured off it and the tracer/flash origins key on that.
  const gx = -0.247, gy = Y(0.955), gz = 0.30;
  B.add(rbox(0.052, 0.085, 0.44, 0.014, 2), place(gx, gy + 0.055, gz + 0.02),
    { bone: 'handR', colour: PAL.steel, rigid: true, wear: true, group: GEAR });
  B.add(new THREE.CylinderGeometry(0.011, 0.0125, 0.40, 6),
    tilt(gx, gy + 0.075, gz + 0.42, Math.PI / 2, 0, 0),
    { bone: 'handR', colour: 0x1e1f1d, rigid: true, wear: true, group: GEAR });
  // Handguard, magazine, stock, optic — the four shapes that make a carbine.
  B.add(rbox(0.046, 0.056, 0.30, 0.016, 2), place(gx, gy + 0.072, gz + 0.36),
    { bone: 'handR', colour: 0x33342e, rigid: true, group: GEAR });
  B.add(rbox(0.032, 0.16, 0.075, 0.012, 2), tilt(gx, gy - 0.03, gz - 0.03, -0.16, 0, 0),
    { bone: 'handR', colour: 0x26271f, rigid: true, group: GEAR });
  B.add(rbox(0.044, 0.095, 0.20, 0.02, 2), place(gx, gy + 0.045, gz - 0.20),
    { bone: 'handR', colour: 0x2a2b26, rigid: true, group: RUBBER });
  // Optic: a taller block than before. The top line of a carbine is what makes
  // the weapon read as held rather than as an arm.
  B.add(rbox(0.038, 0.062, 0.085, 0.012, 1), place(gx, gy + 0.132, gz + 0.10),
    { bone: 'handR', colour: 0x1b1c1a, rigid: true, group: RUBBER });

  /* --- legs -------------------------------------------------------------- */
  for (const s of [1, -1]) {
    const L = s > 0 ? 'L' : 'R';
    B.add(limb(0.098, 0.078, 0.42, cylSeg), between(
      [s * 0.098, Y(0.90), 0], [s * 0.104, Y(0.49), 0.012]),
      { bone: `thigh${L}`, colour: PAL.fatigue, camo: true, group: CLOTH, kit: true });
    // Cargo pocket on the OUTER FACE of the thigh. Authored at x 0.128 first,
    // which put it entirely inside a leg that spans 0.012..0.190 — 24 triangles
    // of buried geometry. At 0.170 it stands 12 mm proud of the thigh and puts
    // a hard vertical edge on the outside of the leg, so the legs read as two
    // shapes rather than two cylinders when they cross in a stride.
    B.add(rbox(0.052, 0.155, 0.115, 0.020, 1), place(s * 0.170, Y(0.735), 0.012),
      { bone: `thigh${L}`, colour: PAL.fatigueDark, rigid: true, group: CLOTH, kit: true });
    B.add(limb(0.078, 0.060, 0.41, cylSeg), between(
      [s * 0.104, Y(0.49), 0.012], [s * 0.106, Y(0.085), 0.005]),
      { bone: `shin${L}`, colour: PAL.fatigue, camo: true, dust: true, group: CLOTH, kit: true });
    // Knee pad.
    B.add(rbox(0.10, 0.11, 0.095, 0.032, 2), place(s * 0.104, Y(0.485), 0.045),
      { bone: `shin${L}`, colour: PAL.plate, wear: true, rigid: true, group: GEAR, kit: true });
    // Boot: upper, then a wider sole so the foot has a ground plane.
    B.add(rbox(0.098, 0.115, 0.135, 0.028, 2), place(s * 0.106, Y(0.105), 0.012),
      { bone: `foot${L}`, colour: PAL.boot, dust: true, rigid: true, group: RUBBER });
    B.add(rbox(0.108, 0.055, 0.245, 0.022, 2), place(s * 0.106, Y(0.032), 0.045),
      { bone: `foot${L}`, colour: PAL.boot, dust: true, rigid: true, group: RUBBER });
  }
}

/* -------------------------------------------------------------- primitives */

/** Rounded box: a box grid projected onto the Minkowski sum of box and sphere. */
function rbox(w, h, d, r, seg = 2) {
  const geo = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const pos = geo.getAttribute('position');
  const ax = Math.max(1e-4, w * 0.5 - r);
  const ay = Math.max(1e-4, h * 0.5 - r);
  const az = Math.max(1e-4, d * 0.5 - r);
  const v = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    q.set(
      THREE.MathUtils.clamp(v.x, -ax, ax),
      THREE.MathUtils.clamp(v.y, -ay, ay),
      THREE.MathUtils.clamp(v.z, -az, az),
    );
    v.sub(q);
    const len = v.length();
    if (len > 1e-6) v.multiplyScalar(r / len);
    pos.setXYZ(i, q.x + v.x, q.y + v.y, q.z + v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function sphere(r, wSeg, hSeg, scale = [1, 1, 1], thetaLength = Math.PI) {
  const geo = new THREE.SphereGeometry(r, wSeg, hSeg, 0, Math.PI * 2, 0, thetaLength);
  geo.scale(scale[0], scale[1], scale[2]);
  return geo;
}

/** A tapered limb segment, capped, oriented along +Y before placement. */
function limb(r0, r1, len, seg) {
  return new THREE.CylinderGeometry(r1, r0, len, seg, 1, false);
}

function place(x, y, z) { return _m.makeTranslation(x, y, z).clone(); }

function tilt(x, y, z, rx, ry, rz) {
  const m = new THREE.Matrix4();
  m.makeRotationFromEuler(new THREE.Euler(rx, ry, rz));
  m.setPosition(x, y, z);
  return m;
}

/** Place a +Y aligned primitive so it spans from a to b. */
function between(a, b) {
  const A = new THREE.Vector3().fromArray(a);
  const Bv = new THREE.Vector3().fromArray(b);
  const dir = new THREE.Vector3().subVectors(Bv, A);
  const len = dir.length() || 1e-4;
  dir.divideScalar(len);
  const q = new THREE.Quaternion().setFromUnitVectors(_up, dir);
  const mid = A.clone().addScaledVector(dir, len * 0.5);
  return new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
}

/* ------------------------------------------------------------------ colour */

/**
 * Coarse disruptive breakup — ONE octave, at 2.6 cycles/m (a 38 cm blob).
 *
 * The mesh's median edge is 51 mm, so anything above ~10 cycles/m is below the
 * sampling rate and lands as per-vertex noise instead of a pattern. The old
 * three-octave version spent 45% of its amplitude there, which cost value
 * contrast and bought a grey haze. This octave is coarse enough to survive
 * being sampled at the vertices and to still be a pattern at 10 m, and the
 * blend is 0.55 rather than 0.82 so the fatigues keep one coherent value at 30.
 */
const CAMO = [
  new THREE.Color(0x5f5b44), new THREE.Color(0x45432f),
  new THREE.Color(0x6d6850), new THREE.Color(0x35331f),
];

function applyCamo(c, v) {
  const n = value3(v.x * 2.6, v.y * 2.0, v.z * 2.6) * 0.72
    + value3(v.x * 6.2 + 4.1, v.y * 5.4, v.z * 6.2) * 0.28;
  const idx = Math.min(CAMO.length - 1, Math.floor(n * CAMO.length));
  const pick = CAMO[idx];
  c.lerp(pick, 0.55);
}

function hash3(x, y, z) {
  let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  h -= Math.floor(h);
  return h;
}

function value3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const c000 = hash3(ix, iy, iz), c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz), c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1), c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1), c111 = hash3(ix + 1, iy + 1, iz + 1);
  const x00 = c000 + (c100 - c000) * ux, x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux, x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy, y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

/* ------------------------------------------------------------- temporaries */

const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();
const _axis = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/* -------------------------------------------------------------- instancing */

/**
 * One bot's skeleton. The SkinnedMesh stays at the identity transform in world
 * space and the *rig* moves — that keeps `bindMatrix` identity and makes the
 * ragdoll trivial, because writing a bone's local transform writes its world
 * transform whenever the rig is reset to identity.
 *
 * @param team 0 ALPHA (friendly) | 1 BRAVO (hostile, default)
 */
export function createSoldierInstance(asset, team = 1) {
  const bones = [];
  for (let i = 0; i < BONE_DEFS.length; i++) {
    const [name, parentName, p] = BONE_DEFS[i];
    const bone = new THREE.Bone();
    bone.name = name;
    if (parentName) {
      const parent = bones[BONE_INDEX.get(parentName)];
      const pp = asset.bind.pos[BONE_INDEX.get(parentName)];
      bone.position.set(p[0] - pp.x, p[1] - pp.y, p[2] - pp.z);
      parent.add(bone);
    } else {
      bone.position.set(p[0], p[1], p[2]);
    }
    bones.push(bone);
  }

  const rig = new THREE.Group();
  rig.name = 'BotRig';
  rig.add(bones[0]);
  rig.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(bones);
  const mesh = new THREE.SkinnedMesh(asset.geometry, asset.materialsFor(team));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  // Identity bind matrix: the geometry is authored in the same space the bones
  // occupy when the rig sits at the origin.
  mesh.bind(skeleton, new THREE.Matrix4());

  const byName = new Map();
  bones.forEach((b) => byName.set(b.name, b));

  // Rest pose is captured so locomotion can express itself as offsets from the
  // bind pose rather than as absolute transforms.
  const rest = bones.map((b) => ({
    p: b.position.clone(), q: b.quaternion.clone(),
  }));

  return { rig, mesh, skeleton, bones, byName, rest, team };
}
