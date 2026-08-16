import * as THREE from 'three';
import { Config, QualityTier } from '../core/Config.js';
import { RECIPES, ALIASES, resolveRecipe } from './Recipes.js';
import {
  bakeScheduler, deriveCurvatureAO, encodeNormals, linearToSrgb8,
  makeDataTexture, normaliseRobust,
} from './SurfaceBake.js';
import { applySurfaceShader, disposeSharedMaps } from './SurfaceShader.js';
import { mulberry32, fbm, clamp, clamp01, smoothstep } from './Noise.js';

/**
 * OWNER: materials / texturing agent.
 *
 * Single entry point for every surface in the game. `makeMaterial(preset, opts)`
 * returns a ready-to-use material immediately; the full-resolution bake lands a
 * few frames later without ever blocking a frame (see SurfaceBake.js).
 *
 *   LevelModule  -> 'concrete' | 'plaster' | 'sand' | 'metal' | ...
 *   WeaponModule -> 'gunmetal' | 'polymer' | 'rubber' | 'metal'
 *   AiModule     -> 'canvas' | 'rubber' | 'metal'
 *
 * Call `getMaterialCatalog()` to discover what exists rather than guessing.
 *
 * Colour management, stated once because every map depends on it:
 *   map        sRGB encoded bytes, tagged SRGBColorSpace  (hardware decoded)
 *   normalMap  linear bytes, NoColorSpace
 *   armMap     linear bytes, NoColorSpace — R = AO, G = roughness, B = metalness
 * Recipes author albedo in *linear reflectance*; the OETF is applied on the way
 * into the texture, so the numbers in Recipes.js are physically comparable.
 */

const _materialCache = new Map();
const _surfaceCache = new Map();

/**
 * Two-part answer to "the preview is a 32px splat".
 *
 * `PREVIEW_TEXELS` is the only pass that runs synchronously, and it exists
 * purely so the texture is never uninitialised garbage on the frame the
 * material is created. It is deliberately tiny — a full recipe bake is ~0.5 s
 * of CPU at 512px, so anything larger than this is a visible boot hitch.
 *
 * `FIRST_REFINE_TEXELS` is where the refinement ladder *starts*, and it is the
 * number that actually matters: the scheduler is round-robin, so every material
 * in the world reaches 128px before any single one goes to 256. At a 2.4 m
 * world scale 32px is a 75 mm blob per texel — genuinely the "same camouflage
 * field at the same wrong scale" the surfaces were accused of — while 128px
 * resolves the form-board lines and the brick courses. The old ladder started
 * at N/2, so the whole world sat at 32px until an entire half-resolution bake
 * had completed for every material.
 */
const PREVIEW_TEXELS = 32;
const FIRST_REFINE_TEXELS = 128;

/** Largest number of recipe-private masks `bakePass` will carry per texel. */
const MAX_MASKS = 6;

/* ------------------------------------------------------------------ tiers */

function tierAllowsShaderDetail() {
  return Config.quality !== QualityTier.LOW;
}

/**
 * Resolution policy. A caller's `size` is a request, not a command: it is
 * raised to the recipe's minimum (a 256px bake of gun metal is visibly mush at
 * ADS range) and then capped by the quality tier's texture budget.
 */
function resolveSize(requested, recipe) {
  const budget = Config.gfx.textureSize;
  const want = Math.max(requested ?? budget, recipe.minSize ?? 256);
  const size = Math.min(want, budget);
  // Keep it a power of two so mip chains and the coarse divisor stay exact.
  return 1 << Math.round(Math.log2(Math.max(64, size)));
}

/* ------------------------------------------------------------- bake passes */

/**
 * Nearest-neighbour upscale of an RGBA byte image, M -> N (N a multiple of M).
 * Treated as 32-bit copies and done a row at a time: one expanded row is reused
 * for all N/M destination rows, which turns the inner loop into a memcpy.
 */
const _splatRow = { u32: null };
function splat(src, dst, M, N) {
  const s32 = new Uint32Array(src.buffer, src.byteOffset, M * M);
  const d32 = new Uint32Array(dst.buffer, dst.byteOffset, N * N);
  const f = N / M;
  const shift = Math.round(Math.log2(f));
  if (!_splatRow.u32 || _splatRow.u32.length < N) _splatRow.u32 = new Uint32Array(N);
  const row = _splatRow.u32.subarray(0, N);
  for (let sy = 0; sy < M; sy++) {
    const sRow = sy * M;
    for (let x = 0; x < N; x++) row[x] = s32[sRow + (x >> shift)];
    for (let k = 0; k < f; k++) d32.set(row, ((sy << shift) + k) * N);
  }
}

/**
 * Run one recipe at working resolution M into the N-resolution byte buffers.
 * Written as a generator so the scheduler can slice it; pass `sliced = false`
 * to run it straight through (the coarse pass does exactly that).
 *
 * Order matters: height and masks first, then the curvature/AO derivation over
 * the finished field, then shading — the shading pass needs to know whether a
 * texel is on an edge or in a cavity, which is not knowable one texel at a time.
 */
function* bakePass(impl, recipe, N, M, dstAlbedo, dstNormal, dstArm, sliced, relief) {
  // Target roughly a millisecond per slice at the sampling cost these recipes
  // actually run at, independent of which stage's resolution we are on.
  const chunkRows = sliced ? Math.max(1, Math.round(384 / M)) : 0;
  const direct = M === N;
  const A = direct ? dstAlbedo : new Uint8Array(M * M * 4);
  const Nb = direct ? dstNormal : new Uint8Array(M * M * 4);
  const R = direct ? dstArm : new Uint8Array(M * M * 4);

  const masks = Math.min(recipe.masks ?? 0, MAX_MASKS);
  const H = new Float32Array(M * M);
  const MK = masks ? new Float32Array(M * M * masks) : null;
  const out = new Float32Array(MAX_MASKS + 4);

  for (let y = 0; y < M; y++) {
    const v = (y + 0.5) / M;
    for (let x = 0; x < M; x++) {
      impl.sample((x + 0.5) / M, v, out);
      const i = y * M + x;
      H[i] = out[0];
      for (let k = 0; k < masks; k++) MK[i * masks + k] = out[1 + k];
    }
    if (chunkRows && (y % chunkRows) === chunkRows - 1) yield;
  }

  normaliseRobust(H, 3);
  if (chunkRows) yield;

  const derived = deriveCurvatureAO(H, M, {}, {
    aoStrength: recipe.aoStrength ?? 1,
    curvGain: recipe.curvGain ?? 1,
  });
  if (chunkRows) yield;

  encodeNormals(H, M, Nb, relief);
  if (chunkRows) yield;

  const curv = derived.curv, ao = derived.ao;
  const ctx = { h: 0, curv: 0, edge: 0, cavity: 0, ao: 1 };
  const mv = new Float32Array(MAX_MASKS);
  const sh = new Float32Array(6);

  for (let y = 0; y < M; y++) {
    const v = (y + 0.5) / M;
    for (let x = 0; x < M; x++) {
      const i = y * M + x;
      const cv = curv[i];
      ctx.h = H[i];
      ctx.curv = cv;
      // Curvature is in RMS units, so these thresholds mean "half a sigma of
      // convexity begins to wear, two sigma is fully worn" for every preset.
      ctx.edge = smoothstep(0.55, 2.0, cv);
      ctx.cavity = smoothstep(0.55, 2.0, -cv);
      ctx.ao = ao[i];
      for (let k = 0; k < masks; k++) mv[k] = MK[i * masks + k];

      sh[0] = 0.18; sh[1] = 0.18; sh[2] = 0.18;
      sh[3] = 0.85; sh[4] = 0; sh[5] = 1;
      impl.shade((x + 0.5) / M, v, ctx, mv, sh);

      const j = i * 4;
      // Reflectance bounds: nothing below fresh asphalt, nothing above fresh
      // lime plaster. Pure black and pure white do not exist as surfaces and
      // both wreck the grade's tonal range.
      A[j] = linearToSrgb8(clamp(sh[0], 0.012, 0.85));
      A[j + 1] = linearToSrgb8(clamp(sh[1], 0.012, 0.85));
      A[j + 2] = linearToSrgb8(clamp(sh[2], 0.012, 0.85));
      A[j + 3] = 255;

      R[j] = (clamp01(ctx.ao * sh[5]) * 255 + 0.5) | 0;
      R[j + 1] = (clamp(sh[3], 0.03, 1) * 255 + 0.5) | 0;
      R[j + 2] = (clamp01(sh[4]) * 255 + 0.5) | 0;
      R[j + 3] = 255;
    }
    if (chunkRows && (y % chunkRows) === chunkRows - 1) yield;
  }

  if (!direct) {
    splat(A, dstAlbedo, M, N);
    splat(Nb, dstNormal, M, N);
    splat(R, dstArm, M, N);
  }
}

function runToCompletion(gen) { let r = gen.next(); while (!r.done) r = gen.next(); }

/**
 * Build (or fetch) the PBR texture set for a recipe at a given size and seed.
 * The set is cached independently of the material, so two materials that differ
 * only by tiling share one GPU upload.
 */
function getSurfaceSet(id, recipe, size, seed, worldScale, recipeOpts) {
  // worldScale is part of the *bake* now, not just the projection: every
  // recipe derives its lattice counts and noise periods from it so features
  // land at their real physical size. Two tile sizes are two different bakes.
  const key = `${id}|${size}|${seed}|${worldScale}|${recipeOpts ? JSON.stringify(recipeOpts) : ''}`;
  const hit = _surfaceCache.get(key);
  if (hit) return hit;

  const N = size;
  const aniso = Config.gfx.anisotropy;
  const albedo = new Uint8Array(N * N * 4);
  const normal = new Uint8Array(N * N * 4);
  const arm = new Uint8Array(N * N * 4);

  const impl = recipe.build(seed, Object.assign({ worldScale, size: N }, recipeOpts || {}));

  // `reliefM` is the peak-to-peak height range in METRES; the normal encoder
  // wants it as a fraction of the tile. Authoring it as a fraction (the old
  // contract) meant a 2.4 m concrete tile carried 53 mm of relief and a 2 m
  // brick tile carried 60 mm mortar joints — both read as rubble, not masonry.
  const relief = recipe.reliefM != null
    ? recipe.reliefM / Math.max(0.05, worldScale)
    : (recipe.relief ?? 0.02);

  // Instant pass, splatted into the full-size buffers so the texture never
  // changes dimensions and nothing has to be re-linked.
  const coarse = Math.min(PREVIEW_TEXELS, N);
  runToCompletion(bakePass(impl, recipe, N, coarse, albedo, normal, arm, false, relief));

  const set = {
    map: makeDataTexture(albedo, N, true, aniso),
    normalMap: makeDataTexture(normal, N, false, aniso),
    armMap: makeDataTexture(arm, N, false, aniso),
    resolution: coarse,
    ready: false,
  };
  _surfaceCache.set(key, set);

  // Refine progressively from 128px up. Each stage costs a quarter of the next,
  // so the whole world reaches a legible resolution for ~6% of the work of one
  // full bake, and the ladder totals only ~1.33x a single full-resolution pass.
  const stages = [];
  for (let M = Math.min(FIRST_REFINE_TEXELS, N); M < N; M <<= 1) stages.push(M);
  stages.push(N);
  const refine = (function* () {
    for (const M of stages) {
      yield* bakePass(impl, recipe, N, M, albedo, normal, arm, true, relief);
      // Bumping the Source is enough: every clone that shares it re-uploads,
      // and no material or program is touched.
      set.map.source.needsUpdate = true;
      set.normalMap.source.needsUpdate = true;
      set.armMap.source.needsUpdate = true;
      set.resolution = M;
      yield;
    }
    set.ready = true;
  })();
  bakeScheduler.add(refine, key);

  return set;
}

function tiled(tex, repeat) {
  if (repeat === 1) return tex;
  const t = tex.clone();
  t.repeat.set(repeat, repeat);
  return t;
}

/* --------------------------------------------------------------- material */

/**
 * Single entry point. `preset` names a surface recipe; results are cached by
 * preset + options, so calling this repeatedly is free.
 *
 * opts:
 *   size        requested texture size (raised to the recipe minimum, capped
 *               by the quality tier)
 *   seed        deterministic variation
 *   repeat      UV tiling (ignored when the material is triplanar)
 *   triplanar   force world-space projection on/off (default: recipe's choice)
 *   worldScale  metres per texture tile. Drives the triplanar projection AND
 *               the bake itself — recipes author their feature sizes in metres
 *               and derive their lattices from this, so changing it re-bakes
 *               rather than just re-projecting. For UV-mapped surfaces the
 *               caller must set its UV scale to the same number.
 *   detail      override the detail-normal family, or `false` to disable
 *   detailMetres  size of one detail-normal tile in metres
 *   macro       macro-breakup strength. Internally split into a hard-capped
 *               mid band (~4-8 m) and a stronger low band (~15-30 m); values
 *               above the caps in SurfaceShader.js have no additional effect.
 *   envMapIntensity
 *   material    raw property overrides applied last
 *   recipe      recipe-specific parameters (e.g. asphalt_line's lineWidth)
 */
export function makeMaterial(preset, opts = {}) {
  const key = `${preset}:${JSON.stringify(opts)}:${Config.quality}`;
  const cached = _materialCache.get(key);
  if (cached) return cached;

  const { id, recipe } = resolveRecipe(preset);
  const size = resolveSize(opts.size, recipe);
  const seed = opts.seed ?? 1337;
  const repeat = opts.repeat ?? 1;

  const shaderOk = tierAllowsShaderDetail();
  const triplanar = shaderOk && (opts.triplanar ?? recipe.triplanar ?? false);
  // Metres per tile. For triplanar surfaces this is the projection frequency;
  // for UV-mapped ones the caller sets its UV scale to match. Either way it is
  // the unit the recipe authors its feature sizes in, so it must be resolved
  // before the bake, not after.
  const worldScale = opts.worldScale ?? recipe.worldScale ?? 2;

  const set = getSurfaceSet(id, recipe, size, seed, worldScale, opts.recipe);

  const props = {
    map: tiled(set.map, repeat),
    normalMap: tiled(set.normalMap, repeat),
    aoMap: tiled(set.armMap, repeat),
    roughnessMap: null,
    metalnessMap: null,
    // The armMap carries roughness in G and metalness in B; three samples the
    // same texture through both slots, so share one clone rather than three.
    roughness: 1.0,
    metalness: 1.0,
    normalScale: new THREE.Vector2(1, 1),
    envMapIntensity: opts.envMapIntensity ?? 1.0,
    dithering: true,
  };
  props.roughnessMap = props.aoMap;
  props.metalnessMap = props.aoMap;

  const Klass = recipe.klass === 'physical' ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const mat = new Klass(Object.assign(props, recipe.props || {}, opts.material || {}));

  if (shaderOk) {
    const detail = opts.detail === false ? null : (opts.detail ?? recipe.detail);
    // The detail normal is authored in metres too (`detailMetres` = size of one
    // detail tile). Tying it to the base tile instead meant a wall re-scaled
    // from 2.4 m to 1.0 m silently pulled its micro-relief down to 140 mm and
    // shimmered. Clamp so it never lands below ~2 cm.
    const detailMetres = opts.detailMetres ?? recipe.detailMetres ?? null;
    const detailScale = opts.detailScale ?? (detailMetres
      ? clamp(worldScale / detailMetres, 1, 24)
      : (recipe.detailScale ?? 6));
    applySurfaceShader(mat, {
      detail,
      detailScale,
      detailStrength: opts.detailStrength ?? recipe.detailStrength ?? 0.5,
      detailFade: opts.detailFade || [8, 26],
      macro: opts.macro ?? recipe.macro ?? 0,
      macroPeriod: opts.macroPeriod ?? 7,
      macroPeriodLow: opts.macroPeriodLow ?? 30,
      triplanar,
      worldScale,
      triSharp: opts.triSharp ?? 6,
      anisotropy: Config.gfx.anisotropy,
    });
  }

  mat.userData.preset = id;
  mat.userData.surface = set;
  mat.userData.triplanar = triplanar;
  mat.userData.worldScale = worldScale;
  _materialCache.set(key, mat);
  return mat;
}

/* ---------------------------------------------------------------- catalog */

/**
 * Everything `makeMaterial` understands. Other modules should read this rather
 * than hard-coding preset names — `triplanar: true` entries in particular
 * ignore `repeat` and take their scale from `worldScale` instead.
 */
export function getMaterialCatalog() {
  const out = [];
  for (const [id, r] of Object.entries(RECIPES)) {
    out.push({
      id,
      label: r.label,
      description: r.description,
      tags: r.tags ? r.tags.slice() : [],
      triplanar: !!r.triplanar,
      worldScale: r.worldScale ?? 2,
      minSize: r.minSize ?? 256,
      transparent: r.klass === 'physical',
      aliases: Object.keys(ALIASES).filter((a) => ALIASES[a] === id),
    });
  }
  return out;
}

/** Resolves once every queued bake has reached full resolution. */
export function materialsReady() { return bakeScheduler.whenIdle(); }

/** Force all pending bakes to finish now. Only for offline/headless capture. */
export function flushMaterialBakes() { bakeScheduler.flush(); }

export function clearMaterialCache() {
  for (const set of _surfaceCache.values()) {
    set.map.dispose(); set.normalMap.dispose(); set.armMap.dispose();
  }
  _surfaceCache.clear();
  for (const m of _materialCache.values()) {
    m.map?.dispose(); m.normalMap?.dispose(); m.aoMap?.dispose();
    m.dispose();
  }
  _materialCache.clear();
  disposeSharedMaps();
}

/* ------------------------------------------------------- legacy interface */

/**
 * Compatibility shim for the original height/shade surface builder. New code
 * should add a recipe in Recipes.js instead — that path gets curvature-driven
 * wear, chunked baking and the detail/macro shader for free.
 */
export function generateSurface({
  size = 512, seed = 1, height, shade,
  normalStrength = 2.0, aoStrength = 0.9, repeat = 1,
  anisotropy = Config.gfx.anisotropy,
} = {}) {
  const N = size;
  const rand = mulberry32(seed);
  const albedo = new Uint8Array(N * N * 4);
  const normal = new Uint8Array(N * N * 4);
  const arm = new Uint8Array(N * N * 4);
  const H = new Float32Array(N * N);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) H[y * N + x] = height((x + 0.5) / N, (y + 0.5) / N, rand);
  }
  normaliseRobust(H, 3);
  const d = deriveCurvatureAO(H, N, {}, { aoStrength, curvGain: 1 });
  encodeNormals(H, N, normal, normalStrength * 0.01);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x, j = i * 4;
      const s = shade((x + 0.5) / N, (y + 0.5) / N, H[i], rand) || [];
      albedo[j] = linearToSrgb8(clamp(s[0] ?? 0.2, 0.012, 0.85));
      albedo[j + 1] = linearToSrgb8(clamp(s[1] ?? 0.2, 0.012, 0.85));
      albedo[j + 2] = linearToSrgb8(clamp(s[2] ?? 0.2, 0.012, 0.85));
      albedo[j + 3] = 255;
      arm[j] = (clamp01(d.ao[i]) * 255) | 0;
      arm[j + 1] = (clamp(s[3] ?? 0.8, 0.03, 1) * 255) | 0;
      arm[j + 2] = (clamp01(s[4] ?? 0) * 255) | 0;
      arm[j + 3] = 255;
    }
  }

  const mk = (data, srgb) => {
    const t = makeDataTexture(data, N, srgb, anisotropy);
    t.repeat.set(repeat, repeat);
    return t;
  };
  return { map: mk(albedo, true), normalMap: mk(normal, false), armMap: mk(arm, false) };
}

export { mulberry32, fbm, RECIPES };

// Automated capture (the screenshot harness) renders a handful of frames and
// exits, so the default trickle would photograph the preview pass. Lift the
// ceiling — and the floor — when a WebDriver is attached; interactive play is
// untouched and keeps the adaptive behaviour.
if (typeof navigator !== 'undefined' && navigator.webdriver) {
  bakeScheduler.minMs = 24;
  bakeScheduler.maxMs = 60;
  bakeScheduler.budgetMs = 40;
}
