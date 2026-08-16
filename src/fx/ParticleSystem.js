import * as THREE from 'three';
import { ATLAS_COLS } from './FxTextures.js';

/**
 * OWNER: VFX agent.
 *
 * The particle engine. One draw call per blend mode, no per-frame CPU work and
 * no per-frame allocation.
 *
 * SIMULATION IS ANALYTIC, IN THE VERTEX SHADER
 * --------------------------------------------
 * A particle is written once, at spawn, as a set of initial conditions:
 * position, velocity, drag, gravity, turbulence, and two size/colour keys. The
 * vertex shader then evaluates its state at `now - birth` in closed form:
 *
 *     v(t) = (v0 - g/k)·e^(-kt) + g/k
 *     x(t) = x0 + (v0 - g/k)·(1 - e^(-kt))/k + (g/k)·t
 *
 * which is the exact solution of dv/dt = -k·v + g. That is the whole simulation
 * — the CPU never touches a live particle again, the buffer is only written on
 * spawn, and a 24k-particle field costs the same on the CPU as an empty one.
 *
 * TURBULENCE
 * ----------
 * Added on top as an ABC (Arnold-Beltrami-Childress) flow. It is divergence
 * free by construction, which is what keeps smoke from visibly compressing into
 * or exploding out of invisible points the way sin/cos noise fields do, and it
 * costs six trig ops. The field is sampled at the *unperturbed* position so the
 * displacement never feeds back into itself (the standard cheap approximation —
 * a true advection would need the previous frame's position, and that would put
 * the state back on the CPU).
 *
 * SOFT PARTICLES
 * --------------
 * The fragment shader reads the depth prepass PostStack already renders for
 * GTAO/SSR/TAA and fades the sprite out as it approaches the surface behind it,
 * so smoke meets a wall in a soft gradient instead of a hard intersection line.
 * When the tier is too low for a G-buffer the term is compiled out at runtime by
 * a uniform, not a branch per particle.
 *
 * LIT PARTICLES
 * -------------
 * Optional per particle. A billboard gets a hemispherical normal, a wrapped
 * diffuse term (light bleeds around a puff rather than terminating at 90°) and
 * a self-shadow approximation: optical depth through the puff attenuates the sun
 * contribution, so a dense smoke column is dark in the middle and rimmed at the
 * edges.
 */

/** Floats per particle in the interleaved instance buffer. */
const STRIDE = 27;

export const LAYER = { ALPHA: 0, ADDITIVE: 1, HAZE: 2 };

/**
 * Shared, mutable spawn descriptor. Emitters fill it and call `spawn()`;
 * nothing is allocated per particle. Call `reset()` before filling.
 */
export const P = {
  x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: 0,
  life: 1,
  drag: 0,
  gravity: 0,
  turbulence: 0,
  lit: 0,
  size0: 0.1, size1: 0.1,
  stretch: 0, spin: 0,
  r0: 1, g0: 1, b0: 1,
  r1: 1, g1: 1, b1: 1,
  alpha: 1,
  tile: 0,
  fade: 1.4,
  soft: 0.5,
};

export function resetP() {
  P.x = P.y = P.z = 0;
  P.vx = P.vy = P.vz = 0;
  P.life = 1;
  P.drag = 0; P.gravity = 0; P.turbulence = 0; P.lit = 0;
  P.size0 = 0.1; P.size1 = 0.1; P.stretch = 0; P.spin = 0;
  P.r0 = P.g0 = P.b0 = 1;
  P.r1 = P.g1 = P.b1 = 1;
  P.alpha = 1; P.tile = 0; P.fade = 1.4; P.soft = 0.5;
  return P;
}

/* -------------------------------------------------------------- shaders */

const TURBULENCE_GLSL = /* glsl */`
// ABC flow. div(u) == 0 analytically, so the field swirls without sources or
// sinks; two octaves give a large slow roll plus fine curl.
vec3 fxTurbulence( vec3 p, float t ) {
  vec3 q = p * 0.55 + vec3( 0.0, -t * 0.13, 0.0 );
  vec3 a = vec3(
    1.00 * sin( q.z ) + 0.60 * cos( q.y ),
    0.80 * sin( q.x ) + 1.00 * cos( q.z ),
    0.60 * sin( q.y ) + 0.80 * cos( q.x )
  );
  vec3 r = p * 2.30 + vec3( t * 0.35, t * 0.19, -t * 0.27 );
  vec3 b = vec3(
    sin( r.z ) + cos( r.y ),
    sin( r.x ) + cos( r.z ),
    sin( r.y ) + cos( r.x )
  );
  return a + b * 0.32;
}
`;

const VERT = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uAtlasCols;

attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute vec3 aTime;      // birth, 1/life, seed
attribute vec4 aDynamics;  // drag k, gravity scale, turbulence, lit amount
attribute vec4 aSize;      // size0, size1, stretch, spin
attribute vec3 aColorA;
attribute vec3 aColorB;
attribute vec4 aStyle;     // alpha, tile index, fade exponent, soft distance

varying vec2 vUv;
varying vec3 vTint;
varying float vAlpha;
varying float vViewZ;
varying float vSoft;
varying float vLit;
varying float vDensity;
varying vec2 vQuad;

${TURBULENCE_GLSL}

#include <common>
#include <fog_pars_vertex>

void main() {
  float age = uTime - aTime.x;
  float u = age * aTime.y;
  float dead = step( 1.0, u ) + step( u, -1e-6 );
  u = clamp( u, 0.0, 1.0 );
  age = max( age, 0.0 );

  // --- closed-form drag + gravity ----------------------------------------
  vec3 g = vec3( 0.0, -9.81 * aDynamics.y, 0.0 );
  float k = aDynamics.x;
  vec3 pos, vel;
  if ( k > 1e-3 ) {
    float e = exp( -k * age );
    vec3 term = aVelocity - g / k;
    pos = aOrigin + term * ( 1.0 - e ) / k + ( g / k ) * age;
    vel = term * e + g / k;
  } else {
    pos = aOrigin + aVelocity * age + 0.5 * g * age * age;
    vel = aVelocity + g * age;
  }

  if ( aDynamics.z > 0.0 ) {
    vec3 tv = fxTurbulence( pos, uTime + aTime.z * 41.0 );
    // Displacement grows with age: at t=0 the particle is exactly where it was
    // emitted, which keeps tight bursts from jittering apart at the source.
    pos += tv * aDynamics.z * age;
    vel += tv * aDynamics.z * 0.6;
  }

  // --- size / alpha over life ---------------------------------------------
  float ease = 1.0 - ( 1.0 - u ) * ( 1.0 - u );      // fast then settling
  float size = mix( aSize.x, aSize.y, ease );
  float fadeIn = smoothstep( 0.0, 0.07, u );
  vAlpha = aStyle.x * fadeIn * pow( 1.0 - u, aStyle.z ) * ( 1.0 - dead );
  vTint = mix( aColorA, aColorB, ease );
  vDensity = aStyle.x;
  vLit = aDynamics.w;
  vSoft = aStyle.w;

  // --- billboard -----------------------------------------------------------
  vec4 mvPosition = modelViewMatrix * vec4( pos, 1.0 );
  vec2 corner = position.xy;

  if ( aSize.z > 0.0 ) {
    // Velocity-stretched: the quad's long axis follows the screen-space
    // projection of the velocity, and shrinks back to a round sprite as the
    // motion turns toward the camera (otherwise a spark flying at the viewer
    // would draw a full-length bar).
    vec3 vv = ( viewMatrix * vec4( vel, 0.0 ) ).xyz;
    float speed = length( vv );
    vec2 ax = vv.xy;
    float axl = length( ax );
    vec2 dir = axl > 1e-4 ? ax / axl : vec2( 0.0, 1.0 );
    float fore = axl / max( speed, 1e-4 );
    float len = mix( size, size + aSize.z * speed, fore );
    mvPosition.xy += dir * ( corner.y * len ) + vec2( -dir.y, dir.x ) * ( corner.x * size );
    vQuad = vec2( corner.x, corner.y ) * 2.0;
  } else {
    float a = aSize.w * age + aTime.z * 6.2831853;
    float s = sin( a ), c = cos( a );
    mvPosition.xy += vec2( corner.x * c - corner.y * s, corner.x * s + corner.y * c ) * size;
    vQuad = corner * 2.0;
  }

  vViewZ = -mvPosition.z;

  // Atlas addressing: tile index -> column/row in the 4x4 sheet.
  float tile = aStyle.y;
  float col = mod( tile, uAtlasCols );
  float row = floor( tile / uAtlasCols );
  vUv = ( uv + vec2( col, row ) ) / uAtlasCols;

  gl_Position = dead > 0.0 ? vec4( 2.0, 2.0, 2.0, 1.0 ) : projectionMatrix * mvPosition;

  #include <fog_vertex>
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform sampler2D uAtlas;
uniform sampler2D uDepth;
uniform float uTime;
uniform vec2 uInvBuffer;
uniform vec2 uPlanes;       // near, far
uniform float uHasDepth;
uniform vec3 uSunDirView;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uExtinction;

varying vec2 vUv;
varying vec3 vTint;
varying float vAlpha;
varying float vViewZ;
varying float vSoft;
varying float vLit;
varying float vDensity;
varying vec2 vQuad;

#include <common>
#include <fog_pars_fragment>

void main() {
  vec4 tex = texture2D( uAtlas, vUv );
  float a = tex.a * vAlpha;
  if ( a < 0.0035 ) discard;

  vec3 col = tex.rgb * vTint;

  if ( vLit > 0.0 ) {
    // Hemispherical normal over the billboard: the sprite is shaded as if it
    // were the front of a sphere, which is what a puff of smoke actually is.
    float r2 = min( dot( vQuad, vQuad ), 1.0 );
    vec3 n = vec3( vQuad, sqrt( 1.0 - r2 ) );
    float ndl = dot( n, uSunDirView );
    float wrap = clamp( ( ndl + 0.55 ) / 1.55, 0.0, 1.0 );
    // Self-shadowing: optical depth through the puff toward the light. Thick,
    // dense particles keep their cores dark; thin edges transmit and glow.
    float thickness = sqrt( 1.0 - r2 ) * vDensity;
    float transmit = exp( -thickness * 2.6 );
    vec3 lit = uAmbient + uSunColor * wrap * mix( 0.22, 1.0, transmit );
    col *= mix( vec3( 1.0 ), lit, vLit );
  }

  if ( uHasDepth > 0.5 && vSoft > 0.0 ) {
    vec2 suv = gl_FragCoord.xy * uInvBuffer;
    float dz = texture2D( uDepth, suv ).x;
    float ndc = dz * 2.0 - 1.0;
    float sceneZ = ( 2.0 * uPlanes.x * uPlanes.y ) /
      ( uPlanes.y + uPlanes.x - ndc * ( uPlanes.y - uPlanes.x ) );
    a *= clamp( ( sceneZ - vViewZ ) / vSoft, 0.0, 1.0 );
  }

  #ifdef FX_HAZE

    // Heat shimmer. The pass multiplies what is already in the HDR buffer by a
    // ripple centred on 1.0, so the air over a muzzle or a fireball brightens
    // and darkens in bands the way it does through a real thermal gradient.
    // It is a local-contrast modulation rather than a true refraction: sampling
    // the colour buffer while writing to it is a feedback loop, and this stack
    // has no spare copy of it to read from.
    float w1 = sin( vQuad.x * 8.0 + uTime * 13.0 + vTint.x * 9.0 );
    float w2 = cos( vQuad.y * 11.0 - uTime * 9.5 + vTint.y * 5.0 );
    float w3 = sin( ( vQuad.x + vQuad.y ) * 17.0 + uTime * 21.0 );
    float ripple = ( w1 * w2 + w3 * 0.45 ) * 0.5;
    gl_FragColor = vec4( vec3( 1.0 + ripple * a * 0.9 ), 1.0 );

  #else

    gl_FragColor = vec4( col, a );

    #ifdef FX_ADDITIVE
      // Additive light must be *extinguished* by haze, not mixed toward its
      // colour, or every spark would gain a grey halo at range.
      gl_FragColor.a *= exp( -uExtinction * vViewZ );
    #else
      #include <fog_fragment>
    #endif

  #endif
}
`;

/* --------------------------------------------------------------- system */

class Layer {
  /** @param {'alpha'|'additive'|'haze'} mode */
  constructor(name, capacity, mode, shared) {
    this.name = name;
    const additive = mode === 'additive';
    const haze = mode === 'haze';
    this.capacity = Math.max(16, capacity | 0);
    this.head = 0;
    this.spawned = 0;
    this.lastSpawn = -1e9;
    this.longestLife = 1;
    this._dirtyMin = 1e9;
    this._dirtyMax = -1;
    this._range = { start: 0, count: 0 };

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    this.array = new Float32Array(this.capacity * STRIDE);
    const buf = new THREE.InstancedInterleavedBuffer(this.array, STRIDE, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    this.buffer = buf;

    geo.setAttribute('aOrigin', new THREE.InterleavedBufferAttribute(buf, 3, 0));
    geo.setAttribute('aVelocity', new THREE.InterleavedBufferAttribute(buf, 3, 3));
    geo.setAttribute('aTime', new THREE.InterleavedBufferAttribute(buf, 3, 6));
    geo.setAttribute('aDynamics', new THREE.InterleavedBufferAttribute(buf, 4, 9));
    geo.setAttribute('aSize', new THREE.InterleavedBufferAttribute(buf, 4, 13));
    geo.setAttribute('aColorA', new THREE.InterleavedBufferAttribute(buf, 3, 17));
    geo.setAttribute('aColorB', new THREE.InterleavedBufferAttribute(buf, 3, 20));
    geo.setAttribute('aStyle', new THREE.InterleavedBufferAttribute(buf, 4, 23));
    geo.instanceCount = 0;
    this.geometry = geo;

    const mat = new THREE.ShaderMaterial({
      name: `FxParticles-${name}`,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: { value: 0 },
        uAtlasCols: { value: ATLAS_COLS },
        uAtlas: { value: null },
        uDepth: { value: null },
        uInvBuffer: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uPlanes: { value: new THREE.Vector2(0.02, 800) },
        uHasDepth: { value: 0 },
        uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uAmbient: { value: new THREE.Color(0.2, 0.24, 0.3) },
        uExtinction: { value: 0.004 },
      }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: additive ? { FX_ADDITIVE: '' } : (haze ? { FX_HAZE: '' } : {}),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: haze ? THREE.CustomBlending : (additive ? THREE.AdditiveBlending : THREE.NormalBlending),
      fog: !additive && !haze,
      side: THREE.DoubleSide,
    });
    if (haze) {
      // dst = src * dst: a ripple centred on 1.0 leaves the image alone and
      // pushes it either way at the crests.
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.DstColorFactor;
      mat.blendDst = THREE.ZeroFactor;
      mat.blendSrcAlpha = THREE.ZeroFactor;
      mat.blendDstAlpha = THREE.OneFactor;
    }
    // Shared per-frame uniform objects: one write updates every layer.
    for (const key of Object.keys(shared)) mat.uniforms[key] = shared[key];
    this.material = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = haze ? 10 : (additive ? 12 : 11);
    this.mesh.name = `FxParticles-${name}`;
    this.mesh.userData.noPrepass = true;
  }

  write(time) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    this.spawned++;
    const o = i * STRIDE;
    const a = this.array;

    a[o] = P.x; a[o + 1] = P.y; a[o + 2] = P.z;
    a[o + 3] = P.vx; a[o + 4] = P.vy; a[o + 5] = P.vz;
    a[o + 6] = time;
    a[o + 7] = 1 / Math.max(P.life, 1e-3);
    a[o + 8] = Math.random();
    a[o + 9] = P.drag; a[o + 10] = P.gravity; a[o + 11] = P.turbulence; a[o + 12] = P.lit;
    a[o + 13] = P.size0; a[o + 14] = P.size1; a[o + 15] = P.stretch; a[o + 16] = P.spin;
    a[o + 17] = P.r0; a[o + 18] = P.g0; a[o + 19] = P.b0;
    a[o + 20] = P.r1; a[o + 21] = P.g1; a[o + 22] = P.b1;
    a[o + 23] = P.alpha; a[o + 24] = P.tile; a[o + 25] = P.fade; a[o + 26] = P.soft;

    if (o < this._dirtyMin) this._dirtyMin = o;
    if (o + STRIDE - 1 > this._dirtyMax) this._dirtyMax = o + STRIDE - 1;
    this.lastSpawn = time;
    if (P.life > this.longestLife) this.longestLife = P.life;
    this.geometry.instanceCount = Math.min(this.capacity, Math.max(this.geometry.instanceCount, this.spawned));
  }

  flush(time) {
    if (this._dirtyMax >= 0) {
      const buf = this.buffer;
      // Reuse one range object rather than allocating per frame. three clears
      // the array after upload, so an entry left behind means the mesh was not
      // drawn — widen to a full upload in that case rather than losing writes.
      if (buf.updateRanges.length === 0) {
        this._range.start = this._dirtyMin;
        this._range.count = this._dirtyMax - this._dirtyMin + 1;
        buf.updateRanges.push(this._range);
      } else {
        buf.updateRanges.length = 0;
      }
      buf.needsUpdate = true;
      this._dirtyMin = 1e9;
      this._dirtyMax = -1;
    }
    // Everything spawned has expired: stop paying vertex cost for a dead field.
    if (this.geometry.instanceCount > 0 && time - this.lastSpawn > this.longestLife) {
      this.geometry.instanceCount = 0;
      this.spawned = 0;
      this.longestLife = 1;
    }
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class ParticleSystem {
  /**
   * @param {number} budget total particles across both layers
   * @param {THREE.Texture} atlas
   */
  constructor(budget, atlas, { haze = true } = {}) {
    this.time = 0;
    this.atlas = atlas;
    this.hazeEnabled = haze;

    // Alpha-blended smoke and dust are the volume; additive sparks and fire are
    // the accents. Splitting the budget 55/42 keeps a grenade's smoke alive
    // through a firefight's worth of impact sparks; heat shimmer needs only a
    // handful of quads and is the first thing dropped on a low tier.
    const hazeBudget = haze ? Math.max(48, Math.floor(budget * 0.03)) : 16;
    const alphaBudget = Math.floor((budget - hazeBudget) * 0.57);
    const addBudget = budget - hazeBudget - alphaBudget;

    this.shared = {
      uTime: { value: 0 },
      uDepth: { value: null },
      uInvBuffer: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      uPlanes: { value: new THREE.Vector2(0.02, 800) },
      uHasDepth: { value: 0 },
      uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.18, 0.22, 0.28) },
      uExtinction: { value: 0.004 },
      uAtlas: { value: atlas },
    };

    this.layers = [
      new Layer('alpha', alphaBudget, 'alpha', this.shared),
      new Layer('additive', addBudget, 'additive', this.shared),
      new Layer('haze', hazeBudget, 'haze', this.shared),
    ];
    if (!haze) this.layers[LAYER.HAZE].mesh.visible = false;

    this.root = new THREE.Group();
    this.root.name = 'FxParticles';
    // The vertex shader treats instance data as world space, so the root must
    // stay at identity; freezing the matrix makes that structural.
    this.root.matrixAutoUpdate = false;
    for (const l of this.layers) this.root.add(l.mesh);
  }

  /** Spawn one particle from the shared descriptor `P`. */
  spawn(layer) {
    if (layer === LAYER.HAZE && !this.hazeEnabled) return;
    this.layers[layer].write(this.time);
  }

  /**
   * Per-frame uniform sync. Nothing here touches particle state.
   * @param {number} dt
   * @param {import('../core/Engine.js').Engine} engine
   */
  update(dt, engine) {
    this.time = engine.elapsed;
    const s = this.shared;
    s.uTime.value = this.time;

    const post = engine.post;
    const depth = post && post.useGBuffer && post.geometry ? post.geometry.depthTexture : null;
    s.uDepth.value = depth || this.atlas;   // a sampler must always be bound
    s.uHasDepth.value = depth ? 1 : 0;

    const rm = engine.get('render');
    if (rm && rm.bufferWidth) s.uInvBuffer.value.set(1 / rm.bufferWidth, 1 / rm.bufferHeight);
    s.uPlanes.value.set(engine.camera.near, engine.camera.far);

    // Sun in view space, so the fragment shader can light a billboard without
    // a per-particle world normal.
    const sun = engine.sun;
    if (sun) {
      _v.copy(sun.position).sub(sun.target ? sun.target.position : _zero).normalize();
      _v.transformDirection(engine.camera.matrixWorldInverse);
      s.uSunDirView.value.copy(_v);
      s.uSunColor.value.copy(sun.color).multiplyScalar(Math.min(sun.intensity, 8) * 0.16);
    }
    // Sky fill. The fog colour carries the right *magnitude* of ambient light
    // but not the right hue — it is the horizon term of the aerial-perspective
    // fit, which is deliberately warm and almost blue-free. Taking its
    // luminance and re-tinting toward the sky keeps smoke sitting in the same
    // light as the geometry around it without inheriting that bias.
    const env = engine.scene.environmentIntensity ?? 1;
    const fogColor = engine.scene.fog ? engine.scene.fog.color : null;
    if (fogColor) {
      const lum = 0.2126 * fogColor.r + 0.7152 * fogColor.g + 0.0722 * fogColor.b;
      s.uAmbient.value.setRGB(lum * 0.74, lum * 0.82, lum * 1.0).multiplyScalar(0.7 * env);
    }
    if (engine.scene.fog && engine.scene.fog.density !== undefined) {
      s.uExtinction.value = engine.scene.fog.density * 0.9;
    }
  }

  /**
   * Upload the frame's spawns. Deliberately separate from `update()` and driven
   * from lateUpdate: weapons, AI and explosions all emit their events during the
   * update phase, which runs *after* this module's own update. Flushing early
   * would leave those particles in CPU memory until the next frame.
   */
  flush() {
    for (const l of this.layers) l.flush(this.time);
  }

  get liveEstimate() {
    let n = 0;
    for (const l of this.layers) n += l.geometry.instanceCount;
    return n;
  }

  dispose() {
    for (const l of this.layers) l.dispose();
  }
}

const _v = new THREE.Vector3();
const _zero = new THREE.Vector3();
