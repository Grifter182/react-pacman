import * as THREE from 'three';

/**
 * OWNER: player-feel agent.
 *
 * Health, damage feedback and the low-health state.
 *
 * The feedback loop a shooter needs from a hit is: *how much*, *from where*,
 * and *how close to dead am I*. Those are three separate channels here:
 *
 *   how much   — trauma impulse + rumble, scaled by damage
 *   from where — the signed angle between the view and the shooter, emitted as
 *                'ui:damage' for the HUD agent to draw an arc with
 *   how close  — a desaturating, vignetting, pulsing screen state driven by a
 *                *curve*, not a threshold, so the player can feel themselves
 *                sliding toward death rather than being told at 25%.
 *
 * Recovery is deliberately slow to start and fast to finish: the tension lives
 * in the delay, not in the heal rate.
 */
export class Vitals {
  constructor(state) {
    this.state = state;
    this.sinceDamage = 99;
    this.regenDelay = 3.4;
    this.lastHitDir = new THREE.Vector3(0, 0, -1);

    this.suppression = 0;        // 0..1, set by incoming near-misses
    this.lowBlend = 0;           // 0..1 smoothed low-health weight
    this._beatTimer = 0;
    this._indicatorId = 0;
    this._baseSat = null;
    this._baseVig = null;
    this._graded = false;
  }

  reset() {
    const s = this.state;
    s.health = s.maxHealth;
    s.alive = true;
    this.sinceDamage = 99;
    this.suppression = 0;
    this.lowBlend = 0;
  }

  /**
   * @param amount  raw damage
   * @param from    attacker id / label, forwarded on the bus untouched
   * @param origin  world position of the shooter, for the directional arc
   */
  damage(amount, from, origin, engine, meta = {}) {
    const s = this.state;
    if (!s.alive || amount <= 0) return 0;

    const applied = Math.min(s.health, amount);
    s.health = Math.max(0, s.health - amount);
    this.sinceDamage = 0;

    // Signed bearing of the shooter relative to where the player is looking.
    // 0 = dead ahead, +PI/2 = right. The HUD draws this straight onto a ring.
    let angle = 0;
    if (origin) {
      const dx = origin.x - s.position.x;
      const dz = origin.z - s.position.z;
      this.lastHitDir.set(dx, 0, dz).normalize();
      const world = Math.atan2(dx, dz);
      angle = wrapPi(world - (s.yaw + Math.PI));
    }

    engine.bus.emit('player:damaged', {
      amount: applied, from,
      direction: this.lastHitDir.clone(),
      angle, health: s.health, ...meta,
    });
    engine.bus.emit('ui:damage', {
      id: this._indicatorId++, angle, amount: applied,
      from, headshot: !!meta.headshot, life: 1.5,
    });

    // Regeneration is owned by the match module; tell it to hold off. The field
    // is read with a `?? 0` fallback there, so writing it is safe either way.
    const match = engine.get?.('match');
    if (match) match._regenDelay = Math.max(match._regenDelay || 0, this.regenDelay);

    if (s.health <= 0) {
      s.alive = false;
      engine.bus.emit('player:died', { by: from, position: s.position.clone() });
    }
    return applied;
  }

  /** A round cracking past raises suppression; it decays on its own. */
  suppress(amount) {
    this.suppression = Math.min(1, this.suppression + amount);
  }

  update(dt, engine, trauma) {
    const s = this.state;
    this.sinceDamage += dt;
    this.suppression = Math.max(0, this.suppression - dt * 0.85);

    const ratio = THREE.MathUtils.clamp(s.health / s.maxHealth, 0, 1);
    // Nothing below 60%: above that the player should be reading the world, not
    // their own vignette. Below it the curve steepens quadratically.
    const low = ratio > 0.6 ? 0 : Math.pow((0.6 - ratio) / 0.6, 1.6);
    this.lowBlend += (low - this.lowBlend) * Math.min(1, dt * 3.2);

    /* --- heartbeat ------------------------------------------------------- */
    if (this.lowBlend > 0.08 && s.alive) {
      // 68 bpm at the threshold up to ~150 bpm on the floor.
      const bpm = 68 + this.lowBlend * 82;
      this._beatTimer -= dt;
      if (this._beatTimer <= 0) {
        this._beatTimer = 60 / bpm;
        engine.bus.emit('audio:play', {
          id: 'heartbeat', position: null,
          volume: 0.12 + this.lowBlend * 0.5, pitch: 0.85 + this.lowBlend * 0.2,
        });
        // The screen pulses with the beat, subtly — it is felt, not seen.
        trauma?.add(this.lowBlend * 0.035);
      }
    } else {
      this._beatTimer = 0;
    }

    /* --- colour response -------------------------------------------------- */
    // Desaturation and a tighter vignette as vision tunnels. The grade module
    // owns these fields; the baseline is captured once and restored exactly, so
    // whatever the render agent tunes them to still holds when we are healthy.
    const grade = engine.get('post')?.grade;
    if (grade && typeof grade.saturation === 'number') {
      if (this._baseSat === null) { this._baseSat = grade.saturation; this._baseVig = grade.vignette; }
      const w = this.lowBlend;
      if (w > 1e-3) {
        this._graded = true;
        const pulse = 0.5 + 0.5 * Math.sin(engine.elapsed * (6 + w * 5));
        grade.saturation = this._baseSat * (1 - w * 0.72);
        grade.vignette = this._baseVig + w * (0.34 + pulse * 0.10);
      } else if (this._graded) {
        this._graded = false;
        grade.saturation = this._baseSat;
        grade.vignette = this._baseVig;
      }
    }

    if (engine.frame % 6 === 0) {
      engine.bus.emit('ui:vitals', {
        health: s.health, ratio, low: this.lowBlend,
        suppression: this.suppression, regenerating: this.sinceDamage > this.regenDelay && ratio < 1,
      });
    }
  }
}

function wrapPi(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
