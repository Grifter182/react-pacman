import * as THREE from 'three';

/**
 * OWNER: gameplay agent.
 *
 * Killstreak rewards. Two of them, and both do something the player can see
 * working rather than printing a message.
 *
 *   UAV (3)        Reveals every living hostile on the minimap for 28 seconds.
 *                  The HUD reads the live actor list directly while it is up,
 *                  so the blips are the actual soldiers, moving in real time.
 *   AIRSTRIKE (5)  A strafing run. The target is the centroid of the densest
 *                  cluster of living hostiles — found by picking the actor with
 *                  the most neighbours inside 14 m, which is a one-pass
 *                  approximation of a mode-seeking cluster and is exact enough
 *                  for six bodies. Eight bombs walk a line through that
 *                  centroid, perpendicular to the run-in, each one a real
 *                  explosion with real damage falloff.
 *
 * Both are consumed on use and the streak counter keeps climbing, so a player
 * on a nine streak has already spent both and is running on skill.
 */

const _v = new THREE.Vector3();
const _c = new THREE.Vector3();

export const STREAKS = [
  { at: 3, id: 'uav', name: 'UAV RECON', sub: 'HOSTILES REVEALED' },
  { at: 5, id: 'airstrike', name: 'AIRSTRIKE', sub: 'ORDNANCE INBOUND' },
];

export class StreakSystem {
  constructor(engine, hooks) {
    this.engine = engine;
    this.hooks = hooks;                // { actors(), applyDamage(actor, dmg, info) }
    this.uavUntil = 0;
    this.time = 0;
    this._strike = null;
    this._awarded = new Set();
  }

  reset() {
    this.uavUntil = 0;
    this._strike = null;
    this._awarded.clear();
  }

  /** Called after every player kill with the new streak length. */
  onStreak(n) {
    for (const s of STREAKS) {
      if (n !== s.at || this._awarded.has(s.id)) continue;
      this._awarded.add(s.id);
      if (s.id === 'uav') this.callUav();
      else if (s.id === 'airstrike') this.callAirstrike();
      this.engine.bus.emit('match:callout', {
        title: s.name, sub: s.sub, kind: 'reward', dwell: 3.2,
      });
      return s;
    }
    return null;
  }

  /** A death cancels nothing already in the air, but re-arms the awards. */
  onPlayerDeath() { this._awarded.clear(); }

  callUav() {
    this.uavUntil = this.time + 28;
    this.engine.bus.emit('match:uav', { active: true, until: this.uavUntil });
  }

  callAirstrike() {
    const actors = this.hooks.actors() || [];
    const live = actors.filter((a) => a.alive);
    if (!live.length) return;

    // Mode-seeking by neighbour count: the actor with the most company inside
    // 14 m sits in the densest part of the field, and its neighbourhood
    // centroid is where the ordnance should go.
    let best = live[0], bestCount = -1;
    for (const a of live) {
      let n = 0;
      for (const b of live) if (a !== b && a.position.distanceToSquared(b.position) < 196) n++;
      if (n > bestCount) { bestCount = n; best = a; }
    }
    _c.set(0, 0, 0);
    let n = 0;
    for (const b of live) {
      if (b.position.distanceToSquared(best.position) < 196) { _c.add(b.position); n++; }
    }
    if (n) _c.multiplyScalar(1 / n);

    // Run-in along the map's long axis, offset so the line walks through the
    // cluster rather than starting on it.
    const heading = Math.random() < 0.5 ? 0 : Math.PI;
    this._strike = {
      centre: _c.clone(),
      dir: new THREE.Vector3(Math.sin(heading + Math.PI / 2), 0, Math.cos(heading + Math.PI / 2)),
      next: this.time + 2.4,          // the delay is the whole drama of a strike
      left: 8,
      step: 0.22,
      index: -4,
    };
    this.engine.bus.emit('match:objective', {
      text: 'AIRSTRIKE INBOUND', sub: 'CLEAR THE MARKET FLOOR',
    });
  }

  update(dt) {
    this.time += dt;

    if (this.uavUntil > 0 && this.time > this.uavUntil) {
      this.uavUntil = 0;
      this.engine.bus.emit('match:uav', { active: false });
    }

    const s = this._strike;
    if (!s) return;
    while (s.left > 0 && this.time >= s.next) {
      _v.copy(s.centre).addScaledVector(s.dir, s.index * 7.5);
      // A little scatter: bombs are not laid on a ruler.
      _v.x += (Math.random() - 0.5) * 3.2;
      _v.z += (Math.random() - 0.5) * 3.2;
      this._detonate(_v, 9.5, 120);
      s.index++;
      s.left--;
      s.next += s.step;
    }
    if (s.left <= 0) {
      this._strike = null;
      // Hand the objective strip back to whatever the round was saying before
      // the strike borrowed it.
      this.hooks.restoreObjective?.();
    }
  }

  _detonate(position, radius, power) {
    const engine = this.engine;
    engine.bus.emit('fx:explosion', { position: position.clone(), radius, power });

    // Damage falls off with the square of distance, floored at the radius —
    // the same shape the AI's own grenades use, so the two read alike.
    for (const a of this.hooks.actors() || []) {
      if (!a.alive) continue;
      const d = a.position.distanceTo(position);
      if (d > radius) continue;
      const k = 1 - d / radius;
      this.hooks.applyDamage(a, power * k * k, {
        by: 'airstrike', position, headshot: false,
      });
    }

    const player = engine.get('player');
    if (player?.state?.alive) {
      const d = player.state.position.distanceTo(position);
      if (d < radius) {
        const k = 1 - d / radius;
        // Friendly fire from your own strike is real, but halved: the call is a
        // reward, not a trap.
        player.damage(power * k * k * 0.5, 'airstrike', { origin: position.clone(), explosion: true });
      }
    }
  }

  get uavActive() { return this.uavUntil > this.time; }
}
