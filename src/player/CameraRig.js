import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { Trauma } from './Trauma.js';

/**
 * OWNER: player-feel agent.
 *
 * The camera is not bolted to the capsule. It is a mass on a stiff spring that
 * *chases* the eye point, and every impulse in the game — landing, a step-up, a
 * slide, recoil, an explosion — is injected as a velocity into that spring
 * rather than as a position offset. That single decision is what makes weight
 * read: the head keeps moving after the body stops.
 *
 * Layers, in the order they are summed:
 *   1. spring position        (weight, landings, step smoothing)
 *   2. gait bob               (foot-plant timed, figure-eight, not a sine)
 *   3. landing dip            (spring velocity impulse, impact-proportional)
 *   4. strafe roll            (lateral velocity, damped)
 *   5. breathing sway         (ADS only; grows with damage and fatigue)
 *   6. mantle arc             (pitch/roll/offset following the vault)
 *   7. trauma shake           (see Trauma.js)
 *
 * Nothing here writes back into `state.pitch/yaw` — the weapon module owns
 * those and reconciles recoil against them. All view motion is additive at the
 * camera, so aim stays exactly where the player put it.
 */
export class CameraRig {
  constructor(state, controller, input) {
    this.state = state;
    this.ctrl = controller;
    this.input = input;
    this.trauma = new Trauma();

    this._pos = new THREE.Vector3();       // spring position (world)
    this._vel = new THREE.Vector3();       // spring velocity
    this._target = new THREE.Vector3();
    this._initialised = false;

    this._pendingStep = 0;
    this._bobPhase = 0;
    this._bobAmount = 0;
    this._lastPlantHalf = 0;
    this._plant = 0;
    this._plantVis = 0;
    this._roll = 0; this._rollV = 0;
    this._pitchOff = 0; this._pitchOffV = 0;
    this._fov = Config.camera.fovBase;
    this._breath = 0;
    this._fatigue = 0;
    this._sprintTime = 0;
    this._mantleBlend = 0;

    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._tmp = new THREE.Vector3();

    /**
     * Front-end crane shot. Off during play; the HUD turns it on with the
     * title screen so the menu has a living backdrop instead of a still.
     */
    this.cinematic = false;
    this.cinematicPhase = 1.9;             // start looking down the main street
    this.cinematicShot = {
      centre: new THREE.Vector3(0, 1.6, 6),
      radius: 26,
      radiusSwing: 4.5,
      height: 9.5,
      heightSwing: 1.6,
      lookLift: 2.2,
      fov: 46,                             // longer lens than gameplay: compresses the souk
    };
  }

  /** Landing: impact speed becomes downward spring velocity plus trauma. */
  onLand(impact) {
    const w = THREE.MathUtils.clamp((impact - 2.2) / 12, 0, 1.6);
    this._vel.y -= 1.35 * w + 0.25;
    this.trauma.add(Math.min(0.5, w * 0.34));
    this._pitchOffV += w * 0.9;
  }

  onStep(offset) { this._pendingStep += offset; }

  reset(position) {
    this._pos.copy(position);
    this._vel.set(0, 0, 0);
    this._pendingStep = 0;
    this._bobPhase = 0;
    this._roll = this._rollV = 0;
    this._pitchOff = this._pitchOffV = 0;
    this.trauma.reset();
    this._initialised = true;
  }

  /**
   * @param ctx { adsBlend, health, maxHealth, suppression }
   */
  update(dt, engine, ctx) {
    const s = this.state;
    const P = Config.player, C = Config.camera;
    const set = this.input.settings;
    const ads = ctx.adsBlend;

    /* --- 1. eye target ---------------------------------------------------- */
    const footY = s.position.y - this.ctrl.halfHeight;
    this._target.set(s.position.x, footY + this.ctrl.eyeHeight, s.position.z);

    if (!this._initialised) { this.reset(this._target); }

    // A step-up teleports the capsule; the camera is pushed back down by the
    // same amount and springs up over ~120 ms. Stairs stop strobing.
    if (this._pendingStep !== 0) {
      this._pos.y -= THREE.MathUtils.clamp(this._pendingStep, -P.stepHeight, P.stepHeight);
      this._pendingStep = 0;
    }

    /* --- 2. spring -------------------------------------------------------- */
    // Critically damped, stiffer vertically than laterally: the head resists
    // bouncing sideways far more than it resists bobbing.
    const grounded = s.grounded;
    const fH = grounded ? 13.5 : 16.0;
    const fV = grounded ? 11.0 : 15.0;
    this._springAxis('x', this._target.x, fH, 1.0, dt);
    this._springAxis('z', this._target.z, fH, 1.0, dt);
    this._springAxis('y', this._target.y, fV, 0.86, dt);   // slightly underdamped: it settles with one small overshoot

    /* --- 3. gait bob ------------------------------------------------------ */
    const hSpeed = Math.hypot(s.velocity.x, s.velocity.z);
    const sprintMax = P.sprintSpeed;
    const bobTarget = grounded && !s.sliding ? Math.min(1.25, hSpeed / sprintMax) : 0;
    this._bobAmount += (bobTarget - this._bobAmount) * Math.min(1, dt * 7);

    // Stride frequency rises sub-linearly with speed: real gait lengthens the
    // stride about as much as it quickens it.
    const stride = 3.6 + Math.sqrt(Math.max(0, hSpeed)) * 2.35;
    this._bobPhase += dt * stride * (this._bobAmount > 0.02 ? 1 : 0);

    const half = Math.floor(this._bobPhase / Math.PI);
    if (half !== this._lastPlantHalf && this._bobAmount > 0.10) {
      this._lastPlantHalf = half;
      this._plant = this._bobAmount;
      // Foot plants are where footstep audio and the vertical impulse belong;
      // firing them off a timer instead is what makes bob look pasted on.
      this._vel.y -= 0.10 * this._bobAmount * (s.crouching ? 0.45 : 1);
      engine.bus.emit('player:footstep', {
        position: s.position, speed: hSpeed,
        foot: (half & 1) ? 'left' : 'right',
        stance: s.prone ? 'prone' : s.crouching ? 'crouch' : s.sprinting ? 'sprint' : 'walk',
      });
      engine.bus.emit('audio:play', {
        id: 'footstep', position: null,
        volume: 0.10 + Math.min(0.30, hSpeed * 0.045) * (s.crouching ? 0.4 : 1),
        pitch: 0.9 + Math.random() * 0.2,
      });
    }
    this._plant = Math.max(0, this._plant - dt * 8);
    this._plantVis += (this._plant * this._plant - this._plantVis) * Math.min(1, dt * 20);

    const bobScale = set.bobScale * THREE.MathUtils.lerp(1, 0.22, ads) * (s.sliding ? 0.15 : 1);
    const amp = this._bobAmount * bobScale;
    const p = this._bobPhase;
    // Figure eight: lateral at the stride rate, vertical at twice it. The
    // vertical term is |cos| rather than cos so the head dips on *both* plants.
    const bobX = Math.sin(p) * 0.026 * amp;
    const bobY = -Math.abs(Math.cos(p)) * 0.020 * amp - this._plantVis * 0.012;
    const bobRoll = Math.sin(p + 0.5) * 0.0085 * amp;

    /* --- 4. strafe roll and pitch lag ------------------------------------- */
    const sin = Math.sin(s.yaw), cos = Math.cos(s.yaw);
    // Lateral velocity in view space: +x is to the player's right.
    const lateral = s.velocity.x * cos - s.velocity.z * sin;
    const forward = -s.velocity.x * sin - s.velocity.z * cos;
    const rollTarget = THREE.MathUtils.clamp(-lateral / sprintMax, -1, 1)
      * 0.031 * THREE.MathUtils.lerp(1, 0.35, ads);
    this._rollV += (rollTarget - this._roll) * 88 * dt;
    this._rollV *= Math.max(0, 1 - 13 * dt);
    this._roll += this._rollV * dt;

    this._pitchOffV *= Math.max(0, 1 - 11 * dt);
    this._pitchOff += this._pitchOffV * dt;
    this._pitchOff += (0 - this._pitchOff) * Math.min(1, dt * 9);
    // Acceleration lag: the head tips back as you accelerate away.
    const accelPitch = THREE.MathUtils.clamp(forward / sprintMax, -1, 1) * 0.010;

    /* --- 5. breathing sway ------------------------------------------------ */
    // Two incommensurate rates so it never visibly loops; amplitude scales with
    // how hurt and how winded the player is. Aiming steadies it, never freezes it.
    this._sprintTime = s.sprinting ? Math.min(6, this._sprintTime + dt) : Math.max(0, this._sprintTime - dt * 0.55);
    const hurt = 1 - THREE.MathUtils.clamp(ctx.health / ctx.maxHealth, 0, 1);
    this._fatigue += ((this._sprintTime / 6) * 0.7 + hurt * 0.9 - this._fatigue) * Math.min(1, dt * 1.4);
    this._breath += dt * (1.05 + this._fatigue * 1.5);
    const bAmp = (0.0022 + this._fatigue * 0.0075) * ads + (ctx.suppression || 0) * 0.004;
    const swayYaw = (Math.sin(this._breath * 1.37) * 0.62 + Math.sin(this._breath * 0.71 + 2.1) * 0.38) * bAmp;
    const swayPitch = (Math.sin(this._breath * 1.91 + 1.3) * 0.55 + Math.sin(this._breath * 0.93) * 0.45) * bAmp * 0.8;

    /* --- 6. mantle arc ---------------------------------------------------- */
    const mp = this.ctrl.mantleProgress;
    const mantling = mp >= 0;
    this._mantleBlend += ((mantling ? 1 : 0) - this._mantleBlend) * Math.min(1, dt * 14);
    let mPitch = 0, mRoll = 0, mLift = 0;
    if (this._mantleBlend > 1e-3) {
      const u = mantling ? mp : 1;
      // Look down at the ledge on the pull, level out on the push-off; the
      // slight roll is the free hand taking the weight.
      mPitch = -Math.sin(u * Math.PI) * 0.19 + Math.sin(u * Math.PI * 2) * 0.05;
      mRoll = Math.sin(u * Math.PI) * 0.075;
      mLift = -Math.sin(u * Math.PI) * 0.085;
      mPitch *= this._mantleBlend; mRoll *= this._mantleBlend; mLift *= this._mantleBlend;
    }

    /* --- 7. trauma -------------------------------------------------------- */
    this.trauma.scale = set.shakeScale;
    this.trauma.update(dt);
    const tr = this.trauma;

    const cam = engine.camera;

    /* --- cinematic idle --------------------------------------------------- */
    // While the front end is up there is no player to follow, so the camera
    // becomes a slow crane shot over the map instead of standing still. A
    // static menu backdrop reads as a screenshot; drifting parallax reads as a
    // place. Driven entirely from elapsed time so it needs no state and cannot
    // desync, and it returns the camera to the player the moment it is off.
    if (this.cinematic) {
      const t = engine.elapsed * 0.045 + this.cinematicPhase;
      const c = this.cinematicShot;
      const orbit = c.radius + Math.sin(t * 0.6) * c.radiusSwing;
      cam.position.set(
        c.centre.x + Math.sin(t) * orbit,
        c.height + Math.sin(t * 0.83) * c.heightSwing,
        c.centre.z + Math.cos(t) * orbit,
      );
      // Look slightly above the focus so the frame carries sky and roofline,
      // which is where the silhouette detail is.
      _look.set(c.centre.x, c.centre.y + c.lookLift, c.centre.z);
      cam.lookAt(_look);
      const vmc = engine.viewmodelCamera;
      vmc.position.copy(cam.position);
      vmc.quaternion.copy(cam.quaternion);
      if (Math.abs(cam.fov - c.fov) > 0.01) { cam.fov = c.fov; cam.updateProjectionMatrix(); }
      return;
    }

    /* --- compose ---------------------------------------------------------- */
    // Bob is in view space; rotate it into the world by yaw.
    const worldBobX = bobX * cos;
    const worldBobZ = -bobX * sin;
    cam.position.set(
      this._pos.x + worldBobX + tr.offset.x,
      this._pos.y + bobY + mLift + tr.offset.y,
      this._pos.z + worldBobZ + tr.offset.z,
    );

    this._e.set(
      s.pitch + this._pitchOff + accelPitch + swayPitch + mPitch + tr.rot.x,
      s.yaw + swayYaw + tr.rot.y,
      this._roll + bobRoll + mRoll + tr.rot.z,
      'YXZ',
    );
    cam.quaternion.setFromEuler(this._e);

    /* --- FOV -------------------------------------------------------------- */
    let targetFov = set.fov;
    if (s.sprinting) targetFov += C.fovSprintAdd * Math.min(1, this._bobAmount);
    if (s.sliding) targetFov += 6.5;
    // A slow lerp on the ADS transition fights the animator; match its curve by
    // scaling directly off the blend the weapon reports.
    targetFov *= THREE.MathUtils.lerp(1, C.fovAdsScale, ads);
    const fovRate = ads > 0.01 ? 30 : 9;
    this._fov += (targetFov - this._fov) * Math.min(1, dt * fovRate);
    if (Math.abs(cam.fov - this._fov) > 0.005) {
      cam.fov = this._fov;
      cam.updateProjectionMatrix();
    }

    const vm = engine.viewmodelCamera;
    vm.position.copy(cam.position);
    vm.quaternion.copy(cam.quaternion);
    const vmFov = set.viewmodelFov * THREE.MathUtils.lerp(1, 0.86, ads);
    if (Math.abs(vm.fov - vmFov) > 0.005) { vm.fov = vmFov; vm.updateProjectionMatrix(); }
  }

  /**
   * One axis of a damped harmonic oscillator, integrated semi-implicitly.
   * `f` is the undamped frequency in Hz-ish units, `zeta` the damping ratio
   * (1 = critical). Semi-implicit Euler is stable here for any frame time the
   * engine will hand us because the engine clamps dt to 250 ms.
   */
  _springAxis(axis, target, f, zeta, dt) {
    const omega = f;
    const x = this._pos[axis] - target;
    const v = this._vel[axis];
    const a = -omega * omega * x - 2 * zeta * omega * v;
    const nv = v + a * dt;
    this._vel[axis] = nv;
    this._pos[axis] += nv * dt;
    // Hard leash: the camera may lag, but it may never leave the head.
    const d = this._pos[axis] - target;
    if (d > 0.35) { this._pos[axis] = target + 0.35; this._vel[axis] = 0; }
    else if (d < -0.35) { this._pos[axis] = target - 0.35; this._vel[axis] = 0; }
  }
}

/** Scratch for the cinematic look-at target; allocated once. */
const _look = new THREE.Vector3();
