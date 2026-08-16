import * as THREE from 'three';

/**
 * OWNER: level-art agent.
 *
 * Mask-driven surface weathering layered on top of the baked material set.
 *
 * A tiling PBR bake is uniform by construction: every square metre of a wall
 * gets the same dirt as every other. Real buildings do not work that way — the
 * bottom 1.2 m is grey with splash-back, corners and overhangs collect wind
 * dust, and every window sill drools a dark streak down the wall below it.
 *
 * Rather than authoring unique textures (which would defeat the whole tiling
 * budget) the level bakes those fields into a two-channel *vertex* attribute at
 * construction time — `aWeather.x` grime, `aWeather.y` water staining — and
 * this module blends the corresponding surface response in the fragment shader.
 * The vertex field is smooth and cheap; a small tiling streak map supplies the
 * high frequency so the result never reads as a soft airbrushed gradient.
 *
 * It chains onto whatever `onBeforeCompile` the material already carries, so
 * the materials agent's detail / macro / triplanar injection stays intact.
 */

let _streakTex = null;

/**
 * Vertical streak / blotch map.
 *   R  runoff streaks — very high frequency across, very low frequency down
 *   G  a second decorrelated streak set, used for the water-stain channel
 *   B  large soft blotches, for patchy grime rather than even coverage
 */
export function getStreakMap() {
  if (_streakTex) return _streakTex;
  const N = 128;
  const data = new Uint8Array(N * N * 4);

  // Per-column runoff: each column of the map is one rivulet with its own
  // strength and its own vertical onset, which is what makes streaks read as
  // discrete trails rather than as noise.
  const colA = new Float32Array(N);
  const colB = new Float32Array(N);
  let s = 0x1f3a7c9d;
  const rand = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  for (let x = 0; x < N; x++) {
    colA[x] = Math.pow(rand(), 2.2);
    colB[x] = Math.pow(rand(), 1.6);
  }
  // Two smoothing passes widen the rivulets to a few texels each.
  for (let k = 0; k < 2; k++) {
    const a = colA.slice(), b = colB.slice();
    for (let x = 0; x < N; x++) {
      const l = (x + N - 1) % N, r = (x + 1) % N;
      colA[x] = a[l] * 0.26 + a[x] * 0.48 + a[r] * 0.26;
      colB[x] = b[l] * 0.3 + b[x] * 0.4 + b[r] * 0.3;
    }
  }

  for (let y = 0; y < N; y++) {
    const v = y / N;
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      // Streaks fade in downward and dissolve at the very bottom where the
      // runoff has spread out and dried.
      const fall = Math.min(1, v * 2.6) * (1 - Math.pow(v, 4));
      const jitter = 0.82 + 0.18 * Math.sin((x * 12.9898 + y * 4.1414) * 3.7);
      const blotch =
        0.5 + 0.5 * Math.sin(x * 0.11 + Math.sin(y * 0.07) * 2.1)
        * Math.cos(y * 0.09 + Math.sin(x * 0.05) * 1.7);
      data[i] = Math.min(255, colA[x] * fall * jitter * 300) | 0;
      data[i + 1] = Math.min(255, colB[x] * fall * jitter * 280) | 0;
      data[i + 2] = (blotch * 255) | 0;
      data[i + 3] = 255;
    }
  }

  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  _streakTex = t;
  return t;
}

const VERT_HEAD = /* glsl */`
attribute vec2 aWeather;
varying vec2 vLvWea;
varying vec3 vLvPos;
`;

const VERT_BODY = /* glsl */`
  vLvWea = aWeather;
  vLvPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const FRAG_HEAD = /* glsl */`
varying vec2 vLvWea;
varying vec3 vLvPos;
uniform sampler2D lvStreak;
uniform vec3 lvDust;
uniform vec2 lvWeather;   // x grime gain, y stain gain
float lvGrime = 0.0;
float lvStain = 0.0;
`;

/**
 * Streak UVs run *around* the building horizontally and *down* it vertically,
 * so a rivulet stays a vertical line on every wall orientation without needing
 * a triplanar blend: the horizontal coordinate is a skewed sum of x and z,
 * which is continuous across a corner, and the vertical coordinate is world Y.
 */
const FRAG_BODY = /* glsl */`
  {
    // 2.4 m of wall per tile across (so each rivulet is ~30 mm wide) and one
    // tile per 7 m of height, which is a little over one storey run-off.
    vec2 suv = vec2( ( vLvPos.x * 0.83 + vLvPos.z * 0.56 ) * 0.42, vLvPos.y * -0.142 );
    vec3 st = texture2D( lvStreak, suv ).rgb;
    // NB: "patch" is a reserved word in GLSL ES 3.00 — every identifier in an
    // injected chunk has to be namespaced or it collides with something.
    float lvPatch = 0.55 + st.b * 0.75;
    lvGrime = clamp( vLvWea.x * lvWeather.x * lvPatch * ( 0.62 + st.r * 0.9 ), 0.0, 1.0 );
    lvStain = clamp( vLvWea.y * lvWeather.y * ( 0.20 + st.g * 1.55 ), 0.0, 1.0 );
    // Dust is a dry, warm, light film that flattens the base albedo toward its
    // own colour; staining is a dark wet deposit that keeps the base hue.
    diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.52 + lvDust, lvGrime );
    diffuseColor.rgb *= 1.0 - lvStain * 0.46;
  }
`;

const FRAG_ROUGH = /* glsl */`
  roughnessFactor = clamp( roughnessFactor + lvGrime * 0.16 - lvStain * 0.34, 0.045, 1.0 );
`;

/**
 * Attach the weathering layer to a material produced by `makeMaterial`.
 * Idempotent — calling it twice on the same (cached) material is a no-op.
 *
 * @param {THREE.Material} material
 * @param {object} [opts]
 * @param {number} [opts.grime] gain on the grime channel
 * @param {number} [opts.stain] gain on the staining channel
 * @param {number[]} [opts.dust] linear RGB of the dust film
 */
export function applyWeathering(material, opts = {}) {
  if (material.userData.lvWeathered) return material;
  material.userData.lvWeathered = true;

  const uniforms = {
    lvStreak: { value: getStreakMap() },
    lvDust: { value: new THREE.Color().setRGB(
      opts.dust?.[0] ?? 0.150, opts.dust?.[1] ?? 0.126, opts.dust?.[2] ?? 0.092,
      THREE.LinearSRGBColorSpace) },
    lvWeather: { value: new THREE.Vector2(opts.grime ?? 1.0, opts.stain ?? 1.0) },
  };
  material.userData.lvUniforms = uniforms;

  const baseCompile = material.onBeforeCompile;
  const baseKey = material.customProgramCacheKey;

  material.onBeforeCompile = function (shader, renderer) {
    if (baseCompile) baseCompile.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <project_vertex>', VERT_BODY + '\n#include <project_vertex>');

    let f = shader.fragmentShader;
    f = f.replace('#include <common>', '#include <common>\n' + FRAG_HEAD);

    // The materials agent's surface shader has already rewritten these two
    // chunks; match whichever form is actually present so the level still
    // weathers correctly on the LOW tier, where that injection is skipped.
    const mapSite = 'diffuseColor.rgb *= sfAlbedo;';
    if (f.includes(mapSite)) f = f.replace(mapSite, mapSite + FRAG_BODY);
    else f = f.replace('#include <map_fragment>', '#include <map_fragment>' + FRAG_BODY);

    const roughSite = 'float roughnessFactor = roughness * sfArm.g;';
    if (f.includes(roughSite)) f = f.replace(roughSite, roughSite + FRAG_ROUGH);
    else f = f.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>' + FRAG_ROUGH);

    shader.fragmentShader = f;
  };

  material.customProgramCacheKey = function () {
    return 'lvwea|' + (baseKey ? baseKey.call(this) : (material.userData.preset || 'x'));
  };
  material.needsUpdate = true;
  return material;
}

export function disposeWeathering() {
  _streakTex?.dispose();
  _streakTex = null;
}
