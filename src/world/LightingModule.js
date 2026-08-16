import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { ATMO } from './Atmosphere.js';
import { CascadedShadows } from './CascadedShadows.js';
import { DynamicLightPool } from './DynamicLights.js';
import { installAtmosphericFog, uninstallAtmosphericFog } from './AtmosphericFog.js';

/**
 * OWNER: lighting / shadows agent.
 *
 * The light rig: one key (the sun, split into stabilised shadow cascades), sky
 * fill from the baked environment, atmospheric height fog matched to that same
 * sky, and a pool of transient dynamic lights other modules can borrow.
 *
 * FILL / BOUNCE
 * -------------
 * There is deliberately no HemisphereLight. `scene.environment` is the PMREM of
 * the sky cubemap SkyModule baked, and its diffuse mip IS the SH irradiance of
 * that sky — the same integral a light probe would compute, from the same
 * pixels, with the specular lobes thrown in. Adding a hemisphere light on top
 * would double count the sky and flatten out exactly the directional variation
 * that makes the fill read as bounce. The lower hemisphere of the bake contains
 * a sunlit planet ground, so upward-facing bounce arrives warm and downward
 * facing surfaces pick up the blue sky — the split that keeps shadowed areas
 * coloured instead of flat black.
 *
 * Per-frame cost, HIGH tier: 4 cascade shadow passes, ~20 shadow taps per lit
 * fragment, 6 idle point lights. Everything is gated on Config.gfx.
 */
export class LightingModule {
  constructor() {
    this.csm = null;
    this.sun = null;
    this.dynamicLights = null;
    this._offs = [];
  }

  async init(engine) {
    const gfx = Config.gfx;
    const tier = Config.quality;
    const renderer = engine.renderer || engine.get('render').renderer;

    /**
     * INTEGRATION NOTE for the render agent: the cascade sampler in
     * CascadedShadows.js is written against three's PCF path, which binds
     * shadow maps as `sampler2DShadow` and gives hardware 2x2 comparison
     * filtering for free. VSM would additionally cost a two-pass separable blur
     * per cascade per frame (8 extra full-res passes at 4 cascades) and bleeds
     * light through the long thin occluders this map is full of. If VSM is ever
     * wanted back, the sampler falls back to three's `getShadow` automatically.
     */
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    const sunDir = engine.sunDirection || new THREE.Vector3(0.478, 0.250, -0.842).normalize();

    this.csm = new CascadedShadows({
      scene: engine.scene,
      direction: sunDir,
      count: gfx.shadowCascades,
      mapSize: gfx.shadowMapSize,
      maxDistance: gfx.shadowDistance,
      pcfTaps: { low: 6, medium: 8, high: 12, ultra: 16 }[tier] ?? 8,
      contactHardening: tier === 'high' || tier === 'ultra',
      worldBlur: 0.26,
    }).build();

    // Key light. The colour is the sun's own spectral transmittance at 14.5
    // degrees of elevation (see Atmosphere.js), pulled 18% toward white: fully
    // physical it is saturated enough to drag every material's hue toward
    // orange, and a shooter needs surfaces to stay identifiable.
    const irr = engine.sunIrradiance || new THREE.Vector3(7.1, 5.6, 3.1);
    const peak = Math.max(irr.x, irr.y, irr.z);
    const key = new THREE.Color().setRGB(irr.x / peak, irr.y / peak, irr.z / peak, THREE.LinearSRGBColorSpace);
    key.lerp(new THREE.Color(1, 1, 1), 0.18);
    this.csm.setSunColor(key, peak);
    this.sun = this.csm.keyLight;
    engine.sun = this.sun;
    engine.csm = this.csm;

    // Sky fill. Slightly under unity so shadowed areas keep a floor of colour
    // without going milky — the bake is physically bright and ACES is forgiving
    // at the top end but not at the bottom.
    engine.scene.environmentIntensity = 0.85;
    engine.viewmodelScene.environmentIntensity = 0.85;

    // Fog. Must exist before any material compiles (USE_FOG is a define), which
    // is why this module is registered ahead of the level and the actors.
    // Fallback mirrors a converged fit for the shipped sun elevation, so the
    // fog is still sky-matched if SkyModule ever fails to publish one.
    const fit = engine.skyFit || {
      horizon: [1.154, 0.894, 0.061],
      ramp: [-1.141, -0.830, 0.200],
      belt: [-1.789, -1.138, 3.503],
      tint: [0.630, 0.407, 0.189],
      broad: [0.006, -0.018, -0.020],
      gradientPow: [0.51, 0.96, 0.42],
      mieG: 0.72,
    };
    // ATMO.haze is the single source for the boundary layer: the sky bake
    // already folded these exact numbers into its ground hemisphere, so the
    // fogged geometry and the background behind it converge on one value.
    engine.scene.fog = installAtmosphericFog({
      fit,
      sunDir: [sunDir.x, sunDir.y, sunDir.z],
      density: ATMO.haze.density,
      scaleHeight: ATMO.haze.scaleHeight,
      baseHeight: ATMO.haze.baseHeight,
    });
    engine.fogFit = fit;

    // Transient lights. Budget is a real per-fragment cost, so it is tiered.
    const budget = { low: 3, medium: 4, high: 6, ultra: 8 }[tier] ?? 4;
    this.dynamicLights = new DynamicLightPool(engine.scene, budget);
    engine.dynamicLights = this.dynamicLights;

    this._bind(engine);
    this.csm.update(engine.camera);
  }

  /**
   * Lighting owns light, including the light events make. Any module can also
   * call `engine.dynamicLights.spawn()` directly for cases these defaults miss.
   */
  _bind(engine) {
    const p = new THREE.Vector3();

    this._offs.push(engine.bus.on('weapon:fire', (e) => {
      if (!e?.origin) return;
      p.copy(e.origin);
      this.dynamicLights.spawn({
        position: p,
        color: 0xffd9a0,
        intensity: 26,
        radius: 9,
        life: 0.055,
      });
    }));

    this._offs.push(engine.bus.on('fx:explosion', (e) => {
      if (!e?.position) return;
      const r = Math.max(e.radius || 6, 3);
      this.dynamicLights.spawn({
        position: e.position,
        color: 0xff8c3a,
        intensity: 90 * (r / 6),
        radius: r * 3.2,
        life: 0.42,
        flicker: 0.35,
      });
    }));
  }

  update(dt, engine) {
    if (this.csm) this.csm.update(engine.camera);
    if (this.dynamicLights) this.dynamicLights.update(dt);
  }

  resize(w, h, engine) {
    // Cascade sphere radii depend on the camera's aspect; refit immediately so
    // the first frame after a resize is not sampling a stale projection.
    if (this.csm) this.csm.update(engine.camera);
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    this.dynamicLights?.dispose();
    this.csm?.dispose();
    uninstallAtmosphericFog();
  }
}
