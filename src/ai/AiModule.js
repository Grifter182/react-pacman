import * as THREE from 'three';
import { Config } from '../core/Config.js';

/**
 * OWNER: AI agent.
 *
 * Enemy combatants: navigation, perception, cover selection, engagement and
 * death. Baseline gives each bot a capsule proxy, waypoint wandering and
 * line-of-sight aggression so the map is populated and shootable.
 *
 * Replace with: navmesh generation from level geometry, A* + funnel string
 * pulling, a behaviour tree (patrol/investigate/engage/flank/suppress/retreat),
 * skeletal characters with locomotion blending, and ragdoll on death.
 *
 * Exposes `this.actors` — MatchModule and WeaponModule read it for hit tests.
 */
export class AiModule {
  constructor() {
    this.actors = [];
    this.root = new THREE.Group();
    this.root.name = 'Actors';
  }

  async init(engine) {
    engine.scene.add(this.root);
    this.collision = engine.get('collision');
    this.level = engine.get('level');

    const count = Config.match.botCount;
    for (let i = 0; i < count; i++) this._spawnBot(engine, i);

    engine.bus.on('weapon:fire', (e) => this._resolveHit(e, engine));
    engine.ai = this;
  }

  _spawnBot(engine, i) {
    const geo = new THREE.CapsuleGeometry(0.32, 1.05, 6, 12);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(0.06, 0.25, 0.24),
      roughness: 0.78,
      metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.7 })
    );
    head.position.y = 0.75;
    head.castShadow = true;
    mesh.add(head);

    const spawn = this.level?.pickSpawn(1) || { position: new THREE.Vector3(0, 1, -20) };
    mesh.position.copy(spawn.position).setY(0.87);
    this.root.add(mesh);

    this.actors.push({
      id: i,
      mesh,
      head,
      health: 100,
      alive: true,
      team: 1,
      velocity: new THREE.Vector3(),
      target: new THREE.Vector3().copy(mesh.position),
      thinkTimer: Math.random(),
      fireTimer: 0.5 + Math.random(),
      alert: 0,
      respawnTimer: 0,
    });
  }

  fixedUpdate(dt, engine) {
    const player = engine.get('player');
    const pPos = player?.state.position;

    for (const a of this.actors) {
      if (!a.alive) {
        a.respawnTimer -= dt;
        if (a.respawnTimer <= 0) this._respawn(a, engine);
        continue;
      }

      a.thinkTimer -= dt;
      if (a.thinkTimer <= 0) {
        a.thinkTimer = 0.5 + Math.random() * 0.8;
        this._think(a, pPos, engine);
      }

      // Steer toward target, snapped to the ground plane.
      _v3a.subVectors(a.target, a.mesh.position);
      _v3a.y = 0;
      const dist = _v3a.length();
      if (dist > 0.4) {
        _v3a.divideScalar(dist);
        const speed = a.alert > 0.5 ? 4.4 : 2.3;
        a.velocity.lerp(_v3b.copy(_v3a).multiplyScalar(speed), Math.min(1, dt * 6));
      } else {
        a.velocity.multiplyScalar(Math.max(0, 1 - dt * 8));
      }

      a.mesh.position.addScaledVector(a.velocity, dt);
      this.collision?.capsuleResolve(a.mesh.position, 0.34, 0.86, 2);
      a.mesh.position.y = Math.max(0.87, a.mesh.position.y);

      // Face movement, or the player when alerted.
      const faceX = a.alert > 0.5 && pPos ? pPos.x - a.mesh.position.x : a.velocity.x;
      const faceZ = a.alert > 0.5 && pPos ? pPos.z - a.mesh.position.z : a.velocity.z;
      if (Math.abs(faceX) + Math.abs(faceZ) > 1e-3) {
        const yaw = Math.atan2(faceX, faceZ);
        a.mesh.rotation.y = _lerpAngle(a.mesh.rotation.y, yaw, Math.min(1, dt * 7));
      }

      a.alert = Math.max(0, a.alert - dt * 0.25);
    }
  }

  _think(a, pPos, engine) {
    if (pPos && this._canSee(a, pPos)) {
      a.alert = 1;
      // Close to engagement range but keep some distance.
      _v3a.subVectors(a.mesh.position, pPos);
      _v3a.y = 0;
      const d = _v3a.length();
      if (d > 16) a.target.copy(pPos).addScaledVector(_v3a.normalize(), 12);
      else if (d < 6) a.target.copy(pPos).addScaledVector(_v3a.normalize(), 9);
      else a.target.copy(a.mesh.position).addScaledVector(
        _v3b.set(-_v3a.z, 0, _v3a.x).normalize(), (Math.random() - 0.5) * 8
      );
    } else if (a.alert < 0.2) {
      const b = this.level?.bounds;
      const range = b ? Math.min(40, (b.max.x - b.min.x) * 0.4) : 30;
      a.target.set((Math.random() - 0.5) * range * 2, 0.87, (Math.random() - 0.5) * range * 2);
    }
  }

  _canSee(a, pPos) {
    _v3c.copy(pPos).setY(pPos.y + 0.5);
    _v3a.subVectors(_v3c, a.head.getWorldPosition(_v3b));
    const dist = _v3a.length();
    if (dist > 70) return false;
    _v3a.divideScalar(dist);
    const hit = this.collision?.raycast(_v3b, _v3a, dist - 0.4);
    return !hit;
  }

  /** Hitscan resolution against bot capsules — runs before world geometry. */
  _resolveHit({ direction, hit }, engine) {
    const cam = engine.camera;
    const origin = cam.getWorldPosition(_v3a);
    const worldDist = hit ? hit.distance : 400;

    let best = null, bestT = worldDist;
    for (const a of this.actors) {
      if (!a.alive) continue;
      const t = _raySphere(origin, direction, a.mesh.position, 0.55);
      if (t !== null && t < bestT) {
        const headT = _raySphere(origin, direction, a.head.getWorldPosition(_v3b), 0.18);
        best = { actor: a, t, headshot: headT !== null };
        bestT = t;
      }
    }
    if (!best) return;

    const w = engine.get('weapons');
    const def = w ? (w.constructor.WEAPONS?.[w.current]) : null;
    const base = 33;
    const damage = base * (best.headshot ? 2.1 : 1);
    best.actor.health -= damage;
    best.actor.alert = 1;

    _v3c.copy(origin).addScaledVector(direction, best.t);
    engine.bus.emit('hit:actor', {
      actor: best.actor, point: _v3c.clone(),
      normal: direction.clone().negate(), damage, headshot: best.headshot,
    });

    if (best.actor.health <= 0) {
      best.actor.alive = false;
      best.actor.respawnTimer = 5 + Math.random() * 3;
      best.actor.mesh.visible = false;
      engine.bus.emit('actor:killed', { actor: best.actor, by: 'player', headshot: best.headshot });
    }
  }

  _respawn(a, engine) {
    const spawn = this.level?.pickSpawn(1);
    if (spawn) a.mesh.position.copy(spawn.position).setY(0.87);
    a.health = 100;
    a.alive = true;
    a.alert = 0;
    a.mesh.visible = true;
  }

  dispose() {
    for (const a of this.actors) { a.mesh.geometry.dispose(); a.mesh.material.dispose(); }
    this.actors.length = 0;
  }
}

function _lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function _raySphere(origin, dir, center, radius) {
  const ox = origin.x - center.x, oy = origin.y - center.y, oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
