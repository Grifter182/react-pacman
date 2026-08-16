import * as THREE from 'three';

/**
 * OWNER: AI agent.
 *
 * A navigation mesh built from the level's collision geometry at boot. Nothing
 * about the map is hand-authored here — the level changes, the navmesh follows.
 *
 * The pipeline is Recast's, compressed to what this game needs:
 *
 *   1. **Voxelise.** Every collision triangle is rasterised into a 2.5-D
 *      heightfield: for each column the triangle touches, a solid span
 *      [yMin, yMax] is inserted, flagged walkable when the triangle's slope is
 *      inside the agent's limit. Near-vertical triangles contribute their whole
 *      height range and are never walkable — they are the walls.
 *   2. **Merge + filter.** Spans per column are merged, then each walkable span
 *      top is tested for head clearance. A surface under a low ceiling is not a
 *      surface an agent can use.
 *   3. **Erode.** Surfaces within the agent radius of a drop or a wall are
 *      removed, so a path centre-line is automatically a legal capsule path and
 *      the agent never has to steer away from geometry it is already inside.
 *   4. **Grow regions.** Flood fill over the surviving adjacency gives connected
 *      components; a request whose ends are in different regions fails fast
 *      instead of exhaustively searching the map.
 *
 * Queries: `findPath` runs A* over the surface graph and string-pulls the
 * corridor with the funnel algorithm, so the returned path is a short list of
 * real corner points rather than a staircase of cell centres.
 */

const NEI_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NEI_DZ = [0, 0, 1, -1, 1, -1, 1, -1];

export class NavMesh {
  constructor(opts = {}) {
    this.cell = opts.cell ?? 0.44;
    this.agentRadius = opts.agentRadius ?? 0.42;
    this.agentHeight = opts.agentHeight ?? 1.72;
    this.stepHeight = opts.stepHeight ?? 0.46;
    this.maxSlopeCos = Math.cos((opts.maxSlopeDeg ?? 50) * Math.PI / 180);

    this.ready = false;
    this.nodeCount = 0;
    this.buildMs = 0;
  }

  /* ------------------------------------------------------------------ build */

  /**
   * @param geometry  BufferGeometry of the merged world collider (world space)
   * @param bounds    THREE.Box3 limiting the voxelised area
   */
  build(geometry, bounds) {
    const t0 = performance.now();
    const cs = this.cell;

    this.minX = Math.floor(bounds.min.x / cs) * cs;
    this.minZ = Math.floor(bounds.min.z / cs) * cs;
    this.gw = Math.ceil((bounds.max.x - this.minX) / cs) + 1;
    this.gd = Math.ceil((bounds.max.z - this.minZ) / cs) + 1;
    const cells = this.gw * this.gd;

    // Per-column span soup. Flat typed arrays with a free-list would be faster
    // to allocate but this runs exactly once, and the readable form is worth
    // more than 30 ms at boot.
    const columns = new Array(cells);
    this._rasterise(geometry, columns, bounds);

    /* --- merge spans and pick surfaces ------------------------------------ */
    const nodeCell = [];
    const nodeY = [];
    const cellFirst = new Int32Array(cells).fill(-1);
    const cellCount = new Uint8Array(cells);
    /** Height of the tallest solid above each column's floor — cover lookup. */
    this.obstacleTop = new Float32Array(cells).fill(-Infinity);

    for (let c = 0; c < cells; c++) {
      const col = columns[c];
      if (!col) continue;
      col.sort((a, b) => a.min - b.min);

      // Merge overlapping / touching spans, keeping walkability of the top.
      const merged = [];
      let cur = null;
      for (const sp of col) {
        if (cur && sp.min <= cur.max + 0.04) {
          if (sp.max > cur.max) { cur.max = sp.max; cur.walk = sp.walk; }
          else if (sp.max > cur.max - 0.04) cur.walk = cur.walk || sp.walk;
        } else {
          cur = { min: sp.min, max: sp.max, walk: sp.walk };
          merged.push(cur);
        }
      }

      let top = -Infinity;
      for (let i = 0; i < merged.length; i++) {
        const sp = merged[i];
        if (sp.max > top) top = sp.max;
        if (!sp.walk) continue;
        // Head clearance: the next span up must start above head height.
        const ceil = i + 1 < merged.length ? merged[i + 1].min : Infinity;
        if (ceil - sp.max < this.agentHeight) continue;
        if (cellCount[c] >= 3) continue;              // three decks is plenty
        if (cellFirst[c] < 0) cellFirst[c] = nodeY.length;
        cellCount[c]++;
        nodeCell.push(c);
        nodeY.push(sp.max);
      }
      this.obstacleTop[c] = top;
    }

    const n = nodeY.length;
    this.nodeCount = n;
    this.nodeCell = Int32Array.from(nodeCell);
    this.nodeY = Float32Array.from(nodeY);
    this.cellFirst = cellFirst;
    this.cellCount = cellCount;
    this.nodeFlags = new Uint8Array(n);          // 1 = eroded away, 2 = border
    this.nodeRegion = new Int32Array(n).fill(-1);
    this.nei = new Int32Array(n * 8).fill(-1);

    this._link();
    this._erode();
    this._link();                                 // relink after erosion
    this._growRegions();

    // A* scratch, stamped rather than cleared between searches.
    this._gScore = new Float32Array(n);
    this._fScore = new Float32Array(n);
    this._came = new Int32Array(n);
    this._stamp = new Int32Array(n);
    this._closed = new Uint8Array(n);
    this._search = 0;
    this._heap = new Heap(Math.max(64, n >> 2));

    this.ready = n > 0;
    this.buildMs = performance.now() - t0;
    return this;
  }

  /** Triangle -> column spans. This is the only O(triangles x cells) pass. */
  _rasterise(geometry, columns, bounds) {
    const pos = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const triCount = index ? index.count / 3 : pos.count / 3;
    const cs = this.cell;
    const ax = new THREE.Vector3(), bx = new THREE.Vector3(), cx = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      ax.fromBufferAttribute(pos, i0);
      bx.fromBufferAttribute(pos, i1);
      cx.fromBufferAttribute(pos, i2);

      const yMin = Math.min(ax.y, bx.y, cx.y);
      const yMax = Math.max(ax.y, bx.y, cx.y);
      if (yMax < bounds.min.y - 2 || yMin > bounds.max.y + 2) continue;

      e1.subVectors(bx, ax); e2.subVectors(cx, ax);
      nrm.crossVectors(e1, e2);
      const nl = nrm.length();
      if (nl < 1e-9) continue;
      nrm.divideScalar(nl);
      const ny = Math.abs(nrm.y);
      const walkable = ny >= this.maxSlopeCos;

      const lo = this._cellOf(Math.min(ax.x, bx.x, cx.x), Math.min(ax.z, bx.z, cx.z));
      const hi = this._cellOf(Math.max(ax.x, bx.x, cx.x), Math.max(ax.z, bx.z, cx.z));
      const gx0 = Math.max(0, lo.x), gz0 = Math.max(0, lo.z);
      const gx1 = Math.min(this.gw - 1, hi.x), gz1 = Math.min(this.gd - 1, hi.z);
      if (gx1 < gx0 || gz1 < gz0) continue;

      // Plane form for the y lookup: y = (d - nx*x - nz*z) / ny
      const d = nrm.x * ax.x + nrm.y * ax.y + nrm.z * ax.z;

      // Conservative edge-function rasterisation. Each of the triangle's three
      // 2-D edges becomes a linear function; pushing it outward by the cell's
      // projected half-extent turns "centre inside" into "cell overlaps", which
      // is the same separating-axis result at a third of the cost — and the
      // functions step by a constant per cell, so the inner loop is three adds.
      const area = (bx.x - ax.x) * (cx.z - ax.z) - (cx.x - ax.x) * (bx.z - ax.z);
      if (Math.abs(area) < 1e-12) continue;
      const w = area > 0 ? 1 : -1;
      const ex = [ax.x, bx.x, cx.x], ez = [ax.z, bx.z, cx.z];
      const EA = _ea, EB = _eb, E0 = _e0, EOFF = _eoff;
      for (let e = 0; e < 3; e++) {
        const x1 = ex[e], z1 = ez[e], x2 = ex[(e + 1) % 3], z2 = ez[(e + 1) % 3];
        EA[e] = -w * (z2 - z1);
        EB[e] = w * (x2 - x1);
        EOFF[e] = 0.5 * cs * (Math.abs(EA[e]) + Math.abs(EB[e]));
        const px = this.minX + (gx0 + 0.5) * cs, pz = this.minZ + (gz0 + 0.5) * cs;
        E0[e] = EA[e] * (px - x1) + EB[e] * (pz - z1) + EOFF[e];
      }

      for (let gz = gz0; gz <= gz1; gz++) {
        const rz = gz - gz0;
        for (let gx = gx0; gx <= gx1; gx++) {
          const rx = gx - gx0;
          if (E0[0] + EA[0] * rx * cs + EB[0] * rz * cs < 0) continue;
          if (E0[1] + EA[1] * rx * cs + EB[1] * rz * cs < 0) continue;
          if (E0[2] + EA[2] * rx * cs + EB[2] * rz * cs < 0) continue;
          const cx0 = this.minX + gx * cs, cz0 = this.minZ + gz * cs;

          let sMin, sMax;
          if (ny > 0.2) {
            // Sample the plane at the column centre — exact for flat surfaces
            // and correct-to-half-a-cell on ramps.
            const px = cx0 + cs * 0.5, pz = cz0 + cs * 0.5;
            let h = (d - nrm.x * px - nrm.z * pz) / nrm.y;
            h = Math.min(yMax, Math.max(yMin, h));
            sMin = h - 0.05; sMax = h;
          } else {
            // Near-vertical: it occupies its whole height range in this column.
            sMin = yMin; sMax = yMax;
          }
          const c = gz * this.gw + gx;
          let col = columns[c];
          if (!col) { col = []; columns[c] = col; }
          col.push({ min: sMin, max: sMax, walk: walkable });
        }
      }
    }
  }

  _cellOf(x, z) {
    return {
      x: Math.floor((x - this.minX) / this.cell),
      z: Math.floor((z - this.minZ) / this.cell),
    };
  }

  /** 8-way adjacency between surfaces whose height differs by <= stepHeight. */
  _link() {
    const { gw, gd, nodeCell, nodeY, cellFirst, cellCount, nei, nodeFlags } = this;
    nei.fill(-1);
    for (let i = 0; i < this.nodeCount; i++) {
      if (nodeFlags[i] & 1) continue;
      const c = nodeCell[i];
      const gx = c % gw, gz = (c / gw) | 0;
      const y = nodeY[i];
      for (let k = 0; k < 8; k++) {
        const nx = gx + NEI_DX[k], nz = gz + NEI_DZ[k];
        if (nx < 0 || nz < 0 || nx >= gw || nz >= gd) continue;
        const nc = nz * gw + nx;
        const first = cellFirst[nc];
        if (first < 0) continue;
        let best = -1, bestDy = this.stepHeight + 1e-3;
        for (let j = first; j < first + cellCount[nc]; j++) {
          if (nodeFlags[j] & 1) continue;
          const dy = Math.abs(nodeY[j] - y);
          if (dy < bestDy) { bestDy = dy; best = j; }
        }
        // A diagonal move must not cut a corner between two blocked cells.
        if (best >= 0 && k >= 4) {
          const s1 = this._nodeAt(gx + NEI_DX[k], gz, y);
          const s2 = this._nodeAt(gx, gz + NEI_DZ[k], y);
          if (s1 < 0 || s2 < 0) best = -1;
        }
        nei[i * 8 + k] = best;
      }
    }
  }

  _nodeAt(gx, gz, y) {
    if (gx < 0 || gz < 0 || gx >= this.gw || gz >= this.gd) return -1;
    const c = gz * this.gw + gx;
    const first = this.cellFirst[c];
    if (first < 0) return -1;
    let best = -1, bestDy = this.stepHeight + 1e-3;
    for (let j = first; j < first + this.cellCount[c]; j++) {
      if (this.nodeFlags[j] & 1) continue;
      const dy = Math.abs(this.nodeY[j] - y);
      if (dy < bestDy) { bestDy = dy; best = j; }
    }
    return best;
  }

  /**
   * Remove everything within the agent radius of a border. Doing this once at
   * build time is what lets steering treat the path as a free centre-line.
   * Border flags are captured *before* erosion — cover lives on those cells.
   */
  _erode() {
    const n = this.nodeCount;
    const layers = Math.max(1, Math.round(this.agentRadius / this.cell));
    let front = [];
    for (let i = 0; i < n; i++) {
      let border = false;
      for (let k = 0; k < 8 && !border; k++) if (this.nei[i * 8 + k] < 0) border = true;
      if (border) { this.nodeFlags[i] |= 2; front.push(i); }
    }
    this.borderCount = front.length;

    for (let layer = 0; layer < layers; layer++) {
      const next = [];
      for (const i of front) {
        if (this.nodeFlags[i] & 1) continue;
        this.nodeFlags[i] |= 1;
        for (let k = 0; k < 8; k++) {
          const j = this.nei[i * 8 + k];
          if (j >= 0 && !(this.nodeFlags[j] & 1)) next.push(j);
        }
      }
      front = next;
    }
  }

  /** Flood fill: connected components of the eroded surface graph. */
  _growRegions() {
    const n = this.nodeCount;
    const stack = [];
    let region = 0;
    this.regionSize = [];
    for (let i = 0; i < n; i++) {
      if (this.nodeFlags[i] & 1) continue;
      if (this.nodeRegion[i] >= 0) continue;
      let size = 0;
      stack.length = 0; stack.push(i);
      this.nodeRegion[i] = region;
      while (stack.length) {
        const a = stack.pop();
        size++;
        for (let k = 0; k < 8; k++) {
          const b = this.nei[a * 8 + k];
          if (b >= 0 && this.nodeRegion[b] < 0 && !(this.nodeFlags[b] & 1)) {
            this.nodeRegion[b] = region;
            stack.push(b);
          }
        }
      }
      this.regionSize.push(size);
      region++;
    }
    this.regionCount = region;
    // The biggest component is the playable floor; everything else is a ledge
    // island a bot should never try to path onto.
    let best = -1, bestSize = -1;
    for (let r = 0; r < region; r++) if (this.regionSize[r] > bestSize) { bestSize = this.regionSize[r]; best = r; }
    this.mainRegion = best;
  }

  /* ----------------------------------------------------------------- query */

  nodePosition(i, out = new THREE.Vector3()) {
    const c = this.nodeCell[i];
    const gx = c % this.gw, gz = (c / this.gw) | 0;
    return out.set(
      this.minX + (gx + 0.5) * this.cell,
      this.nodeY[i],
      this.minZ + (gz + 0.5) * this.cell,
    );
  }

  /** Closest usable surface to a world point, searching outward in rings. */
  nearest(p, maxRings = 8) {
    if (!this.ready) return -1;
    const g = this._cellOf(p.x, p.z);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= maxRings; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const gx = g.x + dx, gz = g.z + dz;
          if (gx < 0 || gz < 0 || gx >= this.gw || gz >= this.gd) continue;
          const c = gz * this.gw + gx;
          const first = this.cellFirst[c];
          if (first < 0) continue;
          for (let j = first; j < first + this.cellCount[c]; j++) {
            if (this.nodeFlags[j] & 1) continue;
            const px = this.minX + (gx + 0.5) * this.cell;
            const pz = this.minZ + (gz + 0.5) * this.cell;
            const dy = (this.nodeY[j] - p.y);
            const d = (px - p.x) ** 2 + (pz - p.z) ** 2 + dy * dy * 4;
            if (d < bestD) { bestD = d; best = j; }
          }
        }
      }
      if (best >= 0 && r >= 1) break;
    }
    return best;
  }

  sampleHeight(p) {
    const i = this.nearest(p, 3);
    return i >= 0 ? this.nodeY[i] : p.y;
  }

  /**
   * A* over the surface graph. Costs are true 3-D distances with a small
   * penalty for hugging borders, so bots take the middle of a lane unless
   * something better is on offer.
   * @returns {number[]|null} node indices, start..goal
   */
  findNodePath(startNode, goalNode, maxExpansions = 4000) {
    if (startNode < 0 || goalNode < 0) return null;
    if (startNode === goalNode) return [startNode];
    if (this.nodeRegion[startNode] !== this.nodeRegion[goalNode]) return null;

    const s = ++this._search;
    const { _gScore: g, _fScore: f, _came: came, _stamp: stamp, _closed: closed, nei } = this;
    const heap = this._heap;
    heap.clear();

    stamp[startNode] = s; g[startNode] = 0; closed[startNode] = 0;
    f[startNode] = this._h(startNode, goalNode);
    came[startNode] = -1;
    heap.push(f[startNode], startNode);

    let expansions = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur] === s) continue;
      closed[cur] = s;
      if (cur === goalNode) return this._reconstruct(came, cur, s, stamp);
      if (++expansions > maxExpansions) break;

      const cy = this.nodeY[cur];
      for (let k = 0; k < 8; k++) {
        const nb = nei[cur * 8 + k];
        if (nb < 0 || closed[nb] === s) continue;
        const step = k < 4 ? this.cell : this.cell * 1.41421356;
        const dy = Math.abs(this.nodeY[nb] - cy);
        // Climbing costs more than walking; borders cost a little more still.
        const cost = step + dy * 1.8 + ((this.nodeFlags[nb] & 2) ? this.cell * 0.35 : 0);
        const tentative = g[cur] + cost;
        if (stamp[nb] !== s || tentative < g[nb]) {
          stamp[nb] = s;
          g[nb] = tentative;
          came[nb] = cur;
          f[nb] = tentative + this._h(nb, goalNode);
          heap.push(f[nb], nb);
        }
      }
    }
    return null;
  }

  _h(a, b) {
    const ca = this.nodeCell[a], cb = this.nodeCell[b];
    const ax = ca % this.gw, az = (ca / this.gw) | 0;
    const bx = cb % this.gw, bz = (cb / this.gw) | 0;
    const dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
    // Octile distance: admissible for 8-connected grids, far tighter than
    // Euclidean, so A* expands a fraction of the nodes.
    const oct = (dx + dz) + (1.41421356 - 2) * Math.min(dx, dz);
    // Weighted A*: over-estimating the remaining cost by a quarter cuts the
    // expanded set several-fold and the paths it returns are within a few
    // percent of optimal. On a grid this dense, nobody can see the difference
    // and the frame budget very much can.
    return (oct * this.cell + Math.abs(this.nodeY[a] - this.nodeY[b]) * 1.2) * 1.25;
  }

  _reconstruct(came, cur, s, stamp) {
    const out = [];
    let guard = 0;
    while (cur >= 0 && guard++ < 20000) {
      out.push(cur);
      const prev = came[cur];
      if (prev < 0 || stamp[prev] !== s) break;
      cur = prev;
    }
    out.reverse();
    return out;
  }

  /**
   * Full path query: A* then funnel string pulling.
   * @returns {THREE.Vector3[]|null} corner points from `from` to `to`
   */
  findPath(from, to, out = []) {
    out.length = 0;
    if (!this.ready) return null;
    const a = this.nearest(from);
    const b = this.nearest(to);
    if (a < 0 || b < 0) return null;
    const nodes = this.findNodePath(a, b);
    if (!nodes) return null;

    const start = this.nodePosition(a, new THREE.Vector3());
    start.x = from.x; start.z = from.z;
    const end = this.nodePosition(b, new THREE.Vector3());
    end.x = to.x; end.z = to.z;

    const portals = this._buildPortals(nodes, start, end);
    this._funnel(portals, out);
    simplify(out, this.cell * 0.55);

    // Safety net: the funnel is a purely geometric shortcut and knows nothing
    // about the grid it came from. Any segment that does not survive a
    // walkability sweep is replaced by the corridor it skipped.
    this._repair(out, nodes);
    return out;
  }

  /**
   * Portals are the shared edges of the corridor, inset by the agent radius.
   * A diagonal step shares only a corner, which is a legal degenerate portal —
   * the funnel handles it without a special case.
   */
  _buildPortals(nodes, start, end) {
    const portals = [{ lx: start.x, lz: start.z, rx: start.x, rz: start.z, y: start.y }];

    for (let i = 0; i + 1 < nodes.length; i++) {
      const ca = this.nodeCell[nodes[i]], cb = this.nodeCell[nodes[i + 1]];
      const ax = ca % this.gw, az = (ca / this.gw) | 0;
      const bx = cb % this.gw, bz = (cb / this.gw) | 0;
      const dx = bx - ax, dz = bz - az;
      const y = this.nodeY[nodes[i + 1]];

      if (dx === 0 || dz === 0) {
        this._pushEdgePortal(portals, ax, az, dx, dz, y);
        continue;
      }

      // A diagonal step shares only a corner, and a point portal can never be
      // tightened — a corridor of them defeats the funnel entirely and the
      // "smoothed" path comes back as the raw staircase. Because diagonal links
      // are only created when both cardinal neighbours are open (the corner cut
      // test in `_link`), the move can always be decomposed into two cardinal
      // portals through one of them.
      const y0 = this.nodeY[nodes[i]];
      let mx = ax + dx, mz = az;
      let mid = this._nodeAt(mx, mz, y0);
      if (mid < 0) { mx = ax; mz = az + dz; mid = this._nodeAt(mx, mz, y0); }
      if (mid >= 0) {
        this._pushEdgePortal(portals, ax, az, mx - ax, mz - az, this.nodeY[mid]);
        this._pushEdgePortal(portals, mx, mz, bx - mx, bz - mz, y);
      } else {
        const cx = this.minX + (ax + 0.5 + dx * 0.5) * this.cell;
        const cz = this.minZ + (az + 0.5 + dz * 0.5) * this.cell;
        portals.push({ lx: cx, lz: cz, rx: cx, rz: cz, y });
      }
    }
    portals.push({ lx: end.x, lz: end.z, rx: end.x, rz: end.z, y: end.y });
    return portals;
  }

  /**
   * The shared edge between a cell and its cardinal neighbour, inset a little.
   *
   * Orientation matters and is easy to get backwards. `tri2` is the plain 2-D
   * cross product in (x, z); with y up that plane is left-handed on screen, so
   * the funnel's "left" vertex sits at (+uz, -ux) from the edge midpoint. Swap
   * these and the funnel never tightens.
   *
   * The mesh is already eroded by the agent radius, so the inset is only there
   * to keep the pull off exact corners — insetting by the radius again would
   * collapse every portal to a point.
   */
  _pushEdgePortal(portals, gx, gz, dx, dz, y) {
    const cs = this.cell;
    const hw = cs * 0.44;
    const mx = this.minX + (gx + 0.5 + dx * 0.5) * cs;
    const mz = this.minZ + (gz + 0.5 + dz * 0.5) * cs;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    portals.push({
      lx: mx + uz * hw, lz: mz - ux * hw,
      rx: mx - uz * hw, rz: mz + ux * hw,
      y,
    });
  }

  /** Simple stupid funnel (Mononen). Left/right must be CCW about the apex. */
  _funnel(portals, out) {
    let apexX = portals[0].lx, apexZ = portals[0].lz, apexY = portals[0].y;
    let leftX = apexX, leftZ = apexZ, rightX = apexX, rightZ = apexZ;
    let apexI = 0, leftI = 0, rightI = 0;
    out.push(new THREE.Vector3(apexX, apexY, apexZ));

    let guard = portals.length * 4 + 32;
    for (let i = 1; i < portals.length; i++) {
      if (guard-- <= 0) break;
      const p = portals[i];

      // Tighten the funnel on the right.
      if (tri2(apexX, apexZ, rightX, rightZ, p.rx, p.rz) <= 0) {
        if ((apexX === rightX && apexZ === rightZ)
            || tri2(apexX, apexZ, leftX, leftZ, p.rx, p.rz) > 0) {
          rightX = p.rx; rightZ = p.rz; rightI = i;
        } else {
          // Right crossed left: the left vertex is a corner of the path.
          out.push(new THREE.Vector3(leftX, portals[leftI].y, leftZ));
          apexX = leftX; apexZ = leftZ; apexY = portals[leftI].y; apexI = leftI;
          leftX = apexX; leftZ = apexZ; rightX = apexX; rightZ = apexZ;
          leftI = apexI; rightI = apexI;
          i = apexI;
          continue;
        }
      }
      // Tighten the funnel on the left.
      if (tri2(apexX, apexZ, leftX, leftZ, p.lx, p.lz) >= 0) {
        if ((apexX === leftX && apexZ === leftZ)
            || tri2(apexX, apexZ, rightX, rightZ, p.lx, p.lz) < 0) {
          leftX = p.lx; leftZ = p.lz; leftI = i;
        } else {
          out.push(new THREE.Vector3(rightX, portals[rightI].y, rightZ));
          apexX = rightX; apexZ = rightZ; apexY = portals[rightI].y; apexI = rightI;
          leftX = apexX; leftZ = apexZ; rightX = apexX; rightZ = apexZ;
          leftI = apexI; rightI = apexI;
          i = apexI;
          continue;
        }
      }
    }
    const last = portals[portals.length - 1];
    const tail = out[out.length - 1];
    if (!tail || Math.abs(tail.x - last.lx) > 1e-4 || Math.abs(tail.z - last.lz) > 1e-4) {
      out.push(new THREE.Vector3(last.lx, last.y, last.lz));
    }
    void apexY;
  }

  /** Replace any string-pulled segment that does not clear the grid. */
  _repair(points, nodes) {
    for (let i = 0; i + 1 < points.length; i++) {
      if (this.walkableLine(points[i], points[i + 1])) continue;
      // Splice in the corridor cells that lie between the two corners, ordered
      // along the segment they replace.
      const insert = [];
      const p = new THREE.Vector3();
      for (const nd of nodes) {
        this.nodePosition(nd, p);
        const t = projectT(points[i], points[i + 1], p);
        if (t > 0.02 && t < 0.98) insert.push({ t, p: p.clone() });
      }
      if (!insert.length) continue;
      insert.sort((m, n) => m.t - n.t);
      points.splice(i + 1, 0, ...insert.map((m) => m.p));
      i += insert.length;
    }
  }

  /** Can an agent walk the straight line a->b without leaving the mesh? */
  walkableLine(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    const steps = Math.ceil(dist / (this.cell * 0.8));
    if (steps <= 1) return true;
    // The ends of a path are the agent's real position and its goal, which are
    // routinely inside the eroded band (standing against a wall is legal, it is
    // only *pathing* through there that is not). Testing those samples would
    // reject almost every path, so the sweep only checks the interior.
    const skip = Math.max(1, Math.round(steps * 0.5 / Math.max(dist, 0.01)));
    let lastY = a.y;
    for (let i = skip; i < steps - skip + 1; i++) {
      const t = i / steps;
      _p.set(a.x + dx * t, lastY, a.z + dz * t);
      const n = this.nearest(_p, 0);
      if (n < 0) return false;
      if (Math.abs(this.nodeY[n] - lastY) > this.stepHeight) return false;
      lastY = this.nodeY[n];
    }
    return true;
  }

  /** A random reachable surface point, optionally near `origin`. */
  randomPoint(rand = Math.random, origin = null, radius = 0) {
    if (!this.ready) return null;
    for (let tries = 0; tries < 32; tries++) {
      const i = (rand() * this.nodeCount) | 0;
      if (this.nodeFlags[i] & 1) continue;
      if (this.nodeRegion[i] !== this.mainRegion) continue;
      this.nodePosition(i, _p);
      if (origin && radius > 0 && _p.distanceToSquared(origin) > radius * radius) continue;
      return _p.clone();
    }
    return null;
  }

  stats() {
    let usable = 0;
    for (let i = 0; i < this.nodeCount; i++) if (!(this.nodeFlags[i] & 1)) usable++;
    return {
      cells: this.gw * this.gd, surfaces: this.nodeCount, usable,
      regions: this.regionCount, buildMs: this.buildMs, cell: this.cell,
    };
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Drop corners that carry no information: points closer together than `tol`,
 * and points that sit within `tol` of the line between their neighbours. The
 * funnel leaves a few of these around portal seams and they make a bot stutter
 * as it ticks through waypoints it is already standing on.
 */
function simplify(points, tol) {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const next = points[i + 1];
    const p = points[i];
    if (p.distanceTo(prev) < tol) continue;
    const dx = next.x - prev.x, dz = next.z - prev.z;
    const l2 = dx * dx + dz * dz;
    if (l2 > 1e-8) {
      const t = ((p.x - prev.x) * dx + (p.z - prev.z) * dz) / l2;
      if (t > 0 && t < 1) {
        const ex = prev.x + dx * t - p.x, ez = prev.z + dz * t - p.z;
        if (ex * ex + ez * ez < tol * tol * 0.36) continue;
      }
    }
    out.push(p);
  }
  out.push(points[points.length - 1]);
  points.length = 0;
  for (const p of out) points.push(p);
  return points;
}

/** 2 x signed area of triangle (a,b,c) in the XZ plane. */
function tri2(ax, az, bx, bz, cx, cz) {
  return (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
}

function projectT(a, b, p) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  if (l2 < 1e-9) return 0;
  return ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2;
}

/** Binary min-heap over (key, value) pairs, backed by typed arrays. */
class Heap {
  constructor(capacity) {
    this.keys = new Float32Array(capacity);
    this.vals = new Int32Array(capacity);
    this.size = 0;
  }

  clear() { this.size = 0; }

  _grow() {
    const k = new Float32Array(this.keys.length * 2);
    const v = new Int32Array(this.vals.length * 2);
    k.set(this.keys); v.set(this.vals);
    this.keys = k; this.vals = v;
  }

  push(key, val) {
    if (this.size >= this.keys.length) this._grow();
    let i = this.size++;
    this.keys[i] = key; this.vals[i] = val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this._swap(p, i); i = p;
    }
  }

  pop() {
    const top = this.vals[0];
    this.size--;
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size];
      this.vals[0] = this.vals[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.size && this.keys[l] < this.keys[m]) m = l;
        if (r < this.size && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this._swap(m, i); i = m;
      }
    }
    return top;
  }

  _swap(a, b) {
    const k = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = k;
    const v = this.vals[a]; this.vals[a] = this.vals[b]; this.vals[b] = v;
  }
}

const _p = new THREE.Vector3();
const _ea = new Float64Array(3);
const _eb = new Float64Array(3);
const _e0 = new Float64Array(3);
const _eoff = new Float64Array(3);
