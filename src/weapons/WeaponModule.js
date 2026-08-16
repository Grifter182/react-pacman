import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { makeMaterial } from '../materials/TextureFactory.js';

/**
 * OWNER: weapons agent.
 *
 * First-person viewmodel + ballistics. Owns:
 *   - weapon definitions (fire rate, recoil pattern, spread, damage falloff)
 *   - the viewmodel rig and all procedural animation (sway, bob, ADS blend,
 *     recoil kick, reload, sprint-lower, inspect)
 *   - hitscan / projectile resolution and the events that drive FX + audio
 *
 * Baseline is a blocked-out rifle with a working fire loop so the rest of the
 * game has something to hang off. Replace the mesh with authored geometry and
 * the animation with proper additive layers.
 */

export const WEAPONS = {
  rifle: {
    name: 'M4A1',
    rpm: 780,
    damage: 33,
    headshotMultiplier: 2.1,
    magazine: 30,
    reserve: 210,
    reloadTime: 2.1,
    reloadEmptyTime: 2.75,
    adsTime: 0.19,
    spreadHip: 0.028,
    spreadAds: 0.0035,
    recoil: { vertical: 0.0125, horizontal: 0.0052, recovery: 7.5, kick: 0.028 },
    muzzleVelocity: 880,
    falloffStart: 30,
    falloffEnd: 90,
    falloffMin: 0.55,
  },
};

export class WeaponModule {
  constructor() {
    this.current = 'rifle';
    this.ammo = WEAPONS.rifle.magazine;
    this.reserve = WEAPONS.rifle.reserve;
    this.firing = false;
    this.reloading = false;
    this._cooldown = 0;
    this._reloadTimer = 0;
    this._adsBlend = 0;
    this._recoil = new THREE.Vector2();
    this._recoilVel = new THREE.Vector2();
    this._sway = new THREE.Vector2();
    this._swayTarget = new THREE.Vector2();
    this._lastYaw = 0;
    this._lastPitch = 0;
    this.rig = new THREE.Group();
  }

  async init(engine) {
    this.player = engine.get('player');
    this.collision = engine.get('collision');
    this._buildViewmodel(engine);

    engine.bus.on('input:fire', ({ down }) => { this.firing = down; });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyR') this.startReload(engine);
    });
    engine.weapons = this;
  }

  _buildViewmodel(engine) {
    const metal = makeMaterial('metal', { repeat: 2, seed: 91, size: 256 });
    const body = new THREE.Group();

    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.085, 0.34), metal);
    receiver.position.set(0, -0.005, -0.10);
    body.add(receiver);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, 0.30, 16), metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.012, -0.35);
    body.add(barrel);

    const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.055, 0.22), metal);
    handguard.position.set(0, 0.006, -0.31);
    body.add(handguard);

    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.16), metal);
    stock.position.set(0, -0.012, 0.11);
    body.add(stock);

    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.13, 0.06), metal);
    mag.position.set(0, -0.10, -0.09);
    mag.rotation.x = 0.14;
    body.add(mag);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.10, 0.05), metal);
    grip.position.set(0, -0.085, 0.02);
    grip.rotation.x = -0.30;
    body.add(grip);

    const optic = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.046, 0.10), metal);
    optic.position.set(0, 0.066, -0.06);
    body.add(optic);

    // Muzzle reference used for tracers, flash and shell ejection.
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.012, -0.50);
    body.add(this.muzzle);

    body.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
    this.body = body;
    this.rig.add(body);
    engine.viewmodelScene.add(this.rig);

    // Hip and ADS reference poses; the animation blends between them.
    this.hipPose = { pos: new THREE.Vector3(0.155, -0.135, -0.24), rot: new THREE.Euler(0.02, 0.05, 0.01) };
    this.adsPose = { pos: new THREE.Vector3(0.0, -0.056, -0.16), rot: new THREE.Euler(0, 0, 0) };
  }

  startReload(engine) {
    const w = WEAPONS[this.current];
    if (this.reloading || this.ammo >= w.magazine || this.reserve <= 0) return;
    this.reloading = true;
    this._reloadTimer = this.ammo === 0 ? w.reloadEmptyTime : w.reloadTime;
    engine.bus.emit('weapon:reload', { weapon: this.current, phase: 'start' });
  }

  update(dt, engine) {
    const w = WEAPONS[this.current];
    const s = this.player.state;

    // --- ADS blend -------------------------------------------------------
    const adsTarget = s.ads && !this.reloading && !s.sprinting ? 1 : 0;
    const adsRate = dt / Math.max(0.01, w.adsTime);
    this._adsBlend += Math.sign(adsTarget - this._adsBlend) * Math.min(adsRate, Math.abs(adsTarget - this._adsBlend));

    // --- reload ----------------------------------------------------------
    if (this.reloading) {
      this._reloadTimer -= dt;
      if (this._reloadTimer <= 0) {
        const need = w.magazine - this.ammo;
        const take = Math.min(need, this.reserve);
        this.ammo += take; this.reserve -= take;
        this.reloading = false;
        engine.bus.emit('weapon:reload', { weapon: this.current, phase: 'end' });
      }
    }

    // --- firing ----------------------------------------------------------
    this._cooldown -= dt;
    if (this.firing && !this.reloading && this._cooldown <= 0) {
      if (this.ammo > 0) {
        this._fire(engine, w);
        this._cooldown = 60 / w.rpm;
      } else {
        this.startReload(engine);
      }
    }

    // --- recoil recovery -------------------------------------------------
    this._recoilVel.multiplyScalar(Math.max(0, 1 - w.recoil.recovery * dt));
    this._recoil.lerp(_zero2, Math.min(1, w.recoil.recovery * dt * 0.55));

    // --- sway from look input -------------------------------------------
    const dYaw = s.yaw - this._lastYaw;
    const dPitch = s.pitch - this._lastPitch;
    this._lastYaw = s.yaw; this._lastPitch = s.pitch;
    this._swayTarget.set(
      THREE.MathUtils.clamp(dYaw * 2.2, -0.05, 0.05),
      THREE.MathUtils.clamp(dPitch * 2.2, -0.05, 0.05)
    );
    this._sway.lerp(this._swayTarget, Math.min(1, dt * 9));

    this._poseViewmodel(dt, engine);
  }

  _poseViewmodel(dt, engine) {
    const s = this.player.state;
    const a = this._adsBlend;
    const smooth = a * a * (3 - 2 * a);

    const pos = _v3a.copy(this.hipPose.pos).lerp(this.adsPose.pos, smooth);
    const rotX = THREE.MathUtils.lerp(this.hipPose.rot.x, this.adsPose.rot.x, smooth);
    const rotY = THREE.MathUtils.lerp(this.hipPose.rot.y, this.adsPose.rot.y, smooth);
    const rotZ = THREE.MathUtils.lerp(this.hipPose.rot.z, this.adsPose.rot.z, smooth);

    const swayScale = 1 - smooth * 0.75;
    pos.x += this._sway.x * swayScale;
    pos.y += this._sway.y * swayScale;

    // Walk bob, damped hard while aiming
    const hSpeed = Math.hypot(s.velocity.x, s.velocity.z);
    const bobAmt = Math.min(1, hSpeed / Config.player.sprintSpeed) * (1 - smooth * 0.85);
    const t = engine.elapsed;
    pos.x += Math.cos(t * 7.0) * 0.013 * bobAmt;
    pos.y += Math.sin(t * 14.0) * 0.009 * bobAmt;

    // Sprint lower
    const sprintBlend = s.sprinting ? 1 : 0;
    this._sprint = THREE.MathUtils.lerp(this._sprint ?? 0, sprintBlend, Math.min(1, dt * 8));
    pos.y -= this._sprint * 0.075;
    pos.z += this._sprint * 0.05;

    // Reload dip
    if (this.reloading) {
      pos.y -= 0.06; pos.z += 0.02;
    }

    // Recoil pushes the model back and up
    pos.z += this._recoil.y * 0.5;
    pos.y += this._recoil.y * 0.12;

    this.body.position.copy(pos);
    this.body.rotation.set(
      rotX - this._sway.y * 1.4 * swayScale + this._recoil.y * 1.2 - this._sprint * 0.28,
      rotY - this._sway.x * 1.4 * swayScale + this._recoil.x * 0.9 + this._sprint * 0.42,
      rotZ + this._sway.x * 0.8 * swayScale + this._sprint * 0.22
    );
  }

  _fire(engine, w) {
    this.ammo--;

    const cam = engine.camera;
    const origin = cam.getWorldPosition(_v3b);
    const dir = cam.getWorldDirection(_v3c).clone();

    // Spread cone — tight when aimed, wide from the hip, wider while moving.
    const s = this.player.state;
    const moveFactor = 1 + Math.hypot(s.velocity.x, s.velocity.z) * 0.06;
    const spread = THREE.MathUtils.lerp(w.spreadHip, w.spreadAds, this._adsBlend) * moveFactor;
    const ang = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    _v3d.set(Math.cos(ang) * r, Math.sin(ang) * r, 0).applyQuaternion(cam.quaternion);
    dir.add(_v3d).normalize();

    // Recoil impulse applied to both the view and the model.
    const rc = w.recoil;
    const vKick = rc.vertical * (1 - this._adsBlend * 0.3);
    const hKick = (Math.random() - 0.5) * 2 * rc.horizontal;
    s.pitch += vKick;
    s.yaw += hKick * 0.5;
    this._recoil.x += hKick * 3;
    this._recoil.y += rc.kick;

    const hit = this.collision?.raycast(origin, dir, 400);

    engine.bus.emit('weapon:fire', {
      weapon: this.current,
      origin: this.muzzle.getWorldPosition(new THREE.Vector3()),
      direction: dir.clone(),
      hit,
    });

    if (hit) {
      engine.bus.emit('hit:surface', {
        point: hit.point.clone(),
        normal: hit.normal.clone(),
        material: hit.object?.material?.userData?.preset || 'concrete',
        impulse: 1,
      });
    }

    engine.bus.emit('audio:play', { id: 'rifle_fire', position: null, volume: 1 });
    this.player.addShake(0.004);
  }

  dispose() {}
}

const _zero2 = new THREE.Vector2(0, 0);
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _v3d = new THREE.Vector3();
