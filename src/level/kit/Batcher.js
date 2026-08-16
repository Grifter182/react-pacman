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

  /** Close every bucket into a mesh and parent it under `root`. */
  flush(root) {
    const meshes = [];
    for (const [id, b] of this._buckets) {
      if (b.vertexCount === 0) continue;
      const def = b._def;
      const mesh = new THREE.Mesh(b.toGeometry(def.weather), def.material);
      mesh.name = id;
      mesh.castShadow = def.castShadow;
      mesh.receiveShadow = def.receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      root.add(mesh);
      meshes.push(mesh);
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
   */
  define(name, geometry, material, opts = {}) {
    this.kinds.set(name, {
      geometry, material,
      xforms: [],
      castShadow: opts.castShadow !== false,
      receiveShadow: opts.receiveShadow !== false,
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

  flush(root) {
    const meshes = [];
    for (const [name, k] of this.kinds) {
      if (!k.xforms.length) { k.geometry.dispose(); continue; }
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
