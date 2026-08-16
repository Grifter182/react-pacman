import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { createRT } from './post/PassCore.js';
import { GeometryPass } from './post/GeometryPass.js';
import { AmbientOcclusion } from './post/AmbientOcclusion.js';
import { Reflections } from './post/Reflections.js';
import { TemporalAA } from './post/TemporalAA.js';
import { Bloom } from './post/Bloom.js';
import { CameraEffects } from './post/CameraEffects.js';
import { Exposure } from './post/Exposure.js';
import { ColorGrade } from './post/ColorGrade.js';
import { Sharpen } from './post/Sharpen.js';
import { makeGradeLUT, makeDirtTexture } from './post/LutFactory.js';

/**
 * OWNER: rendering / post-processing agent.
 *
 * The full HDR post chain. RenderModule calls `composite(engine, renderer)`
 * once per frame; everything below happens inside that call.
 *
 *   depth+normal+velocity prepass   (GeometryPass)
 *   world colour -> HDR target
 *   GTAO                            (Config.gfx.ssao)
 *   SSR                             (Config.gfx.ssr)
 *   TAA resolve                     (Config.gfx.taa)
 *   camera motion blur              (Config.gfx.motionBlur)
 *   auto exposure + auto focus      (always — it is a 1x1 chain)
 *   depth of field                  (Config.gfx.dof)
 *   bloom + anamorphic streak       (Config.gfx.bloom, Config.gfx.bloomMips)
 *   exposure / ACES / LUT / lens artefacts / grain / vignette  (ColorGrade)
 *   FXAA (only when TAA is off) then CAS sharpen -> default framebuffer
 *
 * TAA jitter is applied to `camera.projectionMatrix` here and removed again
 * before the frame ends, so no other module ever sees a jittered camera. The
 * current offset is published as `engine.taaJitter` (NDC) for anything that
 * needs it.
 *
 * Deliberately NOT named `render` — the engine calls `render(engine)` on every
 * registered module and this stack must only ever be driven by RenderModule,
 * which owns frame composition and supplies the renderer.
 */
export class PostStack {
  constructor() {
    this.enabled = true;

    this.hdr = null;
    this.rtA = null;
    this.rtB = null;
    this.ldrA = null;
    this.ldrB = null;

    this.geometry = null;
    this.ao = null;
    this.ssr = null;
    this.taa = null;
    this.bloom = null;
    this.cameraFx = null;
    this.exposure = null;
    this.grade = null;
    this.sharpen = null;

    this.useGBuffer = false;
    this.useAo = false;
    this.useSsr = false;
    this.useTaa = false;
    this.useMotionBlur = false;
    this.useDof = false;
    this.useBloom = false;

    this.width = 2;
    this.height = 2;
    this._tier = null;

    this._unjitteredProj = new THREE.Matrix4();
    this._invProj = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._jitterNdc = new THREE.Vector2();
    this._jitterUv = new THREE.Vector2();
    this._prevCamPos = new THREE.Vector3();
    this._hasPrevCamPos = false;
    this._clearColor = new THREE.Color();
    this._tmpV = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();

    this._ads = 0;
    this._adsTarget = 0;

    /** Shared per-frame state handed to every sub-pass. */
    this._ctx = {
      depthTexture: null,
      normalTexture: null,
      velocityTexture: null,
      adaptTexture: null,
      blackTexture: null,
      envCube: null,
      proj: new THREE.Matrix4(),
      invProj: new THREE.Matrix4(),
      prevViewProj: new THREE.Matrix4(),
      cameraMatrixWorld: new THREE.Matrix4(),
      jitterUv: new THREE.Vector2(),
      sunScreen: new THREE.Vector3(0.5, 0.5, 0),
      projScale: 500,
      frameNoise: 0,
      cameraShift: 0,
      staticExposure: 1,
      ads: 0,
      dt: 0.016,
      time: 0,
    };
  }

  async init(engine) {
    const rm = engine.get('render');
    rm.attachPostStack(this);
    engine.post = this;

    const lut = makeGradeLUT();
    this._lut = lut.texture;
    this._dirt = makeDirtTexture(256);
    this._black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    this._black.needsUpdate = true;
    // A cube sampler must always have something bound: leaving it unset lets
    // WebGL bind unit 0, which is usually a sampler2D, and that is a GL error.
    const px = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    px.needsUpdate = true;
    this._blackCube = new THREE.CubeTexture([px, px, px, px, px, px]);
    this._blackCube.needsUpdate = true;
    this._ctx.blackTexture = this._black;

    this.grade = new ColorGrade();
    this.grade.init(this._lut, lut.size, this._dirt);
    this.sharpen = new Sharpen();
    this.sharpen.init();
    this.exposure = new Exposure();
    this.exposure.init();
    this.bloom = new Bloom();
    this.cameraFx = new CameraEffects();
    this.cameraFx.init();
    this.geometry = new GeometryPass();
    this.geometry.init();
    this.ao = new AmbientOcclusion();
    this.ssr = new Reflections();
    this.taa = new TemporalAA();
    this.taa.init();

    this._configure();
    this.resize(rm.bufferWidth, rm.bufferHeight);

    engine.bus.on('input:ads', (e) => { this._adsTarget = e && e.down ? 1 : 0; });
  }

  /** Rebuild the feature set from the current quality tier. */
  _configure() {
    const gfx = Config.gfx;
    this._tier = Config.quality;

    // Sample counts are compile-time constants in these shaders, so a tier
    // change rebuilds the programs rather than branching at runtime.
    this.ao.dispose();
    this.ssr.dispose();
    this.bloom.dispose();

    this.useAo = !!gfx.ssao;
    this.useSsr = !!gfx.ssr;
    this.useTaa = !!gfx.taa;
    this.useMotionBlur = !!gfx.motionBlur;
    this.useDof = !!gfx.dof;
    this.useBloom = !!gfx.bloom;
    this.useGBuffer = this.useAo || this.useSsr || this.useTaa || this.useMotionBlur || this.useDof;

    this.ao.init(gfx.ssaoSamples || 16);
    this.ssr.init(gfx.ssaoSamples >= 24 ? 48 : 32);
    this.bloom.init(gfx.bloomMips || 5);

    // Lower tiers cannot afford a wide GTAO search or a long SSR march.
    this.ao.radius = gfx.ssaoSamples >= 24 ? 1.25 : 1.0;
    this.ao.maxRadiusPixels = gfx.ssaoSamples >= 24 ? 110 : 72;
    this.ssr.maxDistance = gfx.ssaoSamples >= 24 ? 48 : 30;
  }

  /**
   * @param {number} w buffer width  @param {number} h buffer height
   * @param {object} [engine] present only when the *engine* drives the resize,
   *   in which case w/h are CSS pixels and the real buffer size must be taken
   *   from RenderModule instead.
   */
  resize(w, h, engine) {
    // The engine broadcasts a resize to every registered module before it runs
    // any init(), so this can land before the sub-passes exist. init() calls
    // resize() itself once they do, so bailing out here loses nothing.
    if (!this.grade) return;
    if (engine && typeof engine.get === 'function') {
      const rm = engine.get('render');
      if (rm && rm.bufferWidth) { w = rm.bufferWidth; h = rm.bufferHeight; }
    }
    w = Math.max(2, w | 0);
    h = Math.max(2, h | 0);
    this.width = w;
    this.height = h;

    this.hdr?.dispose();
    this.hdr = createRT(w, h, { depthBuffer: true, name: 'hdr' });

    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtA = createRT(w, h, { name: 'post-a' });
    this.rtB = createRT(w, h, { name: 'post-b' });

    this.ldrA?.dispose();
    this.ldrA = createRT(w, h, { type: THREE.UnsignedByteType, name: 'ldr-a' });
    this.ldrB?.dispose();
    this.ldrB = this.useTaa ? null : createRT(w, h, { type: THREE.UnsignedByteType, name: 'ldr-b' });

    if (this.useGBuffer) this.geometry.resize(w, h); else this.geometry.dispose();
    if (this.useAo) this.ao.resize(w, h);
    if (this.useSsr) this.ssr.resize(w, h);
    if (this.useTaa) this.taa.resize(w, h);
    if (this.useBloom) this.bloom.resize(w, h);
    this.cameraFx.resize(w, h);
    this.exposure.resize(w, h);
    this.grade.resize(w, h);
    this.sharpen.resize(w, h);
  }

  /** Ping-pong helper: whichever full-res scratch target is not the source. */
  _scratch(currentTexture) {
    return (currentTexture === this.rtA.texture) ? this.rtB : this.rtA;
  }

  composite(engine, renderer) {
    if (!this.enabled || !this.hdr) { renderer.render(engine.scene, engine.camera); return; }
    if (this._tier !== Config.quality) {
      this._configure();
      this.resize(this.width, this.height);
    }

    const camera = engine.camera;
    const scene = engine.scene;
    const ctx = this._ctx;
    const dt = Math.min(Math.max(engine.delta || 0.016, 1e-4), 0.1);

    // --- renderer state we borrow and must hand back ------------------------
    const prevToneMapping = renderer.toneMapping;
    const prevColorSpace = renderer.outputColorSpace;
    renderer.getClearColor(this._clearColor);
    const prevClearAlpha = renderer.getClearAlpha();
    // The world is rendered in *linear* light. Tone mapping happens exactly
    // once, in ColorGrade; letting the renderer also tone map would crush the
    // image twice.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    // --- matrices, unjittered ------------------------------------------------
    camera.updateMatrixWorld();
    this._unjitteredProj.copy(camera.projectionMatrix);
    this._invProj.copy(this._unjitteredProj).invert();
    this._viewProj.multiplyMatrices(this._unjitteredProj, camera.matrixWorldInverse);

    // --- TAA jitter ---------------------------------------------------------
    this._jitterNdc.set(0, 0);
    if (this.useTaa) {
      this.taa.jitter(this._jitterNdc, this.width, this.height);
      const e = camera.projectionMatrix.elements;
      e[8] += this._jitterNdc.x;   // clip.x += jx * w  ->  ndc.x += jx
      e[9] += this._jitterNdc.y;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }
    engine.taaJitter = this._jitterNdc;
    this._jitterUv.set(this._jitterNdc.x * 0.5, this._jitterNdc.y * 0.5);

    // --- per-frame context ---------------------------------------------------
    this._ads += (this._adsTarget - this._ads) * (1 - Math.exp(-dt * 9));
    if (!this._hasPrevCamPos) { this._prevCamPos.copy(camera.position); this._hasPrevCamPos = true; }
    ctx.cameraShift = this._prevCamPos.distanceTo(camera.position);
    this._prevCamPos.copy(camera.position);

    // On the first frame there is no history: seed "previous" with "current" so
    // nothing reprojects against an identity matrix.
    if (!this.geometry._hasPrev) {
      this.geometry.prevViewProj.copy(this._viewProj);
      this.geometry._hasPrev = true;
    }
    this.geometry.currViewProj.copy(this._viewProj);

    ctx.proj.copy(this._unjitteredProj);
    ctx.invProj.copy(this._invProj);
    ctx.prevViewProj.copy(this.geometry.prevViewProj);
    ctx.cameraMatrixWorld.copy(camera.matrixWorld);
    ctx.jitterUv.copy(this._jitterUv);
    ctx.projScale = 0.5 * this.height * this._unjitteredProj.elements[5];
    ctx.frameNoise = this.useTaa ? (engine.frame % 64) : 0;
    ctx.staticExposure = renderer.toneMappingExposure;
    ctx.ads = this._ads;
    ctx.dt = dt;
    ctx.time = engine.elapsed;
    ctx.envCube = (scene.background && scene.background.isCubeTexture) ? scene.background : this._blackCube;
    this._projectSun(engine, camera, ctx);

    // --- 1. depth / normal / velocity prepass --------------------------------
    if (this.useGBuffer && this.geometry.target) {
      this.geometry.render(renderer, engine, this._viewProj);
      ctx.depthTexture = this.geometry.depthTexture;
      ctx.normalTexture = this.geometry.normalTexture;
      ctx.velocityTexture = this.geometry.velocityTexture;
    } else {
      ctx.depthTexture = this._black;
      ctx.normalTexture = this._black;
      ctx.velocityTexture = this._black;
    }

    // --- 2. world colour -> HDR ---------------------------------------------
    renderer.setRenderTarget(this.hdr);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    // Every later pass reconstructs positions with the unjittered matrices, so
    // hand the camera back before anything else can observe it.
    camera.projectionMatrix.copy(this._unjitteredProj);
    camera.projectionMatrixInverse.copy(this._invProj);

    let src = this.hdr.texture;

    // --- 3. ambient occlusion -----------------------------------------------
    if (this.useAo && this.ao.aoTarget) {
      this.ao.render(renderer, ctx);
      const dst = this._scratch(src);
      this.ao.composite(renderer, ctx, src, dst);
      src = dst.texture;
    }

    // --- 4. screen-space reflections ----------------------------------------
    if (this.useSsr && this.ssr.target) {
      const dst = this._scratch(src);
      this.ssr.render(renderer, ctx, src, dst);
      src = dst.texture;
    }

    // --- 5. temporal resolve --------------------------------------------------
    if (this.useTaa) {
      src = this.taa.render(renderer, ctx, src);
      this.taa.advance();
    }

    // --- 6. camera motion blur ------------------------------------------------
    if (this.useMotionBlur) {
      const dst = this._scratch(src);
      this.cameraFx.renderMotionBlur(renderer, ctx, src, dst);
      src = dst.texture;
    }

    // --- 7. eye adaptation + auto focus (1x1 result, no readback) -------------
    ctx.adaptTexture = this.exposure.render(renderer, ctx, src);

    // --- 8. depth of field ----------------------------------------------------
    if (this.useDof) {
      const dst = this._scratch(src);
      this.cameraFx.renderDof(renderer, ctx, src, dst);
      src = dst.texture;
    }

    // --- 9. bloom -------------------------------------------------------------
    let bloomTex = null;
    let streakTex = null;
    if (this.useBloom) {
      const r = this.bloom.render(renderer, src, this.width, this.height);
      bloomTex = r.bloom;
      streakTex = r.streak;
    }

    // --- 10. tonemap + grade + lens artefacts ---------------------------------
    this.grade.render(renderer, ctx, src, bloomTex, streakTex, this.ldrA);

    // --- 11. edge AA (spatial fallback) + sharpen -> screen --------------------
    let ldr = this.ldrA.texture;
    if (!this.useTaa && this.ldrB) {
      this.sharpen.renderFxaa(renderer, ldr, this.ldrB);
      ldr = this.ldrB.texture;
    }
    this.sharpen.renderCas(renderer, ldr, null);

    // --- restore -------------------------------------------------------------
    this.geometry.endFrame();
    renderer.setRenderTarget(null);
    renderer.setClearColor(this._clearColor, prevClearAlpha);
    renderer.toneMapping = prevToneMapping;
    renderer.outputColorSpace = prevColorSpace;
  }

  /** Screen-space sun position + a front/behind flag, for the dirt-mask flare. */
  _projectSun(engine, camera, ctx) {
    const dir = engine.sunDirection;
    if (!dir) { ctx.sunScreen.set(0.5, 0.5, 0); return; }
    this._tmpV.copy(dir).multiplyScalar(4000).add(camera.position);
    this._tmpV2.copy(this._tmpV).applyMatrix4(camera.matrixWorldInverse);
    if (this._tmpV2.z >= 0) { ctx.sunScreen.set(0.5, 0.5, 0); return; }
    this._tmpV.project(camera);
    ctx.sunScreen.set(this._tmpV.x * 0.5 + 0.5, this._tmpV.y * 0.5 + 0.5, 1);
  }

  dispose() {
    this.hdr?.dispose();
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.ldrA?.dispose();
    this.ldrB?.dispose();
    this.geometry?.dispose();
    this.ao?.dispose();
    this.ssr?.dispose();
    this.taa?.dispose();
    this.bloom?.dispose();
    this.cameraFx?.dispose();
    this.exposure?.dispose();
    this.grade?.dispose();
    this.sharpen?.dispose();
    this._lut?.dispose();
    this._dirt?.dispose();
    this._black?.dispose();
    this._blackCube?.dispose();
  }
}
