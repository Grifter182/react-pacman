import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

/**
 * OWNER: physics agent.
 *
 * Static-world collision built on a single merged BVH, plus the queries every
 * other system needs:
 *   - `raycast(origin, dir, maxDist)`      bullets, line of sight, decals
 *   - `capsuleResolve(pos, radius, half)`  character depenetration
 *   - `sphereCast(...)`                    grenades, ragdoll proxies
 *
 * LevelModule calls `build(meshes)` once the map geometry exists.
 */
export class CollisionModule {
  constructor() {
    this.bvh = null;
    this.collider = null;
    this._raycaster = new THREE.Raycaster();
    this._raycaster.firstHitOnly = true;
    this.dynamicBodies = [];
  }

  async init() {}

  /**
   * @param {THREE.Mesh} mergedMesh a single mesh whose geometry covers all
   *        static collision surfaces, in world space.
   */
  build(mergedMesh) {
    this.collider = mergedMesh;
    mergedMesh.geometry.computeBoundsTree({ maxLeafTris: 8 });
    this.bvh = mergedMesh.geometry.boundsTree;
  }

  /** @returns {{point:THREE.Vector3, normal:THREE.Vector3, distance:number, object:THREE.Object3D}|null} */
  raycast(origin, direction, maxDist = 1000, extraTargets = null) {
    if (!this.collider) return null;
    this._raycaster.set(origin, direction);
    this._raycaster.far = maxDist;
    const targets = extraTargets ? [this.collider, ...extraTargets] : [this.collider];
    const hits = this._raycaster.intersectObjects(targets, true);
    if (!hits.length) return null;
    const h = hits[0];
    const normal = h.face
      ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
      : direction.clone().negate();
    return { point: h.point, normal, distance: h.distance, object: h.object, face: h.face };
  }

  /**
   * Push a vertical capsule out of the static world.
   * @param {THREE.Vector3} position capsule centre (mutated in place)
   * @returns {{grounded:boolean, groundNormal:THREE.Vector3, hits:number}}
   */
  capsuleResolve(position, radius, halfHeight, iterations = 4) {
    const result = { grounded: false, groundNormal: new THREE.Vector3(0, 1, 0), hits: 0 };
    if (!this.bvh) return result;

    const segStart = _v1.set(position.x, position.y - halfHeight + radius, position.z);
    const segEnd = _v2.set(position.x, position.y + halfHeight - radius, position.z);
    const box = _box;

    for (let it = 0; it < iterations; it++) {
      box.makeEmpty();
      box.expandByPoint(segStart); box.expandByPoint(segEnd);
      box.min.addScalar(-radius); box.max.addScalar(radius);

      let moved = false;
      this.bvh.shapecast({
        intersectsBounds: (bounds) => bounds.intersectsBox(box),
        intersectsTriangle: (tri) => {
          const dist = tri.closestPointToSegment(_seg.set(segStart, segEnd), _triPoint, _capPoint);
          if (dist < radius) {
            const depth = radius - dist;
            const dir = _v3.subVectors(_capPoint, _triPoint);
            if (dir.lengthSq() < 1e-12) return;
            dir.normalize();
            segStart.addScaledVector(dir, depth);
            segEnd.addScaledVector(dir, depth);
            moved = true;
            result.hits++;
            if (dir.y > 0.5) {
              result.grounded = true;
              result.groundNormal.copy(dir);
            }
          }
        },
      });
      if (!moved) break;
    }

    position.set(segStart.x, segStart.y + halfHeight - radius, segStart.z);
    return result;
  }

  dispose() {
    this.collider?.geometry.disposeBoundsTree?.();
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _box = new THREE.Box3();
const _seg = new THREE.Line3();
const _triPoint = new THREE.Vector3();
const _capPoint = new THREE.Vector3();

export { MeshBVH };
