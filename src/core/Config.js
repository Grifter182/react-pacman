/**
 * Global tuning + quality configuration.
 * `quality` is resolved at boot from device capability and can be changed live.
 */

export const QualityTier = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  ULTRA: 'ultra',
};

export const QualityPresets = {
  [QualityTier.LOW]: {
    renderScale: 0.75,
    shadowMapSize: 1024,
    shadowCascades: 2,
    shadowDistance: 60,
    ssao: false,
    ssaoSamples: 8,
    ssr: false,
    bloom: true,
    bloomMips: 4,
    motionBlur: false,
    dof: false,
    taa: false,
    volumetrics: false,
    anisotropy: 4,
    textureSize: 512,
    particleBudget: 2000,
    decalBudget: 64,
  },
  [QualityTier.MEDIUM]: {
    renderScale: 0.9,
    shadowMapSize: 2048,
    shadowCascades: 3,
    shadowDistance: 90,
    ssao: true,
    ssaoSamples: 12,
    ssr: false,
    bloom: true,
    bloomMips: 5,
    motionBlur: true,
    dof: false,
    taa: true,
    volumetrics: true,
    anisotropy: 8,
    textureSize: 1024,
    particleBudget: 6000,
    decalBudget: 128,
  },
  [QualityTier.HIGH]: {
    renderScale: 1.0,
    shadowMapSize: 2048,
    // THREE CASCADES, NOT FOUR — and the range pulled in to pay for it.
    //
    // Under VSM three.js renders a mesh into every cascade if it casts OR
    // receives (see `LevelModule._budget`), and `receiveShadow` is true on
    // essentially the whole map. The cascade count is therefore a direct
    // multiplier on the submitted triangle count: at 4 cascades the level's
    // 244k unique triangles were submitted 5 times for 1,341k, which is most
    // of the frame's whole budget and the reason round 2 measured 2.94M.
    //
    // Dropping a cascade normally costs near-field shadow resolution, because
    // the practical split scheme (Zhang et al., lambda 0.65, as implemented in
    // CascadedShadows._updateSplits) hands the first cascade a bigger slice
    // when there are fewer of them. At 140 m that would have taken cascade 0
    // from 0.6-13.9 m to 0.6-18.9 m — a 35% coarser contact shadow, which is
    // exactly the shadow the player sees at their own feet.
    //
    // Pulling `shadowDistance` to 110 m gives it back: at 3 cascades over
    // 110 m the first split lands at 15.2 m, within 9% of the 4-cascade
    // 13.9 m, so the near field is effectively unchanged. The range still
    // covers the compound, which is 80 x 92 m, and geometry past 110 m is
    // backdrop that lives in `SKY` buckets and casts nothing anyway.
    //
    // Net: -244k submitted triangles for a shadow that measures the same
    // where anyone can see it.
    shadowCascades: 3,
    shadowDistance: 110,
    ssao: true,
    ssaoSamples: 20,
    ssr: true,
    bloom: true,
    bloomMips: 6,
    motionBlur: true,
    dof: true,
    taa: true,
    volumetrics: true,
    anisotropy: 16,
    textureSize: 1024,
    particleBudget: 12000,
    decalBudget: 256,
  },
  [QualityTier.ULTRA]: {
    renderScale: 1.0,
    shadowMapSize: 4096,
    shadowCascades: 4,
    shadowDistance: 200,
    ssao: true,
    ssaoSamples: 32,
    ssr: true,
    bloom: true,
    bloomMips: 6,
    motionBlur: true,
    dof: true,
    taa: true,
    volumetrics: true,
    anisotropy: 16,
    textureSize: 2048,
    particleBudget: 24000,
    decalBudget: 512,
  },
};

export const Config = {
  quality: QualityTier.HIGH,
  get gfx() { return QualityPresets[Config.quality]; },

  /** Player feel — tuned to modern-military-shooter cadence. */
  player: {
    height: 1.75,
    eyeHeight: 1.62,
    crouchEyeHeight: 1.02,
    radius: 0.34,
    walkSpeed: 3.6,
    sprintSpeed: 6.35,
    crouchSpeed: 1.9,
    adsSpeedScale: 0.45,
    accelGround: 60,
    accelAir: 9,
    friction: 9.5,
    jumpVelocity: 4.35,
    gravity: 19.6,
    stepHeight: 0.42,
    maxSlopeDeg: 48,
    mantleMaxHeight: 1.45,
    slideImpulse: 7.4,
  },

  camera: {
    fovBase: 80,
    fovSprintAdd: 8,
    fovAdsScale: 0.62,
    near: 0.02,
    far: 800,
    viewmodelFov: 55,
  },

  /** Sensitivity in radians per raw pointer unit. */
  input: {
    sensitivity: 0.0022,
    adsSensScale: 0.72,
    invertY: false,
  },

  match: {
    scoreLimit: 75,
    timeLimitSec: 600,
    respawnDelaySec: 4.0,
    botCount: 7,
  },

  debug: {
    /** Set by the headless harness; suppresses development-only overlays. */
    captureMode: false,
    showStats: false,
    freeCam: false,
    wireframe: false,
  },
};

/**
 * Pick a starting tier from a cheap capability probe.
 *
 * `?quality=ultra` in the URL overrides the probe. This exists for the
 * headless capture harness: it renders through SwiftShader, which the probe
 * (correctly, for a real player) demotes to MEDIUM — but that would mean every
 * visual review judged a mid-tier image and never saw the effects gated to the
 * top tiers. Reviews must look at the image the game is actually trying to
 * produce.
 */
export function autoDetectQuality(renderer) {
  try {
    const forced = new URLSearchParams(location.search).get('quality');
    if (forced && QualityPresets[forced]) return forced;
  } catch { /* no location in a worker/test context */ }
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    if (mobile) return QualityTier.LOW;
    if (/SwiftShader|llvmpipe|Software|Mesa/i.test(name)) return QualityTier.MEDIUM;
    const mem = navigator.deviceMemory || 8;
    if (mem >= 8) return QualityTier.HIGH;
    return QualityTier.MEDIUM;
  } catch {
    return QualityTier.MEDIUM;
  }
}
