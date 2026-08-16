import * as THREE from 'three';
import { ATLAS_COLS, PT } from './FxTextures.js';

/**
 * OWNER: VFX agent.
 *
 * Environmental particulate: dust motes hanging in the air and sand blowing
 * across the ground. Neither is ever spawned or simulated — a mote's position
 * is a pure function of its seed and the clock, wrapped modulo a box that
 * follows the camera, so the field is infinite, costs one draw call, and the
 * CPU writes exactly three uniforms per frame.
 *
 * SUN SHAFTS WITHOUT VOLUMETRICS
 * ------------------------------
 * A mote is only visible when light is falling on it. Rather than sampling the
 * shadow cascades (which would mean lighting uniforms on a custom shader and a
 * texture fetch per mote), brightness is modulated by a large-scale world-space
 * noise field and by a strong forward-scattering lobe around the sun. The noise
 * gives the banded, drifting "shafts between buildings" structure; the lobe is
 * why real dust is nearly invisible with the sun behind you and blinding when
 * you look into it. The two together read as volumetric light at a cost of one
 * value-noise evaluation per particle.
 */

const VERT = /* glsl */`
precision highp float;

uniform float uTime;
uniform vec3 uCenter;
uniform vec3 uBox;
uniform vec3 uWind;
uniform vec3 uSunDir;
uniform float uSize;
uniform float uTile;
uniform float uAtlasCols;
uniform float uShaftScale;
uniform float uBrightness;

attribute vec3 aSeed;
attribute vec2 aParam;   // size multiplier, phase

varying vec2 vUv;
varying float vAlpha;

float hash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.yzx + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}

float vnoise( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float n000 = hash13( i );
  float n100 = hash13( i + vec3( 1.0, 0.0, 0.0 ) );
  float n010 = hash13( i + vec3( 0.0, 1.0, 0.0 ) );
  float n110 = hash13( i + vec3( 1.0, 1.0, 0.0 ) );
  float n001 = hash13( i + vec3( 0.0, 0.0, 1.0 ) );
  float n101 = hash13( i + vec3( 1.0, 0.0, 1.0 ) );
  float n011 = hash13( i + vec3( 0.0, 1.0, 1.0 ) );
  float n111 = hash13( i + vec3( 1.0, 1.0, 1.0 ) );
  return mix(
    mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
    mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ), f.z );
}

void main() {
  // Deterministic drift, then wrap into a box that follows the camera. The
  // particle never "respawns": it re-enters on the opposite face.
  vec3 bob = vec3(
    sin( uTime * 0.61 + aSeed.x * 41.0 ),
    sin( uTime * 0.43 + aSeed.y * 33.0 ),
    cos( uTime * 0.55 + aSeed.z * 27.0 )
  ) * 0.18;
  vec3 p = aSeed * uBox + uWind * uTime + bob;
  p = mod( p - uCenter + uBox * 0.5, uBox ) + uCenter - uBox * 0.5;

  vec3 toCam = p - cameraPosition;
  float dist = length( toCam );
  vec3 viewDir = toCam / max( dist, 1e-3 );

  // Shafts: slow-moving bands of illuminated air.
  float shaft = vnoise( p * uShaftScale + vec3( 0.0, uTime * 0.05, 0.0 ) );
  shaft = smoothstep( 0.34, 0.78, shaft );

  // Forward scattering: dust lights up when you look toward the sun.
  float phase = pow( max( dot( viewDir, uSunDir ), 0.0 ), 5.0 );

  float fade = smoothstep( 0.6, 2.0, dist ) * ( 1.0 - smoothstep( uBox.z * 0.30, uBox.z * 0.5, dist ) );
  vAlpha = uBrightness * fade * ( 0.18 + 0.82 * shaft ) * ( 0.25 + 1.6 * phase )
    * ( 0.5 + 0.5 * sin( uTime * 1.7 + aParam.y ) );

  vec4 mvPosition = viewMatrix * vec4( p, 1.0 );
  // Motes are a fixed angular size rather than a fixed world size: they are
  // meant to read as points of light, not as spheres that grow as you approach.
  float size = uSize * aParam.x * ( 0.6 + dist * 0.05 );
  mvPosition.xy += position.xy * size;
  gl_Position = projectionMatrix * mvPosition;

  float col = mod( uTile, uAtlasCols );
  float row = floor( uTile / uAtlasCols );
  vUv = ( uv + vec2( col, row ) ) / uAtlasCols;
}
`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D uAtlas;
uniform vec3 uColor;
varying vec2 vUv;
varying float vAlpha;

void main() {
  vec4 t = texture2D( uAtlas, vUv );
  float a = t.a * vAlpha;
  if ( a < 0.002 ) discard;
  gl_FragColor = vec4( t.rgb * uColor, a );
}
`;

class Field {
  constructor(count, atlas, opts) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    const seeds = new Float32Array(count * 3);
    const params = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      seeds[i * 3] = Math.random();
      seeds[i * 3 + 1] = Math.random();
      seeds[i * 3 + 2] = Math.random();
      params[i * 2] = 0.5 + Math.random() * 1.2;
      params[i * 2 + 1] = Math.random() * 6.283;
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(params, 2));
    geo.instanceCount = count;

    this.uniforms = {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3().fromArray(opts.box) },
      uWind: { value: new THREE.Vector3().fromArray(opts.wind) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSize: { value: opts.size },
      uTile: { value: opts.tile },
      uAtlasCols: { value: ATLAS_COLS },
      uShaftScale: { value: opts.shaftScale },
      uBrightness: { value: opts.brightness },
      uAtlas: { value: atlas },
      uColor: { value: new THREE.Color().fromArray(opts.color) },
    };

    const mat = new THREE.ShaderMaterial({
      name: `FxAmbience-${opts.name}`,
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.name = `FxAmbience-${opts.name}`;
    this.mesh.userData.noPrepass = true;
    this.offsetY = opts.offsetY || 0;
  }

  update(time, camera, sunDir) {
    this.uniforms.uTime.value = time;
    this.uniforms.uCenter.value.set(camera.position.x, camera.position.y + this.offsetY, camera.position.z);
    if (sunDir) this.uniforms.uSunDir.value.copy(sunDir);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

export class Ambience {
  /**
   * @param {number} moteCount
   * @param {number} sandCount
   * @param {THREE.Texture} atlas
   */
  constructor(moteCount, sandCount, atlas) {
    this.root = new THREE.Group();
    this.root.name = 'FxAmbience';
    this.root.matrixAutoUpdate = false;
    this.fields = [];

    if (moteCount > 0) {
      this.motes = new Field(moteCount, atlas, {
        name: 'motes',
        box: [26, 14, 26],
        wind: [0.11, 0.02, 0.07],
        size: 0.020,
        tile: PT.MOTE,
        shaftScale: 0.075,
        brightness: 0.85,
        color: [1.0, 0.94, 0.82],
        offsetY: 2.0,
      });
      this.fields.push(this.motes);
    }

    if (sandCount > 0) {
      // Sand runs in a shallow slab near the ground and moves an order of
      // magnitude faster than the motes: it is being pushed, not floating.
      this.sand = new Field(sandCount, atlas, {
        name: 'sand',
        box: [34, 2.4, 34],
        wind: [2.6, 0.05, 1.5],
        size: 0.035,
        tile: PT.DUST,
        shaftScale: 0.11,
        brightness: 0.5,
        color: [0.95, 0.84, 0.62],
        offsetY: -0.7,
      });
      this.fields.push(this.sand);
    }

    for (const f of this.fields) this.root.add(f.mesh);
  }

  update(dt, engine) {
    for (const f of this.fields) f.update(engine.elapsed, engine.camera, engine.sunDirection);
  }

  dispose() {
    for (const f of this.fields) f.dispose();
    this.fields.length = 0;
  }
}
