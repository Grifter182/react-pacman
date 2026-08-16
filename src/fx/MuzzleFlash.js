import * as THREE from 'three';
import { buildFlashTexture, PT } from './FxTextures.js';
import { LAYER, P, resetP } from './ParticleSystem.js';

/**
 * OWNER: VFX agent.
 *
 * The muzzle flash is four separate phenomena and looks wrong when it is drawn
 * as one sprite:
 *
 *   1. the *flash* proper — unburnt powder igniting outside the crown, a hot
 *      star whose lobes land differently on every shot;
 *   2. the *core bloom* — the overexposed disc at the crown itself;
 *   3. the *gas cone* — a short cone of luminous propellant gas along the bore,
 *      which is bore-aligned and therefore must not be camera facing;
 *   4. the *smoke* — a slow puff that survives the flash by two orders of
 *      magnitude in time, and belongs in the world, not on the viewmodel.
 *
 * The first three live in the viewmodel scene, which is drawn after the post
 * stack over a cleared depth buffer, so they are built from three's own
 * materials (they need the tonemap and colour-space chunks the post stack
 * would otherwise have applied). The smoke and the heat shimmer are world
 * particles emitted at the muzzle's world position — the viewmodel camera
 * tracks the player camera exactly, so that position is directly usable.
 *
 * THE FLASH MUST SURVIVE AT LEAST ONE RENDERED FRAME
 * ---------------------------------------------------
 * A 45 ms flash decayed by `dt` is not a flash at all when `dt` is 160 ms: the
 * envelope reaches zero inside the same frame it was triggered, so the star,
 * the core and the gas cone are all drawn at opacity 0 and the shot leaves no
 * trace on screen. That is not a hypothetical — it is why the captured firing
 * frames had no muzzle flash. The envelope below is therefore driven by time
 * *and* by a rendered-frame counter, and cannot complete before the flash has
 * actually been photographed twice.
 */
export class MuzzleFlash {
  constructor(engine) {
    this.engine = engine;
    this.root = new THREE.Group();
    this.root.name = 'FxMuzzleFlash';
    this.root.frustumCulled = false;
    // Parented to the viewmodel camera and driven by the muzzle's transform
    // *relative to that camera*. Both matrices come from the same traversal, so
    // the flash cannot slip by a frame if another module syncs the viewmodel
    // camera after this one runs.
    this.camera = engine.viewmodelCamera || null;
    (this.camera || engine.viewmodelScene).add(this.root);

    this.starTex = buildFlashTexture(128, 'star');
    this.coreTex = buildFlashTexture(96, 'core');
    this.coneTex = buildFlashTexture(96, 'cone');

    // Star and core are camera facing — the flash is a ball of burning gas and
    // has no preferred orientation.
    this.star = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.starTex,
      color: new THREE.Color(3.6, 2.1, 0.95),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      opacity: 1,
    }));
    this.star.frustumCulled = false;
    this.star.renderOrder = 20;
    this.root.add(this.star);

    this.core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.coreTex,
      color: new THREE.Color(5.5, 3.6, 2.2),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      opacity: 1,
    }));
    this.core.frustumCulled = false;
    this.core.renderOrder = 21;
    this.root.add(this.core);

    // Gas cone: two crossed bore-aligned cards. A cone mesh would silhouette
    // against itself at the tip; crossed cards read as volume from any angle
    // for four triangles.
    const cardGeo = new THREE.PlaneGeometry(1, 1);
    cardGeo.translate(0, 0.5, 0);            // pivot at the crown
    cardGeo.rotateX(-Math.PI / 2);           // extend along -Z (the bore)
    const coneMat = new THREE.MeshBasicMaterial({
      map: this.coneTex,
      color: new THREE.Color(2.8, 1.5, 0.6),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    this.coneMat = coneMat;
    this.cards = [];
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(cardGeo, coneMat);
      m.rotation.z = i * Math.PI * 0.5;
      m.frustumCulled = false;
      m.renderOrder = 19;
      this.root.add(m);
    }
    this.cardGeo = cardGeo;

    this.live = false;
    this.age = 0;
    this.frames = 0;
    this.duration = 0.055;
    this.heat = 0;               // barrel heat, 0..1 — drives smoke
    this._scale = 1;
    this._coneScale = 1;
    this.root.visible = false;
  }

  /**
   * @param {THREE.Vector3} worldPos muzzle position
   * @param {THREE.Vector3} dir      bore direction
   * @param {object} particles       ParticleSystem
   * @param {object} [def]           weapon definition (for calibre-ish scaling)
   */
  fire(worldPos, dir, particles, def) {
    // Per-shot variation. Powder that has not finished burning is the flash, so
    // its size is genuinely random shot to shot — a constant-size flash is one
    // of the tells of a cheap gun effect.
    const bore = def && def.damage ? THREE.MathUtils.clamp(def.damage / 34, 0.7, 1.5) : 1;
    const v = 0.75 + Math.random() * 0.6;
    this._scale = 0.105 * bore * v;
    this._coneScale = 0.19 * bore * (0.7 + Math.random() * 0.7);
    this.duration = 0.052 + Math.random() * 0.030;
    this.age = 0;
    this.frames = 0;
    this.live = true;

    this.star.material.rotation = Math.random() * Math.PI * 2;
    this.core.material.rotation = Math.random() * Math.PI * 2;
    for (let i = 0; i < this.cards.length; i++) {
      this.cards[i].rotation.z = Math.random() * Math.PI + i * Math.PI * 0.5;
    }
    this.root.visible = true;

    this.heat = Math.min(1, this.heat + 0.13);
    this._emitWorld(worldPos, dir, particles);
    this._light(worldPos, dir, bore);
  }

  /**
   * The shot's own light on the world.
   *
   * LightingModule also spawns one off 'weapon:fire' — at 26 cd for 55 ms,
   * which is under a tenth of the key's irradiance two metres out and expires
   * inside a single slow frame. This one is sized against the sun (the key is
   * ~19 in the same units) and lives long enough to be seen: a flash that does
   * not touch the wall beside you is a decal on the lens, not a light.
   */
  _light(pos, dir, bore) {
    const pool = this.engine && this.engine.dynamicLights;
    if (!pool) return;
    // Sat a little forward of the crown: the gas ball that emits the light is
    // outside the barrel, and offsetting it stops the near clip of the
    // viewmodel from being the brightest thing in the scene.
    _lp.copy(pos).addScaledVector(dir, 0.22);
    pool.spawn({
      position: _lp,
      color: 0xffc98a,
      intensity: (52 + Math.random() * 22) * bore,
      radius: 13 * bore,
      // 0.055 s was both too short to read at 60 fps and too short to survive
      // a capture. ~0.1 s with the pool's quadratic decay is one clear pulse.
      life: 0.105,
    });
  }

  /** Smoke, blow-by dust and shimmer — these live in the world, not the gun. */
  _emitWorld(pos, dir, particles) {
    // Muzzle blast pushes a low, fast puff forward that a hot barrel turns into
    // a lingering wisp.
    const puffs = 1 + (Math.random() < 0.4 + this.heat * 0.5 ? 1 : 0);
    for (let i = 0; i < puffs; i++) {
      resetP();
      P.x = pos.x + dir.x * 0.12; P.y = pos.y + dir.y * 0.12; P.z = pos.z + dir.z * 0.12;
      const sp = 1.6 + Math.random() * 2.4;
      P.vx = dir.x * sp + (Math.random() - 0.5) * 0.5;
      P.vy = dir.y * sp + (Math.random() - 0.5) * 0.5 + 0.25;
      P.vz = dir.z * sp + (Math.random() - 0.5) * 0.5;
      P.life = 0.5 + Math.random() * 0.9 + this.heat * 0.8;
      P.drag = 3.4;
      P.gravity = -0.04;
      P.turbulence = 0.35;
      P.lit = 1;
      P.size0 = 0.065 + Math.random() * 0.055;
      P.size1 = P.size0 * (5 + this.heat * 4);
      P.spin = (Math.random() - 0.5) * 2.2;
      // Powder smoke off a rifle is thin but it is not invisible, and it is the
      // only part of the shot that is still on screen a second later.
      P.alpha = 0.20 + this.heat * 0.22;
      P.tile = Math.random() < 0.5 ? PT.SMOKE : PT.WISP;
      P.fade = 1.7;
      P.soft = 0.35;
      P.r0 = 0.55; P.g0 = 0.54; P.b0 = 0.52;
      P.r1 = 0.32; P.g1 = 0.32; P.b1 = 0.33;
      particles.spawn(LAYER.ALPHA);
    }

    // A few burning grains thrown clear of the crown.
    const grains = 4 + ((Math.random() * 5) | 0);
    for (let i = 0; i < grains; i++) {
      resetP();
      P.x = pos.x; P.y = pos.y; P.z = pos.z;
      const sp = 3 + Math.random() * 7;
      P.vx = dir.x * sp + (Math.random() - 0.5) * 3;
      P.vy = dir.y * sp + (Math.random() - 0.5) * 3;
      P.vz = dir.z * sp + (Math.random() - 0.5) * 3;
      P.life = 0.12 + Math.random() * 0.22;
      P.drag = 2.2; P.gravity = 0.8;
      P.size0 = 0.013 + Math.random() * 0.012;
      P.size1 = P.size0 * 0.4;
      P.stretch = 0.038;
      P.alpha = 1; P.tile = PT.SPARK; P.fade = 1.2; P.soft = 0;
      P.r0 = 5.0; P.g0 = 2.6; P.b0 = 0.8;
      P.r1 = 1.2; P.g1 = 0.25; P.b1 = 0.05;
      particles.spawn(LAYER.ADDITIVE);
    }

    // Heat shimmer over the crown.
    resetP();
    P.x = pos.x + dir.x * 0.16; P.y = pos.y + dir.y * 0.16 + 0.03; P.z = pos.z + dir.z * 0.16;
    P.vx = dir.x * 0.7; P.vy = 0.55; P.vz = dir.z * 0.7;
    P.life = 0.28; P.drag = 2.6; P.turbulence = 0.5;
    P.size0 = 0.10; P.size1 = 0.34;
    P.alpha = 0.5; P.tile = PT.SMOKE; P.fade = 1.3; P.soft = 0.25;
    // The haze shader has no colour of its own — it reads the colour keys as
    // the ripple's phase offsets, so randomising them decorrelates overlapping
    // shimmer quads.
    P.r0 = P.r1 = Math.random(); P.g0 = P.g1 = Math.random();
    particles.spawn(LAYER.HAZE);
  }

  /**
   * Called from lateUpdate: the weapon rig has already been animated this frame
   * but its world matrices are only refreshed later, so force the chain here.
   */
  update(dt, engine) {
    this.heat = Math.max(0, this.heat - dt * 0.55);
    if (!this.live) {
      if (this.root.visible) this.root.visible = false;
      return;
    }

    const weapons = engine.get('weapons');
    const muzzle = weapons && weapons.muzzle;
    if (!muzzle) { this.root.visible = false; this.live = false; return; }
    muzzle.updateWorldMatrix(true, false);
    if (this.camera) {
      _m4.copy(this.camera.matrixWorld).invert().multiply(muzzle.matrixWorld);
      _m4.decompose(this.root.position, this.root.quaternion, _s);
    } else {
      muzzle.matrixWorld.decompose(this.root.position, this.root.quaternion, _s);
    }

    // Fast attack, fast decay. The star peaks a hair after the core, which is
    // what gives the flash a shape rather than a single pop.
    //
    // The envelope is clamped by the number of frames actually rendered until
    // two have gone by, so the first photographed frame is always the peak and
    // the second is always the mid-decay — no matter how long `dt` is. Past
    // two frames the clamp is inert and the flash is purely time-driven again.
    let u = this.age / this.duration;
    if (this.frames < 2) u = Math.min(u, this.frames * 0.5);
    u = u < 0 ? 0 : (u > 1 ? 1 : u);
    this.frames++;
    this.age += dt;
    if (u >= 1) this.live = false;

    const core = Math.pow(1 - u, 1.5);
    // The star lags the core by a fraction of the flash: the powder outside the
    // crown ignites after the crown itself is already blown out.
    // ...but it must not START at zero, or a frame captured at the peak shows
    // a bare core and none of the shape.
    const star = Math.min(0.55 + u / 0.18, 1) * Math.pow(1 - u, 1.8);

    this.core.material.opacity = core;
    this.core.scale.setScalar(this._scale * (0.65 + 0.5 * core));
    this.star.material.opacity = star;
    this.star.scale.setScalar(this._scale * (1.4 + 1.1 * u));

    const gas = Math.pow(1 - u, 2.2);
    this.coneMat.opacity = gas * 0.9;
    for (const c of this.cards) {
      // The card's length runs along local -Z (the bore); X is its width.
      c.scale.set(this._coneScale * (0.55 + 0.45 * gas), 1, this._coneScale * (0.8 + 1.6 * u));
    }
  }

  dispose() {
    this.starTex.dispose();
    this.coreTex.dispose();
    this.coneTex.dispose();
    this.star.material.dispose();
    this.core.material.dispose();
    this.coneMat.dispose();
    this.cardGeo.dispose();
    this.root.removeFromParent();
  }
}

const _s = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _lp = new THREE.Vector3();
