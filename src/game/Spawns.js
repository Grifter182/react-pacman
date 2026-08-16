import * as THREE from 'three';

/**
 * OWNER: gameplay agent.
 *
 * Spawn selection.
 *
 * "Random point from the team's list" is what produces the worst moment a
 * deathmatch has: materialising six metres in front of somebody's muzzle. The
 * fix is not a bigger map, it is to score every candidate against the actual
 * state of the world and take the best one.
 *
 * Each candidate is scored on four terms, in descending weight:
 *
 *   SIGHTLINE   A ray from every living hostile's eye to the spawn's chest
 *               height. Anyone who can see the point at all makes it very
 *               expensive, and the cost is doubled if the point is inside their
 *               forward arc — being seen is bad, being *aimed at* is fatal.
 *   PROXIMITY   Inverse-square-ish penalty out to 30 m, so a spawn nobody can
 *               see but everybody is standing next to still loses.
 *   RECENCY     The place the player just died, and the last spawn used, are
 *               both penalised. Repeatedly dying on the same tile is what makes
 *               a spawn feel broken even when it is technically safe.
 *   COHESION    A small bonus for being near a living friendly, because
 *               spawning alone behind the enemy is not a reward.
 *
 * A little noise is added so two consecutive deaths in the same place do not
 * deterministically return the same tile.
 */

const _eye = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _to = new THREE.Vector3();

export class SpawnSelector {
  constructor(level, collision) {
    this.level = level;
    this.collision = collision;
    this.lastUsed = new Map();      // team -> THREE.Vector3
  }

  /**
   * @param team      team id
   * @param hostiles  [{ position, yaw, alive }]
   * @param friends   [{ position }]
   * @param deathSite where the spawning player last died, or null
   */
  pick(team, hostiles = [], friends = [], deathSite = null) {
    const pool = (this.level?.spawnPoints || []).filter((s) => s.team === team);
    if (!pool.length) {
      return { position: new THREE.Vector3(0, 1, 0), yaw: 0, score: 0 };
    }

    const last = this.lastUsed.get(team);
    let best = pool[0];
    let bestScore = -Infinity;

    for (const s of pool) {
      let score = Math.random() * 6;
      _chest.copy(s.position).setY(s.position.y + 1.25);

      for (const h of hostiles) {
        if (h.alive === false) continue;
        const d = h.position.distanceTo(s.position);
        // Proximity: full penalty on top of them, nothing past 30 m.
        if (d < 30) score -= (1 - d / 30) * 55;

        if (d < 70 && this._sees(h, _chest)) {
          // Facing test: the AI's forward vector is (sin yaw, cos yaw).
          _to.copy(_chest).sub(h.position).normalize();
          const facing = _to.x * Math.sin(h.yaw || 0) + _to.z * Math.cos(h.yaw || 0);
          score -= 90 + Math.max(0, facing) * 90;
        }
      }

      if (deathSite) {
        const d = s.position.distanceTo(deathSite);
        if (d < 24) score -= (1 - d / 24) * 40;
      }
      if (last) {
        const d = s.position.distanceTo(last);
        if (d < 6) score -= 25;
      }

      for (const f of friends) {
        const d = f.position ? f.position.distanceTo(s.position) : 999;
        if (d < 26) score += (1 - d / 26) * 12;
      }

      if (score > bestScore) { bestScore = score; best = s; }
    }

    this.lastUsed.set(team, best.position);
    return { position: best.position, yaw: best.yaw ?? 0, score: bestScore };
  }

  /** Eye-to-chest line of sight against the static world. */
  _sees(hostile, target) {
    if (!this.collision?.raycast) return false;
    _eye.copy(hostile.position).setY(hostile.position.y + 0.62);
    _to.copy(target).sub(_eye);
    const dist = _to.length();
    if (dist < 0.5) return true;
    _to.multiplyScalar(1 / dist);
    const hit = this.collision.raycast(_eye, _to, dist - 0.3);
    return !hit;
  }
}
