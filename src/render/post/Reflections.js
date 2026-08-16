import * as THREE from 'three';
import { FullScreenPass, createRT } from './PassCore.js';

/**
 * OWNER: rendering / post-processing agent.
 *
 * Screen-space reflections for the wet concrete, painted metal and glass in the
 * level. Half-resolution view-space ray march against the prepass depth buffer,
 * with binary refinement on hit, roughness-driven ray perturbation, and a
 * confidence term that fades the result at screen edges, at grazing "reflect
 * back into the camera" angles and past the roughness cutoff.
 *
 * The composite step is the important one: the PBR materials have *already*
 * added an IBL specular lobe, so naively adding SSR on top doubles the energy.
 * Instead only the *difference* between the screen-space hit and what the probe
 * already contributed is added, which makes SSR a replacement for the probe
 * where screen data exists and a clean no-op where it does not.
 */
export class Reflections {
  constructor() {
    this.target = null;
    this.march = null;
    this.resolve = null;

    this.intensity = 1.0;
    this.maxRoughness = 0.62;
    this.thickness = 0.55;   // metres of assumed geometry depth
    this.maxDistance = 42.0;
  }

  init(steps = 40) {
    this.march = new FullScreenPass('ssr-march', MARCH_FRAG, {
      tDepth: { value: null },
      tNormal: { value: null },
      tColor: { value: null },
      uProj: { value: new THREE.Matrix4() },
      uInvProj: { value: new THREE.Matrix4() },
      uJitter: { value: new THREE.Vector2() },
      uTexel: { value: new THREE.Vector2() },
      uThickness: { value: this.thickness },
      uMaxDistance: { value: this.maxDistance },
      uMaxRoughness: { value: this.maxRoughness },
      uFrameNoise: { value: 0 },
    }, { defines: { STEPS: steps, REFINE: 5 } });

    this.resolve = new FullScreenPass('ssr-resolve', RESOLVE_FRAG, {
      tColor: { value: null },
      tSSR: { value: null },
      tNormal: { value: null },
      tDepth: { value: null },
      tEnv: { value: null },
      uHasEnv: { value: 0 },
      uInvProj: { value: new THREE.Matrix4() },
      uCameraMatrix: { value: new THREE.Matrix4() },
      uJitter: { value: new THREE.Vector2() },
      uHalfTexel: { value: new THREE.Vector2() },
      uIntensity: { value: this.intensity },
      uMaxRoughness: { value: this.maxRoughness },
    });
  }

  resize(w, h) {
    this.target?.dispose();
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    this.target = createRT(hw, hh, { name: 'ssr' });
    this.march.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.resolve.uniforms.uHalfTexel.value.set(1 / hw, 1 / hh);
  }

  render(renderer, ctx, colorTexture, outTarget) {
    const m = this.march.uniforms;
    m.tDepth.value = ctx.depthTexture;
    m.tNormal.value = ctx.normalTexture;
    m.tColor.value = colorTexture;
    m.uProj.value.copy(ctx.proj);
    m.uInvProj.value.copy(ctx.invProj);
    m.uJitter.value.copy(ctx.jitterUv);
    m.uThickness.value = this.thickness;
    m.uMaxDistance.value = this.maxDistance;
    m.uMaxRoughness.value = this.maxRoughness;
    m.uFrameNoise.value = ctx.frameNoise;
    this.march.render(renderer, this.target);

    const r = this.resolve.uniforms;
    r.tColor.value = colorTexture;
    r.tSSR.value = this.target.texture;
    r.tNormal.value = ctx.normalTexture;
    r.tDepth.value = ctx.depthTexture;
    r.tEnv.value = ctx.envCube;
    r.uHasEnv.value = ctx.envCube ? 1 : 0;
    r.uInvProj.value.copy(ctx.invProj);
    r.uCameraMatrix.value.copy(ctx.cameraMatrixWorld);
    r.uJitter.value.copy(ctx.jitterUv);
    r.uIntensity.value = this.intensity;
    r.uMaxRoughness.value = this.maxRoughness;
    this.resolve.render(renderer, outTarget);
  }

  dispose() {
    this.target?.dispose();
    this.march?.dispose();
    this.resolve?.dispose();
  }
}

const MARCH_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tColor;
uniform mat4 uProj;
uniform mat4 uInvProj;
uniform vec2 uJitter;
uniform vec2 uTexel;
uniform float uThickness;
uniform float uMaxDistance;
uniform float uMaxRoughness;
uniform float uFrameNoise;

/* view space -> screen uv (jitter re-applied so it lines up with the buffers) */
vec2 project(vec3 v){
  vec4 c = uProj * vec4(v, 1.0);
  return (c.xy / c.w) * 0.5 + 0.5 + uJitter;
}
float sceneViewZ(vec2 uv){
  float d = texture(tDepth, uv).r;
  if (d >= 1.0) return -1e9;
  return viewFromDepth(uv - uJitter, d, uInvProj).z;
}

void main(){
  vec2 uv = vUv;
  vec4 g = texture(tNormal, uv);
  float roughness = g.b;
  float d = texture(tDepth, uv).r;

  // Nothing to reflect off: sky, or a surface too rough for coherent SSR.
  if (d >= 1.0 || roughness > uMaxRoughness) { fragColor = vec4(0.0); return; }

  vec3 P = viewFromDepth(uv - uJitter, d, uInvProj);
  vec3 N = octDecode(g.rg);
  vec3 V = normalize(P);           // camera -> surface
  vec3 R = reflect(V, N);

  // Roughness-aware: perturb the mirror direction inside a cone whose width
  // grows with roughness. TAA (or the resolve blur) integrates the cone.
  vec3 rnd = hash32(gl_FragCoord.xy + uFrameNoise * 17.0) * 2.0 - 1.0;
  float cone = roughness * roughness * 0.55;
  R = normalize(R + rnd * cone);
  if (dot(R, N) < 0.0) R = reflect(R, N);

  // Rays coming back toward the eye have no on-screen data behind them.
  float backFade = clamp(1.0 - dot(R, -V) * 1.15, 0.0, 1.0);
  if (backFade <= 0.001) { fragColor = vec4(0.0); return; }

  float noise = ignoise(gl_FragCoord.xy + uFrameNoise * 3.11);
  float maxDist = uMaxDistance;
  float stepLen = maxDist / float(STEPS);

  vec3 hitPos = vec3(0.0);
  vec2 hitUv = vec2(0.0);
  float hit = 0.0;
  float t = stepLen * (0.35 + noise * 0.65);
  float prevT = 0.0;

  for (int i = 0; i < STEPS; i++) {
    vec3 S = P + R * t;
    if (S.z > -0.02) break;                 // ray passed behind the near plane
    vec2 suv = project(S);
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
    float sz = sceneViewZ(suv);
    if (sz > -1e8) {
      float diff = sz - S.z;                // >0 : ray is behind the surface
      if (diff > 0.0 && diff < uThickness + stepLen * 0.5) {
        // Binary refinement between the last miss and this hit.
        float lo = prevT, hi = t;
        for (int r = 0; r < REFINE; r++) {
          float mid = (lo + hi) * 0.5;
          vec3 M = P + R * mid;
          vec2 muv = project(M);
          float mz = sceneViewZ(muv);
          if (mz > -1e8 && (mz - M.z) > 0.0) hi = mid; else lo = mid;
        }
        vec3 H = P + R * hi;
        hitUv = project(H);
        hitPos = H;
        hit = 1.0;
        break;
      }
    }
    prevT = t;
    // Geometric growth keeps near-field contact reflections crisp while still
    // reaching the far end of the march budget.
    t += stepLen * (1.0 + float(i) * 0.06);
    if (t > maxDist) break;
  }

  if (hit < 0.5) { fragColor = vec4(0.0); return; }

  // Confidence: fade at the screen border, with distance, and by roughness.
  vec2 edge = smoothstep(vec2(0.0), vec2(0.11), hitUv)
            * smoothstep(vec2(0.0), vec2(0.11), 1.0 - hitUv);
  float conf = edge.x * edge.y * backFade;
  conf *= 1.0 - smoothstep(uMaxRoughness * 0.55, uMaxRoughness, roughness);
  conf *= 1.0 - smoothstep(uMaxDistance * 0.6, uMaxDistance, length(hitPos - P));

  vec3 c = texture(tColor, hitUv).rgb;
  // Clamp fireflies: a single blown specular pixel smeared over a rough
  // reflection cone is the classic SSR sparkle.
  c = min(c, vec3(24.0));
  fragColor = vec4(c, conf);
}
`;

const RESOLVE_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tColor;
uniform sampler2D tSSR;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform samplerCube tEnv;
uniform int uHasEnv;
uniform mat4 uInvProj;
uniform mat4 uCameraMatrix;
uniform vec2 uJitter;
uniform vec2 uHalfTexel;
uniform float uIntensity;
uniform float uMaxRoughness;

void main(){
  vec3 colour = texture(tColor, vUv).rgb;
  float d = texture(tDepth, vUv).r;
  vec4 g = texture(tNormal, vUv);
  float roughness = g.b;
  float metalness = g.a;

  if (d >= 1.0 || roughness > uMaxRoughness) { fragColor = vec4(colour, 1.0); return; }

  // 5-tap cross upsample, widened with roughness — a cheap stand-in for a
  // proper pre-filtered reflection mip chain.
  float spread = 1.0 + roughness * 3.0;
  vec4 refl = texture(tSSR, vUv) * 2.0;
  refl += texture(tSSR, vUv + vec2( uHalfTexel.x, 0.0) * spread);
  refl += texture(tSSR, vUv + vec2(-uHalfTexel.x, 0.0) * spread);
  refl += texture(tSSR, vUv + vec2(0.0,  uHalfTexel.y) * spread);
  refl += texture(tSSR, vUv + vec2(0.0, -uHalfTexel.y) * spread);
  refl /= 6.0;

  vec3 P = viewFromDepth(vUv - uJitter, d, uInvProj);
  vec3 N = octDecode(g.rg);
  vec3 V = normalize(-P);
  float NoV = clamp(dot(N, V), 0.0, 1.0);
  vec3 Rv = reflect(-V, N);
  vec3 Rw = normalize((uCameraMatrix * vec4(Rv, 0.0)).xyz);

  // Probe fallback. The sky cube has no mip chain, so roughness is expressed by
  // blending toward the reflection's own hemisphere average rather than a lod.
  vec3 env = vec3(0.0);
  if (uHasEnv == 1) {
    vec3 sharp = texture(tEnv, Rw).rgb;
    vec3 wide = (texture(tEnv, normalize(Rw + vec3(0.35, 0.35, 0.0))).rgb
               + texture(tEnv, normalize(Rw + vec3(-0.35, 0.35, 0.0))).rgb
               + texture(tEnv, normalize(Rw + vec3(0.0, -0.35, 0.35))).rgb) / 3.0;
    env = mix(sharp, wide, clamp(roughness * 1.6, 0.0, 1.0));
  }

  // Metals tint their reflection with their own colour; the shaded pixel is a
  // usable proxy for that tint without a full albedo G-buffer.
  vec3 tint = clamp(colour * 1.4, vec3(0.02), vec3(1.0));
  vec3 F0 = mix(vec3(0.04), tint, metalness);
  float f = pow(1.0 - NoV, 5.0);
  vec3 F = F0 + (max(vec3(1.0 - roughness), F0) - F0) * f;

  float w = refl.a * uIntensity * (1.0 - smoothstep(uMaxRoughness * 0.6, uMaxRoughness, roughness));
  // Replace, do not add: subtract what the IBL probe already put here.
  vec3 delta = (refl.rgb - env) * F * w;
  colour += clamp(delta, vec3(-4.0), vec3(8.0));

  fragColor = vec4(max(colour, vec3(0.0)), 1.0);
}
`;
