import * as THREE from 'three';
import { FullScreenPass } from './PassCore.js';

/**
 * OWNER: rendering / post-processing agent.
 *
 * Final present-time passes, both operating on the display-referred (sRGB
 * encoded) image, which is where they belong perceptually.
 *
 *  - FXAA, used only when TAA is off. It is a spatial-only fallback, so it can
 *    never ghost; the cost is a little softness on sub-pixel detail.
 *  - CAS (contrast-adaptive sharpening). Unlike an unsharp mask, the sharpening
 *    weight is derived from the local min/max so flat regions and already-
 *    contrasty edges are left alone — it recovers the resolve/upscale softness
 *    without producing halos or amplifying grain.
 */
export class Sharpen {
  constructor() {
    this.cas = null;
    this.fxaa = null;
    this.sharpness = 0.45;
  }

  init() {
    this.cas = new FullScreenPass('cas', CAS_FRAG, {
      tColor: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uSharpness: { value: this.sharpness },
    });
    this.fxaa = new FullScreenPass('fxaa', FXAA_FRAG, {
      tColor: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
  }

  resize(w, h) {
    this.cas.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.fxaa.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  renderFxaa(renderer, colorTexture, outTarget) {
    this.fxaa.uniforms.tColor.value = colorTexture;
    this.fxaa.render(renderer, outTarget);
  }

  renderCas(renderer, colorTexture, outTarget) {
    this.cas.uniforms.tColor.value = colorTexture;
    this.cas.uniforms.uSharpness.value = this.sharpness;
    this.cas.render(renderer, outTarget);
  }

  dispose() {
    this.cas?.dispose();
    this.fxaa?.dispose();
  }
}

const CAS_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uSharpness;

vec3 fetch(vec2 o){ return texture(tColor, vUv + o * uTexel).rgb; }

void main(){
  vec3 a = fetch(vec2(-1.0, -1.0));
  vec3 b = fetch(vec2( 0.0, -1.0));
  vec3 c = fetch(vec2( 1.0, -1.0));
  vec3 d = fetch(vec2(-1.0,  0.0));
  vec3 e = fetch(vec2( 0.0,  0.0));
  vec3 f = fetch(vec2( 1.0,  0.0));
  vec3 g = fetch(vec2(-1.0,  1.0));
  vec3 h = fetch(vec2( 0.0,  1.0));
  vec3 i = fetch(vec2( 1.0,  1.0));

  // Cross min/max plus the corner ring: the two-ring estimate is what lets CAS
  // tell a real edge from a lone noisy pixel.
  vec3 mnRGB = min(min(min(d, e), min(f, b)), h);
  vec3 mnRGB2 = min(mnRGB, min(min(a, c), min(g, i)));
  mnRGB += mnRGB2;
  vec3 mxRGB = max(max(max(d, e), max(f, b)), h);
  vec3 mxRGB2 = max(mxRGB, max(max(a, c), max(g, i)));
  mxRGB += mxRGB2;

  vec3 rcpM = 1.0 / max(mxRGB, vec3(1e-4));
  vec3 amp = clamp(min(mnRGB, 2.0 - mxRGB) * rcpM, 0.0, 1.0);
  amp = sqrt(amp);

  float peak = -1.0 / mix(8.0, 5.0, clamp(uSharpness, 0.0, 1.0));
  vec3 w = amp * peak;
  vec3 rcpW = 1.0 / (1.0 + 4.0 * w);
  vec3 outColour = clamp(((b + d + f + h) * w + e) * rcpW, 0.0, 1.0);
  fragColor = vec4(outColour, 1.0);
}
`;

/** Compact FXAA 3.11-style edge resolve, luma from the green channel. */
const FXAA_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tColor;
uniform vec2 uTexel;

#define EDGE_THRESHOLD_MIN 0.0312
#define EDGE_THRESHOLD_MAX 0.125
#define SEARCH_STEPS 10
#define SUBPIXEL 0.75

float lumaOf(vec3 c){ return c.g * 1.963 + c.r * 0.375 + c.b * 0.1200; }

void main(){
  vec2 t = uTexel;
  vec3 rgbM = texture(tColor, vUv).rgb;
  float lM = lumaOf(rgbM);
  float lN = lumaOf(texture(tColor, vUv + vec2(0.0, -t.y)).rgb);
  float lS = lumaOf(texture(tColor, vUv + vec2(0.0,  t.y)).rgb);
  float lW = lumaOf(texture(tColor, vUv + vec2(-t.x, 0.0)).rgb);
  float lE = lumaOf(texture(tColor, vUv + vec2( t.x, 0.0)).rgb);

  float mn = min(lM, min(min(lN, lS), min(lW, lE)));
  float mx = max(lM, max(max(lN, lS), max(lW, lE)));
  float range = mx - mn;
  if (range < max(EDGE_THRESHOLD_MIN, mx * EDGE_THRESHOLD_MAX)) {
    fragColor = vec4(rgbM, 1.0);
    return;
  }

  float lNW = lumaOf(texture(tColor, vUv + vec2(-t.x, -t.y)).rgb);
  float lNE = lumaOf(texture(tColor, vUv + vec2( t.x, -t.y)).rgb);
  float lSW = lumaOf(texture(tColor, vUv + vec2(-t.x,  t.y)).rgb);
  float lSE = lumaOf(texture(tColor, vUv + vec2( t.x,  t.y)).rgb);

  float edgeH = abs(lNW + lNE - 2.0 * lN) * 2.0 + abs(lW + lE - 2.0 * lM) * 4.0 + abs(lSW + lSE - 2.0 * lS) * 2.0;
  float edgeV = abs(lNW + lSW - 2.0 * lW) * 2.0 + abs(lN + lS - 2.0 * lM) * 4.0 + abs(lNE + lSE - 2.0 * lE) * 2.0;
  bool horizontal = edgeH >= edgeV;

  float l1 = horizontal ? lN : lW;
  float l2 = horizontal ? lS : lE;
  float g1 = abs(l1 - lM);
  float g2 = abs(l2 - lM);
  bool steepest = g1 >= g2;
  float stepLen = horizontal ? t.y : t.x;
  if (!steepest) stepLen = -stepLen;

  vec2 currentUv = vUv;
  if (horizontal) currentUv.y += stepLen * 0.5; else currentUv.x += stepLen * 0.5;
  float localAvg = 0.5 * ((steepest ? l1 : l2) + lM);
  float gradScaled = 0.25 * max(g1, g2);

  vec2 offset = horizontal ? vec2(t.x, 0.0) : vec2(0.0, t.y);
  vec2 uv1 = currentUv - offset;
  vec2 uv2 = currentUv + offset;
  float lEnd1 = lumaOf(texture(tColor, uv1).rgb) - localAvg;
  float lEnd2 = lumaOf(texture(tColor, uv2).rgb) - localAvg;
  bool done1 = abs(lEnd1) >= gradScaled;
  bool done2 = abs(lEnd2) >= gradScaled;
  if (!done1) uv1 -= offset;
  if (!done2) uv2 += offset;

  for (int i = 0; i < SEARCH_STEPS; i++) {
    if (done1 && done2) break;
    if (!done1) { lEnd1 = lumaOf(texture(tColor, uv1).rgb) - localAvg; done1 = abs(lEnd1) >= gradScaled; if (!done1) uv1 -= offset * 1.5; }
    if (!done2) { lEnd2 = lumaOf(texture(tColor, uv2).rgb) - localAvg; done2 = abs(lEnd2) >= gradScaled; if (!done2) uv2 += offset * 1.5; }
  }

  float dist1 = horizontal ? (vUv.x - uv1.x) : (vUv.y - uv1.y);
  float dist2 = horizontal ? (uv2.x - vUv.x) : (uv2.y - vUv.y);
  bool dir1 = dist1 < dist2;
  float distMin = min(dist1, dist2);
  float spanLength = dist1 + dist2;
  float pixelOffset = -distMin / max(spanLength, 1e-5) + 0.5;

  bool lumaCentreSmaller = lM < localAvg;
  bool correct = ((dir1 ? lEnd1 : lEnd2) < 0.0) != lumaCentreSmaller;
  float finalOffset = correct ? pixelOffset : 0.0;

  // Sub-pixel term: recovers the aliasing FXAA's edge search cannot see.
  float avg = (1.0 / 12.0) * (2.0 * (lN + lS + lW + lE) + lNW + lNE + lSW + lSE);
  float subPix = clamp(abs(avg - lM) / max(range, 1e-5), 0.0, 1.0);
  subPix = (-2.0 * subPix + 3.0) * subPix * subPix;
  finalOffset = max(finalOffset, subPix * subPix * SUBPIXEL);

  vec2 finalUv = vUv;
  if (horizontal) finalUv.y += finalOffset * stepLen; else finalUv.x += finalOffset * stepLen;
  fragColor = vec4(texture(tColor, finalUv).rgb, 1.0);
}
`;
