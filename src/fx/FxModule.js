import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { buildParticleAtlas, buildDecalAtlas, PT } from './FxTextures.js';
import { ParticleSystem, LAYER, P, resetP } from './ParticleSystem.js';
import { DecalField } from './Decals.js';
import { DebrisPool, makeCasingGeometry, makeChunkGeometry } from './Debris.js';
import { spawnImpact, recipeFor, emitBurst } from './Impacts.js';
import { MuzzleFlash } from './MuzzleFlash.js';
import { Explosions } from './Explosions.js';
import { Ambience } from './Ambience.js';

/**
 * OWNER: VFX agent.
 *
 * Everything transient in the world: particles, muzzle flash, impacts, decals,
 * tracers, smoke, explosions, shell casings and environmental particulate.
 *
 * Composition (each subsystem documents its own physics):
 *   ParticleSystem  GPU-simulated instanced particles, 3 blend layers
 *   DecalField      surface-projected, normal-mapped, lit bullet holes
 *   DebrisPool      swept-collision rigid bodies (casings, chunks)
 *   MuzzleFlash     multi-element viewmodel flash + world blast products
 *   Explosions      staged detonation sequencer
 *   Ambience        procedural dust motes and blown sand
 *
 * Listens for: 'weapon:fire', 'weapon:eject', 'hit:surface', 'hit:actor',
 * 'actor:killed', 'fx:explosion', 'fx:smoke'.
 * Publishes:   'audio:play' (impact and casing sounds — the audio agent owns
 *              the synthesis, this module only says what happened and where).
 *
 * WHY IMPACTS ARE DELAYED
 * -----------------------
 * The weapon is hitscan: 'hit:surface' arrives on the same frame as the shot.
 * A tracer that takes 80 ms to cross a street would then arrive *after* its own
 * impact. Impact effects are queued with the round's time of flight, so the
 * dust leaves the wall as the tracer reaches it. The sound is not delayed — the
 * audio module gets its event immediately and does its own propagation.
 */
export class FxModule {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'FX';
    this.root.matrixAutoUpdate = false;

    this.particles = null;
    this.decals = null;
    this.casings = null;
    this.chunks = null;
    this.flash = null;
    this.explosions = null;
    this.ambience = null;
    this.collision = null;

    this._offs = [];
    this._pending = [];
    this._smokers = [];
    this._tracerCounter = 0;
  }

  async init(engine) {
    const gfx = Config.gfx;
    const tier = Config.quality;
    const tierIndex = { low: 0, medium: 1, high: 2, ultra: 3 }[tier] ?? 1;

    engine.scene.add(this.root);
    this.collision = engine.get('collision');

    // --- textures -----------------------------------------------------------
    // Atlas generation is a boot-time cost that scales with the square of the
    // tile, so the ladder is steep: a 4px smoke sprite does not benefit from a
    // 128px source, and a bullet hole is never more than a few hundred pixels
    // on screen even with your face against the wall.
    const particleTile = [48, 64, 96, 128][tierIndex];
    const decalTile = [64, 96, 128, 160][tierIndex];
    this.atlas = buildParticleAtlas(particleTile);
    const decalAtlas = buildDecalAtlas(decalTile);
    this.decalAtlas = decalAtlas;
    const aniso = Math.min(engine.maxAnisotropy || 4, 4);
    this.atlas.anisotropy = aniso;
    decalAtlas.albedo.anisotropy = aniso;
    decalAtlas.normal.anisotropy = aniso;

    // --- particles ----------------------------------------------------------
    // Heat shimmer is a whole extra transparent layer; it only earns its place
    // where there is frame time to spare.
    this.particles = new ParticleSystem(gfx.particleBudget, this.atlas, { haze: tierIndex >= 2 });
    this.root.add(this.particles.root);

    // --- decals -------------------------------------------------------------
    this.decals = new DecalField(gfx.decalBudget, decalAtlas.albedo, decalAtlas.normal);
    this.root.add(this.decals.mesh);

    // --- rigid debris -------------------------------------------------------
    this.casings = new DebrisPool({
      geometry: makeCasingGeometry(),
      material: new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.60, 0.44, 0.16),
        metalness: 0.95, roughness: 0.34,
      }),
      capacity: [12, 20, 32, 48][tierIndex],
      radius: 0.008,
      restitution: 0.42,
      friction: 0.42,
      name: 'FxCasings',
    });
    this.root.add(this.casings.mesh);

    this.chunks = new DebrisPool({
      geometry: makeChunkGeometry(7),
      material: new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.36, 0.35, 0.33),
        metalness: 0.0, roughness: 0.92,
      }),
      capacity: [10, 18, 30, 44][tierIndex],
      radius: 0.05,
      restitution: 0.24,
      friction: 0.62,
      name: 'FxChunks',
    });
    this.root.add(this.chunks.mesh);

    // --- flash, explosions, ambience ---------------------------------------
    this.flash = new MuzzleFlash(engine);
    this.explosions = new Explosions(this);
    this.ambience = new Ambience(
      [110, 260, 520, 900][tierIndex],
      [0, 140, 300, 520][tierIndex],
      this.atlas,
    );
    this.root.add(this.ambience.root);

    // --- pools that must never allocate at event time -----------------------
    for (let i = 0; i < 48; i++) {
      this._pending.push({
        active: false, t: 0,
        point: new THREE.Vector3(), normal: new THREE.Vector3(),
        material: 'concrete', impulse: 1,
      });
    }
    for (let i = 0; i < 6; i++) {
      this._smokers.push({ active: false, t: 0, life: 0, rate: 0, acc: 0, radius: 1, pos: new THREE.Vector3() });
    }

    // --- events -------------------------------------------------------------
    const bus = engine.bus;
    this._offs.push(bus.on('weapon:fire', (e) => this.onFire(e, engine)));
    this._offs.push(bus.on('weapon:eject', (e) => this.onEject(e, engine)));
    this._offs.push(bus.on('hit:surface', (e) => this.onSurfaceHit(e, engine)));
    this._offs.push(bus.on('hit:actor', (e) => this.onActorHit(e, engine)));
    this._offs.push(bus.on('actor:killed', (e) => this.onActorKilled(e, engine)));
    this._offs.push(bus.on('fx:explosion', (e) => this.onExplosion(e, engine)));
    this._offs.push(bus.on('fx:smoke', (e) => this.smokeGrenade(e, engine)));

    engine.fx = this;
  }

  /* ------------------------------------------------------------- weapons */

  onFire({ origin, direction, hit, def, shotIndex = 0 }, engine) {
    if (!origin || !direction) return;
    this.flash.fire(origin, direction, this.particles, def);

    // Tracers are loaded every fourth or fifth round in a real belt or mag, and
    // the muzzle end is deliberately started down range: a tracer born at the
    // crown is a bright blob over the sights, not a streak into the distance.
    this._tracerCounter++;
    const everyN = def && def.tracerEvery ? def.tracerEvery : 4;
    if (this._tracerCounter % everyN !== 0) return;

    const dist = hit ? origin.distanceTo(hit.point) : 140;
    const speed = 460;
    const start = Math.min(2.2, dist * 0.25);

    resetP();
    P.x = origin.x + direction.x * start;
    P.y = origin.y + direction.y * start;
    P.z = origin.z + direction.z * start;
    P.vx = direction.x * speed; P.vy = direction.y * speed; P.vz = direction.z * speed;
    // Dies exactly as it reaches the impact point.
    P.life = Math.max(0.02, (dist - start) / speed);
    P.drag = 0.0;
    P.gravity = 0.06;                 // enough droop to read at 100 m
    P.size0 = 0.030; P.size1 = 0.016;
    P.stretch = 0.0062;               // ~2.9 m of streak at muzzle velocity
    P.alpha = 1; P.tile = PT.SPARK; P.fade = 0.55; P.soft = 0.2;
    P.r0 = 7.0; P.g0 = 2.2; P.b0 = 0.5;
    P.r1 = 2.2; P.g1 = 0.35; P.b1 = 0.08;
    this.particles.spawn(LAYER.ADDITIVE);
  }

  /** Shell ejection: a real body with a real bounce and a real ping. */
  onEject({ position, direction, speed = 3, spin = 18 }, engine) {
    if (!position || !this.casings) return;
    _v.copy(direction).multiplyScalar(speed);
    // Inherit the shooter's motion, or a sprinting player's cases hang in the
    // air behind them.
    const player = engine.get('player');
    if (player && player.state && player.state.velocity) _v.add(player.state.velocity);
    this.casings.spawn(position, _v, { life: 5.5, spin });
  }

  /* ------------------------------------------------------------- impacts */

  onSurfaceHit({ point, normal, material, impulse = 1 }, engine) {
    if (!point || !normal) return;
    // Time of flight from the shooter's eye, so the impact lands with the round.
    const d = engine.camera.position.distanceTo(point);
    const delay = Math.min(d / 460, 0.35);

    let slot = null;
    for (const s of this._pending) { if (!s.active) { slot = s; break; } }
    if (!slot) { spawnImpact(this, point, normal, material, impulse, engine); return; }

    slot.active = true;
    slot.t = delay;
    slot.point.copy(point);
    slot.normal.copy(normal);
    slot.material = material || 'concrete';
    slot.impulse = impulse;
  }

  onActorHit({ point, normal, headshot }, engine) {
    if (!point) return;
    _n.copy(normal || _up).normalize();
    const recipe = recipeFor('flesh');
    const scale = headshot ? 1.6 : 1.0;
    for (const spec of recipe.bursts) emitBurst(this.particles, spec, point, _n, scale);
    engine.bus.emit('audio:play', { id: 'impact_flesh', position: point, volume: 0.55 });
  }

  onActorKilled({ actor, headshot }, engine) {
    // Actors are owned by the AI module and their shape is not this module's
    // business: take a world position from whichever of the two conventional
    // fields it exposes and give up quietly if neither is there.
    if (!actor) return;
    if (actor.position && actor.position.isVector3) _v.copy(actor.position);
    else if (actor.mesh) actor.mesh.getWorldPosition(_v);
    else return;
    _v.y += headshot ? 1.62 : 1.15;
    const recipe = recipeFor('flesh');
    for (const spec of recipe.bursts) emitBurst(this.particles, spec, _v, _up, headshot ? 2.2 : 1.4);
  }

  /* ---------------------------------------------------------- explosions */

  onExplosion({ position, radius = 5, power = 1 }, engine) {
    if (!position) return;
    this.explosions.trigger(position, radius, power, engine);
  }

  /**
   * A smoke grenade: a sustained emitter rather than a burst, so the cloud
   * builds over its burn time and keeps its internal motion afterwards.
   * @param {{position:THREE.Vector3, radius?:number, duration?:number}} e
   */
  smokeGrenade({ position, radius = 2.2, duration = 9 }) {
    if (!position) return;
    let slot = null;
    for (const s of this._smokers) { if (!s.active) { slot = s; break; } }
    if (!slot) slot = this._smokers[0];
    slot.active = true;
    slot.t = 0;
    slot.life = duration;
    slot.radius = radius;
    slot.rate = 22;
    slot.acc = 0;
    slot.pos.copy(position);
  }

  _updateSmokers(dt) {
    for (const s of this._smokers) {
      if (!s.active) continue;
      s.t += dt;
      if (s.t > s.life) { s.active = false; continue; }
      // Output tails off as the canister burns out.
      const output = 1 - Math.pow(s.t / s.life, 2);
      s.acc += dt * s.rate * output;
      while (s.acc >= 1) {
        s.acc -= 1;
        resetP();
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * s.radius * 0.35;
        P.x = s.pos.x + Math.cos(a) * rr;
        P.y = s.pos.y + Math.random() * 0.2;
        P.z = s.pos.z + Math.sin(a) * rr;
        P.vx = Math.cos(a) * (0.5 + Math.random() * 0.8);
        P.vy = 0.8 + Math.random() * 1.1;
        P.vz = Math.sin(a) * (0.5 + Math.random() * 0.8);
        P.life = 4.5 + Math.random() * 4.0;
        P.drag = 1.5;
        P.gravity = -0.10;
        P.turbulence = 0.75;
        P.lit = 1;
        P.size0 = s.radius * 0.45; P.size1 = s.radius * 1.9;
        P.spin = (Math.random() - 0.5) * 0.6;
        P.alpha = 0.42;
        P.tile = Math.random() < 0.4 ? PT.DENSE : PT.WISP;
        P.fade = 2.4; P.soft = 0.9;
        P.r0 = 0.78; P.g0 = 0.78; P.b0 = 0.80;
        P.r1 = 0.55; P.g1 = 0.55; P.b1 = 0.58;
        this.particles.spawn(LAYER.ALPHA);
      }
    }
  }

  /* -------------------------------------------------------------- frame */

  fixedUpdate(dt, engine) {
    if (this.casings) this.casings.fixedUpdate(dt, this.collision, this._onCasingImpact);
    if (this.chunks) this.chunks.fixedUpdate(dt, this.collision, this._onChunkImpact);
  }

  update(dt, engine) {
    // Queued impacts first: they may spawn particles this frame.
    for (const s of this._pending) {
      if (!s.active) continue;
      s.t -= dt;
      if (s.t > 0) continue;
      s.active = false;
      spawnImpact(this, s.point, s.normal, s.material, s.impulse, engine);
    }

    this._updateSmokers(dt);
    this.explosions.update(dt, engine);
    this.particles.update(dt, engine);
    this.decals.update(dt, engine);
    this.ambience.update(dt, engine);
  }

  lateUpdate(dt, engine) {
    // Everything that publishes an FX event — weapons, AI, the match — updates
    // after this module does, so the GPU-side commit has to happen here or a
    // shot fired this frame would not be drawn until the next one.
    this.flash.update(dt, engine);
    this.particles.flush();
    this.casings.sync();
    this.chunks.sync();
  }

  /* Bound once so fixedUpdate never allocates a closure. */
  _onCasingImpact = (body, hit, impactSpeed) => {
    if (body.bounces > 2 || impactSpeed < 0.9 || !this.engine) return;
    this.engine.bus.emit('audio:play', {
      id: 'shell_bounce',
      position: body.pos,
      volume: Math.min(0.5, 0.14 + impactSpeed * 0.06),
      pitch: 0.85 + Math.random() * 0.4,
    });
  };

  _onChunkImpact = (body, hit, impactSpeed) => {
    if (impactSpeed < 1.6 || !this.particles) return;
    // A chunk landing kicks up its own small puff.
    resetP();
    P.x = body.pos.x; P.y = body.pos.y; P.z = body.pos.z;
    P.vx = hit.normal.x * 0.5; P.vy = hit.normal.y * 0.5 + 0.2; P.vz = hit.normal.z * 0.5;
    P.life = 0.6 + Math.random() * 0.6;
    P.drag = 3.2; P.gravity = 0.05; P.turbulence = 0.3; P.lit = 1;
    P.size0 = 0.06; P.size1 = 0.34;
    P.alpha = 0.28; P.tile = PT.SMOKE; P.fade = 1.7; P.soft = 0.4;
    P.r0 = 0.58; P.g0 = 0.56; P.b0 = 0.52;
    P.r1 = 0.40; P.g1 = 0.39; P.b1 = 0.38;
    this.particles.spawn(LAYER.ALPHA);
  };

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    this.particles?.dispose();
    this.decals?.dispose();
    this.casings?.dispose();
    this.chunks?.dispose();
    this.flash?.dispose();
    this.ambience?.dispose();
    this.atlas?.dispose();
    this.decalAtlas?.albedo.dispose();
    this.decalAtlas?.normal.dispose();
    this.root.removeFromParent();
  }
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
