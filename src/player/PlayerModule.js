import * as THREE from 'three';
import { Config } from '../core/Config.js';

/**
 * OWNER: player-feel agent.
 *
 * Input, camera, and the capsule character controller. Everything that makes
 * movement *feel* right lives here: acceleration curves, air control, step-up,
 * crouch/slide, mantling, view bob, landing dip, camera shake, FOV kick.
 *
 * Publishes on the bus: 'player:spawn', 'player:died', 'player:damaged'.
 * Exposes `this.state` which WeaponModule and HudModule read:
 *   { position, velocity, yaw, pitch, grounded, sprinting, crouching, ads, health }
 */
export class PlayerModule {
  constructor() {
    this.state = {
      position: new THREE.Vector3(0, 1.0, 34),
      velocity: new THREE.Vector3(),
      yaw: Math.PI,
      pitch: 0,
      grounded: false,
      sprinting: false,
      crouching: false,
      ads: false,
      health: 100,
      maxHealth: 100,
      alive: true,
    };
    this.keys = new Set();
    this._pointerLocked = false;
    this._bobPhase = 0;
    this._bobAmount = 0;
    this._landDip = 0;
    this._shake = new THREE.Vector3();
    this._fov = Config.camera.fovBase;
    this._eyeHeight = Config.player.eyeHeight;
    this._coyote = 0;
    this._jumpBuffer = 0;
  }

  async init(engine) {
    this.collision = engine.get('collision');
    const level = engine.get('level');
    if (level) {
      const s = level.pickSpawn(0);
      this.state.position.copy(s.position).setY(Config.player.height * 0.5 + 0.05);
      this.state.yaw = s.yaw;
    }
    this._bindInput(engine);
    engine.player = this;
    engine.bus.emit('player:spawn', { position: this.state.position, yaw: this.state.yaw });
  }

  _bindInput(engine) {
    const canvas = engine.canvas;
    const onKey = (e, down) => {
      const k = e.code;
      if (down) this.keys.add(k); else this.keys.delete(k);
      if (down && (k === 'Space' || k.startsWith('Arrow'))) e.preventDefault();
      if (down && k === 'Space') this._jumpBuffer = 0.14;
    };
    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));

    canvas.addEventListener('click', () => {
      if (!this._pointerLocked) canvas.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this._pointerLocked = document.pointerLockElement === canvas;
      engine.bus.emit('ui:pointerlock', { locked: this._pointerLocked });
    });
    window.addEventListener('mousemove', (e) => {
      if (!this._pointerLocked) return;
      const sens = Config.input.sensitivity * (this.state.ads ? Config.input.adsSensScale : 1);
      this.state.yaw -= e.movementX * sens;
      this.state.pitch -= e.movementY * sens * (Config.input.invertY ? -1 : 1);
      const lim = Math.PI / 2 - 0.008;
      this.state.pitch = Math.max(-lim, Math.min(lim, this.state.pitch));
    });
    window.addEventListener('mousedown', (e) => {
      if (!this._pointerLocked) return;
      if (e.button === 0) engine.bus.emit('input:fire', { down: true });
      if (e.button === 2) { this.state.ads = true; engine.bus.emit('input:ads', { down: true }); }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) engine.bus.emit('input:fire', { down: false });
      if (e.button === 2) { this.state.ads = false; engine.bus.emit('input:ads', { down: false }); }
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  fixedUpdate(dt, engine) {
    const s = this.state;
    const P = Config.player;
    if (!s.alive) return;

    const fwd = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    s.crouching = this.keys.has('ControlLeft') || this.keys.has('KeyC');
    s.sprinting = this.keys.has('ShiftLeft') && fwd > 0 && !s.crouching && !s.ads;

    // Desired horizontal velocity in world space
    const sin = Math.sin(s.yaw), cos = Math.cos(s.yaw);
    let wishX = strafe * cos - fwd * sin;
    let wishZ = -strafe * sin - fwd * cos;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1e-4) { wishX /= wishLen; wishZ /= wishLen; }

    let speed = P.walkSpeed;
    if (s.sprinting) speed = P.sprintSpeed;
    else if (s.crouching) speed = P.crouchSpeed;
    if (s.ads) speed *= P.adsSpeedScale;

    const accel = s.grounded ? P.accelGround : P.accelAir;
    const targetX = wishX * speed, targetZ = wishZ * speed;
    s.velocity.x += (targetX - s.velocity.x) * Math.min(1, accel * dt / Math.max(speed, 1));
    s.velocity.z += (targetZ - s.velocity.z) * Math.min(1, accel * dt / Math.max(speed, 1));

    if (s.grounded && wishLen < 1e-4) {
      const f = Math.max(0, 1 - P.friction * dt);
      s.velocity.x *= f; s.velocity.z *= f;
    }

    // Gravity + jump with coyote time and input buffering
    s.velocity.y -= P.gravity * dt;
    this._coyote = s.grounded ? 0.12 : Math.max(0, this._coyote - dt);
    this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);
    if (this._jumpBuffer > 0 && this._coyote > 0) {
      s.velocity.y = P.jumpVelocity;
      this._jumpBuffer = 0; this._coyote = 0; s.grounded = false;
    }

    const wasGrounded = s.grounded;
    const prevVy = s.velocity.y;

    s.position.addScaledVector(s.velocity, dt);

    const halfHeight = P.height * 0.5;
    const res = this.collision?.capsuleResolve(s.position, P.radius, halfHeight) || { grounded: false };
    s.grounded = res.grounded;
    if (res.grounded && s.velocity.y < 0) s.velocity.y = 0;

    if (!wasGrounded && s.grounded && prevVy < -4) {
      this._landDip = Math.min(0.16, -prevVy * 0.012);
      engine.bus.emit('player:land', { impact: -prevVy });
    }

    // Floor guard so a physics hiccup can never drop the player out of the map.
    if (s.position.y < -20) {
      s.position.set(0, 2, 34); s.velocity.set(0, 0, 0);
    }
  }

  update(dt, engine) {
    const s = this.state;
    const P = Config.player, C = Config.camera;

    // Eye height with smooth crouch
    const targetEye = s.crouching ? P.crouchEyeHeight : P.eyeHeight;
    this._eyeHeight += (targetEye - this._eyeHeight) * Math.min(1, dt * 12);

    // View bob driven by actual horizontal speed
    const hSpeed = Math.hypot(s.velocity.x, s.velocity.z);
    const bobTarget = s.grounded ? Math.min(1, hSpeed / P.sprintSpeed) : 0;
    this._bobAmount += (bobTarget - this._bobAmount) * Math.min(1, dt * 8);
    this._bobPhase += dt * (6.0 + hSpeed * 1.15);
    const bobY = Math.sin(this._bobPhase * 2) * 0.022 * this._bobAmount * (s.ads ? 0.25 : 1);
    const bobX = Math.cos(this._bobPhase) * 0.028 * this._bobAmount * (s.ads ? 0.2 : 1);
    const bobRoll = Math.cos(this._bobPhase) * 0.008 * this._bobAmount;

    this._landDip *= Math.max(0, 1 - dt * 9);
    this._shake.multiplyScalar(Math.max(0, 1 - dt * 11));

    // FOV: sprint widens, ADS narrows
    let targetFov = C.fovBase;
    if (s.sprinting) targetFov += C.fovSprintAdd * this._bobAmount;
    if (s.ads) targetFov = C.fovBase * C.fovAdsScale;
    this._fov += (targetFov - this._fov) * Math.min(1, dt * 11);

    const cam = engine.camera;
    cam.position.set(
      s.position.x + bobX + this._shake.x,
      s.position.y - P.height * 0.5 + this._eyeHeight + bobY - this._landDip + this._shake.y,
      s.position.z + this._shake.z
    );
    cam.rotation.set(s.pitch, s.yaw, bobRoll + this._shake.z * 0.4, 'YXZ');
    if (Math.abs(cam.fov - this._fov) > 0.01) {
      cam.fov = this._fov;
      cam.updateProjectionMatrix();
    }

    engine.viewmodelCamera.position.copy(cam.position);
    engine.viewmodelCamera.quaternion.copy(cam.quaternion);
  }

  addShake(intensity) {
    this._shake.set(
      (Math.random() - 0.5) * intensity,
      (Math.random() - 0.5) * intensity,
      (Math.random() - 0.5) * intensity * 0.6
    );
  }

  damage(amount, from, engine) {
    const s = this.state;
    if (!s.alive) return;
    s.health = Math.max(0, s.health - amount);
    this.engine?.bus.emit('player:damaged', { amount, from });
    if (s.health <= 0) {
      s.alive = false;
      this.engine?.bus.emit('player:died', { by: from, position: s.position.clone() });
    }
  }

  dispose() {}
}
