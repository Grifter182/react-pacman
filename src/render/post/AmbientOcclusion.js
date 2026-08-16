import * as THREE from 'three';
import { FullScreenPass, createRT } from './PassCore.js';

/**
 * OWNER: rendering / post-processing agent.
 *
 * Ground-Truth Ambient Occlusion (Jimenez et al. 2016) — horizon search in
 * screen space with the exact cosine-weighted arc integral, which is what makes
 * it "ground truth" rather than the flat, uniformly-grey look of classic SSAO.
 *
 * Pipeline:
 *   1. half-res GTAO  (R = visibility, G = view-space depth, for the blur)
 *   2. separable bilateral blur, depth-weighted so contact shadows keep edges
 *   3. full-res composite with a depth-aware (joint bilateral) upsample
 *
 * Noise is rotated per frame when TAA is on, so the temporal resolve converts
 * the remaining sampling noise into extra effective samples; with TAA off the
 * rotation is frozen to avoid a visible boil.
 */
export class AmbientOcclusion {
  constructor() {
    this.aoTarget = null;
    this.tmpTarget = null;
    this.gtao = null;
    this.blurH = null;
    this.blurV = null;
    this.apply = null;
    this._slices = 0;
    this._steps = 0;

    this.radius = 1.15;          // metres
    this.intensity = 1.0;
    this.power = 1.5;
    this.maxRadiusPixels = 96;
  }

  init(samples) {
    // Slices trade angular coverage against depth of the horizon search.
    // 3 slices x N steps is the sweet spot the GTAO paper reports.
    const slices = samples >= 28 ? 4 : samples >= 16 ? 3 : 2;
    const steps = Math.max(3, Math.round(samples / slices));
    this._slices = slices;
    this._steps = steps;

    this.gtao = new FullScreenPass('gtao', GTAO_FRAG, {
      tDepth: { value: null },
      tNormal: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uJitter: { value: new THREE.Vector2() },
      uTexel: { value: new THREE.Vector2() },       // full-res texel size
      uProjScale: { value: 500.0 },
      uRadius: { value: this.radius },
      uMaxRadiusPixels: { value: this.maxRadiusPixels },
      uPower: { value: this.power },
      uFrameNoise: { value: 0 },
    }, { defines: { SLICES: slices, STEPS: steps } });

    this.blurH = new FullScreenPass('gtao-blur-h', BLUR_FRAG, {
      tAO: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uDir: { value: new THREE.Vector2(1, 0) },
    });
    this.blurV = new FullScreenPass('gtao-blur-v', BLUR_FRAG, {
      tAO: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uDir: { value: new THREE.Vector2(0, 1) },
    });

    this.apply = new FullScreenPass('gtao-apply', APPLY_FRAG, {
      tColor: { value: null },
      tAO: { value: null },
      tDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uJitter: { value: new THREE.Vector2() },
      uHalfTexel: { value: new THREE.Vector2() },
      uIntensity: { value: this.intensity },
    });
  }

  resize(w, h) {
    this.aoTarget?.dispose();
    this.tmpTarget?.dispose();
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    const opts = { format: THREE.RGBAFormat, type: THREE.HalfFloatType, name: 'gtao' };
    this.aoTarget = createRT(hw, hh, opts);
    this.tmpTarget = createRT(hw, hh, opts);
    this.gtao.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.blurH.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    this.blurV.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    this.apply.uniforms.uHalfTexel.value.set(1 / hw, 1 / hh);
  }

  /**
   * @returns {THREE.Texture} the blurred half-res AO buffer
   */
  render(renderer, ctx) {
    const g = this.gtao.uniforms;
    g.tDepth.value = ctx.depthTexture;
    g.tNormal.value = ctx.normalTexture;
    g.uInvProj.value.copy(ctx.invProj);
    g.uJitter.value.copy(ctx.jitterUv);
    g.uProjScale.value = ctx.projScale;
    g.uRadius.value = this.radius;
    g.uPower.value = this.power;
    g.uFrameNoise.value = ctx.frameNoise;
    this.gtao.render(renderer, this.aoTarget);

    this.blurH.uniforms.tAO.value = this.aoTarget.texture;
    this.blurH.render(renderer, this.tmpTarget);
    this.blurV.uniforms.tAO.value = this.tmpTarget.texture;
    this.blurV.render(renderer, this.aoTarget);

    return this.aoTarget.texture;
  }

  /** Multiply AO into the HDR colour buffer with a depth-aware upsample. */
  composite(renderer, ctx, colorTexture, outTarget) {
    const u = this.apply.uniforms;
    u.tColor.value = colorTexture;
    u.tAO.value = this.aoTarget.texture;
    u.tDepth.value = ctx.depthTexture;
    u.uInvProj.value.copy(ctx.invProj);
    u.uJitter.value.copy(ctx.jitterUv);
    u.uIntensity.value = this.intensity;
    this.apply.render(renderer, outTarget);
  }

  dispose() {
    this.aoTarget?.dispose();
    this.tmpTarget?.dispose();
    this.gtao?.dispose();
    this.blurH?.dispose();
    this.blurV?.dispose();
    this.apply?.dispose();
  }
}

const GTAO_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform mat4 uInvProj;
uniform vec2 uJitter;
uniform vec2 uTexel;
uniform float uProjScale;
uniform float uRadius;
uniform float uMaxRadiusPixels;
uniform float uPower;
uniform float uFrameNoise;

void main(){
  vec2 uv = vUv;
  float centreDepth = texture(tDepth, uv).r;
  if (centreDepth >= 1.0) { fragColor = vec4(1.0, -60000.0, 0.0, 1.0); return; }

  vec3 P = viewFromDepth(uv - uJitter, centreDepth, uInvProj);
  vec3 N = octDecode(texture(tNormal, uv).rg);
  vec3 V = normalize(-P);

  // World radius -> screen radius. uProjScale = 0.5 * height * proj[1][1].
  float radiusPixels = min(uRadius * uProjScale / max(0.05, -P.z), uMaxRadiusPixels);
  if (radiusPixels < 1.5) { fragColor = vec4(1.0, P.z, 0.0, 1.0); return; }

  float noise = ignoise(gl_FragCoord.xy + uFrameNoise * 7.53);
  float offsetNoise = hash12(gl_FragCoord.xy + uFrameNoise * 13.17);

  // Distance falloff: samples beyond the radius must not create a hard edge,
  // so their horizon contribution is faded back toward "unoccluded".
  float falloffScale = 1.0 / (uRadius * uRadius);

  float visibility = 0.0;
  float weightSum = 0.0;

  for (int s = 0; s < SLICES; s++) {
    float phi = (float(s) + noise) * (PI / float(SLICES));
    vec2 dirPx = vec2(cos(phi), sin(phi));

    // Build the slice frame. tangent points along +dirPx in view space, so a
    // positive angle in this slice means "toward +dirPx on screen".
    vec3 sliceDir = vec3(dirPx, 0.0);
    vec3 planeNormal = normalize(cross(sliceDir, V));
    vec3 tangent = cross(V, planeNormal);

    vec3 projN = N - planeNormal * dot(N, planeNormal);
    float projNLen = length(projN);
    if (projNLen < 1e-4) continue;
    vec3 projNn = projN / projNLen;

    float cosN = clamp(dot(projNn, V), -1.0, 1.0);
    float n = (dot(projNn, tangent) >= 0.0 ? 1.0 : -1.0) * acos(cosN);

    float cosHorizon[2];
    cosHorizon[0] = -1.0;
    cosHorizon[1] = -1.0;

    for (int side = 0; side < 2; side++) {
      float sgn = (side == 0) ? -1.0 : 1.0;
      float best = -1.0;
      for (int st = 0; st < STEPS; st++) {
        // Quadratic step distribution: dense near the shading point where
        // contact occlusion lives, sparse out at the radius.
        float t = (float(st) + offsetNoise) / float(STEPS);
        t = max(t * t, 1.2 / max(radiusPixels, 2.0));
        vec2 sampleUv = uv + sgn * dirPx * t * radiusPixels * uTexel;
        if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) break;
        float sd = texture(tDepth, sampleUv).r;
        if (sd >= 1.0) continue;
        vec3 S = viewFromDepth(sampleUv - uJitter, sd, uInvProj);
        vec3 D = S - P;
        float dist2 = dot(D, D);
        float cosA = dot(D, V) * inversesqrt(max(dist2, 1e-8));
        float falloff = clamp(1.0 - dist2 * falloffScale, 0.0, 1.0);
        best = max(best, mix(-1.0, cosA, falloff));
      }
      cosHorizon[side] = best;
    }

    float h1 = -acos(clamp(cosHorizon[0], -1.0, 1.0));
    float h2 =  acos(clamp(cosHorizon[1], -1.0, 1.0));
    // Clamp each horizon into the normal-oriented hemisphere.
    h1 = n + max(h1 - n, -HALF_PI);
    h2 = n + min(h2 - n,  HALF_PI);

    float sinN = sin(n);
    float arc = 0.25 * (-cos(2.0 * h1 - n) + cos(n) + 2.0 * h1 * sinN)
              + 0.25 * (-cos(2.0 * h2 - n) + cos(n) + 2.0 * h2 * sinN);

    visibility += projNLen * arc;
    weightSum += projNLen;
  }

  float ao = (weightSum > 1e-5) ? clamp(visibility / weightSum, 0.0, 1.0) : 1.0;
  ao = pow(ao, uPower);
  fragColor = vec4(ao, P.z, 0.0, 1.0);
}
`;

const BLUR_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tAO;
uniform vec2 uTexel;
uniform vec2 uDir;

void main(){
  vec2 centre = texture(tAO, vUv).rg;
  float z0 = centre.y;
  // Sky pixels carry a sentinel depth; leave them alone.
  if (z0 < -5e4) { fragColor = vec4(centre, 0.0, 1.0); return; }

  // Gaussian sigma ~2 texels, gated by a depth term so the blur never crosses
  // a silhouette (that is what turns AO into a grey halo).
  const float w[5] = float[5](0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);
  float sum = centre.x * w[0];
  float wsum = w[0];
  float depthSigma = max(0.06, abs(z0) * 0.035);

  for (int i = 1; i < 5; i++) {
    for (int s = 0; s < 2; s++) {
      vec2 o = uDir * uTexel * float(i) * (s == 0 ? 1.0 : -1.0);
      vec2 t = texture(tAO, vUv + o).rg;
      if (t.y < -5e4) continue;
      float dz = abs(t.y - z0) / depthSigma;
      float bw = w[i] * exp(-dz * dz);
      sum += t.x * bw;
      wsum += bw;
    }
  }
  fragColor = vec4(sum / max(wsum, 1e-5), z0, 0.0, 1.0);
}
`;

const APPLY_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tColor;
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform vec2 uJitter;
uniform vec2 uHalfTexel;
uniform float uIntensity;

void main(){
  vec3 colour = texture(tColor, vUv).rgb;
  float d = texture(tDepth, vUv).r;
  if (d >= 1.0) { fragColor = vec4(colour, 1.0); return; }

  float z = viewFromDepth(vUv - uJitter, d, uInvProj).z;

  // Joint-bilateral upsample: bilinear weights x depth similarity. Without the
  // depth term the half-res AO bleeds one full-res pixel past every silhouette.
  vec2 f = fract(vUv / uHalfTexel - 0.5);
  vec2 base = (floor(vUv / uHalfTexel - 0.5) + 0.5) * uHalfTexel;
  float bw[4];
  bw[0] = (1.0 - f.x) * (1.0 - f.y);
  bw[1] = f.x * (1.0 - f.y);
  bw[2] = (1.0 - f.x) * f.y;
  bw[3] = f.x * f.y;
  vec2 off[4];
  off[0] = vec2(0.0, 0.0);
  off[1] = vec2(uHalfTexel.x, 0.0);
  off[2] = vec2(0.0, uHalfTexel.y);
  off[3] = uHalfTexel;

  float ao = 0.0;
  float wsum = 0.0;
  float sigma = max(0.05, abs(z) * 0.05);
  for (int i = 0; i < 4; i++) {
    vec2 t = texture(tAO, base + off[i]).rg;
    float dz = (t.y - z) / sigma;
    float w = bw[i] * exp(-dz * dz) + 1e-5;
    ao += t.x * w;
    wsum += w;
  }
  ao = clamp(ao / wsum, 0.0, 1.0);
  ao = mix(1.0, ao, uIntensity);

  // AO is an *indirect* visibility term. Applying it flat also darkens direct
  // sun and speculars, which reads as dirt. Scaling the occlusion back on very
  // bright pixels approximates "the sun is not occluded here" for free.
  float l = luma(colour);
  float direct = clamp((l - 0.9) * 0.55, 0.0, 0.75);
  ao = mix(ao, 1.0, direct);

  // Occluded regions keep sky-bounce colour rather than going flat black: the
  // shadowed value is nudged cool, which is what a real overcast bounce does.
  vec3 occluded = colour * ao;
  occluded *= mix(vec3(1.0), vec3(0.92, 0.97, 1.08), (1.0 - ao) * 0.6);
  fragColor = vec4(occluded, 1.0);
}
`;
