import * as THREE from 'three';

/**
 * OWNER: weapons agent.
 *
 * Telescopic-sight overlay for the DMR. A screen-filling quad parented to the
 * viewmodel camera, drawn last with depth testing off, whose fragment shader
 * builds the whole sight picture procedurally:
 *
 *   - the eyepiece surround, fully opaque outside the exit pupil
 *   - a scope shadow whose centre is offset by the same sway and recoil the
 *     weapon is under, so the black crescent creeps in exactly the way it does
 *     when your cheek weld drifts — this is the entire reason a scope overlay
 *     feels like a scope rather than a decal
 *   - lateral chromatic fringing at the edge of the field, because a real
 *     ocular does not correct all the way out
 *   - an etched mil-dot reticle with a floating centre dot and holdover marks
 *
 * The world camera's FOV change is owned by the player module; this pass only
 * supplies the optic.
 */

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;

uniform float uOpacity;      // ADS blend
uniform float uAspect;
uniform vec2  uShadow;       // eyebox offset, in screen radii
uniform float uRadius;       // exit-pupil radius as a fraction of screen height
uniform float uReticle;      // reticle brightness
uniform float uMildot;       // spacing of one mil in screen radii
uniform vec3  uReticleColor;

float lineMask(float d, float w, float soft) {
  return 1.0 - smoothstep(w, w + soft, d);
}

void main() {
  // Work in a square space centred on the screen; y is the reference axis so
  // the sight picture stays circular at any aspect.
  vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5) * 2.0;
  float r = length(p);

  // --- eyepiece surround ---------------------------------------------
  float edge = smoothstep(uRadius, uRadius + 0.012, r);

  // --- scope shadow: the exit pupil, displaced by the eyebox offset ----
  vec2 q = p - uShadow;
  float rq = length(q);
  float pupil = smoothstep(uRadius * 0.995, uRadius * 0.62, rq);
  float shade = clamp(pupil, 0.0, 1.0);

  // Field darkening + lateral chromatic fringe just inside the field stop.
  float fringe = smoothstep(uRadius * 0.72, uRadius, r);
  vec3 tint = mix(vec3(1.0), vec3(1.10, 0.98, 1.14), fringe * 0.9);

  // --- reticle ---------------------------------------------------------
  vec2 rp = p;
  float m = uMildot;
  float th = 0.0016;
  float soft = 0.0018;

  // Posts: heavy outside 3 mils, fine inside — a real duplex.
  float armH = lineMask(abs(rp.y), th, soft) * step(abs(rp.x), m * 5.0);
  float armV = lineMask(abs(rp.x), th, soft) * step(abs(rp.y), m * 5.0);
  float heavy = lineMask(abs(rp.y), th * 2.6, soft) * step(m * 3.0, abs(rp.x))
              + lineMask(abs(rp.x), th * 2.6, soft) * step(m * 3.0, abs(rp.y));
  float ret = max(max(armH, armV), heavy);

  // Mil dots along both arms.
  for (int i = 1; i <= 4; i++) {
    float d = float(i) * m;
    ret = max(ret, 1.0 - smoothstep(th * 1.6, th * 2.6, length(rp - vec2(d, 0.0))));
    ret = max(ret, 1.0 - smoothstep(th * 1.6, th * 2.6, length(rp - vec2(-d, 0.0))));
    ret = max(ret, 1.0 - smoothstep(th * 1.6, th * 2.6, length(rp - vec2(0.0, -d))));
  }
  // Holdover ladder below centre.
  for (int i = 1; i <= 3; i++) {
    float d = float(i) * m * 1.0;
    float w = m * (0.30 - float(i) * 0.05);
    ret = max(ret, lineMask(abs(rp.y + d), th, soft) * step(abs(rp.x), w));
  }
  // Floating centre aiming dot.
  ret = max(ret, 1.0 - smoothstep(th * 1.1, th * 2.0, length(rp)));

  // The reticle is etched glass: it is in focus and unaffected by the eyebox
  // shadow, but it is dimmed where the shadow eats the field.
  float retA = ret * uReticle * shade;

  vec3 col = mix(vec3(0.0), uReticleColor, retA);
  // Alpha: opaque surround, opaque shadow, reticle over a transparent field.
  float alpha = max(max(edge, 1.0 - shade), retA);
  alpha = clamp(alpha, 0.0, 1.0) * uOpacity;

  // Inside the clear field the surround contributes nothing, so premultiply
  // the tint only where the glass is actually visible.
  col *= tint;
  gl_FragColor = vec4(col, alpha);
}
`;

export class ScopeOverlay {
  constructor(camera) {
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        uOpacity: { value: 0 },
        uAspect: { value: 1 },
        uShadow: { value: new THREE.Vector2() },
        uRadius: { value: 0.62 },
        uReticle: { value: 1.0 },
        uMildot: { value: 0.105 },
        uReticleColor: { value: new THREE.Color(0.05, 0.05, 0.06) },
      },
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.name = 'ScopeOverlay';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 40;
    this.mesh.visible = false;
    this.mesh.position.z = -0.02;
    camera.add(this.mesh);
    this.resize();
  }

  /** Size the quad to exactly fill the near frustum at its parking distance. */
  resize() {
    const cam = this.camera;
    const dist = 0.02;
    const h = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5) * dist;
    this.mesh.scale.set(h * cam.aspect * 1.02, h * 1.02, 1);
    this.material.uniforms.uAspect.value = cam.aspect;
  }

  /**
   * @param opacity  ADS blend for the scoped weapon (0 hides the pass entirely)
   * @param offsetX  eyebox drift, in screen radii
   * @param offsetY  ditto
   */
  update(opacity, offsetX, offsetY) {
    const on = opacity > 0.002;
    this.mesh.visible = on;
    if (!on) return;
    const u = this.material.uniforms;
    u.uOpacity.value = Math.min(1, opacity);
    // The shadow only creeps in as the shooter's alignment degrades; a fully
    // settled hold sits centred with a clean field.
    u.uShadow.value.set(offsetX, offsetY);
    this.resize();
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
