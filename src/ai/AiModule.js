import * as THREE from 'three';
import { Config, QualityTier } from '../core/Config.js';
import { NavMesh } from './NavMesh.js';
import { CoverMap } from './Cover.js';
import { Perception } from './Perception.js';
import { CombatSystem, createCombat, DIFFICULTY, rayCapsule } from './Combat.js';
import { Brain, createBrain, Tactic } from './Brain.js';
import { soldierAsset, createSoldierInstance, disposeSoldierAsset, HITBOXES, MUZZLE_LOCAL } from './Soldier.js';
import { Locomotion } from './Locomotion.js';
import { Ragdoll } from './Ragdoll.js';

/**
 * OWNER: AI agent.
 *
 * The enemy squad, end to end.
 *
 *   NavMesh.js     voxelised navmesh from the collider + A* + funnel
 *   Cover.js       cover points harvested from the navmesh
 *   Perception.js  FOV cone, hearing, visibility accumulator, memory
 *   Brain.js       posture/tactic HFSM
 *   Combat.js      reaction time, convergent aim, bursts, suppression, grenades
 *   Soldier.js     procedural skinned soldier + per-limb hitboxes
 *   Locomotion.js  gait, foot IK, torso aiming, hit reactions
 *   Ragdoll.js     Verlet death simulation
 *
 * PUBLIC SURFACE (unchanged from the baseline module):
 *   `this.actors`   array of actors; each has `.mesh`, `.head`, `.health`,
 *                   `.alive`, `.team`, `.velocity`, `.position`
 *   emits 'hit:actor' { actor, point, normal, damage, headshot }
 *   emits 'actor:killed' { actor, by, headshot }
 */

/** Per-tier AI cost knobs. Anything here costs frame time, so it is gated. */
const AI_TIERS = {
  [QualityTier.LOW]: { navCell: 0.52, footIK: false, ragdolls: 2, tracers: 16, detail: 1, perceptionHz: 6 },
  [QualityTier.MEDIUM]: { navCell: 0.46, footIK: true, ragdolls: 3, tracers: 24, detail: 1, perceptionHz: 8 },
  [QualityTier.HIGH]: { navCell: 0.38, footIK: true, ragdolls: 4, tracers: 32, detail: 2, perceptionHz: 10 },
  [QualityTier.ULTRA]: { navCell: 0.34, footIK: true, ragdolls: 6, tracers: 32, detail: 2, perceptionHz: 12 },
};

const CAPSULE_HALF = 0.87;
const CAPSULE_RADIUS = 0.34;

export class AiModule {
  constructor() {
    this.actors = [];
    this.root = new THREE.Group();
    this.root.name = 'Actors';
    this.difficulty = 'regular';
    this._pathQueue = [];
    this._flashPool = [];
    this._time = 0;
    this._ragdolls = [];
  }

  async init(engine) {
    this.engine = engine;
    engine.scene.add(this.root);
    this.collision = engine.get('collision');
    this.level = engine.get('level');
    this.tier = AI_TIERS[Config.quality] || AI_TIERS[QualityTier.HIGH];

    /* --- navigation -------------------------------------------------------- */
    this.nav = new NavMesh({
      cell: this.tier.navCell,
      agentRadius: CAPSULE_RADIUS + 0.08,
      agentHeight: 1.72,
      stepHeight: Config.player.stepHeight,
      maxSlopeDeg: Config.player.maxSlopeDeg + 2,
    });
    const collider = this.collision?.collider || this.level?.collider;
    if (collider?.geometry) {
      const bounds = this.level?.bounds
        || new THREE.Box3().setFromBufferAttribute(collider.geometry.getAttribute('position'));
      this.nav.build(collider.geometry, bounds);
    }
    this.cover = new CoverMap().build(this.nav);
    const ns = this.nav.stats();
    console.info('[AI] navmesh', `${ns.usable}/${ns.surfaces} surfaces,`,
      `${ns.regions} regions, cell ${ns.cell.toFixed(2)}m,`,
      `${ns.buildMs.toFixed(0)}ms · cover ${this.cover.points.length} points`);

    /* --- systems ----------------------------------------------------------- */
    this.perception = new Perception();
    this.combat = new CombatSystem(engine);
    this.brain = new Brain({
      nav: this.nav, cover: this.cover, perception: this.perception,
      combat: this.combat, collision: this.collision, level: this.level,
      player: engine.get('player'), engine, time: 0, actors: this.actors,
      requestPath: (a, dest, reason) => this._requestPath(a, dest, reason),
    });

    this.asset = soldierAsset(this.tier.detail);
    this._initTracers();
    this._initFlashes();

    for (let i = 0; i < Config.match.botCount; i++) this._spawnBot(engine, i);

    engine.bus.on('weapon:fire', (e) => this._resolveHit(e, engine));
    engine.bus.on('weapon:fire', (e) => this._noise(e.eyeOrigin || e.origin, 62));
    engine.bus.on('player:footstep', (e) => this._noise(e.position, e.stance === 'sprint' ? 17 : e.stance === 'crouch' ? 5 : 10));
    engine.bus.on('player:land', (e) => this._noise(e.position, e.hard ? 20 : 9));
    engine.bus.on('fx:explosion', (e) => this._noise(e.position, 90));
    engine.bus.on('player:died', () => { for (const a of this.actors) a.percept.alert *= 0.4; });

    engine.ai = this;
  }

  /* ------------------------------------------------------------------ spawn */

  _spawnBot(engine, i) {
    const inst = createSoldierInstance(this.asset);
    this.root.add(inst.rig);
    this.root.add(inst.mesh);

    // Squads are not uniform: a fifth of them sit a rung either side of the set
    // difficulty, which is what stops seven identical reaction times.
    const ladder = ['recruit', 'regular', 'veteran', 'elite'];
    const at = Math.max(0, ladder.indexOf(this.difficulty));
    const roll = Math.random();
    const rung = roll < 0.20 ? Math.max(0, at - 1) : roll > 0.80 ? Math.min(ladder.length - 1, at + 1) : at;
    const skill = DIFFICULTY[ladder[rung]];

    const spawn = this.level?.pickSpawn(1) || { position: new THREE.Vector3(0, 0.1, -20) };
    const a = {
      id: i,
      mesh: inst.rig,               // legacy field: the actor's transform node
      skin: inst.mesh,
      head: inst.byName.get('head'),
      inst,
      loco: new Locomotion(inst),
      ragdoll: null,

      position: new THREE.Vector3().copy(spawn.position).setY(spawn.position.y + CAPSULE_HALF),
      velocity: new THREE.Vector3(),
      yaw: spawn.yaw ?? 0,
      aimPitch: 0,
      health: 100,
      maxHealth: 100,
      alive: true,
      team: 1,
      alert: 0,                      // legacy mirror of percept.alert
      target: new THREE.Vector3(),   // legacy field: current move goal
      thinkTimer: Math.random() * 0.2,
      fireTimer: 0,
      respawnTimer: 0,
      lastDamaged: -99,

      percept: Perception.create(),
      combat: createCombat(skill),
      brain: createBrain(),
      skill: { perception: skill.perception },
      cover: null,
      path: null,
      pathIndex: 0,
      pathDone: true,
      pathAge: 0,
      _perceptTimer: Math.random() * 0.2,
      _groundY: spawn.position.y,
      _eye: new THREE.Vector3(),
      _muzzle: new THREE.Vector3(),
    };
    a.percept.lastKnown.copy(a.position);
    a.brain.aimPoint.copy(a.position).add(new THREE.Vector3(0, 0.5, 4));

    this.actors.push(a);
  }

  /* ------------------------------------------------------------------- loop */

  fixedUpdate(dt, engine) {
    this._time += dt;
    this.brain.ctx.time = this._time;
    this.brain.ctx.player = engine.get('player');
    const player = this.brain.ctx.player;
    if (!player) return;

    const perceptStep = 1 / this.tier.perceptionHz;

    for (const a of this.actors) {
      if (!a.alive) {
        a.respawnTimer -= dt;
        if (a.respawnTimer <= 0) this._respawn(a, engine);
        continue;
      }

      /* --- perception ----------------------------------------------------- */
      a._perceptTimer -= dt;
      if (a._perceptTimer <= 0) {
        const step = perceptStep + a._perceptTimer;
        a._perceptTimer = perceptStep;
        a.loco.eye(a._eye);
        this.perception.update(Math.max(1e-3, step), a, player.state, {
          collision: this.collision, time: this._time, eye: a._eye,
        });
        a.alert = a.percept.alert;
        if (a.percept.justSpotted) {
          engine.bus.emit('ai:spotted', { actor: a, position: player.state.position.clone() });
        }
      }

      /* --- decide ---------------------------------------------------------- */
      a.thinkTimer -= dt;
      if (a.thinkTimer <= 0) {
        const step = 0.12 + Math.random() * 0.04;
        this.brain.tick(0.12 - a.thinkTimer, a);
        a.thinkTimer = step;
      }

      /* --- move ------------------------------------------------------------ */
      this._steer(dt, a);

      /* --- shoot ----------------------------------------------------------- */
      a.loco.muzzle(a._muzzle, MUZZLE_LOCAL);
      const b = a.brain;
      // Half a second of grace after losing sight: a bot mid-burst finishes it
      // rather than stopping dead the instant your head clears a doorway.
      const visible = a.percept.spotted || b.tactic === Tactic.SUPPRESS
        || this._time - a.percept.lastSeen < 0.6;
      this.combat.update(dt, a, {
        time: this._time,
        target: player.state,
        targetVisible: visible,
        allowFire: b.wantFire && a.alive,
        muzzle: a._muzzle,
        aimPoint: b.aimPoint,
      });
    }

    this.combat.stepGrenades(dt);
  }

  /**
   * Path following with local avoidance. Steering is deliberately simple —
   * the navmesh is already eroded by the agent radius, so the only thing left
   * to solve is agent-vs-agent, and for that a reciprocal repulsion weighted by
   * time-to-collision beats a full ORCA solve at a fraction of the cost.
   */
  _steer(dt, a) {
    const b = a.brain;
    const desiredSpeed = b.desiredSpeed;

    /* --- pick a steering target ------------------------------------------- */
    let tx = 0, tz = 0, has = false;
    if (a.path && !a.pathDone) {
      const wp = a.path[a.pathIndex];
      if (wp) {
        const dx = wp.x - a.position.x, dz = wp.z - a.position.z;
        const d = Math.hypot(dx, dz);
        const last = a.pathIndex === a.path.length - 1;
        if (d < (last ? 0.55 : 1.0)) {
          a.pathIndex++;
          // The path itself is left in place: the brain reads `pathDone` to
          // decide what to do next, and clearing it here would make arrival
          // indistinguishable from never having had a path.
          if (a.pathIndex >= a.path.length) a.pathDone = true;
        } else { tx = dx / d; tz = dz / d; has = true; }
      } else { a.pathDone = true; }
      a.pathAge += dt;
      if (a.pathAge > 12) a.pathDone = true;      // stale: the world moved on
    } else if (b.hasGoal) {
      const dx = b.goal.x - a.position.x, dz = b.goal.z - a.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.28) { tx = dx / d; tz = dz / d; has = true; }
    }

    if (has) { a.target.set(a.position.x + tx * 2, a.position.y, a.position.z + tz * 2); }

    /* --- lateral strafe (combat shuffling) --------------------------------- */
    if (b.strafe && !has) {
      tx = Math.cos(a.yaw) * b.strafe;
      tz = -Math.sin(a.yaw) * b.strafe;
      has = Math.abs(b.strafe) > 0.05;
    }

    /* --- local avoidance --------------------------------------------------- */
    let ax = 0, az = 0;
    for (const o of this.actors) {
      if (o === a || !o.alive) continue;
      const dx = a.position.x - o.position.x, dz = a.position.z - o.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 6.25 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      // Reciprocal: both agents take half the correction, so they part cleanly
      // instead of chasing each other's avoidance vector.
      const push = (2.5 - d) / 2.5;
      ax += (dx / d) * push;
      az += (dz / d) * push;
      // Bias the correction sideways so two agents on a head-on course do not
      // deadlock pushing straight back at each other.
      ax += (-dz / d) * push * 0.5 * (a.id < o.id ? 1 : -1);
      az += (dx / d) * push * 0.5 * (a.id < o.id ? 1 : -1);
    }

    let wx = tx * desiredSpeed + ax * 3.2;
    let wz = tz * desiredSpeed + az * 3.2;
    const wl = Math.hypot(wx, wz);
    const maxSpeed = Math.max(desiredSpeed, has ? desiredSpeed : 1.2);
    if (wl > maxSpeed && wl > 1e-5) { wx = wx / wl * maxSpeed; wz = wz / wl * maxSpeed; }
    if (!has && ax === 0 && az === 0) { wx = 0; wz = 0; }

    const accel = has ? 12 : 9;
    a.velocity.x += (wx - a.velocity.x) * Math.min(1, dt * accel);
    a.velocity.z += (wz - a.velocity.z) * Math.min(1, dt * accel);

    a.position.x += a.velocity.x * dt;
    a.position.z += a.velocity.z * dt;

    /* --- ground and walls --------------------------------------------------- */
    // The collision capsule does not shrink when a bot crouches: `position` is
    // the anchor the whole rig hangs from, so changing the half-height would
    // sink the mesh into the floor. Crouching is a pose, not a volume change.
    const half = CAPSULE_HALF;
    this.collision?.capsuleResolve(a.position, CAPSULE_RADIUS, half, 3);

    _v.set(a.position.x, a.position.y + 0.5, a.position.z);
    const hit = this.collision?.raycast(_v, _down, 3.2);
    if (hit) {
      a._groundY = hit.point.y;
    } else if (this.nav.ready) {
      a._groundY = this.nav.sampleHeight(a.position);
    }
    // Vertical is servo'd, not simulated: bots have no jump, and a spring here
    // keeps them glued to stairs and ramps without any airborne state.
    const targetY = a._groundY + half;
    a.position.y += (targetY - a.position.y) * Math.min(1, dt * 14);

    /* --- facing -------------------------------------------------------------- */
    const combatFacing = b.posture === 'combat' || b.posture === 'alerted';
    let faceX, faceZ;
    if (combatFacing) {
      faceX = b.aimPoint.x - a.position.x;
      faceZ = b.aimPoint.z - a.position.z;
    } else {
      faceX = a.velocity.x; faceZ = a.velocity.z;
    }
    if (Math.abs(faceX) + Math.abs(faceZ) > 1e-3) {
      const yaw = Math.atan2(faceX, faceZ);
      a.yaw = lerpAngle(a.yaw, yaw, Math.min(1, dt * (combatFacing ? 9 : 5)));
    }
    // Pitch is measured from the eye so the torso leans correctly up stairwells.
    const dy = b.aimPoint.y - (a.position.y + 0.72);
    const flat = Math.hypot(b.aimPoint.x - a.position.x, b.aimPoint.z - a.position.z);
    a.aimPitch = Math.atan2(dy, Math.max(0.2, flat));
  }

  /* ------------------------------------------------------------ pathfinding */

  _requestPath(a, dest, reason) {
    if (!this.nav.ready || !dest) return;
    a.pathDone = false;
    this._pathQueue.push({ a, dest: dest.clone(), reason });
    if (this._pathQueue.length > 24) this._pathQueue.shift();
  }

  /** Two searches per frame at most, oldest first. */
  _servePathQueue() {
    let budget = 2;
    while (budget-- > 0 && this._pathQueue.length) {
      const req = this._pathQueue.shift();
      const a = req.a;
      if (!a.alive) continue;
      const pts = this.nav.findPath(a.position, req.dest, []);
      if (pts && pts.length) {
        a.path = pts;
        a.pathIndex = pts.length > 1 ? 1 : 0;
        a.pathDone = false;
        a.pathAge = 0;
      } else {
        a.path = null;
        a.pathDone = true;
      }
    }
  }

  /* ------------------------------------------------------------- perception */

  _noise(position, loudness) {
    if (!position) return;
    for (const a of this.actors) {
      if (!a.alive) continue;
      this.perception.hear(a, position, loudness, this._time);
    }
  }

  /* --------------------------------------------------------------- rendering */

  update(dt, engine) {
    const camPos = engine.camera.position;
    // Pathfinding is served per *frame*, not per fixed step: A* is the only
    // spiky cost in the module and the fixed step can run eight times a frame.
    this._servePathQueue();

    for (const a of this.actors) {
      if (a.ragdoll?.active) { a.ragdoll.step(dt); continue; }
      if (!a.alive) continue;

      const distSq = a.position.distanceToSquared(camPos);
      // Foot IK is the only per-frame ray cost in the animation layer; it stops
      // paying for itself long before the bot stops being visible.
      const footIK = this.tier.footIK && distSq < 42 * 42;
      a.loco.update(dt, {
        collision: this.collision,
        position: a.position,
        yaw: a.yaw,
        aimYaw: Math.atan2(a.brain.aimPoint.x - a.position.x, a.brain.aimPoint.z - a.position.z),
        aimPitch: -a.aimPitch,
        aimBlend: a.brain.posture === 'combat' ? 1 : a.brain.posture === 'alerted' ? 0.55 : 0.1,
        crouch: a.brain.crouch,
        speed: Math.hypot(a.velocity.x, a.velocity.z),
        footIK,
        time: this._time,
      });
    }

    this._updateTracers(dt);
    this._updateFlashes(dt);
  }

  /* ------------------------------------------------------------------- hits */

  /**
   * Hitscan resolution against per-limb capsules. Runs before world geometry so
   * a round that would have hit a wall behind a bot still hits the bot.
   */
  _resolveHit(e, engine) {
    const origin = e.eyeOrigin || e.origin;
    const direction = e.direction;
    if (!origin || !direction) return;
    const worldDist = e.hit ? e.hit.distance : 400;

    let best = null, bestT = worldDist;
    for (const a of this.actors) {
      if (!a.alive) continue;
      // Broad phase: the whole body as one capsule.
      const coarse = rayCapsule(origin, direction, a.position, CAPSULE_HALF + 0.12, 0.55);
      if (coarse === null || coarse > bestT) continue;

      for (const hb of HITBOXES) {
        const bone = a.inst.byName.get(hb.bone);
        if (!bone) continue;
        _v.set(hb.offset[0], hb.offset[1], hb.offset[2]).applyMatrix4(bone.matrixWorld);
        const t = rayCapsule(origin, direction, _v, hb.half + hb.radius, hb.radius);
        if (t !== null && t < bestT) {
          bestT = t;
          best = { actor: a, t, limb: hb.limb };
        }
      }
    }
    if (!best) return;

    const weapons = engine.get('weapons');
    // The weapon table owns the damage curve; this only picks the limb.
    const base = typeof e.damage === 'number' ? e.damage : 33;
    const limbMul = weapons?.limbFactor ? weapons.limbFactor(best.limb, e.weapon) : (best.limb === 'head' ? 2.0 : 1);
    const damage = base * limbMul;
    const headshot = best.limb === 'head';

    _pt.copy(origin).addScaledVector(direction, best.t);
    this._damageActor(best.actor, damage, {
      point: _pt, direction, headshot, limb: best.limb, by: 'player',
    }, engine);
  }

  _damageActor(a, damage, info, engine) {
    a.health -= damage;
    a.lastDamaged = this._time;
    a.percept.alert = 1;
    // Being shot at from an unseen direction is information: bots turn and
    // treat the shooter's bearing as a contact.
    const player = engine.get('player');
    if (player) {
      a.percept.lastKnown.copy(player.state.position);
      a.percept.lastHeard = this._time;
      a.percept.visibility = Math.max(a.percept.visibility, 0.75);
      if (a.brain.tactic === Tactic.PATROL || a.brain.tactic === Tactic.IDLE) {
        a.brain.tactic = Tactic.TAKE_COVER;
        a.brain.since = 99;
      }
    }
    a.loco.react(info.direction, Math.min(1, damage / 40), info.limb);

    engine.bus.emit('hit:actor', {
      actor: a,
      point: info.point.clone(),
      normal: info.direction.clone().negate(),
      damage, headshot: info.headshot, limb: info.limb,
    });

    if (a.health <= 0) this._kill(a, info, engine);
  }

  _kill(a, info, engine) {
    a.alive = false;
    a.health = 0;
    a.respawnTimer = 6 + Math.random() * 4;
    a.brain.tactic = Tactic.DEAD;
    a.velocity.set(0, 0, 0);
    if (a.cover) { this.cover.release(a.cover, a.id); a.cover = null; }
    a.path = null;

    // Budgeted ragdolls: over the limit, the oldest corpse is frozen so the
    // simulation cost cannot grow with the killfeed.
    _v.copy(info.direction).multiplyScalar(Math.min(6, 2.5 + a.maxHealth * 0.02));
    _v.y += 1.4;
    const rd = new Ragdoll().start(a.inst, a.velocity, _v, this.collision);
    a.ragdoll = rd;
    this._ragdolls.push(a);
    while (this._ragdolls.length > this.tier.ragdolls) {
      const old = this._ragdolls.shift();
      old.ragdoll?.stop();
    }

    engine.bus.emit('actor:killed', { actor: a, by: info.by || 'player', headshot: !!info.headshot });
  }

  _respawn(a, engine) {
    const player = engine.get('player');
    const avoid = player ? [player.state.position] : [];
    const spawn = this.level?.pickSpawn(1, avoid);
    if (spawn) {
      a.position.copy(spawn.position).setY(spawn.position.y + CAPSULE_HALF);
      a._groundY = spawn.position.y;
      a.yaw = spawn.yaw ?? 0;
    }
    a.health = a.maxHealth;
    a.alive = true;
    a.velocity.set(0, 0, 0);
    a.ragdoll?.stop();
    a.ragdoll = null;
    const idx = this._ragdolls.indexOf(a);
    if (idx >= 0) this._ragdolls.splice(idx, 1);

    // Rebuild the rest pose: the ragdoll left the bones wherever they landed.
    for (let i = 0; i < a.inst.bones.length; i++) {
      a.inst.bones[i].position.copy(a.inst.rest[i].p);
      a.inst.bones[i].quaternion.copy(a.inst.rest[i].q);
    }
    a.inst.rig.position.copy(a.position);
    a.inst.rig.rotation.set(0, a.yaw, 0);
    a.inst.rig.updateMatrixWorld(true);

    a.percept = Perception.create();
    a.percept.lastKnown.copy(a.position);
    a.brain = createBrain();
    a.brain.aimPoint.copy(a.position).add(_v.set(Math.sin(a.yaw), 0.5, Math.cos(a.yaw)).multiplyScalar(6));
    a.combat.reactTimer = 0.6;
    a.combat.aimError = a.combat.skill.errStart;
    a.pathDone = true;
    a.alert = 0;
  }

  /* ------------------------------------------------------------------- FX */

  _initTracers() {
    const count = this.tier.tracers;
    const geo = new THREE.CylinderGeometry(0.011, 0.011, 1, 4, 1, true);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(3.2, 1.5, 0.5),
      transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.tracers = new THREE.InstancedMesh(geo, mat, count);
    this.tracers.frustumCulled = false;
    this.tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < count; i++) { _m.makeScale(0, 0, 0); this.tracers.setMatrixAt(i, _m); }
    this.tracers.instanceMatrix.needsUpdate = true;
    this.root.add(this.tracers);
    this._tracerFree = [];
    for (let i = 0; i < count; i++) this._tracerFree.push(i);
    this._tracerLive = [];

    this.engine.bus.on('ai:fire', ({ origin, end }) => this._spawnTracer(origin, end));
  }

  _spawnTracer(from, to) {
    const idx = this._tracerFree.pop();
    if (idx === undefined) return;
    const dist = from.distanceTo(to);
    _v.copy(to).add(from).multiplyScalar(0.5);
    _m.lookAt(from, to, _up);
    _q.setFromRotationMatrix(_m);
    _m.compose(_v, _q, _scale.set(1, 1, dist));
    this.tracers.setMatrixAt(idx, _m);
    this.tracers.instanceMatrix.needsUpdate = true;
    this._tracerLive.push({ idx, life: 0.06 });
  }

  _updateTracers(dt) {
    for (let i = this._tracerLive.length - 1; i >= 0; i--) {
      const t = this._tracerLive[i];
      t.life -= dt;
      if (t.life <= 0) {
        _m.makeScale(0, 0, 0);
        this.tracers.setMatrixAt(t.idx, _m);
        this.tracers.instanceMatrix.needsUpdate = true;
        this._tracerFree.push(t.idx);
        this._tracerLive.splice(i, 1);
      }
    }
  }

  _initFlashes() {
    // Two shared muzzle lights, claimed round-robin. More than that and a
    // firefight starts costing real shadow-free light updates.
    const n = Config.quality === QualityTier.LOW ? 1 : 2;
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffca88, 0, 9, 2);
      l.visible = false;
      this.root.add(l);
      this._flashPool.push({ light: l, life: 0 });
    }
    this._flashNext = 0;
    this.engine.bus.on('ai:fire', ({ origin }) => {
      const f = this._flashPool[this._flashNext % this._flashPool.length];
      this._flashNext++;
      if (!f) return;
      f.light.position.copy(origin);
      f.life = 0.05;
      f.light.visible = true;
    });
  }

  _updateFlashes(dt) {
    for (const f of this._flashPool) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const k = Math.max(0, f.life / 0.05);
      f.light.intensity = k * 16;
      if (f.life <= 0) { f.light.visible = false; f.light.intensity = 0; }
    }
  }

  /* ------------------------------------------------------------------- api */

  /** Difficulty affects reaction time and accuracy only — never health. */
  setDifficulty(name) {
    if (!DIFFICULTY[name]) return this.difficulty;
    this.difficulty = name;
    for (const a of this.actors) {
      a.combat.skill = DIFFICULTY[name];
      a.skill.perception = DIFFICULTY[name].perception;
    }
    return name;
  }

  stats() {
    const byTactic = {};
    for (const a of this.actors) byTactic[a.brain.tactic] = (byTactic[a.brain.tactic] || 0) + 1;
    return { nav: this.nav.stats(), cover: this.cover.stats(), tactics: byTactic };
  }

  dispose() {
    for (const a of this.actors) {
      a.ragdoll?.stop();
      a.inst.skeleton.dispose?.();
    }
    this.actors.length = 0;
    this.tracers?.dispose();
    this.combat?.dispose();
    disposeSoldierAsset();
  }
}

function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

const _v = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
