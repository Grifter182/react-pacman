import * as THREE from 'three';
import { LAYER, P, resetP } from './ParticleSystem.js';
import { PT, DT } from './FxTextures.js';

/**
 * OWNER: VFX agent.
 *
 * Surface response for a bullet impact. The 'hit:surface' event carries the
 * material preset the round landed on, and that name selects a recipe here:
 * concrete throws pulverised dust and spall, steel throws a shower of burning
 * particles that arc under gravity and light the wall for a frame, sand plumes
 * and never sparks, wood throws splinters that tumble, glass throws shards and
 * a scatter of glints, water splashes and leaves nothing behind.
 *
 * A recipe is data: a decal description plus a list of burst specs. The emitter
 * below is the only code that reads them, so adding a surface is adding a row.
 */

const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (r) => (Array.isArray(r) ? rnd(r[0], r[1]) : r);

/* ------------------------------------------------------------- recipes */

/**
 * Burst spec fields (all optional except tile/count):
 *   tile, count, speed, cone, life, size0, size1, drag, gravity, turbulence,
 *   lit, stretch, spin, alpha, fade, soft, colorA, colorB, additive, offset
 */
const DUST_GREY = [0.62, 0.60, 0.575];
const DUST_PALE = [0.82, 0.80, 0.76];
const SPARK_HOT = [4.5, 2.3, 0.7];
const SPARK_COOL = [1.4, 0.28, 0.05];

const CONCRETE = {
  decal: { tile: DT.CONCRETE, size: [0.075, 0.115], tint: [0.85, 0.84, 0.82], life: 110 },
  sound: 'impact_concrete',
  bursts: [
    // Pulverised cement — the loud part of the effect, gone in a second.
    {
      tile: PT.SPALL, count: [5, 8], speed: [1.1, 3.4], cone: 0.85, life: [0.45, 0.95],
      size0: [0.035, 0.07], size1: 4.2, drag: 3.6, gravity: 0.12, turbulence: 0.35,
      lit: 1, spin: 2.2, alpha: 0.62, fade: 1.5, soft: 0.35,
      colorA: DUST_PALE, colorB: DUST_GREY,
    },
    // The cloud that hangs behind it.
    {
      tile: PT.SMOKE, count: [2, 3], speed: [0.3, 0.9], cone: 1.0, life: [1.2, 2.2],
      size0: [0.08, 0.14], size1: 3.4, drag: 2.2, gravity: -0.02, turbulence: 0.22,
      lit: 1, spin: 0.7, alpha: 0.3, fade: 1.9, soft: 0.5,
      colorA: DUST_GREY, colorB: [0.5, 0.49, 0.48],
    },
    // Chips with real ballistic arcs.
    {
      tile: PT.CHIP, count: [4, 8], speed: [2.2, 6.5], cone: 1.15, life: [0.5, 1.1],
      size0: [0.012, 0.026], size1: 1.0, drag: 0.35, gravity: 1.0, turbulence: 0,
      lit: 1, spin: 9, alpha: 1, fade: 0.6, soft: 0.1,
      colorA: [0.55, 0.54, 0.52], colorB: [0.42, 0.41, 0.40],
    },
  ],
};

const METAL = {
  decal: { tile: DT.METAL, size: [0.045, 0.07], tint: [0.9, 0.9, 0.92], life: 120 },
  sound: 'impact_metal',
  light: { color: 0xffb060, intensity: 7, radius: 3.2, life: 0.10 },
  bursts: [
    // Burning steel fragments: fast, stretched, arcing, cooling to red.
    {
      tile: PT.SPARK, count: [10, 18], speed: [3.0, 11.0], cone: 1.25, life: [0.22, 0.75],
      size0: [0.008, 0.016], size1: 0.35, drag: 1.1, gravity: 1.0, turbulence: 0.1,
      stretch: 0.026, alpha: 1, fade: 1.1, soft: 0, additive: true,
      colorA: SPARK_HOT, colorB: SPARK_COOL,
    },
    // A couple of long ricochet streaks that outrun the rest.
    {
      tile: PT.SPARK, count: [1, 3], speed: [9.0, 16.0], cone: 0.9, life: [0.35, 0.6],
      size0: [0.010, 0.014], size1: 0.3, drag: 0.55, gravity: 1.0,
      stretch: 0.05, alpha: 1, fade: 0.9, soft: 0, additive: true,
      colorA: SPARK_HOT, colorB: SPARK_COOL,
    },
    // Vaporised paint and oil.
    {
      tile: PT.SMOKE, count: [1, 2], speed: [0.4, 1.2], cone: 0.8, life: [0.5, 1.0],
      size0: [0.03, 0.06], size1: 3.0, drag: 3.0, gravity: -0.05, turbulence: 0.3,
      lit: 0.6, alpha: 0.22, fade: 1.6, soft: 0.4,
      colorA: [0.32, 0.31, 0.30], colorB: [0.22, 0.22, 0.22],
    },
  ],
};

const WOOD = {
  decal: { tile: DT.WOOD, size: [0.07, 0.10], tint: [0.9, 0.78, 0.58], life: 110 },
  sound: 'impact_wood',
  bursts: [
    {
      tile: PT.SPLINTER, count: [5, 10], speed: [2.0, 6.0], cone: 1.1, life: [0.6, 1.3],
      size0: [0.02, 0.05], size1: 1.0, drag: 0.9, gravity: 1.0,
      lit: 1, spin: 14, alpha: 1, fade: 0.7, soft: 0.1,
      colorA: [0.72, 0.54, 0.32], colorB: [0.48, 0.35, 0.20],
    },
    {
      tile: PT.DUST, count: [3, 5], speed: [0.6, 2.0], cone: 0.9, life: [0.6, 1.3],
      size0: [0.03, 0.07], size1: 3.2, drag: 3.4, gravity: 0.1, turbulence: 0.3,
      lit: 1, alpha: 0.42, fade: 1.6, soft: 0.4,
      colorA: [0.76, 0.62, 0.42], colorB: [0.55, 0.45, 0.32],
    },
  ],
};

const SAND = {
  decal: { tile: DT.SAND, size: [0.13, 0.20], tint: [0.95, 0.86, 0.66], life: 45 },
  sound: 'impact_sand',
  bursts: [
    // A plume, not a puff: dry sand keeps going up after the round has stopped.
    {
      tile: PT.DUST, count: [7, 11], speed: [1.4, 4.0], cone: 0.7, life: [0.9, 1.9],
      size0: [0.05, 0.10], size1: 4.5, drag: 2.4, gravity: 0.16, turbulence: 0.45,
      lit: 1, spin: 1.2, alpha: 0.5, fade: 1.5, soft: 0.45,
      colorA: [0.92, 0.82, 0.62], colorB: [0.74, 0.66, 0.50],
    },
    {
      tile: PT.CHIP, count: [4, 8], speed: [2.0, 5.0], cone: 1.0, life: [0.4, 0.9],
      size0: [0.008, 0.018], size1: 1.0, drag: 0.5, gravity: 1.0,
      lit: 1, spin: 6, alpha: 0.9, fade: 0.8, soft: 0.1,
      colorA: [0.86, 0.76, 0.56], colorB: [0.70, 0.62, 0.46],
    },
  ],
};

const GLASS = {
  decal: { tile: DT.GLASS, size: [0.12, 0.19], tint: [0.9, 0.95, 1.0], life: 130 },
  sound: 'impact_glass',
  bursts: [
    {
      tile: PT.GLASS, count: [6, 12], speed: [1.6, 5.5], cone: 1.2, life: [0.7, 1.5],
      size0: [0.012, 0.030], size1: 1.0, drag: 0.6, gravity: 1.0,
      lit: 1, spin: 12, alpha: 1, fade: 0.7, soft: 0.1,
      colorA: [0.80, 0.90, 0.98], colorB: [0.60, 0.72, 0.82],
    },
    // Glints: shards catching the sun as they tumble, not sparks.
    {
      tile: PT.SPARK, count: [4, 8], speed: [1.5, 5.0], cone: 1.2, life: [0.35, 0.8],
      size0: [0.010, 0.020], size1: 0.4, drag: 0.6, gravity: 1.0,
      alpha: 0.8, fade: 1.4, soft: 0, additive: true,
      colorA: [1.5, 1.9, 2.4], colorB: [0.3, 0.4, 0.5],
    },
  ],
};

const PLASTER = {
  decal: { tile: DT.PLASTER, size: [0.09, 0.14], tint: [0.95, 0.94, 0.92], life: 110 },
  sound: 'impact_plaster',
  bursts: [
    {
      tile: PT.SMOKE, count: [5, 8], speed: [0.9, 2.8], cone: 0.95, life: [0.8, 1.7],
      size0: [0.05, 0.10], size1: 4.0, drag: 3.0, gravity: 0.05, turbulence: 0.35,
      lit: 1, alpha: 0.6, fade: 1.5, soft: 0.45,
      colorA: [0.96, 0.95, 0.93], colorB: [0.78, 0.77, 0.75],
    },
    {
      tile: PT.CHIP, count: [3, 6], speed: [1.8, 4.5], cone: 1.1, life: [0.5, 1.0],
      size0: [0.010, 0.024], size1: 1.0, drag: 0.4, gravity: 1.0,
      lit: 1, spin: 8, alpha: 1, fade: 0.7, soft: 0.1,
      colorA: [0.92, 0.91, 0.89], colorB: [0.72, 0.71, 0.70],
    },
  ],
};

const BRICK = {
  decal: { tile: DT.BRICK, size: [0.075, 0.115], tint: [0.95, 0.72, 0.58], life: 110 },
  sound: 'impact_brick',
  bursts: [
    {
      tile: PT.SPALL, count: [5, 8], speed: [1.2, 3.6], cone: 0.9, life: [0.5, 1.1],
      size0: [0.035, 0.07], size1: 4.0, drag: 3.4, gravity: 0.12, turbulence: 0.3,
      lit: 1, spin: 2, alpha: 0.6, fade: 1.5, soft: 0.35,
      colorA: [0.80, 0.55, 0.42], colorB: [0.58, 0.42, 0.34],
    },
    {
      tile: PT.CHIP, count: [4, 7], speed: [2.4, 6.0], cone: 1.15, life: [0.5, 1.0],
      size0: [0.012, 0.026], size1: 1.0, drag: 0.35, gravity: 1.0,
      lit: 1, spin: 10, alpha: 1, fade: 0.6, soft: 0.1,
      colorA: [0.66, 0.40, 0.30], colorB: [0.44, 0.28, 0.22],
    },
  ],
};

const FABRIC = {
  decal: { tile: DT.FABRIC, size: [0.05, 0.08], tint: [0.8, 0.78, 0.74], life: 90 },
  sound: 'impact_fabric',
  bursts: [
    {
      tile: PT.DUST, count: [3, 5], speed: [0.5, 1.6], cone: 0.9, life: [0.5, 1.1],
      size0: [0.03, 0.06], size1: 2.8, drag: 3.6, gravity: 0.08, turbulence: 0.28,
      lit: 1, alpha: 0.35, fade: 1.7, soft: 0.4,
      colorA: [0.72, 0.68, 0.60], colorB: [0.55, 0.52, 0.46],
    },
  ],
};

const WATER = {
  decal: null,
  sound: 'impact_water',
  bursts: [
    // Crown of droplets straight up the normal, then a fine mist.
    {
      tile: PT.WATER, count: [10, 16], speed: [2.0, 5.5], cone: 0.55, life: [0.4, 0.9],
      size0: [0.012, 0.030], size1: 0.8, drag: 0.5, gravity: 1.0,
      lit: 1, alpha: 0.85, fade: 1.0, soft: 0.1,
      colorA: [0.78, 0.88, 0.95], colorB: [0.55, 0.68, 0.78],
    },
    {
      tile: PT.SMOKE, count: [2, 4], speed: [0.4, 1.4], cone: 0.9, life: [0.5, 1.0],
      size0: [0.04, 0.09], size1: 3.0, drag: 3.4, gravity: 0.1, turbulence: 0.3,
      lit: 1, alpha: 0.25, fade: 1.8, soft: 0.4,
      colorA: [0.86, 0.92, 0.96], colorB: [0.70, 0.78, 0.84],
    },
    {
      tile: PT.RING, count: 1, speed: 0, cone: 0, life: 0.55,
      size0: 0.08, size1: 7.0, drag: 0, gravity: 0,
      lit: 1, alpha: 0.5, fade: 1.6, soft: 0.15,
      colorA: [0.85, 0.92, 0.98], colorB: [0.6, 0.7, 0.8],
    },
  ],
};

const FLESH = {
  decal: { tile: DT.BLOOD, size: [0.10, 0.18], tint: [0.9, 0.15, 0.12], life: 40 },
  sound: 'impact_flesh',
  bursts: [
    {
      tile: PT.BLOOD, count: [8, 14], speed: [1.2, 4.5], cone: 1.0, life: [0.45, 1.0],
      size0: [0.012, 0.035], size1: 1.2, drag: 1.2, gravity: 1.0,
      lit: 1, spin: 5, alpha: 0.95, fade: 1.0, soft: 0.1,
      colorA: [0.65, 0.05, 0.04], colorB: [0.32, 0.03, 0.03],
    },
    // Airborne mist — the part that reads at distance.
    {
      tile: PT.SMOKE, count: [3, 5], speed: [0.6, 2.0], cone: 0.9, life: [0.35, 0.8],
      size0: [0.05, 0.11], size1: 2.4, drag: 4.0, gravity: 0.05, turbulence: 0.25,
      lit: 1, alpha: 0.34, fade: 1.8, soft: 0.35,
      colorA: [0.48, 0.06, 0.05], colorB: [0.24, 0.03, 0.03],
    },
  ],
};

const ASPHALT = {
  decal: { tile: DT.CONCRETE, size: [0.07, 0.11], tint: [0.42, 0.42, 0.44], life: 90 },
  sound: 'impact_asphalt',
  bursts: [
    {
      tile: PT.SPALL, count: [4, 7], speed: [1.0, 3.0], cone: 0.9, life: [0.4, 0.9],
      size0: [0.03, 0.06], size1: 3.6, drag: 3.6, gravity: 0.12, turbulence: 0.3,
      lit: 1, spin: 2, alpha: 0.5, fade: 1.5, soft: 0.35,
      colorA: [0.38, 0.37, 0.36], colorB: [0.26, 0.26, 0.26],
    },
    {
      tile: PT.CHIP, count: [3, 6], speed: [2.0, 5.0], cone: 1.1, life: [0.4, 0.9],
      size0: [0.010, 0.022], size1: 1.0, drag: 0.4, gravity: 1.0,
      lit: 1, spin: 9, alpha: 1, fade: 0.6, soft: 0.1,
      colorA: [0.24, 0.24, 0.25], colorB: [0.16, 0.16, 0.17],
    },
  ],
};

/** Material preset -> recipe. Names match `material.userData.preset`. */
const RECIPES = {
  concrete: CONCRETE,
  gravel: CONCRETE,
  tile: BRICK,
  brick: BRICK,
  plaster: PLASTER,
  metal: METAL,
  gunmetal: METAL,
  corrugated: METAL,
  polymer: METAL,
  wood: WOOD,
  sand: SAND,
  sandbag: SAND,
  asphalt: ASPHALT,
  asphalt_line: ASPHALT,
  glass: GLASS,
  canvas: FABRIC,
  rubber: FABRIC,
  water: WATER,
  flesh: FLESH,
};

export function recipeFor(name) {
  return RECIPES[name] || CONCRETE;
}

/* ------------------------------------------------------------- emission */

/**
 * Emit one burst spec about a surface point.
 * @param {import('./ParticleSystem.js').ParticleSystem} sys
 * @param {object} spec
 * @param {THREE.Vector3} point
 * @param {THREE.Vector3} normal
 * @param {number} scale energy multiplier (impulse, explosion power, ...)
 */
export function emitBurst(sys, spec, point, normal, scale = 1) {
  const layer = spec.additive ? LAYER.ADDITIVE : LAYER.ALPHA;
  const count = Math.max(1, Math.round(pick(spec.count) * scale));
  const cone = spec.cone !== undefined ? spec.cone : 0.8;

  // Tangent frame about the surface normal.
  _n.copy(normal).normalize();
  _t.set(0, 1, 0);
  if (Math.abs(_n.y) > 0.94) _t.set(1, 0, 0);
  _t.crossVectors(_t, _n).normalize();
  _b.crossVectors(_n, _t);

  const cA = spec.colorA || [1, 1, 1];
  const cB = spec.colorB || cA;

  for (let i = 0; i < count; i++) {
    resetP();
    const ang = Math.random() * TAU;
    // sqrt keeps the sample uniform over the cone's disc instead of piling up
    // on the axis; the extra pow biases a little back toward the normal.
    const spread = Math.pow(Math.random(), 0.65) * cone;
    const ca = Math.cos(ang) * spread, sa = Math.sin(ang) * spread;

    _d.copy(_n).addScaledVector(_t, ca).addScaledVector(_b, sa).normalize();
    const speed = pick(spec.speed !== undefined ? spec.speed : 1) * (0.7 + 0.6 * scale);

    const off = spec.offset || 0.012;
    P.x = point.x + _n.x * off + (_t.x * ca + _b.x * sa) * off * 2;
    P.y = point.y + _n.y * off + (_t.y * ca + _b.y * sa) * off * 2;
    P.z = point.z + _n.z * off + (_t.z * ca + _b.z * sa) * off * 2;
    P.vx = _d.x * speed; P.vy = _d.y * speed; P.vz = _d.z * speed;

    P.life = pick(spec.life !== undefined ? spec.life : 1);
    P.drag = spec.drag || 0;
    P.gravity = spec.gravity || 0;
    P.turbulence = spec.turbulence || 0;
    P.lit = spec.lit || 0;
    P.size0 = pick(spec.size0 !== undefined ? spec.size0 : 0.05);
    P.size1 = P.size0 * (spec.size1 !== undefined ? spec.size1 : 1);
    P.stretch = spec.stretch || 0;
    P.spin = spec.spin ? (Math.random() - 0.5) * 2 * spec.spin : 0;
    P.r0 = cA[0]; P.g0 = cA[1]; P.b0 = cA[2];
    P.r1 = cB[0]; P.g1 = cB[1]; P.b1 = cB[2];
    P.alpha = (spec.alpha !== undefined ? spec.alpha : 1);
    P.tile = spec.tile;
    P.fade = spec.fade !== undefined ? spec.fade : 1.4;
    P.soft = spec.soft !== undefined ? spec.soft : 0.4;
    sys.spawn(layer);
  }
}

/**
 * Full impact response.
 * @param {object} fx the FxModule (needs .particles, .decals, .collision)
 */
export function spawnImpact(fx, point, normal, materialName, impulse, engine) {
  const recipe = recipeFor(materialName);
  const scale = THREE.MathUtils.clamp(0.55 + impulse * 0.65, 0.35, 1.4);

  for (const spec of recipe.bursts) emitBurst(fx.particles, spec, point, normal, scale);

  if (recipe.decal && fx.decals) {
    const d = recipe.decal;
    _tint.setRGB(d.tint[0], d.tint[1], d.tint[2]);
    fx.decals.place({
      point, normal,
      tile: d.tile,
      size: pick(d.size) * (0.85 + 0.3 * scale),
      tint: _tint,
      life: d.life,
    }, fx.collision);
  }

  // Hot fragments throw real light for a couple of frames.
  if (recipe.light && engine.dynamicLights && Math.random() < 0.45) {
    _p.copy(point).addScaledVector(normal, 0.25);
    engine.dynamicLights.spawn({
      position: _p,
      color: recipe.light.color,
      intensity: recipe.light.intensity * scale,
      radius: recipe.light.radius,
      life: recipe.light.life,
    });
  }

  if (recipe.sound) {
    engine.bus.emit('audio:play', { id: recipe.sound, position: point, volume: 0.5 * scale });
  }
}

const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _tint = new THREE.Color();
