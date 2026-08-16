import * as THREE from 'three';
import { FullScreenPass } from './PassCore.js';

/**
 * OWNER: rendering / post-processing agent.
 *
 * The single tone-mapping + grading + lens-artefact pass. Everything that
 * happens to a pixel after the scene is resolved and before sharpening lives
 * here, in one shader, because every one of these operations is a cheap ALU op
 * on a value that is already in registers — splitting them into separate passes
 * would cost far more in bandwidth than it saves in flexibility.
 *
 * Order matters and is not negotiable:
 *
 *   chromatic aberration  (a lens property: it must sample the *scene*)
 *   + bloom + anamorphic streak + lens dirt   (light scattered in the lens)
 *   x auto exposure                            (sensor sensitivity)
 *   -> ACES filmic tonemap                     (sensor response)
 *   -> 3D LUT creative grade                   (the colourist's pass)
 *   -> lift / gamma / gain, saturation         (final trim)
 *   + film grain, vignette                     (film/lens, display referred)
 *   -> sRGB encode
 *
 * Doing the LUT before the tonemap would grade HDR values the LUT has no domain
 * for; doing the vignette before exposure would make it get auto-compensated
 * away. Lens artefacts are last and subtle by design.
 */
export class ColorGrade {
  constructor() {
    this.pass = null;
    this.bloomIntensity = 0.055;
    this.streakIntensity = 0.030;
    this.dirtIntensity = 1.6;
    this.chromatic = 0.0022;
    this.grain = 0.030;
    this.vignette = 0.34;
    this.saturation = 1.02;
    this.exposureCompensation = 1.0;
    this.lift = new THREE.Vector3(0.004, 0.008, 0.018);
    this.gamma = new THREE.Vector3(1.0, 1.0, 1.02);
    this.gain = new THREE.Vector3(1.02, 1.0, 0.985);
  }

  init(lut, lutSize, dirt) {
    this.pass = new FullScreenPass('grade', GRADE_FRAG, {
      tColor: { value: null },
      tBloom: { value: null },
      tStreak: { value: null },
      tDirt: { value: dirt },
      tLut: { value: lut },
      tAdapt: { value: null },
      uLutSize: { value: lutSize },
      uTexel: { value: new THREE.Vector2() },
      uKeyValue: { value: 0.16 },
      uExposureComp: { value: this.exposureCompensation },
      uBloom: { value: this.bloomIntensity },
      uStreak: { value: this.streakIntensity },
      uDirt: { value: this.dirtIntensity },
      uChromatic: { value: this.chromatic },
      uGrain: { value: this.grain },
      uVignette: { value: this.vignette },
      uSaturation: { value: this.saturation },
      uLift: { value: this.lift },
      uGamma: { value: this.gamma },
      uGain: { value: this.gain },
      uTime: { value: 0 },
      uSunScreen: { value: new THREE.Vector3(0.5, 0.5, 0) },
      uHasBloom: { value: 1 },
      uHasAdapt: { value: 1 },
      uStaticExposure: { value: 1.0 },
    });
  }

  resize(w, h) { this.pass.uniforms.uTexel.value.set(1 / w, 1 / h); }

  render(renderer, ctx, colorTexture, bloomTexture, streakTexture, outTarget) {
    const u = this.pass.uniforms;
    u.tColor.value = colorTexture;
    u.tBloom.value = bloomTexture || ctx.blackTexture;
    u.tStreak.value = streakTexture || ctx.blackTexture;
    u.tAdapt.value = ctx.adaptTexture || ctx.blackTexture;
    u.uHasBloom.value = bloomTexture ? 1 : 0;
    u.uHasAdapt.value = ctx.adaptTexture ? 1 : 0;
    u.uStaticExposure.value = ctx.staticExposure;
    u.uExposureComp.value = this.exposureCompensation;
    u.uBloom.value = this.bloomIntensity;
    u.uStreak.value = this.streakIntensity;
    u.uDirt.value = this.dirtIntensity;
    u.uChromatic.value = this.chromatic;
    u.uGrain.value = this.grain;
    u.uVignette.value = this.vignette;
    u.uSaturation.value = this.saturation;
    u.uTime.value = ctx.time;
    u.uSunScreen.value.copy(ctx.sunScreen);
    this.pass.render(renderer, outTarget);
  }

  dispose() { this.pass?.dispose(); }
}

const GRADE_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tStreak;
uniform sampler2D tDirt;
uniform sampler2D tAdapt;
uniform highp sampler3D tLut;
uniform float uLutSize;
uniform vec2 uTexel;
uniform float uKeyValue;
uniform float uExposureComp;
uniform float uBloom;
uniform float uStreak;
uniform float uDirt;
uniform float uChromatic;
uniform float uGrain;
uniform float uVignette;
uniform float uSaturation;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform float uTime;
uniform vec3 uSunScreen;
uniform int uHasBloom;
uniform int uHasAdapt;
uniform float uStaticExposure;

/* ACES filmic, Stephen Hill's RRT+ODT fit. */
const mat3 ACESInput = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);
const mat3 ACESOutput = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);
vec3 rrt(vec3 v){
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c){ return clamp(ACESOutput * rrt(ACESInput * max(c, vec3(0.0))), 0.0, 1.0); }

vec3 applyLut(vec3 c){
  // Half-texel inset: without it the two end slices of the cube are clamped
  // and the extreme blacks/whites get pulled toward their neighbours.
  float scale = (uLutSize - 1.0) / uLutSize;
  float offset = 1.0 / (2.0 * uLutSize);
  return texture(tLut, clamp(c, 0.0, 1.0) * scale + offset).rgb;
}

void main(){
  vec2 uv = vUv;
  vec2 fromCentre = uv - 0.5;
  float r2 = dot(fromCentre, fromCentre);

  // --- chromatic aberration: transverse only, so the centre stays perfectly
  // sharp and only the corners separate, exactly like a real lens ------------
  float ca = uChromatic * smoothstep(0.045, 0.28, r2);
  vec3 colour;
  if (ca > 1e-6) {
    colour.r = texture(tColor, uv - fromCentre * ca).r;
    colour.g = texture(tColor, uv).g;
    colour.b = texture(tColor, uv + fromCentre * ca).b;
  } else {
    colour = texture(tColor, uv).rgb;
  }
  colour = max(colour, vec3(0.0));

  // --- lens scatter ---------------------------------------------------------
  if (uHasBloom == 1) {
    vec3 bloom = texture(tBloom, uv).rgb;
    vec3 streak = texture(tStreak, uv).rgb;
    float dirt = texture(tDirt, uv).r;

    // Dirt only lights up where there is real energy behind it, and hardest
    // around the sun — which is what makes a dirty lens read as dirty *glass*
    // rather than as a texture stuck to the screen.
    vec2 sunDelta = (uv - uSunScreen.xy) * vec2(1.0, 0.62);
    float sunProx = uSunScreen.z * exp(-dot(sunDelta, sunDelta) * 7.0);
    float dirtGain = dirt * (0.25 + sunProx * 3.5);

    colour += bloom * uBloom * (1.0 + dirtGain * uDirt);
    colour += streak * uStreak;
  }

  // --- exposure -------------------------------------------------------------
  float exposure = uStaticExposure;
  if (uHasAdapt == 1) {
    float avg = max(texture(tAdapt, vec2(0.5)).r, 1e-4);
    exposure *= uKeyValue / avg;
  }
  exposure *= uExposureComp;
  colour *= clamp(exposure, 0.05, 24.0);

  // --- tonemap + creative grade --------------------------------------------
  colour = aces(colour);
  colour = applyLut(colour);

  // Lift / gamma / gain (ASC-CDL ordering: offset, then power, then slope).
  colour = clamp(colour + uLift * (1.0 - colour), 0.0, 1.0);
  colour = pow(max(colour, vec3(1e-5)), uGamma);
  colour *= uGain;

  float l = luma(colour);
  colour = clamp(mix(vec3(l), colour, uSaturation), 0.0, 1.0);

  // --- film grain: scaled by luminance so highlights stay clean and shadows
  // carry the noise, which is how real film stock behaves -------------------
  float g = hash12(gl_FragCoord.xy + fract(uTime) * 719.7) - 0.5;
  float grainAmount = uGrain * (0.35 + 1.0 * (1.0 - smoothstep(0.0, 0.75, l))) * (0.4 + 0.6 * smoothstep(0.0, 0.12, l));
  colour += g * grainAmount;

  // --- vignette: natural (cos^4-ish) falloff, not a black ring --------------
  float v = 1.0 - uVignette * pow(clamp(r2 * 2.05, 0.0, 1.0), 1.45);
  colour *= v;

  fragColor = vec4(srgbEncode(max(colour, vec3(0.0))), 1.0);
}
`;
