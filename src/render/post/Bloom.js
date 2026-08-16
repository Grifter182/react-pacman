import * as THREE from 'three';
import { FullScreenPass, createRT } from './PassCore.js';

/**
 * OWNER: rendering / post-processing agent.
 *
 * Energy-preserving progressive dual-filter bloom (the CoD:AW / Jimenez
 * "next generation post processing" chain).
 *
 * Downsample uses the 13-tap partial-Karis-average filter: the four 2x2 groups
 * are weighted by 1/(1+luma) *before* they are combined, which is what stops a
 * single blown pixel from flickering into a firefly when the camera moves.
 * Upsample uses a 3x3 tent and accumulates additively into the next-larger mip,
 * so the final result is a proper sum of octaves rather than one fat gaussian.
 *
 * The threshold is a soft knee applied only in the first downsample. It is
 * deliberately high and the final intensity deliberately low: bloom here is
 * lens scatter around genuinely bright things, not a glow filter.
 */
export class Bloom {
  constructor() {
    this.mips = [];
    this.streakA = null;
    this.streakB = null;
    this.prefilter = null;
    this.down = null;
    this.up = null;
    this.streak = null;

    this.threshold = 1.15;
    this.knee = 0.6;
    this.radius = 0.85;      // upsample tent spread in texels
  }

  init(mipCount) {
    this._mipCount = Math.max(2, Math.min(8, mipCount | 0));

    this.prefilter = new FullScreenPass('bloom-prefilter', PREFILTER_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: this.threshold },
      uKnee: { value: this.knee },
    });
    this.down = new FullScreenPass('bloom-down', DOWN_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.up = new FullScreenPass('bloom-up', UP_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: this.radius },
    }, { blending: THREE.AdditiveBlending, transparent: true });
    this.streak = new FullScreenPass('bloom-streak', STREAK_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uStride: { value: 1.0 },
      uTint: { value: new THREE.Vector3(0.55, 0.72, 1.0) },
    });
  }

  resize(w, h) {
    for (const m of this.mips) m.dispose();
    this.mips.length = 0;
    let mw = w, mh = h;
    for (let i = 0; i < this._mipCount; i++) {
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      this.mips.push(createRT(mw, mh, { name: `bloom-${i}` }));
      if (mw <= 2 || mh <= 2) break;
    }
    this.streakA?.dispose();
    this.streakB?.dispose();
    const s = this.mips[Math.min(1, this.mips.length - 1)];
    this.streakA = createRT(s.width, s.height, { name: 'streak-a' });
    this.streakB = createRT(s.width, s.height, { name: 'streak-b' });
  }

  /**
   * @returns {{bloom: THREE.Texture, streak: THREE.Texture}}
   */
  render(renderer, srcTexture, srcW, srcH) {
    const mips = this.mips;
    if (mips.length === 0) return { bloom: null, streak: null };

    // --- prefilter + downsample chain --------------------------------------
    this.prefilter.uniforms.tSrc.value = srcTexture;
    this.prefilter.uniforms.uTexel.value.set(1 / srcW, 1 / srcH);
    this.prefilter.uniforms.uThreshold.value = this.threshold;
    this.prefilter.uniforms.uKnee.value = this.knee;
    this.prefilter.render(renderer, mips[0]);

    for (let i = 1; i < mips.length; i++) {
      this.down.uniforms.tSrc.value = mips[i - 1].texture;
      this.down.uniforms.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      this.down.render(renderer, mips[i]);
    }

    // --- anamorphic streak, taken off a mid mip so it stays wide and soft ---
    const si = Math.min(1, mips.length - 1);
    this.streak.uniforms.tSrc.value = mips[si].texture;
    this.streak.uniforms.uTexel.value.set(1 / this.streakA.width, 1 / this.streakA.height);
    this.streak.uniforms.uStride.value = 1.0;
    this.streak.uniforms.uTint.value.set(1, 1, 1);
    this.streak.render(renderer, this.streakA);
    this.streak.uniforms.tSrc.value = this.streakA.texture;
    this.streak.uniforms.uStride.value = 7.0;   // second octave -> ~7x reach
    this.streak.uniforms.uTint.value.set(0.55, 0.72, 1.0);
    this.streak.render(renderer, this.streakB);

    // --- progressive upsample, additive into the larger mip -----------------
    for (let i = mips.length - 1; i > 0; i--) {
      this.up.uniforms.tSrc.value = mips[i].texture;
      this.up.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      this.up.uniforms.uRadius.value = this.radius;
      this.up.render(renderer, mips[i - 1]);
    }

    return { bloom: mips[0].texture, streak: this.streakB.texture };
  }

  dispose() {
    for (const m of this.mips) m.dispose();
    this.mips.length = 0;
    this.streakA?.dispose();
    this.streakB?.dispose();
    this.prefilter?.dispose();
    this.down?.dispose();
    this.up?.dispose();
    this.streak?.dispose();
  }
}

/** Karis-averaged 13-tap box + soft-knee threshold. */
const PREFILTER_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;

vec3 fetch(vec2 uv){ return min(texture(tSrc, uv).rgb, vec3(64.0)); }
float karisWeight(vec3 c){ return 1.0 / (1.0 + luma(c)); }

void main(){
  vec2 t = uTexel;
  vec3 a = fetch(vUv + t * vec2(-2.0,  2.0));
  vec3 b = fetch(vUv + t * vec2( 0.0,  2.0));
  vec3 c = fetch(vUv + t * vec2( 2.0,  2.0));
  vec3 d = fetch(vUv + t * vec2(-2.0,  0.0));
  vec3 e = fetch(vUv);
  vec3 f = fetch(vUv + t * vec2( 2.0,  0.0));
  vec3 g = fetch(vUv + t * vec2(-2.0, -2.0));
  vec3 h = fetch(vUv + t * vec2( 0.0, -2.0));
  vec3 i = fetch(vUv + t * vec2( 2.0, -2.0));
  vec3 j = fetch(vUv + t * vec2(-1.0,  1.0));
  vec3 k = fetch(vUv + t * vec2( 1.0,  1.0));
  vec3 l = fetch(vUv + t * vec2(-1.0, -1.0));
  vec3 m = fetch(vUv + t * vec2( 1.0, -1.0));

  // Group into five 2x2 boxes, weight each by its own Karis average.
  vec3 g0 = (j + k + l + m) * 0.25;
  vec3 g1 = (a + b + d + e) * 0.25;
  vec3 g2 = (b + c + e + f) * 0.25;
  vec3 g3 = (d + e + g + h) * 0.25;
  vec3 g4 = (e + f + h + i) * 0.25;
  float w0 = karisWeight(g0) * 0.5;
  float w1 = karisWeight(g1) * 0.125;
  float w2 = karisWeight(g2) * 0.125;
  float w3 = karisWeight(g3) * 0.125;
  float w4 = karisWeight(g4) * 0.125;
  vec3 colour = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4)
              / max(w0 + w1 + w2 + w3 + w4, 1e-5);

  // Soft-knee threshold (Unity/Jimenez curve): quadratic ramp through the knee
  // so the bloom boundary is not a visible contour.
  float br = max(colour.r, max(colour.g, colour.b));
  float knee = uThreshold * uKnee;
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-5);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
  fragColor = vec4(colour * contrib, 1.0);
}
`;

const DOWN_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tSrc;
uniform vec2 uTexel;
vec3 fetch(vec2 uv){ return texture(tSrc, uv).rgb; }
void main(){
  vec2 t = uTexel;
  vec3 a = fetch(vUv + t * vec2(-2.0,  2.0));
  vec3 b = fetch(vUv + t * vec2( 0.0,  2.0));
  vec3 c = fetch(vUv + t * vec2( 2.0,  2.0));
  vec3 d = fetch(vUv + t * vec2(-2.0,  0.0));
  vec3 e = fetch(vUv);
  vec3 f = fetch(vUv + t * vec2( 2.0,  0.0));
  vec3 g = fetch(vUv + t * vec2(-2.0, -2.0));
  vec3 h = fetch(vUv + t * vec2( 0.0, -2.0));
  vec3 i = fetch(vUv + t * vec2( 2.0, -2.0));
  vec3 j = fetch(vUv + t * vec2(-1.0,  1.0));
  vec3 k = fetch(vUv + t * vec2( 1.0,  1.0));
  vec3 l = fetch(vUv + t * vec2(-1.0, -1.0));
  vec3 m = fetch(vUv + t * vec2( 1.0, -1.0));
  // Weights sum to exactly 1 -> the chain is energy preserving.
  vec3 o = (j + k + l + m) * 0.125;
  o += (a + b + d + e) * 0.03125;
  o += (b + c + e + f) * 0.03125;
  o += (d + e + g + h) * 0.03125;
  o += (e + f + h + i) * 0.03125;
  fragColor = vec4(o, 1.0);
}
`;

const UP_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
void main(){
  vec2 t = uTexel * uRadius;
  vec3 o = texture(tSrc, vUv + vec2(-t.x,  t.y)).rgb * 1.0;
  o += texture(tSrc, vUv + vec2( 0.0,  t.y)).rgb * 2.0;
  o += texture(tSrc, vUv + vec2( t.x,  t.y)).rgb * 1.0;
  o += texture(tSrc, vUv + vec2(-t.x,  0.0)).rgb * 2.0;
  o += texture(tSrc, vUv).rgb * 4.0;
  o += texture(tSrc, vUv + vec2( t.x,  0.0)).rgb * 2.0;
  o += texture(tSrc, vUv + vec2(-t.x, -t.y)).rgb * 1.0;
  o += texture(tSrc, vUv + vec2( 0.0, -t.y)).rgb * 2.0;
  o += texture(tSrc, vUv + vec2( t.x, -t.y)).rgb * 1.0;
  fragColor = vec4(o * (1.0 / 16.0), 1.0);
}
`;

/**
 * Horizontal-only gaussian, run twice with an increasing stride so two cheap
 * passes cover ~50 texels. Slightly blue-tinted, which is what a real
 * anamorphic front element does to its flare.
 */
const STREAK_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uStride;
uniform vec3 uTint;
void main(){
  const float w[4] = float[4](0.383, 0.242, 0.061, 0.006);
  vec3 o = texture(tSrc, vUv).rgb * w[0];
  for (int i = 1; i < 4; i++) {
    float dx = uTexel.x * uStride * float(i) * 2.0;
    o += texture(tSrc, vUv + vec2(dx, 0.0)).rgb * w[i];
    o += texture(tSrc, vUv - vec2(dx, 0.0)).rgb * w[i];
  }
  fragColor = vec4(o * uTint, 1.0);
}
`;
