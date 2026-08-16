import * as THREE from 'three';

/**
 * OWNER: AI agent.
 *
 * What a bot knows, and when. Three channels feed one belief state:
 *
 *  **Sight** is not a boolean. A target inside the view cone with line of sight
 *  fills a *visibility accumulator* whose rate depends on range, how far off the
 *  centre of vision it is, and what the target is doing — a sprinting silhouette
 *  at 8 m is registered in a fifth of a second, a prone one at 50 m may never
 *  be. That accumulator is what stops bots snapping onto a player the instant a
 *  ray clears, which is the single most "cheating" thing an FPS AI can do.
 *
 *  **Hearing** is range-attenuated by loudness. Gunfire carries 60 m, footsteps
 *  8 m, a sprint 14 m. Sound never grants a position directly: it grants a
 *  *guess* with error proportional to distance, which is why bots search the
 *  wrong side of a wall sometimes — as they should.
 *
 *  **Memory** keeps the last known position and the target's velocity at that
 *  moment, so a bot that loses you leads its search rather than freezing where
 *  you were.
 */

export class Perception {
  constructor(opts = {}) {
    this.fovDeg = opts.fovDeg ?? 108;
    this.range = opts.range ?? 78;
    this.closeRange = opts.closeRange ?? 4.5;    // felt presence, ignores the cone
    this.gainBase = opts.gainBase ?? 2.6;
    this.decay = opts.decay ?? 0.62;
    this.memorySec = opts.memorySec ?? 11;
  }

  /** Fresh per-actor belief state. */
  static create() {
    return {
      visibility: 0,
      alert: 0,
      hasLos: false,
      losPoint: new THREE.Vector3(),
      lastKnown: new THREE.Vector3(),
      lastKnownVel: new THREE.Vector3(),
      lastSeen: -999,
      lastHeard: -999,
      heardPos: new THREE.Vector3(),
      heardConfidence: 0,
      spotted: false,
      sinceSpotted: 999,
      exposure: 0,        // how long the target has been continuously visible
      searchPoint: null,
    };
  }

  /**
   * @param a       actor (needs .eye world position, .yaw, .percept)
   * @param target  { position, velocity, crouching, sprinting, prone, alive }
   * @param ctx     { collision, time, dt, eye:THREE.Vector3 }
   */
  update(dt, a, target, ctx) {
    const p = a.percept;
    p.sinceSpotted += dt;

    if (!target || target.alive === false) {
      p.visibility = Math.max(0, p.visibility - this.decay * dt * 2);
      p.hasLos = false;
      p.spotted = false;
      return;
    }

    const eye = ctx.eye;
    _to.subVectors(target.position, eye);
    _to.y += 0.35;                                    // aim at the chest, not the feet
    const dist = _to.length();

    let gain = 0;
    p.hasLos = false;

    if (dist < this.range) {
      _to.divideScalar(dist);
      // Forward from yaw. Bots look where they are facing, including while
      // strafing, which is what makes flanking work at all.
      _fwd.set(Math.sin(a.yaw), 0, Math.cos(a.yaw));
      const cosAngle = _fwd.x * _to.x + _fwd.z * _to.z;
      const halfFov = Math.cos((this.fovDeg * 0.5) * Math.PI / 180);

      const inCone = cosAngle > halfFov;
      const close = dist < this.closeRange;
      if (inCone || close) {
        p.hasLos = this._lineOfSight(eye, target.position, dist, ctx.collision);
        if (p.hasLos) {
          p.losPoint.copy(target.position);
          // Range term: full rate inside 12 m, tailing to nothing at max range.
          const rangeK = THREE.MathUtils.clamp(1.35 - dist / this.range, 0.06, 1);
          // Foveal term: the centre of vision resolves far faster than the edge.
          const centre = THREE.MathUtils.clamp((cosAngle - halfFov) / (1 - halfFov), 0, 1);
          const focus = 0.25 + 0.75 * centre * centre;
          // Signature: movement and stance change how much there is to see.
          const speed = target.velocity ? Math.hypot(target.velocity.x, target.velocity.z) : 0;
          let sig = 0.55 + Math.min(1, speed / 5.5) * 0.75;
          if (target.prone) sig *= 0.34;
          else if (target.crouching) sig *= 0.62;
          if (target.sprinting) sig *= 1.25;
          if (close) sig *= 2.2;
          gain = this.gainBase * rangeK * focus * sig * (a.skill?.perception ?? 1);
        }
      }
    }

    if (gain > 0) {
      p.visibility = Math.min(1.6, p.visibility + gain * dt);
      p.exposure += dt;
    } else {
      p.visibility = Math.max(0, p.visibility - this.decay * dt);
      p.exposure = 0;
    }

    const wasSpotted = p.spotted;
    p.spotted = p.visibility >= 1;

    if (p.spotted) {
      p.lastKnown.copy(target.position);
      if (target.velocity) p.lastKnownVel.copy(target.velocity);
      p.lastSeen = ctx.time;
      p.alert = 1;
      p.sinceSpotted = 0;
      p.searchPoint = null;
      if (!wasSpotted) p.justSpotted = true;
    } else {
      p.justSpotted = false;
      // Alertness bleeds slower than the accumulator: a bot that half-saw
      // something stays switched on for a while.
      p.alert = Math.max(p.visibility * 0.8, p.alert - dt * 0.11);
    }
  }

  /**
   * Three-point silhouette test. One ray to the chest misses a player whose
   * head is the only thing over a wall — and grants sight of a player whose
   * chest is behind a railing their head clears.
   */
  _lineOfSight(eye, targetPos, dist, collision) {
    if (!collision) return true;
    for (let i = 0; i < SAMPLES.length; i++) {
      _pt.copy(targetPos).y += SAMPLES[i];
      _dir.subVectors(_pt, eye);
      const d = _dir.length();
      if (d < 1e-4) return true;
      _dir.divideScalar(d);
      if (!collision.raycast(eye, _dir, d - 0.22)) return true;
    }
    void dist;
    return false;
  }

  /**
   * Register a sound. Confidence falls off with distance, and the recorded
   * position carries matching error — so a distant shot sends a bot to the
   * right area, not to the shooter's feet.
   */
  hear(a, position, loudness, time, rand = Math.random) {
    const p = a.percept;
    _to.subVectors(position, a.position);
    const dist = _to.length();
    const audible = loudness;
    if (dist > audible) return false;

    const conf = THREE.MathUtils.clamp(1 - dist / audible, 0, 1);
    if (conf < p.heardConfidence * 0.6 && time - p.lastHeard < 1.2) return false;

    const err = (1 - conf) * dist * 0.22;
    p.heardPos.set(
      position.x + (rand() - 0.5) * err,
      position.y,
      position.z + (rand() - 0.5) * err,
    );
    p.lastHeard = time;
    p.heardConfidence = conf;
    // Sound cannot spot you, but it can make a bot look the right way and it
    // primes the visibility accumulator so the follow-up glance is quick.
    p.alert = Math.max(p.alert, 0.35 + conf * 0.5);
    p.visibility = Math.max(p.visibility, conf * 0.45);
    if (time - p.lastSeen > 2) {
      p.lastKnown.copy(p.heardPos);
      p.searchPoint = null;
    }
    return true;
  }

  /** Has the target been out of contact long enough to forget entirely? */
  forgotten(a, time) {
    return time - a.percept.lastSeen > this.memorySec
      && time - a.percept.lastHeard > this.memorySec;
  }
}

/** Height offsets sampled on the target silhouette, in metres from its origin. */
const SAMPLES = [0.62, 0.05, -0.55];

const _to = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _dir = new THREE.Vector3();
