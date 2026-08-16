import * as THREE from 'three';
import { Ease } from './Clip.js';

/**
 * OWNER: weapons agent.
 *
 * The viewmodel animator. Everything here is procedural and *layered*: each
 * layer writes an offset, the layers sum, and nothing ever assigns a final
 * transform directly. That is the only way the gun can be simultaneously
 * breathing, lagging the camera, bobbing on the correct foot, mid-reload and
 * recovering from a burst without any two systems fighting for the same value.
 *
 * Layer order (all additive on top of the hip<->ADS base pose):
 *   1  base        hip and ADS reference poses, blended along a curve
 *   2  breathing   two-rate respiration plus incommensurate micro-drift
 *   3  sway        second-order spring driven by look delta, with inertia
 *   4  bob         speed-driven figure-eight with foot-plant impulses
 *   5  stance      sprint-lower, crouch, mantle-lower, airborne
 *   6  recoil      visual kick springs, decoupled from the aim punch
 *   7  clip        the keyframed layer (reload / draw / holster / inspect)
 *
 * SPRINGS. Sway, kick and stance all use the same critically-ish damped
 * second-order integrator, substepped at 240 Hz. Substepping matters: a 20 ms
 * frame with k = 210 is past the explicit-Euler stability limit and the gun
 * would visibly ring.
 */

const SUB = 1 / 240;

/** Second-order spring: integrate `s = {x, v}` toward `target`. */
function spring(s, target, k, c, dt) {
  let remain = dt;
  while (remain > 1e-6) {
    const h = Math.min(SUB, remain);
    const a = (target - s.x) * k - s.v * c;
    s.v += a * h;
    s.x += s.v * h;
    remain -= h;
  }
}

function damp(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/**
 * ADS blend curve. Not a lerp: the weapon breaks toward the eye fast, then
 * decelerates hard into alignment, and the rotation trails the translation by
 * a few milliseconds so the optic swings level *after* it arrives. Coming out
 * of ADS is quicker and linear-ish, because a player dropping out of aim wants
 * their peripheral vision back immediately.
 */
function adsCurves(a, rising) {
  if (rising) return { p: Ease.quintOut(a), r: Ease.cubicOut(Math.max(0, a * 1.12 - 0.12)) };
  return { p: Ease.cubicInOut(a), r: Ease.cubicInOut(a) };
}

export class ViewmodelAnimator {
  constructor() {
    this.weapon = null;
    this.def = null;
    this.arms = null;

    this.adsBlend = 0;
    this._adsRising = false;

    // Sway springs: x/y follow look delta, z follows forward accel, roll leans.
    this._swayX = { x: 0, v: 0 };
    this._swayY = { x: 0, v: 0 };
    this._swayR = { x: 0, v: 0 };
    this._lookYaw = 0; this._lookPitch = 0;
    this._lookVelYaw = 0; this._lookVelPitch = 0;

    // Recoil: visual kick springs, entirely separate from the aim punch the
    // module applies to the camera.
    this._kickZ = { x: 0, v: 0 };
    this._kickY = { x: 0, v: 0 };
    this._kickPitch = { x: 0, v: 0 };
    this._kickYaw = { x: 0, v: 0 };
    this._kickRoll = { x: 0, v: 0 };

    // Stance weights.
    this._sprint = 0; this._crouch = 0; this._mantle = 0; this._air = 0; this._land = 0;

    // Bob.
    this._bobPhase = 0;
    this._bobAmount = 0;
    this._plant = 0;
    this._lastPlantHalf = 0;

    // Mechanical sub-states.
    this._boltCycle = 0;       // 0..1 over one bolt stroke
    this._boltLock = 0;        // 1 when held open on an empty magazine
    this._coverOpen = 0;
    this._triggerPull = 0;
    this._selector = 0;

    this.pose = {};
    this._v = new THREE.Vector3();
    this._e = new THREE.Euler();
  }

  setWeapon(weapon, def, arms) {
    this.weapon = weapon;
    this.def = def;
    this.arms = arms;
    this._kickZ.x = this._kickZ.v = 0;
    this._kickPitch.x = this._kickPitch.v = 0;
    this._boltCycle = 0;
    this._coverOpen = 0;
  }

  /** Fire impulse. `shotIndex` selects the deterministic pattern entry. */
  onFire(kickScale = 1) {
    const rc = this.def.recoil;
    // Impulse into velocity, not position: the gun accelerates backward and
    // the spring decides how far it actually travels. Position impulses look
    // like a teleport at high RPM.
    this._kickZ.v += rc.kick * 42 * kickScale;
    this._kickY.v += rc.kick * 9 * kickScale;
    this._kickPitch.v += rc.kick * 62 * kickScale;
    this._kickYaw.v += (Math.random() - 0.5) * rc.kick * 40 * kickScale;
    this._kickRoll.v += (Math.random() - 0.5) * rc.kick * 55 * kickScale;
    this._boltCycle = 1e-4;
    this._coverOpen = 1;
  }

  setBoltLock(locked) { this._boltLock = locked ? 1 : 0; }

  /**
   * @param dt   frame delta
   * @param ctx  { state, elapsed, adsWanted, firing, clipPose, reloading }
   */
  update(dt, ctx) {
    const def = this.def;
    const w = this.weapon;
    if (!w || !def) return;
    const s = ctx.state;

    /* -- 1. ADS blend ---------------------------------------------------- */
    const target = ctx.adsWanted ? 1 : 0;
    this._adsRising = target > this.adsBlend;
    const rate = dt / Math.max(0.01, this._adsRising ? def.adsTime : def.adsTime * 0.78);
    const d = target - this.adsBlend;
    this.adsBlend += Math.sign(d) * Math.min(rate, Math.abs(d));
    const a = THREE.MathUtils.clamp(this.adsBlend, 0, 1);
    const cur = adsCurves(a, this._adsRising);

    const pos = this._v.copy(w.hipPose.pos).lerp(w.adsPose.pos, cur.p);
    let rx = THREE.MathUtils.lerp(w.hipPose.rot.x, w.adsPose.rot.x, cur.r);
    let ry = THREE.MathUtils.lerp(w.hipPose.rot.y, w.adsPose.rot.y, cur.r);
    let rz = THREE.MathUtils.lerp(w.hipPose.rot.z, w.adsPose.rot.z, cur.r);

    const free = 1 - a;

    /* Two different scales, and the split matters.
     *
     * Additive *rotation* of the weapon is cheap at ADS: it swings the muzzle
     * and barely moves the optic, and the camera rig is already contributing
     * its own aim wobble, so the sight picture stays alive.
     *
     * Additive *translation* is not cheap. At full ADS the optic sits ~105 mm
     * from the eye, so 1.8 mm of residual breathing drift is a whole degree of
     * angular error and walks the optic ring visibly off centre — the review
     * measured the ring at 61% / 47% instead of 50% / 50%. The lateral budget
     * is therefore squeezed hard as the blend closes, which puts the housing on
     * the screen centre where the reticle already is, and leaves the *world*
     * to do the moving. */
    const aimScale = THREE.MathUtils.lerp(1, def.adsSwayScale, a);
    const aimShift = aimScale * THREE.MathUtils.lerp(1, 0.22, a * a);

    /* -- 2. breathing ---------------------------------------------------- */
    // Two-rate respiration (chest ~0.24 Hz, a faster shallow component) plus
    // drift built from incommensurate frequencies so it never visibly loops.
    const t = ctx.elapsed;
    const breath = Math.sin(t * 1.52) * 0.55 + Math.sin(t * 2.37 + 1.1) * 0.25;
    const driftX = Math.sin(t * 0.37) * 0.6 + Math.sin(t * 0.83 + 2.1) * 0.25;
    const driftY = Math.sin(t * 0.29 + 1.7) * 0.6 + Math.sin(t * 0.61 + 0.4) * 0.3;
    // Holding breath: aiming steadies the weapon, it does not freeze it.
    const bScale = 0.0030 * aimShift;
    pos.x += driftX * bScale * 0.9;
    pos.y += (breath * 0.8 + driftY * 0.5) * bScale;
    rx += breath * 0.012 * aimScale;
    ry += driftX * 0.010 * aimScale;

    /* -- 3. sway --------------------------------------------------------- */
    // Look delta -> spring target. The spring's own lag *is* the inertia; the
    // weapon trails the camera and overshoots slightly on a hard flick.
    let dYaw = s.yaw - this._lookYaw;
    let dPitch = s.pitch - this._lookPitch;
    this._lookYaw = s.yaw; this._lookPitch = s.pitch;
    if (dt > 1e-5) {
      // Angular velocity, low-passed so a single noisy mouse frame cannot
      // punch the spring.
      this._lookVelYaw = damp(this._lookVelYaw, dYaw / dt, 26, dt);
      this._lookVelPitch = damp(this._lookVelPitch, dPitch / dt, 26, dt);
    }
    const swayLimit = 0.075;
    const sxT = THREE.MathUtils.clamp(this._lookVelYaw * 0.020 * def.swayScale, -swayLimit, swayLimit);
    const syT = THREE.MathUtils.clamp(-this._lookVelPitch * 0.016 * def.swayScale, -swayLimit, swayLimit);
    const srT = THREE.MathUtils.clamp(-this._lookVelYaw * 0.030 * def.swayScale, -0.28, 0.28);
    spring(this._swayX, sxT, def.swaySpring, def.swayDamp, dt);
    spring(this._swayY, syT, def.swaySpring, def.swayDamp, dt);
    spring(this._swayR, srT, def.swaySpring * 0.85, def.swayDamp * 0.9, dt);

    pos.x += this._swayX.x * aimShift;
    pos.y += this._swayY.x * aimShift;
    rx += -this._swayY.x * 3.6 * aimScale;
    ry += this._swayX.x * 3.2 * aimScale;
    rz += this._swayR.x * aimScale;

    /* -- 4. bob ---------------------------------------------------------- */
    const hSpeed = Math.hypot(s.velocity.x, s.velocity.z);
    const speedNorm = Math.min(1.35, hSpeed / 6.35);
    const grounded = s.grounded !== false;
    this._bobAmount = damp(this._bobAmount, grounded ? speedNorm : 0, 7, dt);
    // Stride frequency rises with speed but sub-linearly — real gait lengthens
    // the stride as much as it quickens it.
    this._bobPhase += dt * (4.4 + Math.sqrt(Math.max(0, hSpeed)) * 2.9);
    const p = this._bobPhase;

    // Foot plant: one per half cycle. The impulse is what gives the bob its
    // weight — a pure sine reads as floating.
    const half = Math.floor(p / Math.PI);
    if (half !== this._lastPlantHalf) {
      this._lastPlantHalf = half;
      this._plant = this._bobAmount * (grounded ? 1 : 0);
    }
    this._plant = Math.max(0, this._plant - dt * 7.5);
    const plantKick = this._plant * this._plant;

    const bobAmp = this._bobAmount * def.bobScale * aimScale;
    const bobShift = this._bobAmount * def.bobScale * aimShift;
    // Figure eight: lateral at the stride rate, vertical at twice it.
    pos.x += Math.sin(p) * 0.0165 * bobShift;
    pos.y += (-Math.abs(Math.cos(p)) * 0.011 + 0.004) * bobShift - plantKick * 0.010 * def.bobScale * (1 - a * 0.75);
    pos.z += Math.sin(p * 2 + 0.6) * 0.0055 * bobShift;
    rz += Math.sin(p + 0.35) * 0.055 * bobAmp;
    rx += (Math.cos(p * 2) * 0.020 + plantKick * 0.055) * bobAmp;
    ry += Math.sin(p) * 0.030 * bobAmp;

    /* -- 5. stance ------------------------------------------------------- */
    this._sprint = damp(this._sprint, s.sprinting && !ctx.reloading ? 1 : 0, 9, dt);
    this._crouch = damp(this._crouch, s.crouching ? 1 : 0, 8, dt);
    this._mantle = damp(this._mantle, ctx.mantling ? 1 : 0, 14, dt);
    this._air = damp(this._air, grounded ? 0 : 1, 6, dt);

    const sp = this._sprint * free;
    // Sprint: the muzzle drops and the gun rolls into the shoulder — a run
    // pose, not the idle pose slid downward.
    pos.y -= sp * 0.052;
    pos.z += sp * 0.030;
    pos.x += sp * 0.024;
    rx -= sp * 0.42;
    ry += sp * 0.52;
    rz += sp * 0.46;
    // Sprint adds its own arm swing at the stride frequency.
    pos.x += Math.sin(p) * 0.014 * sp;
    rz += Math.sin(p + 0.9) * 0.10 * sp;

    // Mantle: both hands are needed on the ledge, so the weapon drops away.
    pos.y -= this._mantle * 0.16;
    pos.z += this._mantle * 0.05;
    rx -= this._mantle * 0.95;
    rz += this._mantle * 0.55;

    // Airborne: the weapon lags vertical acceleration.
    pos.y -= THREE.MathUtils.clamp(s.velocity.y, -8, 6) * 0.0022 * free;
    rx += THREE.MathUtils.clamp(s.velocity.y, -8, 6) * 0.010 * free;
    pos.y -= this._crouch * 0.006;

    /* -- 6. recoil (visual only) ---------------------------------------- */
    const rc = def.recoil;
    spring(this._kickZ, 0, rc.kickSpring, rc.kickDamp, dt);
    spring(this._kickY, 0, rc.kickSpring * 1.15, rc.kickDamp * 1.1, dt);
    spring(this._kickPitch, 0, rc.kickSpring * 0.86, rc.kickDamp * 0.95, dt);
    spring(this._kickYaw, 0, rc.kickSpring * 1.1, rc.kickDamp * 1.2, dt);
    spring(this._kickRoll, 0, rc.kickSpring * 0.9, rc.kickDamp, dt);

    // Aiming pushes the recoil into the shoulder: less swing, more straight
    // rearward travel, which is what a proper stock actually does.
    const kickSwing = THREE.MathUtils.lerp(1, 0.45, a);
    pos.z += this._kickZ.x * 0.55;
    pos.y += this._kickY.x * 0.16 * kickSwing;
    rx += this._kickPitch.x * 1.25 * kickSwing;
    ry += this._kickYaw.x * 0.9 * kickSwing;
    rz += this._kickRoll.x * 1.1 * kickSwing;

    /* -- 7. clip layer --------------------------------------------------- */
    const cp = ctx.clipPose;
    const wp = cp.weapon;
    if (wp) {
      pos.x += wp.px; pos.y += wp.py; pos.z += wp.pz;
      rx += wp.rx; ry += wp.ry; rz += wp.rz;
    }

    /* -- apply ----------------------------------------------------------- */
    w.root.position.copy(pos);
    w.root.rotation.set(rx, ry, rz, 'YXZ');

    this._applyParts(dt, ctx, cp);
    this._applyArms(dt, cp, a);
  }

  /** Moving mechanical parts: bolt, port cover, trigger, selector, magazine. */
  _applyParts(dt, ctx, cp) {
    const P = this.weapon.parts;
    const def = this.def;

    // Bolt cycle: rearward fast, forward under spring. One stroke has to fit
    // inside the cyclic interval or a high-RPM weapon looks jammed.
    if (this._boltCycle > 0) {
      const stroke = Math.min(0.055, (60 / def.rpm) * 0.85);
      this._boltCycle += dt / stroke;
      if (this._boltCycle >= 1) this._boltCycle = 0;
    }
    let boltZ = 0;
    if (this._boltCycle > 0) {
      const u = this._boltCycle;
      boltZ = u < 0.42 ? Ease.quadOut(u / 0.42) * 0.030 : (1 - Ease.quadIn((u - 0.42) / 0.58)) * 0.030;
    }
    boltZ += this._boltLock * 0.030;

    const setP = (obj, rest, node, extra) => {
      if (!obj) return;
      obj.position.set(
        rest.x + (node ? node.px : 0) + (extra?.x || 0),
        rest.y + (node ? node.py : 0) + (extra?.y || 0),
        rest.z + (node ? node.pz : 0) + (extra?.z || 0)
      );
    };
    const setR = (obj, rest, node, extra) => {
      if (!obj) return;
      obj.rotation.set(
        rest.x + (node ? node.rx : 0) + (extra?.x || 0),
        rest.y + (node ? node.ry : 0) + (extra?.y || 0),
        rest.z + (node ? node.rz : 0) + (extra?.z || 0)
      );
    };

    setP(P.mag, P.magRest, cp.mag);
    setR(P.mag, _zeroE, cp.mag);
    setP(P.bolt, P.boltRest, cp.bolt, { z: boltZ });
    setP(P.charge, P.chargeRest, cp.charge);
    setP(P.boltCatch, P.boltCatchRest, cp.boltCatch);

    // Ejection port cover: swings open on the first shot and stays open, the
    // way it does on a real rifle once the bolt has cycled past it.
    this._coverOpen = damp(this._coverOpen, this._coverOpen > 0.5 ? 1 : 0, 26, dt);
    setR(P.cover, P.coverRest, cp.cover, { z: -this._coverOpen * 1.35 });

    // Trigger: fast pull, slower reset — the reset is the part players feel.
    const wantPull = ctx.firing && !ctx.reloading ? 1 : 0;
    this._triggerPull = damp(this._triggerPull, wantPull, wantPull ? 55 : 20, dt);
    setR(P.trigger, P.triggerRest, cp.trigger, { x: -this._triggerPull * 0.34 });

    // Safety selector: rotates about its own axis to the current fire mode.
    const modeIndex = Math.max(0, def.modes.indexOf(ctx.fireMode));
    this._selector = damp(this._selector, modeIndex, 18, dt);
    setR(P.selector, P.selectorRest, cp.selector, { z: -0.6 - this._selector * 0.75 });
  }

  /** Hands ride the weapon; the clip layer moves them off it during reloads. */
  _applyArms(dt, cp, adsAmount) {
    const arms = this.arms;
    if (!arms) return;
    const R = arms.rest;
    const L = cp.left, Rr = cp.right;

    arms.left.position.set(
      R.left.pos.x + (L ? L.px : 0),
      R.left.pos.y + (L ? L.py : 0),
      R.left.pos.z + (L ? L.pz : 0)
    );
    arms.left.rotation.set(
      R.left.rot.x + (L ? L.rx : 0),
      R.left.rot.y + (L ? L.ry : 0),
      R.left.rot.z + (L ? L.rz : 0)
    );
    arms.right.position.set(
      R.right.pos.x + (Rr ? Rr.px : 0),
      R.right.pos.y + (Rr ? Rr.py : 0),
      R.right.pos.z + (Rr ? Rr.pz : 0)
    );
    arms.right.rotation.set(
      R.right.rot.x + (Rr ? Rr.rx : 0),
      R.right.rot.y + (Rr ? Rr.ry : 0),
      R.right.rot.z + (Rr ? Rr.rz : 0)
    );

    // Aiming tucks the support elbow in and pulls the arms slightly inboard so
    // they do not splay outside the frame when the optic is centred.
    arms.left.position.x -= adsAmount * 0.010;
    arms.right.position.x -= adsAmount * 0.006;
  }
}

const _zeroE = new THREE.Euler(0, 0, 0);
