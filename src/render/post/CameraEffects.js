import * as THREE from 'three';
import { FullScreenPass } from './PassCore.js';

/**
 * OWNER: rendering / post-processing agent.
 *
 * Camera motion blur and depth of field — the two effects that come from the
 * lens/shutter rather than the scene.
 *
 * Motion blur integrates along the per-pixel motion vector with a shutter
 * fraction, so the blur length is physically tied to frame time: at 120 fps the
 * same camera swing produces half the streak it does at 60 fps, exactly as a
 * fixed shutter angle behaves.
 *
 * DOF is deliberately shallow. The circle of confusion is signed (near field
 * negative, far field positive) and the near field is dilated slightly so
 * out-of-focus foreground bleeds *over* sharp background instead of being
 * clipped by it. Focus distance comes from the auto-focus value in the
 * adaptation buffer, which tracks whatever is under the crosshair — so aiming
 * at a target pulls focus onto it.
 */
export class CameraEffects {
  constructor() {
    this.motionBlur = null;
    this.dof = null;
    this.shutter = 0.42;
    this.maxBlurRadius = 0.035;   // fraction of screen height
    this.aperture = 0.55;
    this.adsAperture = 1.35;
    this.maxCoCRadius = 9.0;      // pixels
  }

  init() {
    this.motionBlur = new FullScreenPass('motion-blur', MB_FRAG, {
      tColor: { value: null },
      tVelocity: { value: null },
      tDepth: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uInvProj: { value: new THREE.Matrix4() },
      uJitter: { value: new THREE.Vector2() },
      uCameraMatrix: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uStrength: { value: this.shutter },
      uMaxRadius: { value: this.maxBlurRadius },
    }, { defines: { MB_TAPS: 9 } });

    this.dof = new FullScreenPass('dof', DOF_FRAG, {
      tColor: { value: null },
      tDepth: { value: null },
      tAdapt: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uInvProj: { value: new THREE.Matrix4() },
      uJitter: { value: new THREE.Vector2() },
      uAperture: { value: this.aperture },
      uMaxRadius: { value: this.maxCoCRadius },
      uTime: { value: 0 },
    }, { defines: { DOF_TAPS: 22 } });
  }

  resize(w, h) {
    this.motionBlur.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.dof.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  renderMotionBlur(renderer, ctx, colorTexture, outTarget) {
    const u = this.motionBlur.uniforms;
    u.tColor.value = colorTexture;
    u.tVelocity.value = ctx.velocityTexture;
    u.tDepth.value = ctx.depthTexture;
    u.uInvProj.value.copy(ctx.invProj);
    u.uJitter.value.copy(ctx.jitterUv);
    u.uCameraMatrix.value.copy(ctx.cameraMatrixWorld);
    u.uPrevViewProj.value.copy(ctx.prevViewProj);
    u.uStrength.value = this.shutter;
    u.uMaxRadius.value = this.maxBlurRadius;
    this.motionBlur.render(renderer, outTarget);
  }

  renderDof(renderer, ctx, colorTexture, outTarget) {
    const u = this.dof.uniforms;
    u.tColor.value = colorTexture;
    u.tDepth.value = ctx.depthTexture;
    u.tAdapt.value = ctx.adaptTexture;
    u.uInvProj.value.copy(ctx.invProj);
    u.uJitter.value.copy(ctx.jitterUv);
    u.uAperture.value = THREE.MathUtils.lerp(this.aperture, this.adsAperture, ctx.ads);
    u.uMaxRadius.value = this.maxCoCRadius;
    u.uTime.value = ctx.time;
    this.dof.render(renderer, outTarget);
  }

  dispose() {
    this.motionBlur?.dispose();
    this.dof?.dispose();
  }
}

const MB_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tColor;
uniform sampler2D tVelocity;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform mat4 uInvProj;
uniform vec2 uJitter;
uniform mat4 uCameraMatrix;
uniform mat4 uPrevViewProj;
uniform float uStrength;
uniform float uMaxRadius;

vec2 velocityAt(vec2 uv){
  float d = texture(tDepth, uv).r;
  if (d < 0.999999) return texture(tVelocity, uv).rg;
  vec3 vp = viewFromDepth(uv - uJitter, d, uInvProj);
  vec4 pc = uPrevViewProj * (uCameraMatrix * vec4(vp, 1.0));
  if (pc.w <= 1e-6) return vec2(0.0);
  return uv - uJitter - ((pc.xy / pc.w) * 0.5 + 0.5);
}

void main(){
  vec2 uv = vUv;
  vec2 v = velocityAt(uv) * uStrength;

  float len = length(v);
  float maxLen = uMaxRadius;
  if (len > maxLen) v *= maxLen / len;
  // Below a third of a pixel the blur is pure cost, so bail early.
  if (length(v / uTexel) < 0.35) { fragColor = texture(tColor, uv); return; }

  float dither = ignoise(gl_FragCoord.xy) - 0.5;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < MB_TAPS; i++) {
    // Symmetric around the pixel: a purely backwards smear detaches moving
    // objects from their own silhouette.
    float t = (float(i) + 0.5 + dither) / float(MB_TAPS) - 0.5;
    vec2 suv = uv + v * t;
    vec3 c = texture(tColor, clamp(suv, vec2(0.0), vec2(1.0))).rgb;
    // Triangle weighting keeps the centre sample dominant so static detail
    // inside a moving frame does not dissolve.
    float w = 1.0 - abs(t) * 1.2;
    sum += c * w;
    wsum += w;
  }
  fragColor = vec4(sum / max(wsum, 1e-4), 1.0);
}
`;

const DOF_FRAG = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tAdapt;
uniform vec2 uTexel;
uniform mat4 uInvProj;
uniform vec2 uJitter;
uniform float uAperture;
uniform float uMaxRadius;
uniform float uTime;

float viewZ(vec2 uv){
  float d = texture(tDepth, uv).r;
  if (d >= 1.0) return -1e4;
  return viewFromDepth(uv - uJitter, d, uInvProj).z;
}

/* Signed circle of confusion, normalised to [-1,1]. */
float coc(float z, float focus){
  float dist = -z;                       // positive metres in front of the eye
  float c = (dist - focus) / max(dist, 0.05);
  return clamp(c * uAperture, -1.0, 1.0);
}

void main(){
  vec2 uv = vUv;
  vec3 centre = texture(tColor, uv).rgb;
  float focus = max(texture(tAdapt, vec2(0.5)).g, 0.35);
  float z0 = viewZ(uv);
  float c0 = coc(z0, focus);

  float radius = abs(c0) * uMaxRadius;
  if (radius < 0.75) { fragColor = vec4(centre, 1.0); return; }

  // Golden-angle spiral: uniform disc coverage with no visible ring structure
  // at low tap counts, which is what a hexagonal-iris bokeh wants.
  float angleOffset = hash12(gl_FragCoord.xy) * 6.2831853;
  vec3 sum = centre;
  float wsum = 1.0;
  for (int i = 0; i < DOF_TAPS; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(DOF_TAPS));
    float a = fi * 2.3999632 + angleOffset;
    vec2 off = vec2(cos(a), sin(a)) * r * radius * uTexel;
    vec2 suv = clamp(uv + off, vec2(0.0), vec2(1.0));
    vec3 s = texture(tColor, suv).rgb;
    float cs = coc(viewZ(suv), focus);
    // A sample only contributes if its own CoC reaches this pixel. Near-field
    // samples are always allowed to bleed forward; far-field samples behind a
    // sharp edge are rejected, which removes the classic background halo.
    float reach = abs(cs) * uMaxRadius;
    float w = (cs < 0.0) ? step(r * radius, reach + 1.0)
                         : step(r * radius, max(reach, radius) + 1.0) * step(-0.02, cs - c0 * 0.35);
    // Bokeh weighting: bright samples spread more, which is what makes
    // highlights read as discs rather than smears.
    w *= 1.0 / (1.0 + luma(s) * 0.12);
    sum += s * w;
    wsum += w;
  }
  vec3 blurred = sum / max(wsum, 1e-4);
  fragColor = vec4(mix(centre, blurred, smoothstep(0.75, 2.2, radius)), 1.0);
}
`;
