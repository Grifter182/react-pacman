import * as THREE from 'three';

/**
 * OWNER: lighting / shadows agent.
 *
 * Fixed-size pool of transient point lights for muzzle flashes, explosions,
 * sparks and anything else that needs to throw light for a few frames.
 *
 * The pool is allocated once and never grows or shrinks. That is the whole
 * reason it exists: `NUM_POINT_LIGHTS` is a compile-time define, so adding or
 * removing a light from the scene invalidates every lit program and stalls the
 * frame recompiling shaders. Pooled lights stay in the scene permanently at
 * zero intensity, which costs a few ALU per fragment and nothing else.
 *
 * Requests beyond the budget do not fail — they evict the pooled light with the
 * least remaining energy, so a grenade always outbids a spent muzzle flash.
 *
 * Usage from any module:
 *   engine.dynamicLights.spawn({ position, color, intensity, radius, life });
 */
export class DynamicLightPool {
  /**
   * @param {THREE.Scene} scene
   * @param {number} budget  simultaneous dynamic lights
   */
  constructor(scene, budget) {
    this.scene = scene;
    this.slots = [];
    for (let i = 0; i < budget; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 12, 2);
      light.name = `DynamicLight${i}`;
      light.castShadow = false;
      // Kept in the scene and visible for the whole session so the light count
      // — and therefore every compiled program — never changes.
      scene.add(light);
      this.slots.push({
        light,
        active: false,
        t: 0,
        life: 1,
        peak: 0,
        flicker: 0,
        seed: Math.random() * 1000,
      });
    }
  }

  get budget() { return this.slots.length; }

  /**
   * @param {object} o
   * @param {THREE.Vector3} o.position
   * @param {THREE.Color|number} [o.color]
   * @param {number} [o.intensity]  peak intensity, renderer light units
   * @param {number} [o.radius]     cutoff distance in metres
   * @param {number} [o.life]       seconds
   * @param {number} [o.flicker]    0..1 amount of per-frame noise on intensity
   * @returns {object|null} the slot, for callers that want to move the light
   */
  spawn({ position, color = 0xffffff, intensity = 20, radius = 12, life = 0.12, flicker = 0 }) {
    let slot = null;
    let worst = Infinity;
    for (const s of this.slots) {
      if (!s.active) { slot = s; break; }
      // Remaining energy, so a dying flash is evicted before a fresh explosion.
      const remaining = s.peak * Math.max(0, 1 - s.t / s.life);
      if (remaining < worst) { worst = remaining; slot = s; }
    }
    if (!slot) return null;
    if (slot.active && slot.peak * Math.max(0, 1 - slot.t / slot.life) > intensity) return null;

    slot.active = true;
    slot.t = 0;
    slot.life = Math.max(life, 1e-3);
    slot.peak = intensity;
    slot.flicker = flicker;
    slot.seed = Math.random() * 1000;
    slot.light.position.copy(position);
    if (color instanceof THREE.Color) slot.light.color.copy(color);
    else slot.light.color.set(color);
    slot.light.distance = radius;
    slot.light.intensity = intensity;
    return slot;
  }

  release(slot) {
    if (!slot) return;
    slot.active = false;
    slot.light.intensity = 0;
  }

  update(dt) {
    for (const s of this.slots) {
      if (!s.active) continue;
      s.t += dt;
      const u = s.t / s.life;
      if (u >= 1) {
        s.active = false;
        s.light.intensity = 0;
        continue;
      }
      // Fast attack, quadratic decay: reads as a flash rather than a fade.
      const attack = Math.min(u / 0.09, 1);
      const decay = (1 - u) * (1 - u);
      let k = attack * decay;
      if (s.flicker > 0) {
        const n = Math.sin((s.t * 71.3 + s.seed) * 6.283) * Math.sin((s.t * 137.7 + s.seed) * 6.283);
        k *= 1 + s.flicker * n * 0.5;
      }
      s.light.intensity = s.peak * Math.max(k, 0);
    }
  }

  dispose() {
    for (const s of this.slots) this.scene.remove(s.light);
    this.slots.length = 0;
  }
}
