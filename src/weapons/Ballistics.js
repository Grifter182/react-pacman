import * as THREE from 'three';
import { LIMB, PENETRATION } from './WeaponDefs.js';

/**
 * OWNER: weapons agent.
 *
 * Hitscan ballistics: range falloff, per-limb multipliers, penetration through
 * thin surfaces, and the accuracy model that decides where the round actually
 * goes.
 *
 * PENETRATION WITHOUT CSG
 * -----------------------
 * The world collider is a single merged, front-face-only BVH, so there is no
 * "exit face" to be found by casting forward — the next forward hit is the
 * *next wall*, not the back of this one. The trick is to cast backwards: from a
 * probe point one penetration-budget beyond the entry, a ray travelling toward
 * the shooter meets the far side of the current slab front-on (its normal
 * points downrange, so its front face is what a rearward ray sees). The gap
 * between that hit and the entry is the material thickness, measured with the
 * same collider and no extra data.
 *
 * Damage across a penetration is not linear in thickness — it is exponential,
 * because each centimetre removes a fraction of the *remaining* energy. A
 * bullet through 2 cm of concrete keeps far less than twice what it loses in
 * 1 cm, which is why concrete stops rifle rounds and plasterboard does not.
 */

const _dir = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _back = new THREE.Vector3();
const _from = new THREE.Vector3();

/** Piecewise damage falloff. Flat inside `falloffStart`, floored past `End`. */
export function damageAtRange(def, distance) {
  if (distance <= def.falloffStart) return def.damage;
  if (distance >= def.falloffEnd) return def.damage * def.falloffMin;
  const t = (distance - def.falloffStart) / (def.falloffEnd - def.falloffStart);
  // Smoothstep rather than linear: the shoulders of the curve are where a
  // player learns a weapon's effective range, and a hard corner reads as a bug.
  const s = t * t * (3 - 2 * t);
  return def.damage * THREE.MathUtils.lerp(1, def.falloffMin, s);
}

/** Limb multiplier. `head` folds in the weapon's own headshot multiplier. */
export function limbMultiplier(def, limb) {
  if (limb === 'head') return def.headshotMultiplier;
  return LIMB[limb] ?? 1.0;
}

/**
 * Full damage for one impact.
 * @param def          weapon definition
 * @param distance     metres travelled
 * @param limb         'head' | 'chest' | 'arm' | ...
 * @param penFactor    surviving fraction after penetration (1 = clean line)
 */
export function resolveDamage(def, distance, limb = 'chest', penFactor = 1) {
  return damageAtRange(def, distance) * limbMultiplier(def, limb) * penFactor;
}

function penetrationFor(material) {
  return PENETRATION[material] || PENETRATION.default;
}

function materialOf(hit) {
  const m = hit?.object?.material;
  if (!m) return 'default';
  if (Array.isArray(m)) return m[0]?.userData?.preset || 'default';
  return m.userData?.preset || 'default';
}

/**
 * Trace a shot through the world, punching through thin surfaces until the
 * weapon runs out of penetration budget or layers.
 *
 * @returns {{segments:Array, hit:object|null, distance:number, penFactor:number,
 *            exit:THREE.Vector3|null}}
 *   `hit` is the surface the round finally stopped on (or the last one it hit),
 *   `segments` lists every layer it went through with the damage factor on the
 *   way out — the AI/actor resolver uses those to score a shot that came
 *   through a wall.
 */
export function traceShot(collision, origin, direction, def, maxDist = 400) {
  const result = { segments: [], hit: null, distance: maxDist, penFactor: 1, exit: null };
  if (!collision) return result;

  _dir.copy(direction).normalize();
  _from.copy(origin);
  let travelled = 0;
  let penFactor = 1;
  let layers = 0;

  while (layers <= def.penetrationLayers) {
    const hit = collision.raycast(_from, _dir, maxDist - travelled);
    if (!hit) {
      result.distance = maxDist;
      result.penFactor = penFactor;
      return result;
    }

    travelled += hit.distance;
    result.hit = hit;
    result.distance = travelled;
    result.penFactor = penFactor;

    if (layers >= def.penetrationLayers) return result;

    const mat = materialOf(hit);
    const pen = penetrationFor(mat);
    const budget = pen.maxThickness * def.penetrationPower;
    if (budget <= 1e-4) return result;

    // Backwards probe: find the far side of this slab.
    _probe.copy(hit.point).addScaledVector(_dir, budget + 0.002);
    _back.copy(_dir).negate();
    const exit = collision.raycast(_probe, _back, budget + 0.002);
    if (!exit) return result;                              // thicker than budget

    const thickness = (budget + 0.002) - exit.distance;
    if (thickness <= 0 || thickness > budget) return result;

    // Exponential energy loss per centimetre of material.
    const survive = Math.pow(1 - Math.min(0.95, pen.lossPerCm), thickness * 100);
    penFactor *= survive;
    result.segments.push({
      material: mat, thickness, entry: hit.point.clone(), exit: exit.point.clone(),
      normal: hit.normal.clone(), penFactor,
    });

    if (penFactor < 0.10) {                                // no longer lethal
      result.penFactor = penFactor;
      result.exit = exit.point.clone();
      return result;
    }

    result.exit = exit.point.clone();
    _from.copy(exit.point).addScaledVector(_dir, 0.004);
    travelled += thickness;
    layers++;
  }
  result.penFactor = penFactor;
  return result;
}

/* ------------------------------------------------------------- accuracy */

/**
 * Accuracy state machine. Owns the two things that decide a cone's radius:
 * per-shot bloom (fires up, decays down) and first-shot accuracy (charges while
 * settled, spends itself on the shot that breaks the settle).
 */
export class AccuracyModel {
  constructor() {
    this.bloom = 0;
    this.charge = 1;      // 0..1 first-shot-accuracy charge
    this.sinceShot = 99;
  }

  reset() { this.bloom = 0; this.charge = 1; this.sinceShot = 99; }

  update(dt, def, state) {
    this.sinceShot += dt;
    this.bloom *= Math.exp(-def.spreadDecay * dt);
    // FSA recharges only when the shooter is settled: not firing, and not
    // sprinting. Moving slowly still charges — a marksman walking a corner
    // should not be denied their first shot.
    const settled = this.sinceShot > 0.05 && !state.sprinting;
    const rate = settled ? dt / Math.max(0.01, def.fsa.chargeTime) : -dt * 3;
    this.charge = THREE.MathUtils.clamp(this.charge + rate, 0, 1);
  }

  /** Cone half-angle in radians for the shot about to be fired. */
  spread(def, state, adsBlend) {
    const base = THREE.MathUtils.lerp(def.spreadHip, def.spreadAds, adsBlend);
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    let cone = base + speed * def.spreadMovePerMs * (1 - adsBlend * 0.55);
    if (state.grounded === false) cone *= def.spreadAirScale;
    else if (state.crouching) cone *= def.spreadCrouchScale;
    cone += this.bloom;
    // First-shot accuracy collapses the cone for a fully charged shot; it is
    // strongest when aimed, because that is the shot it is meant to reward.
    const fsa = THREE.MathUtils.lerp(1, def.fsa.spreadScale, this.charge * (0.45 + adsBlend * 0.55));
    return Math.min(def.spreadMax, cone * fsa);
  }

  /** Multiplier applied to the recoil impulse of the shot about to be fired. */
  recoilScale(def) {
    return THREE.MathUtils.lerp(1, def.fsa.recoilScale, this.charge);
  }

  onShot(def) {
    this.bloom = Math.min(def.spreadMax, this.bloom + def.spreadPerShot);
    this.charge = 0;
    this.sinceShot = 0;
  }
}

/**
 * Sample a direction inside the cone. `rand01` is injected so the caller can
 * make a shot reproducible; the radius uses sqrt so samples are uniform over
 * the disc rather than piling up in the centre.
 */
export function coneSample(out, dir, quat, spread, rand = Math.random) {
  const ang = rand() * Math.PI * 2;
  const r = Math.sqrt(rand()) * spread;
  out.set(Math.cos(ang) * r, Math.sin(ang) * r, 0).applyQuaternion(quat);
  out.add(dir).normalize();
  return out;
}
