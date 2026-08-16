import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeMaterial } from '../materials/TextureFactory.js';

/**
 * OWNER: level-art agent.
 *
 * Builds the playable map: geometry, props, trim, decals, and the merged
 * collision mesh handed to CollisionModule. Also owns `spawnPoints`, which
 * MatchModule and AiModule read.
 *
 * Baseline is a symmetrical three-lane courtyard — replace with authored
 * blockout + detail passes, but keep these exports stable:
 *   this.spawnPoints : Array<{position:THREE.Vector3, yaw:number, team:number}>
 *   this.bounds      : THREE.Box3
 */
export class LevelModule {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'Level';
    this.spawnPoints = [];
    this.bounds = new THREE.Box3();
    this._collisionGeos = [];
  }

  async init(engine) {
    engine.scene.add(this.root);
    this.materials = {
      ground: makeMaterial('sand', { repeat: 42, seed: 11, size: 512 }),
      wall: makeMaterial('concrete', { repeat: 5, seed: 23, size: 512 }),
      trim: makeMaterial('plaster', { repeat: 3, seed: 41, size: 512 }),
      metal: makeMaterial('metal', { repeat: 3, seed: 59, size: 512 }),
    };

    this._buildGround();
    this._buildArena();
    this._finalise(engine);

    engine.level = this;
  }

  _add(geo, material, transform, collide = true) {
    const mesh = new THREE.Mesh(geo, material);
    if (transform) transform(mesh);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.updateMatrixWorld(true);
    this.root.add(mesh);
    if (collide) {
      const g = geo.clone();
      g.applyMatrix4(mesh.matrixWorld);
      this._collisionGeos.push(g.index ? g.toNonIndexed() : g);
    }
    return mesh;
  }

  _buildGround() {
    const g = new THREE.PlaneGeometry(200, 200, 1, 1);
    g.rotateX(-Math.PI / 2);
    const mesh = this._add(g, this.materials.ground, (m) => { m.position.y = 0; m.castShadow = false; });
    mesh.name = 'Ground';
  }

  _buildArena() {
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const wall = this.materials.wall;

    // Perimeter
    const R = 46, H = 9, T = 1.2;
    this._add(box(R * 2, H, T), wall, (m) => m.position.set(0, H / 2, -R));
    this._add(box(R * 2, H, T), wall, (m) => m.position.set(0, H / 2, R));
    this._add(box(T, H, R * 2), wall, (m) => m.position.set(-R, H / 2, 0));
    this._add(box(T, H, R * 2), wall, (m) => m.position.set(R, H / 2, 0));

    // Central structure
    this._add(box(14, 6, 14), wall, (m) => m.position.set(0, 3, 0));
    this._add(box(16, 0.6, 16), this.materials.trim, (m) => m.position.set(0, 6.3, 0));

    // Lane cover — mirrored so the map plays fair from both spawns
    const covers = [
      [-24, 0, -14, 6, 3, 1.0], [24, 0, -14, 6, 3, 1.0],
      [-24, 0, 14, 6, 3, 1.0], [24, 0, 14, 6, 3, 1.0],
      [-12, 0, -28, 1.0, 3.4, 8], [12, 0, -28, 1.0, 3.4, 8],
      [-12, 0, 28, 1.0, 3.4, 8], [12, 0, 28, 1.0, 3.4, 8],
      [-33, 0, 0, 5, 4.2, 1.0], [33, 0, 0, 5, 4.2, 1.0],
    ];
    for (const [x, , z, w, h, d] of covers) {
      this._add(box(w, h, d), wall, (m) => m.position.set(x, h / 2, z));
    }

    // Crates
    const crate = this.materials.metal;
    const crates = [
      [-8, -20, 1.4], [8, -20, 1.4], [-8, 20, 1.4], [8, 20, 1.4],
      [-20, -4, 1.2], [20, 4, 1.2], [-30, 22, 1.6], [30, -22, 1.6],
      [0, -32, 1.5], [0, 32, 1.5],
    ];
    for (const [x, z, s] of crates) {
      this._add(box(s, s, s), crate, (m) => {
        m.position.set(x, s / 2, z);
        m.rotation.y = (x * 0.37 + z * 0.11) % Math.PI;
      });
    }

    // Spawns: two opposed sets, facing the centre.
    for (let i = 0; i < 6; i++) {
      const t = (i / 5 - 0.5) * 24;
      this.spawnPoints.push({ position: new THREE.Vector3(t, 0.1, -40), yaw: 0, team: 0 });
      this.spawnPoints.push({ position: new THREE.Vector3(t, 0.1, 40), yaw: Math.PI, team: 1 });
    }
  }

  _finalise(engine) {
    const merged = BufferGeometryUtils.mergeGeometries(
      this._collisionGeos.map((g) => {
        const out = new THREE.BufferGeometry();
        out.setAttribute('position', g.getAttribute('position'));
        return out;
      }), false
    );
    const collider = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ visible: false }));
    collider.name = 'Collider';
    collider.matrixAutoUpdate = false;
    engine.get('collision').build(collider);

    this.bounds.setFromObject(this.root);
    this._collisionGeos.length = 0;
  }

  /** Random spawn for a team, biased away from `avoid` positions. */
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
    this.root.traverse((o) => { o.geometry?.dispose?.(); });
  }
}
