import * as THREE from 'three';
import { LAYER, P, resetP } from './ParticleSystem.js';
import { PT, DT } from './FxTextures.js';

/**
 * OWNER: VFX agent.
 *
 * An explosion is a sequence, not an event. Real high explosive produces, in
 * this order and on these timescales:
 *
 *   0 ms    detonation flash — white, over before the eye resolves it
 *   0-40    fireball: an expanding shell of burning fuel, brightest at its edge
 *   0-60    shockwave: a pressure front that distorts the air ahead of the fire
 *   0-200   debris and burning fragments thrown ballistically
 *   80-400  dust wave hugging the ground, outrunning the fire
 *   0.3-6s  the smoke column, rising, cooling, shearing in the wind
 *
 * Playing all of that at t=0 is the single most common reason a game explosion
 * reads as a firework. The stages below are scheduled off a pooled record with
 * no closures and no allocation.
 *
 * The fireball's "shell" is a radial cluster of fire billboards rather than a
 * sphere mesh: a sphere reads as a hard-edged balloon at exactly the moment the
 * effect is largest on screen, and the cluster costs nothing beyond particles
 * that are already budgeted.
 */
export class Explosions {
  constructor(fx) {
    this.fx = fx;
    this.pool = [];
    for (let i = 0; i < 8; i++) {
      this.pool.push({
        active: false, stage: 0, t: 0,
        pos: new THREE.Vector3(), radius: 5, power: 1,
        ground: new THREE.Vector3(), hasGround: false, groundNormal: new THREE.Vector3(0, 1, 0),
      });
    }
  }

  /** @param {THREE.Vector3} position */
  trigger(position, radius, power, engine) {
    let rec = null;
    for (const r of this.pool) { if (!r.active) { rec = r; break; } }
    if (!rec) rec = this.pool[0];
    rec.active = true;
    rec.stage = 0;
    rec.t = 0;
    rec.pos.copy(position);
    rec.radius = Math.max(1, radius);
    rec.power = Math.max(0.2, power);

    // Find the ground under the blast so the dust wave and the scorch mark lie
    // on a real surface instead of floating at the detonation height.
    rec.hasGround = false;
    const collision = this.fx.collision;
    if (collision && collision.collider) {
      const hit = collision.raycast(position, _down, rec.radius * 1.6);
      if (hit) {
        rec.hasGround = true;
        rec.ground.copy(hit.point);
        rec.groundNormal.copy(hit.normal);
      }
    }

    this._stageFlash(rec, engine);
  }

  update(dt, engine) {
    for (const rec of this.pool) {
      if (!rec.active) continue;
      rec.t += dt;
      if (rec.stage === 0 && rec.t >= 0.09) { this._stageRollout(rec); rec.stage = 1; }
      if (rec.stage === 1 && rec.t >= 0.28) { this._stageDustWave(rec); rec.stage = 2; }
      if (rec.stage === 2 && rec.t >= 0.55) { this._stageColumn(rec, engine); rec.stage = 3; }
      if (rec.stage === 3 && rec.t >= 1.4) { rec.active = false; }
      // Sustained shake for the first fifth of a second, not a single kick.
      if (rec.t < 0.2) {
        const p = engine.get('player');
        const k = 0.055 * rec.power * (1 - rec.t / 0.2);
        // Directional trauma when the player module offers it: a blast from the
        // left should throw the view right.
        if (p && p.shakeFrom) p.shakeFrom(k * 4, rec.pos);
        else if (p && p.addShake) p.addShake(k);
      }
    }
  }

  /* --------------------------------------------------------- stage 0 */

  _stageFlash(rec, engine) {
    const sys = this.fx.particles;
    const r = rec.radius;
    const p = rec.pos;

    // Detonation flash: two frames of pure white, big enough to blow the
    // exposure out through the post stack's auto-exposure.
    for (let i = 0; i < 2; i++) {
      resetP();
      P.x = p.x; P.y = p.y; P.z = p.z;
      P.life = 0.09 + i * 0.05;
      P.size0 = r * (0.5 + i * 0.5); P.size1 = P.size0 * 2.2;
      P.alpha = 1; P.tile = PT.FLARE; P.fade = 1.0; P.soft = 0;
      P.spin = (Math.random() - 0.5) * 4;
      P.r0 = 14; P.g0 = 11; P.b0 = 8;
      P.r1 = 6; P.g1 = 3.0; P.b1 = 1.0;
      // Bias 0: the detonation flash is shorter than a slow frame, and
      // backdating its birth would retire it before it was ever drawn.
      sys.spawn(LAYER.ADDITIVE, 0);
    }

    // Fireball shell: fire thrown radially, fastest at the leading edge.
    const shell = Math.round(18 * Math.min(rec.power, 2));
    for (let i = 0; i < shell; i++) {
      resetP();
      _rand(_d);
      const sp = r * (1.6 + Math.random() * 1.8);
      P.x = p.x + _d.x * r * 0.15; P.y = p.y + _d.y * r * 0.15; P.z = p.z + _d.z * r * 0.15;
      P.vx = _d.x * sp; P.vy = _d.y * sp + r * 0.5; P.vz = _d.z * sp;
      P.life = 0.28 + Math.random() * 0.42;
      P.drag = 4.5;                       // fire decelerates hard as it entrains air
      P.gravity = -0.35;                  // and then floats
      P.turbulence = 1.4;
      P.size0 = r * 0.18; P.size1 = P.size0 * 3.4;
      P.spin = (Math.random() - 0.5) * 3;
      P.alpha = 1; P.tile = PT.FLAME; P.fade = 1.5; P.soft = r * 0.25;
      P.r0 = 9; P.g0 = 3.6; P.b0 = 0.9;
      P.r1 = 1.6; P.g1 = 0.35; P.b1 = 0.06;
      sys.spawn(LAYER.ADDITIVE);
    }

    // Core: one slow dense fireball that lingers behind the shell.
    resetP();
    P.x = p.x; P.y = p.y + r * 0.1; P.z = p.z;
    P.vy = r * 0.35;
    P.life = 0.55; P.drag = 3.0; P.gravity = -0.5; P.turbulence = 0.8;
    P.size0 = r * 0.5; P.size1 = r * 1.5;
    P.alpha = 1; P.tile = PT.FLAME; P.fade = 1.8; P.soft = r * 0.3;
    P.r0 = 7; P.g0 = 2.7; P.b0 = 0.7;
    P.r1 = 0.9; P.g1 = 0.2; P.b1 = 0.04;
    sys.spawn(LAYER.ADDITIVE);

    // Shockwave: an expanding shell of distortion that outruns the fire.
    for (let i = 0; i < 4; i++) {
      resetP();
      P.x = p.x; P.y = p.y; P.z = p.z;
      P.life = 0.22 + i * 0.03;
      P.size0 = r * 0.35; P.size1 = r * (2.6 + i * 0.4);
      P.alpha = 0.9; P.tile = i === 0 ? PT.RING : PT.SMOKE; P.fade = 1.1; P.soft = r * 0.2;
      P.spin = (Math.random() - 0.5) * 2;
      // Colour keys are the shimmer's phase offsets in the haze shader.
      P.r0 = P.r1 = Math.random(); P.g0 = P.g1 = Math.random();
      sys.spawn(LAYER.HAZE);
    }

    // Burning fragments.
    const sparks = Math.round(26 * Math.min(rec.power, 2.5));
    for (let i = 0; i < sparks; i++) {
      resetP();
      _rand(_d);
      const sp = r * (0.9 + Math.random() * 2.6);
      P.x = p.x; P.y = p.y; P.z = p.z;
      P.vx = _d.x * sp; P.vy = Math.abs(_d.y) * sp * 0.8 + r * 0.4; P.vz = _d.z * sp;
      P.life = 0.5 + Math.random() * 1.4;
      P.drag = 0.55; P.gravity = 1.0; P.turbulence = 0.25;
      P.size0 = 0.02 + Math.random() * 0.03; P.size1 = P.size0 * 0.4;
      P.stretch = 0.02;
      P.alpha = 1; P.tile = PT.SPARK; P.fade = 1.3; P.soft = 0;
      P.r0 = 6; P.g0 = 2.8; P.b0 = 0.7;
      P.r1 = 1.1; P.g1 = 0.18; P.b1 = 0.03;
      sys.spawn(LAYER.ADDITIVE);
    }

    // Physical debris.
    const chunks = this.fx.chunks;
    if (chunks) {
      const n = Math.round(10 * Math.min(rec.power, 2));
      for (let i = 0; i < n; i++) {
        _rand(_d);
        const sp = r * (0.8 + Math.random() * 1.9);
        _v.copy(p).addScaledVector(_d, r * 0.2);
        _v2.set(_d.x * sp, Math.abs(_d.y) * sp * 0.9 + r * 0.9, _d.z * sp);
        const s = 0.04 + Math.random() * 0.11;
        _scale.set(s, s * (0.5 + Math.random()), s * (0.5 + Math.random()));
        chunks.spawn(_v, _v2, { life: 3 + Math.random() * 3, spin: 8 + Math.random() * 20, scale: _scale });
      }
    }

    // Scorch mark and the ground flash ring.
    if (rec.hasGround && this.fx.decals) {
      _tint.setRGB(0.55, 0.5, 0.46);
      this.fx.decals.place({
        point: rec.ground, normal: rec.groundNormal,
        tile: DT.SCORCH, size: r * 0.9, tint: _tint, life: 90,
      }, this.fx.collision);
    }
  }

  /* --------------------------------------------------------- stage 1 */

  /** The fireball rolls out and starts turning to smoke at its edges. */
  _stageRollout(rec) {
    const sys = this.fx.particles;
    const r = rec.radius;
    const p = rec.pos;
    const n = Math.round(10 * Math.min(rec.power, 2));
    for (let i = 0; i < n; i++) {
      resetP();
      _rand(_d);
      const sp = r * (0.5 + Math.random() * 1.1);
      P.x = p.x + _d.x * r * 0.4; P.y = p.y + _d.y * r * 0.3; P.z = p.z + _d.z * r * 0.4;
      P.vx = _d.x * sp; P.vy = Math.abs(_d.y) * sp * 0.6 + r * 0.5; P.vz = _d.z * sp;
      P.life = 0.7 + Math.random() * 0.9;
      P.drag = 2.6; P.gravity = -0.55; P.turbulence = 1.1;
      P.lit = 0.75;
      P.size0 = r * 0.28; P.size1 = P.size0 * 3.0;
      P.spin = (Math.random() - 0.5) * 1.6;
      P.alpha = 0.72; P.tile = Math.random() < 0.5 ? PT.DENSE : PT.SMOKE;
      P.fade = 1.5; P.soft = r * 0.3;
      P.r0 = 0.32; P.g0 = 0.24; P.b0 = 0.20;
      P.r1 = 0.14; P.g1 = 0.13; P.b1 = 0.13;
      sys.spawn(LAYER.ALPHA);
    }
  }

  /* --------------------------------------------------------- stage 2 */

  /** Ground-hugging dust ring — the part that reads as *scale*. */
  _stageDustWave(rec) {
    if (!rec.hasGround) return;
    const sys = this.fx.particles;
    const r = rec.radius;
    const g = rec.ground;
    const n = Math.round(16 * Math.min(rec.power, 2));

    _n.copy(rec.groundNormal);
    _t.set(0, 1, 0);
    if (Math.abs(_n.y) > 0.94) _t.set(1, 0, 0);
    _t.crossVectors(_t, _n).normalize();
    _b.crossVectors(_n, _t);

    for (let i = 0; i < n; i++) {
      resetP();
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const ca = Math.cos(a), sa = Math.sin(a);
      const sp = r * (1.1 + Math.random() * 0.9);
      P.x = g.x + (_t.x * ca + _b.x * sa) * r * 0.25 + _n.x * 0.1;
      P.y = g.y + (_t.y * ca + _b.y * sa) * r * 0.25 + _n.y * 0.1;
      P.z = g.z + (_t.z * ca + _b.z * sa) * r * 0.25 + _n.z * 0.1;
      P.vx = (_t.x * ca + _b.x * sa) * sp + _n.x * sp * 0.12;
      P.vy = (_t.y * ca + _b.y * sa) * sp + _n.y * sp * 0.12;
      P.vz = (_t.z * ca + _b.z * sa) * sp + _n.z * sp * 0.12;
      P.life = 1.4 + Math.random() * 1.6;
      P.drag = 2.0; P.gravity = 0.04; P.turbulence = 0.5;
      P.lit = 1;
      P.size0 = r * 0.2; P.size1 = P.size0 * 3.6;
      P.spin = (Math.random() - 0.5) * 1.0;
      P.alpha = 0.42; P.tile = Math.random() < 0.5 ? PT.SMOKE : PT.WISP;
      P.fade = 1.7; P.soft = r * 0.3;
      P.r0 = 0.62; P.g0 = 0.57; P.b0 = 0.50;
      P.r1 = 0.42; P.g1 = 0.40; P.b1 = 0.38;
      sys.spawn(LAYER.ALPHA);
    }
  }

  /* --------------------------------------------------------- stage 3 */

  /** The column: slow, lit, self-shadowing, alive for several seconds. */
  _stageColumn(rec, engine) {
    const sys = this.fx.particles;
    const r = rec.radius;
    const p = rec.pos;
    const n = Math.round(9 * Math.min(rec.power, 2));
    for (let i = 0; i < n; i++) {
      resetP();
      _rand(_d);
      P.x = p.x + _d.x * r * 0.3; P.y = p.y + Math.abs(_d.y) * r * 0.3; P.z = p.z + _d.z * r * 0.3;
      P.vx = _d.x * r * 0.25; P.vy = r * (0.35 + Math.random() * 0.4); P.vz = _d.z * r * 0.25;
      P.life = 3.5 + Math.random() * 3.0;
      P.drag = 1.1; P.gravity = -0.16; P.turbulence = 0.85;
      P.lit = 1;
      P.size0 = r * 0.35; P.size1 = P.size0 * 3.2;
      P.spin = (Math.random() - 0.5) * 0.5;
      P.alpha = 0.5; P.tile = i % 3 === 0 ? PT.DENSE : PT.WISP;
      P.fade = 2.2; P.soft = r * 0.4;
      P.r0 = 0.26; P.g0 = 0.24; P.b0 = 0.23;
      P.r1 = 0.16; P.g1 = 0.16; P.b1 = 0.17;
      sys.spawn(LAYER.ALPHA);
    }
  }

  dispose() {}
}

/** Uniform point on the unit sphere — no clustering at the poles. */
function _rand(out) {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  out.set(Math.cos(a) * s, z, Math.sin(a) * s);
  return out;
}

const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _tint = new THREE.Color();
