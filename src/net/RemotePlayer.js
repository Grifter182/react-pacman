import * as THREE from 'three';
import { createSoldierInstance, HITBOXES, MUZZLE_LOCAL } from '../ai/Soldier.js';
import { Locomotion } from '../ai/Locomotion.js';
import { Ragdoll } from '../ai/Ragdoll.js';
import { rayCapsule } from '../ai/Combat.js';

/**
 * OWNER: netcode agent.
 *
 * Another human, as this client sees them.
 *
 * The body is the same procedural soldier the AI squad uses — skinned mesh,
 * locomotion with foot IK, per-limb hitboxes, Verlet ragdoll — imported as a
 * library, not by reaching into the AI module. That matters for fairness: a
 * remote player is exactly as large, and as hittable, as a bot.
 *
 * MOTION
 *   Snapshots arrive at 20 Hz with jitter. The body is drawn INTERP_DELAY in
 *   the past, between the two snapshots that bracket that instant, so motion
 *   is continuous rather than stepping at the tick rate. When the buffer runs
 *   dry (packet loss) the last velocity is extrapolated for at most 250 ms and
 *   then held. A gap larger than a sprint can cover in one tick is a respawn
 *   or teleport and is cut, not lerped across the map.
 *
 *   Body yaw lags aim yaw through a critically damped follow so a flick reads
 *   as the head and rifle leading and the hips catching up — secondary motion
 *   rather than a snapping turntable.
 *
 * `this.actor` deliberately mirrors the AI actor shape (`position`, `alive`,
 * `team`, `mesh`, `head`, `inst`, `velocity`, `health`), so FX, audio, the HUD
 * and the match roster can treat it like any other combatant.
 */

const CAPSULE_HALF = 0.87;          // AiModule's capsule: rig origin above the feet
const TELEPORT_DIST = 5.0;
const MAX_EXTRAPOLATE_MS = 250;
const BUFFER_MS = 1500;

const _a = new THREE.Vector3();
const _v = new THREE.Vector3();

export class RemotePlayer {
  constructor(id, name, asset, root) {
    this.id = id;
    this.name = name;
    this.rosterName = name;
    this.rosterEntry = null;
    this.root = root;

    this.inst = createSoldierInstance(asset);
    this.inst.rig.name = `NetPlayer:${name}`;
    root.add(this.inst.rig);
    root.add(this.inst.mesh);
    this.loco = new Locomotion(this.inst);
    this.ragdoll = null;

    this.buffer = [];               // [{ t, p, v, y, pi, s, a, w, ads }]
    this.feet = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.aimYaw = 0;                // soldier convention: +Z forward at 0
    this.bodyYaw = 0;
    this.bodyYawVel = 0;
    this.pitch = 0;
    this.stance = 0;
    this.ads = false;
    this.weapon = 'rifle';
    this.visibleOnce = false;

    this.actor = {
      id: `net${id}`,
      net: true,
      netId: id,
      mesh: this.inst.rig,
      skin: this.inst.mesh,
      head: this.inst.byName.get('head'),
      inst: this.inst,
      position: new THREE.Vector3(),
      velocity: this.vel,
      yaw: 0,
      health: 100,
      maxHealth: 100,
      alive: false,               // until the first snapshot places the body
      team: 1,
    };
    this._setVisible(false);

    this.plate = makeNameplate(name);
    root.add(this.plate);
  }

  /* ------------------------------------------------------------ snapshots */

  push(t, st) {
    const last = this.buffer[this.buffer.length - 1];
    if (last && t <= last.t) return;          // duplicate or out of order
    this.buffer.push({
      t,
      p: new THREE.Vector3(st.p[0], st.p[1], st.p[2]),
      v: new THREE.Vector3(st.v[0], st.v[1], st.v[2]),
      y: st.y, pi: st.pi, s: st.s, a: st.a, w: st.w, ads: st.ads,
    });
    while (this.buffer.length > 2 && this.buffer[1].t < t - BUFFER_MS) this.buffer.shift();
  }

  /** Interpolated state at server time `rt`; false while nothing has arrived. */
  _sample(rt) {
    const buf = this.buffer;
    if (!buf.length) return false;
    let a = buf[0], b = null;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= rt) { a = buf[i]; b = buf[i + 1] || null; break; }
    }

    if (!b || rt < a.t) {
      // Starved (or ahead of the oldest sample): extrapolate briefly, then hold.
      const ahead = Math.min(MAX_EXTRAPOLATE_MS, Math.max(0, rt - a.t)) / 1000;
      this.feet.copy(a.p).addScaledVector(a.v, ahead);
      this.vel.copy(a.v);
      this._take(a, a.y);
      return true;
    }

    if (a.p.distanceTo(b.p) > TELEPORT_DIST) {
      const s = (rt - a.t) < (b.t - a.t) * 0.5 ? a : b;
      this.feet.copy(s.p);
      this.vel.copy(s.v);
      this._take(s, s.y);
      return true;
    }

    const k = (rt - a.t) / Math.max(1, b.t - a.t);
    this.feet.lerpVectors(a.p, b.p, k);
    this.vel.lerpVectors(a.v, b.v, k);
    this._take(k < 0.5 ? a : b, a.y + wrapPi(b.y - a.y) * k);
    this.pitch = a.pi + (b.pi - a.pi) * k;
    return true;
  }

  _take(s, playerYaw) {
    // The player's yaw looks down -Z at zero; the soldier rig faces +Z.
    this.aimYaw = playerYaw + Math.PI;
    this.pitch = s.pi;
    this.stance = s.s;
    this.ads = s.ads;
    this.weapon = s.w;
    this._targetAlive = s.a;
  }

  /* ---------------------------------------------------------------- frame */

  update(dt, rt, ctx) {
    this._collision = ctx.collision;
    if (!this._sample(rt)) return;

    // Life state follows the stream; a `kill` message may already have started
    // the ragdoll, in which case this only catches the respawn.
    // The `kill` message is real-time but the stream is drawn INTERP_DELAY
    // behind it, so a body killed by message stays down until the stream has
    // itself shown it dead; only a later "alive" is a respawn.
    if (!this._targetAlive) this._deathLatch = false;
    if (this._targetAlive && !this.actor.alive && !this._deathLatch) this._respawn();
    else if (!this._targetAlive && this.actor.alive) this.kill(null);

    if (this.ragdoll?.active) {
      this.ragdoll.step(dt);
      this.plate.visible = false;
      return;
    }
    if (!this.actor.alive) { this.plate.visible = false; return; }

    // Body yaw follows aim with a ~0.15 s critically damped lag.
    const err = wrapPi(this.aimYaw - this.bodyYaw);
    const w = 14;
    this.bodyYawVel += (err * w * w - this.bodyYawVel * 2 * w) * dt;
    this.bodyYaw = wrapPi(this.bodyYaw + this.bodyYawVel * dt);
    if (Math.abs(err) > 1.4) this.bodyYaw = wrapPi(this.aimYaw - Math.sign(err) * 1.4);

    const a = this.actor;
    a.position.copy(this.feet).setY(this.feet.y + CAPSULE_HALF);
    a.yaw = this.bodyYaw;

    const speed = Math.hypot(this.vel.x, this.vel.z);
    const distSq = a.position.distanceToSquared(ctx.camPos);
    this.loco.update(dt, {
      collision: ctx.collision,
      position: a.position,
      yaw: this.bodyYaw,
      aimYaw: this.aimYaw,
      // Player pitch is positive looking up; the rig's spine chain is the reverse.
      aimPitch: -this.pitch,
      aimBlend: this.ads ? 1 : 0.7,
      crouch: this.stance === 1 || this.stance === 2 || this.stance === 3,
      speed,
      footIK: ctx.footIK && distSq < 42 * 42,
      time: ctx.time,
    });

    // Nameplate: over the helmet, fading out with range so a crowded room is
    // not a wall of labels.
    const head = a.head;
    if (head) head.getWorldPosition(this.plate.position); else this.plate.position.copy(a.position);
    this.plate.position.y += 0.42;
    const d = Math.sqrt(distSq);
    const fade = 1 - THREE.MathUtils.smoothstep(d, 35, 60);
    this.plate.material.opacity = 0.92 * fade;
    this.plate.visible = fade > 0.01;
  }

  /** World-space muzzle, for tracers and the flash. */
  muzzle(out) {
    if (!this.actor.alive) return out.copy(this.actor.position);
    return this.loco.muzzle(out, MUZZLE_LOCAL);
  }

  eye(out) {
    if (this.actor.head) return this.actor.head.getWorldPosition(out);
    return out.copy(this.feet).setY(this.feet.y + 1.6);
  }

  /**
   * Ray against the per-limb capsules, the same test the AI uses for bots.
   * @returns {{ t:number, limb:string } | null} nearest hit closer than maxT
   */
  raycast(origin, dir, maxT) {
    if (!this.actor.alive || this.ragdoll?.active) return null;
    const coarse = rayCapsule(origin, dir, this.actor.position, CAPSULE_HALF + 0.12, 0.55);
    if (coarse === null || coarse > maxT) return null;
    let best = null, bestT = maxT;
    for (const hb of HITBOXES) {
      const bone = this.inst.byName.get(hb.bone);
      if (!bone) continue;
      _v.set(hb.offset[0], hb.offset[1], hb.offset[2]).applyMatrix4(bone.matrixWorld);
      const t = rayCapsule(origin, dir, _v, hb.half + hb.radius, hb.radius);
      if (t !== null && t < bestT) { bestT = t; best = { t, limb: hb.limb }; }
    }
    return best;
  }

  /** Flinch on a confirmed local hit, before the victim's client even knows. */
  react(dir, damage, limb) {
    if (this.actor.alive) this.loco.react(dir, Math.min(1, damage / 40), limb);
  }

  kill(fromPos, collision) {
    if (!this.actor.alive) return;
    this.actor.alive = false;
    this._deathLatch = true;
    this.actor.health = 0;
    this.plate.visible = false;
    if (!this.visibleOnce) { this._setVisible(false); return; }

    if (fromPos) _a.copy(this.actor.position).sub(fromPos).setY(0);
    else _a.set(Math.sin(this.bodyYaw), 0, Math.cos(this.bodyYaw)).negate();
    if (_a.lengthSq() < 1e-6) _a.set(0, 0, 1);
    _a.normalize().multiplyScalar(4.5);
    _a.y += 1.4;
    this.ragdoll = new Ragdoll().start(this.inst, this.vel, _a, collision || this._collision || null);
  }

  _respawn() {
    this.ragdoll?.stop();
    this.ragdoll = null;
    const inst = this.inst;
    for (let i = 0; i < inst.bones.length; i++) {
      inst.bones[i].position.copy(inst.rest[i].p);
      inst.bones[i].quaternion.copy(inst.rest[i].q);
    }
    this.bodyYaw = this.aimYaw;
    this.bodyYawVel = 0;
    this.actor.alive = true;
    this.actor.health = this.actor.maxHealth;
    this.visibleOnce = true;
    this._setVisible(true);
  }

  _setVisible(on) {
    this.inst.rig.visible = on;
    this.inst.mesh.visible = on;
  }

  dispose() {
    this.ragdoll?.stop();
    this.root.remove(this.inst.rig);
    this.root.remove(this.inst.mesh);
    this.root.remove(this.plate);
    this.inst.skeleton.dispose?.();
    this.plate.material.map.dispose();
    this.plate.material.dispose();
  }
}

/* ============================================================= nameplate */

/**
 * A callsign drawn into a canvas at runtime — no font files, no image assets.
 * The plate is a sprite, which the G-buffer pass skips, so it never writes
 * into SSAO/SSR normals.
 */
function makeNameplate(name) {
  const w = 256, h = 64;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.font = '600 30px "Bahnschrift","DIN Alternate","Roboto Condensed","Arial Narrow",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const tw = Math.min(w - 8, g.measureText(name).width + 34);

  // Hostile chevron plate: dark glass, a warm-red keyline, the callsign.
  g.fillStyle = 'rgba(12,14,18,0.62)';
  roundRect(g, (w - tw) / 2, 12, tw, 40, 6);
  g.fill();
  g.strokeStyle = 'rgba(255,92,70,0.85)';
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = 'rgba(255,92,70,0.95)';
  g.beginPath();
  g.moveTo(w / 2 - 7, 52); g.lineTo(w / 2 + 7, 52); g.lineTo(w / 2, 60);
  g.closePath(); g.fill();
  g.fillStyle = '#f2ede4';
  g.fillText(name, w / 2, 33);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: true,
    toneMapped: false, opacity: 0.92, fog: false,
  });
  const s = new THREE.Sprite(mat);
  s.scale.set(1.1, 0.275, 1);
  s.renderOrder = 10;
  s.visible = false;
  s.name = `Nameplate:${name}`;
  return s;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function wrapPi(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

