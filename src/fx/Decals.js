import * as THREE from 'three';
import { ATLAS_COLS } from './FxTextures.js';

/**
 * OWNER: VFX agent.
 *
 * Projected impact decals: bullet holes, scorch marks, blood.
 *
 * These are surface-aligned, not camera-facing. Each decal is an oriented quad
 * whose +Z is the surface normal, rolled by a random angle so ten hits on the
 * same wall are ten different holes, and lit by a real `MeshStandardMaterial`
 * with the crater's tangent-space normal map — so a hole in a wall catches the
 * sun on its upper lip and shadows its lower one, and goes dark when the wall
 * goes into shadow. A camera-facing sprite cannot do any of that.
 *
 * FITTING THE DECAL TO THE SURFACE
 * --------------------------------
 * A quad pasted at a hit point that lands near a corner floats in mid air over
 * the edge. Four short probe rays are cast back at the surface from the corners
 * of the proposed footprint; if the surface does not continue under enough of
 * them the decal is shrunk until it does. That is the cheapest available
 * approximation of a projected volume decal on a BVH-only world.
 *
 * Storage is a ring buffer of exactly `Config.gfx.decalBudget` instances in one
 * draw call. Age lives in an instance attribute and the fade is evaluated in the
 * vertex shader, so an idle decal field costs nothing per frame on the CPU.
 */
export class DecalField {
  /**
   * @param {number} budget
   * @param {THREE.Texture} albedo atlas (RGB + coverage)
   * @param {THREE.Texture} normal atlas (tangent space)
   */
  constructor(budget, albedo, normal) {
    this.budget = Math.max(8, budget | 0);
    this.index = 0;
    this.time = 0;

    const geo = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshStandardMaterial({
      map: albedo,
      normalMap: normal,
      normalScale: new THREE.Vector2(1.35, 1.35),
      roughness: 0.86,
      metalness: 0.0,
      transparent: true,
      depthWrite: false,
      // Coplanar with the wall it sits on: the normal offset alone is not
      // enough at grazing angles, and pushing it further out makes the decal
      // visibly float when seen from the side.
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -12,
      side: THREE.FrontSide,
    });
    material.name = 'FxDecals';

    this.uniforms = { uTime: { value: 0 } };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.vertexShader = `
        attribute vec2 aTile;
        attribute vec2 aLife;
        uniform float uTime;
        varying float vFade;
      ` + shader.vertexShader.replace('#include <uv_vertex>', /* glsl */`
        vec2 fxUv = ( uv + aTile ) / ${ATLAS_COLS.toFixed(1)};
        #ifdef USE_MAP
          vMapUv = fxUv;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv = fxUv;
        #endif
        float fxAge = uTime - aLife.x;
        float fxU = clamp( fxAge * aLife.y, 0.0, 1.0 );
        // Hold, then fade: a bullet hole does not start disappearing the
        // instant it is made, it weathers out at the end of its life.
        vFade = 1.0 - smoothstep( 0.70, 1.0, fxU );
      `);
      shader.fragmentShader = 'varying float vFade;\n' + shader.fragmentShader
        .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\n\tdiffuseColor.a *= vFade;');
    };
    // Materials with an onBeforeCompile need a stable cache key or three will
    // reuse a program compiled without the patch.
    material.customProgramCacheKey = () => 'fx-decal-v1';

    this.mesh = new THREE.InstancedMesh(geo, material, this.budget);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 4;
    this.mesh.name = 'FxDecals';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.userData.noPrepass = true;

    const tiles = new Float32Array(this.budget * 2);
    const life = new Float32Array(this.budget * 2);
    this.aTile = new THREE.InstancedBufferAttribute(tiles, 2);
    this.aLife = new THREE.InstancedBufferAttribute(life, 2);
    this.aTile.setUsage(THREE.DynamicDrawUsage);
    this.aLife.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTile', this.aTile);
    geo.setAttribute('aLife', this.aLife);

    // Everything starts collapsed; a zero-scale instance rasterises nothing.
    _m4.makeScale(0, 0, 0);
    for (let i = 0; i < this.budget; i++) {
      this.mesh.setMatrixAt(i, _m4);
      this.mesh.setColorAt(i, _white);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * @param {object} o
   * @param {THREE.Vector3} o.point   world hit point
   * @param {THREE.Vector3} o.normal  surface normal
   * @param {number} o.tile           decal atlas tile index
   * @param {number} o.size           footprint in metres
   * @param {THREE.Color} [o.tint]
   * @param {number} [o.life]         seconds before it has faded out entirely
   * @param {object} [collision]      CollisionModule, for the fit probes
   */
  place({ point, normal, tile, size, tint = null, life = 60 }, collision = null) {
    let s = size;

    // --- orientation: +Z along the normal, random roll about it -------------
    _q.setFromUnitVectors(_zAxis, _n.copy(normal).normalize());
    _q2.setFromAxisAngle(_zAxis, Math.random() * Math.PI * 2);
    _q.multiply(_q2);

    if (collision && collision.collider) {
      _t.set(1, 0, 0).applyQuaternion(_q);
      _b.set(0, 1, 0).applyQuaternion(_q);
      const half = s * 0.42;
      let solid = 0;
      for (let i = 0; i < 4; i++) {
        const sx = (i & 1) ? half : -half;
        const sy = (i & 2) ? half : -half;
        _p.copy(point).addScaledVector(_t, sx).addScaledVector(_b, sy).addScaledVector(_n, 0.08);
        const hit = collision.raycast(_p, _nn.copy(_n).negate(), 0.16);
        // A hit that is not roughly coplanar (a floor meeting a wall) does not
        // count as continuous surface.
        if (hit && hit.normal.dot(_n) > 0.72) solid++;
      }
      if (solid < 4) s *= solid >= 2 ? 0.62 : 0.34;
    }

    const i = this.index;
    this.index = (this.index + 1) % this.budget;

    _p.copy(point).addScaledVector(_n, 0.010);
    _m4.compose(_p, _q, _scale.set(s, s, 1));
    this.mesh.setMatrixAt(i, _m4);
    this.mesh.setColorAt(i, tint || _white);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this.aTile.array[i * 2] = tile % ATLAS_COLS;
    this.aTile.array[i * 2 + 1] = Math.floor(tile / ATLAS_COLS);
    this.aLife.array[i * 2] = this.time;
    this.aLife.array[i * 2 + 1] = 1 / Math.max(life, 0.1);
    this.aTile.needsUpdate = true;
    this.aLife.needsUpdate = true;
  }

  update(dt, engine) {
    this.time = engine.elapsed;
    this.uniforms.uTime.value = this.time;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nn = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _white = new THREE.Color(1, 1, 1);
