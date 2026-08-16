import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { ATMO } from './Atmosphere.js';
import { CascadedShadows } from './CascadedShadows.js';
import { DynamicLightPool } from './DynamicLights.js';
import { installAtmosphericFog, uninstallAtmosphericFog } from './AtmosphericFog.js';

/**
 * OWNER: lighting / shadows agent.
 *
 * The light rig: one key (the sun, split into stabilised shadow cascades), a
 * three-part fill, atmospheric height fog matched to the sky, and a pool of
 * transient dynamic lights other modules can borrow.
 *
 * THE EXPOSURE BUDGET
 * -------------------
 * Auto-exposure normalises the frame's geometric-mean luminance, so absolute
 * light levels here do not survive to the screen — only RATIOS do. Every number
 * below is therefore chosen as a ratio, and the ratio that matters most is what
 * a horizontal patch of ground receives from the sun versus from everything
 * else. The sun sits at 14.5 degrees, so the ground only collects sin(14.5) =
 * 0.25 of its beam:
 *
 *              key on ground     total fill     ratio
 *   before       1.29                0.96        1.34 : 1
 *   after        3.68                0.84        4.40 : 1
 *
 * 1.34:1 is not a key light, it is two fills, and it is why the game had no
 * directional form: the ground — most of an FPS frame — was lit almost equally
 * from the sun and from the whole rest of the sky, so it carried no gradient
 * and no terminator. Vertical surfaces were never the problem; a wall facing
 * the sun was already at 5.9:1.
 *
 * FILL / BOUNCE — three terms, deliberately not one
 * -------------------------------------------------
 * 1. `scene.environment`, the PMREM of SkyModule's bake, at 0.32. Its diffuse
 *    mip is the true SH irradiance of the sky, including the dust band and the
 *    clouds. It is scaled well under unity ON PURPOSE — at unity it swamps the
 *    key, per the table above.
 *
 * 2. A hemisphere term for GROUND BOUNCE. The previous version of this file
 *    argued no hemisphere light was needed because the bake's lower hemisphere
 *    already carries a sunlit planet ground. That was true and it was not
 *    enough: the planet ground in the bake is a hazed, distant, low-albedo
 *    surface whose radiance is 0.20 against a horizon of 1.5, so once the
 *    environment is scaled to 0.32 there is essentially no warm term left
 *    anywhere in the rig and every shaded facade collapses to sky blue. The
 *    hemisphere's ground colour is DERIVED, not dialled: it is the level's own
 *    sand albedo times the irradiance that sand actually receives from the key
 *    and the sky, divided by pi and integrated over the half-hemisphere a
 *    vertical wall sees. Measured on a facade turned away from the sun, the
 *    hemisphere term is (1.00, 0.65, 0.42) of irradiance — take it away and
 *    that facade is left with (0.53, 0.63, 0.87), blue/red 1.64, i.e. exactly
 *    the "unlit blue-black" the review found. With it the same facade is
 *    (1.53, 1.28, 1.29).
 *
 * 3. A weak cool directional fill 150 degrees round from the key. It shades the
 *    faces the key and the bounce both miss, so a shadow-side wall still has a
 *    gradient across it rather than one flat value. Under 5% of the key, no
 *    shadow map.
 *
 * The net is that lit and shadowed faces differ by 11.6:1 — 3.5 stops — in
 * value AND cross over in hue: the lit side normalises to (1.00, 0.73, 0.45),
 * the shadow side to (1.00, 0.83, 0.84). Warm key, cool-neutral and much
 * dimmer fill, and no black.
 *
 * Per-frame cost, HIGH tier: 4 cascade shadow passes, ~26 shadow taps per lit
 * fragment, one extra unshadowed directional, one hemisphere term, 6 idle point
 * lights. Everything is gated on Config.gfx.
 */

/**
 * Sun strength multiplier over the physical E0 * transmittance.
 *
 * This is the one honestly non-physical number in the rig. It exists because
 * the sky is a full physical hemisphere of light and the sun is a 0.0005 sr
 * disc, and at 14.5 degrees of elevation the physically correct answer is a
 * flat image. Film lights the same scene with a 4:1 to 8:1 key-to-fill and so
 * does every shooter this is measured against.
 */
const KEY_GAIN = 2.85;

/** Fraction of the physical sky irradiance left in `scene.environment`. */
const ENV_INTENSITY = 0.32;

/**
 * The viewmodel keeps more environment than the world. The gun is 40 cm from
 * the player's chest and half a metre above the ground, so it genuinely sits in
 * far more bounce than a wall does, and it is also the one object always in
 * frame — letting it crush is worse than letting it read slightly flat.
 */
const VIEWMODEL_ENV_INTENSITY = 0.50;

export class LightingModule {
  constructor() {
    this.csm = null;
    this.sun = null;
    this.bounce = null;
    this.fill = null;
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

    const sunDir = engine.sunDirection || new THREE.Vector3(-0.963, 0.250, 0.101).normalize();

    this.csm = new CascadedShadows({
      scene: engine.scene,
      direction: sunDir,
      count: gfx.shadowCascades,
      mapSize: gfx.shadowMapSize,
      maxDistance: gfx.shadowDistance,
      pcfTaps: { low: 8, medium: 12, high: 20, ultra: 28 }[tier] ?? 12,
      // Contact hardening is what separates "this crate is sitting on the
      // ground" from "this crate is floating". It costs 12 extra comparison
      // taps; only the low tier cannot afford them.
      contactHardening: tier !== 'low',
      worldBlur: 0.34,
    }).build();

    // Key light. The colour is the sun's own spectral transmittance at 14.5
    // degrees of elevation (see Atmosphere.js), used RAW.
    //
    // It used to be pulled 18% toward white on the argument that a fully
    // physical low sun drags every material's hue toward orange. It does, and
    // that is the point: at this elevation the warm key against the cool sky
    // fill is the single largest source of form in the image, and desaturating
    // the key by 18% removes almost a third of the key-to-fill hue separation
    // to protect a material read that the albedo textures already carry on
    // their own. The bounce term below is what keeps shaded surfaces
    // identifiable, not a whitened key.
    const irr = engine.sunIrradiance || new THREE.Vector3(6.7, 4.9, 3.0);
    const peak = Math.max(irr.x, irr.y, irr.z);
    const key = new THREE.Color().setRGB(irr.x / peak, irr.y / peak, irr.z / peak, THREE.LinearSRGBColorSpace);
    this.csm.setSunColor(key, peak * KEY_GAIN);
    this.sun = this.csm.keyLight;
    engine.sun = this.sun;
    engine.csm = this.csm;

    // Sky fill, scaled well under unity — see the exposure budget above.
    engine.scene.environmentIntensity = ENV_INTENSITY;
    engine.viewmodelScene.environmentIntensity = VIEWMODEL_ENV_INTENSITY;

    this._installBounce(engine, sunDir, irr);

    // Fog. Must exist before any material compiles (USE_FOG is a define), which
    // is why this module is registered ahead of the level and the actors.
    // Fallback mirrors a converged fit for the shipped sun elevation, so the
    // fog is still sky-matched if SkyModule ever fails to publish one.
    const fit = engine.skyFit || {
      horizon: [1.156, 0.897, 0.062],
      ramp: [-1.132, -0.826, 0.201],
      belt: [-1.763, -1.128, 3.499],
      tint: [0.645, 0.426, 0.202],
      broad: [-0.007, -0.029, -0.026],
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
   * Ground bounce + opposing fill.
   *
   * Both colours are computed from the rig that is already standing rather than
   * picked by eye, so if the sun elevation, the sand albedo or the environment
   * scale ever move, the bounce moves with them and stays plausible.
   *
   * Order matters: these two lights are added to the scene AFTER the cascades.
   * three fills `directionalShadowMap[i]` by directional-light index and then
   * truncates the array to the shadow count, so every shadow-casting light must
   * come first or cascade i stops lining up with map i. `this.fill` never casts,
   * which is what makes appending it safe.
   */
  _installBounce(engine, sunDir, sunIrradiance) {
    const scene = engine.scene;

    // Irradiance arriving at a horizontal patch of the level's ground: the key,
    // foreshortened by the sun's elevation, plus the sky.
    const nl = Math.max(sunDir.y, 0);
    const skyUp = engine.skyIrradianceUp || new THREE.Vector3(0.94, 1.22, 1.98);
    const eGround = new THREE.Vector3(
      sunIrradiance.x * KEY_GAIN * nl + skyUp.x * ENV_INTENSITY,
      sunIrradiance.y * KEY_GAIN * nl + skyUp.y * ENV_INTENSITY,
      sunIrradiance.z * KEY_GAIN * nl + skyUp.z * ENV_INTENSITY,
    );

    // Radiant exitance of that ground. ATMO.groundAlbedo is the linear albedo of
    // the level's own sand (materials/Recipes.js C_SAND), so this is literally
    // the light coming back off the floor the player is standing on.
    const a = ATMO.groundAlbedo;
    const exitance = new THREE.Vector3(a[0] * eGround.x, a[1] * eGround.y, a[2] * eGround.z);

    // A downward-facing surface a little above the ground sees it filling most
    // of its hemisphere; a vertical wall sees exactly half. three's hemisphere
    // light hands the ground colour to normals pointing straight down and the
    // mean of the two colours to horizontal normals, which is the same split.
    const GROUND_FORM_FACTOR = 1.0;
    const groundColor = new THREE.Color().setRGB(
      exitance.x * GROUND_FORM_FACTOR,
      exitance.y * GROUND_FORM_FACTOR,
      exitance.z * GROUND_FORM_FACTOR,
      THREE.LinearSRGBColorSpace,
    );

    // Upward-facing surfaces already get the sky through the environment map;
    // this is the part of it the 0.32 scale threw away, added back at a fifth
    // strength so the ground reads as open-air rather than as a studio floor.
    // Deliberately well under the ground term. The bounce only reads as SAND
    // if it dominates the sky half; at parity every shaded facade came back to
    // neutral grey, which is less wrong than blue but is not what a desert
    // looks like.
    const SKY_RECOVERY = 0.22;
    const skyColor = new THREE.Color().setRGB(
      skyUp.x * SKY_RECOVERY, skyUp.y * SKY_RECOVERY, skyUp.z * SKY_RECOVERY,
      THREE.LinearSRGBColorSpace,
    );

    this.bounce = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.0);
    this.bounce.name = 'GroundBounce';
    this.bounce.color.copy(skyColor);
    this.bounce.groundColor.copy(groundColor);
    scene.add(this.bounce);

    // Opposing fill. 150 degrees round from the key rather than a flat 180 —
    // directly opposite, it would light precisely the faces the key misses and
    // hand them a second flat value, which is the classic way to destroy the
    // form a key just built. Lifted to 38 degrees of elevation so it reads as
    // sky rather than as a second sun, and coloured with the zenith rather than
    // the horizon so it stays cool against the warm bounce.
    const az = Math.atan2(sunDir.z, sunDir.x) + (150 * Math.PI) / 180;
    const el = (38 * Math.PI) / 180;
    const fillDir = new THREE.Vector3(
      Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el),
    );
    // Colour of sky light itself — the hue of the measured hemispherical
    // irradiance, normalised. Not the fitted zenith: that extrapolates to
    // (0.02, 0.07, 0.26), an almost pure blue that would tint the shadow side
    // ultramarine rather than merely cool.
    const zPeak = Math.max(skyUp.x, skyUp.y, skyUp.z, 1e-4);

    this.fill = new THREE.DirectionalLight(0xffffff, 1);
    this.fill.name = 'SkyFill';
    this.fill.castShadow = false;
    this.fill.color.setRGB(skyUp.x / zPeak, skyUp.y / zPeak, skyUp.z / zPeak, THREE.LinearSRGBColorSpace);
    // ~4.5% of the key: enough to put a gradient across a shadowed wall, far too
    // little to read as a light of its own or to cast a competing terminator.
    this.fill.intensity = sunIrradiance.y * KEY_GAIN * 0.045;
    this.fill.position.copy(fillDir).multiplyScalar(80);
    this.fill.target.position.set(0, 0, 0);
    scene.add(this.fill);
    scene.add(this.fill.target);
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
    if (this.bounce) { this.bounce.parent?.remove(this.bounce); this.bounce = null; }
    if (this.fill) {
      this.fill.target.parent?.remove(this.fill.target);
      this.fill.parent?.remove(this.fill);
      this.fill = null;
    }
    this.dynamicLights?.dispose();
    this.csm?.dispose();
    uninstallAtmosphericFog();
  }
}
