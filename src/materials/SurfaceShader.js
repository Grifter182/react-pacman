import * as THREE from 'three';
import { fbm, worley, Cell, clamp01 } from './Noise.js';
import { makeDataTexture } from './SurfaceBake.js';

/**
 * OWNER: materials / texturing agent.
 *
 * Shader-side half of the material system. A baked texture set has exactly one
 * resolution; a first-person camera does not. This module injects three things
 * into MeshStandardMaterial / MeshPhysicalMaterial through `onBeforeCompile`
 * so a single 512px bake holds up from 30 cm to 40 m:
 *
 *  - **Detail normal.** A small, shared, very high frequency normal map tiled
 *    several times per base tile and blended into the baked normal. It carries
 *    the sub-millimetre structure that would otherwise need a 4K bake, and it
 *    fades out with distance so it never turns into shimmer.
 *  - **Macro breakup.** A low-frequency, world-space modulation of albedo,
 *    roughness and AO. Base maps tile every couple of metres; this does not,
 *    so the repeat stops being legible at range. It is projected on a skewed
 *    world-space axis pair, which is continuous over every face orientation
 *    and therefore costs a single tap rather than a triplanar blend.
 *  - **Triplanar projection.** World-space projection of the whole PBR set for
 *    surfaces whose UVs are stretched or nonexistent — the arena's ground plane
 *    and box walls are exactly that case.
 *
 * Everything here is opt-in per material and gated by quality tier: at LOW the
 * injection is skipped entirely and the material stays a plain textured
 * standard material.
 */

/* --------------------------------------------------- shared detail normals */

const _detailCache = new Map();
let _macroTexture = null;

/**
 * Bake one of the shared high-frequency detail normal maps.
 * RGB is a tangent-space normal, A is a cavity term (0.5 = neutral) that
 * nudges roughness and AO where the micro surface dips.
 *
 * These are small (256px) and there are at most four of them, so they are
 * generated synchronously — the whole set costs less than one full-resolution
 * material bake slice.
 */
function bakeDetail(kind, anisotropy) {
  const N = 256;
  const H = new Float32Array(N * N);
  const seed = 0x9e37 ^ (kind.charCodeAt(0) * 7919 + kind.length * 104729);
  const cell = new Cell();

  let f;
  if (kind === 'brushed') {
    // Extreme anisotropy: features 24x narrower across the grain than along it.
    const a = fbm(seed + 1, 6, 4, 0.55);
    const b = fbm(seed + 2, 40, 3, 0.5);
    f = (u, v) => a(u, v * 24) * 0.7 + b(u * 2, v * 40) * 0.3;
  } else if (kind === 'weave') {
    const TH = 16;
    const fuzz = fbm(seed + 3, 60, 3, 0.5);
    f = (u, v) => {
      const iu = Math.floor(u * TH), iv = Math.floor(v * TH);
      const fu = u * TH - iu, fv = v * TH - iv;
      const over = ((iu + iv) & 1) === 0;
      const wu = Math.pow(Math.max(0, Math.sin(fu * Math.PI)), 0.7);
      const wv = Math.pow(Math.max(0, Math.sin(fv * Math.PI)), 0.7);
      return (over ? wu * 0.9 + wv * 0.2 : wv * 0.9 + wu * 0.2) + fuzz(u, v) * 0.12;
    };
  } else if (kind === 'pit') {
    const w = worley(seed + 4, 30, 1.0);
    const n = fbm(seed + 5, 50, 3, 0.5);
    f = (u, v) => {
      w(u, v, cell);
      return -Math.pow(clamp01(1 - cell.f1 / 0.32), 0.7) * 0.8 + n(u, v) * 0.25;
    };
  } else if (kind === 'stipple') {
    // Lime render / paint stipple: isotropic sand grit with *no* cellular
    // structure, which is what separates a floated coat from a mineral one.
    // Deliberately different statistics to 'grain' so plaster and concrete do
    // not share a micro-signature.
    const n1 = fbm(seed + 9, 40, 4, 0.62);
    const n2 = fbm(seed + 10, 96, 2, 0.5);
    f = (u, v) => {
      const a = n1(u, v);
      // Sharpen into shallow pinholes rather than rolling dunes.
      return Math.sign(a) * Math.pow(Math.abs(a), 1.6) * 0.9 + n2(u, v) * 0.30;
    };
  } else {
    // 'grain' — mineral micro-relief: sharp cellular grit over fine fbm.
    const w = worley(seed + 6, 34, 1.0);
    const n1 = fbm(seed + 7, 24, 4, 0.55);
    const n2 = fbm(seed + 8, 70, 3, 0.5);
    f = (u, v) => {
      w(u, v, cell);
      const grit = Math.pow(clamp01(1 - cell.f1 / 0.30), 0.8) * (cell.rand(3) > 0.4 ? 1 : 0.35);
      return n1(u, v) * 0.5 + n2(u, v) * 0.25 + grit * 0.55;
    };
  }

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) H[y * N + x] = f((x + 0.5) / N, (y + 0.5) / N);
  }

  // Normalise so every detail map delivers the same slope budget regardless of
  // how the underlying field happens to be scaled.
  let mean = 0;
  for (let i = 0; i < H.length; i++) mean += H[i];
  mean /= H.length;
  let sd = 0;
  for (let i = 0; i < H.length; i++) { const d = H[i] - mean; sd += d * d; }
  sd = Math.sqrt(sd / H.length) || 1;
  for (let i = 0; i < H.length; i++) H[i] = (H[i] - mean) / sd;

  const data = new Uint8Array(N * N * 4);
  const k = 0.09;                                    // slope per sigma per texel
  for (let y = 0; y < N; y++) {
    const yp = ((y + 1) % N) * N, ym = ((y - 1 + N) % N) * N, row = y * N;
    for (let x = 0; x < N; x++) {
      const xp = (x + 1) % N, xm = (x - 1 + N) % N;
      const dx = (H[row + xp] - H[row + xm]) * k * N * 0.5;
      const dy = (H[yp + x] - H[ym + x]) * k * N * 0.5;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (row + x) * 4;
      data[i] = (-dx * inv * 0.5 + 0.5) * 255 + 0.5 | 0;
      data[i + 1] = (-dy * inv * 0.5 + 0.5) * 255 + 0.5 | 0;
      data[i + 2] = (inv * 0.5 + 0.5) * 255 + 0.5 | 0;
      // Cavity: how far this texel sits below the local mean.
      data[i + 3] = clamp01(0.5 + H[row + x] * 0.22) * 255 + 0.5 | 0;
    }
  }
  return makeDataTexture(data, N, false, anisotropy);
}

export function getDetailMap(kind, anisotropy = 8) {
  if (!kind) return null;
  let t = _detailCache.get(kind);
  if (!t) { t = bakeDetail(kind, anisotropy); _detailCache.set(kind, t); }
  return t;
}

/**
 * The shared macro-variation map. Three decorrelated fields: R tints albedo,
 * G modulates roughness, B modulates AO/dirt. One texture for the whole world,
 * so every surface's large-scale variation stays coherent — a damp patch of
 * ground reads as the same weather as the damp wall above it.
 *
 * DELIBERATELY ONLY TWO OCTAVES. The previous four-octave version put its
 * finest octave at 1/16 of the mapping period; sampled at a 26 m period that
 * is a 1.6 m blob, and 1.6 m blobs painted over every wall, floor and facade in
 * the same world-space frame is the definition of a camouflage pattern. Macro
 * variation is only allowed to live at frequencies *below* the ones a viewer
 * can read as a pattern; anything smaller belongs in the baked recipe, where it
 * is attached to actual material structure.
 *
 * Each channel is rescaled to a standard deviation of 0.25 about 0.5, so the
 * shader-side amplitudes below mean the same thing regardless of how the noise
 * happened to be distributed.
 */
export function getMacroMap() {
  if (_macroTexture) return _macroTexture;
  const N = 128;
  const fields = [fbm(0x51ed, 1, 2, 0.5), fbm(0x2f5a, 2, 2, 0.5), fbm(0x1b87, 1, 2, 0.55)];
  const chan = fields.map((f) => {
    const buf = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) buf[y * N + x] = f((x + 0.5) / N, (y + 0.5) / N);
    }
    let mean = 0;
    for (let i = 0; i < buf.length; i++) mean += buf[i];
    mean /= buf.length;
    let sd = 0;
    for (let i = 0; i < buf.length; i++) { const d = buf[i] - mean; sd += d * d; }
    sd = Math.sqrt(sd / buf.length) || 1;
    const k = 0.25 / sd;
    for (let i = 0; i < buf.length; i++) buf[i] = clamp01(0.5 + (buf[i] - mean) * k);
    return buf;
  });

  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = chan[0][i] * 255 + 0.5 | 0;
    data[i * 4 + 1] = chan[1][i] * 255 + 0.5 | 0;
    data[i * 4 + 2] = chan[2][i] * 255 + 0.5 | 0;
    data[i * 4 + 3] = 255;
  }
  _macroTexture = makeDataTexture(data, N, false, 4);
  return _macroTexture;
}

export function disposeSharedMaps() {
  for (const t of _detailCache.values()) t.dispose();
  _detailCache.clear();
  _macroTexture?.dispose();
  _macroTexture = null;
}

/* ------------------------------------------------------------ GLSL sources */

const PARS_FRAGMENT = /* glsl */`
#ifdef SF_WORLD
  varying vec3 vSfWPos;
  varying vec3 vSfWNrm;
#endif
#ifdef SF_DETAIL
  uniform sampler2D sfDetailMap;
  uniform vec4 sfDetail;      // x tiles/base-tile, y normal gain, z rough gain, w fade start
  uniform float sfDetailEnd;  // fade end, metres
  uniform float sfDetailAlb;  // albedo gain from the detail map's cavity channel
#endif
#ifdef SF_MACRO
  uniform sampler2D sfMacroMap;
  uniform vec4 sfMacro;       // x 1/period mid (1/m), y albedo amt mid, z rough amt mid, w 1/period low
  uniform vec2 sfMacroLo;     // x albedo amt low, y rough amt low
  uniform vec4 sfMacroPhase;  // xy mid-band offset, zw low-band offset (per material)
  uniform vec2 sfMacroHue;    // x warm/cool swing tied to the value term, y UV warp in tiles
#endif
#ifdef SF_TRIPLANAR
  uniform vec2 sfTri;         // x tiles per metre, y blend sharpness
#endif
vec3 sfAlbedo = vec3( 1.0 );
vec3 sfArm = vec3( 1.0 );
vec3 sfNrm = vec3( 0.0, 0.0, 1.0 );
vec3 sfWorldN = vec3( 0.0, 1.0, 0.0 );
`;

const SAMPLE_FUNCTION = /* glsl */`
#ifdef SF_DETAIL
float sfFade() {
  return 1.0 - smoothstep( sfDetail.w, sfDetailEnd, length( vViewPosition ) );
}
#endif

void sfSampleSurface() {

  // The macro fields are sampled FIRST, because one of the things they drive is
  // a world-space warp of the base projection itself. Two bands, and they do
  // different jobs.
  //
  // MID (~7-10 m) is the one that used to wreck everything: crank it and every
  // surface in the frame wears the same blob field. It is capped by the factory,
  // and — new in round 3 — every material gets its own phase offset, so two
  // different materials no longer put their blobs in the same world position.
  // That decorrelation is what makes a usable amount of it safe: a shared field
  // reads as camouflage, an independent one per material reads as weathering.
  //
  // LOW (~15-30 m) is the band a 30 m facade actually needs so it does not read
  // as one flat pass of paint. It is allowed to be several times stronger
  // precisely because it is too large to be read as a pattern.
  //
  // Both use a skewed world projection — continuous across every face
  // orientation, so a single tap works where triplanar would need three.
  vec2 sfWarp = vec2( 0.0 );
  #ifdef SF_MACRO
    vec3 sfWP = vSfWPos;
    vec2 muv = ( sfWP.xz + sfWP.y * vec2( 0.71, 0.37 ) ) * sfMacro.x + sfMacroPhase.xy;
    vec3 sfMid = texture2D( sfMacroMap, muv ).rgb - 0.5;

    // Rotated, offset, channel-swizzled so the low band never correlates with
    // the mid one and the two cannot beat into a visible lattice.
    vec2 luv = ( sfWP.xz * mat2( 0.83, -0.56, 0.56, 0.83 )
               + sfWP.y * vec2( -0.29, 0.53 ) ) * sfMacro.w + sfMacroPhase.zw;
    vec3 sfLow = texture2D( sfMacroMap, luv ).gbr - 0.5;

    // Base-projection warp, in TILES, from the low band only. Its job is to
    // stop a ground plane laying down an exact lattice of the same tile: a
    // smooth sub-tile displacement makes the repeat land in a different phase
    // every few metres, which is what kills the lattice the eye locks onto.
    // Only the low band drives it, because the shear a warp introduces is
    // amplitude/period — a 7 m field would visibly skew anything with a
    // straight line in it. It is opt-in per recipe (warpTiles) and off by
    // default: masonry wants its courses straight.
    sfWarp = vec2( sfLow.r + sfMid.b * 0.30, sfLow.b - sfMid.r * 0.30 ) * sfMacroHue.y;
  #endif

  #ifdef SF_TRIPLANAR

    vec3 wn = normalize( vSfWNrm );
    vec3 bw = pow( abs( wn ), vec3( sfTri.y ) );
    bw /= max( bw.x + bw.y + bw.z, 1e-5 );
    vec3 p = vSfWPos * sfTri.x;
    p.xz += sfWarp;
    float sx = wn.x >= 0.0 ? 1.0 : -1.0;
    float sy = wn.y >= 0.0 ? 1.0 : -1.0;
    float sz = wn.z >= 0.0 ? 1.0 : -1.0;
    vec2 uvX = vec2( p.z * sx, p.y );
    vec2 uvY = vec2( p.x, p.z * sy );
    vec2 uvZ = vec2( - p.x * sz, p.y );

    sfAlbedo = texture2D( map, uvX ).rgb * bw.x
             + texture2D( map, uvY ).rgb * bw.y
             + texture2D( map, uvZ ).rgb * bw.z;
    sfArm = texture2D( roughnessMap, uvX ).rgb * bw.x
          + texture2D( roughnessMap, uvY ).rgb * bw.y
          + texture2D( roughnessMap, uvZ ).rgb * bw.z;

    vec3 nX = texture2D( normalMap, uvX ).xyz * 2.0 - 1.0;
    vec3 nY = texture2D( normalMap, uvY ).xyz * 2.0 - 1.0;
    vec3 nZ = texture2D( normalMap, uvZ ).xyz * 2.0 - 1.0;

    #ifdef SF_DETAIL
      float fade = sfFade();
      float ds = sfDetail.y * fade;
      // Keep the whole texel: .xy is the micro normal, .a is the cavity term,
      // and the triplanar path was previously throwing the cavity away. That
      // mattered more than it sounds — the ground is the only large triplanar
      // surface in the level, so the surface with the most screen area was the
      // one getting no detail-scale roughness or AO break-up at all.
      vec4 dX = texture2D( sfDetailMap, uvX * sfDetail.x );
      vec4 dY = texture2D( sfDetailMap, uvY * sfDetail.x );
      vec4 dZ = texture2D( sfDetailMap, uvZ * sfDetail.x );
      nX.xy += ( dX.xy * 2.0 - 1.0 ) * ds;
      nY.xy += ( dY.xy * 2.0 - 1.0 ) * ds;
      nZ.xy += ( dZ.xy * 2.0 - 1.0 ) * ds;
      float dCav = dX.a * bw.x + dY.a * bw.y + dZ.a * bw.z;
      sfAlbedo *= 1.0 + ( dCav - 0.5 ) * sfDetailAlb * fade;
      sfArm.g = clamp( sfArm.g + ( 0.5 - dCav ) * sfDetail.z * fade, 0.02, 1.0 );
      sfArm.r *= 1.0 - ( 1.0 - dCav ) * 0.22 * fade;
    #endif

    nX.xy *= normalScale;
    nY.xy *= normalScale;
    nZ.xy *= normalScale;

    // Whiteout blend: fold each projection's tangent normal into world space by
    // adding the geometric normal's off-axis components, then weight-sum. Keeps
    // detail on all three planes instead of letting the dominant axis win.
    vec3 wX = vec3( nX.xy + wn.zy, abs( nX.z ) * wn.x );
    vec3 wY = vec3( nY.xy + wn.xz, abs( nY.z ) * wn.y );
    vec3 wZ = vec3( nZ.xy + wn.xy, abs( nZ.z ) * wn.z );
    sfWorldN = normalize( wX.zyx * bw.x + wY.xzy * bw.y + wZ.xyz * bw.z );

  #else

    vec2 sfUv = vMapUv + sfWarp;
    sfAlbedo = texture2D( map, sfUv ).rgb;
    sfArm = texture2D( roughnessMap, vRoughnessMapUv + sfWarp ).rgb;
    sfNrm = texture2D( normalMap, vNormalMapUv + sfWarp ).xyz * 2.0 - 1.0;

    #ifdef SF_DETAIL
      float fade = sfFade();
      vec4 dt = texture2D( sfDetailMap, sfUv * sfDetail.x );
      // UDN blend: perturb the base normal's tangent components and keep its
      // z. Cheap, never flips the base normal, and stays stable under mips.
      sfNrm = normalize( vec3( sfNrm.xy + ( dt.xy * 2.0 - 1.0 ) * sfDetail.y * fade, sfNrm.z ) );
      // A 512 px bake over a 2 m tile is 4 mm per texel, so at the 1 m the
      // player's own feet occupy the base albedo is MAGNIFIED four times and
      // has nothing left to say. The detail map is the only thing running at a
      // frequency the eye can still resolve there, so it drives albedo as well
      // as relief: micro-cavity reads darker, micro-crest reads lighter, which
      // is true of every mineral surface and is what stops a close-up reading
      // as a blurred photograph of a material rather than the material.
      sfAlbedo *= 1.0 + ( dt.a - 0.5 ) * sfDetailAlb * fade;
      sfArm.g = clamp( sfArm.g + ( 0.5 - dt.a ) * sfDetail.z * fade, 0.02, 1.0 );
      sfArm.r *= 1.0 - ( 1.0 - dt.a ) * 0.22 * fade;
    #endif

  #endif

  #ifdef SF_MACRO
    float sfMv = sfMid.r * sfMacro.y + sfLow.r * sfMacroLo.x;

    // The macro used to be a scalar multiply, which means it could only ever
    // move a surface up and down its OWN hue — ten materials all getting
    // brighter and darker together in one warm register is a large part of why
    // the frame read as a single colour at two brightnesses.
    //
    // Weathering does not work that way. Where a surface is sun-bleached and
    // dust-loaded it goes paler AND warmer; where it is damp, shaded or
    // soot-loaded it goes darker AND cooler, because what is lighting it there
    // is sky rather than sun. Tying a warm/cool swing to the value term costs
    // one madd and gives the frame chroma variation that survives at range,
    // which is exactly what the base maps lose to mip collapse.
    vec3 sfTint = vec3( 1.0 + sfMv * sfMacroHue.x, 1.0, 1.0 - sfMv * sfMacroHue.x * 1.35 );
    sfAlbedo *= clamp( vec3( 1.0 + sfMv ) * sfTint, vec3( 0.50 ), vec3( 1.60 ) );

    sfArm.g = clamp( sfArm.g * ( 1.0 + sfMid.g * sfMacro.z + sfLow.g * sfMacroLo.y ), 0.02, 1.0 );
    sfArm.r *= clamp( 1.0 + sfMid.b * sfMacro.z * 0.5 + sfLow.b * sfMacroLo.y * 0.35, 0.72, 1.12 );
  #endif

  sfAlbedo = clamp( sfAlbedo, vec3( 0.004 ), vec3( 0.92 ) );
}
`;

const VERTEX_WORLD = /* glsl */`
  vec4 sfWorld = vec4( transformed, 1.0 );
  mat3 sfNormalM = mat3( modelMatrix );
  #ifdef USE_BATCHING
    sfWorld = batchingMatrix * sfWorld;
    sfNormalM = sfNormalM * mat3( batchingMatrix );
  #endif
  #ifdef USE_INSTANCING
    sfWorld = instanceMatrix * sfWorld;
    sfNormalM = sfNormalM * mat3( instanceMatrix );
  #endif
  sfWorld = modelMatrix * sfWorld;
  vSfWPos = sfWorld.xyz;
  vSfWNrm = normalize( sfNormalM * objectNormal );
`;

/* ------------------------------------------------------------- application */

/**
 * Hard ceilings on the world-space macro term, enforced here so no call site
 * can reintroduce the camouflage look by passing a large `macro`.
 *   MID  ~7-10 m  — the pattern-forming band.
 *   LOW  ~15-30 m — genuine large-scale variation. Allowed to be stronger.
 *
 * The mid cap went up from 0.18 in round 3 and the reason is the phase offset
 * below, not a change of heart. What made this band read as camouflage was
 * never its amplitude on any one surface — it was that every material sampled
 * the SAME field at the SAME world position, so a blob ran across a wall, the
 * ground and a crate as one continuous shape and announced itself as a texture
 * laid over the world. Give each material its own phase and the same amplitude
 * reads as that material weathering independently, which is what it is.
 */
const MACRO_MID_CAP = 0.26;
const MACRO_LOW_CAP = 0.32;

/** Warp is a strong tool with a sharp edge; nothing may exceed a third of a tile. */
const WARP_CAP = 0.34;

/**
 * Deterministic per-material phase. Any two materials with different keys land
 * their macro blobs in different places; the same key always reproduces, so a
 * rebuild is bit-identical.
 */
function phaseFor(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const f = (n) => {
    let x = Math.imul(h ^ n, 0x27d4eb2d);
    x ^= x >>> 15;
    return ((x >>> 0) / 4294967296) * 8;
  };
  return [f(1), f(2), f(3), f(4)];
}

/**
 * Wire the detail / macro / triplanar path into a standard-family material.
 *
 * `cfg` fields (all optional):
 *   detail        'grain' | 'brushed' | 'weave' | 'pit'
 *   detailScale   detail tiles per base tile
 *   detailStrength / detailRough / detailAlbedo
 *   detailFade    [ start, end ] in metres
 *   macro         0..1 breakup strength (0 disables). Split internally into a
 *                 capped mid band and a stronger low band — see MACRO_*_CAP.
 *   macroPeriod   metres per macro cycle, mid band (default 9)
 *   macroPeriodLow  metres per macro cycle, low band (default 30)
 *   macroHue      warm/cool swing carried by the macro value term (default 0.40)
 *   warpTiles     world-space warp of the base projection, in tiles. Breaks the
 *                 exact repeat of a tiled surface. ORGANIC SURFACES ONLY — it
 *                 shears whatever it is applied to, and a sheared brick course
 *                 is worse than a repeated one.
 *   phaseKey      string identifying this material; decides its macro phase
 *   triplanar     boolean
 *   worldScale    metres per base tile (drives the triplanar frequency)
 *   triSharp      triplanar blend exponent
 *   anisotropy    for the shared maps
 */
export function applySurfaceShader(material, cfg = {}) {
  const useDetail = !!cfg.detail && (cfg.detailStrength ?? 0) > 0;
  const useMacro = (cfg.macro ?? 0) > 0.001;
  const useTri = !!cfg.triplanar;
  if (!useDetail && !useMacro && !useTri) return material;

  const uniforms = {};
  const defines = Object.assign({}, material.defines, { SF_SURFACE: '' });

  if (useDetail) {
    defines.SF_DETAIL = '';
    const fade = cfg.detailFade || [7, 22];
    uniforms.sfDetailMap = { value: getDetailMap(cfg.detail, cfg.anisotropy ?? 8) };
    uniforms.sfDetail = {
      value: new THREE.Vector4(
        cfg.detailScale ?? 6,
        cfg.detailStrength ?? 0.5,
        cfg.detailRough ?? 0.14,
        fade[0],
      ),
    };
    uniforms.sfDetailEnd = { value: fade[1] };
    uniforms.sfDetailAlb = { value: Math.min(1.2, cfg.detailAlbedo ?? 0.55) };
  }
  if (useMacro) {
    defines.SF_MACRO = '';
    defines.SF_WORLD = '';
    const want = cfg.macro ?? 0.15;
    // The mid band is capped here rather than trusted from the caller: it is
    // the term that turns ten materials into one camouflage pattern, and no
    // call site has enough context to be allowed to crank it.
    const mid = Math.min(want, MACRO_MID_CAP);
    const low = Math.min(want, MACRO_LOW_CAP);
    uniforms.sfMacroMap = { value: getMacroMap() };
    uniforms.sfMacro = {
      value: new THREE.Vector4(
        1 / Math.max(0.5, cfg.macroPeriod ?? 9),
        mid * 1.25,                       // albedo, mid band
        mid * 0.95,                       // roughness, mid band
        1 / Math.max(4, cfg.macroPeriodLow ?? 30),
      ),
    };
    uniforms.sfMacroLo = {
      value: new THREE.Vector2(low * 2.40, low * 1.40),
    };
    const ph = phaseFor(cfg.phaseKey || 'default');
    uniforms.sfMacroPhase = { value: new THREE.Vector4(ph[0], ph[1], ph[2], ph[3]) };
    uniforms.sfMacroHue = {
      value: new THREE.Vector2(
        Math.min(0.75, cfg.macroHue ?? 0.40),
        Math.min(WARP_CAP, Math.max(0, cfg.warpTiles ?? 0)),
      ),
    };
  }
  if (useTri) {
    defines.SF_TRIPLANAR = '';
    defines.SF_WORLD = '';
    uniforms.sfTri = {
      value: new THREE.Vector2(1 / Math.max(0.05, cfg.worldScale ?? 2), cfg.triSharp ?? 6),
    };
  }

  material.defines = defines;
  material.userData.surfaceUniforms = uniforms;

  // Only the define set changes the generated program — the detail family and
  // all the scales are uniforms, so they must NOT widen the key or every
  // material ends up with its own compiled program.
  const key = `sf|${useDetail ? 'd' : '-'}|${useMacro ? 'm' : '-'}|${useTri ? 't' : '-'}`;
  material.customProgramCacheKey = () => key;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    if (defines.SF_WORLD !== undefined) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSfWPos;\nvarying vec3 vSfWNrm;')
        .replace('#include <project_vertex>', VERTEX_WORLD + '\n#include <project_vertex>');
    }

    let f = shader.fragmentShader;
    // Uniforms and varyings go next to <common>; the sampling function has to
    // wait until every *_pars_fragment has declared the samplers it reads.
    f = f.replace('#include <common>', '#include <common>\n' + PARS_FRAGMENT);
    f = f.replace(
      '#include <clipping_planes_pars_fragment>',
      '#include <clipping_planes_pars_fragment>\n' + SAMPLE_FUNCTION,
    );

    f = f.replace('#include <map_fragment>', /* glsl */`
  sfSampleSurface();
  diffuseColor.rgb *= sfAlbedo;
`);
    f = f.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * sfArm.g;');
    f = f.replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * sfArm.b;');
    f = f.replace('#include <normal_fragment_maps>', /* glsl */`
  #ifdef SF_TRIPLANAR
    normal = normalize( ( viewMatrix * vec4( sfWorldN, 0.0 ) ).xyz );
    #ifdef DOUBLE_SIDED
      normal *= faceDirection;
    #endif
  #else
    vec3 mapN = sfNrm;
    mapN.xy *= normalScale;
    normal = normalize( tbn * mapN );
  #endif
`);
    f = f.replace('#include <aomap_fragment>', /* glsl */`
  #ifdef USE_AOMAP
    float ambientOcclusion = ( sfArm.r - 1.0 ) * aoMapIntensity + 1.0;
    reflectedLight.indirectDiffuse *= ambientOcclusion;
    #if defined( USE_CLEARCOAT )
      clearcoatSpecularIndirect *= ambientOcclusion;
    #endif
    #if defined( USE_SHEEN )
      sheenSpecularIndirect *= ambientOcclusion;
    #endif
    #if defined( USE_ENVMAP ) && defined( STANDARD )
      float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
      reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
    #endif
  #endif
`);

    shader.fragmentShader = f;
  };

  material.needsUpdate = true;
  return material;
}
