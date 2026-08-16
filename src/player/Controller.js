import * as THREE from 'three';
import { Config } from '../core/Config.js';

/**
 * OWNER: player-feel agent.
 *
 * The capsule character controller. Runs on the 120 Hz fixed step; owns
 * position, velocity, stance and every ground interaction. It never touches the
 * camera — it publishes the *consequences* of motion (step offsets, landing
 * impacts, mantle arcs) and `CameraRig` turns those into view motion.
 *
 * Design notes that are not obvious from the code:
 *
 *  - `position` is the capsule *centre*, matching `CollisionModule.capsuleResolve`.
 *    Stance changes therefore move the centre by the half-height delta so the
 *    feet stay planted; the camera is built from the feet, so no pop.
 *  - Acceleration is the Quake projection model (`wishSpeed - v·wishDir`),
 *    not a lerp to a target velocity. It is what gives a shooter its crisp
 *    direction changes: turning is instant, top speed is not.
 *  - Depenetration is *not* allowed to lift the capsule unless the surface it
 *    pushed off is walkable. Without that clamp, running into any steep face
 *    ramps the player up it — the classic surf exploit.
 */

export const Stance = { STAND: 0, CROUCH: 1, PRONE: 2, SLIDE: 3 };

/** Capsule height / eye height / speed scale / accel scale, per stance. */
const STANCE = [
  { height: 1.75, eye: Config.player.eyeHeight, speed: 1.00, accel: 1.00 },
  { height: 1.26, eye: Config.player.crouchEyeHeight, speed: 1.00, accel: 0.72 },
  { height: 0.74, eye: 0.46, speed: 1.00, accel: 0.45 },
  { height: 1.10, eye: 0.88, speed: 1.00, accel: 0.25 },
];

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

export class Controller {
  constructor(state, input) {
    this.state = state;
    this.input = input;
    this.collision = null;
    this.bus = null;

    this.stance = Stance.STAND;
    this.halfHeight = STANCE[Stance.STAND].height * 0.5;
    this.eyeHeight = STANCE[Stance.STAND].eye;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundDist = 0;

    /** Vertical distance the controller teleported this step (step-up/down). */
    this.stepOffset = 0;
    /** Impact speed of the most recent landing, consumed by the camera. */
    this.landImpact = 0;
    this.slideSpeed = 0;

    this._coyote = 0;
    this._jumpBuffer = 0;
    this._slideTimer = 0;
    this._slideCooldown = 0;
    this._crouchHeld = false;
    this._sinceGrounded = 0;
    this._steepTimer = 0;
    this._proneToggle = false;

    this.mantle = null;          // { t, dur, from, to, fwd, height }
    this._mantleCooldown = 0;

    this._wish = new THREE.Vector3();
    this._pre = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
  }

  attach(collision, bus) { this.collision = collision; this.bus = bus; }

  get maxSlopeCos() { return Math.cos(Config.player.maxSlopeDeg * Math.PI / 180); }

  /** Re-seat the controller after a spawn/teleport. */
  reset(position) {
    const s = this.state;
    this.stance = Stance.STAND;
    this.halfHeight = STANCE[Stance.STAND].height * 0.5;
    this.eyeHeight = STANCE[Stance.STAND].eye;
    s.velocity.set(0, 0, 0);
    if (position) s.position.copy(position);
    this.mantle = null;
    this.stepOffset = 0;
    this.landImpact = 0;
    this._slideTimer = 0;
    this._slideCooldown = 0;
    this.slideSpeed = 0;
    this.groundNormal.set(0, 1, 0);
  }

  /* ------------------------------------------------------------------ step */

  fixedUpdate(dt) {
    const s = this.state;
    const P = Config.player;
    if (!s.alive) { s.velocity.multiplyScalar(Math.max(0, 1 - dt * 6)); return; }

    this.stepOffset = 0;
    this._slideCooldown = Math.max(0, this._slideCooldown - dt);
    this._mantleCooldown = Math.max(0, this._mantleCooldown - dt);
    this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);

    if (this.input.pressed('jump')) this._jumpBuffer = 0.14;
    const crouchDown = this.input.down('crouch');
    const crouchEdge = crouchDown && !this._crouchHeld;
    this._crouchHeld = crouchDown;
    if (this.input.pressed('prone')) this._proneToggle = !this._proneToggle;

    if (this.mantle) { this._stepMantle(dt); return; }

    /* --- intent ---------------------------------------------------------- */
    const sin = Math.sin(s.yaw), cos = Math.cos(s.yaw);
    const mx = this.input.moveX, my = this.input.moveY;
    // Camera-relative basis: forward is -Z rotated by yaw.
    const wishX = mx * cos - my * sin;
    const wishZ = -mx * sin - my * cos;
    const wishLen = Math.hypot(wishX, wishZ);
    const wx = wishLen > 1e-5 ? wishX / wishLen : 0;
    const wz = wishLen > 1e-5 ? wishZ / wishLen : 0;

    const hSpeed = Math.hypot(s.velocity.x, s.velocity.z);
    const wantSprint = this.input.down('sprint') && my > 0.35 && !s.ads;

    /* --- stance ---------------------------------------------------------- */
    this._updateStance(dt, crouchDown, crouchEdge, wantSprint, hSpeed, wx, wz);

    s.crouching = this.stance === Stance.CROUCH || this.stance === Stance.PRONE;
    s.prone = this.stance === Stance.PRONE;
    s.sliding = this.stance === Stance.SLIDE;
    s.sprinting = wantSprint && this.stance === Stance.STAND && s.grounded && hSpeed > 2.2;

    /* --- speed target ---------------------------------------------------- */
    let speed;
    if (this.stance === Stance.PRONE) speed = 1.05;
    else if (this.stance === Stance.CROUCH) speed = P.crouchSpeed;
    else if (this.stance === Stance.SLIDE) speed = 1.2;         // steering only
    else speed = s.sprinting ? P.sprintSpeed : P.walkSpeed;
    if (s.ads) speed *= P.adsSpeedScale;
    // Analogue sticks deserve analogue speed; a key is always full deflection.
    const wishSpeed = speed * Math.min(1, wishLen);

    const steep = this.state.grounded === false && this.groundDist < 0.25
      && this.groundNormal.y < this.maxSlopeCos;

    /* --- horizontal acceleration ----------------------------------------- */
    if (s.grounded && !steep) {
      const fr = this.stance === Stance.SLIDE ? 1.15 : P.friction * STANCE[this.stance].accel;
      this._friction(dt, fr, this.stance === Stance.SLIDE ? 0.4 : 1.4);
      const accel = P.accelGround * STANCE[this.stance].accel;
      this._accelerate(wx, wz, wishSpeed, accel, dt);
      if (this.stance === Stance.SLIDE) this._slideDynamics(dt);
    } else {
      // Air control: full directional authority, zero free speed. The post-clamp
      // is what separates "air strafe" from "bunny-hop into orbit".
      const before = Math.hypot(s.velocity.x, s.velocity.z);
      this._accelerate(wx, wz, Math.min(wishSpeed, 1.6), P.accelAir, dt);
      const after = Math.hypot(s.velocity.x, s.velocity.z);
      const cap = Math.max(before, P.sprintSpeed * 1.02);
      if (after > cap && after > 1e-5) {
        const k = cap / after;
        s.velocity.x *= k; s.velocity.z *= k;
      }
      if (steep) this._slopeSlide(dt);
    }

    /* --- gravity and jump ------------------------------------------------- */
    s.velocity.y -= P.gravity * dt;
    if (s.velocity.y < -55) s.velocity.y = -55;

    this._coyote = s.grounded ? 0.13 : Math.max(0, this._coyote - dt);
    if (this._jumpBuffer > 0 && this._coyote > 0 && !steep && this.stance !== Stance.PRONE) {
      // A slide-jump keeps its momentum: that is the whole point of sliding.
      if (this.stance === Stance.SLIDE) { this._endSlide(0.75); s.velocity.y = P.jumpVelocity * 0.94; }
      else s.velocity.y = P.jumpVelocity;
      this._jumpBuffer = 0; this._coyote = 0; s.grounded = false;
      this.bus?.emit('player:jump', { position: s.position });
    }

    /* --- integrate + collide ---------------------------------------------- */
    const wasGrounded = s.grounded;
    const prevVy = s.velocity.y;
    this._pre.copy(s.position);
    s.position.addScaledVector(s.velocity, dt);

    const wantX = s.position.x, wantZ = s.position.z, preY = s.position.y;
    const res = this.collision?.capsuleResolve(s.position, P.radius, this.halfHeight)
      || { grounded: false, groundNormal: UP };

    this._probeGround(s.position);
    const walkable = this.groundNormal.y >= this.maxSlopeCos;

    // Surf clamp: depenetration may only raise the capsule when the thing it
    // pushed off could be stood on.
    const lift = s.position.y - preY;
    if (lift > 1e-4 && !walkable && !res.grounded) s.position.y = preY;

    // Step-up: if the sweep was blocked laterally while grounded, try to place
    // the capsule on top of whatever stopped it.
    const pushX = s.position.x - wantX, pushZ = s.position.z - wantZ;
    const blocked = (pushX * pushX + pushZ * pushZ) > 4e-6
      && (pushX * -s.velocity.x + pushZ * -s.velocity.z) > 0;
    if (blocked && (wasGrounded || this._sinceGrounded < 0.15) && this.stance !== Stance.PRONE) {
      this._tryStepUp(wantX, wantZ, preY);
    }

    const groundedNow = (res.grounded && res.groundNormal.y >= this.maxSlopeCos)
      || (this.groundDist <= 0.06 && walkable);
    s.grounded = groundedNow;
    this._sinceGrounded = groundedNow ? 0 : this._sinceGrounded + dt;

    if (groundedNow) {
      if (s.velocity.y < 0) s.velocity.y = 0;
      // Glue to the ground over crests and down shallow steps, or the player
      // launches off every ramp lip like a car in a bad driving game.
      if (this.groundDist > 0.005 && this.groundDist < Config.player.stepHeight && prevVy <= 0.2) {
        s.position.y -= this.groundDist;
        this.stepOffset -= this.groundDist;
        this.groundDist = 0;
      }
    }

    if (!wasGrounded && groundedNow && prevVy < -2.2) {
      this.landImpact = -prevVy;
      this.bus?.emit('player:land', { impact: this.landImpact, position: s.position, hard: this.landImpact > 9 });
      if (this.landImpact > 13.5) {
        // Fall damage above roughly a three-storey drop, quadratic in excess.
        const excess = this.landImpact - 13.5;
        this.bus?.emit('player:falldamage', { amount: Math.min(95, excess * excess * 1.9) });
      }
    }

    if (!s.grounded && this._mantleCooldown <= 0 && this.stance !== Stance.PRONE) {
      this._tryMantle(wx, wz, wishLen);
    } else if (s.grounded && this._jumpBuffer > 0 && this._mantleCooldown <= 0) {
      this._tryMantle(wx, wz, wishLen);
    }

    if (s.position.y < -20) {
      this.reset(this._pre.setY(3));
      this.bus?.emit('player:falldamage', { amount: 34 });
    }
  }

  /* ------------------------------------------------------------ sub-steps */

  _friction(dt, rate, stopSpeed) {
    const v = this.state.velocity;
    const speed = Math.hypot(v.x, v.z);
    if (speed < 1e-4) { v.x = 0; v.z = 0; return; }
    // `stopSpeed` keeps the last fraction of a metre-per-second from taking an
    // exponentially long time to bleed off — the difference between stopping
    // and drifting.
    const control = Math.max(speed, stopSpeed);
    const drop = control * rate * dt;
    const k = Math.max(0, speed - drop) / speed;
    v.x *= k; v.z *= k;
  }

  _accelerate(wx, wz, wishSpeed, accel, dt) {
    if (wishSpeed <= 1e-4) return;
    const v = this.state.velocity;
    const current = v.x * wx + v.z * wz;
    const add = wishSpeed - current;
    if (add <= 0) return;
    const a = Math.min(accel * dt * wishSpeed, add);
    v.x += wx * a; v.z += wz * a;
  }

  /** Gravity resolved along a too-steep face, so the player slides off it. */
  _slopeSlide(dt) {
    const n = this.groundNormal;
    const v = this.state.velocity;
    // Component of -up tangent to the surface.
    const t = this._tmp.set(-n.x * n.y, n.x * n.x + n.z * n.z, -n.z * n.y);
    const len = t.length();
    if (len < 1e-4) return;
    t.divideScalar(len);
    const g = Config.player.gravity * (1 - n.y * n.y) * 1.15;
    v.addScaledVector(t, g * dt);
    // Kill the into-surface component so we do not accumulate against it.
    const into = v.dot(n);
    if (into < 0) v.addScaledVector(n, -into);
  }

  /** Slides accelerate downhill and bleed on the flat: momentum, not a timer. */
  _slideDynamics(dt) {
    const v = this.state.velocity;
    const n = this.groundNormal;
    const slope = 1 - n.y;                 // 0 flat, grows with steepness
    if (slope > 0.02) {
      const t = this._tmp.set(-n.x * n.y, n.x * n.x + n.z * n.z, -n.z * n.y);
      if (t.lengthSq() > 1e-8) {
        t.normalize();
        const along = v.x * t.x + v.z * t.z;
        // Downhill only: a slide never climbs.
        if (along > -0.2) v.addScaledVector(t, Config.player.gravity * slope * 0.85 * dt);
      }
    }
    this.slideSpeed = Math.hypot(v.x, v.z);
  }

  _updateStance(dt, crouchDown, crouchEdge, wantSprint, hSpeed, wx, wz) {
    const s = this.state;

    if (this.stance === Stance.SLIDE) {
      this._slideTimer += dt;
      const done = this._slideTimer > 1.5
        || this.slideSpeed < 2.4
        || (!crouchDown && this._slideTimer > 0.22);
      if (done) this._endSlide(crouchDown);
      else { this._blendStance(dt); return; }
    }

    // Sprint + crouch at speed starts a slide; the cooldown stops it becoming
    // a faster-than-sprinting travel mode.
    if (crouchEdge && s.grounded && hSpeed > 4.0 && this._slideCooldown <= 0
        && this.stance === Stance.STAND) {
      this._beginSlide(hSpeed, wx, wz);
      return;
    }

    let want = Stance.STAND;
    if (this._proneToggle) want = Stance.PRONE;
    else if (crouchDown) want = Stance.CROUCH;
    if (want !== Stance.PRONE) this._proneToggle = false;
    if (want === Stance.STAND && wantSprint) this._proneToggle = false;

    if (want !== this.stance) {
      const targetH = STANCE[want].height;
      if (targetH > STANCE[this.stance].height && !this._hasClearance(targetH)) return;
      this._setStance(want, dt);
    }
    this._blendStance(dt);
  }

  _setStance(next, dt) {
    const s = this.state;
    const oldHalf = this.halfHeight;
    this.stance = next;
    // Feet stay where they are: move the centre, not the capsule.
    const targetHalf = STANCE[next].height * 0.5;
    s.position.y += targetHalf - oldHalf;
    this.halfHeight = targetHalf;
    void dt;
  }

  /** Eye height eases toward the stance target; the capsule snaps, the view does not. */
  _blendStance(dt) {
    const target = STANCE[this.stance].eye;
    const rate = this.stance === Stance.PRONE || this.stance === Stance.SLIDE ? 9 : 13;
    this.eyeHeight += (target - this.eyeHeight) * Math.min(1, dt * rate);
  }

  _beginSlide(hSpeed, wx, wz) {
    const s = this.state;
    const v = s.velocity;
    let dx = v.x, dz = v.z;
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) { dx = wx; dz = wz; } else { dx /= l; dz /= l; }
    // Momentum preservation with a kick: you leave the slide faster than you
    // entered it only if the ground helps you.
    const boost = Math.max(hSpeed, Config.player.slideImpulse);
    v.x = dx * boost; v.z = dz * boost;
    this._setStance(Stance.SLIDE, 0);
    this._slideTimer = 0;
    this.slideSpeed = boost;
    this.bus?.emit('player:slide', { phase: 'start', speed: boost, position: s.position });
    this.bus?.emit('audio:play', { id: 'slide', position: null, volume: 0.6 });
  }

  _endSlide(keepCrouch) {
    const canStand = !keepCrouch && this._hasClearance(STANCE[Stance.STAND].height);
    this._setStance(canStand ? Stance.STAND : Stance.CROUCH, 0);
    this._slideCooldown = 0.95;
    this._slideTimer = 0;
    this.bus?.emit('player:slide', { phase: 'end' });
  }

  /* ------------------------------------------------------------- geometry */

  /** Is there room to grow the capsule to `height` where we stand? */
  _hasClearance(height) {
    const col = this.collision;
    if (!col) return true;
    const s = this.state;
    const feet = s.position.y - this.halfHeight;
    const need = height - 0.06;
    const r = Config.player.radius * 0.72;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      this._probe.set(s.position.x + Math.cos(a) * r, feet + 0.05, s.position.z + Math.sin(a) * r);
      const hit = col.raycast(this._probe, UP, need);
      if (hit) return false;
    }
    return true;
  }

  /** Ground probe: gives a real surface normal, which depenetration cannot. */
  _probeGround(position) {
    const col = this.collision;
    this.groundDist = 99;
    if (!col) { this.groundNormal.set(0, 1, 0); return; }
    const r = Config.player.radius * 0.6;
    let bestDist = 99, bestN = null;
    // Three probes on a small triad: a single centre ray falls through the gap
    // when the player straddles a ledge edge.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      this._probe.set(position.x + Math.cos(a) * r, position.y, position.z + Math.sin(a) * r);
      const hit = col.raycast(this._probe, DOWN, this.halfHeight + 0.6);
      if (hit) {
        const d = hit.distance - this.halfHeight;
        if (d < bestDist) { bestDist = d; bestN = hit.normal; }
      }
    }
    if (bestN) {
      this.groundDist = Math.max(0, bestDist);
      this.groundNormal.copy(bestN);
      if (this.groundNormal.y < 0) this.groundNormal.negate();
    } else {
      this.groundNormal.set(0, 1, 0);
    }
  }

  /**
   * Lift the capsule over a low obstruction. The capsule is re-tested at the
   * raised position before it is committed, so a step never pushes the player
   * into geometry; the vertical delta is handed to the camera as `stepOffset`
   * and smoothed there, which is why stairs do not strobe.
   */
  _tryStepUp(wantX, wantZ, preY) {
    const col = this.collision;
    if (!col) return;
    const s = this.state;
    const P = Config.player;
    const step = P.stepHeight;

    // Probe *past* the obstruction, not at it. `wantX/wantZ` is the capsule
    // centre, which stops a full radius short of the face it hit — a ground
    // ray from there lands in front of the step, measures no rise, and the
    // step-up silently never fires. Reaching forward by most of the radius puts
    // the probe over the tread.
    const vx = s.velocity.x, vz = s.velocity.z;
    const vl = Math.hypot(vx, vz);
    const reach = P.radius + 0.12;
    const probeX = vl > 1e-4 ? wantX + (vx / vl) * reach : wantX;
    const probeZ = vl > 1e-4 ? wantZ + (vz / vl) * reach : wantZ;

    this._probe.set(probeX, preY + step + 0.02, probeZ);
    const res = col.capsuleResolve(this._probe, P.radius, this.halfHeight, 3);
    const dx = this._probe.x - probeX, dz = this._probe.z - probeZ;
    if (dx * dx + dz * dz > 0.02) return;            // still jammed up there
    void res;

    const hit = col.raycast(this._probe, DOWN, this.halfHeight + step + 0.1);
    if (!hit || hit.normal.y < this.maxSlopeCos) return;

    const floorY = this._probe.y - hit.distance;
    const newY = floorY + this.halfHeight;
    const rise = newY - preY;
    if (rise <= 0.012 || rise > step + 0.02) return;

    s.position.set(this._probe.x, newY, this._probe.z);
    this.stepOffset += rise;
    this.groundDist = 0;
    this.groundNormal.copy(hit.normal);
  }

  /* --------------------------------------------------------------- mantle */

  /**
   * Waist-high cover gets vaulted, not walked around. A chest-height forward
   * ray finds the face; a downward ray past it finds the top; the capsule is
   * test-fitted on the ledge before the animation commits, so a mantle can
   * never end inside a wall.
   */
  _tryMantle(wx, wz, wishLen) {
    const col = this.collision;
    const s = this.state;
    if (!col || wishLen < 0.4) return;
    const P = Config.player;

    const feet = s.position.y - this.halfHeight;
    this._tmp.set(wx, 0, wz);
    const chest = this._probe.set(s.position.x, feet + 0.75, s.position.z);
    const face = col.raycast(chest, this._tmp, P.radius + 0.55);
    if (!face || Math.abs(face.normal.y) > 0.42) return;

    // Look for the top surface a little past the face.
    const over = this._tmp2.copy(face.point)
      .addScaledVector(this._tmp, P.radius + 0.22);
    over.y = feet + P.mantleMaxHeight + 0.85;
    const top = col.raycast(over, DOWN, P.mantleMaxHeight + 1.1);
    if (!top || top.normal.y < 0.62) return;

    const rise = top.point.y - feet;
    if (rise < 0.42 || rise > P.mantleMaxHeight) return;

    // Fit the capsule (crouched) on the ledge before committing.
    const half = STANCE[Stance.CROUCH].height * 0.5;
    this._probe.set(top.point.x, top.point.y + half + 0.03, top.point.z);
    const before = this._probe.clone();
    col.capsuleResolve(this._probe, P.radius, half, 3);
    if (before.distanceToSquared(this._probe) > 0.05) return;

    this.mantle = {
      t: 0,
      dur: THREE.MathUtils.clamp(0.34 + rise * 0.20, 0.34, 0.70),
      from: s.position.clone(),
      to: this._probe.clone(),
      rise,
      fwd: new THREE.Vector3(wx, 0, wz),
    };
    if (this.stance !== Stance.CROUCH) this._setStance(Stance.CROUCH, 0);
    s.velocity.set(0, 0, 0);
    s.mantling = true;
    this.bus?.emit('player:mantle', { phase: 'start', height: rise, position: s.position.clone() });
    this.bus?.emit('audio:play', { id: 'mantle', position: null, volume: 0.55 });
  }

  _stepMantle(dt) {
    const m = this.mantle;
    const s = this.state;
    m.t += dt;
    const u = Math.min(1, m.t / m.dur);

    // Two separated eases: the body rises first and translates second. Doing
    // both on one curve reads as a lift on a string; splitting them reads as a
    // pull-up. `to` is only reached at u = 1 by construction.
    const up = smoothstep(0, 0.68, u);
    const fwd = smoothstep(0.28, 1, u);
    s.position.x = m.from.x + (m.to.x - m.from.x) * fwd;
    s.position.z = m.from.z + (m.to.z - m.from.z) * fwd;
    s.position.y = m.from.y + (m.to.y - m.from.y) * up;
    s.grounded = false;
    s.velocity.set(0, 0, 0);

    if (u >= 1) {
      s.position.copy(m.to);
      s.velocity.set(m.fwd.x * 1.5, 0, m.fwd.z * 1.5);
      s.mantling = false;
      s.grounded = true;
      this.mantle = null;
      this._mantleCooldown = 0.25;
      this.bus?.emit('player:mantle', { phase: 'end' });
    }
  }

  /** 0..1 progress of the active mantle, for the camera arc. */
  get mantleProgress() { return this.mantle ? Math.min(1, this.mantle.t / this.mantle.dur) : -1; }
  get footY() { return this.state.position.y - this.halfHeight; }
}

function smoothstep(a, b, x) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
