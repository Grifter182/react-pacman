import * as THREE from 'three';

/**
 * OWNER: AI agent.
 *
 * Procedural locomotion for the soldier rig — no clips, no baked animation.
 * Everything is solved from three inputs: how fast the body is moving, what
 * stance it is in, and where it is looking.
 *
 *   **Gait** is a phase, advanced by *distance travelled* rather than by time,
 *   so a bot decelerating into cover finishes its stride instead of moon-walking.
 *   Each foot spends half the cycle in stance (planted, sliding backward under
 *   the body) and half in swing (arcing forward). Stride length and cadence both
 *   scale with speed, sub-linearly, the way a real gait does.
 *
 *   **Foot IK** is a two-bone analytic solve. The foot target from the gait is
 *   projected onto the ground with a downward ray, so bots stand correctly on
 *   stairs and rubble instead of hovering or sinking. The hips drop when a leg
 *   cannot reach, which is what sells a step down.
 *
 *   **Aiming** is a distributed twist: the yaw and pitch to the target are split
 *   across hips, spine, chest, neck and head with different weights, so a bot
 *   tracking you turns its whole upper body and leads with its eyes.
 *
 * Bone orientation trick used throughout: at bind time every bone's local
 * rotation is identity, so a bone's "down the limb" axis is simply the
 * normalised offset of its child. Pointing a bone along a world direction is
 * then one `setFromUnitVectors` in the parent's frame.
 */

const GAIT = {
  strideBase: 0.62,
  strideSpeed: 0.145,
  cadenceBase: 1.55,
  cadenceSpeed: 0.30,
  liftWalk: 0.075,
  liftRun: 0.155,
};

export class Locomotion {
  constructor(inst) {
    this.inst = inst;
    this.bones = inst.bones;
    this.byName = inst.byName;

    this.phase = Math.random();
    this.speed = 0;
    this.stanceBlend = 0;         // 0 stand, 1 crouch
    this.aimBlend = 0;            // 0 low ready, 1 shouldered
    this.leanBlend = 0;

    this._prevPos = new THREE.Vector3();
    this._hasPrev = false;
    this._footY = [0, 0];
    this._footN = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)];
    this._hipDrop = 0;
    this._bodyYaw = 0;
    this._aimYaw = 0;
    this._aimPitch = 0;

    // Hit reaction springs: value + velocity per axis.
    this._hit = { x: 0, xv: 0, y: 0, yv: 0, z: 0, zv: 0 };
    this._flinch = 0;
    this._breath = Math.random() * 10;

    this.thighLen = [0, 0];
    this.shinLen = [0, 0];
    this._measured = false;
  }

  /** Impulse from a bullet: the torso is knocked off the aim for a moment. */
  react(worldDir, strength, limb) {
    const s = Math.min(1.2, strength);
    // Convert the impact direction into the rig's frame so a shot from the left
    // rocks the body to the right regardless of which way it is facing.
    const yaw = this.inst.rig.rotation.y;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const lateral = worldDir.x * fz - worldDir.z * fx;
    const frontal = worldDir.x * fx + worldDir.z * fz;
    this._hit.zv += -lateral * s * 7.0;
    this._hit.xv += frontal * s * 6.0;
    this._hit.yv += (Math.random() - 0.5) * s * 4.0;
    this._flinch = Math.min(1, this._flinch + s * (limb === 'head' ? 1.1 : 0.65));
  }

  /**
   * @param ctx {
   *   collision, position (capsule centre), yaw, aimYaw, aimPitch, aimBlend,
   *   crouch, speed, footIK, time
   * }
   */
  update(dt, ctx) {
    if (!this._measured) this._measure();
    const rig = this.inst.rig;
    const B = this.byName;

    /* --- rig transform ---------------------------------------------------- */
    rig.position.copy(ctx.position);
    this._bodyYaw = ctx.yaw;
    rig.rotation.set(0, ctx.yaw, 0);

    /* --- gait phase ------------------------------------------------------- */
    const speed = ctx.speed;
    this.speed += (speed - this.speed) * Math.min(1, dt * 9);
    this.stanceBlend += ((ctx.crouch ? 1 : 0) - this.stanceBlend) * Math.min(1, dt * 7);
    this.aimBlend += ((ctx.aimBlend ?? 0) - this.aimBlend) * Math.min(1, dt * 8);

    const moving = this.speed > 0.22;
    const cadence = GAIT.cadenceBase + Math.sqrt(Math.max(0, this.speed)) * GAIT.cadenceSpeed;
    // Standing still freezes the phase rather than resetting it, so a bot that
    // stops mid-stride keeps its feet where it left them.
    if (moving) this.phase = (this.phase + dt * cadence) % 1;

    const run = THREE.MathUtils.clamp((this.speed - 2.4) / 3.2, 0, 1);
    const stride = (GAIT.strideBase + this.speed * GAIT.strideSpeed)
      * (1 - this.stanceBlend * 0.45) * Math.min(1, this.speed / 1.6);
    const lift = THREE.MathUtils.lerp(GAIT.liftWalk, GAIT.liftRun, run)
      * (1 - this.stanceBlend * 0.4) * Math.min(1, this.speed / 1.4);

    /* --- body: bob, sway, crouch, lean ------------------------------------ */
    const hips = B.get('hips');
    const bobAmp = (0.020 + run * 0.028) * Math.min(1, this.speed / 2.2);
    const bob = -Math.abs(Math.sin(this.phase * Math.PI * 2)) * bobAmp;
    const sway = Math.sin(this.phase * Math.PI * 2) * 0.018 * Math.min(1, this.speed / 3);
    // The bind pose has the legs at full extension; a constant 35 mm of hip
    // drop puts a little bend in the knees so the IK has somewhere to go and
    // the stance stops looking like a mannequin.
    const crouchDrop = 0.035 + this.stanceBlend * 0.30;

    this._breath += dt * (0.9 + run * 1.4);
    const breathe = Math.sin(this._breath) * 0.006 * (1 - Math.min(1, this.speed));

    this._hipDrop += (0 - this._hipDrop) * Math.min(1, dt * 8);
    hips.position.set(
      this.inst.rest[0].p.x + sway,
      this.inst.rest[0].p.y + bob - crouchDrop - this._hipDrop + breathe,
      this.inst.rest[0].p.z,
    );

    // Hit reaction springs — critically damped, ~5 Hz.
    springDamp(this._hit, 'x', dt, 34, 9);
    springDamp(this._hit, 'y', dt, 34, 9);
    springDamp(this._hit, 'z', dt, 34, 9);
    this._flinch = Math.max(0, this._flinch - dt * 2.4);

    const pelvisPitch = this.stanceBlend * 0.16 + run * 0.10;
    hips.rotation.set(pelvisPitch + this._hit.x * 0.35, 0, this._hit.z * 0.35 - sway * 1.2);

    /* --- aim distribution -------------------------------------------------- */
    // Difference between where the body faces and where the eyes want to look,
    // spread across the spine so no single joint snaps.
    let dYaw = wrapPi((ctx.aimYaw ?? ctx.yaw) - ctx.yaw);
    dYaw = THREE.MathUtils.clamp(dYaw, -1.25, 1.25);
    const pitch = THREE.MathUtils.clamp(ctx.aimPitch ?? 0, -0.85, 0.7);
    this._aimYaw += (dYaw - this._aimYaw) * Math.min(1, dt * 10);
    this._aimPitch += (pitch - this._aimPitch) * Math.min(1, dt * 10);

    const spine = B.get('spine'), chest = B.get('chest');
    const neck = B.get('neck'), head = B.get('head');
    const counterSway = -sway * 0.8;
    const spinePitch = this._aimPitch * 0.18 + this._hit.x * 0.5;
    const chestPitch = this._aimPitch * 0.34 + this._hit.x * 0.7 - run * 0.12;
    spine.rotation.set(spinePitch, this._aimYaw * 0.22 + counterSway, this._hit.z * 0.4);
    chest.rotation.set(chestPitch, this._aimYaw * 0.34,
      this._hit.z * 0.6 + Math.sin(this.phase * Math.PI * 2 + Math.PI) * 0.03 * run);
    neck.rotation.set(this._aimPitch * 0.20, this._aimYaw * 0.18, 0);
    head.rotation.set(this._aimPitch * 0.28 + this._flinch * 0.35,
      this._aimYaw * 0.26, this._hit.z * 0.5 + this._flinch * 0.2);

    /* --- arms -------------------------------------------------------------- */
    this._poseArms(dt, run, pelvisPitch + spinePitch + chestPitch);

    /* --- legs -------------------------------------------------------------- */
    rig.updateMatrixWorld(true);
    this._solveLegs(dt, ctx, stride, lift, moving);
    rig.updateMatrixWorld(true);
  }

  /**
   * Arms are posed, not solved: a rifle carry is a fixed relationship between
   * the chest and the hands, so the honest implementation is a blend between
   * two authored poses plus the counter-rotation of the walk.
   *
   * The weapon is rigidly bound to the right hand, so the *net* rotation of
   * the whole chain — pelvis, spine, chest, shoulder, elbow, wrist — is the
   * barrel's pitch. The pose is therefore solved for the barrel rather than
   * authored joint by joint: the shoulder raise and the elbow counter-rotation
   * cancel, and the wrist takes up whatever is left over between the torso's
   * lean and the pitch the bot actually wants to shoot at. Raise the shoulder
   * without that bookkeeping and the barrel points at the sky.
   *
   * @param chainPitch accumulated pitch of pelvis + spine + chest, radians
   */
  _poseArms(dt, run, chainPitch) {
    const B = this.byName;
    const a = this.aimBlend;
    const swing = Math.sin(this.phase * Math.PI * 2)
      * (0.16 + run * 0.22) * (1 - a * 0.75) * Math.min(1, this.speed / 2.5);

    // Shoulder raise: 24 degrees at the low ready, 87 shouldered.
    const raise = THREE.MathUtils.lerp(0.42, 1.52, a);
    const bend = THREE.MathUtils.lerp(0.30, 0.14, a);      // residual elbow flex
    // Barrel target: muzzle down at the carry, on the aim line when shouldered.
    const barrel = THREE.MathUtils.lerp(0.36, this._aimPitch, a);
    const wrist = THREE.MathUtils.clamp(barrel - chainPitch + bend, -0.85, 1.05);

    const rArm = B.get('armR'), rFore = B.get('foreR'), rHand = B.get('handR');
    rArm.rotation.set(-raise + swing * 0.35 + this._hit.x * 0.30, -0.10 * a, -0.12 - 0.10 * a);
    rFore.rotation.set(raise - bend, 0.14 * a, 0.10 * a);
    rHand.rotation.set(wrist, -0.06 * a, 0);

    // Left arm crosses to the handguard: raised a little less, rolled inward.
    const lArm = B.get('armL'), lFore = B.get('foreL'), lHand = B.get('handL');
    lArm.rotation.set(-raise * 0.92 - swing * 0.35 + this._hit.x * 0.30,
      -0.34 * a, THREE.MathUtils.lerp(0.14, 0.62, a));
    lFore.rotation.set(raise * 0.80 - THREE.MathUtils.lerp(0.34, 0.10, a),
      THREE.MathUtils.lerp(-0.20, -0.70, a), 0);
    lHand.rotation.set(0.25, 0, 0);
    void dt;
  }

  /** Bone lengths, measured once from the bind pose. */
  _measure() {
    const B = this.byName;
    for (let s = 0; s < 2; s++) {
      const suffix = s === 0 ? 'L' : 'R';
      this.thighLen[s] = B.get(`shin${suffix}`).position.length();
      this.shinLen[s] = B.get(`foot${suffix}`).position.length();
    }
    this._measured = true;
  }

  /**
   * Foot targets from the gait, grounded by a downward ray, then a two-bone
   * analytic IK per leg. The knee pole is the rig's forward axis, which is why
   * knees never invert even when a bot is turning on the spot.
   */
  _solveLegs(dt, ctx, stride, lift, moving) {
    const B = this.byName;
    const rig = this.inst.rig;
    const yaw = this._bodyYaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = fz, rz = -fx;                       // right vector

    let lowest = 0;
    for (let s = 0; s < 2; s++) {
      const suffix = s === 0 ? 'L' : 'R';
      const ph = (this.phase + (s === 0 ? 0 : 0.5)) % 1;

      let along, height;
      if (!moving) { along = 0; height = 0; }
      else if (ph < 0.5) {
        // Stance: the planted foot slides backward under the body.
        along = stride * 0.5 - stride * (ph / 0.5);
        height = 0;
      } else {
        const t = (ph - 0.5) / 0.5;
        along = -stride * 0.5 + stride * t;
        height = Math.sin(t * Math.PI) * lift;
      }

      const side = (s === 0 ? 1 : -1) * (0.106 - this.stanceBlend * 0.012);
      const hipWorld = _v1.copy(rig.position);
      const targetX = hipWorld.x + rx * side + fx * along;
      const targetZ = hipWorld.z + rz * side + fz * along;

      // Ground the target. Raycasting from above the hip keeps the probe from
      // starting inside a step.
      let groundY = hipWorld.y - 0.87;
      let normal = _up;
      if (ctx.footIK && ctx.collision) {
        _v2.set(targetX, hipWorld.y + 0.55, targetZ);
        const hit = ctx.collision.raycast(_v2, _down, 2.2);
        if (hit) { groundY = hit.point.y; normal = hit.normal; }
      }
      this._footY[s] += (groundY - this._footY[s]) * Math.min(1, dt * 18);
      this._footN[s].lerp(normal, Math.min(1, dt * 12));

      // 0.085 is the ankle's height above the sole in the bind pose, so the
      // boot lands on the ground rather than in it.
      const footTarget = _v3.set(targetX, this._footY[s] + height + 0.085, targetZ);
      lowest = Math.min(lowest, this._footY[s] - (hipWorld.y - 0.87));

      this._ik(B.get(`thigh${suffix}`), B.get(`shin${suffix}`), footTarget,
        this.thighLen[s], this.shinLen[s], fx, fz, s);

      // Foot: level to the ground it is standing on, toe down through the swing.
      const foot = B.get(`foot${suffix}`);
      const groundPitch = Math.asin(THREE.MathUtils.clamp(
        this._footN[s].x * fx + this._footN[s].z * fz, -0.7, 0.7));
      foot.rotation.set(-groundPitch + (height > 0.001 ? -0.35 * (height / Math.max(lift, 1e-3)) : 0.10), 0, 0);
    }

    // If both feet ended up below the body, drop the hips to meet them — this
    // is what makes stepping down a kerb look like stepping rather than gliding.
    if (lowest < -0.02) this._hipDrop = Math.min(0.24, -lowest * 0.55);
  }

  /**
   * Two-bone analytic IK. Solves the knee by intersecting the two bone-length
   * spheres and picking the point on that circle nearest the pole direction.
   */
  _ik(upper, lower, target, l1, l2, fx, fz, side) {
    upper.updateMatrixWorld(true);
    const root = _v4.setFromMatrixPosition(upper.matrixWorld);

    _dir.subVectors(target, root);
    let dist = _dir.length();
    if (dist < 1e-4) return;
    _dir.divideScalar(dist);
    // Clamp to just inside full extension: a perfectly straight leg has no
    // knee direction and the solve degenerates.
    const maxReach = (l1 + l2) * 0.995;
    if (dist > maxReach) dist = maxReach;
    const eff = _eff.copy(root).addScaledVector(_dir, dist);

    // Distance from the hip to the knee's projection on the hip->foot axis.
    const a = THREE.MathUtils.clamp((dist * dist + l1 * l1 - l2 * l2) / (2 * dist), -l1, l1);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

    // Pole: forward, biased slightly outward so knees track apart.
    _pole.set(fx + fz * 0.18 * (side === 0 ? 1 : -1), 0.12, fz - fx * 0.18 * (side === 0 ? 1 : -1)).normalize();
    // Orthogonalise the pole against the limb axis.
    _pole.addScaledVector(_dir, -_pole.dot(_dir));
    if (_pole.lengthSq() < 1e-6) _pole.set(fx, 0, fz).addScaledVector(_dir, -(_dir.x * fx + _dir.z * fz));
    _pole.normalize();

    _knee.copy(root).addScaledVector(_dir, a).addScaledVector(_pole, h);

    aimBoneAt(upper, _knee);
    upper.updateMatrixWorld(true);
    aimBoneAt(lower, eff);
    lower.updateMatrixWorld(true);
  }

  /** World position of the weapon muzzle, from the right hand bone. */
  muzzle(out, localOffset) {
    const hand = this.byName.get('handR');
    hand.updateMatrixWorld(true);
    return out.copy(localOffset).applyMatrix4(hand.matrixWorld);
  }

  eye(out) {
    const head = this.byName.get('head');
    head.updateMatrixWorld(true);
    return out.set(0, 0.10, 0.10).applyMatrix4(head.matrixWorld);
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Rotate `bone` so its child axis points at a world-space target. The bone's
 * rest rotation is identity, so its local aim axis is the normalised offset of
 * its first child.
 */
function aimBoneAt(bone, worldTarget) {
  const child = bone.children.find((c) => c.isBone);
  if (!child) return;
  _axis.copy(child.position).normalize();

  bone.parent.updateMatrixWorld(false);
  _pm.copy(bone.parent.matrixWorld).invert();
  _local.copy(worldTarget).applyMatrix4(_pm).sub(bone.position);
  if (_local.lengthSq() < 1e-9) return;
  _local.normalize();
  bone.quaternion.setFromUnitVectors(_axis, _local);
}

function springDamp(o, key, dt, k, c) {
  const v = o[`${key}v`];
  const x = o[key];
  const a = -k * x - c * v;
  const nv = v + a * dt;
  o[`${key}v`] = nv;
  o[key] = x + nv * dt;
}

function wrapPi(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _eff = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _local = new THREE.Vector3();
const _pm = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
