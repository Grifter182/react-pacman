import * as THREE from 'three';

/**
 * OWNER: VFX agent.
 *
 * Pooled rigid bodies for the things that are too big to be particles: ejected
 * shell casings and explosion chunks. One instanced draw call per pool, a fixed
 * body count, and no allocation once the pool is built.
 *
 * Integration is semi-implicit Euler at a fixed 60 Hz sub-step (the engine's
 * 120 Hz tick is finer than these need and every step costs a BVH ray). A body
 * sweeps against the world by casting along its own velocity for the distance
 * it is about to travel, so a casing bouncing off a stair at 6 m/s cannot
 * tunnel through it. On contact the velocity is split into normal and tangent
 * components: the normal part reverses and loses (1 - restitution) of itself,
 * the tangent part is scraped down by friction, and the spin is damped by the
 * same contact — which is what stops a casing spinning forever on the floor.
 */
export class DebrisPool {
  /**
   * @param {object} o
   * @param {THREE.BufferGeometry} o.geometry unit-sized body geometry
   * @param {THREE.Material} o.material
   * @param {number} o.capacity
   * @param {number} o.radius     collision radius in metres
   * @param {number} o.restitution
   * @param {number} o.friction   tangential scrape, 0..1
   */
  constructor({ geometry, material, capacity, radius = 0.02, restitution = 0.32,
    friction = 0.55, name = 'FxDebris' }) {
    this.capacity = capacity;
    this.radius = radius;
    this.restitution = restitution;
    this.friction = friction;
    this._accum = 0;
    this._step = 1 / 60;

    this.bodies = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.bodies[i] = {
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        spinAxis: new THREE.Vector3(0, 1, 0),
        spin: 0,
        scale: new THREE.Vector3(1, 1, 1),
        age: 0,
        life: 4,
        resting: false,
        bounces: 0,
      };
    }
    this.cursor = 0;

    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = name;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _m4.makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, _m4);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * @param {THREE.Vector3} position
   * @param {THREE.Vector3} velocity
   * @param {object} [o] { life, spin, scale }
   */
  spawn(position, velocity, o = null) {
    // Round-robin eviction: the oldest body in flight is the one nobody is
    // looking at any more.
    let b = null;
    for (let i = 0; i < this.capacity; i++) {
      const cand = this.bodies[(this.cursor + i) % this.capacity];
      if (!cand.active) { b = cand; this.cursor = (this.cursor + i + 1) % this.capacity; break; }
    }
    if (!b) { b = this.bodies[this.cursor]; this.cursor = (this.cursor + 1) % this.capacity; }

    b.active = true;
    b.resting = false;
    b.bounces = 0;
    b.age = 0;
    b.life = (o && o.life) || 6;
    b.pos.copy(position);
    b.vel.copy(velocity);
    b.spin = (o && o.spin !== undefined) ? o.spin : 12;
    b.spinAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    b.quat.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    if (o && o.scale) b.scale.copy(o.scale); else b.scale.set(1, 1, 1);
    return b;
  }

  /**
   * @param {number} dt
   * @param {object} collision CollisionModule or null
   * @param {function} [onImpact] (body, hit) => void — dust, sound, sparks
   */
  fixedUpdate(dt, collision, onImpact) {
    this._accum += dt;
    let steps = 0;
    while (this._accum >= this._step && steps < 4) {
      this._integrate(this._step, collision, onImpact);
      this._accum -= this._step;
      steps++;
    }
    if (steps >= 4) this._accum = 0;
  }

  _integrate(h, collision, onImpact) {
    const g = -19.6;                       // matches Config.player.gravity
    for (let i = 0; i < this.capacity; i++) {
      const b = this.bodies[i];
      if (!b.active) continue;

      b.age += h;
      if (b.age > b.life + 0.5) { b.active = false; continue; }
      if (b.resting) continue;

      b.vel.y += g * h;
      // Light air drag so tumbling chips settle instead of skating.
      b.vel.multiplyScalar(1 - Math.min(0.6 * h, 0.2));

      const speed = b.vel.length();
      const travel = speed * h;
      let moved = false;

      if (collision && collision.collider && travel > 1e-5) {
        _dir.copy(b.vel).multiplyScalar(1 / speed);
        const hit = collision.raycast(b.pos, _dir, travel + this.radius);
        if (hit) {
          const vn = b.vel.dot(hit.normal);
          b.pos.copy(hit.point).addScaledVector(hit.normal, this.radius);
          if (vn < 0) {
            // Split into normal / tangential and treat them separately.
            _tmp.copy(hit.normal).multiplyScalar(vn);
            b.vel.sub(_tmp);                       // tangential
            b.vel.multiplyScalar(1 - this.friction);
            b.vel.addScaledVector(hit.normal, -vn * this.restitution);
            b.spin *= 0.55;
            b.bounces++;
            if (onImpact) onImpact(b, hit, -vn);
          }
          moved = true;
          // Come to rest on a floor once the bounce energy is gone; a body that
          // keeps micro-bouncing is both a visual artefact and pure cost.
          if (b.vel.lengthSq() < 0.35 && hit.normal.y > 0.55) {
            b.resting = true;
            b.vel.set(0, 0, 0);
            b.spin = 0;
          }
        }
      }
      if (!moved) b.pos.addScaledVector(b.vel, h);

      if (b.spin > 0.01) {
        _q.setFromAxisAngle(b.spinAxis, b.spin * h);
        b.quat.premultiply(_q);
      }
    }
  }

  /** Write instance matrices. Only touched when at least one body is alive. */
  sync() {
    let live = 0;
    for (let i = 0; i < this.capacity; i++) {
      const b = this.bodies[i];
      if (!b.active) continue;
      live++;
      // The last half second shrinks the body out rather than popping it.
      const t = b.age - b.life;
      const k = t > 0 ? Math.max(0, 1 - t * 2) : 1;
      _scale.copy(b.scale).multiplyScalar(k);
      _m4.compose(b.pos, b.quat, _scale);
      this.mesh.setMatrixAt(i, _m4);
    }
    if (live > 0 || this._wasLive) {
      // Clear the slots that died this frame.
      if (live !== this._wasLive) {
        _m4.makeScale(0, 0, 0);
        for (let i = 0; i < this.capacity; i++) {
          if (!this.bodies[i].active) this.mesh.setMatrixAt(i, _m4);
        }
      }
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    this._wasLive = live;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}

/* -------------------------------------------------------------- bodies */

/** A rifle case: tapered brass tube with a rim and a hollow mouth. */
export function makeCasingGeometry() {
  const parts = [];
  const body = new THREE.CylinderGeometry(0.0044, 0.0051, 0.040, 10, 1, true);
  body.translate(0, 0.002, 0);
  parts.push(body);
  const head = new THREE.CylinderGeometry(0.0055, 0.0055, 0.004, 10);
  head.translate(0, -0.020, 0);
  parts.push(head);
  const neck = new THREE.CylinderGeometry(0.0036, 0.0044, 0.008, 10, 1, true);
  neck.translate(0, 0.024, 0);
  parts.push(neck);

  const geo = mergeSimple(parts);
  // Long axis on Z so a spawn direction can be used directly as "which way the
  // case is pointing" without another basis change.
  geo.rotateX(Math.PI / 2);
  return geo;
}

/** An angular masonry chunk — a cube with its corners pushed around. */
export function makeChunkGeometry(seed = 1) {
  const geo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  const pos = geo.attributes.position;
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i,
      pos.getX(i) * (0.6 + rand() * 0.8),
      pos.getY(i) * (0.6 + rand() * 0.8),
      pos.getZ(i) * (0.6 + rand() * 0.8));
  }
  geo.computeVertexNormals();
  return geo;
}

/** Minimal non-indexed merge — avoids pulling in an addon for three primitives. */
function mergeSimple(geometries) {
  let total = 0;
  const nonIndexed = geometries.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    total += n.attributes.position.count;
    return n;
  });
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of nonIndexed) {
    const p = g.attributes.position;
    const nrm = g.attributes.normal;
    const t = g.attributes.uv;
    position.set(p.array, o * 3);
    if (nrm) normal.set(nrm.array, o * 3);
    if (t) uv.set(t.array, o * 2);
    o += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _scale = new THREE.Vector3();
