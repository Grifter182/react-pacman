import * as THREE from 'three';
import { GeoBuilder } from './Geo.js';

/**
 * OWNER: level-art agent.
 *
 * Draw-call router for static level geometry.
 *
 * Two competing pressures decide how the map is batched. Merging everything
 * that shares a material into one buffer minimises draw calls — but a single
 * mesh spanning the whole compound is inside every shadow cascade frustum and
 * inside the camera frustum from everywhere, so all of its triangles are
 * resubmitted four or five times a frame no matter where the player is looking.
 *
 * So the router keys buckets on (material, spatial cell). Cell size is a
 * deliberate compromise: large enough that the bucket count stays around a
 * couple of dozen meshes, small enough that the near cascade and the view
 * frustum can reject most of the map. Pieces are routed by their origin, which
 * makes cell borders fuzzy — harmless, because culling uses each merged
 * bucket's real bounding box.
 */
export class Batcher {
  /**
   * @param {number} cell cell size in metres
   */
  constructor(cell = 34) {
    this.cell = cell;
    this._buckets = new Map();
    this._defs = new Map();
  }

  /**
   * Declare a surface bucket.
   * @param {string} key         bucket name used by `at()`
   * @param {THREE.Material} material
   * @param {object} [opts]
   * @param {number} [opts.uvScale] metres per texture tile
   * @param {boolean} [opts.weather] emit and use the aWeather attribute
   * @param {boolean} [opts.castShadow]
   * @param {boolean} [opts.receiveShadow]
   */
  define(key, material, opts = {}) {
    this._defs.set(key, {
      material,
      uvScale: opts.uvScale ?? 2,
      weather: opts.weather !== false,
      castShadow: opts.castShadow !== false,
      receiveShadow: opts.receiveShadow !== false,
      cells: opts.cells !== false,
    });
    return this;
  }

  /**
   * Fetch the builder for a bucket at a world position. Always call this with
   * the piece's own origin — routing by origin is what keeps a wall and its
   * trim in the same cell.
   */
  at(key, x = 0, z = 0) {
    const def = this._defs.get(key);
    if (!def) throw new Error(`[Batcher] undefined bucket "${key}"`);
    const cx = def.cells ? Math.floor(x / this.cell) : 0;
    const cz = def.cells ? Math.floor(z / this.cell) : 0;
    const id = `${key}#${cx},${cz}`;
    let b = this._buckets.get(id);
    if (!b) {
      b = new GeoBuilder({ uvScale: def.uvScale });
      b._def = def;
      b._key = key;
      this._buckets.set(id, b);
    }
    b.clearFrame();
    return b;
  }

  /**
   * Close every bucket into a mesh and parent it under `root`.
   *
   * COALESCING. Routing by origin into a fixed grid produces a long tail: on
   * this map 30 of the 116 meshes held under 350 triangles between them — six
   * triangles of gravel in one corner cell, eighteen of sand in another. Each
   * of those is a full state change in the main pass *and* one in every shadow
   * cascade the cell touches, so a 6-triangle mesh that casts costs five draw
   * calls and buys nothing: the whole point of the spatial split is that a
   * cascade can reject a *large* chunk of the map, and a chunk this small was
   * never going to be the difference.
   *
   * So a cell only survives as its own mesh if it is big enough to be worth
   * rejecting. Everything under the threshold is welded back into one
   * per-material remainder mesh, which is still frustum-culled by its own
   * bounding box — just a looser one.
   */
  flush(root, opts = {}) {
    const minCellTris = opts.minCellTris ?? 2600;

    // Group cells by bucket key so the remainder is per material, not global.
    const byKey = new Map();
    for (const [id, b] of this._buckets) {
      if (b.vertexCount === 0) continue;
      const key = b._key;
      let g = byKey.get(key);
      if (!g) byKey.set(key, g = []);
      g.push([id, b]);
    }

    const meshes = [];
    for (const [key, cells] of byKey) {
      const def = cells[0][1]._def;
      const keep = [];
      let rest = null, restIds = 0;
      for (const [id, b] of cells) {
        // A lone cell is already the whole material; splitting it off into a
        // "remainder" would just rename it.
        if (cells.length === 1 || b.triangleCount >= minCellTris) { keep.push([id, b]); continue; }
        if (!rest) { rest = b; restIds = 1; continue; }
        rest.concat(b);
        restIds++;
      }
      if (rest) keep.push([restIds > 1 ? `${key}#rest*${restIds}` : `${key}#rest`, rest]);

      for (const [id, b] of keep) {
        const mesh = new THREE.Mesh(b.toGeometry(def.weather), def.material);
        mesh.name = id;
        mesh.castShadow = def.castShadow;
        mesh.receiveShadow = def.receiveShadow;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        root.add(mesh);
        meshes.push(mesh);
      }
    }
    this._buckets.clear();
    return meshes;
  }

  stats() {
    let tris = 0, buckets = 0;
    for (const b of this._buckets.values()) {
      if (!b.vertexCount) continue;
      buckets++;
      tris += b.triangleCount;
    }
    return { buckets, tris };
  }
}

/**
 * Instanced prop pool. One prototype geometry, one draw call, N placements.
 * Prototypes are authored at the origin by the same GeoBuilder the static kit
 * uses, so an instanced barrel and a merged barrel are the same asset.
 */
export class InstancePool {
  constructor() {
    this.kinds = new Map();
  }

  /**
   * @param {string} name
   * @param {THREE.BufferGeometry} geometry prototype, authored around origin
   * @param {THREE.Material} material
   * @param {object} [opts]
   * @param {string} [opts.mergeTo] batcher bucket to weld this kind into
   *        instead of realising an InstancedMesh — see `flush`.
   */
  define(name, geometry, material, opts = {}) {
    this.kinds.set(name, {
      geometry, material,
      xforms: [],
      castShadow: opts.castShadow !== false,
      receiveShadow: opts.receiveShadow !== false,
      mergeTo: opts.mergeTo || null,
    });
    return this;
  }

  /** Queue one placement. */
  add(name, x, y, z, ry = 0, scale = 1, rx = 0, rz = 0) {
    const k = this.kinds.get(name);
    if (!k) throw new Error(`[InstancePool] undefined kind "${name}"`);
    const m = new THREE.Matrix4();
    _e.set(rx, ry, rz, 'YXZ');
    _q.setFromEuler(_e);
    _s.set(scale, scale, scale);
    m.compose(_v.set(x, y, z), _q, _s);
    k.xforms.push(m);
    return this;
  }

  count(name) { return this.kinds.get(name)?.xforms.length ?? 0; }

  /**
   * Realise the pool.
   *
   * INSTANCING IS NOT FREE, and round 2 proved it the expensive way. An
   * InstancedMesh is one draw call *per pass* — main plus every shadow pass it
   * lands in. Under VSM a mesh enters the shadow passes if it casts OR
   * receives (see `LevelModule._budget`), so an ordinary prop kind costs five
   * draw calls, not one. Sixteen kinds therefore cost 80 draw calls before a
   * single triangle is considered, and half of those kinds had fewer than 25
   * placements of a 150-triangle prototype. Five pipe bundles across a
   * 3,700 m² compound is 2,700 triangles: welding them into the `metal` bucket
   * that already exists costs nothing at all in triangles or in culling
   * granularity, and removes five draw calls.
   *
   * So a kind is instanced when the placement count is high enough that the
   * duplicated vertex data would actually matter, and merged when it is not.
   * A kind flagged `castShadow: false, receiveShadow: false` costs ONE draw
   * call, which is why the rooftop kinds are instanced at any count.
   * `mergeTo` names the bucket; `batcher` must be supplied and must still be
   * open (call this before `Batcher.flush`).
   */
  flush(root, batcher = null) {
    const meshes = [];
    for (const [name, k] of this.kinds) {
      if (!k.xforms.length) { k.geometry.dispose(); continue; }
      if (k.mergeTo && batcher) {
        for (const m of k.xforms) {
          batcher.at(k.mergeTo, m.elements[12], m.elements[14]).identity().absorb(k.geometry, m);
        }
        k.geometry.dispose();
        continue;
      }
      const im = new THREE.InstancedMesh(k.geometry, k.material, k.xforms.length);
      im.name = `inst:${name}`;
      for (let i = 0; i < k.xforms.length; i++) im.setMatrixAt(i, k.xforms[i]);
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = k.castShadow;
      im.receiveShadow = k.receiveShadow;
      im.frustumCulled = true;
      im.computeBoundingSphere();
      root.add(im);
      meshes.push(im);
    }
    return meshes;
  }
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
