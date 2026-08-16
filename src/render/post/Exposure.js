import * as THREE from 'three';
import { FullScreenPass, createRT } from './PassCore.js';
import { GradeShared } from './GradeShared.js';

/**
 * OWNER: rendering / post-processing agent.
 *
 * Automatic exposure (eye adaptation) plus auto-focus, both resolved entirely
 * on the GPU — no readback, so no pipeline stall.
 *
 * The scene luminance is reduced to a 1x1 geometric mean through a log-space
 * mip chain (log space is what makes the average perceptual rather than
 * dominated by the single brightest window in frame), with a mildly
 * centre-weighted metering mask. The result is adapted with an exponential
 * curve — faster when the frame gets brighter than when it gets darker, as the
 * eye does.
 *
 * PARTIAL ADAPTATION — the thing that makes an interior look like an interior
 * ------------------------------------------------------------------------
 * A textbook auto-exposure drives the frame's geometric mean to a fixed key,
 * which means it renders a black cellar and a white street at *identical*
 * midtones. That is a correct light meter and a terrible camera: it deletes the
 * largest depth and mood cue an FPS frame has, and it is why the previous build
 * could put a doorway and the alley behind it at the same value.
 *
 * So the metered luminance is compressed toward a fixed anchor before the key
 * is divided by it:
 *
 *     adapted = anchor * (metered / anchor) ^ ADAPT_STRENGTH
 *
 * At ADAPT_STRENGTH = 1 this is the textbook behaviour. At 0 there is no
 * adaptation at all and the exposure is fixed. At 0.68 a scene eight times
 * darker gets only 8^0.68 = 4.1x more exposure, so it still renders about
 * twice as dark on screen — the room reads as a room, and stepping out into the
 * street still lifts, just not all the way. Absolute clamps at both ends stop
 * the pathological cases (staring into a wall, staring at the sun) from
 * running away.
 *
 * The same 1x1 buffer carries the smoothed auto-focus distance in .g, sampled
 * from the depth buffer under the crosshair. Depth of field reads it from here.
 */
export class Exposure {
  constructor() {
    this.chain = [];
    this.adapt = [null, null];
    this.index = 0;
    this.logPass = null;
    this.downPass = null;
    this.adaptPass = null;

    /**
     * Range is deliberately much wider than the old [0.012, 7.5]: that band is
     * under nine stops, narrow enough that a shaded interior hit the floor and
     * a sunlit exterior hit the ceiling, at which point the two ends of the
     * level were being metered by a clamp rather than by their content.
     */
    this.minLuminance = 0.0035;
    this.maxLuminance = 42.0;

    /** Scene luminance the exposure is anchored to. See the class comment. */
    this.anchorLuminance = 0.22;
    /** 1 = full adaptation (everything renders at the same midtone), 0 = none. */
    this.adaptStrength = 0.68;

    this.speedUp = 2.4;      // 1/s toward a brighter frame
    this.speedDown = 0.9;    // 1/s toward a darker frame
    this._primed = false;
  }

  /** The key the grade meters to. Single source of truth for the whole chain. */
  get keyValue() { return GradeShared.keyValue; }
  set keyValue(v) { GradeShared.keyValue = v; }

  init() {
    this.logPass = new FullScreenPass('lum-log', LOG_FRAG, {
      tColor: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.downPass = new FullScreenPass('lum-down', DOWN_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.adaptPass = new FullScreenPass('adapt', ADAPT_FRAG, {
      tLum: { value: null },
      tPrev: { value: null },
      tDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uJitter: { value: new THREE.Vector2() },
      uDt: { value: 0.016 },
      uMin: { value: this.minLuminance },
      uMax: { value: this.maxLuminance },
      uAnchor: { value: this.anchorLuminance },
      uAdaptStrength: { value: this.adaptStrength },
      uSpeedUp: { value: this.speedUp },
      uSpeedDown: { value: this.speedDown },
      uPrimed: { value: 0 },
    });

    const opts = { format: THREE.RGBAFormat, type: THREE.HalfFloatType, name: 'lum' };
    let s = 64;
    while (s >= 1) {
      this.chain.push(createRT(s, s, opts));
      s >>= 1;
    }
    this.adapt[0] = createRT(1, 1, { ...opts, filter: THREE.NearestFilter, name: 'adapt-0' });
    this.adapt[1] = createRT(1, 1, { ...opts, filter: THREE.NearestFilter, name: 'adapt-1' });
  }

  resize(w, h) {
    this.logPass.uniforms.uTexel.value.set(1 / w, 1 / h);
    this._primed = false;
  }

  /** @returns {THREE.Texture} 1x1 (r = adapted luminance, g = focus distance) */
  render(renderer, ctx, colorTexture) {
    this.logPass.uniforms.tColor.value = colorTexture;
    this.logPass.render(renderer, this.chain[0]);
    for (let i = 1; i < this.chain.length; i++) {
      this.downPass.uniforms.tSrc.value = this.chain[i - 1].texture;
      this.downPass.uniforms.uTexel.value.set(1 / this.chain[i - 1].width, 1 / this.chain[i - 1].height);
      this.downPass.render(renderer, this.chain[i]);
    }

    const read = this.adapt[this.index];
    const write = this.adapt[this.index ^ 1];
    const u = this.adaptPass.uniforms;
    u.tLum.value = this.chain[this.chain.length - 1].texture;
    u.tPrev.value = read.texture;
    u.tDepth.value = ctx.depthTexture;
    u.uInvProj.value.copy(ctx.invProj);
    u.uJitter.value.copy(ctx.jitterUv);
    u.uDt.value = Math.min(ctx.dt, 0.1);
    u.uMin.value = this.minLuminance;
    u.uMax.value = this.maxLuminance;
    u.uAnchor.value = this.anchorLuminance;
    u.uAdaptStrength.value = this.adaptStrength;
    u.uSpeedUp.value = this.speedUp;
    u.uSpeedDown.value = this.speedDown;
    u.uPrimed.value = this._primed ? 1 : 0;
    this.adaptPass.render(renderer, write);
    this.index ^= 1;
    this._primed = true;

    // Published for Bloom, which PostStack calls without a context object and
    // which needs the same exposure to threshold against. See GradeShared.js.
    GradeShared.adaptTexture = write.texture;
    GradeShared.staticExposure = ctx.staticExposure;

    return write.texture;
  }

  dispose() {
    for (const t of this.chain) t.dispose();
    this.chain.length = 0;
    this.adapt[0]?.dispose();
    this.adapt[1]?.dispose();
    this.logPass?.dispose();
    this.downPass?.dispose();
    this.adaptPass?.dispose();
    if (GradeShared.adaptTexture) GradeShared.adaptTexture = null;
  }
}

const LOG_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tColor;
uniform vec2 uTexel;

void main(){
  vec2 o = uTexel * 1.5;
  vec3 c = texture(tColor, vUv + vec2(-o.x, -o.y)).rgb
         + texture(tColor, vUv + vec2( o.x, -o.y)).rgb
         + texture(tColor, vUv + vec2(-o.x,  o.y)).rgb
         + texture(tColor, vUv + vec2( o.x,  o.y)).rgb;
  float l = luma(c * 0.25);

  // Mild centre weighting. It used to fall to 0.35 at the frame edge, which is
  // a portrait meter: in a corridor shot the walls filling the outer two thirds
  // of frame were being discounted to a third of their weight, so the meter saw
  // mostly the bright doorway ahead and stopped down the room the player is
  // standing in. 0.55 still protects against a sky-filled top third without
  // deciding the exposure from a sixth of the image.
  vec2 d = (vUv - 0.5) * vec2(1.0, 1.15);
  float mask = mix(0.55, 1.0, 1.0 - smoothstep(0.10, 0.55, dot(d, d)));

  // log-average -> geometric mean once the chain collapses to 1x1.
  fragColor = vec4(log(max(l, 1e-4)) * mask, mask, 0.0, 1.0);
}
`;

const DOWN_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tSrc;
uniform vec2 uTexel;
void main(){
  vec2 o = uTexel * 0.5;
  vec4 c = texture(tSrc, vUv + vec2(-o.x, -o.y))
         + texture(tSrc, vUv + vec2( o.x, -o.y))
         + texture(tSrc, vUv + vec2(-o.x,  o.y))
         + texture(tSrc, vUv + vec2( o.x,  o.y));
  fragColor = c * 0.25;
}
`;

const ADAPT_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tLum;
uniform sampler2D tPrev;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform vec2 uJitter;
uniform float uDt;
uniform float uMin;
uniform float uMax;
uniform float uAnchor;
uniform float uAdaptStrength;
uniform float uSpeedUp;
uniform float uSpeedDown;
uniform int uPrimed;

void main(){
  vec2 lum = texture(tLum, vec2(0.5)).rg;
  float metered = clamp(exp(lum.r / max(lum.g, 1e-3)), uMin, uMax);

  // Partial adaptation: compress the metered value toward the anchor so a dark
  // interior does not get pulled up to the same midtone as an open street.
  // pow() in log form so the exponent is doing the compressing, not a lerp
  // (a lerp in linear luminance is a lerp in the wrong space and collapses at
  // the dark end, where every stop matters most).
  float target = uAnchor * exp(log(max(metered, 1e-5) / uAnchor) * uAdaptStrength);
  target = clamp(target, uMin, uMax);

  // Auto-focus: depth under the crosshair, clamped to a sane weapon-range band.
  float cd = texture(tDepth, vec2(0.5)).r;
  float focusTarget = (cd >= 1.0) ? 60.0
    : clamp(-viewFromDepth(vec2(0.5) - uJitter, cd, uInvProj).z, 0.4, 70.0);

  vec2 prev = texture(tPrev, vec2(0.5)).rg;
  if (uPrimed == 0) { fragColor = vec4(target, focusTarget, 0.0, 1.0); return; }

  float prevLum = clamp(prev.r, uMin, uMax);
  float speed = (target > prevLum) ? uSpeedUp : uSpeedDown;
  // Frame-rate independent exponential approach.
  float k = 1.0 - exp(-uDt * speed);
  float adapted = clamp(prevLum + (target - prevLum) * k, uMin, uMax);

  float prevFocus = (prev.g > 0.01) ? prev.g : focusTarget;
  float focus = prevFocus + (focusTarget - prevFocus) * (1.0 - exp(-uDt * 6.5));

  fragColor = vec4(adapted, focus, 0.0, 1.0);
}
`;
