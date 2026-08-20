import * as THREE from 'three';

/**
 * OWNER: AI agent.  (New file; imported only from src/ai/.)
 *
 * WHY THIS EXISTS
 * ---------------
 * Measured, this session: with the player standing still at four real places
 * for a minute each, an enemy was in front of them and not behind a wall for
 * 1.7% / 0% / 72.5% / 100% of the match, and someone was within 25 m for
 * 0% / 0% / 1.7% / 38.3%. The bots were alive, drawn, and busy — 110 m of
 * travel each per two minutes. They were simply never *where the player was*.
 *
 * The cause was structural, not a bug. A bot's only destination in relaxed
 * posture was a waypoint picked uniformly at random about 26 m away. That is a
 * random walk: from the north spawn line, in a 60 s sample, a bot's expected
 * displacement is under 40 m on a map 85 m deep. The southern third of the
 * level — which is where the player spawns — was statistically unreachable in
 * the time available, and nothing anywhere in the behaviour tree pulled anyone
 * towards contact.
 *
 * This file is the squad's shared head. Two structures, both of which decay:
 *
 *  COVERAGE — a coarse grid of "when did anybody last look here". Bots with
 *  nothing better to do go to the *stalest* place they can reach, not a random
 *  one. Staleness is self-correcting: the longer a corner goes unvisited the
 *  more attractive it becomes, so a squad sweeps its map instead of diffusing
 *  through it. This channel knows nothing whatsoever about the player. It is
 *  what makes a silent, stationary player get found — by being looked for.
 *
 *  CONTACT — a short list of decaying marks, each one produced by something
 *  that actually happened in the world: a bot got eyes on someone, a bot took a
 *  round from a bearing, a bot went down, a shot or a blast was loud enough to
 *  carry. A mark is a *place*, never a target, and its heat halves every ~6 s
 *  and is discarded near 25 s. That is the whole anti-omniscience story: the
 *  squad converges on where the fight was, arrives, finds nobody if the player
 *  moved, and falls back to sweeping. Breaking line of sight and walking away
 *  still works — you are leaving behind a stale rumour, not a tracker.
 *
 * ONE MAP, NOT TWO: every coverage cell stores the position of a real navmesh
 * node in the main region, so "somewhere a bot should go" and "somewhere a bot
 * can path to" are the same structure by construction. A cell with no reachable
 * node does not exist here at all.
 */

const CELL_SIZE = 9;              // m; coarse enough that a cell is ~a room
const VISIT_RADIUS = 11;          // m; how much a bot standing still "clears"
const MARK_MERGE = 7;             // m; reports closer than this are one contact
// A mark has to outlive the walk to it: crossing this map takes 20-25 s, so a
// six-second half-life meant the squad forgot a sighting before anyone arrived.
// It still decays to nothing — after ~35 s a rumour is gone.
const MARK_TAU = 13;              // s; heat e-folding time
const MARK_FLOOR = 0.07;          // heat below this is forgotten
const MARK_MAX = 12;
/**
 * How long a bot's claim on a sweep cell holds. Measured: without an expiry,
 * 90 of 97 cells read as "swept" after two minutes while no bot had been south
 * of z=+8.8 on an 88 m map — a pledge from a bot that was shot at, pulled into
 * a search and never went is indistinguishable from ground somebody walked.
 * A pledge is an intention; only `visited` is evidence.
 */
const PLEDGE_TTL = 30;            // s

export class SquadIntel {
  constructor() {
    this.ready = false;
    this.cells = [];
    this.marks = [];
    this._gw = 0; this._gd = 0;
    this._minX = 0; this._minZ = 0;
    this._index = null;            // grid cell -> index into this.cells, or -1
  }

  /**
   * Bin every usable main-region navmesh node into coarse cells, and keep for
   * each cell the node nearest its centre. Anything with no such node is not a
   * place — no bot is ever sent there and it never reads as stale.
   */
  build(nav) {
    if (!nav?.ready) return this;
    const w = (nav.gw * nav.cell), d = (nav.gd * nav.cell);
    this._minX = nav.minX; this._minZ = nav.minZ;
    this._gw = Math.max(1, Math.ceil(w / CELL_SIZE));
    this._gd = Math.max(1, Math.ceil(d / CELL_SIZE));
    this._index = new Int32Array(this._gw * this._gd).fill(-1);

    const acc = new Map();
    const p = new THREE.Vector3();
    for (let i = 0; i < nav.nodeCount; i++) {
      if (nav.nodeFlags[i] & 1) continue;
      if (nav.nodeRegion[i] !== nav.mainRegion) continue;
      nav.nodePosition(i, p);
      const gx = Math.floor((p.x - this._minX) / CELL_SIZE);
      const gz = Math.floor((p.z - this._minZ) / CELL_SIZE);
      if (gx < 0 || gz < 0 || gx >= this._gw || gz >= this._gd) continue;
      const key = gz * this._gw + gx;
      let c = acc.get(key);
      if (!c) {
        c = {
          key, gx, gz, count: 0,
          cx: this._minX + (gx + 0.5) * CELL_SIZE,
          cz: this._minZ + (gz + 0.5) * CELL_SIZE,
          bestD: Infinity, pos: new THREE.Vector3(),
          visited: 0, pledged: -1e4, pledgedBy: -1,
        };
        acc.set(key, c);
      }
      c.count++;
      const dd = (p.x - c.cx) ** 2 + (p.z - c.cz) ** 2;
      if (dd < c.bestD) { c.bestD = dd; c.pos.copy(p); }
    }

    // A cell needs real floor in it, not one stray ledge voxel.
    const minNodes = Math.max(4, Math.round(6 / (nav.cell * nav.cell)));
    for (const c of acc.values()) {
      if (c.count < minNodes) continue;
      this._index[c.key] = this.cells.length;
      // Stagger the initial staleness so the squad fans out on the first tick
      // instead of six bots queuing for the same corner.
      c.visited = -Math.random() * 40;
      this.cells.push(c);
    }
    this.ready = this.cells.length > 0;
    this.areaM2 = this.cells.length * CELL_SIZE * CELL_SIZE;
    return this;
  }

  /* --------------------------------------------------------------- coverage */

  /** Stamp everything within eyeshot of `pos` as freshly looked at. */
  visit(pos, time) {
    if (!this.ready) return;
    const r = Math.ceil(VISIT_RADIUS / CELL_SIZE);
    const gx0 = Math.floor((pos.x - this._minX) / CELL_SIZE);
    const gz0 = Math.floor((pos.z - this._minZ) / CELL_SIZE);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = gx0 + dx, gz = gz0 + dz;
        if (gx < 0 || gz < 0 || gx >= this._gw || gz >= this._gd) continue;
        const idx = this._index[gz * this._gw + gx];
        if (idx < 0) continue;
        const c = this.cells[idx];
        const dd = (c.cx - pos.x) ** 2 + (c.cz - pos.z) ** 2;
        if (dd > VISIT_RADIUS * VISIT_RADIUS) continue;
        // The cell you are standing in is cleared outright; the ring around it
        // is only refreshed part-way, so a bot walking a lane does not certify
        // the rooms either side of it.
        const k = dd < CELL_SIZE * CELL_SIZE ? 1 : 0.55;
        c.visited = Math.max(c.visited, time - (1 - k) * 22);
        // Arriving discharges the claim, whoever made it.
        if (k === 1) { c.pledged = -1e4; c.pledgedBy = -1; }
      }
    }
  }

  /**
   * The place most worth going to look at, from `from`. Staleness in seconds,
   * discounted by travel; `pledged` keeps two bots off the same errand.
   * Returns a THREE.Vector3 that is a real navmesh node position, or null.
   */
  stalest(from, time, actorId = -1, rand = Math.random) {
    if (!this.ready) return null;
    // Two passes: the first only considers genuinely neglected ground, the
    // second drops that bar so this never returns null while cells exist —
    // a null here used to fall through to the level's authored waypoint list,
    // five of whose entries are on unreachable ledges.
    for (const minAge of [12, 0]) {
      let best = null, bestScore = -Infinity;
      for (const c of this.cells) {
        const age = time - this._freshness(c, time);
        if (age < minAge) continue;
        const dist = Math.hypot(c.pos.x - from.x, c.pos.z - from.z);
        if (dist < 6) continue;
        // Distance is discounted gently on purpose. A squad that only ever
        // takes the nearest stale cell never crosses its own map; the far end
        // has to be able to win on age alone.
        const score = age - dist * 0.7 + rand() * 16;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (best) {
        // Pledge it: the cell now reads as handled so the rest of the squad
        // spreads out. One claim per bot, released when that bot gives up on
        // the errand (Brain._set), and expiring by itself after PLEDGE_TTL.
        this.release(actorId);
        best.pledged = time;
        best.pledgedBy = actorId;
        return best.pos.clone();
      }
    }
    return null;
  }

  /**
   * Undo the last pledge for a cell whose errand never started. Without this a
   * rejected patrol leg still marks the ground as swept, and the coverage map
   * becomes a record of intentions rather than of where anyone has looked.
   */
  unpledge(pos) {
    if (!this.ready || !pos) return;
    const gx = Math.floor((pos.x - this._minX) / CELL_SIZE);
    const gz = Math.floor((pos.z - this._minZ) / CELL_SIZE);
    if (gx < 0 || gz < 0 || gx >= this._gw || gz >= this._gd) return;
    const idx = this._index[gz * this._gw + gx];
    if (idx >= 0) { this.cells[idx].pledged = -1e4; this.cells[idx].pledgedBy = -1; }
  }

  /** Drop whatever cell this actor had claimed. */
  release(actorId) {
    if (actorId < 0) return;
    for (const c of this.cells) {
      if (c.pledgedBy === actorId) { c.pledged = -1e4; c.pledgedBy = -1; break; }
    }
  }

  /** How long since anybody actually stood at `pos`, or 0 if it is not a cell. */
  ageAt(pos, time) {
    if (!this.ready || !pos) return 0;
    const gx = Math.floor((pos.x - this._minX) / CELL_SIZE);
    const gz = Math.floor((pos.z - this._minZ) / CELL_SIZE);
    if (gx < 0 || gz < 0 || gx >= this._gw || gz >= this._gd) return 0;
    const idx = this._index[gz * this._gw + gx];
    return idx >= 0 ? time - this.cells[idx].visited : 0;
  }

  _freshness(c, time) {
    const pledgeAlive = time - c.pledged < PLEDGE_TTL;
    return pledgeAlive ? Math.max(c.visited, c.pledged) : c.visited;
  }

  /* ---------------------------------------------------------------- contact */

  /**
   * Something happened at `pos`. `weight` is how much that is worth knowing;
   * every mark decays from it. Nearby reports merge, so a firefight is one hot
   * place rather than forty tepid ones.
   */
  report(pos, weight, kind, time) {
    if (!pos) return null;
    for (const m of this.marks) {
      if (Math.hypot(m.pos.x - pos.x, m.pos.z - pos.z) < MARK_MERGE) {
        const h = this.heat(m, time);
        m.pos.lerp(pos, 0.4);
        m.weight = Math.min(1.6, Math.max(h, weight) + 0.12);
        m.time = time;
        m.kind = kind;
        m.hits++;
        return m;
      }
    }
    const m = { pos: pos.clone(), weight, kind, time, hits: 1, claims: 0, claimTime: -99 };
    this.marks.push(m);
    if (this.marks.length > MARK_MAX) {
      let worst = 0, worstH = Infinity;
      for (let i = 0; i < this.marks.length; i++) {
        const h = this.heat(this.marks[i], time);
        if (h < worstH) { worstH = h; worst = i; }
      }
      this.marks.splice(worst, 1);
    }
    return m;
  }

  heat(m, time) {
    return m.weight * Math.exp(-(time - m.time) / MARK_TAU);
  }

  /** Drop marks that have gone cold. Cheap; called a few times a second. */
  decay(time) {
    for (let i = this.marks.length - 1; i >= 0; i--) {
      if (this.heat(this.marks[i], time) < MARK_FLOOR) this.marks.splice(i, 1);
    }
  }

  /**
   * The mark this actor should go and stand on, or null. Hot beats near, but
   * not by an unlimited amount — a bot does not cross the map for a rumour.
   * `maxClaims` caps how much of the squad one contact can swallow, so a single
   * sighting cannot collapse the whole match onto one point.
   */
  best(from, time, opts = {}) {
    const minHeat = opts.minHeat ?? 0.2;
    const maxDist = opts.maxDist ?? 85;
    const maxClaims = opts.maxClaims ?? 3;
    let best = null, bestScore = 0;
    for (const m of this.marks) {
      const h = this.heat(m, time);
      if (h < minHeat) continue;
      if (m.claims >= maxClaims && time - m.claimTime < 6) continue;
      const dist = Math.hypot(m.pos.x - from.x, m.pos.z - from.z);
      if (dist > maxDist) continue;
      const score = h / (1 + dist / 45);
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  claim(m, time) {
    if (!m) return;
    if (time - m.claimTime > 6) m.claims = 0;
    m.claims++;
    m.claimTime = time;
  }

  /** A bot stood on a mark and found nothing: cool it down hard. */
  clear(m, time) {
    if (!m) return;
    m.weight = Math.min(m.weight, this.heat(m, time) * 0.3);
    m.time = time;
  }

  stats(time) {
    // `staleCells` counts ground nobody has actually stood in, not ground
    // nobody has promised to visit. Pledges are excluded on purpose.
    let stale = 0, pledged = 0;
    for (const c of this.cells) {
      if (time - c.visited > 45) stale++;
      if (time - c.pledged < PLEDGE_TTL) pledged++;
    }
    return {
      cells: this.cells.length,
      areaM2: this.areaM2 | 0,
      staleCells: stale,
      pledgedCells: pledged,
      marks: this.marks.length,
      hottest: this.marks.length
        ? +Math.max(...this.marks.map((m) => this.heat(m, time))).toFixed(2) : 0,
    };
  }
}
