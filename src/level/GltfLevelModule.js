import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { computeBoundsTree } from 'three-mesh-bvh';
import { NavMesh } from '../ai/NavMesh.js';
import { Config } from '../core/Config.js';
import { ProxySet } from './kit/Geo.js';

/**
 * A level loaded from a glTF file, satisfying the same contract LevelModule
 * does so that nothing downstream knows the difference.
 *
 * ============================================================================
 * FOUR THINGS AN IMPORTED SCENE DOES NOT COME WITH
 * ============================================================================
 *
 * 1. A DRAW-CALL BUDGET. The forest arrives as 1,480 unique primitives across
 *    2,878 nodes, none of them instanced — that is 1,480 draw calls against the
 *    procedural level's 118. They share only three materials, so baking the node
 *    transforms into the vertices and merging by material collapses it to three.
 *    This is not an optimisation, it is the difference between playable and not.
 *
 * 2. COLLISION. The scene is one soup of visual triangles, 139,612 of which are
 *    leaf cards. Colliding against those would put the whole canopy in the BVH
 *    and let the player walk into leaves. Instead the terrain collides as
 *    itself, and the trees collide as trunk proxies placed at the positions the
 *    canopy primitives cluster onto — 511 of them, a few thousand triangles
 *    total, and a trunk you can take cover behind rather than a bush you bounce
 *    off.
 *
 * 3. SCALE. Nothing in a glTF states what a unit means. Worse, the file's own
 *    accessor bounds read 200 x 200 x 392 while the scene actually measures
 *    19.2 x 2.9 x 9.8 once the node hierarchy is walked, so trusting the
 *    bounding box gives an answer twenty times wrong. The factor lives in
 *    MapRegistry with its reasoning written down.
 *
 * 4. SPAWNS. There are no spawn entities, and `pickSpawn` is called by
 *    PlayerModule during init — which runs BEFORE AiModule builds its navmesh,
 *    so the AI's copy cannot be borrowed. A local NavMesh is built here and the
 *    spawns are the two ends of the longest walkable axis, which is the road.
 *
 * The project's own surface shader is deliberately NOT used: it requires a
 * per-vertex `aWeather` attribute (see kit/Weathering.js) that imported geometry
 * has no way of carrying. Imported maps render on plain MeshStandardMaterial.
 */
export class GltfLevelModule {
  constructor(def) {
    this.def = def;
    this.root = new THREE.Group();
    this.root.name = `Level:${def.id}`;
    this.collider = null;
    this.bounds = new THREE.Box3();
    this.navPoints = [];
    this.spawnPoints = [];
    this.stats = {};
  }

  async init(engine) {
    const t0 = performance.now();
    engine.scene.add(this.root);

    const gltf = await new GLTFLoader().loadAsync(this.def.path);
    const scale = this.def.scale ?? 1;

    /* --- 1. flatten and merge by material -------------------------------- */
    const byMaterial = new Map();
    const trunkSpots = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const key = mat?.name || 'unnamed';
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      // Merging demands identical attribute sets; UV2/colour appear on some
      // primitives and not others, and a mismatch throws rather than warns.
      for (const name of Object.keys(g.attributes)) {
        if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      }
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) {
        g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      }
      if (!byMaterial.has(key)) byMaterial.set(key, { mat, geoms: [] });
      byMaterial.get(key).geoms.push(g);

      if (key !== this.def.groundMaterial) {
        const c = new THREE.Vector3();
        g.computeBoundingBox();
        g.boundingBox.getCenter(c);
        trunkSpots.push(c);
      }
    });

    let drawn = 0, tris = 0;
    const groundGeoms = [];
    for (const [name, { mat, geoms }] of byMaterial) {
      const merged = BufferGeometryUtils.mergeGeometries(geoms, false);
      if (!merged) { console.warn(`[Level] could not merge "${name}" (${geoms.length} parts)`); continue; }
      merged.scale(scale, scale, scale);
      for (const g of geoms) g.dispose();
      const material = this._material(mat);
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `gltf:${name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
      drawn++;
      tris += merged.index ? merged.index.count / 3 : merged.attributes.position.count / 3;
      if (name === this.def.groundMaterial) groundGeoms.push(merged);
    }

    this.bounds.setFromObject(this.root);

    /* --- 2. collision: terrain as itself, trees as trunks ----------------- */
    const proxy = new ProxySet();
    const r = (this.def.trunkRadius ?? 0.06) * scale;
    const h = (this.def.trunkHeight ?? 2.5) * scale;
    // Cluster the canopy centres so a tree made of nine leaf cards yields one
    // trunk rather than nine overlapping boxes.
    const cell = r * 4;
    const seen = new Set();
    let trunks = 0;
    for (const p of trunkSpots) {
      const wx = p.x * scale, wz = p.z * scale;
      const k = `${Math.round(wx / cell)},${Math.round(wz / cell)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      proxy.box(wx, this.bounds.min.y + h / 2, wz, r * 2, h, r * 2);
      trunks++;
    }
    const trunkMesh = proxy.toMesh();
    const collisionGeoms = [...groundGeoms.map((g) => g.clone())];
    if (trunkMesh.geometry.attributes.position.count) collisionGeoms.push(trunkMesh.geometry);
    // A merge needs matching attributes; collision only ever reads position.
    const stripped = collisionGeoms.map((g) => {
      const s = new THREE.BufferGeometry();
      s.setAttribute('position', g.index
        ? new THREE.BufferAttribute(new Float32Array(unindex(g)), 3)
        : g.attributes.position.clone());
      return s;
    });
    const colGeo = stripped.length > 1 ? BufferGeometryUtils.mergeGeometries(stripped, false) : stripped[0];
    colGeo.computeBoundingSphere();
    // CollisionModule reads geometry.boundsTree; three-mesh-bvh is not patched
    // onto BufferGeometry.prototype here, so build it explicitly.
    colGeo.boundsTree = computeBoundsTree.call(colGeo);
    const collider = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial({ visible: false }));
    collider.name = 'LevelCollision';
    collider.matrixAutoUpdate = false;
    collider.updateMatrix();
    this.collider = collider;
    engine.get('collision').build(collider);

    /* --- 3. spawns, from a navmesh built here ---------------------------- */
    this._deriveSpawns();

    this.stats = { meshes: drawn, triangles: Math.round(tris), trunks, collisionTris: Math.round(colGeo.attributes.position.count / 3) };
    console.info(`[Level] ${this.def.name}: ${drawn} draws, ${Math.round(tris / 1000)}k tris, `
      + `${trunks} trunk proxies, ${this.stats.collisionTris} collision tris, `
      + `${(performance.now() - t0).toFixed(0)}ms`);
    if (this.def.credit) console.info(`[Level] ${this.def.credit}`);
  }

  /** Imported PBR, without the project's weathering shader. */
  _material(src) {
    const m = new THREE.MeshStandardMaterial({
      map: src?.map ?? null,
      normalMap: src?.normalMap ?? null,
      color: src?.color ? src.color.clone() : new THREE.Color(0xffffff),
      roughness: src?.roughness ?? 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
      transparent: !!src?.transparent,
      alphaTest: src?.alphaTest || (src?.transparent ? 0.35 : 0),
    });
    if (m.map) {
      m.map.colorSpace = THREE.SRGBColorSpace;
      m.map.anisotropy = 8;
    }
    return m;
  }

  /**
   * Two spawns at opposite ends of the longest walkable run.
   *
   * A forest has no authored spawn entities, and picking the bounding box's
   * corners would drop players into the trees outside the terrain. The navmesh
   * knows which cells are actually standable, so the spawns are the extremes of
   * its own walkable set — which on a map built around one road puts the teams
   * at opposite ends of that road.
   */
  _deriveSpawns() {
    const nav = new NavMesh({
      cell: 0.52,
      agentRadius: (Config.player.radius ?? 0.34) + 0.08,
      agentHeight: 1.72,
      stepHeight: Config.player.stepHeight,
      maxSlopeDeg: Config.player.maxSlopeDeg + 2,
    });
    nav.build(this.collider.geometry, this.bounds);
    const pts = [];
    if (nav.ready) {
      const { gw, gd, cell, minX, minZ, cellFirst, cellCount, nodeY, nodeFlags, nodeRegion, mainRegion } = nav;
      for (let c = 0; c < gw * gd; c++) {
        const first = cellFirst[c], n = cellCount[c];
        if (first < 0 || !n) continue;
        let lo = Infinity, node = -1;
        for (let k = 0; k < n; k++) { const nd = first + k; if (nodeY[nd] < lo) { lo = nodeY[nd]; node = nd; } }
        if (node < 0 || (nodeFlags[node] & 1) !== 0) continue;
        if (nodeRegion[node] !== mainRegion) continue;   // islands are not spawns
        const x = c % gw, z = (c - x) / gw;
        pts.push(new THREE.Vector3(minX + x * cell, nodeY[node] + 0.1, minZ + z * cell));
      }
    }
    if (pts.length < 2) {
      const c = this.bounds.getCenter(new THREE.Vector3());
      this.spawnPoints = [
        { team: 0, position: c.clone(), yaw: 0 },
        { team: 1, position: c.clone(), yaw: Math.PI },
      ];
      console.warn('[Level] navmesh produced no walkable spawn candidates; using the centre');
      return;
    }
    // Longest separation, sampled rather than brute-forced over every pair.
    let a = pts[0], b = pts[0], best = -1;
    const step = Math.max(1, Math.floor(pts.length / 400));
    for (let i = 0; i < pts.length; i += step) {
      for (let j = i + step; j < pts.length; j += step) {
        const d = pts[i].distanceToSquared(pts[j]);
        if (d > best) { best = d; a = pts[i]; b = pts[j]; }
      }
    }
    const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
    const near = (p, n) => pts.filter((q) => q.distanceToSquared(p) < 12 * 12).slice(0, n);
    this.spawnPoints = [
      ...near(a, 6).map((position) => ({ team: 0, position, yaw })),
      ...near(b, 6).map((position) => ({ team: 1, position, yaw: yaw + Math.PI })),
    ];
    this.navPoints = [a.clone(), b.clone(), a.clone().lerp(b, 0.5)];
    console.info(`[Level] spawns derived from ${pts.length} walkable cells, `
      + `${Math.sqrt(best).toFixed(0)} m apart`);
  }

  /** Same contract as LevelModule.pickSpawn. */
  pickSpawn(team = 0, avoid = []) {
    const pool = this.spawnPoints.filter((s) => s.team === team);
    if (!pool.length) return { position: new THREE.Vector3(0, 1, 0), yaw: 0 };
    let best = pool[0], bestScore = -Infinity;
    for (const s of pool) {
      let score = Math.random() * 4;
      for (const a of avoid) score += s.position.distanceTo(a) * 0.1;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
    });
  }
}

/** Expand an indexed geometry's positions into a flat triangle soup. */
function unindex(g) {
  const pos = g.attributes.position, idx = g.index;
  const out = new Float32Array(idx.count * 3);
  for (let i = 0; i < idx.count; i++) {
    const v = idx.getX(i);
    out[i * 3] = pos.getX(v); out[i * 3 + 1] = pos.getY(v); out[i * 3 + 2] = pos.getZ(v);
  }
  return out;
}
