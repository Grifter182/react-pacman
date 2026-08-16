import {
  fbm, fbm01, ridged, worley, warped, Cell, lattice,
  hash2f, clamp, clamp01, mix, smoothstep, tri,
} from './Noise.js';

/**
 * OWNER: materials / texturing agent.
 *
 * The surface recipe library. One entry per material; each one is a pure
 * description that the baker turns into a tileable PBR set.
 *
 * Recipe contract
 * ---------------
 *   sample(u, v, out)      out[0] = height (arbitrary units, normalised later)
 *                          out[1..masks] = recipe-private masks
 *   shade(u, v, c, m, out) c = { h, curv, edge, cavity, ao } derived from the
 *                          height field; m = this texel's masks;
 *                          out = [ r, g, b, roughness, metalness, aoScale ]
 *
 * Two rules run through every recipe here:
 *
 *  - **Albedo is authored in linear reflectance.** The baker applies the sRGB
 *    OETF on the way into the texture. Values stay inside real-world bounds:
 *    nothing darker than fresh asphalt (~0.02) and nothing brighter than fresh
 *    plaster (~0.8). No pure black, no pure white — both are unphysical and
 *    both destroy the tonal range the grade needs.
 *  - **Metalness is a phase, not a slider.** A texel is either conductor or
 *    dielectric; the only intermediate values are the couple of texels where a
 *    rust or paint mask crosses over. Roughness is driven by those same masks,
 *    so wear reads as one coherent story instead of three unrelated noises.
 *
 * Wear itself comes from curvature (`c.edge`, `c.cavity`), never from a stray
 * noise field: paint leaves convex edges first, grime collects in concave
 * cavities. That single coupling is most of what separates a surface that
 * looks used from a surface that looks dirty.
 */

/* --------------------------------------------------------- colour helpers */

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
/** Author colours the way they are measured (sRGB), store them linear. */
const srgb = (r, g, b) => [toLinear(r), toLinear(g), toLinear(b)];

/* ------------------------------------------------------------- palette */

const C_CONCRETE = srgb(0.53, 0.52, 0.50);
const C_AGGREGATE = srgb(0.63, 0.61, 0.57);
const C_PLASTER = srgb(0.79, 0.77, 0.72);
const C_BRICK = srgb(0.52, 0.28, 0.22);
const C_BRICK_ALT = srgb(0.44, 0.24, 0.20);
const C_MORTAR = srgb(0.56, 0.55, 0.51);
const C_STEEL = srgb(0.72, 0.73, 0.74);          // bare mild steel, conductor F0
const C_STEEL_DARK = srgb(0.47, 0.47, 0.49);     // parkerised / blued
const C_RUST = srgb(0.46, 0.22, 0.10);
const C_RUST_DARK = srgb(0.27, 0.13, 0.07);
const C_PAINT = srgb(0.34, 0.35, 0.28);          // olive drab
const C_ZINC = srgb(0.66, 0.67, 0.68);
const C_SAND = srgb(0.70, 0.61, 0.44);
const C_SAND_DARK = srgb(0.52, 0.44, 0.31);
const C_STONE = srgb(0.44, 0.42, 0.39);
const C_ASPHALT = srgb(0.20, 0.20, 0.21);
const C_ASPHALT_AGG = srgb(0.34, 0.33, 0.32);
const C_ROADPAINT = srgb(0.84, 0.82, 0.74);
const C_WOOD = srgb(0.46, 0.32, 0.19);
const C_WOOD_DARK = srgb(0.28, 0.18, 0.10);
const C_BURLAP = srgb(0.55, 0.47, 0.33);
const C_TILE = srgb(0.83, 0.81, 0.77);
const C_GROUT = srgb(0.52, 0.50, 0.47);
const C_RUBBER = srgb(0.17, 0.17, 0.18);
const C_CANVAS = srgb(0.39, 0.38, 0.29);
const C_POLYMER = srgb(0.16, 0.16, 0.17);
const C_DIRT = srgb(0.24, 0.20, 0.15);

/* ---------------------------------------------------------------- recipes */

export const RECIPES = {

  /* ===================================================== cracked concrete */
  concrete: {
    label: 'Cracked concrete',
    description: 'Poured slab: exposed aggregate, spalling pits, warped crack network, cavity soot.',
    tags: ['architecture', 'wall', 'ground'],
    minSize: 512, relief: 0.022, masks: 3,
    aoStrength: 1.0, curvGain: 1.0,
    detail: 'grain', detailScale: 7, detailStrength: 0.6,
    macro: 0.45, triplanar: true, worldScale: 2.4,
    build(seed) {
      const slab = fbm(seed + 11, 3, 5, 0.55);
      const fine = fbm(seed + 12, 30, 2, 0.5);
      const wear = fbm01(seed + 13, 2, 3, 0.6);
      const wobble = fbm(seed + 14, 5, 2, 0.5);
      const cracks = worley(seed + 15, 6, 0.85);
      const pits = worley(seed + 16, 22, 1.0);
      const aggr = worley(seed + 17, 46, 1.0);
      const cA = new Cell(), cB = new Cell(), cC = new Cell();
      return {
        sample(u, v, out) {
          // The F2-F1 border field of a domain-warped cellular grid is a
          // connected polygonal graph — which is how concrete actually
          // fractures — and the warp pulls it off the lattice axes.
          const wu = u + wobble(u * 2, v * 2) * 0.05;
          const wv = v + wobble(u * 2 + 2.7, v * 2 - 1.3) * 0.05;
          cracks(wu, wv, cA);
          const border = cA.f2 - cA.f1;
          const crack = smoothstep(0.050, 0.004, border) * smoothstep(0.40, 0.60, wear(u, v));

          pits(u, v, cB);
          const pit = smoothstep(0.30, 0.06, cB.f1) * (cB.rand(1) > 0.66 ? 1 : 0);

          aggr(u, v, cC);
          const expose = smoothstep(0.46, 0.74, wear(u * 2 + 4.1, v * 2));
          const agg = smoothstep(0.33, 0.11, cC.f1) * expose;

          out[0] = slab(u, v) * 0.42 + fine(u, v) * 0.10 + agg * 0.20 - crack * 0.85 - pit * 0.55;
          out[1] = crack; out[2] = agg; out[3] = expose;
        },
        shade(u, v, c, m, out) {
          const crack = m[0], agg = m[1], expose = m[2];
          const tone = 0.74 + c.h * 0.52;
          let r = C_CONCRETE[0] * tone, g = C_CONCRETE[1] * tone, b = C_CONCRETE[2] * tone;
          r = mix(r, C_AGGREGATE[0], agg * 0.85);
          g = mix(g, C_AGGREGATE[1], agg * 0.85);
          b = mix(b, C_AGGREGATE[2], agg * 0.85);

          // Grime settles where water sits; rain and boots scrub the ridges.
          const dirt = c.cavity * (0.55 + expose * 0.30);
          r = mix(r, C_DIRT[0], dirt * 0.42);
          g = mix(g, C_DIRT[1], dirt * 0.45);
          b = mix(b, C_DIRT[2], dirt * 0.44);
          const worn = c.edge * 0.55;
          r = mix(r, r * 1.20 + 0.010, worn);
          g = mix(g, g * 1.20 + 0.010, worn);
          b = mix(b, b * 1.20 + 0.010, worn);

          const ck = crack * 0.92;
          r = mix(r, 0.021, ck); g = mix(g, 0.020, ck); b = mix(b, 0.020, ck);

          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(0.88 + c.cavity * 0.06 - worn * 0.22 - agg * 0.12, 0.30, 1.0);
          out[4] = 0;
          out[5] = 1 - crack * 0.30;
        },
      };
    },
  },

  /* ============================================ weathered plaster + brick */
  plaster: {
    label: 'Weathered plaster over brick',
    description: 'Lime render blown off in patches to reveal a running-bond brick course; rain streaking below every break.',
    tags: ['architecture', 'wall'],
    minSize: 512, relief: 0.026, masks: 3,
    aoStrength: 1.05, curvGain: 1.0,
    detail: 'grain', detailScale: 6, detailStrength: 0.5,
    macro: 0.40, triplanar: true, worldScale: 2.0,
    build(seed) {
      const COLS = 9, ROWS = 26;              // 2 m tile -> 222 x 77 mm courses
      const L = { lx: 0, ly: 0, col: 0, row: 0, id: 0 };
      const skim = fbm(seed + 21, 6, 4, 0.55);
      const grit = fbm(seed + 22, 40, 2, 0.5);
      const blown = warped(fbm01(seed + 23, 3, 4, 0.58), seed + 24, 0.09, 4, 2);
      const brickN = fbm(seed + 25, 24, 2, 0.5);
      const streak = fbm(seed + 26, 3, 3, 0.62);
      return {
        sample(u, v, out) {
          lattice(u, v, COLS, ROWS, 0.5, seed + 27, L);
          // Mortar joints: ~10 mm on a 222 x 77 mm cell is 4.5% across and
          // 13% down, so the two axes need different thresholds.
          const jx = Math.min(L.lx, 1 - L.lx);
          const jy = Math.min(L.ly, 1 - L.ly);
          const face = Math.min(smoothstep(0.020, 0.055, jx), smoothstep(0.055, 0.135, jy));
          const mortar = 1 - face;

          const bTone = hash2f(L.col, L.row, seed + 28);
          // Bricks are individually proud or sunk by a couple of millimetres.
          const brickH = face * (0.30 + (bTone - 0.5) * 0.10) + brickN(u * 3, v * 3) * 0.05;

          // Plaster survives where the render field is high; the boundary is
          // deliberately hard — render sheets off in flakes, it does not fade.
          const p = smoothstep(0.46, 0.545, blown(u, v));
          const plasterH = p * (0.62 + skim(u, v) * 0.18) + grit(u, v) * 0.05 * p;

          out[0] = brickH + plasterH;
          out[1] = p; out[2] = mortar; out[3] = bTone;
        },
        shade(u, v, c, m, out) {
          const p = m[0], mortar = m[1], bTone = m[2];
          // brick / mortar substrate
          let br = mix(C_BRICK[0], C_BRICK_ALT[0], bTone);
          let bg = mix(C_BRICK[1], C_BRICK_ALT[1], bTone);
          let bb = mix(C_BRICK[2], C_BRICK_ALT[2], bTone);
          const bn = 0.82 + c.h * 0.36;
          br *= bn; bg *= bn; bb *= bn;
          let r = mix(br, C_MORTAR[0] * 0.92, mortar);
          let g = mix(bg, C_MORTAR[1] * 0.92, mortar);
          let b = mix(bb, C_MORTAR[2] * 0.92, mortar);
          let rough = mix(0.90, 0.96, mortar);

          // plaster coat
          const pt = 0.84 + c.h * 0.28;
          const pr = C_PLASTER[0] * pt, pg = C_PLASTER[1] * pt, pb = C_PLASTER[2] * pt;
          r = mix(r, pr, p); g = mix(g, pg, p); b = mix(b, pb, p);
          rough = mix(rough, 0.88, p);

          // Rain streaking: dirt washed out of the broken render runs down the
          // face below it, so the streak field is stretched hard along v.
          const st = clamp01(streak(u * 6, v) * 0.5 + 0.5);
          const wash = smoothstep(0.55, 0.95, st) * (1 - p * 0.55) * (0.35 + c.cavity * 0.5);
          r = mix(r, C_DIRT[0], wash * 0.5);
          g = mix(g, C_DIRT[1], wash * 0.52);
          b = mix(b, C_DIRT[2], wash * 0.52);

          // Salt / lime bloom sits on the convex arris of every brick.
          const bloom = c.edge * (1 - p) * 0.35;
          r = mix(r, 0.42, bloom); g = mix(g, 0.41, bloom); b = mix(b, 0.39, bloom);

          const dirt = c.cavity * 0.55;
          r *= 1 - dirt * 0.35; g *= 1 - dirt * 0.37; b *= 1 - dirt * 0.38;

          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(rough + c.cavity * 0.05 - c.edge * 0.10, 0.35, 1.0);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },

  /* ====================================================== brick, unrendered */
  brick: {
    label: 'Brick wall',
    description: 'Running-bond fired clay with recessed mortar, efflorescence on the arrises and soot in the joints.',
    tags: ['architecture', 'wall'],
    minSize: 512, relief: 0.030, masks: 3,
    aoStrength: 1.15, curvGain: 1.0,
    detail: 'grain', detailScale: 6, detailStrength: 0.55,
    macro: 0.40, triplanar: true, worldScale: 2.0,
    build(seed) {
      const COLS = 9, ROWS = 26;
      const L = { lx: 0, ly: 0, col: 0, row: 0, id: 0 };
      const clay = fbm(seed + 31, 20, 3, 0.55);
      const sandy = fbm(seed + 32, 60, 2, 0.5);
      const chip = worley(seed + 33, 30, 1.0);
      const cA = new Cell();
      return {
        sample(u, v, out) {
          lattice(u, v, COLS, ROWS, 0.5, seed + 34, L);
          const jx = Math.min(L.lx, 1 - L.lx);
          const jy = Math.min(L.ly, 1 - L.ly);
          const face = Math.min(smoothstep(0.018, 0.050, jx), smoothstep(0.050, 0.128, jy));
          const bTone = hash2f(L.col, L.row, seed + 35);
          // Slight pillowing across each brick face reads as fired clay.
          const pillow = face * (1 - Math.pow(Math.abs(L.lx * 2 - 1), 3) * 0.35);
          chip(u, v, cA);
          const chipped = smoothstep(0.22, 0.05, cA.f1) * (cA.rand(2) > 0.86 ? 1 : 0) * face;
          out[0] = pillow * (0.62 + (bTone - 0.5) * 0.14)
            + clay(u * 2, v * 2) * 0.08 + sandy(u, v) * 0.03 - chipped * 0.35;
          out[1] = face; out[2] = bTone; out[3] = chipped;
        },
        shade(u, v, c, m, out) {
          const face = m[0], bTone = m[1], chipped = m[2];
          const t = 0.80 + c.h * 0.34;
          let r = mix(C_BRICK[0], C_BRICK_ALT[0], bTone) * t;
          let g = mix(C_BRICK[1], C_BRICK_ALT[1], bTone) * t;
          let b = mix(C_BRICK[2], C_BRICK_ALT[2], bTone) * t;
          // fresh fracture is paler and less weathered than the fired skin
          r = mix(r, r * 1.45 + 0.02, chipped);
          g = mix(g, g * 1.40 + 0.02, chipped);
          b = mix(b, b * 1.35 + 0.02, chipped);
          const mortar = 1 - face;
          r = mix(r, C_MORTAR[0], mortar); g = mix(g, C_MORTAR[1], mortar); b = mix(b, C_MORTAR[2], mortar);

          const bloom = c.edge * 0.40 * face;
          r = mix(r, 0.44, bloom); g = mix(g, 0.43, bloom); b = mix(b, 0.41, bloom);
          const soot = c.cavity * 0.7;
          r *= 1 - soot * 0.45; g *= 1 - soot * 0.47; b *= 1 - soot * 0.47;

          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(mix(0.87, 0.96, mortar) + chipped * 0.05 - c.edge * 0.08, 0.4, 1.0);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },

  /* ==================================================== rusted painted steel */
  metal: {
    label: 'Painted steel, rusting',
    description: 'Riveted panel plate in olive drab: paint chipping off the arrises, rust blooming out of the cavities and running downward.',
    tags: ['prop', 'crate', 'industrial'],
    minSize: 512, relief: 0.009, masks: 3,
    aoStrength: 0.9, curvGain: 1.15,
    detail: 'brushed', detailScale: 5, detailStrength: 0.45,
    macro: 0.30, triplanar: false, worldScale: 1.4,
    build(seed) {
      const PC = 3, PR = 2;
      const L = { lx: 0, ly: 0, col: 0, row: 0, id: 0 };
      const oilcan = fbm(seed + 41, 4, 3, 0.5);
      const mill = fbm(seed + 42, 8, 2, 0.5);
      const rustF = warped(fbm01(seed + 43, 3, 4, 0.6), seed + 44, 0.10, 4, 2);
      const runs = fbm01(seed + 45, 4, 3, 0.6);
      const chipN = fbm01(seed + 46, 12, 3, 0.6);
      const scab = fbm(seed + 47, 40, 2, 0.5);
      return {
        sample(u, v, out) {
          lattice(u, v, PC, PR, 0, seed + 48, L);
          const dx = Math.min(L.lx, 1 - L.lx) / PC;      // back into tile units
          const dy = Math.min(L.ly, 1 - L.ly) / PR;
          const seam = 1 - smoothstep(0.0015, 0.0060, Math.min(dx, dy));

          // Rivet line: 10 per panel, set in 1 cm from the horizontal seam.
          const rdu = ((u * PC * 10) % 1 - 0.5) / (PC * 10);
          const rdv = dy - 0.010;
          const rivet = smoothstep(0.0062, 0.0022, Math.sqrt(rdu * rdu + rdv * rdv));

          // Rust is a growth process: the base field is warped so blooms have
          // fingers, and vertical runs bleed out of them.
          const rust = clamp01(rustF(u, v) * 1.05 + runs(u * 6, v) * 0.30 - 0.18);

          out[0] = oilcan(u, v) * 0.30 + mill(u * 4, v) * 0.06
            - seam * 0.90 + rivet * 0.55 + scab(u, v) * rust * 0.22;
          out[1] = rust; out[2] = chipN(u, v); out[3] = seam;
        },
        shade(u, v, c, m, out) {
          const rustBase = m[0], chipNoise = m[1], seam = m[2];
          // Water sits in the cavities and drains off the ridges, so curvature
          // biases the rust field before it is thresholded.
          const rust = clamp01(rustBase + c.cavity * 0.40 - c.edge * 0.14 + seam * 0.18);
          const rusted = smoothstep(0.475, 0.545, rust);
          // Paint leaves the arrises first; the noise only decides *where*
          // along an arris, never whether a flat field spontaneously chips.
          const chip = clamp01(smoothstep(0.30, 0.82, c.edge) * (0.30 + chipNoise * 1.1)
            + smoothstep(0.86, 0.99, chipNoise) * 0.6);
          const chipped = smoothstep(0.44, 0.52, chip);
          const paint = clamp01(1 - Math.max(chipped, rusted));

          const pt = 0.82 + c.h * 0.30;
          let r = mix(C_STEEL[0], C_PAINT[0] * pt, paint);
          let g = mix(C_STEEL[1], C_PAINT[1] * pt, paint);
          let b = mix(C_STEEL[2], C_PAINT[2] * pt, paint);

          const rt = 0.65 + chipNoise * 0.7;
          r = mix(r, mix(C_RUST_DARK[0], C_RUST[0], rt), rusted);
          g = mix(g, mix(C_RUST_DARK[1], C_RUST[1], rt), rusted);
          b = mix(b, mix(C_RUST_DARK[2], C_RUST[2], rt), rusted);

          const grime = c.cavity * 0.55;
          r *= 1 - grime * 0.30; g *= 1 - grime * 0.32; b *= 1 - grime * 0.33;

          out[0] = r; out[1] = g; out[2] = b;
          // Paint is a rough dielectric, bare steel a smooth conductor, rust a
          // very rough dielectric — one mask pair drives all three.
          out[3] = clamp(mix(mix(0.30, 0.58, paint), 0.94, rusted) - c.edge * 0.06, 0.10, 1.0);
          out[4] = (1 - paint) * (1 - rusted);
          out[5] = 1;
        },
      };
    },
  },

  /* ===================================================== corrugated sheeting */
  corrugated: {
    label: 'Corrugated galvanised sheet',
    description: 'Rolled profile with zinc spangle, rust creeping out of the valleys and along the cut edges.',
    tags: ['prop', 'industrial', 'wall'],
    minSize: 512, relief: 0.075, masks: 3,
    aoStrength: 1.0, curvGain: 0.7,
    detail: 'brushed', detailScale: 6, detailStrength: 0.35,
    macro: 0.30, triplanar: false, worldScale: 1.8,
    build(seed) {
      const RIBS = 8;
      const spangle = worley(seed + 51, 26, 1.0);
      const dent = fbm(seed + 52, 5, 3, 0.5);
      const rustF = warped(fbm01(seed + 53, 4, 4, 0.6), seed + 54, 0.08, 4, 2);
      const runs = fbm01(seed + 55, 5, 3, 0.6);
      const cA = new Cell();
      return {
        sample(u, v, out) {
          // Trapezoidal-ish profile: a raised cosine flattened at the crowns.
          const phase = u * RIBS;
          const s = Math.cos(phase * Math.PI * 2);
          const profile = Math.sign(s) * Math.pow(Math.abs(s), 0.6);
          spangle(u, v, cA);
          const facet = cA.rand(3);
          out[0] = profile * 0.5 + dent(u, v) * 0.06 + (facet - 0.5) * 0.012;
          out[1] = clamp01(rustF(u, v) + runs(u * 3, v) * 0.35 - 0.2);
          out[2] = facet;
          out[3] = profile * 0.5 + 0.5;
        },
        shade(u, v, c, m, out) {
          const rustBase = m[0], facet = m[1], crown = m[2];
          // Water tracks down the valleys, so rust follows the profile as much
          // as it follows the noise.
          const rust = clamp01(rustBase + (1 - crown) * 0.35 + c.cavity * 0.25 - c.edge * 0.20 - 0.10);
          const rusted = smoothstep(0.495, 0.565, rust);

          // Zinc spangle: large crystal facets with slightly different tilt.
          const zt = 0.80 + facet * 0.42;
          let r = C_ZINC[0] * zt, g = C_ZINC[1] * zt, b = C_ZINC[2] * zt;
          r = mix(r, C_RUST[0], rusted); g = mix(g, C_RUST[1], rusted); b = mix(b, C_RUST[2], rusted);

          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(mix(0.36 + facet * 0.14, 0.93, rusted), 0.12, 1.0);
          out[4] = 1 - rusted;
          out[5] = 1;
        },
      };
    },
  },

  /* ================================================================== sand */
  sand: {
    label: 'Wind-rippled sand',
    description: 'Dune surface with a warped ripple train, scattered gravel and damp compaction in the troughs.',
    tags: ['ground', 'terrain'],
    minSize: 512, relief: 0.030, masks: 3,
    aoStrength: 0.85, curvGain: 0.8,
    detail: 'grain', detailScale: 9, detailStrength: 0.7,
    macro: 0.50, triplanar: true, worldScale: 3.2,
    build(seed) {
      const RIPPLES = 17;
      const dune = fbm(seed + 61, 2, 4, 0.55);
      const crest = ridged(seed + 66, 3, 3, 0.5, 2.6);
      const warp = fbm(seed + 62, 3, 2, 0.5);
      const grain = fbm(seed + 63, 80, 2, 0.5);
      const peb = worley(seed + 64, 30, 1.0);
      const drift = fbm01(seed + 65, 3, 3, 0.6);
      const cA = new Cell();
      return {
        sample(u, v, out) {
          // Ripples are a phase-modulated train, not a sine: the crests are
          // sharp and the troughs broad because that is how saltation piles it.
          // Dune crests are ridges, not blobs — the slip face is a
          // discontinuity in the sand transport, so a ridged multifractal is
          // the correct primitive and plain fbm is not.
          const dn = dune(u, v) * 0.60 + (crest(u, v) - 0.42) * 0.95;
          const ph = v * RIPPLES + warp(u * 2, v * 2) * 2.4 + dn * 1.6;
          const s = 0.5 + 0.5 * Math.cos(ph * Math.PI * 2);
          const ripple = s * s * Math.sqrt(s) * 0.5 + s * s * 0.5;   // ~pow(s,1.7)
          const cover = smoothstep(0.35, 0.65, drift(u, v));

          peb(u, v, cA);
          const stone = smoothstep(0.32, 0.10, cA.f1) * (cA.rand(4) > 0.74 ? 1 : 0) * (1 - cover * 0.6);

          out[0] = dn * 0.55 + ripple * 0.20 * cover + grain(u, v) * 0.07 + stone * 0.26;
          out[1] = stone; out[2] = ripple * cover; out[3] = cover;
        },
        shade(u, v, c, m, out) {
          const stone = m[0], ripple = m[1];
          const t = 0.78 + c.h * 0.44;
          let r = C_SAND[0] * t, g = C_SAND[1] * t, b = C_SAND[2] * t;
          // Troughs hold moisture and the fines settle there — darker, denser.
          const damp = c.cavity * 0.75;
          r = mix(r, C_SAND_DARK[0], damp * 0.7);
          g = mix(g, C_SAND_DARK[1], damp * 0.7);
          b = mix(b, C_SAND_DARK[2], damp * 0.72);
          // Crests are dry, dusty and slightly brighter.
          const dry = c.edge * 0.4 + ripple * 0.25;
          r = mix(r, r * 1.16 + 0.012, dry);
          g = mix(g, g * 1.15 + 0.010, dry);
          b = mix(b, b * 1.12 + 0.008, dry);

          const st = 0.7 + hash2f((u * 4096) | 0, (v * 4096) | 0, 7) * 0.6;
          r = mix(r, C_STONE[0] * st, stone);
          g = mix(g, C_STONE[1] * st, stone);
          b = mix(b, C_STONE[2] * st, stone);

          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(0.95 - stone * 0.20 - damp * 0.08, 0.45, 1.0);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },

  /* ================================================================ gravel */
  gravel: {
    label: 'Gravel bed',
    description: 'Packed crushed stone: two grades of aggregate bedded in fines, dust washed into the interstices.',
    tags: ['ground', 'terrain'],
    minSize: 512, relief: 0.055, masks: 3,
    aoStrength: 1.25, curvGain: 0.9,
    detail: 'grain', detailScale: 8, detailStrength: 0.65,
    macro: 0.45, triplanar: true, worldScale: 2.6,
    build(seed) {
      const big = worley(seed + 71, 16, 1.0);
      const small = worley(seed + 72, 38, 1.0);
      const fines = fbm(seed + 73, 24, 3, 0.55);
      const dustF = fbm01(seed + 74, 3, 3, 0.6);
      const cA = new Cell(), cB = new Cell();
      return {
        sample(u, v, out) {
          big(u, v, cA);
          small(u, v, cB);
          // Stones are ellipsoid caps: sqrt profile, not a gaussian, so the
          // silhouette has a real edge for the curvature pass to find.
          const rA = clamp01(1 - cA.f1 / (0.28 + cA.rand(5) * 0.18));
          const rB = clamp01(1 - cB.f1 / (0.30 + cB.rand(6) * 0.16));
          const hA = Math.sqrt(rA) * (0.55 + cA.rand(7) * 0.45);
          const hB = Math.sqrt(rB) * (0.30 + cB.rand(8) * 0.28);
          const stone = Math.max(hA, hB * 0.8);
          out[0] = stone * 0.8 + fines(u, v) * 0.10;
          out[1] = smoothstep(0.05, 0.35, stone);
          out[2] = hA > hB * 0.8 ? cA.rand(9) : cB.rand(9);
          out[3] = dustF(u, v);
        },
        shade(u, v, c, m, out) {
          const stone = m[0], tint = m[1], dust = m[2];
          const t = 0.62 + tint * 0.75;
          let r = C_STONE[0] * t, g = C_STONE[1] * t, b = C_STONE[2] * t;
          // Fresh crushed faces are paler than the weathered rind.
          r = mix(r, r * 1.3 + 0.015, c.edge * 0.45);
          g = mix(g, g * 1.28 + 0.014, c.edge * 0.45);
          b = mix(b, b * 1.26 + 0.013, c.edge * 0.45);
          // Interstitial fines: everything not a stone is dust.
          const fill = (1 - stone) * (0.5 + dust * 0.5);
          r = mix(r, C_SAND_DARK[0], fill * 0.75);
          g = mix(g, C_SAND_DARK[1], fill * 0.75);
          b = mix(b, C_SAND_DARK[2], fill * 0.75);
          const grime = c.cavity * 0.7;
          r *= 1 - grime * 0.35; g *= 1 - grime * 0.36; b *= 1 - grime * 0.36;
          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(mix(0.96, 0.82, stone) - c.edge * 0.10, 0.45, 1.0);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },

  /* =============================================================== asphalt */
  asphalt: {
    label: 'Asphalt',
    description: 'Bitumen-bound aggregate: exposed stone at the surface, fatigue cracking, oil staining in the ruts.',
    tags: ['ground', 'road'],
    minSize: 512, relief: 0.016, masks: 3,
    aoStrength: 1.0, curvGain: 1.0,
    detail: 'grain', detailScale: 8, detailStrength: 0.6,
    macro: 0.40, triplanar: true, worldScale: 3.0,
    build(seed) {
      const agg = worley(seed + 81, 40, 1.0);
      const fine = worley(seed + 82, 90, 1.0);
      const binder = fbm(seed + 83, 4, 4, 0.6);
      const cracks = worley(seed + 84, 5, 0.9);
      const wobble = fbm(seed + 85, 6, 2, 0.5);
      const oil = fbm01(seed + 86, 3, 3, 0.6);
      const cA = new Cell(), cB = new Cell(), cC = new Cell();
      return {
        sample(u, v, out) {
          agg(u, v, cA);
          fine(u, v, cB);
          const a = smoothstep(0.30, 0.08, cA.f1) * (0.4 + cA.rand(10) * 0.6);
          const f = smoothstep(0.28, 0.08, cB.f1) * 0.45;

          const wu = u + wobble(u * 2, v * 2) * 0.04;
          const wv = v + wobble(u * 2 + 5.3, v * 2 + 1.1) * 0.04;
          cracks(wu, wv, cC);
          const crack = smoothstep(0.045, 0.006, cC.f2 - cC.f1)
            * smoothstep(0.42, 0.66, oil(u * 2, v * 2));

          out[0] = binder(u, v) * 0.22 + a * 0.30 + f * 0.14 - crack * 0.9;
          out[1] = a; out[2] = crack; out[3] = oil(u, v);
        },
        shade(u, v, c, m, out) {
          const a = m[0], crack = m[1], oily = m[2];
          const t = 0.85 + c.h * 0.30;
          let r = C_ASPHALT[0] * t, g = C_ASPHALT[1] * t, b = C_ASPHALT[2] * t;
          // Traffic polishes the binder off the aggregate crowns.
          const polish = smoothstep(0.25, 0.85, c.edge) * a;
          r = mix(r, C_ASPHALT_AGG[0], polish * 0.85);
          g = mix(g, C_ASPHALT_AGG[1], polish * 0.85);
          b = mix(b, C_ASPHALT_AGG[2], polish * 0.85);
          const stain = smoothstep(0.62, 0.9, oily) * (0.4 + c.cavity * 0.6);
          r *= 1 - stain * 0.30; g *= 1 - stain * 0.32; b *= 1 - stain * 0.30;
          r = mix(r, 0.020, crack * 0.9); g = mix(g, 0.019, crack * 0.9); b = mix(b, 0.019, crack * 0.9);
          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(0.90 - polish * 0.30 - stain * 0.14 + crack * 0.05, 0.28, 1.0);
          out[4] = 0;
          out[5] = 1 - crack * 0.25;
        },
      };
    },
  },

  /* ================================================== asphalt, painted line */
  asphalt_line: {
    label: 'Asphalt with painted line',
    description: 'Road surface carrying a worn thermoplastic stripe — paint survives in the hollows and is scrubbed off the aggregate crowns.',
    tags: ['ground', 'road', 'decal'],
    minSize: 512, relief: 0.016, masks: 4,
    aoStrength: 1.0, curvGain: 1.0,
    detail: 'grain', detailScale: 8, detailStrength: 0.55,
    macro: 0.30, triplanar: false, worldScale: 3.0,
    build(seed, opts = {}) {
      const base = RECIPES.asphalt.build(seed);
      const halfWidth = opts.lineWidth ?? 0.06;   // fraction of the tile
      const centre = opts.lineCentre ?? 0.5;
      const ragged = fbm(seed + 91, 12, 3, 0.55);
      const flake = fbm01(seed + 92, 26, 2, 0.6);
      return {
        sample(u, v, out) {
          base.sample(u, v, out);
          // The stripe edge is chipped, not straight: perturb it with a field
          // stretched along the stripe direction.
          const edge = halfWidth + ragged(u * 6, v) * 0.012;
          out[4] = 1 - smoothstep(edge - 0.006, edge, Math.abs(v - centre));
          // Paint adds ~1.5 mm of build; over a 3 m tile that is 0.0005 —
          // small, but it is what makes the stripe catch a grazing light.
          out[0] += out[4] * 0.10;
        },
        shade(u, v, c, m, out) {
          base.shade(u, v, c, m, out);
          const stripe = m[3];
          if (stripe <= 0.001) return;
          // Wear is curvature-driven: the stripe survives between the stones.
          const scrub = clamp01(smoothstep(0.20, 0.90, c.edge) * 1.2 + smoothstep(0.72, 0.98, flake(u, v)) * 0.9);
          const paint = stripe * (1 - scrub * 0.85);
          const pt = 0.80 + c.h * 0.30;
          out[0] = mix(out[0], C_ROADPAINT[0] * pt, paint);
          out[1] = mix(out[1], C_ROADPAINT[1] * pt, paint);
          out[2] = mix(out[2], C_ROADPAINT[2] * pt, paint);
          out[3] = clamp(mix(out[3], 0.62, paint), 0.28, 1.0);
        },
      };
    },
  },

  /* ================================================================== wood */
  wood: {
    label: 'Wood planking',
    description: 'Sawn softwood boards: growth rings raised by weathering, knots, split ends and grey UV-bleached crowns.',
    tags: ['prop', 'architecture', 'floor'],
    minSize: 512, relief: 0.020, masks: 4,
    aoStrength: 1.0, curvGain: 1.0,
    detail: 'grain', detailScale: 6, detailStrength: 0.5,
    macro: 0.35, triplanar: false, worldScale: 2.2,
    build(seed) {
      const PLANKS = 6;
      const grainW = fbm(seed + 101, 6, 4, 0.55);
      const ringN = fbm(seed + 102, 3, 3, 0.5);
      const fibre = fbm(seed + 103, 90, 2, 0.5);
      const knots = worley(seed + 104, 5, 0.9, 2.6);
      const wearN = fbm01(seed + 105, 4, 3, 0.6);
      const cA = new Cell();
      return {
        sample(u, v, out) {
          const row = Math.floor(v * PLANKS);
          const ly = v * PLANKS - row;
          const gap = 1 - smoothstep(0.004, 0.020, Math.min(ly, 1 - ly));
          const rnd = hash2f(0, ((row % PLANKS) + PLANKS) % PLANKS, seed + 106);

          // Growth rings: distance from the board's pith line, warped by the
          // long-grain field. Rings run *along* the plank, hence the stretch.
          const pith = (rnd - 0.5) * 0.9;
          const d = (ly - 0.5 - pith) * 2.2 + grainW(u * 2, v) * 0.42;
          const ring = tri(Math.abs(d) * 11 + ringN(u * 2, v) * 1.3);
          // Weathering erodes the soft earlywood and leaves the rings proud.
          const relief = Math.pow(ring, 1.6);

          knots(u, v, cA);
          const knotR = cA.f1 / (0.16 + cA.rand(11) * 0.10);
          const knot = clamp01(1 - knotR) * (cA.rand(12) > 0.70 ? 1 : 0);

          out[0] = relief * 0.30 + fibre(u * 3, v) * 0.07 - gap * 1.1
            + (rnd - 0.5) * 0.08 + knot * 0.14;
          out[1] = relief; out[2] = knot; out[3] = rnd; out[4] = gap;
        },
        shade(u, v, c, m, out) {
          const ring = m[0], knot = m[1], rnd = m[2], gap = m[3];
          const t = 0.72 + rnd * 0.45;
          let r = mix(C_WOOD[0], C_WOOD_DARK[0], ring * 0.65) * t;
          let g = mix(C_WOOD[1], C_WOOD_DARK[1], ring * 0.65) * t;
          let b = mix(C_WOOD[2], C_WOOD_DARK[2], ring * 0.65) * t;
          // Knots are resin-dense: much darker and glossier than the field.
          r = mix(r, C_WOOD_DARK[0] * 0.55, knot);
          g = mix(g, C_WOOD_DARK[1] * 0.55, knot);
          b = mix(b, C_WOOD_DARK[2] * 0.55, knot);
          // UV bleaches the exposed crowns to silver-grey; sheltered fibre
          // keeps its colour, which is why the effect tracks curvature.
          const bleach = clamp01(c.edge * 0.75 + wearN(u, v) * 0.35);
          const grey = 0.115;
          r = mix(r, grey * 1.02, bleach * 0.55);
          g = mix(g, grey, bleach * 0.55);
          b = mix(b, grey * 0.95, bleach * 0.55);
          const shade = c.cavity * 0.6 + gap;
          r *= 1 - shade * 0.55; g *= 1 - shade * 0.56; b *= 1 - shade * 0.56;
          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(0.78 + ring * 0.10 + bleach * 0.10 - knot * 0.30, 0.30, 1.0);
          out[4] = 0;
          out[5] = 1 - gap * 0.4;
        },
      };
    },
  },

  /* ============================================================== sandbags */
  sandbag: {
    label: 'Sandbag stack',
    description: 'Filled hessian bags in a staggered course: slumped lobes, stitched seams, coarse weave and settled dust.',
    tags: ['prop', 'cover'],
    minSize: 512, relief: 0.090, masks: 3,
    aoStrength: 1.35, curvGain: 0.8,
    detail: 'weave', detailScale: 10, detailStrength: 0.75,
    macro: 0.35, triplanar: false, worldScale: 1.2,
    build(seed) {
      const COLS = 2, ROWS = 4;
      const L = { lx: 0, ly: 0, col: 0, row: 0, id: 0 };
      const slump = fbm(seed + 111, 5, 3, 0.55);
      const weave = fbm(seed + 112, 46, 2, 0.5);
      return {
        sample(u, v, out) {
          lattice(u, v, COLS, ROWS, 0.5, seed + 114, L);
          const rnd = hash2f(L.col, L.row, seed + 115);
          // Superellipse body: |x|^n + |y|^n, n≈3.2, gives the flat-topped
          // pillow shape a filled bag actually takes.
          const sx = (L.lx - 0.5) * 2.0;
          const sy = (L.ly - 0.5) * 2.06;
          const e = Math.pow(Math.abs(sx), 3.2) + Math.pow(Math.abs(sy), 3.0);
          const body = clamp01(1 - e);
          const dome = Math.pow(body, 0.42) * (0.86 + rnd * 0.28);

          // The seam runs across the short axis, pinched at the tie-off end.
          const seam = smoothstep(0.055, 0.008, Math.abs(sy)) * body;
          const stitch = seam * (0.5 + 0.5 * Math.cos(L.lx * 26 * Math.PI * 2));

          const cloth = weave(u * 2, v * 2) * 0.05 + slump(u, v) * 0.10;
          out[0] = dome - seam * 0.16 + stitch * 0.05 + cloth * body;
          out[1] = body; out[2] = rnd; out[3] = seam;
        },
        shade(u, v, c, m, out) {
          const body = m[0], rnd = m[1], seam = m[2];
          const t = 0.74 + rnd * 0.40 + c.h * 0.20;
          let r = C_BURLAP[0] * t, g = C_BURLAP[1] * t, b = C_BURLAP[2] * t;
          // Dust settles on the upward faces; the gaps between bags stay dark.
          const dust = clamp01(c.edge * 0.6 + 0.15);
          r = mix(r, C_SAND[0], dust * 0.30);
          g = mix(g, C_SAND[1], dust * 0.30);
          b = mix(b, C_SAND[2], dust * 0.28);
          const deep = (1 - body) + c.cavity * 0.8;
          r *= 1 - clamp01(deep) * 0.55; g *= 1 - clamp01(deep) * 0.57; b *= 1 - clamp01(deep) * 0.58;
          r = mix(r, r * 0.82, seam); g = mix(g, g * 0.82, seam); b = mix(b, b * 0.82, seam);
          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(0.94 - dust * 0.05, 0.6, 1.0);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },

  /* =========================================================== ceramic tile */
  tile: {
    label: 'Ceramic tile',
    description: 'Glazed field tile on a grout bed: cupped faces, crazed glaze, chipped arrises and grime in the joints.',
    tags: ['architecture', 'floor', 'wall'],
    minSize: 512, relief: 0.014, masks: 4,
    aoStrength: 1.2, curvGain: 1.1,
    detail: 'grain', detailScale: 4, detailStrength: 0.25,
    macro: 0.25, triplanar: false, worldScale: 1.6,
    build(seed) {
      const COLS = 5, ROWS = 5;
      const L = { lx: 0, ly: 0, col: 0, row: 0, id: 0 };
      const craze = worley(seed + 121, 34, 0.85);
      const grout = fbm(seed + 122, 40, 2, 0.5);
      const chipN = worley(seed + 123, 22, 1.0);
      const cA = new Cell(), cB = new Cell();
      return {
        sample(u, v, out) {
          lattice(u, v, COLS, ROWS, 0, seed + 125, L);
          const jx = Math.min(L.lx, 1 - L.lx);
          const jy = Math.min(L.ly, 1 - L.ly);
          const face = Math.min(smoothstep(0.020, 0.045, jx), smoothstep(0.020, 0.045, jy));
          const rnd = hash2f(L.col, L.row, seed + 126);
          // Fired tiles cup slightly — the centre sits proud of the arrises.
          const cup = 1 - (Math.pow(Math.abs(L.lx * 2 - 1), 2.4) + Math.pow(Math.abs(L.ly * 2 - 1), 2.4)) * 0.5;

          craze(u, v, cA);
          const crazing = smoothstep(0.030, 0.004, cA.f2 - cA.f1) * face;

          chipN(u, v, cB);
          const chip = smoothstep(0.16, 0.03, cB.f1) * (cB.rand(13) > 0.90 ? 1 : 0) * (1 - face);

          out[0] = face * (0.70 + cup * 0.10 + (rnd - 0.5) * 0.05)
            - crazing * 0.10 - chip * 0.5 + grout(u, v) * 0.05 * (1 - face);
          out[1] = face; out[2] = rnd; out[3] = crazing; out[4] = chip;
        },
        shade(u, v, c, m, out) {
          const face = m[0], rnd = m[1], crazing = m[2], chip = m[3];
          const t = 0.90 + rnd * 0.16;
          let r = C_TILE[0] * t, g = C_TILE[1] * t, b = C_TILE[2] * t;
          // biscuit shows through where the glaze has chipped off
          r = mix(r, 0.30, chip); g = mix(g, 0.27, chip); b = mix(b, 0.24, chip);
          r = mix(r, C_GROUT[0], 1 - face); g = mix(g, C_GROUT[1], 1 - face); b = mix(b, C_GROUT[2], 1 - face);
          const grime = c.cavity * (1 - face * 0.5);
          r *= 1 - grime * 0.45; g *= 1 - grime * 0.47; b *= 1 - grime * 0.46;
          r = mix(r, r * 0.9, crazing); g = mix(g, g * 0.9, crazing); b = mix(b, b * 0.9, crazing);
          out[0] = r; out[1] = g; out[2] = b;
          // Glaze is near-specular, grout is not. Crazing and chips break the
          // glaze locally, so roughness follows exactly the same masks.
          out[3] = clamp(mix(0.93, 0.10 + rnd * 0.05, face) + crazing * 0.25 + chip * 0.55 + grime * 0.10, 0.06, 1.0);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },

  /* ================================================================= glass */
  glass: {
    label: 'Dirty glass',
    description: 'Float glass with roller wave, wiper smears, edge dust and fine scratching.',
    tags: ['prop', 'transparent'],
    minSize: 256, relief: 0.0022, masks: 3,
    aoStrength: 0.3, curvGain: 0.9,
    detail: null, detailScale: 4, detailStrength: 0.2,
    macro: 0.20, triplanar: false, worldScale: 1.5,
    klass: 'physical',
    props: {
      transparent: true, opacity: 0.30, side: 2 /* THREE.DoubleSide */,
      roughness: 1.0, metalness: 0.0, ior: 1.52,
      envMapIntensity: 2.0, depthWrite: false,
    },
    build(seed) {
      const wave = fbm(seed + 131, 2, 3, 0.5);
      const smear = warped(fbm01(seed + 132, 4, 3, 0.6), seed + 133, 0.10, 3, 2);
      const scratch = worley(seed + 134, 24, 1.0, 6.0);
      const dustF = fbm01(seed + 135, 8, 3, 0.6);
      const cA = new Cell();
      return {
        sample(u, v, out) {
          scratch(u, v, cA);
          const sc = smoothstep(0.020, 0.002, cA.f2 - cA.f1) * (cA.rand(14) > 0.55 ? 1 : 0);
          // Float glass has a gentle roller wave; everything else is contamination.
          const sm = smear(u, v);
          out[0] = wave(u, v) * 0.6 - sc * 0.25 + sm * 0.08;
          out[1] = clamp01(sm * 1.3 - 0.25);
          out[2] = sc;
          out[3] = dustF(u, v);
        },
        shade(u, v, c, m, out) {
          const grease = m[0], sc = m[1], dust = m[2];
          const film = clamp01(grease * 0.8 + smoothstep(0.62, 0.95, dust) * 0.5 + c.cavity * 0.3);
          // Clean glass contributes almost no diffuse — the visible albedo is
          // the dirt film sitting on it.
          const base = 0.030;
          let r = base + film * 0.13, g = base + film * 0.128, b = base + film * 0.12;
          r = mix(r, r + 0.10, sc); g = mix(g, g + 0.10, sc); b = mix(b, b + 0.11, sc);
          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(0.045 + film * 0.42 + sc * 0.30, 0.02, 0.85);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },

  /* ================================================================ rubber */
  rubber: {
    label: 'Rubber',
    description: 'Moulded EPDM: fine pebble grain from the tool, scuffed high points, dust in the pores.',
    tags: ['prop', 'weapon'],
    minSize: 256, relief: 0.006, masks: 2,
    aoStrength: 0.9, curvGain: 1.0,
    detail: 'pit', detailScale: 8, detailStrength: 0.6,
    macro: 0.20, triplanar: false, worldScale: 0.5,
    build(seed) {
      const peb = worley(seed + 141, 44, 1.0);
      const micro = fbm(seed + 142, 70, 2, 0.5);
      const scuffF = fbm01(seed + 143, 6, 3, 0.6);
      const cA = new Cell();
      return {
        sample(u, v, out) {
          peb(u, v, cA);
          const pebble = Math.pow(clamp01(1 - cA.f1 / 0.34), 0.6);
          out[0] = pebble * 0.5 + micro(u, v) * 0.14;
          out[1] = pebble; out[2] = scuffF(u, v);
        },
        shade(u, v, c, m, out) {
          const pebble = m[0], scuffN = m[1];
          const t = 0.86 + c.h * 0.22;
          let r = C_RUBBER[0] * t, g = C_RUBBER[1] * t, b = C_RUBBER[2] * t;
          // Scuffing only happens where something can touch: convex crowns.
          const scuff = clamp01(smoothstep(0.30, 0.9, c.edge) * (0.4 + scuffN * 0.9));
          r = mix(r, r * 1.7 + 0.012, scuff);
          g = mix(g, g * 1.7 + 0.012, scuff);
          b = mix(b, b * 1.7 + 0.013, scuff);
          r *= 1 - c.cavity * 0.25; g *= 1 - c.cavity * 0.26; b *= 1 - c.cavity * 0.26;
          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(0.82 - pebble * 0.10 + scuff * 0.14, 0.4, 1.0);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },

  /* ================================================================ canvas */
  canvas: {
    label: 'Canvas webbing',
    description: 'Plain-weave cotton duck: individual warp and weft threads, frayed fibre, salt and dust worked into the crowns.',
    tags: ['prop', 'character', 'fabric'],
    minSize: 256, relief: 0.010, masks: 2,
    aoStrength: 1.1, curvGain: 1.0,
    detail: 'weave', detailScale: 6, detailStrength: 0.7,
    macro: 0.30, triplanar: false, worldScale: 0.6,
    build(seed) {
      const TH = 24;                            // threads per tile per axis
      const fuzz = fbm(seed + 151, 80, 2, 0.5);
      const slub = fbm(seed + 152, 10, 3, 0.55);
      const wearN = fbm01(seed + 153, 5, 3, 0.6);
      return {
        sample(u, v, out) {
          const iu = Math.floor(u * TH), iv = Math.floor(v * TH);
          const fu = u * TH - iu, fv = v * TH - iv;
          // Plain weave: on each cell one thread crosses over the other.
          const over = ((iu + iv) & 1) === 0;
          // A thread's cross-section is a flattened cylinder.
          const warpH = Math.pow(Math.max(0, Math.sin(fu * Math.PI)), 0.7);
          const weftH = Math.pow(Math.max(0, Math.sin(fv * Math.PI)), 0.7);
          const h = over ? warpH * 0.85 + weftH * 0.25 : weftH * 0.85 + warpH * 0.25;
          const thickness = 0.9 + hash2f(over ? iu : iv, over ? 0 : 1, seed + 154) * 0.25;
          out[0] = h * thickness * 0.5 + slub(u, v) * 0.10 + fuzz(u, v) * 0.05;
          out[1] = h; out[2] = wearN(u, v);
        },
        shade(u, v, c, m, out) {
          const thread = m[0], wearN = m[1];
          const t = 0.78 + c.h * 0.40;
          let r = C_CANVAS[0] * t, g = C_CANVAS[1] * t, b = C_CANVAS[2] * t;
          // Fabric abrades on the thread crowns and only there.
          const abraded = clamp01(smoothstep(0.35, 0.95, c.edge) * (0.3 + wearN * 1.0));
          r = mix(r, r * 1.45 + 0.02, abraded * 0.8);
          g = mix(g, g * 1.42 + 0.02, abraded * 0.8);
          b = mix(b, b * 1.40 + 0.02, abraded * 0.8);
          const soil = c.cavity * 0.8;
          r = mix(r, C_DIRT[0], soil * 0.45); g = mix(g, C_DIRT[1], soil * 0.46); b = mix(b, C_DIRT[2], soil * 0.46);
          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(0.92 - abraded * 0.10 + thread * 0.04, 0.55, 1.0);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },

  /* ============================================================== gun metal */
  gunmetal: {
    label: 'Gun metal',
    description: 'Phosphated steel receiver: bead-blast micro-texture, machining witness marks, holster wear polishing the arrises back to bright steel.',
    tags: ['weapon', 'prop'],
    minSize: 512, relief: 0.0035, masks: 2,
    aoStrength: 0.8, curvGain: 1.4,
    detail: 'brushed', detailScale: 4, detailStrength: 0.35,
    macro: 0.16, triplanar: false, worldScale: 0.35,
    build(seed) {
      const bead = fbm(seed + 161, 90, 2, 0.5);
      const cast = fbm(seed + 162, 7, 3, 0.5);
      const dings = worley(seed + 163, 14, 1.0);
      const wearN = fbm01(seed + 164, 6, 3, 0.6);
      const cA = new Cell();
      return {
        sample(u, v, out) {
          // Witness marks from the cutter: a fine periodic ripple in one axis
          // only, which is what makes machined steel read as machined.
          const mach = Math.cos(v * 96 * Math.PI * 2 + cast(u * 2, v) * 3.0) * 0.5 + 0.5;
          dings(u, v, cA);
          const ding = smoothstep(0.10, 0.02, cA.f1) * (cA.rand(15) > 0.88 ? 1 : 0);
          out[0] = bead(u, v) * 0.30 + mach * 0.10 + cast(u, v) * 0.16 - ding * 0.7;
          out[1] = wearN(u, v); out[2] = ding;
        },
        shade(u, v, c, m, out) {
          const wearN = m[0], ding = m[1];
          // Holster and hand wear polishes the phosphate off high curvature.
          const worn = clamp01(smoothstep(0.30, 0.90, c.edge) * (0.35 + wearN * 1.1));
          const bright = smoothstep(0.30, 0.70, worn);
          const t = 0.88 + c.h * 0.22;
          let r = mix(C_STEEL_DARK[0] * t, C_STEEL[0], bright);
          let g = mix(C_STEEL_DARK[1] * t, C_STEEL[1], bright);
          let b = mix(C_STEEL_DARK[2] * t, C_STEEL[2], bright);
          // A fresh ding cuts through to bright metal too.
          r = mix(r, C_STEEL[0] * 1.02, ding * 0.7);
          g = mix(g, C_STEEL[1] * 1.02, ding * 0.7);
          b = mix(b, C_STEEL[2] * 1.02, ding * 0.7);
          // Carbon fouling in the recesses; keeps it from reading as clean CAD.
          const foul = c.cavity * 0.7;
          r *= 1 - foul * 0.30; g *= 1 - foul * 0.31; b *= 1 - foul * 0.31;
          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(mix(0.46, 0.13, bright) + foul * 0.12 + ding * 0.10, 0.08, 1.0);
          out[4] = 1;                            // steel is a conductor, all of it
          out[5] = 1;
        },
      };
    },
  },

  /* =============================================================== polymer */
  polymer: {
    label: 'Textured polymer',
    description: 'Glass-filled nylon furniture: moulded stipple, parting line, and gloss where hands have burnished it.',
    tags: ['weapon', 'prop'],
    minSize: 256, relief: 0.005, masks: 2,
    aoStrength: 0.9, curvGain: 1.2,
    detail: 'pit', detailScale: 7, detailStrength: 0.5,
    macro: 0.15, triplanar: false, worldScale: 0.35,
    build(seed) {
      const stip = worley(seed + 171, 40, 1.0);
      const flow = fbm(seed + 172, 6, 3, 0.5);
      const micro = fbm(seed + 173, 100, 2, 0.5);
      const cA = new Cell();
      return {
        sample(u, v, out) {
          stip(u, v, cA);
          // Moulded stipple: truncated pyramids, flat-topped, hard-edged.
          const p = clamp01(1 - cA.f1 / 0.30);
          const pyr = Math.min(1, p * 1.6);
          const fl = flow(u, v);
          out[0] = pyr * 0.45 + fl * 0.10 + micro(u, v) * 0.05;
          out[1] = pyr; out[2] = fl * 0.5 + 0.5;
        },
        shade(u, v, c, m, out) {
          const pyr = m[0], flowN = m[1];
          const t = 0.90 + flowN * 0.18;
          let r = C_POLYMER[0] * t, g = C_POLYMER[1] * t, b = C_POLYMER[2] * t;
          const burnish = clamp01(smoothstep(0.35, 0.95, c.edge) * 0.9);
          r = mix(r, r * 1.35, burnish); g = mix(g, g * 1.35, burnish); b = mix(b, b * 1.36, burnish);
          r *= 1 - c.cavity * 0.20; g *= 1 - c.cavity * 0.21; b *= 1 - c.cavity * 0.21;
          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(0.62 - burnish * 0.30 - pyr * 0.05 + c.cavity * 0.08, 0.18, 1.0);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },
};

/* --------------------------------------------------------------- aliases */

/** Names other modules may reasonably reach for, mapped onto a real recipe. */
export const ALIASES = {
  steel: 'metal',
  painted_metal: 'metal',
  crate: 'metal',
  stone: 'gravel',
  ground: 'sand',
  wall: 'concrete',
  road: 'asphalt',
  fabric: 'canvas',
  weapon: 'gunmetal',
  grip: 'polymer',
};

export function resolveRecipe(name) {
  const id = ALIASES[name] || name;
  return RECIPES[id] ? { id, recipe: RECIPES[id] } : { id: 'concrete', recipe: RECIPES.concrete };
}
