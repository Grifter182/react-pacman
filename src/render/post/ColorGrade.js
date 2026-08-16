import * as THREE from 'three';
import { FullScreenPass } from './PassCore.js';
import { GradeShared } from './GradeShared.js';

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
 *   aerial-perspective recovery                (see below)
 *   + bloom + anamorphic streak + lens dirt   (light scattered in the lens)
 *   x auto exposure                            (sensor sensitivity)
 *   -> ACES filmic tonemap                     (sensor response)
 *   -> sRGB encode                             (into the display domain)
 *   -> 3D LUT creative grade                   (the colourist's pass)
 *   -> lift / gamma / gain, saturation         (final trim)
 *   + film grain, vignette                     (film/lens)
 *
 * Doing the LUT before the tonemap would grade HDR values the LUT has no domain
 * for; doing the vignette before exposure would make it get auto-compensated
 * away. Lens artefacts are last and subtle by design.
 *
 * WHY THE ENCODE HAPPENS BEFORE THE LUT
 * -------------------------------------
 * The cube is 33^3 and 8-bit. Sampled in linear light its first two slices sit
 * at 0.000 and 0.031, and 0.031 linear is 49/255 on screen: the entire toe of
 * the image is a straight line between two samples, and the stored values are
 * quantised to 1/255 *linear*, which is four display stops of banding down
 * there. Encoding first spends the cube where the eye is. Everything after the
 * lookup is therefore display-referred, including the grain and the vignette,
 * which is where both of them belong physically anyway.
 *
 * AERIAL-PERSPECTIVE RECOVERY
 * ---------------------------
 * The atmosphere pass mixes every fragment toward the sky's inscatter colour:
 * `c' = c*T + I*(1-T)`. That is the correct physics and it is also, exactly, a
 * low-pass filter applied to the two things the eye uses to tell one material
 * from another — local contrast and chroma are BOTH multiplied by T, while the
 * mean level is dragged toward I. Past about 40 m on this map T is low enough
 * that a brick facade, a plaster facade and a corrugated roof arrive at the
 * same flat tan, so the midground and the background stop being separate
 * planes and become one wash.
 *
 * The fix is not less fog. Less fog removes the depth cue as well. What this
 * does instead is put back the AC component and the chroma in proportion to how
 * much haze a pixel is behind, and leave the *mean* exactly where the fog put
 * it. The distance cue (things get lighter, bluer and lower-contrast with
 * range) survives in full; what comes back is material identity.
 *
 * It runs in linear light before bloom, because it is conceptually a partial
 * inverse of an extinction that also happened in linear light, and because
 * sharpening the bloom would be a lens artefact sharpening itself. Sky
 * fragments (depth == 1) are excluded — the sky IS the inscatter reference and
 * there is nothing behind it to recover.
 *
 * The radius is deliberately wider than the sharpen pass at the end of the
 * chain: this works the 2-3 px band where a distant window reveal or a course
 * of brick lives, the sharpen works the 1 px acutance band, and they do not
 * fight.
 *
 * There is no unconditional lift in this pass. The previous build added
 * (0.004, 0.008, 0.018) on top of a LUT that was itself lifting, and the two
 * together put the floor of every frame at RGB(32,56,74). If a look ever needs
 * a lifted black again it belongs in the LUT's toe, once, where it can be seen.
 */
export class ColorGrade {
  constructor() {
    this.pass = null;
    this.bloomIntensity = 0.16;
    this.streakIntensity = 0.05;
    this.dirtIntensity = 1.6;
    this.chromatic = 0.0022;
    /**
     * Aerial-perspective recovery. See the class comment.
     *   near/far  metres over which the recovery ramps in. Nothing inside 22 m
     *             is touched — that geometry is not hazed and does not need it.
     *   contrast  gain on the recovered local (2-3 px) detail at full range.
     *   chroma    saturation gain at full range, which is what puts material
     *             identity back into a distant wall.
     *   radius    high-pass radius in pixels at 1080p-ish; kept clear of the
     *             sharpen pass's 1 px band.
     */
    this.aerialNear = 22.0;
    this.aerialFar = 105.0;
    this.aerialContrast = 0.62;
    this.aerialChroma = 0.34;
    this.aerialRadius = 2.4;
    /**
     * Grain was 0.030 across the whole midtone range, which on an image that
     * had no real detail in it read as compression noise rather than as film
     * stock — and once material detail lands, noise at that level eats it.
     * A third of that, weighted into the shadows where silver halide actually
     * clumps, and gated off entirely at the very bottom so it cannot lift a
     * true black back off zero.
     */
    this.grain = 0.011;
    this.vignette = 0.30;
    this.saturation = 1.0;
    this.exposureCompensation = 1.0;
    this.lift = new THREE.Vector3(0, 0, 0);
    this.gamma = new THREE.Vector3(1, 1, 1);
    this.gain = new THREE.Vector3(1, 1, 1);
  }

  /** The key the metering drives the frame's geometric mean to. */
  get keyValue() { return GradeShared.keyValue; }
  set keyValue(v) { GradeShared.keyValue = v; }

  init(lut, lutSize, dirt) {
    this.pass = new FullScreenPass('grade', GRADE_FRAG, {
      tColor: { value: null },
      tBloom: { value: null },
      tStreak: { value: null },
      tDirt: { value: dirt },
      tLut: { value: lut },
      tAdapt: { value: null },
      tDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uHasDepth: { value: 0 },
      uAerial: { value: new THREE.Vector4(
        this.aerialNear, this.aerialFar, this.aerialContrast, this.aerialChroma) },
      uAerialRadius: { value: this.aerialRadius },
      uLutSize: { value: lutSize },
      uTexel: { value: new THREE.Vector2() },
      uKeyValue: { value: GradeShared.keyValue },
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
    // The prepass is optional; without it there is no depth and the recovery
    // simply does not run, rather than running against a 1x1 black texture.
    const depth = ctx.depthTexture;
    const hasDepth = !!depth && depth !== ctx.blackTexture;
    u.tDepth.value = depth || ctx.blackTexture;
    u.uHasDepth.value = hasDepth ? 1 : 0;
    if (hasDepth) u.uInvProj.value.copy(ctx.invProj);
    u.uAerial.value.set(
      this.aerialNear, Math.max(this.aerialNear + 1, this.aerialFar),
      this.aerialContrast, this.aerialChroma);
    u.uAerialRadius.value = this.aerialRadius;
    u.uHasBloom.value = bloomTexture ? 1 : 0;
    u.uHasAdapt.value = ctx.adaptTexture ? 1 : 0;
    u.uStaticExposure.value = ctx.staticExposure;
    u.uKeyValue.value = GradeShared.keyValue;
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
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform int uHasDepth;
uniform vec4 uAerial;        // x near m, y far m, z contrast gain, w chroma gain
uniform float uAerialRadius; // px
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

/* The cube's axes are sRGB-encoded — see the class comment. */
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

  // --- aerial-perspective recovery -----------------------------------------
  // Put back the local contrast and the chroma the fog's mix scaled away,
  // in proportion to range, without touching the mean level the fog set. The
  // sky (depth == 1) is the inscatter reference and is left alone.
  if (uHasDepth == 1) {
    float d = texture(tDepth, uv).x;
    if (d < 1.0) {
      float dist = -viewFromDepth(uv, d, uInvProj).z;
      float aerial = smoothstep(uAerial.x, uAerial.y, dist);
      if (aerial > 0.002) {
        vec2 r = uTexel * uAerialRadius;
        // Diagonal 4-tap: one bilinear box per corner, no axis bias, and it
        // costs four samples instead of the nine a separable blur would.
        vec3 lo = ( texture(tColor, uv + vec2( r.x,  r.y)).rgb
                  + texture(tColor, uv + vec2(-r.x,  r.y)).rgb
                  + texture(tColor, uv + vec2( r.x, -r.y)).rgb
                  + texture(tColor, uv + vec2(-r.x, -r.y)).rgb ) * 0.25;
        colour = max(colour + (colour - max(lo, vec3(0.0))) * (uAerial.z * aerial), vec3(0.0));
        float lu = luma(colour);
        colour = max(mix(vec3(lu), colour, 1.0 + uAerial.w * aerial), vec3(0.0));
      }
    }
  }

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
  colour *= clamp(exposure, 0.02, 40.0);

  // --- tonemap, then into the display domain --------------------------------
  colour = aces(colour);
  vec3 disp = srgbEncode(colour);

  // --- creative grade -------------------------------------------------------
  disp = applyLut(disp);

  // Final trim (ASC-CDL ordering: offset, then power, then slope). All three
  // are identities by default — the look lives in the LUT, in one place.
  disp = clamp(disp + uLift * (1.0 - disp), 0.0, 1.0);
  disp = pow(max(disp, vec3(1e-5)), uGamma);
  disp *= uGain;

  float l = luma(disp);
  disp = clamp(mix(vec3(l), disp, uSaturation), 0.0, 1.0);

  // --- film grain -----------------------------------------------------------
  // Weighted into the shadows, where film grain actually lives, and gated to
  // zero over the bottom few code values so it can never put a floor under a
  // true black. Highlights keep about a fifth of it so they are not glassy.
  float g = hash12(gl_FragCoord.xy + fract(uTime) * 719.7) - 0.5;
  float shadowWeight = 1.0 - smoothstep(0.03, 0.55, l);
  float grainAmount = uGrain * (0.22 + 1.05 * shadowWeight) * smoothstep(0.0, 0.030, l);
  disp += g * grainAmount;

  // --- vignette: natural (cos^4-ish) falloff, not a black ring --------------
  // Applied display-referred, so the exponent converts the linear-light falloff
  // this constant was authored as into the same perceptual falloff.
  float v = 1.0 - uVignette * pow(clamp(r2 * 2.05, 0.0, 1.0), 1.45);
  disp *= pow(max(v, 0.0), 0.4545);

  fragColor = vec4(clamp(disp, 0.0, 1.0), 1.0);
}
`;
