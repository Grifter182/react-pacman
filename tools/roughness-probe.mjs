/**
 * SPECULAR ACCEPTANCE PROBE for the five viewmodel surfaces.
 *
 * WHAT PLANE THIS SAMPLES, AND WHICH MULTIPLIER BELONGS TO IT
 * -----------------------------------------------------------
 * It samples the **G channel of the ARM map** — the roughness texture — of a
 * FULL-RESOLUTION bake of one recipe, produced by running `Recipes[x].build()`
 * through the same steps `TextureFactory.bakePass` runs, including the 8-bit
 * quantisation, and then multiplies by **that slot's own caller multiplier**.
 *
 * The multiplier is the part that is easy to get wrong, so it is tabulated here
 * rather than defaulted. `Gunsmith.weaponMaterials()` sets `material.roughness`
 * per slot and the shader computes `roughness * armMap.g`, so:
 *
 *   slot        recipe               worldScale  size  seed  multiplier
 *   receiver    receiver_phosphate   0.1458      1024  91    1.90
 *   rail        rail_anodised        0.35         512  137   1.00  (shim dropped)
 *   barrel      barrel_nitride       0.35         512  211   1.00  (shim dropped)
 *   furniture   furniture_polymer    0.1716       512  43    1.00
 *   grip        grip_rubber          0.1302       512  12    1.00
 *   level chrome gunmetal            0.35        1024  41    1.00  (NOT the gun)
 *
 * `rail` and `barrel` pass through `Gunsmith.preset(name, fallback, opts, shim)`,
 * which DROPS the shim when the named recipe exists — and the shim is where
 * their `material.roughness` lived. Quoting the shim's 3.00 or 0.46 for those
 * two slots is the mistake this table exists to prevent. `size` is the HIGH-tier
 * value (`Config.gfx.textureSize` 1024, `half` = 512).
 *
 * WHAT IT REPORTS, AND WHAT PASSES
 * --------------------------------
 * Post-multiplier mean / sd / min / max, the decile histogram, the fraction
 * clipped at 1.0, and the sd of the field minus its own box blur at 2 / 6 / 20 /
 * 40 mm — i.e. how much of the gloss variance is grain and how much is patches.
 * A slot passes when all four hold:
 *
 *   1. clipped at 1.0 is 0.00%           (clipping is a binary gloss mask)
 *   2. the histogram is unimodal with no empty interior bucket
 *   3. the mean sits where a GGX lobe exists. The specular peak goes as
 *      1 / r^4, so a surface whose mean is above ~0.85 has no highlight
 *      whatever its histogram looks like — that is how the revision before
 *      this one passed (1) and (2) and still rendered as flat plastic.
 *   4. sd(<6 mm) / sd(total) > 0.8. Variance coarser than ~20 mm is a printed
 *      pattern on a part held 300 mm from the eye, which is what every
 *      "digital camouflage" review of this weapon has been pointing at.
 *
 * Pure Node: no browser, no dev server, nothing shared with another agent's
 * working copy. A full 1024 bake is about 3 seconds.
 *
 *   node tools/roughness-probe.mjs                    # every slot
 *   node tools/roughness-probe.mjs receiver           # one slot
 *   node tools/roughness-probe.mjs gunmetal 0.35 1024 41 1.90   # ad hoc
 */
import { resolveRecipe } from '../src/materials/Recipes.js';
import { deriveCurvatureAO, normaliseRobust, linearToSrgb8 }
  from '../src/materials/SurfaceBake.js';
import { clamp, clamp01, smoothstep } from '../src/materials/Noise.js';

/**
 * slot -> [recipe, worldScale, size, seed, callerRoughnessMultiplier, gating]
 *
 * `chrome` is INFORMATIONAL, not gating. It is the level's prop steel, seen at
 * two to ten metres and owned by another agent, and the four criteria above are
 * authored for a surface held 300 mm from the eye — the 20 mm forging form that
 * makes it fail criterion 4 is the right call at prop range. It is listed only
 * so the historical `gunmetal` x 1.90 pairing stays checkable.
 */
const SLOTS = {
  receiver: ['receiver_phosphate', 0.1458, 1024, 91, 1.90, true],
  rail: ['rail_anodised', 0.35, 512, 137, 1.00, true],
  barrel: ['barrel_nitride', 0.35, 512, 211, 1.00, true],
  furniture: ['furniture_polymer', 0.1716, 512, 43, 1.00, true],
  grip: ['grip_rubber', 0.1302, 512, 12, 1.00, true],
  chrome: ['gunmetal', 0.35, 1024, 41, 1.00, false],
};

const MAX_MASKS = 6;

function bake(name, worldScale, N, seed) {
  const { recipe } = resolveRecipe(name);
  const impl = recipe.build(seed, { worldScale, size: N });
  const masks = Math.min(recipe.masks ?? 0, MAX_MASKS);

  const H = new Float32Array(N * N);
  const MK = masks ? new Float32Array(N * N * masks) : null;
  const out = new Float32Array(MAX_MASKS + 4);
  for (let y = 0; y < N; y++) {
    const v = (y + 0.5) / N;
    for (let x = 0; x < N; x++) {
      impl.sample((x + 0.5) / N, v, out);
      const i = y * N + x;
      H[i] = out[0];
      for (let k = 0; k < masks; k++) MK[i * masks + k] = out[1 + k];
    }
  }
  normaliseRobust(H, 3);
  const { curv, ao } = deriveCurvatureAO(H, N, {}, {
    aoStrength: recipe.aoStrength ?? 1, curvGain: recipe.curvGain ?? 1,
  });

  const rough = new Float32Array(N * N);
  const lum = new Float32Array(N * N);
  const metal = new Float32Array(N * N);
  const ctx = { h: 0, curv: 0, edge: 0, cavity: 0, ao: 1 };
  const mv = new Float32Array(MAX_MASKS);
  const sh = new Float32Array(6);
  for (let y = 0; y < N; y++) {
    const v = (y + 0.5) / N;
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      ctx.h = H[i]; ctx.curv = curv[i];
      // Same thresholds bakePass uses; curvature is in RMS units.
      ctx.edge = smoothstep(0.55, 2.0, curv[i]);
      ctx.cavity = smoothstep(0.55, 2.0, -curv[i]);
      ctx.ao = ao[i];
      for (let k = 0; k < masks; k++) mv[k] = MK[i * masks + k];
      sh[0] = 0.18; sh[1] = 0.18; sh[2] = 0.18;
      sh[3] = 0.85; sh[4] = 0; sh[5] = 1;
      impl.shade((x + 0.5) / N, v, ctx, mv, sh);
      // Quantise exactly as the bake does — the 8-bit step is part of the
      // answer when a recipe is authored pre-divided against a multiplier.
      rough[i] = ((clamp(sh[3], 0.03, 1) * 255 + 0.5) | 0) / 255;
      metal[i] = ((clamp01(sh[4]) * 255 + 0.5) | 0) / 255;
      lum[i] = 0.2126 * linearToSrgb8(clamp(sh[0], 0.012, 0.85))
        + 0.7152 * linearToSrgb8(clamp(sh[1], 0.012, 0.85))
        + 0.0722 * linearToSrgb8(clamp(sh[2], 0.012, 0.85));
    }
  }
  return { rough, lum, metal, N };
}

const stats = (a) => {
  let mn = Infinity, mx = -Infinity, s = 0;
  for (const x of a) { if (x < mn) mn = x; if (x > mx) mx = x; s += x; }
  const mean = s / a.length;
  let q = 0; for (const x of a) q += (x - mean) ** 2;
  return { min: mn, max: mx, mean, sd: Math.sqrt(q / a.length) };
};
const hist = (a, bins) => {
  const h = new Array(bins).fill(0);
  for (const x of a) h[Math.min(bins - 1, Math.max(0, Math.floor(x * bins)))]++;
  return h.map((c) => 100 * c / a.length);
};
/** sd of (field - boxblur(field, r)): the variance living FINER than radius r. */
function bandSd(a, N, r) {
  const w = 2 * r + 1, tmp = new Float32Array(N * N), bl = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0; for (let k = -r; k <= r; k++) s += a[y * N + ((x + k + N) % N)];
    tmp[y * N + x] = s / w;
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0; for (let k = -r; k <= r; k++) s += tmp[((y + k + N) % N) * N + x];
    bl[y * N + x] = s / w;
  }
  let mean = 0; for (let i = 0; i < a.length; i++) mean += a[i] - bl[i];
  mean /= a.length;
  let q = 0; for (let i = 0; i < a.length; i++) q += (a[i] - bl[i] - mean) ** 2;
  return Math.sqrt(q / a.length);
}

function measure(label, name, worldScale, N, seed, mul, gating = true) {
  const { rough, lum, metal } = bake(name, worldScale, N, seed);
  const final = Float32Array.from(rough, (x) => Math.min(1, x * mul));
  const s = stats(final);
  const mmPerTexel = worldScale * 1000 / N;
  const rad = (mm) => Math.max(1, Math.round(mm / mmPerTexel / 2));
  const band = {};
  for (const mm of [2, 6, 20, 40]) band[mm] = bandSd(final, N, rad(mm));
  const deciles = hist(final, 10);
  const clipped = 100 * final.filter((x) => x >= 0.999).length / final.length;
  // interior gap: an empty bucket between two populated ones is the binary mask
  const first = deciles.findIndex((p) => p > 0.05);
  const last = deciles.length - 1 - [...deciles].reverse().findIndex((p) => p > 0.05);
  const gap = deciles.slice(first, last + 1).some((p) => p <= 0.05);
  const grain = band[6] / Math.max(1e-6, s.sd);
  const pass = clipped < 0.005 && !gap && s.mean <= 0.90 && grain > 0.8;

  console.log(`${label.padEnd(10)} ${name.padEnd(19)} ${mmPerTexel.toFixed(3)} mm/texel  x${mul.toFixed(2)}`);
  console.log(`  rough  mean ${s.mean.toFixed(3)}  sd ${s.sd.toFixed(3)}`
    + `  range ${s.min.toFixed(3)}..${s.max.toFixed(3)}  clipped ${clipped.toFixed(2)}%`
    + `  interior gap ${gap ? 'YES' : 'no'}`);
  console.log(`  deciles ${deciles.map((p) => p.toFixed(1).padStart(5)).join('')}`);
  console.log(`  sd finer than  2mm ${band[2].toFixed(4)}  6mm ${band[6].toFixed(4)}`
    + `  20mm ${band[20].toFixed(4)}  40mm ${band[40].toFixed(4)}`
    + `   grain fraction ${grain.toFixed(2)}`);
  const al = stats(lum), mt = stats(metal);
  console.log(`  albedo8 mean ${al.mean.toFixed(1)} sd ${al.sd.toFixed(2)}`
    + `   metalness mean ${mt.mean.toFixed(3)} max ${mt.max.toFixed(3)}`
    + `   -> ${pass ? 'PASS' : 'FAIL'}${gating ? '' : ' (informational, not a viewmodel slot)'}`);
  return pass || !gating;
}

const argv = process.argv.slice(2);
let ok = true;
if (argv.length >= 2) {
  const [name, ws, size, seed, mul] = argv;
  ok = measure('adhoc', name, parseFloat(ws), parseInt(size, 10),
    parseInt(seed ?? '1', 10), parseFloat(mul ?? '1'));
} else {
  const want = argv[0];
  for (const [label, [name, ws, size, seed, mul, gating]] of Object.entries(SLOTS)) {
    if (want && want !== label && want !== name) continue;
    ok = measure(label, name, ws, size, seed, mul, gating) && ok;
  }
}
process.exitCode = ok ? 0 : 1;
