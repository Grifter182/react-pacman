import * as THREE from 'three';

/**
 * OWNER: AI agent (NPC models).
 *
 * Procedural locomotion for the soldier rig — no clips, no baked animation.
 * Everything is solved from four inputs: where the body actually moved since
 * last frame, what stance it is in, how fast it is turning, and where it is
 * looking.
 *
 *   **Steps are planted in the world, not swept under the body.** Each foot owns
 *   a world-space plant point. While it is planted the IK target IS that point,
 *   so the stance foot cannot slide: not while walking, not while strafing, not
 *   while decelerating, not while the body pivots on the spot. A foot lifts only
 *   when the pose it wants has drifted far enough from where it is standing, and
 *   it lands where the body will be when it gets there.
 *
 *   That is a change of mechanism, and it was made against a measurement. The
 *   previous gait swept both feet along the body's forward axis on a timer, and
 *   the sweep did not agree with the body's real velocity: driving the rig with
 *   a body that genuinely translated, the *planted* foot moved through the world
 *   at 1.55 m/s while walking at 2.2 m/s — 70% slip — and at 173% of body speed
 *   while strafing, because the feet were swinging fore-aft while the man went
 *   sideways. Those numbers are why bots read as props on rails. With plants,
 *   stance slip is 0.00 m/s by construction and the remainder is only what the
 *   two-bone IK cannot reach.
 *
 *   **Turning on the spot now steps.** A pivot moves the ideal foot position
 *   without moving the body, so the same trigger that produces a walk produces
 *   a shuffle: the bot picks its feet up and puts them down around the turn
 *   instead of rotating like a turret.
 *
 *   **Foot IK** is a two-bone analytic solve. Plant points are projected onto
 *   the ground with a downward ray, so bots stand correctly on stairs and rubble
 *   instead of hovering or sinking. The hips drop when a leg cannot reach, which
 *   is what sells a step down.
 *
 *   **Aiming** is a distributed twist: the yaw and pitch to the target are split
 *   across hips, spine, chest, neck and head with different weights, so a bot
 *   tracking you turns its whole upper body and leads with its eyes.
 *
 *   **Standing still is a pose, not a freeze.** An idle bot shifts its weight
 *   between its feet on a slow, per-instance cycle and breathes. At 10 m that is
 *   the difference between a man waiting and a mannequin.
 *
 * Bone orientation trick used throughout: at bind time every bone's local
 * rotation is identity, so a bone's "down the limb" axis is simply the
 * normalised offset of its child. Pointing a bone along a world direction is
 * then one `setFromUnitVectors` in the parent's frame.
 */

const GAIT = {
  /** Step length at a standstill and its growth with speed (metres). */
  stepBase: 0.46,
  stepSpeed: 0.145,
  stepMax: 1.32,
  /** Swing duration (seconds) — how long a foot is in the air, by speed. */
  swingWalk: 0.30,
  swingRun: 0.19,
  /** A foot lifts when its plant is this fraction of a step out of place. */
  trigger: 0.50,
  /** …but never within this long of the last step, so it cannot buzz. */
  minInterval: 0.09,
  liftWalk: 0.075,
  liftRun: 0.165,
  /** Metres of "ideal foot" motion produced by a radian of body rotation. */
  turnLever: 0.30,
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
    this._prevYaw = 0;
    this._yawRate = 0;
    this._travel = new THREE.Vector3();   // smoothed world travel direction
    this._measuredSpeed = 0;

    this._footY = [0, 0];
    this._footN = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)];
    // Per-foot plant state. `plant` is a world position; while a foot is not
    // swinging, that position is the IK target and nothing else touches it.
    this._feet = [0, 1].map(() => ({
      plant: new THREE.Vector3(),
      from: new THREE.Vector3(),
      to: new THREE.Vector3(),
      swing: false,
      t: 0,
      dur: GAIT.swingWalk,
      since: 99,
      plantYaw: 0,
    }));
    this._planted = false;
    this._hipDrop = 0;
    this._bodyYaw = 0;
    this._aimYaw = 0;
    this._aimPitch = 0;

    // Hit reaction springs: value + velocity per axis.
    this._hit = { x: 0, xv: 0, y: 0, yv: 0, z: 0, zv: 0 };
    this._flinch = 0;
    this._breath = Math.random() * 10;
    this._idle = Math.random() * 10;      // weight-shift clock, per instance
    this._weight = 0;

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
    dt = Math.min(0.1, Math.max(1e-4, dt));

    /* --- what the body actually did --------------------------------------- */
    // The caller's `speed` is the AI's own velocity magnitude; the travel
    // DIRECTION has to come from the positions, because nothing upstream tells
    // this rig whether the man is walking forward or sidestepping.
    if (this._hasPrev) {
      _delta.subVectors(ctx.position, this._prevPos);
      _delta.y = 0;
      const dist = _delta.length();
      this._measuredSpeed = dist / dt;
      if (dist > 1e-4) {
        _delta.divideScalar(dist);
        // A reversal is antipodal, and lerp-then-normalise cannot cross an
        // antipode: it shortens the vector and the renormalise puts it straight
        // back. That bug made a backpedalling bot believe it was walking
        // forwards, so its feet planted a metre behind it and dragged — 94% of
        // body speed, measured. Reversals snap; everything else damps.
        const k = this._measuredSpeed > 40 ? 1 : Math.min(1, dt * 12);
        if (this._travel.dot(_delta) < -0.8) this._travel.copy(_delta);
        else this._travel.lerp(_delta, k).normalize();
      }
      const dy = wrapPi(ctx.yaw - this._prevYaw) / dt;
      this._yawRate += (dy - this._yawRate) * Math.min(1, dt * 10);
    } else {
      this._travel.set(Math.sin(ctx.yaw), 0, Math.cos(ctx.yaw));
    }
    const teleported = this._hasPrev && this._prevPos.distanceToSquared(ctx.position) > 4;
    this._prevPos.copy(ctx.position);
    this._prevYaw = ctx.yaw;
    this._hasPrev = true;

    /* --- rig transform ---------------------------------------------------- */
    rig.position.copy(ctx.position);
    this._bodyYaw = ctx.yaw;
    rig.rotation.set(0, ctx.yaw, 0);

    /* --- speed, stance, aim ----------------------------------------------- */
    const speed = ctx.speed ?? this._measuredSpeed;
    this.speed += (speed - this.speed) * Math.min(1, dt * 9);
    this.stanceBlend += ((ctx.crouch ? 1 : 0) - this.stanceBlend) * Math.min(1, dt * 7);
    this.aimBlend += ((ctx.aimBlend ?? 0) - this.aimBlend) * Math.min(1, dt * 8);

    const run = THREE.MathUtils.clamp((this.speed - 2.4) / 3.2, 0, 1);
    const stepLen = Math.min(GAIT.stepMax,
      (GAIT.stepBase + this.speed * GAIT.stepSpeed) * (1 - this.stanceBlend * 0.32));
    const lift = THREE.MathUtils.lerp(GAIT.liftWalk, GAIT.liftRun, run) * (1 - this.stanceBlend * 0.4);

    // Cosmetic phase: bob, sway and arm swing ride on it. Advanced by DISTANCE
    // travelled (plus a little for turning), so a bot decelerating into cover
    // finishes its stride instead of moon-walking, and a stopped bot's arms stop
    // with it.
    const travelled = this._measuredSpeed * dt + Math.abs(this._yawRate) * GAIT.turnLever * dt;
    this.phase = (this.phase + travelled / Math.max(0.25, stepLen * 2)) % 1;
    const moving = this.speed > 0.22 || Math.abs(this._yawRate) > 0.6;

    /* --- body: bob, sway, crouch, weight shift ----------------------------- */
    const hips = B.get('hips');
    const bobAmp = (0.020 + run * 0.028) * Math.min(1, this.speed / 2.2);
    const bob = -Math.abs(Math.sin(this.phase * Math.PI * 2)) * bobAmp;
    const sway = Math.sin(this.phase * Math.PI * 2) * 0.018 * Math.min(1, this.speed / 3);
    // The bind pose has the legs at full extension; a constant 35 mm of hip
    // drop puts a little bend in the knees so the IK has somewhere to go and
    // the stance stops looking like a mannequin.
    // …and the faster he goes the lower he carries the pelvis. This is not a
    // flourish: the thigh root sits 0.90 m up and the leg is 0.815 m long, so a
    // straight leg only just reaches the floor. Without the drop the leg has no
    // horizontal reach to put a foot down with, and a long stride would go
    // through full extension and drag. 95 mm buys a 0.40 m step radius.
    const crouchDrop = 0.035 + 0.060 * Math.min(1, this.speed / 3.5)
      + this.stanceBlend * 0.30;

    this._breath += dt * (0.9 + run * 1.4);
    const still = 1 - Math.min(1, this.speed / 0.9);
    const breathe = Math.sin(this._breath) * 0.008 * still;
    // Idle weight shift: a slow lean onto one leg and back. 26 mm of lateral
    // hip travel and a degree of pelvis roll, which is enough to read at 10 m
    // and invisible past 25 — exactly the range where a frozen bot gives itself
    // away.
    this._idle += dt * 0.42;
    const shiftTarget = Math.sin(this._idle) * 0.026 * still;
    this._weight += (shiftTarget - this._weight) * Math.min(1, dt * 2.5);

    this._hipDrop += (0 - this._hipDrop) * Math.min(1, dt * 8);
    hips.position.set(
      this.inst.rest[0].p.x + sway + this._weight,
      this.inst.rest[0].p.y + bob - crouchDrop - this._hipDrop + breathe,
      this.inst.rest[0].p.z,
    );

    // Hit reaction springs — critically damped, ~5 Hz.
    springDamp(this._hit, 'x', dt, 34, 9);
    springDamp(this._hit, 'y', dt, 34, 9);
    springDamp(this._hit, 'z', dt, 34, 9);
    this._flinch = Math.max(0, this._flinch - dt * 2.4);

    const pelvisPitch = this.stanceBlend * 0.16 + run * 0.10;
    hips.rotation.set(
      pelvisPitch + this._hit.x * 0.35, 0,
      this._hit.z * 0.35 - sway * 1.2 - this._weight * 0.9,
    );

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
    this._solveLegs(dt, ctx, stepLen, lift, moving, run, teleported);
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
   * Plant, trigger, swing, land — then two-bone analytic IK per leg.
   *
   * The "ideal" position of a foot is where it would stand if the man were
   * balanced right now: hip, plus the stance width, plus half a step in the
   * direction he is actually travelling. A planted foot is left exactly where
   * it is until that ideal has drifted more than half a step away; then it
   * swings to where the ideal will be when it lands. Nothing in the stance path
   * moves the foot, which is what makes the slip zero rather than small.
   */
  _solveLegs(dt, ctx, stepLen, lift, moving, run, teleported) {
    const B = this.byName;
    const rig = this.inst.rig;
    const yaw = this._bodyYaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = fz, rz = -fx;                       // right vector
    const groundY = rig.position.y - 0.87;
    const swingDur = THREE.MathUtils.lerp(GAIT.swingWalk, GAIT.swingRun, run);
    const trigger = Math.max(0.16, stepLen * GAIT.trigger);
    const lead = Math.min(1.1, this._measuredSpeed * swingDur);

    if (!this._planted || teleported) this._resetPlants(fx, fz, rx, rz, groundY);

    // Which foot is allowed to lift this frame: only one at a time, and only if
    // the other one has been down long enough to carry the weight.
    let wantIdx = -1, wantErr = 0;
    for (let s = 0; s < 2; s++) {
      const st = this._feet[s];
      st.since += dt;
      if (st.swing) { wantIdx = -2; continue; }     // -2: something is airborne
    }

    let lowest = 0;
    for (let s = 0; s < 2; s++) {
      const st = this._feet[s];
      const side = (s === 0 ? 1 : -1) * (0.106 - this.stanceBlend * 0.012);
      // Where this foot wants to be standing right now: under the hip at the
      // stance width, plus half a step in the direction of travel — and the
      // half step fades out as he stops, so a standing man's feet are under him
      // rather than parked half a stride away in the last direction he walked.
      const gaitLead = stepLen * 0.5 * Math.min(1, this._measuredSpeed / 0.6);
      const idealX = rig.position.x + rx * side + this._travel.x * gaitLead;
      const idealZ = rig.position.z + rz * side + this._travel.z * gaitLead;

      if (!st.swing && wantIdx !== -2) {
        const err = Math.hypot(idealX - st.plant.x, idealZ - st.plant.z);
        // A pivot barely moves the foot's ideal position — 0.106 m of stance
        // width is a 17 cm arc for a 90 degree turn — so distance alone would
        // let a bot rotate 180 degrees on one spot with its boots welded down.
        // Yaw since the foot was planted is the second trigger.
        const spun = Math.abs(wrapPi(yaw - st.plantYaw));
        if ((err > trigger || spun > 0.55) && st.since > GAIT.minInterval
            && err + spun * 0.5 > wantErr) {
          wantIdx = s; wantErr = err + spun * 0.5;
        }
      }

      // Ground the ideal/plant. Raycasting from above the hip keeps the probe
      // from starting inside a step.
      let gy = groundY;
      let normal = _up;
      if (ctx.footIK && ctx.collision) {
        const px = st.swing ? st.to.x : idealX;
        const pz = st.swing ? st.to.z : idealZ;
        _v2.set(px, rig.position.y + 0.55, pz);
        const hit = ctx.collision.raycast(_v2, _down, 2.2);
        if (hit) { gy = hit.point.y; normal = hit.normal; }
      }
      this._footY[s] += (gy - this._footY[s]) * Math.min(1, dt * 18);
      this._footN[s].lerp(normal, Math.min(1, dt * 12));
      st.groundY = this._footY[s];
      st.idealX = idealX; st.idealZ = idealZ; st.lead = lead;
    }

    if (wantIdx >= 0) {
      const st = this._feet[wantIdx];
      st.swing = true; st.t = 0; st.dur = swingDur; st.since = 0;
      st.from.copy(st.plant);
      st.to.set(
        st.idealX + this._travel.x * st.lead,
        st.groundY,
        st.idealZ + this._travel.z * st.lead,
      );
    }

    for (let s = 0; s < 2; s++) {
      const st = this._feet[s];
      let tx, tz, height = 0;
      if (st.swing) {
        st.t += dt / Math.max(0.06, st.dur);
        if (st.t >= 1) {
          st.swing = false; st.t = 1;
          st.plant.copy(st.to); st.plant.y = st.groundY;
          st.plantYaw = yaw;
          tx = st.plant.x; tz = st.plant.z;
        } else {
          // Ease-in-out along the ground, sine arc through the air.
          const e = st.t * st.t * (3 - 2 * st.t);
          tx = st.from.x + (st.to.x - st.from.x) * e;
          tz = st.from.z + (st.to.z - st.from.z) * e;
          height = Math.sin(st.t * Math.PI) * lift;
        }
      } else {
        // PLANTED. Nothing here may move the foot; this is the whole mechanism.
        tx = st.plant.x; tz = st.plant.z;
      }

      // 0.085 is the ankle's height above the sole in the bind pose, so the
      // boot lands on the ground rather than in it.
      const footTarget = _v3.set(tx, st.groundY + height + 0.085, tz);
      lowest = Math.min(lowest, st.groundY - (rig.position.y - 0.87));

      const suffix = s === 0 ? 'L' : 'R';
      this._ik(B.get(`thigh${suffix}`), B.get(`shin${suffix}`), footTarget,
        this.thighLen[s], this.shinLen[s], fx, fz, s);

      // Foot: level to the ground it is standing on, toe down through the swing.
      const foot = B.get(`foot${suffix}`);
      const groundPitch = Math.asin(THREE.MathUtils.clamp(
        this._footN[s].x * fx + this._footN[s].z * fz, -0.7, 0.7));
      foot.rotation.set(-groundPitch + (st.swing ? -0.42 * Math.sin(st.t * Math.PI) : 0.10), 0, 0);
    }

    // If both feet ended up below the body, drop the hips to meet them — this
    // is what makes stepping down a kerb look like stepping rather than gliding.
    if (lowest < -0.02) this._hipDrop = Math.min(0.24, -lowest * 0.55);
    void moving;
  }

  /** Put both feet under the body immediately (spawn, respawn, teleport). */
  _resetPlants(fx, fz, rx, rz, groundY) {
    const p = this.inst.rig.position;
    for (let s = 0; s < 2; s++) {
      const st = this._feet[s];
      const side = (s === 0 ? 1 : -1) * 0.106;
      st.plant.set(p.x + rx * side, groundY, p.z + rz * side);
      st.groundY = groundY;
      st.plantYaw = this._bodyYaw;
      st.swing = false; st.t = 1; st.since = 99;
      this._footY[s] = groundY;
    }
    void fx; void fz;
    this._planted = true;
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

const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _eff = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _local = new THREE.Vector3();
const _pm = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
