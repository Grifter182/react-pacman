import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { buildParticleAtlas, buildDecalAtlas, PT, DT } from './FxTextures.js';
import { ParticleSystem, LAYER, P, resetP } from './ParticleSystem.js';
import { DecalField } from './Decals.js';
import { DebrisPool, makeCasingGeometry, makeChunkGeometry } from './Debris.js';
import { spawnImpact, recipeFor, emitBurst, classifySurface } from './Impacts.js';
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
    this._lastFireAt = -1e9;
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
    // Dressing needs the finished collision world, which is built by the level
    // module's init. Binding to 'engine:ready' rather than calling it here
    // makes that independent of registration order.
    this._offs.push(bus.on('engine:ready', () => this.dressLevel(engine)));

    engine.fx = this;
    // Provable-in-one-call debug surface. See `debugSpawnAll`.
    if (typeof window !== 'undefined') window.__fx = this;
  }

  /* --------------------------------------------------------------- debug */

  /**
   * Spawn one of everything at a world position and report what was emitted.
   *
   * This exists because "no effect appeared on screen" is otherwise only ever
   * inferred from a screenshot, and a screenshot cannot tell you whether the
   * event never arrived, the emitter never ran, the particle was written with
   * zero alpha, or the mesh was culled. Call it from the console or a harness:
   *
   *   __fx.debugSpawnAll()                  // 6 m in front of the camera
   *   __fx.debugSpawnAll(new THREE.Vector3(0, 1, 10))
   *
   * The returned object gives live instance counts per layer immediately after
   * the spawn, so a zero there is a wiring bug and a non-zero there with an
   * empty screen is a shading or blending bug. That is the whole point: it
   * splits the failure in half.
   *
   * @param {THREE.Vector3} [position]
   * @returns {object} counts and the state of every subsystem
   */
  debugSpawnAll(position = null) {
    const engine = this.engine;
    const p = _dbgP;
    if (position) p.copy(position);
    else engine.camera.getWorldDirection(p).multiplyScalar(6).add(engine.camera.position);

    const before = this.particles.liveEstimate;

    // One impact of every material, fanned out around the point so they do not
    // overlap, each oriented to its own surface normal.
    const mats = ['concrete', 'metal', 'wood', 'sand', 'glass', 'brick', 'plaster', 'flesh'];
    for (let i = 0; i < mats.length; i++) {
      const a = (i / mats.length) * Math.PI * 2;
      _dbgN.set(Math.cos(a), 0.35, Math.sin(a)).normalize();
      _dbgQ.copy(p).addScaledVector(_dbgN, 1.2);
      spawnImpact(this, _dbgQ, _dbgN, mats[i], 1, engine);
    }

    // Muzzle flash + its light + world blast products, aimed away from camera.
    engine.camera.getWorldDirection(_dbgN);
    this.flash.fire(p, _dbgN, this.particles, null);

    // A tracer that actually travels.
    resetP();
    P.x = p.x; P.y = p.y; P.z = p.z;
    P.vx = _dbgN.x * 460; P.vy = _dbgN.y * 460; P.vz = _dbgN.z * 460;
    P.life = 0.25; P.size0 = 0.038; P.size1 = 0.02; P.stretch = 0.0075;
    P.alpha = 1; P.tile = PT.SPARK; P.fade = 0.55;
    P.r0 = 9; P.g0 = 3; P.b0 = 0.7; P.r1 = 2.6; P.g1 = 0.45; P.b1 = 0.1;
    this.particles.spawn(LAYER.ADDITIVE, 0);

    // Casing, chunk, lingering smoke source, explosion.
    _dbgV.set(2.2, 1.6, 0.4);
    this.casings.spawn(p, _dbgV, { life: 6, spin: 18 });
    _dbgV.set(-1.5, 3.0, 1.0);
    _dbgS.set(0.09, 0.06, 0.07);
    this.chunks.spawn(p, _dbgV, { life: 6, spin: 12, scale: _dbgS });
    this.smokeGrenade({ position: p, radius: 1.6, duration: 6 });
    _dbgQ.copy(p).addScaledVector(_dbgN, 5);
    this.explosions.trigger(_dbgQ, 4, 1, engine);

    // Decals on whatever real surface is under and beside the point.
    let decalsPlaced = 0;
    if (this.collision && this.collision.collider) {
      const hit = this.collision.raycast(p, _down, 6);
      if (hit) {
        _dbgTint.setRGB(0.5, 0.47, 0.44);
        this.decals.place({
          point: hit.point, normal: hit.normal, tile: DT.SCORCH,
          size: 1.4, tint: _dbgTint, life: 600,
        }, this.collision);
        decalsPlaced++;
      }
    }

    // Flush now so the counts below reflect this call even when it is made
    // from outside the frame loop.
    this.particles.flush();

    const report = {
      position: p.toArray().map((n) => +n.toFixed(2)),
      particlesBefore: before,
      particlesAfter: this.particles.liveEstimate,
      layers: this.particles.layers.map((l) => ({
        name: l.name,
        instances: l.geometry.instanceCount,
        capacity: l.capacity,
        visible: l.mesh.visible,
        inScene: !!l.mesh.parent,
      })),
      flash: {
        live: this.flash.live,
        visible: this.flash.root.visible,
        parented: this.flash.root.parent ? this.flash.root.parent.name || this.flash.root.parent.type : null,
        starOpacity: this.flash.star.material.opacity,
      },
      decals: {
        reserved: this.decals.reserved,
        ringIndex: this.decals.index,
        budget: this.decals.budget,
        placedNow: decalsPlaced,
        inScene: !!this.decals.mesh.parent,
      },
      casings: this.casings.bodies.filter((b) => b.active).length,
      chunks: this.chunks.bodies.filter((b) => b.active).length,
      dynamicLights: engine.dynamicLights
        ? engine.dynamicLights.slots.filter((s) => s.active).length : 'none',
      fxRootInScene: !!this.root.parent,
    };
    console.info('[fx] debugSpawnAll', report);
    return report;
  }

  /* ------------------------------------------------------------ dressing */

  /**
   * Scatter permanent grime, staining and splash onto the built level.
   *
   * A grey-box reads as a grey-box mostly because nothing has ever happened to
   * it. Streaks under sills, dirt banked into the base of walls and dried
   * splash on kerbs cost one instanced draw call that already exists and are
   * the cheapest available step toward a place someone lives in.
   *
   * Placement is by raycast against the real collision world, so nothing floats
   * and nothing lands in mid air, and it is driven by a fixed seed so the map
   * looks identical on every load.
   */
  dressLevel(engine) {
    if (this._dressed) return 0;
    const collision = this.collision || engine.get('collision');
    if (!collision || !collision.collider || !this.decals) return 0;
    this._dressed = true;

    const total = Math.min(132, Math.max(16, Math.floor(this.decals.budget * 0.46)));
    const rand = mulberry(0x5eed1a);
    const R = 46;                    // the built-up part of the map
    let placed = 0;
    let guard = 0;

    while (placed < total && guard++ < total * 14) {
      const wall = rand() < 0.62;

      if (wall) {
        // Cast horizontally from a point in the open and dress whatever facade
        // it lands on. Sampling rays rather than surfaces means dressing lands
        // on faces the player can actually see from the street.
        _dressO.set((rand() * 2 - 1) * R, 0.4 + rand() * 4.2, (rand() * 2 - 1) * R);
        const a = rand() * Math.PI * 2;
        _dressD.set(Math.cos(a), (rand() - 0.5) * 0.12, Math.sin(a)).normalize();
        const hit = collision.raycast(_dressO, _dressD, 16);
        if (!hit || Math.abs(hit.normal.y) > 0.42) continue;

        const high = hit.point.y > 2.0;
        const t = rand();
        let tile; let size; let tint; let alignY = null;
        if (high || t < 0.42) {
          // Runs from a sill or a fixing, always downward.
          tile = DT.STAIN;
          size = 0.9 + rand() * 1.9;
          tint = _dressTint.setRGB(0.55, 0.42, 0.28);
          alignY = _down;                       // local +Y points down the wall
        } else if (t < 0.78) {
          tile = DT.GRIME;
          size = 1.1 + rand() * 2.4;
          tint = _dressTint.setRGB(0.48, 0.46, 0.42);
        } else {
          tile = DT.SPLASH;
          size = 0.8 + rand() * 1.4;
          tint = _dressTint.setRGB(0.62, 0.55, 0.40);
          alignY = _up;                          // fan opens upward from grade
        }
        this.decals.place({
          point: hit.point, normal: hit.normal, tile, size, tint,
          life: 1e9, alignY, permanent: true,
        }, collision);
        placed++;
      } else {
        // Ground: traffic wear, oil, dried mud at the foot of things.
        _dressO.set((rand() * 2 - 1) * R, 9, (rand() * 2 - 1) * R);
        const hit = collision.raycast(_dressO, _down, 14);
        if (!hit || hit.normal.y < 0.80) continue;
        const t = rand();
        const tile = t < 0.55 ? DT.GRIME : (t < 0.85 ? DT.SPLASH : DT.SCORCH);
        _dressTint.setRGB(0.52, 0.49, 0.44);
        this.decals.place({
          point: hit.point, normal: hit.normal, tile,
          size: 1.4 + rand() * 3.0, tint: _dressTint,
          life: 1e9, permanent: true,
        }, collision);
        placed++;
      }
    }

    console.info(`[fx] level dressing: ${placed} permanent decals`);
    return placed;
  }

  /* ------------------------------------------------------------- weapons */

  onFire({ origin, direction, hit, def, shotIndex = 0 }, engine) {
    if (!origin || !direction) return;
    this.flash.fire(origin, direction, this.particles, def);

    // Tracers are loaded every fourth or fifth round in a real belt or mag, and
    // the muzzle end is deliberately started down range: a tracer born at the
    // crown is a bright blob over the sights, not a streak into the distance.
    //
    // The counter resets between bursts so the FIRST round of any burst is a
    // tracer. Starting the cycle mid-way meant a two-round burst — which is all
    // a slow capture ever gets — could contain no tracer at all, and the effect
    // then simply does not exist as far as any reviewer is concerned.
    const everyN = Math.max(1, (def && def.tracerEvery) || 4);
    if (engine.elapsed - this._lastFireAt > 0.5) this._tracerCounter = 0;
    this._lastFireAt = engine.elapsed;
    const isTracer = (this._tracerCounter % everyN) === 0;
    this._tracerCounter++;
    if (!isTracer) return;

    const dist = hit ? origin.distanceTo(hit.point) : 140;
    const speed = 460;
    const start = Math.min(2.2, dist * 0.25);

    resetP();
    P.x = origin.x + direction.x * start;
    P.y = origin.y + direction.y * start;
    P.z = origin.z + direction.z * start;
    P.vx = direction.x * speed; P.vy = direction.y * speed; P.vz = direction.z * speed;
    // Dies as it reaches the impact point, with a floor: a 10 m shot has a
    // 17 ms time of flight, and a round that lives for a quarter of a frame is
    // a round nobody ever sees leave the barrel.
    P.life = Math.max(0.085, (dist - start) / speed);
    P.drag = 0.0;
    P.gravity = 0.06;                 // enough droop to read at 100 m
    P.size0 = 0.038; P.size1 = 0.020;
    P.stretch = 0.0075;               // ~3.5 m of streak at muzzle velocity
    P.alpha = 1; P.tile = PT.SPARK; P.fade = 0.55; P.soft = 0.2;
    P.r0 = 9.0; P.g0 = 3.0; P.b0 = 0.7;
    P.r1 = 2.6; P.g1 = 0.45; P.b1 = 0.10;
    // Bias 0: a tracer's whole life can be shorter than one slow frame, so
    // backdating its birth would bury it in the wall before it is ever drawn.
    this.particles.spawn(LAYER.ADDITIVE, 0);
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
    const mat = classifySurface(point, normal, material);

    // Time of flight from the shooter's eye, so the impact lands with the round.
    const d = engine.camera.position.distanceTo(point);
    const delay = Math.min(d / 460, 0.35);

    // Deferring by less than a frame does not delay anything — it just moves
    // the effect one whole frame into the future, which at low frame rates is
    // the difference between an impact that exists and one that does not. If
    // the round would land before the next frame is drawn, land it now.
    if (delay <= (engine.delta || 0.016)) {
      spawnImpact(this, point, normal, mat, impulse, engine);
      return;
    }

    let slot = null;
    for (const s of this._pending) { if (!s.active) { slot = s; break; } }
    if (!slot) { spawnImpact(this, point, normal, mat, impulse, engine); return; }

    slot.active = true;
    slot.t = delay;
    slot.point.copy(point);
    slot.normal.copy(normal);
    slot.material = mat;
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
    // The clock first. Everything below spawns particles, and a particle
    // written before `ParticleSystem.update` has advanced its clock is stamped
    // with the *previous* frame's birth time — it arrives on screen already a
    // frame old, which for a 0.2 s spark is most of its life.
    this.particles.update(dt, engine);
    this.decals.update(dt, engine);

    // Queued impacts: they may spawn particles this frame.
    for (const s of this._pending) {
      if (!s.active) continue;
      s.t -= dt;
      if (s.t > 0) continue;
      s.active = false;
      spawnImpact(this, s.point, s.normal, s.material, s.impulse, engine);
    }

    this._updateSmokers(dt);
    this.explosions.update(dt, engine);
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
const _down = new THREE.Vector3(0, -1, 0);

const _dbgP = new THREE.Vector3();
const _dbgN = new THREE.Vector3();
const _dbgQ = new THREE.Vector3();
const _dbgV = new THREE.Vector3();
const _dbgS = new THREE.Vector3();
const _dbgTint = new THREE.Color();

const _dressO = new THREE.Vector3();
const _dressD = new THREE.Vector3();
const _dressTint = new THREE.Color();

/** Small deterministic PRNG so level dressing is identical on every load. */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
