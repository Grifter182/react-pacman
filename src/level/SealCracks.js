import * as THREE from 'three';
import { NavMesh } from '../ai/NavMesh.js';
import { Config } from '../core/Config.js';

/**
 * Wall off the dead cracks between building shells.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PREVIOUS REVISION SEALED 135 m2 AND CHANGED NOTHING
 * ---------------------------------------------------------------------------
 * It is the two-maps failure again, one layer further in than the header used
 * to claim. The file said it had fixed that by building a NavMesh "with the
 * same parameters AiModule will use" — but AiModule's cell size is
 * `AI_TIERS[Config.quality].navCell`, which is 0.52 / 0.46 / 0.38 / 0.34 across
 * the four tiers, and this file hard-coded 0.52. At the tier the probe runs
 * (low) the two agreed; at any other tier they did not, and the CELL INDICES
 * this returns were never comparable with the ones the probe reports in any
 * case, because nothing ever compared them.
 *
 * So the instruction is now obeyed literally: `debug` carries the grid this
 * ran on and the exact cell index sets it classified — `narrowCells`, the
 * candidates, and `sealedCells`, the ones it filled. LevelModule stashes it on
 * `level.crackReport`, and a probe can difference those against the cells the
 * shipped navmesh calls narrow AFTER the fill. That is a measurement of the
 * difference rather than an inference about it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT NOW MEASURES, AND WHY THAT AND NOT THE AI AGENT'S GRID
 * ---------------------------------------------------------------------------
 * The complaint is that the PLAYER walks into slots that go nowhere, so the
 * agent this reasons about is the player: `Config.player.radius` and a cell
 * fine enough to resolve a gap the player's 0.68 m of shoulder can enter. The
 * AI's voxelisation is a per-tier performance knob and is the wrong ruler for a
 * question about the player's capsule.
 *
 * That does mean this grid and the probe's grid are not the same grid — but
 * they no longer need to be, because what this emits is not a cell, it is a
 * SOLID: a box in the collision proxy, in world space, which every later
 * measurement (navmesh at any cell size, capsule sweep, bullet) reads through
 * the same BVH. The failure mode being avoided was two grids DISAGREEING ABOUT
 * WHERE; a finer grid that emits real geometry cannot disagree, it can only be
 * more precise. The direction of any residual error is safe — the fine grid
 * finds a superset of the coarse grid's slots — and the guards below are what
 * stop a superset from becoming a mistake.
 *
 * ---------------------------------------------------------------------------
 * THE COMPLAINT, MEASURED
 * ---------------------------------------------------------------------------
 * tools/level-probe.mjs found 146 m2 of walkable ground at or under 1.5 m wide,
 * in 79 clusters, the narrowest 0.52 m and the worst an 8.3 m long half-metre
 * slot at x 39.5, z -26.5..-18.2. They are not the level's alleys — the alley
 * here is 7 m wide — they are the seams left where two building shells stand
 * near each other, and walking into one puts the player in a gap that goes
 * nowhere.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT SIMPLY "CLOSE EVERY NARROW GAP"
 * ---------------------------------------------------------------------------
 * A doorway is about a metre wide. So is a stairwell mouth and the reveal beside
 * a doorframe. Sealing on width alone would wall the player out of every
 * interior in the level — a far worse bug, and an invisible one, because the
 * level would still look right.
 *
 * Two properties separate a crack from an opening:
 *
 *   CONNECTIVITY  A doorway joins two different open areas. A crack is a
 *                 cul-de-sac, or it opens twice onto the same street.
 *   LENGTH        A doorway is narrow only for the thickness of the wall,
 *                 a few tens of centimetres. A crack is narrow for metres.
 *
 * A cluster is sealed when it is a cul-de-sac, OR when it stays narrow for more
 * than `maxOpeningRun` — which catches the long slot that happens to be open at
 * both ends, the exact case the first attempt let through. Anything larger than
 * `maxArea` is spared regardless, so a genuine room can never be walled off
 * silently, and every spared cluster is reported with its reason.
 *
 * The acceptance test is two-sided and both sides matter: narrow area must fall
 * well below 146 m2 AND the ground area must not move. A drop in ground area is
 * this function walling the player out of the interiors, which is a worse bug
 * than the one it fixes.
 */

/** Ground cells at or under this width are candidates. */
const NARROW_M = 1.10;
/** A narrow run longer than this is a passage, not an opening in a wall. */
const MAX_OPENING_RUN = 1.6;
/** Never seal a cul-de-sac bigger than this: it is a room, not a crack. */
const MAX_AREA = 14;

export function sealDeadCracks(proxy, bounds, opts = {}) {
  const t0 = performance.now();
  const mesh = proxy.toMesh();

  // Same agent as AiModule builds for, so "walkable" means the same thing here
  // as it will at runtime and in the probe.
  const cell = opts.cell ?? 0.34;
  const nav = new NavMesh({
    cell,
    // The player's own capsule, not the AI agent's inflated one: this is a
    // question about where the player's shoulders fit.
    agentRadius: (Config.player.radius ?? 0.34) + 0.04,
    agentHeight: Config.player.height ?? 1.75,
    stepHeight: Config.player.stepHeight,
    maxSlopeDeg: Config.player.maxSlopeDeg,
  });
  const bb = bounds || new THREE.Box3().setFromBufferAttribute(mesh.geometry.getAttribute('position'));
  nav.build(mesh.geometry, bb);
  mesh.geometry.dispose();
  if (!nav.ready) return { sealed: 0, sealedAreaM2: 0, boxes: 0, spared: [], note: 'navmesh not ready' };

  const { gw, gd, minX, minZ, cellFirst, cellCount, nodeY, nodeFlags } = nav;
  const cells = gw * gd;

  /* --- 1. the ground surface of each column ------------------------------ */
  // Lowest node in a column is the street or a floor slab; a crack is a
  // ground-level phenomenon, so upper storeys are not considered.
  const ground = new Int32Array(cells).fill(-1);
  for (let c = 0; c < cells; c++) {
    const first = cellFirst[c], n = cellCount[c];
    if (first < 0 || n === 0) continue;
    let lo = Infinity, node = -1;
    for (let k = 0; k < n; k++) {
      const nd = first + k;
      if (nodeY[nd] < lo) { lo = nodeY[nd]; node = nd; }
    }
    // `nodeFlags & 1` marks a node eroded away as too close to a wall for the
    // agent. Matching level-probe.mjs exactly: eroded nodes are not walkable.
    if (node >= 0 && (nodeFlags[node] & 1) === 0) ground[c] = node;
  }
  const open = (c) => ground[c] >= 0;

  /* --- 2. corridor width, the same march the probe uses ------------------- */
  const limit = Math.max(1, Math.round(NARROW_M / cell));
  const narrow = new Uint8Array(cells);
  for (let z = 0; z < gd; z++) {
    for (let x = 0; x < gw; x++) {
      const c = z * gw + x;
      if (!open(c)) continue;
      let sx = 1, sz = 1;
      for (let i = x - 1; i >= 0 && open(z * gw + i); i--) sx++;
      for (let i = x + 1; i < gw && open(z * gw + i); i++) sx++;
      for (let i = z - 1; i >= 0 && open(i * gw + x); i--) sz++;
      for (let i = z + 1; i < gd && open(i * gw + x); i++) sz++;
      if (Math.min(sx, sz) <= limit) narrow[c] = 1;
    }
  }

  /* --- 3. label the wide open areas -------------------------------------- */
  const label = new Int32Array(cells).fill(-1);
  const stack = [];
  let regions = 0;
  for (let s = 0; s < cells; s++) {
    if (!open(s) || narrow[s] || label[s] >= 0) continue;
    const id = regions++;
    label[s] = id; stack.push(s);
    while (stack.length) {
      const c = stack.pop();
      const x = c % gw, z = (c - x) / gw;
      const push = (n) => { if (open(n) && !narrow[n] && label[n] < 0) { label[n] = id; stack.push(n); } };
      if (x > 0) push(c - 1);
      if (x < gw - 1) push(c + 1);
      if (z > 0) push(c - gw);
      if (z < gd - 1) push(c + gw);
    }
  }

  /* --- 4. judge each narrow cluster -------------------------------------- */
  const seen = new Uint8Array(cells);
  const fill = new Uint8Array(cells);
  const spared = [];
  let sealedClusters = 0, sealedCells = 0;
  for (let s = 0; s < cells; s++) {
    if (!narrow[s] || seen[s]) continue;
    const members = [];
    const touches = new Set();
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const c = stack.pop();
      members.push(c);
      const x = c % gw, z = (c - x) / gw;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
      const visit = (n) => {
        if (n < 0 || n >= cells || !open(n)) return;
        if (narrow[n]) { if (!seen[n]) { seen[n] = 1; stack.push(n); } return; }
        if (label[n] >= 0) touches.add(label[n]);
      };
      if (x > 0) visit(c - 1);
      if (x < gw - 1) visit(c + 1);
      if (z > 0) visit(c - gw);
      if (z < gd - 1) visit(c + gw);
    }
    const areaM2 = members.length * cell * cell;
    const runM = Math.max(x1 - x0, z1 - z0) * cell;
    const at = [+(minX + x0 * cell).toFixed(1), +(minZ + z0 * cell).toFixed(1)];
    const rec = { at, areaM2: +areaM2.toFixed(1), runM: +runM.toFixed(1), touches: touches.size };

    const culDeSac = touches.size <= 1;
    const tooLongToBeAnOpening = runM > MAX_OPENING_RUN;

    // THE AREA GUARD APPLIES ONLY TO COMPACT CUL-DE-SACS, and getting this
    // wrong is what made the previous revision seal 135 m2 and still leave
    // every named crack open. The guard exists so a genuine ROOM is never
    // walled off — but a room is WIDE, so it never enters the narrow set in the
    // first place. Applied to everything, the guard instead spared the biggest
    // catch in the level: the map perimeter is a continuous sub-metre band, it
    // merges into one cluster of many tens of square metres, and that single
    // spare took several of the named cracks with it. A large NARROW region is
    // by definition long and thin, which is precisely a crack network.
    if (culDeSac && !tooLongToBeAnOpening && areaM2 > MAX_AREA) {
      spared.push({ ...rec, reason: `compact pocket of ${areaM2.toFixed(1)} m2 — a space, not a crack` });
      continue;
    }
    if (!culDeSac && !tooLongToBeAnOpening) {
      spared.push({ ...rec, reason: `opening ${runM.toFixed(1)} m long joining ${touches.size} areas — a doorway` });
      continue;
    }
    for (const c of members) fill[c] = 1;
    sealedClusters++; sealedCells += members.length;
  }

  /* --- 5. emit the fill, merged into runs -------------------------------- */
  // One box per contiguous row rather than per cell: same volume, a fraction of
  // the triangles, and this geometry joins the bullet and capsule BVH.
  const H = 3.0;
  let boxes = 0;
  for (let z = 0; z < gd; z++) {
    let x = 0;
    while (x < gw) {
      if (!fill[z * gw + x]) { x++; continue; }
      let e = x;
      while (e + 1 < gw && fill[z * gw + e + 1]) e++;
      const n = e - x + 1;
      proxy.box(minX + (x + n / 2) * cell, H / 2 - 0.4, minZ + (z + 0.5) * cell, n * cell, H, cell);
      boxes++;
      x = e + 1;
    }
  }

  // The set comparison the diagnosis asked for. These are cell indices on the
  // grid described by `debug.grid`; `x = minX + (i % gw) * cell` recovers the
  // world position of any of them, which is what makes them differenceable
  // against a probe reading a grid of a different pitch.
  const narrowCells = [];
  const sealedCells2 = [];
  for (let c = 0; c < cells; c++) {
    if (narrow[c]) narrowCells.push(c);
    if (fill[c]) sealedCells2.push(c);
  }

  return {
    sealed: sealedClusters,
    sealedAreaM2: +(sealedCells * cell * cell).toFixed(1),
    narrowAreaM2: +(narrowCells.length * cell * cell).toFixed(1),
    boxes,
    wideRegions: regions,
    sparedCount: spared.length,
    spared: spared.sort((a, b) => b.areaM2 - a.areaM2).slice(0, 10),
    ms: +(performance.now() - t0).toFixed(0),
    debug: {
      grid: { gw, gd, cell, minX, minZ },
      narrowCells: Int32Array.from(narrowCells),
      sealedCells: Int32Array.from(sealedCells2),
    },
  };
}
