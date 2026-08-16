import * as THREE from 'three';
import { FullScreenPass, createRT } from './PassCore.js';

/**
 * OWNER: rendering / post-processing agent.
 *
 * Automatic exposure (eye adaptation) plus auto-focus, both resolved entirely
 * on the GPU — no readback, so no pipeline stall.
 *
 * The scene luminance is reduced to a 1x1 geometric mean through a log-space
 * mip chain (log space is what makes the average perceptual rather than
 * dominated by the single brightest window in frame), with a centre-weighted
 * metering mask so a bright sky does not crush the corridor you are standing
 * in. The result is then adapted with an exponential curve — faster when the
 * frame gets brighter than when it gets darker, as the eye does — and hard
 * clamped at both ends so the image can never pump.
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

    this.keyValue = 0.16;
    this.minLuminance = 0.012;
    this.maxLuminance = 7.5;
    this.speedUp = 2.4;      // 1/s toward a brighter frame
    this.speedDown = 0.9;    // 1/s toward a darker frame
    this._primed = false;
  }

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
    u.uSpeedUp.value = this.speedUp;
    u.uSpeedDown.value = this.speedDown;
    u.uPrimed.value = this._primed ? 1 : 0;
    this.adaptPass.render(renderer, write);
    this.index ^= 1;
    this._primed = true;
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

  // Centre-weighted metering. A wide sky at the top of frame should not decide
  // the exposure of the alley the player is standing in.
  vec2 d = (vUv - 0.5) * vec2(1.0, 1.15);
  float mask = mix(0.35, 1.0, 1.0 - smoothstep(0.10, 0.55, dot(d, d)));

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
uniform float uSpeedUp;
uniform float uSpeedDown;
uniform int uPrimed;

void main(){
  vec2 lum = texture(tLum, vec2(0.5)).rg;
  float target = clamp(exp(lum.r / max(lum.g, 1e-3)), uMin, uMax);

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
