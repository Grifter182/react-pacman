import * as THREE from 'three';
import { Config } from '../core/Config.js';

/**
 * Owns the WebGL2 renderer and the frame composition order.
 *
 * Composition:
 *   1. World pass      -> HDR render target (scene + camera)
 *   2. Post stack      -> PostStack.render(readTarget) (owned by PostStack.js)
 *   3. Viewmodel pass  -> drawn on top with a cleared depth buffer so the
 *                         weapon never intersects world geometry.
 *
 * The post-processing chain lives in `src/render/PostStack.js` and is hot-
 * swappable: if it is absent the module falls back to a direct present.
 */
export class RenderModule {
  constructor() {
    this.renderer = null;
    this.postStack = null;
    this.renderScale = 1;
    this._targetScale = 1;
  }

  async init(engine) {
    const renderer = new THREE.WebGLRenderer({
      canvas: engine.canvas,
      antialias: false,          // handled by TAA/SMAA in the post stack
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    renderer.debug.checkShaderErrors = true;
    renderer.setPixelRatio(engine.pixelRatio);
    renderer.setSize(engine.width, engine.height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    /**
     * THE SHADOW FILTER IS CHOSEN BY LightingModule, NOT HERE.
     *
     * This line used to set VSMShadowMap, and it was dead: `lighting` is
     * registered after `render`, so LightingModule.init overwrites it with
     * PCFShadowMap — which is what the cascade sampler in CascadedShadows.js is
     * actually written against, binding shadow maps as `sampler2DShadow` for
     * hardware comparison filtering. Measured at runtime: shadowMap.type === 1
     * (PCFShadowMap).
     *
     * The dead line was not harmless. A reviewer with measurement tools read it,
     * concluded the renderer and the cascade sampler disagreed about what they
     * were sampling, and reported that as the root cause of the map having no
     * shadow story. Code that states a falsehood costs debugging time even when
     * it costs no frames, so the choice now lives in exactly one place and says
     * where that is.
     */
    renderer.shadowMap.autoUpdate = true;
    renderer.autoClear = false;
    // We issue several render() calls per frame (world, post, viewmodel).
    // Auto-reset would zero the counters between them and report only the
    // last pass, so we reset once per frame ourselves in render().
    renderer.info.autoReset = false;

    this.renderer = renderer;
    engine.renderer = renderer;

    this.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    engine.maxAnisotropy = this.maxAnisotropy;

    this._resizeTargets(engine.width, engine.height);
  }

  /** PostStack registers itself here so RenderModule stays its only caller. */
  attachPostStack(stack) { this.postStack = stack; }

  _resizeTargets(w, h) {
    const scale = Config.gfx.renderScale * this.renderScale;
    this.bufferWidth = Math.max(2, Math.floor(w * scale));
    this.bufferHeight = Math.max(2, Math.floor(h * scale));
  }

  resize(w, h, engine) {
    this.renderer.setPixelRatio(engine.pixelRatio);
    this.renderer.setSize(w, h, false);
    this._resizeTargets(w, h);
    if (this.postStack?.resize) this.postStack.resize(this.bufferWidth, this.bufferHeight);
  }

  render(engine) {
    const r = this.renderer;
    r.info.reset();
    r.clear(true, true, true);

    if (this.postStack?.composite) {
      this.postStack.composite(engine, r);
    } else {
      r.render(engine.scene, engine.camera);
    }

    // Viewmodel always draws last, over a cleared depth buffer.
    r.clearDepth();
    r.render(engine.viewmodelScene, engine.viewmodelCamera);
  }

  dispose() { this.renderer?.dispose(); }
}
