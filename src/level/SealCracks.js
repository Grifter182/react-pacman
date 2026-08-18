import * as THREE from 'three';
import { NavMesh } from '../ai/NavMesh.js';
import { Config } from '../core/Config.js';

/**
 * Wall off the dead cracks between building shells.
 *
 * STATUS: NOT WIRED UP, AND NOT WORKING. LevelModule does not call this. It
 * runs and reports "149 dead cracks, 135.2 m2, 314 boxes, spared 13", but
 * dropping the player into each of the five cracks tools/level-probe.mjs names
 * leaves all five enterable — so it is selecting a set of narrow cells that does
 * not contain the reported ones. Two theories have been tried and both were
 * refuted by measurement rather than by argument: that the fix and the test read
 * different maps (fixed, no effect on the outcome), and that the map perimeter
 * merged into one oversized cluster and was spared by the area guard (disproved
 * — the numbers were identical before and after narrowing that guard, so nothing
 * was ever hitting it). The next step is a direct SET COMPARISON: dump the cell
 * indices this selects and the ones level-probe reports as narrow, and
 * difference them. Every theory so far has been an inference about that
 * difference instead of a measurement of it.
 *
 * THE COMPLAINT, MEASURED. A player reported "narrow corridors between buildings
 * that feel like a flaw". tools/level-probe.mjs found 147 m2 of walkable ground
 * at or under 1.5 m wide, in 79 clusters, the narrowest 0.52 m and the worst an
 * 8.3 m long half-metre slot at x 39.5. They are not the level's alleys — the
 * alley here is 7 m wide — they are the seams left where two building shells
 * stand near each other, and walking into one puts the player in a gap that goes
 * nowhere.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS READS THE NAVMESH INSTEAD OF RASTERISING ITS OWN GRID
 * ---------------------------------------------------------------------------
 * The first attempt at this built its own occupancy grid — 0.26 m cells, a chest
 * band, triangle bounding boxes — and decided from that. It ran, it reported
 * "sealed 135 dead cracks, 153.9 m2, 749 boxes", and it was wrong: the probe
 * still measured 140 m2 of narrow ground (down from 147), and all five of the
 * cracks it names were still enterable. It had sealed 153.9 m2 of somewhere
 * else.
 *
 * The cause was having two maps. That grid and the navmesh disagreed about where
 * narrow space is — different cell size, different notion of solid, and bounding
 * boxes that inflate every yaw-rotated prop — so the fix and the test were
 * measuring different worlds, each self-consistently. It is the same failure
 * that has produced every wrong answer in this project: a sight probe fanning
 * rays at the rear-glass radius while claiming to test the front element, an
 * aperture test cast from an eye position no player has.
 *
 * So there is now exactly one map. This builds a NavMesh with the same
 * parameters AiModule will use, and the crack analysis marches over its ground
 * nodes with the same rule level-probe.mjs uses to measure them. The fix cannot
 * drift from its test, because they read the same structure.
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
 */

/** Ground cells at or under this width are candidates. */
const NARROW_M = 1.25;
/** A narrow run longer than this is a passage, not an opening in a wall. */
const MAX_OPENING_RUN = 1.6;
/** Never seal a cul-de-sac bigger than this: it is a room, not a crack. */
const MAX_AREA = 14;

export function sealDeadCracks(proxy, bounds, opts = {}) {
  const t0 = performance.now();
  const mesh = proxy.toMesh();

  // Same agent as AiModule builds for, so "walkable" means the same thing here
  // as it will at runtime and in the probe.
  const nav = new NavMesh({
    cell: opts.cell ?? 0.52,
    agentRadius: (Config.player.radius ?? 0.34) + 0.08,
    agentHeight: 1.72,
    stepHeight: Config.player.stepHeight,
    maxSlopeDeg: Config.player.maxSlopeDeg + 2,
  });
  const bb = bounds || new THREE.Box3().setFromBufferAttribute(mesh.geometry.getAttribute('position'));
  nav.build(mesh.geometry, bb);
  mesh.geometry.dispose();
  if (!nav.ready) return { sealed: 0, sealedAreaM2: 0, boxes: 0, spared: [], note: 'navmesh not ready' };

  const { gw, gd, cell, minX, minZ, cellFirst, cellCount, nodeY, nodeFlags } = nav;
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

  return {
    sealed: sealedClusters,
    sealedAreaM2: +(sealedCells * cell * cell).toFixed(1),
    boxes,
    wideRegions: regions,
    sparedCount: spared.length,
    spared: spared.sort((a, b) => b.areaM2 - a.areaM2).slice(0, 10),
    ms: +(performance.now() - t0).toFixed(0),
  };
}
