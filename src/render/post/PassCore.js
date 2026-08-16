import * as THREE from 'three';

/**
 * OWNER: rendering / post-processing agent.
 *
 * Shared plumbing for every full-screen pass in the post chain.
 *
 * All passes draw a single full-screen *triangle* rather than a quad: it avoids
 * the diagonal seam where two triangles meet, which on tiled/immediate GPUs
 * costs an extra quad-helper invocation for every pixel along the diagonal and
 * breaks derivative continuity there.
 *
 * A single Mesh/Scene/Camera is shared by every pass — only the material is
 * swapped — so a 15-pass chain costs 15 draw calls and zero scene-graph churn.
 */

let _geometry = null;
let _scene = null;
let _mesh = null;
let _camera = null;

function ensureQuad() {
  if (_geometry) return;
  _geometry = new THREE.BufferGeometry();
  _geometry.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  _geometry.setAttribute('uv', new THREE.BufferAttribute(
    new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  _geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8);
  _camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  _mesh = new THREE.Mesh(_geometry, new THREE.MeshBasicMaterial());
  _mesh.frustumCulled = false;
  _mesh.matrixAutoUpdate = false;
  _scene = new THREE.Scene();
  _scene.add(_mesh);
}

export const FS_VERTEX = /* glsl */`
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * GLSL helpers shared by the whole chain. Concatenated into each fragment
 * shader ahead of its body.
 */
export const GLSL_LIB = /* glsl */`
#define PI 3.141592653589793
#define HALF_PI 1.5707963267948966

const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c){ return dot(c, LUMA_W); }

/* Window-space depth [0,1] -> view space position, exact for any projection. */
vec3 viewFromDepth(vec2 uv, float d, mat4 invProj){
  vec4 c = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = invProj * c;
  return v.xyz / v.w;
}

vec2 signNotZero(vec2 v){
  return vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
}
/* Octahedral normal packing: 2 channels, ~equal angular error everywhere. */
vec2 octEncode(vec3 n){
  n /= (abs(n.x) + abs(n.y) + abs(n.z) + 1e-8);
  return (n.z < 0.0) ? ((1.0 - abs(n.yx)) * signNotZero(n.xy)) : n.xy;
}
vec3 octDecode(vec2 e){
  vec3 n = vec3(e.xy, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * signNotZero(n.xy);
  return normalize(n);
}

/* Jimenez's interleaved gradient noise — the cheapest spatially-good dither. */
float ignoise(vec2 p){
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash32(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

/* YCoCg is the right space for temporal clamping: chroma outliers get clipped
   without dragging luminance with them. */
vec3 rgbToYCoCg(vec3 c){
  return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
              0.5  * c.r - 0.5 * c.b,
             -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
vec3 yCoCgToRgb(vec3 c){
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}

vec3 srgbEncode(vec3 c){
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`;

/** One full-screen shader pass. */
export class FullScreenPass {
  /**
   * @param {string} name
   * @param {string} fragmentShader body (GLSL3; GLSL_LIB is prepended)
   * @param {object} uniforms
   * @param {object} [options] { blending, defines, transparent }
   */
  constructor(name, fragmentShader, uniforms = {}, options = {}) {
    ensureQuad();
    this.name = name;
    this.material = new THREE.RawShaderMaterial({
      name,
      glslVersion: THREE.GLSL3,
      uniforms,
      vertexShader: FS_VERTEX,
      fragmentShader: `precision highp float;\nprecision highp int;\nprecision highp sampler2D;\n${GLSL_LIB}\n${fragmentShader}`,
      defines: options.defines || {},
      depthTest: false,
      depthWrite: false,
      transparent: options.transparent === true,
      blending: options.blending !== undefined ? options.blending : THREE.NoBlending,
    });
    this.uniforms = this.material.uniforms;
  }

  /** Rebuild the program with new compile-time constants (quality changes). */
  setDefines(defines) {
    Object.assign(this.material.defines, defines);
    this.material.needsUpdate = true;
  }

  render(renderer, target = null) {
    _mesh.material = this.material;
    renderer.setRenderTarget(target);
    renderer.render(_scene, _camera);
  }

  dispose() { this.material.dispose(); }
}

/** Half-float colour target with sane post-processing defaults. */
export function createRT(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: opts.type || THREE.HalfFloatType,
    format: opts.format || THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    minFilter: opts.filter || THREE.LinearFilter,
    magFilter: opts.filter || THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: opts.depthBuffer === true,
    stencilBuffer: false,
    generateMipmaps: false,
    samples: 0,
    count: opts.count || 1,
  });
  rt.texture.name = opts.name || 'post-rt';
  if (rt.textures) for (const t of rt.textures) t.generateMipmaps = false;
  return rt;
}
