import * as THREE from 'three';

/**
 * OWNER: AI agent.
 *
 * Cover points harvested from the navmesh, not authored. A surface cell that
 * borders a column whose solid geometry rises above the agent is a place you
 * can put your back to something; the direction the obstacle lies in, and how
 * tall it is, are the two facts a bot needs to use it.
 *
 * Every point stores:
 *   pos     the stance position (on the mesh, agent radius already eroded out)
 *   normal  unit vector pointing from the obstacle *into the open* — a threat
 *           is covered when it lies opposite this
 *   height  metres of obstacle above the stance surface
 *   crouch  true when the obstacle only covers a crouched silhouette
 *   left/right  peek positions along the obstacle face, pre-validated
 *
 * Lookup is through a flat 4 m spatial hash: the bots query it several times a
 * second and a linear scan over a few thousand points is not free.
 */

const BUCKET = 4.0;
const MIN_SPACING = 1.8;

export class CoverMap {
  constructor() {
    this.points = [];
    this._buckets = new Map();
  }

  /**
   * @param nav  a built NavMesh
   * @param maxPoints hard cap so a huge map cannot blow the budget
   */
  build(nav, maxPoints = 2200) {
    const t0 = performance.now();
    this.points.length = 0;
    this._buckets.clear();
    if (!nav.ready) return this;

    const cs = nav.cell;
    const occupied = new Map();     // spacing hash, coarser than the buckets
    const pos = new THREE.Vector3();

    for (let i = 0; i < nav.nodeCount && this.points.length < maxPoints; i++) {
      if (nav.nodeFlags[i] & 1) continue;
      if (nav.nodeRegion[i] !== nav.mainRegion) continue;
      nav.nodePosition(i, pos);

      // Accumulate the direction and height of every blocking neighbour.
      let nx = 0, nz = 0, best = 0, count = 0;
      const c = nav.nodeCell[i];
      const gx = c % nav.gw, gz = (c / nav.gw) | 0;
      for (let k = 0; k < 8; k++) {
        const dx = DX[k], dz = DZ[k];
        const ox = gx + dx * 2, oz = gz + dz * 2;   // look one cell past the erosion band
        if (ox < 0 || oz < 0 || ox >= nav.gw || oz >= nav.gd) continue;
        const oc = oz * nav.gw + ox;
        const top = nav.obstacleTop[oc];
        const rise = top - pos.y;
        if (!(rise > 0.72)) continue;
        // A neighbour that is itself walkable at our height is not an obstacle.
        if (nav.cellFirst[oc] >= 0) {
          let flat = false;
          for (let j = nav.cellFirst[oc]; j < nav.cellFirst[oc] + nav.cellCount[oc]; j++) {
            if (Math.abs(nav.nodeY[j] - pos.y) < nav.stepHeight) flat = true;
          }
          if (flat && rise < 1.0) continue;
        }
        const len = Math.hypot(dx, dz);
        nx -= dx / len; nz -= dz / len;       // point away from the obstacle
        if (rise > best) best = rise;
        count++;
      }
      if (!count || best < 0.72) continue;
      // Cells ringed by obstacles on all sides are holes, not cover.
      const nl = Math.hypot(nx, nz);
      if (nl < 0.35 || count > 5) continue;
      nx /= nl; nz /= nl;

      const key = `${Math.round(pos.x / MIN_SPACING)},${Math.round(pos.z / MIN_SPACING)},${Math.round(pos.y / 2.5)}`;
      const prev = occupied.get(key);
      if (prev !== undefined) {
        // Keep the taller cover when two candidates share a slot.
        if (best <= this.points[prev].height) continue;
        this.points[prev] = this._make(pos, nx, nz, best, cs, nav);
        continue;
      }
      occupied.set(key, this.points.length);
      this.points.push(this._make(pos, nx, nz, best, cs, nav));
    }

    for (let i = 0; i < this.points.length; i++) this._index(i);
    this.buildMs = performance.now() - t0;
    return this;
  }

  _make(pos, nx, nz, height, cs, nav) {
    const p = {
      pos: pos.clone(),
      normal: new THREE.Vector3(nx, 0, nz),
      height,
      crouch: height < 1.45,
      left: null, right: null,
      lastUsed: -100,
      owner: -1,
    };
    // Peek slots: one agent-width along the face in each direction, kept only
    // if the navmesh actually has floor there.
    const tx = -nz, tz = nx;
    const step = Math.max(0.8, cs * 2.2);
    for (const [sign, key] of [[1, 'left'], [-1, 'right']]) {
      _v.set(pos.x + tx * step * sign, pos.y, pos.z + tz * step * sign);
      const n = nav.nearest(_v, 1);
      if (n >= 0 && Math.abs(nav.nodeY[n] - pos.y) < nav.stepHeight) {
        p[key] = nav.nodePosition(n, new THREE.Vector3());
      }
    }
    return p;
  }

  _index(i) {
    const p = this.points[i];
    const key = bucketKey(p.pos.x, p.pos.z);
    let arr = this._buckets.get(key);
    if (!arr) { arr = []; this._buckets.set(key, arr); }
    arr.push(i);
  }

  /** Every cover index within `radius` of `pos`. */
  query(pos, radius, out = []) {
    out.length = 0;
    const r = Math.ceil(radius / BUCKET);
    const bx = Math.floor(pos.x / BUCKET), bz = Math.floor(pos.z / BUCKET);
    const r2 = radius * radius;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const arr = this._buckets.get(`${bx + dx},${bz + dz}`);
        if (!arr) continue;
        for (const i of arr) {
          if (this.points[i].pos.distanceToSquared(pos) <= r2) out.push(i);
        }
      }
    }
    return out;
  }

  /**
   * Score every nearby cover point against a threat and return the best.
   *
   * The scoring is deliberately not "closest safe spot": a bot that always
   * takes the nearest cover backs into the same corner every fight. Distance to
   * the threat is scored against a preferred engagement band, lateral offset
   * from the current position is rewarded (so bots spread out and flank), and
   * a point another bot already claimed is heavily penalised.
   *
   * @param opts { from, threat, maxDist, band, now, actorId, requireFlank, crowd }
   */
  best(opts) {
    const { from, threat, maxDist = 22, band = [9, 20], now = 0, actorId = -1, crowd = null } = opts;
    this.query(from, maxDist, _scratch);
    let bestIdx = -1, bestScore = -Infinity;

    const tx = threat.x - from.x, tz = threat.z - from.z;
    const tl = Math.hypot(tx, tz) || 1;
    const tdx = tx / tl, tdz = tz / tl;

    for (const i of _scratch) {
      const p = this.points[i];
      if (p.owner >= 0 && p.owner !== actorId && now - p.lastUsed < 6) continue;

      const toThreatX = threat.x - p.pos.x, toThreatZ = threat.z - p.pos.z;
      const d = Math.hypot(toThreatX, toThreatZ);
      if (d < 3.0) continue;                            // that is not cover, that is a hug
      const ux = toThreatX / d, uz = toThreatZ / d;

      // The obstacle must be between the point and the threat.
      const facing = -(p.normal.x * ux + p.normal.z * uz);
      if (facing < 0.20) continue;

      let score = facing * 3.2;
      // Preferred engagement band, falling off either side.
      if (d < band[0]) score -= (band[0] - d) * 0.28;
      else if (d > band[1]) score -= (d - band[1]) * 0.16;
      // Cheap to reach.
      score -= p.pos.distanceTo(from) * 0.11;
      // Reward moving off the current axis to the threat — that is a flank.
      const offX = p.pos.x - from.x, offZ = p.pos.z - from.z;
      const lateral = Math.abs(offX * -tdz + offZ * tdx);
      score += Math.min(lateral, 12) * (opts.requireFlank ? 0.30 : 0.10);
      // Tall cover beats a knee-high crate when the choice exists.
      score += p.crouch ? 0 : 0.55;
      if (p.left || p.right) score += 0.4;               // somewhere to peek from
      // Claiming a point is not enough to keep a squad from bunching: the
      // points either side of a claimed one are still free, and four bots
      // stacked along one crate is exactly the shooting gallery this whole
      // module exists to avoid. Penalise proximity to every other body.
      if (crowd) {
        for (const o of crowd) {
          if (!o.alive || o.id === actorId) continue;
          const od = Math.hypot(o.position.x - p.pos.x, o.position.z - p.pos.z);
          if (od < 4.5) score -= (4.5 - od) * 0.85;
        }
      }
      score += Math.random() * 0.55;                     // break ties differently each time

      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestIdx < 0) return null;
    const p = this.points[bestIdx];
    p.owner = actorId; p.lastUsed = now;
    return p;
  }

  release(point, actorId) {
    if (point && point.owner === actorId) point.owner = -1;
  }

  stats() { return { points: this.points.length, buildMs: this.buildMs }; }
}

function bucketKey(x, z) {
  return `${Math.floor(x / BUCKET)},${Math.floor(z / BUCKET)}`;
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const _v = new THREE.Vector3();
const _scratch = [];
