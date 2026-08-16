import * as THREE from 'three';
import { Config } from '../core/Config.js';

/**
 * OWNER: VFX agent.
 *
 * GPU-instanced particles, impact decals, tracers, muzzle flash, explosions,
 * shell casings and dust. Everything is pooled — no per-shot allocation.
 *
 * Listens for: 'weapon:fire', 'hit:surface', 'hit:actor', 'fx:explosion'.
 */
export class FxModule {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'FX';
    this.tracers = null;
    this._tracerPool = [];
    this._activeTracers = [];
    this.decals = null;
    this._decalIndex = 0;
  }

  async init(engine) {
    engine.scene.add(this.root);
    this._initTracers(engine);
    this._initDecals(engine);
    this._initMuzzleFlash(engine);

    engine.bus.on('weapon:fire', (e) => this.onFire(e, engine));
    engine.bus.on('hit:surface', (e) => this.onSurfaceHit(e, engine));
    engine.bus.on('fx:explosion', (e) => this.onExplosion(e, engine));
    engine.fx = this;
  }

  _initTracers(engine) {
    const count = 64;
    const geo = new THREE.CylinderGeometry(0.008, 0.008, 1, 5, 1, true);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(4.5, 2.6, 1.0),
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.tracers = new THREE.InstancedMesh(geo, mat, count);
    this.tracers.frustumCulled = false;
    this.tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracers.count = count;
    for (let i = 0; i < count; i++) {
      _m4.makeScale(0, 0, 0);
      this.tracers.setMatrixAt(i, _m4);
      this._tracerPool.push(i);
    }
    this.tracers.instanceMatrix.needsUpdate = true;
    this.root.add(this.tracers);
  }

  _initDecals(engine) {
    const budget = Config.gfx.decalBudget;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x0a0a0c,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.decals = new THREE.InstancedMesh(geo, mat, budget);
    this.decals.frustumCulled = false;
    this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < budget; i++) {
      _m4.makeScale(0, 0, 0);
      this.decals.setMatrixAt(i, _m4);
    }
    this.decals.instanceMatrix.needsUpdate = true;
    this.root.add(this.decals);
  }

  _initMuzzleFlash(engine) {
    const mat = new THREE.SpriteMaterial({
      color: new THREE.Color(6.0, 3.4, 1.4),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      opacity: 0,
    });
    this.flash = new THREE.Sprite(mat);
    this.flash.scale.setScalar(0.14);
    this.flash.frustumCulled = false;
    engine.viewmodelScene.add(this.flash);

    this.flashLight = new THREE.PointLight(0xffcc88, 0, 12, 2);
    engine.scene.add(this.flashLight);
    this._flashTimer = 0;
  }

  onFire({ origin, direction, hit }, engine) {
    this._flashTimer = 0.045;
    const weapons = engine.get('weapons');
    if (weapons?.muzzle) {
      weapons.muzzle.getWorldPosition(this.flash.position);
      this.flash.material.rotation = Math.random() * Math.PI * 2;
      this.flash.scale.setScalar(0.10 + Math.random() * 0.07);
    }
    this.flashLight.position.copy(engine.camera.position).addScaledVector(direction, 0.6);

    const end = hit ? hit.point : _v3a.copy(origin).addScaledVector(direction, 120);
    this._spawnTracer(origin, end);
  }

  _spawnTracer(from, to) {
    const idx = this._tracerPool.pop();
    if (idx === undefined) return;
    const dist = from.distanceTo(to);
    _v3b.copy(to).add(from).multiplyScalar(0.5);
    _m4.lookAt(from, to, _up);
    const q = _q.setFromRotationMatrix(_m4);
    _m4.compose(_v3b, q, _v3c.set(1, 1, dist));
    this.tracers.setMatrixAt(idx, _m4);
    this.tracers.instanceMatrix.needsUpdate = true;
    this._activeTracers.push({ idx, life: 0.055 });
  }

  onSurfaceHit({ point, normal }, engine) {
    const i = this._decalIndex++ % this.decals.count;
    const size = 0.055 + Math.random() * 0.035;
    _v3a.copy(point).addScaledVector(normal, 0.012);
    _m4.lookAt(_zero, normal, _up);
    _q.setFromRotationMatrix(_m4);
    _q.multiply(_q2.setFromAxisAngle(_forward, Math.random() * Math.PI * 2));
    _m4.compose(_v3a, _q, _v3c.set(size, size, size));
    this.decals.setMatrixAt(i, _m4);
    this.decals.instanceMatrix.needsUpdate = true;
  }

  onExplosion({ position, radius = 5, power = 1 }, engine) {
    this._flashTimer = 0.12;
    this.flashLight.position.copy(position);
    this.flashLight.color.setRGB(1, 0.62, 0.28);
    engine.get('player')?.addShake(0.06 * power);
  }

  update(dt, engine) {
    // muzzle flash decay
    this._flashTimer = Math.max(0, this._flashTimer - dt);
    const f = this._flashTimer / 0.045;
    this.flash.material.opacity = Math.min(1, f);
    this.flashLight.intensity = f * 26;

    for (let i = this._activeTracers.length - 1; i >= 0; i--) {
      const t = this._activeTracers[i];
      t.life -= dt;
      if (t.life <= 0) {
        _m4.makeScale(0, 0, 0);
        this.tracers.setMatrixAt(t.idx, _m4);
        this.tracers.instanceMatrix.needsUpdate = true;
        this._tracerPool.push(t.idx);
        this._activeTracers.splice(i, 1);
      }
    }
  }

  dispose() {
    this.tracers?.dispose();
    this.decals?.dispose();
  }
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Vector3(0, 0, 0);
const _forward = new THREE.Vector3(0, 0, 1);
