/**
 * OWNER: rendering / post-processing agent.
 *
 * A one-object channel between the passes inside `src/render/post` that have to
 * agree on the *same* exposure, but which PostStack drives through different
 * call signatures and so cannot hand a shared context to.
 *
 * Concretely: Bloom's threshold has to be exposure-relative. A fixed threshold
 * in raw scene units means "genuinely blown" is whatever the level author's
 * light rig happens to output, so the same number is a hard clip at noon and a
 * dead pass at dusk — which is exactly how the previous build ended up with a
 * threshold (1.15) sitting above every surface in the frame except the sky.
 * `Bloom.render()` only receives a texture and a size, so the adaptation result
 * arrives here instead.
 *
 * The write happens in `Exposure.render()` and the reads happen in
 * `Bloom.render()` and `ColorGrade.render()`. PostStack's frame order is
 *   ... exposure (step 7) -> bloom (step 9) -> grade (step 10) ...
 * so every reader sees the current frame's value, never a stale one.
 *
 * This is deliberately NOT a general-purpose global. Nothing outside this
 * directory may read or write it; cross-module state goes through `engine.bus`.
 */
export const GradeShared = {
  /**
   * Metering key: the ACES-input value the frame's mask-weighted geometric mean
   * is driven to. Lower than the 0.18 "middle grey" convention on purpose — the
   * geometric mean of a high-contrast exterior sits well below its midtone, and
   * keying to 0.18 is what pushed the whole previous image into the top half of
   * the range. See the tone-curve ladder in LutFactory.js.
   */
  keyValue: 0.15,

  /** 1x1 RG texture: r = adapted luminance, g = focus distance. */
  adaptTexture: null,

  /** renderer.toneMappingExposure at the time the adaptation was resolved. */
  staticExposure: 1.0,
};
