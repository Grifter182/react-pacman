import * as THREE from 'three';
import { Config } from '../core/Config.js';

/**
 * OWNER: rendering / post-processing agent.
 *
 * Full-screen HDR post chain. Renders the world into an HDR target, runs the
 * effect chain, and presents to the default framebuffer.
 *
 * Intended final chain (in order):
 *   depth+normal prepass -> GTAO -> SSR -> volumetric light -> TAA resolve
 *   -> motion blur -> DOF -> bloom -> exposure/ACES -> LUT grade -> chromatic
 *   aberration -> film grain -> vignette -> sharpen -> present
 *
 * Baseline below is a working HDR target + present so the game runs before the
 * chain is filled in. Keep `render(engine, renderer)` as the single entry point.
 */
export class PostStack {
  constructor() {
    this.enabled = true;
    this.hdr = null;
    this._quad = null;
    this._quadScene = null;
    this._quadCamera = null;
    this._material = null;
  }

  async init(engine) {
    const rm = engine.get('render');
    rm.attachPostStack(this);
    this._createTargets(rm.bufferWidth, rm.bufferHeight);

    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quadScene = new THREE.Scene();
    this._material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tDiffuse: { value: null },
        uExposure: { value: 1.0 },
        uVignette: { value: 0.32 },
        uGrain: { value: 0.035 },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: /* glsl */`
        in vec3 position; in vec2 uv; out vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        in vec2 vUv; out vec4 fragColor;
        uniform sampler2D tDiffuse;
        uniform float uExposure, uVignette, uGrain, uTime;
        uniform vec2 uResolution;

        // ACES filmic (Stephen Hill fit)
        const mat3 ACESInput = mat3(
          0.59719, 0.07600, 0.02840,
          0.35458, 0.90834, 0.13383,
          0.04823, 0.01566, 0.83777);
        const mat3 ACESOutput = mat3(
           1.60475, -0.10208, -0.00327,
          -0.53108,  1.10813, -0.07276,
          -0.07367, -0.00605,  1.07602);
        vec3 rrt(vec3 v){
          vec3 a = v * (v + 0.0245786) - 0.000090537;
          vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
          return a / b;
        }
        vec3 aces(vec3 c){ return clamp(ACESOutput * rrt(ACESInput * c), 0.0, 1.0); }

        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

        void main(){
          vec3 c = texture(tDiffuse, vUv).rgb * uExposure;
          c = aces(c);
          // filmic grain, scaled by luminance so shadows stay clean
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float g = (hash(vUv * uResolution + uTime) - 0.5) * uGrain * (1.0 - l * 0.7);
          c += g;
          // vignette
          vec2 d = vUv - 0.5;
          c *= 1.0 - uVignette * dot(d, d) * 2.0;
          fragColor = vec4(pow(max(c, 0.0), vec3(1.0 / 2.2)), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._material);
    this._quad.frustumCulled = false;
    this._quadScene.add(this._quad);
  }

  _createTargets(w, h) {
    this.hdr?.dispose();
    this.hdr = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
  }

  resize(w, h) {
    this._createTargets(w, h);
    if (this._material) this._material.uniforms.uResolution.value.set(w, h);
  }

  render(engine, renderer) {
    if (!this.enabled || !this.hdr) { renderer.render(engine.scene, engine.camera); return; }

    renderer.setRenderTarget(this.hdr);
    renderer.clear(true, true, true);
    renderer.render(engine.scene, engine.camera);
    renderer.setRenderTarget(null);

    this._material.uniforms.tDiffuse.value = this.hdr.texture;
    this._material.uniforms.uTime.value = engine.elapsed;
    this._material.uniforms.uExposure.value = renderer.toneMappingExposure;
    // tone mapping is applied in the post shader, not by the renderer
    const prevTM = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.render(this._quadScene, this._quadCamera);
    renderer.toneMapping = prevTM;
  }

  dispose() {
    this.hdr?.dispose();
    this._material?.dispose();
    this._quad?.geometry.dispose();
  }
}
