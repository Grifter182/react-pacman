import * as THREE from 'three';

/**
 * OWNER: AI agent.
 *
 * Death is simulated, not animated. A twelve-particle Verlet skeleton inherits
 * the body's velocity plus the impulse of the killing round, falls under
 * gravity, and is projected out of the world every substep with the same
 * capsule solver the player uses. The rendered skeleton is then *aimed* at the
 * particles — bone lengths come from the bind pose and the constraints use
 * those same lengths, so the mesh can never stretch.
 *
 * Verlet rather than a rigid-body solver because the constraint set here is
 * almost entirely distance constraints; position projection converges in four
 * iterations, needs no inertia tensors, and cannot explode. The cost of a
 * corpse is roughly 12 sphere depenetrations per substep, and corpses are
 * culled after a few seconds.
 */

const JOINTS = [
  'hips', 'spine', 'chest', 'head',
  'elbowL', 'handL', 'elbowR', 'handR',
  'kneeL', 'footL', 'kneeR', 'footR',
];
const J = new Map(JOINTS.map((n, i) => [n, i]));

/** Which bone each particle is sampled from, and where along it. */
const SAMPLE = [
  ['hips', 0], ['spine', 0], ['chest', 0], ['head', 1],
  ['foreL', 0], ['handL', 1], ['foreR', 0], ['handR', 1],
  ['shinL', 0], ['footL', 1], ['shinR', 0], ['footR', 1],
];

/** a, b, stiffness. Structural first, then the shaping constraints. */
const LINKS = [
  ['hips', 'spine', 1], ['spine', 'chest', 1], ['chest', 'head', 1],
  ['chest', 'elbowL', 0.9], ['elbowL', 'handL', 1],
  ['chest', 'elbowR', 0.9], ['elbowR', 'handR', 1],
  ['hips', 'kneeL', 1], ['kneeL', 'footL', 1],
  ['hips', 'kneeR', 1], ['kneeR', 'footR', 1],
  // Shaping: without these the torso folds flat and the limbs pass through it.
  ['hips', 'chest', 0.55], ['spine', 'head', 0.35],
  ['hips', 'elbowL', 0.25], ['hips', 'elbowR', 0.25],
  ['chest', 'kneeL', 0.22], ['chest', 'kneeR', 0.22],
  ['kneeL', 'kneeR', 0.15], ['elbowL', 'elbowR', 0.18],
];

export class Ragdoll {
  constructor() {
    this.pos = [];
    this.prev = [];
    this.links = [];
    this.active = false;
    this.rest = 0;
    this._grounded = 0;
    for (let i = 0; i < JOINTS.length; i++) {
      this.pos.push(new THREE.Vector3());
      this.prev.push(new THREE.Vector3());
    }
  }

  /**
   * @param inst      soldier instance ({ rig, bones, byName })
   * @param velocity  the body's velocity at the moment of death
   * @param impulse   world-space impulse from the killing round
   */
  start(inst, velocity, impulse, collision) {
    this.inst = inst;
    this.collision = collision;
    inst.rig.updateMatrixWorld(true);

    for (let i = 0; i < JOINTS.length; i++) {
      const [boneName, atTail] = SAMPLE[i];
      const bone = inst.byName.get(boneName);
      const p = this.pos[i];
      if (atTail) {
        // Tail of a leaf bone: step along its aim axis by its own length.
        const child = bone.children.find((c) => c.isBone);
        if (child) {
          child.updateMatrixWorld(true);
          p.setFromMatrixPosition(child.matrixWorld);
        } else {
          p.setFromMatrixPosition(bone.matrixWorld);
          _v.set(0, -0.12, 0.05).applyQuaternion(bone.getWorldQuaternion(_q));
          p.add(_v);
        }
      } else {
        p.setFromMatrixPosition(bone.matrixWorld);
      }
      // Seed the previous position so the corpse inherits the run it died in.
      this.prev[i].copy(p).addScaledVector(velocity, -1 / 60);
    }

    // Impulse: strongest at the hit, tapering along the body so the corpse
    // rotates rather than translating as a block.
    if (impulse) {
      for (let i = 0; i < JOINTS.length; i++) {
        const w = i < 4 ? 1 : 0.45;
        this.prev[i].addScaledVector(impulse, -w / 60);
      }
    }

    this.links.length = 0;
    for (const [a, b, stiff] of LINKS) {
      const ia = J.get(a), ib = J.get(b);
      this.links.push({ a: ia, b: ib, len: this.pos[ia].distanceTo(this.pos[ib]), stiff });
    }

    // Bones are written in world space from here on, so neutralise the rig.
    inst.rig.position.set(0, 0, 0);
    inst.rig.rotation.set(0, 0, 0);
    inst.rig.updateMatrixWorld(true);

    this.active = true;
    this.rest = 0;
    return this;
  }

  step(dt) {
    if (!this.active) return;
    // Fixed substeps: Verlet's stability depends on a constant dt, and a frame
    // spike must not turn a corpse into a projectile.
    const h = 1 / 90;
    let remaining = Math.min(dt, 0.1);
    while (remaining > 1e-4) {
      const s = Math.min(h, remaining);
      this._substep(s);
      remaining -= s;
    }
    this._writeBones();
  }

  _substep(dt) {
    const g = 19.6 * dt * dt;
    let moved = 0;
    for (let i = 0; i < this.pos.length; i++) {
      const p = this.pos[i], q = this.prev[i];
      const vx = (p.x - q.x) * 0.995, vy = (p.y - q.y) * 0.995, vz = (p.z - q.z) * 0.995;
      q.copy(p);
      p.x += vx; p.y += vy - g; p.z += vz;
      moved += Math.abs(vx) + Math.abs(vy) + Math.abs(vz);
    }

    for (let it = 0; it < 4; it++) {
      for (const l of this.links) {
        const a = this.pos[l.a], b = this.pos[l.b];
        _v.subVectors(b, a);
        const d = _v.length();
        if (d < 1e-6) continue;
        const diff = (d - l.len) / d * 0.5 * l.stiff;
        a.addScaledVector(_v, diff);
        b.addScaledVector(_v, -diff);
      }
    }

    // World projection. Each particle is a small sphere; capsuleResolve with
    // halfHeight == radius is exactly that.
    if (this.collision) {
      for (let i = 0; i < this.pos.length; i++) {
        const p = this.pos[i];
        _before.copy(p);
        this.collision.capsuleResolve(p, 0.11, 0.11, 2);
        const push = _before.distanceTo(p);
        if (push > 1e-5) {
          // Contact friction: kill most of the tangential motion so limbs stop
          // sliding around on the floor.
          const q = this.prev[i];
          q.lerp(p, 0.55);
          this._grounded = 1;
        }
      }
    }

    this.rest = moved < 0.006 ? this.rest + dt : 0;
    if (this.rest > 1.1) this.active = false;   // settled; stop simulating
  }

  /** Aim the render skeleton at the particle cloud. */
  _writeBones() {
    const B = this.inst.byName;
    const hips = B.get('hips');
    hips.position.copy(this.pos[J.get('hips')]);
    hips.rotation.set(0, 0, 0);
    hips.updateMatrixWorld(true);

    aim(hips, this.pos[J.get('spine')]);
    hips.updateMatrixWorld(true);
    aim(B.get('spine'), this.pos[J.get('chest')]);
    B.get('spine').updateMatrixWorld(true);
    aim(B.get('chest'), this.pos[J.get('head')]);
    B.get('chest').updateMatrixWorld(true);
    aim(B.get('neck'), this.pos[J.get('head')]);

    for (const s of ['L', 'R']) {
      const arm = B.get(`arm${s}`), fore = B.get(`fore${s}`);
      const thigh = B.get(`thigh${s}`), shin = B.get(`shin${s}`);
      B.get(`clav${s}`).updateMatrixWorld(true);
      aim(arm, this.pos[J.get(`elbow${s}`)]);
      arm.updateMatrixWorld(true);
      aim(fore, this.pos[J.get(`hand${s}`)]);
      aim(thigh, this.pos[J.get(`knee${s}`)]);
      thigh.updateMatrixWorld(true);
      aim(shin, this.pos[J.get(`foot${s}`)]);
    }
    this.inst.rig.updateMatrixWorld(true);
  }

  /** Approximate world centre, for culling and for the killfeed marker. */
  centre(out) {
    return out.copy(this.pos[J.get('hips')]).lerp(this.pos[J.get('chest')], 0.5);
  }

  stop() { this.active = false; }
}

function aim(bone, worldTarget) {
  const child = bone.children.find((c) => c.isBone);
  if (!child) return;
  _axis.copy(child.position).normalize();
  _pm.copy(bone.parent.matrixWorld).invert();
  _local.copy(worldTarget).applyMatrix4(_pm).sub(bone.position);
  if (_local.lengthSq() < 1e-9) return;
  _local.normalize();
  bone.quaternion.setFromUnitVectors(_axis, _local);
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _before = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _local = new THREE.Vector3();
const _pm = new THREE.Matrix4();
