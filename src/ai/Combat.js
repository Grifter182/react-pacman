import * as THREE from 'three';

/**
 * OWNER: AI agent.
 *
 * How a bot shoots. The whole point of this file is that difficulty is
 * expressed as *time and error*, never as hit points: a hard bot reacts in
 * 180 ms and converges its aim in half a second, an easy one takes 700 ms and
 * never quite settles. Both die to the same two bullets.
 *
 *   reaction     dead time between deciding to shoot and the first round
 *   convergence  aim error decays exponentially toward a floor while the bot
 *                holds the target — so strafing out of a duel and re-entering
 *                it resets their aim, which is what peeking is *for*
 *   bursts       controlled pairs and threes with a pause, never a laser
 *   suppression  rounds that crack past the player pin them, without damage
 *   grenades     thrown at a target that has been static in cover, arced over
 *                the obstacle rather than through it
 */

export const DIFFICULTY = {
  recruit: { reaction: [0.62, 0.95], errStart: 0.115, errMin: 0.030, converge: 1.5, burst: [2, 3], rest: [0.85, 1.5], suppressAcc: 0.55, grenadeChance: 0.15, perception: 0.75 },
  regular: { reaction: [0.40, 0.66], errStart: 0.085, errMin: 0.018, converge: 2.1, burst: [3, 4], rest: [0.55, 1.05], suppressAcc: 0.7, grenadeChance: 0.32, perception: 1.0 },
  veteran: { reaction: [0.26, 0.44], errStart: 0.060, errMin: 0.010, converge: 3.0, burst: [3, 5], rest: [0.38, 0.75], suppressAcc: 0.85, grenadeChance: 0.5, perception: 1.2 },
  elite: { reaction: [0.16, 0.28], errStart: 0.042, errMin: 0.0055, converge: 4.2, burst: [4, 6], rest: [0.28, 0.55], suppressAcc: 1.0, grenadeChance: 0.65, perception: 1.45 },
};

/** Per-actor combat state. */
export function createCombat(skill) {
  return {
    skill,
    reactTimer: 0,
    fireTimer: 0,
    burstLeft: 0,
    resting: false,
    aimError: skill.errStart,
    aimDir: new THREE.Vector3(0, 0, 1),
    aimJitter: new THREE.Vector3(),
    jitterPhase: Math.random() * 100,
    engaged: false,
    lost: 99,
    shotsFired: 0,
    grenadeCooldown: 6 + Math.random() * 8,
    lastGrenade: -99,
    suppressing: false,
  };
}

export class CombatSystem {
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.collision = engine.get('collision');
    this.rpm = opts.rpm ?? 640;
    this.muzzleVelocityRange = opts.range ?? 90;
    this.grenades = [];
    this._grenadeGeo = null;
  }

  /**
   * Advance one actor's weapon. Returns true if a round was fired this step.
   * @param ctx { time, dt, target, targetVisible, muzzle:Vector3, aimPoint:Vector3, allowFire }
   */
  update(dt, a, ctx) {
    const c = a.combat;
    const skill = c.skill;

    if (!ctx.targetVisible || !ctx.allowFire) {
      // Losing the target does not instantly reset the aim, but it does start
      // it drifting back out — the bot has to re-acquire on the next peek.
      c.aimError = Math.min(skill.errStart, c.aimError + dt * skill.errStart * 0.85);
      c.lost += dt;
      // A brief break in contact (stepping behind a post mid-burst) must not
      // re-roll the reaction time, or a bot never gets past its own dead time
      // in a cluttered lane. Only a real loss of contact does.
      if (c.lost > 0.35) { c.reactTimer = randRange(skill.reaction); c.engaged = false; }
      c.burstLeft = 0;
      return false;
    }
    c.lost = 0;

    if (!c.engaged) { c.engaged = true; c.reactTimer = randRange(skill.reaction); }

    // Aim converges exponentially toward the skill floor while contact holds.
    const k = Math.exp(-skill.converge * dt);
    c.aimError = skill.errMin + (c.aimError - skill.errMin) * k;

    if (c.reactTimer > 0) { c.reactTimer -= dt; return false; }

    c.fireTimer -= dt;
    if (c.fireTimer > 0) return false;

    if (c.burstLeft <= 0) {
      c.burstLeft = Math.round(randRange(skill.burst));
      c.fireTimer = 0;
    }

    this._shoot(a, ctx);
    c.burstLeft--;
    c.shotsFired++;
    c.fireTimer = c.burstLeft > 0 ? 60 / this.rpm : randRange(skill.rest);
    return true;
  }

  /**
   * One round. World geometry is traced first so a bot can genuinely shoot the
   * wall in front of it; the player capsule is only tested along the surviving
   * length of the ray.
   */
  _shoot(a, ctx) {
    const c = a.combat;
    const engine = this.engine;
    const origin = ctx.muzzle;

    _aim.subVectors(ctx.aimPoint, origin);
    const dist = _aim.length() || 1;
    _aim.divideScalar(dist);

    // Error cone: Gaussian-ish, wider at the start of a burst. Recoil climb is
    // baked in as a bias so sustained fire walks up and right, like a person's.
    const spread = c.aimError * (1 + c.burstLeft * 0.06);
    const climb = Math.min(c.shotsFired % 8, 5) * spread * 0.28;
    coneSample(_dir, _aim, spread, climb);

    const worldHit = this.collision?.raycast(origin, _dir, this.muzzleVelocityRange);
    const maxT = worldHit ? worldHit.distance : this.muzzleVelocityRange;

    const player = engine.get('player');
    let hitPlayer = false;
    if (player && player.state.alive) {
      const t = rayCapsule(origin, _dir, player.state.position,
        player.controller?.halfHeight ?? 0.875, 0.36);
      if (t !== null && t < maxT) {
        hitPlayer = true;
        const range = t;
        const weapons = engine.get('weapons');
        // Bots use the same damage table the player does. Limb selection is
        // biased to the chest: they aim centre mass, not for headshots.
        const limb = Math.random() < 0.07 ? 'head' : Math.random() < 0.22 ? 'stomach' : 'chest';
        const dmg = weapons?.damageFor
          ? weapons.damageFor(range, limb, 1, 'rifle') * 0.62
          : 17;
        _pt.copy(origin).addScaledVector(_dir, t);
        player.damage(dmg, `bot${a.id}`, { origin: origin.clone(), headshot: limb === 'head' });
        engine.bus.emit('hit:surface', {
          point: _pt.clone(), normal: _dir.clone().negate(),
          material: 'flesh', impulse: 0.4,
        });
      } else {
        // Near miss: distance of closest approach decides whether the round is
        // heard cracking past or just heard.
        const miss = pointLineDistance(player.state.position, origin, _dir, maxT);
        if (miss < 1.9) {
          player.suppress(THREE.MathUtils.clamp(0.42 - miss * 0.15, 0.06, 0.42) * c.skill.suppressAcc);
          engine.bus.emit('audio:play', {
            id: 'bullet_crack', position: null,
            volume: 0.25 + (1.9 - miss) * 0.2, pitch: 0.9 + Math.random() * 0.3,
          });
        }
      }
    }

    if (worldHit && !hitPlayer) {
      engine.bus.emit('hit:surface', {
        point: worldHit.point.clone(), normal: worldHit.normal.clone(),
        material: worldHit.object?.material?.userData?.preset || 'concrete',
        impulse: 0.85,
      });
    }

    _pt.copy(origin).addScaledVector(_dir, Math.min(maxT, 120));
    engine.bus.emit('ai:fire', {
      actor: a, origin: origin.clone(), direction: _dir.clone(),
      end: _pt.clone(), hitPlayer,
    });
    engine.bus.emit('audio:play', {
      id: 'enemy_fire', position: origin.clone(),
      volume: 0.55, pitch: 0.95 + Math.random() * 0.12,
    });
  }

  /* -------------------------------------------------------------- grenades */

  /**
   * Flush a target out of cover. The arc is solved for a fixed flight time,
   * which is both stable and cheap: given dt, the required launch velocity is
   * (d - 0.5 g t^2) / t. If the resulting arc's apex would clip the obstacle in
   * front of the thrower the throw is refused rather than fumbled into a wall.
   */
  tryThrow(a, targetPos, time) {
    const c = a.combat;
    if (time - c.lastGrenade < c.grenadeCooldown) return false;
    if (Math.random() > c.skill.grenadeChance) { c.lastGrenade = time - c.grenadeCooldown * 0.5; return false; }

    const from = _pt.copy(a.position).setY(a.position.y + 1.25);
    const d = _aim.subVectors(targetPos, from);
    const flat = Math.hypot(d.x, d.z);
    if (flat < 5 || flat > 26) return false;

    const t = THREE.MathUtils.clamp(flat / 13, 0.8, 2.0);
    const g = 19.6;
    const v = new THREE.Vector3(
      d.x / t,
      d.y / t + 0.5 * g * t,
      d.z / t,
    );

    // Refuse the throw if the first metre of the arc is already inside a wall.
    _dir.copy(v).normalize();
    const blocked = this.collision?.raycast(from, _dir, 1.6);
    if (blocked) return false;

    this.grenades.push({
      pos: from.clone(), vel: v, fuse: t + 0.75, from: a.id, radius: 6.0, power: 1,
    });
    c.lastGrenade = time;
    c.grenadeCooldown = 9 + Math.random() * 10;
    this.engine.bus.emit('ai:grenade', { actor: a, position: from.clone(), target: targetPos.clone() });
    this.engine.bus.emit('audio:play', { id: 'grenade_throw', position: from.clone(), volume: 0.4 });
    return true;
  }

  stepGrenades(dt) {
    const g = 19.6;
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const n = this.grenades[i];
      n.vel.y -= g * dt;
      _pt.copy(n.vel).multiplyScalar(dt);
      const travel = _pt.length();
      if (travel > 1e-5) {
        _dir.copy(_pt).divideScalar(travel);
        const hit = this.collision?.raycast(n.pos, _dir, travel + 0.12);
        if (hit) {
          // Bounce with damping; grenades that stop moving simply sit and cook.
          n.pos.copy(hit.point).addScaledVector(hit.normal, 0.06);
          const vn = n.vel.dot(hit.normal);
          n.vel.addScaledVector(hit.normal, -1.45 * vn).multiplyScalar(0.52);
        } else {
          n.pos.add(_pt);
        }
      }
      n.fuse -= dt;
      if (n.fuse <= 0) { this._detonate(n); this.grenades.splice(i, 1); }
    }
  }

  _detonate(n) {
    const engine = this.engine;
    engine.bus.emit('fx:explosion', { position: n.pos.clone(), radius: n.radius, power: n.power });
    engine.bus.emit('audio:play', { id: 'explosion', position: n.pos.clone(), volume: 1 });

    const player = engine.get('player');
    if (player && player.state.alive) {
      _aim.subVectors(player.state.position, n.pos);
      const d = _aim.length();
      if (d < n.radius) {
        // Line of sight gate: a wall between you and the blast is a wall.
        _dir.copy(_aim).divideScalar(Math.max(d, 1e-4));
        const blocked = this.collision?.raycast(n.pos, _dir, d - 0.35);
        const falloff = 1 - d / n.radius;
        const dmg = blocked ? falloff * 18 : falloff * falloff * 88;
        if (dmg > 1) player.damage(dmg, `bot${n.from}`, { origin: n.pos.clone(), explosion: true });
        player.addShake(0.09 * (1 - d / n.radius));
      }
    }
  }

  dispose() { this.grenades.length = 0; }
}

/* ------------------------------------------------------------------ maths */

function randRange([a, b]) { return a + Math.random() * (b - a); }

/** Sample inside a cone about `axis`, with a vertical bias for recoil climb. */
function coneSample(out, axis, spread, climb) {
  // Two uniforms -> a roughly normal offset (Box-Muller without the log cost:
  // sum of two uniforms is close enough at this magnitude and never blows up).
  const rx = (Math.random() + Math.random() - 1) * spread;
  const ry = (Math.random() + Math.random() - 1) * spread + climb;
  _tangent.set(-axis.z, 0, axis.x);
  if (_tangent.lengthSq() < 1e-8) _tangent.set(1, 0, 0);
  _tangent.normalize();
  _bitangent.crossVectors(axis, _tangent).normalize();
  out.copy(axis).addScaledVector(_tangent, rx).addScaledVector(_bitangent, ry).normalize();
}

/** Ray vs vertical capsule. Returns entry distance or null. */
export function rayCapsule(origin, dir, centre, halfHeight, radius) {
  const segY0 = centre.y - halfHeight + radius;
  const segY1 = centre.y + halfHeight - radius;

  // Infinite-cylinder test in XZ, then clamp against the caps.
  const ox = origin.x - centre.x, oz = origin.z - centre.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a > 1e-8) {
    const b = ox * dir.x + oz * dir.z;
    const c = ox * ox + oz * oz - radius * radius;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      let t = (-b - sq) / a;
      if (t < 0) t = (-b + sq) / a;
      if (t >= 0) {
        const y = origin.y + dir.y * t;
        if (y >= segY0 && y <= segY1) return t;
      }
    }
  }
  // Caps.
  let best = null;
  for (const cy of [segY0, segY1]) {
    const t = raySphere(origin, dir, centre.x, cy, centre.z, radius);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

export function raySphere(origin, dir, cx, cy, cz, radius) {
  const ox = origin.x - cx, oy = origin.y - cy, oz = origin.z - cz;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = -b - sq;
  if (t0 >= 0) return t0;
  const t1 = -b + sq;
  return t1 >= 0 ? t1 : null;
}

/** Closest approach of a point to a bounded ray. */
function pointLineDistance(p, origin, dir, maxT) {
  const px = p.x - origin.x, py = p.y - origin.y, pz = p.z - origin.z;
  let t = px * dir.x + py * dir.y + pz * dir.z;
  t = THREE.MathUtils.clamp(t, 0, maxT);
  const dx = px - dir.x * t, dy = py - dir.y * t, dz = pz - dir.z * t;
  return Math.hypot(dx, dy, dz);
}

const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();
