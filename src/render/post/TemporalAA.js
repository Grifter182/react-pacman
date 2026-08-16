import * as THREE from 'three';
import { FullScreenPass, createRT } from './PassCore.js';

/** Radical-inverse Halton sequence — the standard TAA sample distribution. */
export function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/**
 * OWNER: rendering / post-processing agent.
 *
 * Temporal anti-aliasing.
 *
 *  - The projection matrix is jittered on a 16-sample Halton(2,3) sequence by
 *    PostStack; this pass only resolves. Camera code never sees the jitter.
 *  - History is fetched with a 5-tap Catmull-Rom filter. Plain bilinear history
 *    is the single biggest cause of "TAA looks blurry".
 *  - Motion vectors are dilated to the closest-depth pixel of a 3x3 cross, so
 *    silhouettes fetch the history of the object rather than the background.
 *  - History is clipped, not clamped, to the AABB of the 3x3 neighbourhood in
 *    YCoCg. Clipping toward the current colour keeps far more history alive
 *    than clamping per channel, which is what stops the image from crawling.
 *  - Disocclusion is detected from the linear view depth carried in the alpha
 *    channel of the history buffer: if the surface that was at the reprojected
 *    texel is not at the depth we are shading now, the history is thrown away.
 *
 * The alpha channel of the output is the current linear view depth, which makes
 * the history buffer self-describing and costs no extra target.
 */
export class TemporalAA {
  constructor() {
    this.history = [null, null];
    this.index = 0;
    this.resolve = null;
    this.sampleIndex = 0;
    this.sampleCount = 16;
    this.feedback = 0.92;
    this._valid = false;
  }

  init() {
    this.resolve = new FullScreenPass('taa-resolve', TAA_FRAG, {
      tCurrent: { value: null },
      tHistory: { value: null },
      tDepth: { value: null },
      tVelocity: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uInvProj: { value: new THREE.Matrix4() },
      uJitter: { value: new THREE.Vector2() },
      uCameraMatrix: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uFeedback: { value: this.feedback },
      uClampScale: { value: 1.25 },
      uCameraShift: { value: 0.0 },
      uValid: { value: 0 },
    });
  }

  resize(w, h) {
    for (let i = 0; i < 2; i++) {
      this.history[i]?.dispose();
      this.history[i] = createRT(w, h, { name: `taa-history-${i}` });
    }
    this.resolve.uniforms.uTexel.value.set(1 / w, 1 / h);
    this._valid = false;
  }

  /** Jitter offset in NDC for the current frame. */
  jitter(out, w, h) {
    const i = (this.sampleIndex % this.sampleCount) + 1;
    const jx = (halton(i, 2) - 0.5) * 2.0 / w;
    const jy = (halton(i, 3) - 0.5) * 2.0 / h;
    out.set(jx, jy);
    return out;
  }

  advance() { this.sampleIndex = (this.sampleIndex + 1) % this.sampleCount; }

  /** @returns {THREE.Texture} the resolved colour */
  render(renderer, ctx, currentTexture) {
    const read = this.history[this.index];
    const write = this.history[this.index ^ 1];
    const u = this.resolve.uniforms;
    u.tCurrent.value = currentTexture;
    u.tHistory.value = read.texture;
    u.tDepth.value = ctx.depthTexture;
    u.tVelocity.value = ctx.velocityTexture;
    u.uInvProj.value.copy(ctx.invProj);
    u.uJitter.value.copy(ctx.jitterUv);
    u.uCameraMatrix.value.copy(ctx.cameraMatrixWorld);
    u.uPrevViewProj.value.copy(ctx.prevViewProj);
    // Feedback is a per-frame blend weight, so the history's effective
    // exposure time is dt/(1-feedback). Tuned at 60Hz, 0.92 means ~200ms of
    // accumulation; at a 160ms frame that becomes two full seconds and the
    // image smears into paste. Hold the exposure time constant instead of the
    // blend weight, so a slow frame trusts history proportionally less.
    const dt = Math.max(ctx.dt || 1 / 60, 1e-4);
    const targetExposure = (1 / 60) / (1 - this.feedback);
    u.uFeedback.value = THREE.MathUtils.clamp(1 - dt / targetExposure, 0.5, this.feedback);
    u.uCameraShift.value = ctx.cameraShift;
    u.uValid.value = this._valid ? 1 : 0;
    this.resolve.render(renderer, write);
    this.index ^= 1;
    this._valid = true;
    return write.texture;
  }

  dispose() {
    this.history[0]?.dispose();
    this.history[1]?.dispose();
    this.resolve?.dispose();
  }
}

const TAA_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tDepth;
uniform sampler2D tVelocity;
uniform vec2 uTexel;
uniform mat4 uInvProj;
uniform vec2 uJitter;
uniform mat4 uCameraMatrix;
uniform mat4 uPrevViewProj;
uniform float uFeedback;
uniform float uClampScale;
uniform float uCameraShift;
uniform int uValid;

/* Sky and any pixel the prepass skipped has no motion vector of its own; its
   motion is recovered analytically by reprojecting the depth through last
   frame's view-projection. */
vec2 velocityAt(vec2 uv, float d){
  if (d < 0.999999) return texture(tVelocity, uv).rg;
  vec3 vp = viewFromDepth(uv - uJitter, d, uInvProj);
  vec4 wp = uCameraMatrix * vec4(vp, 1.0);
  vec4 pc = uPrevViewProj * wp;
  if (pc.w <= 1e-6) return vec2(0.0);
  return uv - uJitter - ((pc.xy / pc.w) * 0.5 + 0.5);
}

/* Catmull-Rom, 5 bilinear taps (Filmic SMAA / Jimenez optimisation). */
vec3 sampleHistory(vec2 uv, out float outDepth){
  vec2 texSize = 1.0 / uTexel;
  vec2 samplePos = uv * texSize;
  vec2 tc1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - tc1;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;

  vec2 w0 = f2 - 0.5 * (f3 + f);
  vec2 w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
  vec2 w3 = 0.5 * (f3 - f2);
  vec2 w2 = 1.0 - w0 - w1 - w3;
  vec2 w12 = w1 + w2;
  vec2 tc0 = (tc1 - 1.0) * uTexel;
  vec2 tc3 = (tc1 + 2.0) * uTexel;
  vec2 tc12 = (tc1 + w2 / max(w12, vec2(1e-5))) * uTexel;

  vec4 c = vec4(0.0);
  c += texture(tHistory, vec2(tc12.x, tc0.y))  * (w12.x * w0.y);
  c += texture(tHistory, vec2(tc0.x,  tc12.y)) * (w0.x  * w12.y);
  vec4 centre = texture(tHistory, vec2(tc12.x, tc12.y));
  c += centre * (w12.x * w12.y);
  c += texture(tHistory, vec2(tc3.x,  tc12.y)) * (w3.x  * w12.y);
  c += texture(tHistory, vec2(tc12.x, tc3.y))  * (w12.x * w3.y);
  float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  outDepth = centre.a;
  return max(c.rgb / max(wsum, 1e-5), vec3(0.0));
}

/* Clip the history toward the current colour until it enters the neighbourhood
   AABB — far less history loss than a per-channel clamp. */
vec3 clipToAABB(vec3 mn, vec3 mx, vec3 current, vec3 history){
  vec3 centre = 0.5 * (mx + mn);
  vec3 extent = 0.5 * (mx - mn) + 1e-5;
  vec3 v = history - centre;
  vec3 unit = abs(v / extent);
  float ma = max(unit.x, max(unit.y, unit.z));
  return (ma > 1.0) ? (centre + v / ma) : history;
}

void main(){
  vec2 uv = vUv;
  vec3 current = max(texture(tCurrent, uv).rgb, vec3(0.0));

  // --- dilate the motion vector to the closest surface in a 3x3 cross ------
  float d = texture(tDepth, uv).r;
  vec2 bestUv = uv;
  float bestDepth = d;
  for (int i = 0; i < 4; i++) {
    vec2 o = (i == 0) ? vec2(-1.0, -1.0) : (i == 1) ? vec2(1.0, -1.0)
           : (i == 2) ? vec2(-1.0, 1.0) : vec2(1.0, 1.0);
    vec2 nUv = uv + o * uTexel;
    float nd = texture(tDepth, nUv).r;
    if (nd < bestDepth) { bestDepth = nd; bestUv = nUv; }
  }
  vec2 velocity = velocityAt(bestUv, bestDepth);
  vec2 histUv = uv - velocity;

  if (uValid == 0 || histUv.x < 0.0 || histUv.x > 1.0 || histUv.y < 0.0 || histUv.y > 1.0) {
    float z = (d >= 1.0) ? -1e4 : viewFromDepth(uv - uJitter, d, uInvProj).z;
    fragColor = vec4(current, z);
    return;
  }

  float histDepth;
  vec3 history = sampleHistory(histUv, histDepth);

  // --- neighbourhood statistics in YCoCg ----------------------------------
  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  vec3 mn = vec3(1e9);
  vec3 mx = vec3(-1e9);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 s = rgbToYCoCg(max(texture(tCurrent, uv + vec2(float(x), float(y)) * uTexel).rgb, vec3(0.0)));
      m1 += s;
      m2 += s * s;
      mn = min(mn, s);
      mx = max(mx, s);
    }
  }
  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3(0.0)));
  // Variance clipping intersected with the hard min/max: variance alone is too
  // loose on single-pixel highlights, min/max alone is too tight on noise.
  vec3 lo = max(mean - sigma * uClampScale, mn);
  vec3 hi = min(mean + sigma * uClampScale, mx);

  vec3 curY = rgbToYCoCg(current);
  vec3 histY = rgbToYCoCg(history);
  vec3 clipped = clipToAABB(lo, hi, curY, histY);
  float clipDist = length(clipped - histY) / max(length(sigma) + 1e-3, 1e-3);
  history = max(yCoCgToRgb(clipped), vec3(0.0));

  // --- disocclusion ---------------------------------------------------------
  float z = (d >= 1.0) ? -1e4 : viewFromDepth(uv - uJitter, d, uInvProj).z;
  float weight = uFeedback;
  if (d < 1.0 && histDepth < -1e-3 && histDepth > -9e3) {
    // Tolerance grows with distance and with how far the camera travelled this
    // frame, so translation alone never counts as a disocclusion.
    float tol = abs(z) * 0.06 + uCameraShift * 1.6 + 0.05;
    float mismatch = clamp((abs(histDepth - z) - tol) / max(tol, 1e-3), 0.0, 1.0);
    weight *= 1.0 - mismatch;
  }
  // Fast motion halves the history weight: sub-pixel history is unreliable when
  // a texel moves several pixels per frame.
  float speed = length(velocity / uTexel);
  weight *= mix(1.0, 0.72, clamp(speed * 0.04, 0.0, 1.0));
  // Heavy clipping means the history disagreed; trust it less.
  weight *= mix(1.0, 0.55, clamp(clipDist * 0.25, 0.0, 1.0));

  // Karis luminance weighting: blending in 1/(1+L) space stops bright pixels
  // from dominating the average and creating temporal shimmer.
  float wc = (1.0 - weight) / (1.0 + luma(current));
  float wh = weight / (1.0 + luma(history));
  vec3 result = (current * wc + history * wh) / max(wc + wh, 1e-5);

  fragColor = vec4(max(result, vec3(0.0)), z);
}
`;
