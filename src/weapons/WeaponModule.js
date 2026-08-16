import * as THREE from 'three';
import { WEAPONS, WEAPON_ORDER, recoilAtShot } from './WeaponDefs.js';
import { buildWeapon, weaponMaterials } from './Gunsmith.js';
import { buildArms, armMaterials } from './Arms.js';
import { buildClips, ClipPlayer } from './Clip.js';
import { ViewmodelAnimator } from './Animator.js';
import { AccuracyModel, traceShot, resolveDamage, damageAtRange, limbMultiplier, coneSample } from './Ballistics.js';
import { ScopeOverlay } from './ScopeOverlay.js';

/**
 * OWNER: weapons agent.
 *
 * First-person weapons: the viewmodel, its animation, and the ballistics
 * behind every shot.
 *
 *   Gunsmith.js    procedural weapon models        GunGeo.js   geometry kit
 *   Arms.js        first-person arms and gloves    Clip.js     keyframed clips
 *   Animator.js    layered procedural animation    Ballistics.js  hitscan
 *   ScopeOverlay.js  the DMR's telescopic sight
 *
 * PUBLIC SURFACE — other modules depend on all of this:
 *   `WEAPONS`               the weapon table (also `WeaponModule.WEAPONS`)
 *   `this.muzzle`           Object3D at the muzzle crown (FX, audio)
 *   `this.ammo` `.reserve`  current magazine state (HUD)
 *   `this._adsBlend`        0..1 aim blend (HUD crosshair)
 *   `this._recoil`          Vector2 of live aim punch (HUD crosshair bloom)
 *   `this.current`          active weapon id
 *   `damageFor(...)`        the damage model, for whoever resolves actor hits
 *
 * EVENTS OUT
 *   'weapon:fire'    { weapon, origin, direction, hit, ...ballistics }
 *   'weapon:reload'  { weapon, phase }   phase: start|magout|magin|bolt|end
 *   'weapon:switch'  { from, to }
 *   'weapon:eject'   { weapon, position, direction, speed, spin }
 *   'hit:surface'    { point, normal, material, impulse }
 *
 * CONTROLS
 *   LMB fire · RMB aim · R reload · 1/2/3 or wheel switch · F inspect ·
 *   X cycle fire mode
 */

export { WEAPONS };

export class WeaponModule {
  constructor() {
    this.current = 'rifle';
    this.firing = false;
    this.reloading = false;

    // HUD-facing state (names are load-bearing — HudModule reads them).
    this.ammo = WEAPONS.rifle.magazine;
    this.reserve = WEAPONS.rifle.reserve;
    this._adsBlend = 0;
    this._recoil = new THREE.Vector2();

    this.rig = new THREE.Group();
    this.rig.name = 'ViewmodelRig';

    this.builds = new Map();
    this.mags = new Map();
    this.fireModes = new Map();

    this._cooldown = 0;
    this._shotIndex = 0;
    this._sinceShot = 99;
    this._burstLeft = 0;
    this._triggerHeld = false;
    this._triggerEdge = false;
    this._owed = new THREE.Vector2();       // aim punch still owed back
    this._expectPitch = 0;
    this._expectYaw = 0;
    this._ejectQueue = [];
    this._switching = false;
    this._pendingSwitch = null;
    this._boltLocked = false;

    this.accuracy = new AccuracyModel();
    this.animator = new ViewmodelAnimator();
    this.clips = new ClipPlayer((name, clip) => this._onClipEvent(name, clip));

    // Pose scratch, allocated once. Clips add into it, the animator reads it,
    // and it is zeroed rather than rebuilt so the hot path never allocates.
    this._pose = {};
    for (const n of POSE_NODES) this._pose[n] = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
  }

  _resetPose() {
    for (const n of POSE_NODES) {
      const p = this._pose[n];
      p.px = p.py = p.pz = p.rx = p.ry = p.rz = 0;
    }
  }

  /* ------------------------------------------------------------------ init */

  async init(engine) {
    this.engine = engine;
    this.player = engine.get('player');
    this.collision = engine.get('collision');

    const gunMats = weaponMaterials();
    const armMats = armMaterials();

    for (const id of WEAPON_ORDER) {
      const def = WEAPONS[id];
      const build = buildWeapon(def, gunMats);
      build.clips = buildClips(def, build.anchors);
      build.arms = buildArms(build, armMats);
      build.root.add(build.arms.root);
      build.root.visible = false;
      this.rig.add(build.root);

      // The reticle lives on the camera, not the gun: a collimated sight
      // projects its dot to infinity along the optical axis, so it is placed
      // per frame rather than parented to the optic (see _collimate).
      build.reticle.visible = false;
      engine.viewmodelCamera.add(build.reticle);

      this.builds.set(id, build);
      this.mags.set(id, { ammo: def.magazine, reserve: def.reserve });
      this.fireModes.set(id, def.fireMode);
    }

    engine.viewmodelCamera.add(this.rig);
    engine.viewmodelScene.add(engine.viewmodelCamera);
    this._installViewmodelLights(engine);

    this.scope = new ScopeOverlay(engine.viewmodelCamera);

    this._equip(this.current, true);
    this._bindInput(engine);
    engine.weapons = this;
  }

  /**
   * The viewmodel scene has the sky PMREM as its environment but no direct
   * light, so without this the weapon renders as flat ambient mush — no
   * speculars, no form. One key aligned to the world sun (so turning the
   * player relights the gun exactly as it relights the world) plus a cool
   * bounce from below to keep the shadow side coloured rather than black.
   * No shadow casting: the viewmodel is drawn over a cleared depth buffer and
   * a shadow map for two meshes would be pure cost.
   */
  _installViewmodelLights(engine) {
    const vm = engine.viewmodelScene;
    if (vm.userData.viewmodelLit) return;
    vm.userData.viewmodelLit = true;

    const sunDir = engine.sunDirection
      ? engine.sunDirection.clone().normalize()
      : new THREE.Vector3(0.478, 0.250, -0.842).normalize();

    const key = new THREE.DirectionalLight(0xffffff, 3.0);
    if (engine.sun) {
      key.color.copy(engine.sun.color);
      key.intensity = Math.max(1.2, engine.sun.intensity * 0.80);
    }
    key.position.copy(sunDir).multiplyScalar(10);
    key.castShadow = false;
    vm.add(key, key.target);

    // Sky-bounce fill from the opposite quarter and slightly below.
    const fill = new THREE.DirectionalLight(0x8fb4d8, 0.55);
    fill.position.set(-sunDir.x * 8, -3, -sunDir.z * 8);
    vm.add(fill, fill.target);

    // A tight rim from behind the shooter separates the gun from the world.
    const rim = new THREE.DirectionalLight(0xffe6c8, 0.7);
    rim.position.set(-2, 4, 8);
    vm.add(rim, rim.target);

    this._vmLights = [key, fill, rim];
  }

  _bindInput(engine) {
    engine.bus.on('input:fire', ({ down }) => {
      if (down && !this._triggerHeld) this._triggerEdge = true;
      this._triggerHeld = down;
      this.firing = down;
      if (!down) this._burstLeft = 0;
    });

    this._onKey = (e) => {
      if (e.repeat) return;
      switch (e.code) {
        case 'KeyR': this.startReload(engine); break;
        case 'Digit1': this.switchTo('rifle'); break;
        case 'Digit2': this.switchTo('smg'); break;
        case 'Digit3': this.switchTo('dmr'); break;
        case 'KeyF': this.inspect(); break;
        case 'KeyX': this.cycleFireMode(engine); break;
        default: break;
      }
    };
    window.addEventListener('keydown', this._onKey);

    this._onWheel = (e) => {
      if (Math.abs(e.deltaY) < 1) return;
      const i = WEAPON_ORDER.indexOf(this.current);
      const n = WEAPON_ORDER.length;
      this.switchTo(WEAPON_ORDER[(i + (e.deltaY > 0 ? 1 : n - 1)) % n]);
    };
    window.addEventListener('wheel', this._onWheel, { passive: true });
  }

  /* ---------------------------------------------------------------- equip */

  _equip(id, immediate = false) {
    const prev = this.builds.get(this.current);
    if (prev) { prev.root.visible = false; prev.reticle.visible = false; }

    this.current = id;
    this.weapon = this.builds.get(id);
    this.def = WEAPONS[id];
    this.weapon.root.visible = true;

    const st = this.mags.get(id);
    this.ammo = st.ammo;
    this.reserve = st.reserve;

    this.animator.setWeapon(this.weapon, this.def, this.weapon.arms);
    this.animator.setBoltLock(this.ammo === 0);
    this._boltLocked = this.ammo === 0;
    this.accuracy.reset();
    this._shotIndex = 0;
    this._cooldown = immediate ? 0 : 0.05;
  }

  switchTo(id) {
    if (!this.builds.has(id) || id === this.current || this._switching) return;
    this._pendingSwitch = id;
    this._switching = true;
    this.reloading = false;
    this.clips.play(this.weapon.clips.holster, { blend: 20 });
  }

  cycleFireMode(engine) {
    const modes = this.def.modes;
    if (modes.length < 2) return;
    const i = (modes.indexOf(this.fireModes.get(this.current)) + 1) % modes.length;
    this.fireModes.set(this.current, modes[i]);
    engine.bus.emit('ui:notify', { kind: 'weapon', text: `${this.def.name} · ${modes[i].toUpperCase()}` });
    engine.bus.emit('audio:play', { id: 'selector', position: null, volume: 0.4 });
  }

  inspect() {
    if (this.reloading || this._switching || this.clips.playing) return;
    this.clips.play(this.weapon.clips.inspect, { blend: 10 });
  }

  /* --------------------------------------------------------------- reload */

  startReload(engine) {
    const w = this.def;
    if (this.reloading || this._switching) return;
    if (this.ammo >= w.magazine || this.reserve <= 0) return;
    this.reloading = true;
    this._empty = this.ammo === 0;
    // The empty reload has an extra beat for the bolt release; the clip owns
    // the bolt from here, so drop the static lock-back offset.
    this.animator.setBoltLock(false);
    this.clips.play(this._empty ? this.weapon.clips.reloadEmpty : this.weapon.clips.reload, { blend: 16 });
    engine.bus.emit('weapon:reload', { weapon: this.current, phase: 'start', empty: this._empty });
  }

  _onClipEvent(name, clip) {
    const engine = this.engine;
    const bus = engine.bus;
    switch (name) {
      case 'magRelease':
        bus.emit('audio:play', { id: 'mag_release', position: null, volume: 0.5 });
        break;
      case 'magOut':
        bus.emit('weapon:reload', { weapon: this.current, phase: 'magout' });
        break;
      case 'magIn':
        bus.emit('weapon:reload', { weapon: this.current, phase: 'magin' });
        break;
      case 'magSeated': {
        // Ammo transfers when the magazine actually seats, not when the timer
        // expires — a cancelled reload before this beat gives nothing back.
        const w = this.def;
        const need = w.magazine - this.ammo;
        const take = Math.min(need, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        this._syncMag();
        break;
      }
      case 'boltRelease':
        this._boltLocked = false;
        this.animator.setBoltLock(false);
        bus.emit('weapon:reload', { weapon: this.current, phase: 'bolt' });
        bus.emit('audio:play', { id: 'bolt_release', position: null, volume: 0.7 });
        break;
      case 'inspectCharge':
        bus.emit('audio:play', { id: 'charge', position: null, volume: 0.5 });
        break;
      case 'end':
        if (clip.name === 'holster' && this._pendingSwitch) {
          const from = this.current;
          const to = this._pendingSwitch;
          this._pendingSwitch = null;
          this._equip(to);
          bus.emit('weapon:switch', { from, to });
          this.clips.play(this.weapon.clips.draw, { blend: 20 });
        } else if (clip.name === 'draw') {
          this._switching = false;
        } else if (clip.name === 'reload' || clip.name === 'reloadEmpty') {
          this.reloading = false;
          bus.emit('weapon:reload', { weapon: this.current, phase: 'end' });
        }
        break;
      default: break;
    }
  }

  _syncMag() {
    const st = this.mags.get(this.current);
    st.ammo = this.ammo;
    st.reserve = this.reserve;
  }

  /* --------------------------------------------------------------- update */

  update(dt, engine) {
    const def = this.def;
    const s = this.player.state;

    // Recover the aim punch the player has not already fought back.
    this._recoverPunch(dt, s, def);

    this.clips.update(dt);
    this._resetPose();
    this.clips.sample(this._pose);

    this.accuracy.update(dt, def, s);
    this._sinceShot += dt;
    if (this._sinceShot > def.recoil.resetTime && !this.firing) this._shotIndex = 0;

    /* --- firing --------------------------------------------------------- */
    this._cooldown -= dt;
    const mode = this.fireModes.get(this.current);
    const canFire = !this.reloading && !this._switching && !s.sprinting && s.alive !== false;

    if (canFire && this._cooldown <= 0) {
      let wantShot = false;
      if (mode === 'auto') wantShot = this.firing;
      else if (mode === 'semi') wantShot = this._triggerEdge;
      else if (mode === 'burst') {
        if (this._triggerEdge && this._burstLeft <= 0) this._burstLeft = def.burstCount;
        wantShot = this._burstLeft > 0;
      }

      if (wantShot) {
        if (this.ammo > 0) {
          this._fire(engine, def);
          if (mode === 'burst') {
            this._burstLeft--;
            this._cooldown = this._burstLeft > 0 ? 60 / def.rpm : def.burstDelay;
          } else {
            this._cooldown = 60 / def.rpm;
          }
        } else if (this._triggerEdge || mode === 'auto') {
          engine.bus.emit('audio:play', { id: 'dry_fire', position: null, volume: 0.35 });
          this._cooldown = 0.22;
          this.startReload(engine);
        }
      }
    }
    this._triggerEdge = false;

    /* --- shell casings --------------------------------------------------- */
    for (let i = this._ejectQueue.length - 1; i >= 0; i--) {
      const q = this._ejectQueue[i];
      q.t -= dt;
      if (q.t <= 0) { this._emitShell(engine); this._ejectQueue.splice(i, 1); }
    }

    /* --- animation ------------------------------------------------------- */
    const adsWanted = s.ads && !this.reloading && !s.sprinting && !this._switching;
    this.animator.update(dt, {
      state: s,
      elapsed: engine.elapsed,
      adsWanted,
      firing: this.firing && this.ammo > 0,
      reloading: this.reloading,
      mantling: !!s.mantling,
      fireMode: mode,
      clipPose: this._pose,
    });

    this._adsBlend = this.animator.adsBlend;
    // The HUD reads `_recoil.y` for crosshair bloom, so keep it meaningful:
    // outstanding aim punch plus the live accuracy bloom.
    this._recoil.set(this._owed.x, Math.abs(this._owed.y) + this.accuracy.bloom * 0.6);
  }

  /**
   * Return the borrowed aim punch. A recoil system that never gives the aim
   * back is just a random walk; one that gives all of it back regardless of
   * what the player did fights their mouse. So: track how much the player's
   * own input has already pulled down and subtract that from the debt.
   */
  _recoverPunch(dt, s, def) {
    const userPitch = s.pitch - this._expectPitch;
    const userYaw = s.yaw - this._expectYaw;
    if (userPitch < 0) this._owed.y = Math.max(0, this._owed.y + userPitch);
    if (this._owed.x > 0) this._owed.x = Math.max(0, this._owed.x - Math.max(0, -userYaw));
    else if (this._owed.x < 0) this._owed.x = Math.min(0, this._owed.x + Math.max(0, userYaw));

    if (!this.firing && this._owed.lengthSq() > 1e-10) {
      const k = 1 - Math.exp(-def.recoil.recovery * dt);
      const dy = this._owed.y * k, dx = this._owed.x * k;
      s.pitch -= dy;
      s.yaw -= dx;
      this._owed.y -= dy;
      this._owed.x -= dx;
    }
    this._expectPitch = s.pitch;
    this._expectYaw = s.yaw;
  }

  /* ----------------------------------------------------------------- fire */

  _fire(engine, def) {
    this.ammo--;
    this._syncMag();
    this._sinceShot = 0;

    const cam = engine.camera;
    const origin = cam.getWorldPosition(_v3a);
    const aim = cam.getWorldDirection(_v3b);

    const spread = this.accuracy.spread(def, this.player.state, this._adsBlend);
    const dir = coneSample(_v3c, aim, cam.quaternion, spread).clone();

    // --- recoil: deterministic pattern, aim punch decoupled from the model
    const rScale = this.accuracy.recoilScale(def) * THREE.MathUtils.lerp(1, 0.72, this._adsBlend);
    const pat = recoilAtShot(def, this._shotIndex);
    const vKick = pat.v * rScale;
    const hKick = pat.h * rScale;
    this.player.state.pitch += vKick;
    this.player.state.yaw += hKick;
    this._expectPitch = this.player.state.pitch;
    this._expectYaw = this.player.state.yaw;
    this._owed.y += vKick * def.recoil.recoverFraction;
    this._owed.x += hKick * def.recoil.recoverFraction;
    this._shotIndex++;
    this.accuracy.onShot(def);
    this.animator.onFire(rScale);

    // --- ballistics
    const trace = traceShot(this.collision, origin, dir, def);
    const hit = trace.hit;

    const muzzlePos = this.muzzle.getWorldPosition(new THREE.Vector3());
    engine.bus.emit('weapon:fire', {
      weapon: this.current,
      origin: muzzlePos,
      direction: dir,
      hit,
      // Extra payload — the required four keys above are unchanged.
      def,
      shotIndex: this._shotIndex - 1,
      spread,
      eyeOrigin: origin.clone(),
      damage: damageAtRange(def, trace.distance) * trace.penFactor,
      penFactor: trace.penFactor,
      penetrations: trace.segments,
      distance: trace.distance,
    });

    if (hit) {
      engine.bus.emit('hit:surface', {
        point: hit.point.clone(),
        normal: hit.normal.clone(),
        material: hit.object?.material?.userData?.preset || 'concrete',
        impulse: trace.penFactor,
      });
    }
    // Every layer the round punched through gets its own impact.
    for (const seg of trace.segments) {
      engine.bus.emit('hit:surface', {
        point: seg.exit.clone(),
        normal: seg.normal.clone().negate(),
        material: seg.material,
        impulse: seg.penFactor * 0.6,
      });
    }

    this._ejectQueue.push({ t: def.shellDelay });
    engine.bus.emit('audio:play', { id: `${this.current}_fire`, position: null, volume: 1 });
    this.player.addShake(0.003 + def.recoil.kick * 0.06);

    if (this.ammo === 0) {
      this._boltLocked = true;
      this.animator.setBoltLock(true);
    }
  }

  /**
   * Shell ejection. The VFX module owns the casing particles; this publishes
   * where the case leaves the gun and how fast, timed to the bolt's rearward
   * stroke rather than to the shot itself.
   */
  _emitShell(engine) {
    const port = this.weapon.ejectPort;
    const pos = port.getWorldPosition(_v3a).clone();
    // Cases leave an AR-pattern rifle right, forward and slightly up — about
    // 4 o'clock off the bore, tumbling around their long axis.
    const dir = _v3b.set(0.86, 0.42, 0.28).normalize().applyQuaternion(port.getWorldQuaternion(_q)).clone();
    engine.bus.emit('weapon:eject', {
      weapon: this.current,
      position: pos,
      direction: dir,
      speed: 2.6 + Math.random() * 1.1,
      spin: 14 + Math.random() * 10,
    });
  }

  /* ------------------------------------------------------------ collimate */

  /**
   * Place the reticle where a collimator would put it.
   *
   * A red dot is not a decal on the glass: its emitter sits at the focus of a
   * spherical mirror, so the dot leaves the sight as a *parallel* beam and
   * therefore appears at optical infinity, in the direction of the optical
   * axis, regardless of where the eye is. Reproducing that exactly is one line
   * of geometry: from the eye at the origin of camera space, the dot lies
   * along the sight axis A, and it is drawn on the plane of the rear lens, so
   * its position is `A * (G . A)` for lens centre G. Move the gun and the dot
   * slides across the glass; the point it covers in the world does not move.
   */
  lateUpdate(dt, engine) {
    const cam = engine.viewmodelCamera;
    cam.updateMatrixWorld(true);

    const b = this.weapon;
    const sight = b.sight.group;
    const G = _v3a.setFromMatrixPosition(sight.matrixWorld);
    cam.worldToLocal(G);

    const camQi = cam.getWorldQuaternion(_q).invert();
    const A = _v3b.set(0, 0, -1)
      .applyQuaternion(sight.getWorldQuaternion(_q2))
      .applyQuaternion(camQi)
      .normalize();

    const t = G.dot(A);
    const ret = b.reticle;
    if (t > 0.01) {
      const P = _v3c.copy(A).multiplyScalar(t);
      // Eyebox: the dot vanishes once the axis walks off the lens, which is
      // what makes losing your cheek weld cost something.
      const off = P.distanceTo(G);
      const lim = b.sight.glassR * 0.92;
      const visible = 1 - THREE.MathUtils.smoothstep(off, lim * 0.55, lim);

      ret.position.copy(P);
      ret.quaternion.identity();
      // Constant subtended angle: scale by the distance the maths landed on.
      const scale = t * (b.sight.reticleAngle || 5.8e-4);
      ret.scale.setScalar(scale);
      // Bright at the hip (the dot is the only aiming reference), dimmer when
      // aimed so it does not wash out the target behind it.
      const brightness = visible * (0.55 + 0.45 * (1 - this._adsBlend));
      ret.material.opacity = brightness;
      ret.visible = brightness > 0.01;

      if (this.scope) {
        const scoped = this.def.optic === 'scope';
        const k = b.sight.glassR > 0 ? 1 / b.sight.glassR : 0;
        this.scope.update(scoped ? Math.pow(this._adsBlend, 1.6) : 0,
          (P.x - G.x) * k * 0.42, (P.y - G.y) * k * 0.42);
        // The etched overlay reticle replaces the 3D one once the eye is in.
        if (scoped) ret.material.opacity *= 1 - Math.pow(this._adsBlend, 3);
      }
    } else {
      ret.visible = false;
      this.scope?.update(0, 0, 0);
    }
  }

  resize() { this.scope?.resize(); }

  /* ------------------------------------------------------------ ballistics */

  /**
   * Damage model, exposed so whoever resolves actor hits (AI/match) uses the
   * same numbers the weapon table declares instead of a hard-coded constant.
   * @param distance  metres from the shooter
   * @param limb      'head' | 'neck' | 'chest' | 'stomach' | 'arm' | 'leg'
   * @param penFactor surviving fraction after penetration (see 'weapon:fire')
   */
  damageFor(distance, limb = 'chest', penFactor = 1, weaponId = this.current) {
    return resolveDamage(WEAPONS[weaponId] || this.def, distance, limb, penFactor);
  }

  /** Limb multiplier alone, for callers that already have base damage. */
  limbFactor(limb, weaponId = this.current) {
    return limbMultiplier(WEAPONS[weaponId] || this.def, limb);
  }

  get muzzle() { return this.weapon ? this.weapon.muzzle : null; }
  get spread() { return this.accuracy.spread(this.def, this.player.state, this._adsBlend); }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('wheel', this._onWheel);
    for (const b of this.builds.values()) { b.dispose(); b.arms.dispose(); }
    this.builds.clear();
    this.scope?.dispose();
  }
}

WeaponModule.WEAPONS = WEAPONS;

const POSE_NODES = ['weapon', 'mag', 'charge', 'bolt', 'boltCatch', 'cover', 'trigger', 'selector', 'left', 'right'];

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
