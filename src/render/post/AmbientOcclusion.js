import * as THREE from 'three';
import { FullScreenPass, createRT } from './PassCore.js';

/**
 * OWNER: rendering / post-processing agent.
 *
 * Ground-Truth Ambient Occlusion (Jimenez et al. 2016) — horizon search in
 * screen space with the exact cosine-weighted arc integral, which is what makes
 * it "ground truth" rather than the flat, uniformly-grey look of classic SSAO.
 *
 * TWO SCALES, NOT ONE
 * -------------------
 * A single ~1.15 m search is a *bounce* term: it describes how much of the sky
 * a point can see, and it varies slowly, so it shades the inside of a room and
 * the underside of an awning. It is almost invisible on the thing that actually
 * sells contact — the 5 cm band where a crate meets the floor — because at that
 * scale one metre of horizon search is a gentle gradient and the darkening is
 * spread over 200 screen pixels instead of 8.
 *
 * The previous build had only the wide term, and the reviewers were right that
 * nothing read: crates, pallets and wall/floor junctions had no seat. So the
 * pass now resolves two radii and composites them:
 *
 *   R  bounce   ~1.0-1.25 m, gentle power, intensity just under 1
 *   B  contact  ~0.20 m, hard power, intensity over 1
 *
 * Both come out of one shader invocation because the expensive part of a GTAO
 * slice is the frame construction (two cross products, an acos and a projection
 * per slice), not the depth taps — so the second radius reuses the slice basis
 * and only pays for its own, much shorter, and much more cache-coherent march.
 * The contact term runs at ~60% of the step count for the same reason.
 *
 * Pipeline:
 *   1. half-res GTAO  (R = bounce, G = view-space depth, B = contact)
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

    /** Wide bounce term. PostStack overrides radius/maxRadiusPixels per tier. */
    this.radius = 1.15;          // metres
    this.intensity = 0.92;
    this.power = 1.30;
    this.maxRadiusPixels = 96;

    /**
     * Contact term. Small enough that at 3 m it covers about 20 cm of floor —
     * the width of the dark band under a crate — and clamped in pixels so a
     * surface right under the muzzle does not turn the whole lower frame black.
     */
    this.contactRadius = 0.20;   // metres
    this.contactIntensity = 1.55;
    this.contactPower = 1.75;
    this.maxContactPixels = 52;

    /**
     * Occlusion floor. AO is a visibility term for *ambient* light only, so a
     * fully occluded crevice still receives bounce; letting the product of the
     * two scales reach zero would punch flat holes that no amount of grading
     * can recover.
     */
    this.minVisibility = 0.05;
  }

  init(samples) {
    // Slices trade angular coverage against depth of the horizon search.
    // 3 slices x N steps is the sweet spot the GTAO paper reports.
    const slices = samples >= 28 ? 4 : samples >= 16 ? 3 : 2;
    const steps = Math.max(3, Math.round(samples / slices));
    const contactSteps = Math.max(3, Math.min(steps, Math.round(steps * 0.6)));
    this._slices = slices;
    this._steps = steps;
    this._contactSteps = contactSteps;

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
      uContactRadius: { value: this.contactRadius },
      uMaxContactPixels: { value: this.maxContactPixels },
      uContactPower: { value: this.contactPower },
      uFrameNoise: { value: 0 },
    }, { defines: { SLICES: slices, STEPS: steps, CONTACT_STEPS: contactSteps } });

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
      uContactIntensity: { value: this.contactIntensity },
      uMinVisibility: { value: this.minVisibility },
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
    g.uMaxRadiusPixels.value = this.maxRadiusPixels;
    g.uPower.value = this.power;
    g.uContactRadius.value = this.contactRadius;
    g.uMaxContactPixels.value = this.maxContactPixels;
    g.uContactPower.value = this.contactPower;
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
    u.uContactIntensity.value = this.contactIntensity;
    u.uMinVisibility.value = this.minVisibility;
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
uniform float uContactRadius;
uniform float uMaxContactPixels;
uniform float uContactPower;
uniform float uFrameNoise;

/* Shared per-slice state, built once and marched at both radii. */
struct Slice {
  vec2 dirPx;
  vec3 projNn;
  float projNLen;
  float n;
};

/**
 * One horizon march. stepCount is dynamic so the contact scale can run a
 * shorter loop inside the same shader; the bound is a compile-time constant so
 * the compiler can still unroll.
 */
float marchSlice(Slice sl, vec2 uv, vec3 P, vec3 V, float radiusPixels,
                 float falloffScale, float offsetNoise, int stepCount) {
  float cosHorizon[2];
  cosHorizon[0] = -1.0;
  cosHorizon[1] = -1.0;

  for (int side = 0; side < 2; side++) {
    float sgn = (side == 0) ? -1.0 : 1.0;
    float best = -1.0;
    for (int st = 0; st < STEPS; st++) {
      if (st >= stepCount) break;
      // Quadratic step distribution: dense near the shading point where
      // contact occlusion lives, sparse out at the radius.
      float t = (float(st) + offsetNoise) / float(stepCount);
      t = max(t * t, 1.2 / max(radiusPixels, 2.0));
      vec2 sampleUv = uv + sgn * sl.dirPx * t * radiusPixels * uTexel;
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
  h1 = sl.n + max(h1 - sl.n, -HALF_PI);
  h2 = sl.n + min(h2 - sl.n,  HALF_PI);

  float sinN = sin(sl.n);
  float cosN = cos(sl.n);
  return 0.25 * (-cos(2.0 * h1 - sl.n) + cosN + 2.0 * h1 * sinN)
       + 0.25 * (-cos(2.0 * h2 - sl.n) + cosN + 2.0 * h2 * sinN);
}

void main(){
  vec2 uv = vUv;
  float centreDepth = texture(tDepth, uv).r;
  // Sky: unoccluded at BOTH scales. Writing 0 in B here would make the contact
  // term read as fully occluded sky after the bilateral upsample.
  if (centreDepth >= 1.0) { fragColor = vec4(1.0, -60000.0, 1.0, 1.0); return; }

  vec3 P = viewFromDepth(uv - uJitter, centreDepth, uInvProj);
  vec3 N = octDecode(texture(tNormal, uv).rg);
  vec3 V = normalize(-P);

  // World radius -> screen radius. uProjScale = 0.5 * height * proj[1][1].
  float viewZ = max(0.05, -P.z);
  float radiusPixels = min(uRadius * uProjScale / viewZ, uMaxRadiusPixels);
  float contactPixels = min(uContactRadius * uProjScale / viewZ, uMaxContactPixels);
  bool doBounce = radiusPixels >= 1.5;
  bool doContact = contactPixels >= 1.5;
  if (!doBounce && !doContact) { fragColor = vec4(1.0, P.z, 1.0, 1.0); return; }

  float noise = ignoise(gl_FragCoord.xy + uFrameNoise * 7.53);
  float offsetNoise = hash12(gl_FragCoord.xy + uFrameNoise * 13.17);

  // Distance falloff: samples beyond the radius must not create a hard edge,
  // so their horizon contribution is faded back toward "unoccluded". Each scale
  // gets its own, or the contact march would be graded against a metre.
  float bounceFalloff = 1.0 / max(uRadius * uRadius, 1e-4);
  float contactFalloff = 1.0 / max(uContactRadius * uContactRadius, 1e-6);

  float visBounce = 0.0;
  float visContact = 0.0;
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

    Slice sl;
    sl.dirPx = dirPx;
    sl.projNn = projN / projNLen;
    sl.projNLen = projNLen;
    float cosN = clamp(dot(sl.projNn, V), -1.0, 1.0);
    sl.n = (dot(sl.projNn, tangent) >= 0.0 ? 1.0 : -1.0) * acos(cosN);

    visBounce += projNLen * (doBounce
      ? marchSlice(sl, uv, P, V, radiusPixels, bounceFalloff, offsetNoise, STEPS)
      : 1.0);
    visContact += projNLen * (doContact
      ? marchSlice(sl, uv, P, V, contactPixels, contactFalloff, offsetNoise, CONTACT_STEPS)
      : 1.0);
    weightSum += projNLen;
  }

  float ao = 1.0;
  float contact = 1.0;
  if (weightSum > 1e-5) {
    ao = pow(clamp(visBounce / weightSum, 0.0, 1.0), uPower);
    contact = pow(clamp(visContact / weightSum, 0.0, 1.0), uContactPower);
  }
  fragColor = vec4(ao, P.z, contact, 1.0);
}
`;

const BLUR_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tAO;
uniform vec2 uTexel;
uniform vec2 uDir;

void main(){
  vec3 centre = texture(tAO, vUv).rgb;
  float z0 = centre.y;
  // Sky pixels carry a sentinel depth; leave them alone.
  if (z0 < -5e4) { fragColor = vec4(centre, 1.0); return; }

  // Gaussian sigma ~2 texels, gated by a depth term so the blur never crosses
  // a silhouette (that is what turns AO into a grey halo). Both scales ride the
  // same weights so the contact band keeps the same edges as the bounce.
  const float w[5] = float[5](0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);
  vec2 sum = centre.xz * w[0];
  float wsum = w[0];
  float depthSigma = max(0.06, abs(z0) * 0.035);

  for (int i = 1; i < 5; i++) {
    for (int s = 0; s < 2; s++) {
      vec2 o = uDir * uTexel * float(i) * (s == 0 ? 1.0 : -1.0);
      vec3 t = texture(tAO, vUv + o).rgb;
      if (t.y < -5e4) continue;
      float dz = abs(t.y - z0) / depthSigma;
      float bw = w[i] * exp(-dz * dz);
      sum += t.xz * bw;
      wsum += bw;
    }
  }
  sum /= max(wsum, 1e-5);
  fragColor = vec4(sum.x, z0, sum.y, 1.0);
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
uniform float uContactIntensity;
uniform float uMinVisibility;

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

  vec2 ao2 = vec2(0.0);
  float wsum = 0.0;
  float sigma = max(0.05, abs(z) * 0.05);
  for (int i = 0; i < 4; i++) {
    vec3 t = texture(tAO, base + off[i]).rgb;
    float dz = (t.y - z) / sigma;
    float w = bw[i] * exp(-dz * dz) + 1e-5;
    ao2 += t.xz * w;
    wsum += w;
  }
  ao2 = clamp(ao2 / wsum, 0.0, 1.0);

  // Two scales, composited. Intensity is applied to the *occlusion* rather than
  // by lerping toward white, so the contact term can legitimately exceed 1 and
  // bite harder than a physical visibility integral would — which is exactly
  // what makes an object look like it is resting on the floor.
  float aoBounce  = clamp(1.0 - (1.0 - ao2.x) * uIntensity, 0.0, 1.0);
  float aoContact = clamp(1.0 - (1.0 - ao2.y) * uContactIntensity, 0.0, 1.0);
  float ao = max(aoBounce * aoContact, uMinVisibility);

  // AO is an *indirect* visibility term. Applying it flat also darkens direct
  // sun and speculars, which reads as dirt. The threshold has to sit above the
  // brightest *diffuse* surface in the frame, though: at the previous 0.9 it
  // was cutting into sunlit paint and stripping the contact shadows off the one
  // surface the reviewers were looking at. Only a genuine specular or an
  // emissive is this bright.
  float l = luma(colour);
  float direct = clamp((l - 8.0) * 0.05, 0.0, 0.6);
  ao = mix(ao, 1.0, direct);

  // Occluded regions keep sky-bounce colour rather than going flat black: the
  // shadowed value is nudged cool, which is what a real overcast bounce does.
  vec3 occluded = colour * ao;
  occluded *= mix(vec3(1.0), vec3(0.92, 0.97, 1.08), (1.0 - ao) * 0.6);
  fragColor = vec4(occluded, 1.0);
}
`;
