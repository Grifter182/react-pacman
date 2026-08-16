import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { InputMap } from './InputMap.js';
import { Controller, Stance } from './Controller.js';
import { CameraRig } from './CameraRig.js';
import { Vitals } from './Vitals.js';

/**
 * OWNER: player-feel agent.
 *
 * Everything the player *is*: intent (InputMap), body (Controller), view
 * (CameraRig + Trauma) and condition (Vitals). This file only wires those
 * together and owns the public surface other modules read.
 *
 *   InputMap.js    keyboard / mouse / gamepad, sensitivity + FOV settings
 *   Controller.js  capsule movement, stances, slide, step-up, mantle
 *   CameraRig.js   spring camera, layered bob, roll, breathing, FOV
 *   Trauma.js      trauma-model camera shake on Perlin noise
 *   Vitals.js      health, directional damage, low-health response
 *
 * PUBLIC SURFACE — do not rename, other modules read these:
 *   `this.state`   { position, velocity, yaw, pitch, grounded, sprinting,
 *                    crouching, ads, health, maxHealth, alive, mantling,
 *                    prone, sliding, stance }
 *   `addShake(i)`  legacy shake entry point (FX + weapons call it)
 *   `damage(...)`  apply damage to the player
 *
 * EVENTS OUT
 *   'player:spawn'     { position, yaw }
 *   'player:damaged'   { amount, from, direction, angle, health }
 *   'player:died'      { by, position }
 *   'player:land'      { impact, position, hard }
 *   'player:jump'      { position }
 *   'player:footstep'  { position, speed, foot, stance }
 *   'player:mantle'    { phase, height }
 *   'player:slide'     { phase, speed }
 *   'ui:damage'        { id, angle, amount, from, headshot, life }
 *   'ui:vitals'        { health, ratio, low, suppression, regenerating }
 *   'ui:pointerlock'   { locked }
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
      prone: false,
      sliding: false,
      mantling: false,
      stance: Stance.STAND,
      ads: false,
      health: 100,
      maxHealth: 100,
      alive: true,
      team: 0,
    };

    this.input = new InputMap();
    this.controller = new Controller(this.state, this.input);
    this.rig = new CameraRig(this.state, this.controller, this.input);
    this.vitals = new Vitals(this.state);

    // Kept for source compatibility with the previous implementation.
    this.keys = this.input.keys;
    this._adsBlend = 0;
  }

  async init(engine) {
    this.engine = engine;
    this.collision = engine.get('collision');
    this.controller.attach(this.collision, engine.bus);

    const level = engine.get('level');
    if (level) {
      const s = level.pickSpawn(0);
      this.state.position.copy(s.position).setY(s.position.y + Config.player.height * 0.5 + 0.02);
      this.state.yaw = s.yaw;
    }

    this.input.bind(engine);
    engine.bus.on('input:ads', ({ down }) => { this.state.ads = down; });

    engine.bus.on('player:land', ({ impact }) => {
      this.rig.onLand(impact);
      this.input.rumble(Math.min(0.5, impact * 0.03), 0.1, 90);
    });
    engine.bus.on('player:falldamage', ({ amount }) => {
      this.vitals.damage(amount, 'fall', null, engine, { fall: true });
      this.rig.trauma.add(0.5);
    });
    // MatchModule teleports the body on respawn; re-seat the camera so it does
    // not spring across the map.
    engine.bus.on('player:spawn', () => {
      this.controller.reset(null);
      this.vitals.reset();
      this.rig.reset(this._eyeTarget());
    });

    this.controller.reset(this.state.position.clone());
    this.rig.reset(this._eyeTarget());

    engine.player = this;
    engine.bus.emit('player:spawn', { position: this.state.position, yaw: this.state.yaw });
    engine.bus.emit('ui:settings', { settings: this.input.settings });
  }

  _eyeTarget() {
    return new THREE.Vector3(
      this.state.position.x,
      this.state.position.y - this.controller.halfHeight + this.controller.eyeHeight,
      this.state.position.z,
    );
  }

  /* ------------------------------------------------------------------ loop */

  fixedUpdate(dt, engine) {
    this.input.syncAxes();
    this.controller.fixedUpdate(dt);
    this.state.stance = this.controller.stance;
    if (this.controller.stepOffset !== 0) this.rig.onStep(this.controller.stepOffset);
    void engine;
  }

  update(dt, engine) {
    this.input.beginFrame(dt);

    // The weapon module publishes the authoritative aim blend; the camera and
    // the mouse sensitivity both key off it so the two never disagree.
    const weapons = engine.get('weapons');
    this._adsBlend = weapons?._adsBlend ?? (this.state.ads ? 1 : 0);
    const zoom = weapons?.def?.optic === 'scope'
      ? THREE.MathUtils.lerp(1, 0.45, this._adsBlend) : 1;

    const look = this.input.drainLook(this._adsBlend, zoom);
    if (this.state.alive) {
      this.state.yaw += look.yaw;
      this.state.pitch += look.pitch;
      const lim = Math.PI / 2 - 0.008;
      this.state.pitch = Math.max(-lim, Math.min(lim, this.state.pitch));
      // Keep yaw bounded so long sessions cannot lose float precision on it.
      if (this.state.yaw > Math.PI * 4 || this.state.yaw < -Math.PI * 4) {
        this.state.yaw = ((this.state.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
      }
    }

    if (this.controller.landImpact > 0) this.controller.landImpact = 0;

    this.vitals.update(dt, engine, this.rig.trauma);
    this.rig.update(dt, engine, {
      adsBlend: this._adsBlend,
      health: this.state.health,
      maxHealth: this.state.maxHealth,
      suppression: this.vitals.suppression,
    });

    // Death: the view slumps rather than freezing.
    if (!this.state.alive) {
      const cam = engine.camera;
      cam.position.y -= Math.min(0.9, (this._deathT = (this._deathT || 0) + dt) * 0.75);
      cam.rotateZ(Math.min(0.55, this._deathT * 0.55));
    } else {
      this._deathT = 0;
    }

    this.input.endFrame();
  }

  /* ---------------------------------------------------------------- public */

  /** Legacy shake entry point: an amplitude in metres becomes trauma. */
  addShake(intensity) {
    this.rig.trauma.add(Math.min(0.85, Math.sqrt(Math.max(0, intensity)) * 1.35));
  }

  /** Directional trauma, for explosions and impacts with a known origin. */
  shakeFrom(intensity, worldPos) {
    const s = this.state;
    const dx = s.position.x - worldPos.x, dz = s.position.z - worldPos.z;
    const l = Math.hypot(dx, dz) || 1;
    this.rig.trauma.impulse(Math.min(0.9, intensity), dx / l, 0.35, dz / l);
  }

  /**
   * @param amount  damage
   * @param from    attacker label forwarded on the bus
   * @param arg     engine (legacy 3rd argument) or an options object
   *                `{ origin, headshot, engine }`
   */
  damage(amount, from, arg) {
    const engine = this.engine || (arg && arg.bus ? arg : null);
    if (!engine) return 0;
    const opts = arg && !arg.bus ? arg : {};
    const applied = this.vitals.damage(amount, from, opts.origin || null, engine, opts);
    if (applied > 0) {
      const w = Math.min(1, amount / 45);
      if (opts.origin) this.shakeFrom(0.14 + w * 0.34, opts.origin);
      else this.rig.trauma.add(0.14 + w * 0.34);
      this.input.rumble(0.35 + w * 0.5, 0.25, 140);
    }
    return applied;
  }

  /** Near-miss: pins the player without hurting them. */
  suppress(amount = 0.25) {
    this.vitals.suppress(amount);
    this.rig.trauma.add(amount * 0.20);
  }

  /** Runtime settings hook for the UI agent: `player.setSetting('fov', 95)`. */
  setSetting(key, value) {
    const v = this.input.set(key, value);
    this.engine?.bus.emit('ui:settings', { settings: this.input.settings, changed: key });
    return v;
  }

  get settings() { return this.input.settings; }
  get eyeHeight() { return this.controller.eyeHeight; }

  dispose() { this.input.dispose(); }
}
