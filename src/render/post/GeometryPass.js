import * as THREE from 'three';
import { createRT } from './PassCore.js';

/**
 * OWNER: rendering / post-processing agent.
 *
 * Depth + view-normal + material + motion-vector prepass.
 *
 * Everything downstream that needs geometry (GTAO, SSR, TAA, motion blur, DOF)
 * reads this one buffer, so it is rendered exactly once per frame with a scene
 * override material:
 *
 *   MRT0 (RGBA16F)  rg = octahedral view-space normal
 *                    b = roughness      a = metalness
 *   MRT1 (RGBA16F)  rg = motion vector in UV space (curr - prev)
 *   depth (D32F)    sampled by everything
 *
 * Two details make this work with `scene.overrideMaterial`, which normally
 * cannot vary per object:
 *
 *  1. `Material.onBeforeRender` fires per draw call, before the uniform upload,
 *     so the previous-frame model matrix and the *real* material's roughness /
 *     metalness are pushed there. `uniformsNeedUpdate` forces three to actually
 *     re-send them (it otherwise uploads shader uniforms once per material).
 *  2. Transparent and non-triangle objects are hidden for the duration of the
 *     pass. Tracers, decals and sprites must not write depth or normals — they
 *     would punch holes in AO and reflections.
 *
 * Motion vectors are computed analytically from the *unjittered* view-projection
 * matrices so TAA's own sub-pixel jitter never leaks into the velocity field.
 * Per-object previous world matrices are tracked in a WeakMap, which means
 * moving props and actors get correct velocity, not just camera motion.
 */
export class GeometryPass {
  constructor() {
    this.target = null;
    this.depthTexture = null;
    this.material = null;

    this._prevMatrices = new WeakMap();
    this._hidden = [];
    this._scratch = new THREE.Matrix4();

    this.prevViewProj = new THREE.Matrix4();
    this.currViewProj = new THREE.Matrix4();
    this._viewProjScratch = new THREE.Matrix4();
    this._hasPrev = false;
  }

  init() {
    this.material = new THREE.ShaderMaterial({
      name: 'GBufferPrepass',
      glslVersion: THREE.GLSL3,
      uniforms: {
        uPrevModelMatrix: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uCurrViewProj: { value: new THREE.Matrix4() },
        uRoughness: { value: 0.6 },
        uMetalness: { value: 0.0 },
      },
      vertexShader: /* glsl */`
        #include <common>
        #include <batching_pars_vertex>
        #include <skinning_pars_vertex>

        uniform mat4 uPrevModelMatrix;
        uniform mat4 uPrevViewProj;
        uniform mat4 uCurrViewProj;

        out vec3 vViewNormal;
        out vec4 vCurrClip;
        out vec4 vPrevClip;

        void main(){
          #include <batching_vertex>
          #include <beginnormal_vertex>
          #include <skinbase_vertex>
          #include <skinnormal_vertex>
          #include <defaultnormal_vertex>
          vViewNormal = transformedNormal;

          #include <begin_vertex>
          #include <skinning_vertex>
          #include <project_vertex>

          // Replicate <project_vertex>'s object-space transform stack so the
          // world position used for velocity matches the rasterised position.
          vec4 objPos = vec4(transformed, 1.0);
          #ifdef USE_BATCHING
            objPos = batchingMatrix * objPos;
          #endif
          #ifdef USE_INSTANCING
            objPos = instanceMatrix * objPos;
          #endif
          vCurrClip = uCurrViewProj * (modelMatrix * objPos);
          vPrevClip = uPrevViewProj * (uPrevModelMatrix * objPos);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uRoughness;
        uniform float uMetalness;

        in vec3 vViewNormal;
        in vec4 vCurrClip;
        in vec4 vPrevClip;

        layout(location = 0) out vec4 gNormal;
        layout(location = 1) out vec4 gVelocity;

        vec2 signNotZero(vec2 v){
          return vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
        }
        vec2 octEncode(vec3 n){
          n /= (abs(n.x) + abs(n.y) + abs(n.z) + 1e-8);
          return (n.z < 0.0) ? ((1.0 - abs(n.yx)) * signNotZero(n.xy)) : n.xy;
        }

        void main(){
          vec3 n = normalize(vViewNormal);
          // Back-facing triangles (double-sided trim, foliage cards) would
          // otherwise report a normal pointing away from the camera and make
          // AO self-occlude the surface it belongs to.
          if (!gl_FrontFacing) n = -n;
          gNormal = vec4(octEncode(n), uRoughness, uMetalness);

          vec2 vel = vec2(0.0);
          if (vCurrClip.w > 1e-6 && vPrevClip.w > 1e-6) {
            vec2 curr = vCurrClip.xy / vCurrClip.w;
            vec2 prev = vPrevClip.xy / vPrevClip.w;
            vel = (curr - prev) * 0.5;   // NDC delta -> UV delta
          }
          gVelocity = vec4(vel, 0.0, 1.0);
        }
      `,
      side: THREE.FrontSide,
    });

    const uniforms = this.material.uniforms;
    const prevMap = this._prevMatrices;
    const material = this.material;

    // Per-draw-call uniform injection. See the class comment.
    this.material.onBeforeRender = function (renderer, scene, camera, geometry, object) {
      let entry = prevMap.get(object);
      if (entry === undefined) {
        entry = new THREE.Matrix4().copy(object.matrixWorld);
        prevMap.set(object, entry);
      }
      uniforms.uPrevModelMatrix.value.copy(entry);
      entry.copy(object.matrixWorld);

      const src = object.material;
      const real = Array.isArray(src) ? src[0] : src;
      // Only the scalar factors are available here — texture-driven roughness
      // is not sampled. That is enough for SSR gating and cheap enough to be
      // free; a full G-buffer would mean re-authoring every material.
      uniforms.uRoughness.value = (real && real.roughness !== undefined) ? real.roughness : 0.85;
      uniforms.uMetalness.value = (real && real.metalness !== undefined) ? real.metalness : 0.0;
      material.uniformsNeedUpdate = true;
    };
  }

  resize(w, h) {
    this.dispose();
    this.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    this.depthTexture.format = THREE.DepthFormat;
    this.depthTexture.minFilter = THREE.NearestFilter;
    this.depthTexture.magFilter = THREE.NearestFilter;
    this.depthTexture.generateMipmaps = false;
    this.target = createRT(w, h, {
      count: 2,
      filter: THREE.NearestFilter,
      depthBuffer: true,
      name: 'gbuffer',
    });
    this.target.depthTexture = this.depthTexture;
  }

  get normalTexture() { return this.target ? this.target.textures[0] : null; }
  get velocityTexture() { return this.target ? this.target.textures[1] : null; }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {import('../../core/Engine.js').Engine} engine
   * @param {THREE.Matrix4} unjitteredViewProj view-projection WITHOUT TAA jitter
   */
  render(renderer, engine, unjitteredViewProj) {
    if (!this.target) return;
    const scene = engine.scene;
    const camera = engine.camera;

    this.currViewProj.copy(unjitteredViewProj);
    if (!this._hasPrev) { this.prevViewProj.copy(this.currViewProj); this._hasPrev = true; }
    this.material.uniforms.uCurrViewProj.value.copy(this.currViewProj);
    this.material.uniforms.uPrevViewProj.value.copy(this.prevViewProj);

    // --- hide everything that must not contribute to the G-buffer -----------
    const hidden = this._hidden;
    hidden.length = 0;
    scene.traverseVisible((o) => {
      if (o.isMesh !== true) {
        if (o.isPoints === true || o.isSprite === true || o.isLine === true) {
          o.visible = false; hidden.push(o);
        }
        return;
      }
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m || m.transparent === true || m.wireframe === true || o.userData.noPrepass === true) {
        o.visible = false; hidden.push(o);
      }
    });

    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    // The background box would be drawn with the override material and stamp a
    // bogus depth over the whole sky; and the shadow maps must only be built
    // once per frame, by the colour pass that follows.
    scene.background = null;
    scene.overrideMaterial = this.material;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;

    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    scene.background = prevBackground;
    scene.overrideMaterial = prevOverride;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.shadowMap.needsUpdate = prevShadowNeeds;
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
    hidden.length = 0;
  }

  /** Called once per frame after every consumer has read the velocity buffer. */
  endFrame() {
    this.prevViewProj.copy(this.currViewProj);
  }

  dispose() {
    this.target?.dispose();
    this.depthTexture?.dispose();
    this.target = null;
    this.depthTexture = null;
  }
}
