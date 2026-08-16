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
    shadowCascades: 4,
    shadowDistance: 140,
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
    showStats: false,
    freeCam: false,
    wireframe: false,
  },
};

/** Pick a starting tier from a cheap capability probe. */
export function autoDetectQuality(renderer) {
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
