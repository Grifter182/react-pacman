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
 *   build(seed, opts)      opts = { worldScale, size, ...recipe params }
 *   sample(u, v, out)      out[0] = height (arbitrary units, normalised later)
 *                          out[1..masks] = recipe-private masks
 *   shade(u, v, c, m, out) c = { h, curv, edge, cavity, ao } derived from the
 *                          height field; m = this texel's masks;
 *                          out = [ r, g, b, roughness, metalness, aoScale ]
 *
 * EVERYTHING IS AUTHORED IN METRES.
 * ---------------------------------
 * `opts.worldScale` is how many metres one tile of this bake covers. Every
 * feature frequency below is derived from it through the `metrics` helper, so
 * a brick course is 75 mm and an asphalt chipping is 11 mm *whatever* tile size
 * the caller asks for. Recipes used to hard-code lattice counts tuned for one
 * assumed tile size; that is precisely how a wall ends up wearing the same
 * abstract blob field as the ground. A material is recognisable because its
 * features are the size a human expects, not because the noise is pretty.
 *
 * `reliefM` is likewise the peak-to-peak height range of the field **in
 * metres**. The baker divides by worldScale to get the fraction-of-tile the
 * normal encoder wants. Authoring relief as a fraction (the old contract) meant
 * a 2.4 m concrete tile carried 53 mm of relief and read as rubble.
 *
 * Two further rules run through every recipe here:
 *
 *  - **Albedo is authored in linear reflectance.** The baker applies the sRGB
 *    OETF on the way into the texture. Values stay inside real-world bounds:
 *    nothing darker than fresh asphalt (~0.02) and nothing brighter than fresh
 *    plaster (~0.65). No pure black, no pure white.
 *  - **Metalness is a phase, not a slider.** A texel is either conductor or
 *    dielectric; the only intermediate values are the few texels where a wear
 *    mask crosses over. Paint, phosphate and oxide coatings are all
 *    DIELECTRICS — a painted or parkerised part is metalness 0 until the
 *    coating is worn through.
 *
 * Wear itself comes from curvature (`c.edge`, `c.cavity`), never from a stray
 * noise field: coatings leave convex edges first, grime collects in concave
 * cavities.
 *
 * Distinctness
 * ------------
 * Each recipe deliberately occupies a different corner of three axes, because
 * ten materials sharing one statistical signature is one material in ten hats:
 *
 *   recipe    albedo (linear)        dominant spatial band     wear signature
 *   plaster   0.45-0.60, low var     0.6 m patches + 0.1 m     sheet loss, wash
 *   concrete  0.16-0.26, v.low var   0.20 m boards + 12 mm     spall, tie rust
 *   brick     0.05-0.14, HIGH var    0.225/0.075 m courses     arris chip, soot
 *   metal     0.03-0.10, trimodal    0.6 m panels + 80 mm      chip -> rust run
 *   sand      0.28-0.42, low var     90 mm anisotropic train   damp vs dry only
 *   polymer   0.03-0.05, v.low var   1.2 mm stipple, flat      edge burnish only
 *   gunmetal  0.04-0.06 + conductor  0.5 mm blast, flat        polish-through
 */

/* --------------------------------------------------------- colour helpers */

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
/** Author colours the way they are measured (sRGB), store them linear. */
const srgb = (r, g, b) => [toLinear(r), toLinear(g), toLinear(b)];

/* --------------------------------------------------------------- metrics */

/**
 * Per-build unit conversion. Recipes ask for metres; this turns them into the
 * lattice counts and noise periods the tileable primitives need, clamped so a
 * feature never lands below a few texels (which is aliasing, not detail).
 */
function metrics(opts, fallbackScale) {
  const ws = Math.max(0.05, opts.worldScale ?? fallbackScale ?? 1);
  const N = Math.max(64, opts.size ?? 512);
  return {
    ws,
    N,
    /** Noise period giving one feature every `m` metres, capped by resolution. */
    per(m, minTexels = 5) {
      const p = Math.round(ws / Math.max(1e-4, m));
      return Math.max(1, Math.min(p, Math.floor(N / minTexels)));
    },
    /** Integer feature count across the tile (lattices — never resolution-capped). */
    count(m, min = 1) { return Math.max(min, Math.round(ws / Math.max(1e-4, m))); },
    /** `m` metres as a fraction of the tile. */
    f(m) { return m / ws; },
  };
}

/* ------------------------------------------------------------- palette */

/*
 * Reflectance sanity, all linear:
 *   fresh asphalt 0.04 | weathered concrete 0.20-0.28 | red brick 0.08-0.14
 *   dry sand 0.30-0.40 | lime plaster 0.50-0.62 | olive drab paint 0.05
 *   black polymer 0.03-0.05 | steel F0 (conductor) 0.53-0.58
 */
const C_CONCRETE = srgb(0.52, 0.515, 0.505);     // 0.226 linear, near-neutral
const C_CONCRETE_W = srgb(0.60, 0.59, 0.575);    // wash-out / laitance
const C_AGGREGATE = srgb(0.60, 0.575, 0.535);
const C_PLASTER = srgb(0.79, 0.77, 0.71);        // 0.588 linear
const C_PLASTER_2 = srgb(0.71, 0.685, 0.62);     // older coat under the top skim
const C_BRICK = srgb(0.54, 0.29, 0.22);
const C_BRICK_ALT = srgb(0.40, 0.21, 0.17);
const C_BRICK_PALE = srgb(0.61, 0.42, 0.33);     // underfired / sand-struck
const C_BRICK_BLUE = srgb(0.33, 0.24, 0.24);     // overfired header
const C_MORTAR = srgb(0.57, 0.56, 0.52);
const C_STEEL = srgb(0.75, 0.755, 0.76);         // bare mild steel, conductor F0
const C_PARKER = srgb(0.255, 0.253, 0.26);       // manganese phosphate: DIELECTRIC
const C_RUST = srgb(0.46, 0.22, 0.10);
const C_RUST_DARK = srgb(0.27, 0.13, 0.07);
const C_PAINT = srgb(0.34, 0.35, 0.28);          // olive drab
const C_ZINC = srgb(0.66, 0.67, 0.68);
const C_SAND = srgb(0.685, 0.60, 0.435);
const C_SAND_DARK = srgb(0.50, 0.425, 0.30);
const C_STONE = srgb(0.44, 0.42, 0.39);
const C_ASPHALT = srgb(0.235, 0.233, 0.243);
const C_ASPHALT_AGG = srgb(0.395, 0.385, 0.370);
const C_ROADPAINT = srgb(0.84, 0.82, 0.74);
const C_WOOD = srgb(0.46, 0.32, 0.19);
const C_WOOD_DARK = srgb(0.28, 0.18, 0.10);
const C_BURLAP = srgb(0.55, 0.47, 0.33);
const C_TILE = srgb(0.83, 0.81, 0.77);
const C_GROUT = srgb(0.52, 0.50, 0.47);
const C_RUBBER = srgb(0.175, 0.175, 0.185);
const C_CANVAS = srgb(0.39, 0.38, 0.29);
const C_POLYMER = srgb(0.205, 0.203, 0.205);     // 0.034 linear — glass-filled nylon
const C_DIRT = srgb(0.24, 0.20, 0.15);

/* ---------------------------------------------------------------- recipes */

export const RECIPES = {

  /* ================================================== board-formed concrete */
  concrete: {
    label: 'Board-formed concrete',
    description: '200 mm shutter boards with sawn grain and joint lines, snap-tie holes streaking rust, shrinkage cracks, spalled arrises and exposed aggregate.',
    tags: ['architecture', 'wall', 'ground'],
    minSize: 512, reliefM: 0.020, masks: 6,
    aoStrength: 0.95, curvGain: 1.0,
    detail: 'grain', detailMetres: 0.13, detailStrength: 0.42,
    macro: 0.14, triplanar: true, worldScale: 1.2,
    build(seed, opts = {}) {
      const M = metrics(opts, 1.2);
      const BOARDS = M.count(0.20, 2);            // 200 mm shutter boards
      const TIES = M.count(0.60, 1);              // snap ties on a 600 mm grid
      const cellM = M.ws / BOARDS;

      const grainF = fbm(seed + 11, M.per(0.30, 6), 3, 0.5);
      const floatF = fbm(seed + 12, M.per(0.60, 8), 3, 0.55);
      const fineF = fbm(seed + 13, M.per(0.020, 8), 2, 0.5);
      const ageF = fbm01(seed + 14, M.per(0.90, 8), 3, 0.6);
      const wobble = fbm(seed + 15, M.per(0.50, 8), 2, 0.5);
      const crackC = worley(seed + 16, M.per(0.40, 8), 0.85);
      const spallC = worley(seed + 17, M.per(0.055, 6), 1.0);
      const aggrC = worley(seed + 18, M.per(0.013, 5), 1.0);
      const cA = new Cell(), cB = new Cell(), cC = new Cell();

      // 8 mm grout line where the form boards met. Authoring the true 2-3 mm
      // gap is honest and invisible — at 512px over 2.4 m a texel is 4.7 mm, so
      // a sub-texel feature just vanishes. The squeeze-out fin is genuinely
      // this wide anyway.
      const jIn = 0.004 / cellM, jOut = 0.015 / cellM;
      const tieR = 0.014 / M.ws;                  // 28 mm tie cone
      const runL = 0.30 / M.ws;                   // rust run below it

      return {
        sample(u, v, out) {
          /* --- shutter boards: the human-scale band. 200 mm horizontal courses,
             each one a couple of millimetres out of plane, separated by the
             grout line that squeezed through the form joint. This is what makes
             a concrete wall read as *cast* rather than as noise. */
          const by = v * BOARDS;
          const bi = Math.floor(by);
          const bf = by - bi;
          const joint = 1 - smoothstep(jIn, jOut, Math.min(bf, 1 - bf));
          const step = (hash2f(0, bi, seed + 19) - 0.5) * 0.22;
          // Sawn grain runs along the board, so the field is stretched hard in u.
          const grain = grainF(u, v * 2.0) * 0.09 * (1 - joint);

          /* --- snap ties on their grid, each with a downward rust run */
          const tu = u * TIES, tv = v * TIES;
          const ti = Math.floor(tu), tj = Math.floor(tv);
          const present = hash2f(ti, tj, seed + 20) > 0.42 ? 1 : 0;
          const du = (tu - ti - 0.5) / TIES;
          const dv = (tv - tj - 0.5) / TIES;
          const tie = present * smoothstep(tieR, tieR * 0.3, Math.sqrt(du * du + dv * dv));
          const run = present
            * clamp01(1 - Math.abs(du) / (tieR * 2.4))
            * smoothstep(runL, 0.0, Math.max(0, -dv));

          /* --- shrinkage cracking: the F2-F1 border of a warped cellular grid
             is a connected polygonal graph, which is how concrete fractures. */
          // The age field gates all three of the decay terms, so evaluate it
          // first and skip the cellular lookups wherever the wall is young.
          // Cellular evaluation is the single most expensive thing in this
          // recipe and roughly half the tile never needs it.
          const age = ageF(u, v);
          const ageCrack = smoothstep(0.54, 0.74, age);
          const ageSpall = smoothstep(0.38, 0.70, age);

          /* --- shrinkage cracking: the F2-F1 border of a warped cellular grid
             is a connected polygonal graph, which is how concrete fractures.
             Gated so cracking covers a fraction of the wall — letting it run
             everywhere turns concrete into crazy paving, which is its own kind
             of abstract pattern. */
          let crack = 0;
          if (ageCrack > 0.002) {
            const wu = u + wobble(u, v) * M.f(0.05);
            const wv = v + wobble(u + 2.7, v - 1.3) * M.f(0.05);
            crackC(wu, wv, cA);
            crack = smoothstep(0.042, 0.005, cA.f2 - cA.f1) * ageCrack;
          }

          /* --- spalling: 30-60 mm pockets, clustered where the wall is old */
          let spall = 0;
          if (ageSpall > 0.002) {
            spallC(u, v, cB);
            spall = smoothstep(0.34, 0.08, cB.f1) * (cB.rand(1) > 0.70 ? 1 : 0) * ageSpall;
          }

          /* --- aggregate only shows where the skin has actually gone */
          const expose = clamp01(spall * 1.2 + smoothstep(0.60, 0.85, age) * 0.35);
          let agg = 0;
          if (expose > 0.004) {
            aggrC(u, v, cC);
            agg = smoothstep(0.34, 0.12, cC.f1) * expose;
          }

          out[0] = step + grain + floatF(u, v) * 0.05 + fineF(u, v) * 0.018
            - joint * 0.75 - tie * 0.80 - crack * 0.60 - spall * 0.40 + agg * 0.14;
          out[1] = crack; out[2] = agg; out[3] = clamp01(tie + run * 0.55);
          out[4] = expose; out[5] = joint;
          // Each shutter board carried a different amount of release agent and
          // a different pour age, so the wall banks in 200 mm horizontal tonal
          // bands. This is the single most recognisable thing about in-situ
          // concrete and it lives at exactly the scale a human reads.
          out[6] = hash2f(0, bi + 313, seed + 21);
        },
        shade(u, v, c, m, out) {
          const crack = m[0], agg = m[1], tieRun = m[2], expose = m[3], joint = m[4];
          const boardTone = m[5];
          // Concrete's signature is a *narrow* albedo distribution banded by
          // the formwork: the colour barely moves within a board, and steps
          // between boards. All the rest of the read comes from form and
          // occlusion, not from colour noise.
          const tone = (0.84 + c.h * 0.20) * (0.87 + boardTone * 0.30);
          let r = C_CONCRETE[0] * tone, g = C_CONCRETE[1] * tone, b = C_CONCRETE[2] * tone;

          r = mix(r, C_AGGREGATE[0], agg * 0.80);
          g = mix(g, C_AGGREGATE[1], agg * 0.80);
          b = mix(b, C_AGGREGATE[2], agg * 0.80);

          // Laitance / lime wash bleaches the sheltered face pale and chalky.
          const wash = clamp01(0.30 + c.edge * 0.35 - expose * 0.5);
          r = mix(r, C_CONCRETE_W[0], wash * 0.35);
          g = mix(g, C_CONCRETE_W[1], wash * 0.35);
          b = mix(b, C_CONCRETE_W[2], wash * 0.35);

          // Rust bleeding out of the tie holes — the one warm note on the wall.
          r = mix(r, C_RUST[0] * 0.75, tieRun * 0.55);
          g = mix(g, C_RUST[1] * 0.75, tieRun * 0.55);
          b = mix(b, C_RUST[2] * 0.75, tieRun * 0.55);

          const dirt = clamp01(c.cavity * 0.7 + joint * 0.45);
          r = mix(r, C_DIRT[0], dirt * 0.34);
          g = mix(g, C_DIRT[1], dirt * 0.36);
          b = mix(b, C_DIRT[2], dirt * 0.35);

          const ck = crack * 0.85;
          r = mix(r, 0.022, ck); g = mix(g, 0.021, ck); b = mix(b, 0.021, ck);

          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(0.86 + c.cavity * 0.06 - agg * 0.14 - c.edge * 0.08, 0.42, 1.0);
          out[4] = 0;
          out[5] = 1 - crack * 0.30;
        },
      };
    },
  },

  /* ============================================ weathered plaster + brick */
  plaster: {
    label: 'Weathered lime render',
    description: 'Hand-floated lime render over brick: broad trowel sweeps, a hairline map-cracking network, sheets blown off to bare masonry and dirt washing down every break.',
    tags: ['architecture', 'wall'],
    minSize: 512, reliefM: 0.030, masks: 5,
    aoStrength: 1.05, curvGain: 1.0,
    detail: 'stipple', detailMetres: 0.11, detailStrength: 0.34,
    macro: 0.15, triplanar: true, worldScale: 0.9,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.9);
      // Metric brick: 215 x 65 mm unit on a 10 mm joint -> 225 x 75 mm course.
      const COLS = M.count(0.225, 2);
      const ROWS = M.count(0.075, 4);
      const L = { lx: 0, ly: 0, col: 0, row: 0, id: 0 };

      const trowel = fbm(seed + 21, M.per(0.55, 8), 3, 0.55);
      const skim = fbm(seed + 22, M.per(0.16, 6), 3, 0.5);
      const grit = fbm(seed + 23, M.per(0.006, 8), 2, 0.5);
      const blown = warped(fbm01(seed + 24, M.per(0.65, 8), 4, 0.58), seed + 25, M.f(0.09), 3, 2);
      const mapC = worley(seed + 26, M.per(0.11, 6), 0.9);
      const brickN = fbm(seed + 27, M.per(0.05, 6), 2, 0.5);
      const streak = fbm(seed + 28, M.per(0.30, 8), 3, 0.62);
      const cA = new Cell();

      // 10 mm joint on a 225 x 75 mm cell is 4.4% across and 13% down.
      const jxIn = 0.004 / (M.ws / COLS), jxOut = 0.012 / (M.ws / COLS);
      const jyIn = 0.004 / (M.ws / ROWS), jyOut = 0.012 / (M.ws / ROWS);

      return {
        sample(u, v, out) {
          lattice(u, v, COLS, ROWS, 0.5, seed + 29, L);
          const face = Math.min(
            smoothstep(jxIn, jxOut, Math.min(L.lx, 1 - L.lx)),
            smoothstep(jyIn, jyOut, Math.min(L.ly, 1 - L.ly)),
          );
          const mortar = 1 - face;
          const bTone = hash2f(L.col, L.row, seed + 30);
          const brickH = face * (0.26 + (bTone - 0.5) * 0.09) + brickN(u, v) * 0.04;

          // Render survives where the field is high; the boundary is hard —
          // lime render sheets off in flakes, it does not fade out.
          const p = smoothstep(0.455, 0.535, blown(u, v));

          /* Human-scale band 1: trowel sweeps. Broad, shallow, anisotropic
             arcs at half a metre — the mark of a float held at an angle. */
          const sweep = trowel(u, v * 0.55) * 0.16 + skim(u, v) * 0.07;

          /* Human-scale band 2: map cracking. A lime coat over a stiff
             substrate crazes into 80-140 mm islands with hairline gaps. */
          mapC(u, v, cA);
          const craze = smoothstep(0.030, 0.004, cA.f2 - cA.f1) * p;

          const plasterH = p * (0.58 + sweep) + grit(u, v) * 0.035 * p - craze * 0.14;

          out[0] = brickH + plasterH;
          out[1] = p; out[2] = mortar; out[3] = bTone; out[4] = craze;
          out[5] = clamp01(sweep * 2.4 + 0.5);
        },
        shade(u, v, c, m, out) {
          const p = m[0], mortar = m[1], bTone = m[2], craze = m[3], sweep = m[4];

          /* substrate: brick + mortar, only visible in the blown patches */
          let br = mix(C_BRICK[0], C_BRICK_ALT[0], bTone);
          let bg = mix(C_BRICK[1], C_BRICK_ALT[1], bTone);
          let bb = mix(C_BRICK[2], C_BRICK_ALT[2], bTone);
          const bn = 0.84 + c.h * 0.30;
          br *= bn; bg *= bn; bb *= bn;
          let r = mix(br, C_MORTAR[0] * 0.92, mortar);
          let g = mix(bg, C_MORTAR[1] * 0.92, mortar);
          let b = mix(bb, C_MORTAR[2] * 0.92, mortar);
          let rough = mix(0.90, 0.96, mortar);

          /* the coat itself — bright, warm, and very low variance. The only
             colour movement is the float sweep and the older coat showing
             through where the top skim is thin. */
          const pr = mix(C_PLASTER_2[0], C_PLASTER[0], sweep);
          const pg = mix(C_PLASTER_2[1], C_PLASTER[1], sweep);
          const pb = mix(C_PLASTER_2[2], C_PLASTER[2], sweep);
          const pt = 0.90 + c.h * 0.18;
          r = mix(r, pr * pt, p); g = mix(g, pg * pt, p); b = mix(b, pb * pt, p);
          rough = mix(rough, 0.86, p);

          // Crazing catches dirt in the hairlines and only in the hairlines.
          const cz = craze * 0.55;
          r = mix(r, r * 0.72, cz); g = mix(g, g * 0.71, cz); b = mix(b, b * 0.70, cz);

          // Rain streaking: dirt washed out of the break runs down the face
          // below it, so the streak field is stretched hard along v.
          const st = clamp01(streak(u * 6, v * 0.35) * 0.5 + 0.5);
          const wash = smoothstep(0.55, 0.95, st) * (0.35 + c.cavity * 0.5);
          r = mix(r, C_DIRT[0], wash * 0.42);
          g = mix(g, C_DIRT[1], wash * 0.44);
          b = mix(b, C_DIRT[2], wash * 0.44);

          // Salt bloom on the exposed arris of the render sheet.
          const bloom = c.edge * p * 0.30;
          r = mix(r, 0.50, bloom); g = mix(g, 0.49, bloom); b = mix(b, 0.46, bloom);

          const dirt = c.cavity * 0.55;
          r *= 1 - dirt * 0.34; g *= 1 - dirt * 0.36; b *= 1 - dirt * 0.37;

          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(rough + c.cavity * 0.05 - c.edge * 0.10 + craze * 0.04, 0.40, 1.0);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },

  /* ====================================================== brick, unrendered */
  brick: {
    label: 'Brick wall',
    description: 'Running-bond fired clay: heavy unit-to-unit colour scatter, sand-struck faces, 10 mm recessed joints, chipped arrises and soot in the beds.',
    tags: ['architecture', 'wall'],
    minSize: 512, reliefM: 0.020, masks: 5,
    aoStrength: 1.15, curvGain: 1.0,
    detail: 'grain', detailMetres: 0.09, detailStrength: 0.40,
    macro: 0.15, triplanar: true, worldScale: 0.9,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.9);
      const COLS = M.count(0.225, 2);
      const ROWS = M.count(0.075, 4);
      const L = { lx: 0, ly: 0, col: 0, row: 0, id: 0 };

      const clay = fbm(seed + 31, M.per(0.030, 6), 3, 0.55);
      const struck = fbm(seed + 32, M.per(0.008, 7), 2, 0.5);
      const chipC = worley(seed + 33, M.per(0.035, 6), 1.0);
      const bedN = fbm(seed + 34, M.per(0.012, 7), 2, 0.5);
      const cA = new Cell();

      const jxIn = 0.004 / (M.ws / COLS), jxOut = 0.012 / (M.ws / COLS);
      const jyIn = 0.004 / (M.ws / ROWS), jyOut = 0.012 / (M.ws / ROWS);

      return {
        sample(u, v, out) {
          lattice(u, v, COLS, ROWS, 0.5, seed + 35, L);
          const face = Math.min(
            smoothstep(jxIn, jxOut, Math.min(L.lx, 1 - L.lx)),
            smoothstep(jyIn, jyOut, Math.min(L.ly, 1 - L.ly)),
          );
          const bTone = hash2f(L.col, L.row, seed + 36);
          const bHue = hash2f(L.col + 71, L.row + 13, seed + 37);
          // Bricks sit a few millimetres proud or sunk of one another and
          // pillow very slightly across the stretcher face.
          const set = (hash2f(L.col + 5, L.row + 29, seed + 38) - 0.5) * 0.20;
          const pillow = face * (1 - Math.pow(Math.abs(L.lx * 2 - 1), 3) * 0.30);

          chipC(u, v, cA);
          const chipped = smoothstep(0.26, 0.06, cA.f1) * (cA.rand(2) > 0.88 ? 1 : 0) * face;

          out[0] = pillow * (0.55 + set) + clay(u, v) * 0.05 + struck(u, v) * 0.022
            + bedN(u, v) * 0.03 * (1 - face) - chipped * 0.30;
          out[1] = face; out[2] = bTone; out[3] = chipped; out[4] = bHue;
        },
        shade(u, v, c, m, out) {
          const face = m[0], bTone = m[1], chipped = m[2], bHue = m[3];
          // Brick's signature is the *variance*: no two units the same. Two
          // independent hashes, one for value and one for firing colour, give
          // the scattered warm/cool checker a real wall has.
          let hr, hg, hb;
          if (bHue < 0.16) { hr = C_BRICK_BLUE[0]; hg = C_BRICK_BLUE[1]; hb = C_BRICK_BLUE[2]; }
          else if (bHue > 0.80) { hr = C_BRICK_PALE[0]; hg = C_BRICK_PALE[1]; hb = C_BRICK_PALE[2]; }
          else { hr = C_BRICK[0]; hg = C_BRICK[1]; hb = C_BRICK[2]; }
          const t = 0.72 + bTone * 0.52 + c.h * 0.24;
          let r = mix(hr, C_BRICK_ALT[0], bTone * 0.45) * t;
          let g = mix(hg, C_BRICK_ALT[1], bTone * 0.45) * t;
          let b = mix(hb, C_BRICK_ALT[2], bTone * 0.45) * t;

          // A fresh fracture is paler and unweathered.
          r = mix(r, r * 1.50 + 0.02, chipped);
          g = mix(g, g * 1.45 + 0.02, chipped);
          b = mix(b, b * 1.40 + 0.02, chipped);

          const mortar = 1 - face;
          r = mix(r, C_MORTAR[0], mortar); g = mix(g, C_MORTAR[1], mortar); b = mix(b, C_MORTAR[2], mortar);

          const bloom = c.edge * 0.34 * face;
          r = mix(r, 0.44, bloom); g = mix(g, 0.43, bloom); b = mix(b, 0.41, bloom);
          const soot = c.cavity * 0.7;
          r *= 1 - soot * 0.42; g *= 1 - soot * 0.44; b *= 1 - soot * 0.44;

          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(mix(0.86, 0.96, mortar) + chipped * 0.05 - c.edge * 0.08, 0.45, 1.0);
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
    minSize: 512, reliefM: 0.006, masks: 4,
    aoStrength: 0.9, curvGain: 1.15,
    detail: 'brushed', detailMetres: 0.16, detailStrength: 0.34,
    macro: 0.12, triplanar: false, worldScale: 1.4,
    build(seed, opts = {}) {
      const M = metrics(opts, 1.4);
      const PC = M.count(0.60, 1);                 // 600 mm panels
      const PR = M.count(0.70, 1);
      const L = { lx: 0, ly: 0, col: 0, row: 0, id: 0 };
      const oilcan = fbm(seed + 41, M.per(0.35, 8), 3, 0.5);
      const mill = fbm(seed + 42, M.per(0.10, 7), 2, 0.5);
      const rustF = warped(fbm01(seed + 43, M.per(0.45, 8), 4, 0.6), seed + 44, M.f(0.10), 3, 2);
      const runs = fbm01(seed + 45, M.per(0.22, 8), 3, 0.6);
      const chipN = fbm01(seed + 46, M.per(0.10, 7), 3, 0.6);
      const scab = fbm(seed + 47, M.per(0.012, 7), 2, 0.5);

      const RIV = M.count(0.080, 4);               // 80 mm rivet pitch
      const seamW = 0.010 / M.ws;    // 10 mm lapped joint, not a 1-texel canyon
      const rivR = 0.009 / M.ws;                   // 18 mm dome head
      const rivInset = 0.018 / M.ws;

      return {
        sample(u, v, out) {
          lattice(u, v, PC, PR, 0, seed + 48, L);
          const dx = Math.min(L.lx, 1 - L.lx) / PC;   // back into tile units
          const dy = Math.min(L.ly, 1 - L.ly) / PR;
          const j = Math.min(dx, dy);
          const seam = 1 - smoothstep(seamW * 0.5, seamW * 2.2, j);
          // A second, much wider mask covering the whole disturbed zone either
          // side of the joint. The narrow mask alone left the seam *lips* — a
          // couple of texels of extreme curvature — free to chip to bright
          // steel, drawing a white dashed outline around every panel.
          const seamWide = 1 - smoothstep(seamW * 0.5, seamW * 4.0, j);

          // Rivet line set in 14 mm from the horizontal seam.
          const rdu = ((u * RIV) % 1 - 0.5) / RIV;
          const rdv = dy - rivInset;
          const rivet = smoothstep(rivR * 1.05, rivR * 0.35, Math.sqrt(rdu * rdu + rdv * rdv));

          // Rust is a growth process: warped base field so blooms have fingers,
          // with vertical runs bleeding out of them.
          const rust = clamp01(rustF(u, v) * 1.05 + runs(u * 6, v) * 0.30 - 0.18);

          out[0] = oilcan(u, v) * 0.22 + mill(u * 4, v) * 0.04
            - seam * 0.45 + rivet * 0.85 + scab(u, v) * rust * 0.14;
          out[1] = rust; out[2] = chipN(u, v); out[3] = seam; out[4] = seamWide;
        },
        shade(u, v, c, m, out) {
          const rustBase = m[0], chipNoise = m[1], seam = m[2], seamWide = m[3];
          // Water sits in cavities and drains off ridges, so curvature biases
          // the rust field before it is thresholded.
          const rust = clamp01(rustBase + c.cavity * 0.42 - c.edge * 0.14 + seamWide * 0.18);
          // Threshold set high on purpose. A 50/50 split of olive paint and
          // orange oxide at half-metre scale is, literally, a camouflage
          // pattern; rust wants to be a minority phase that starts at the
          // seams, the rivets and the water line and grows out from there.
          const rusted = smoothstep(0.575, 0.675, rust);
          // Paint leaves the arrises first; the noise only decides *where*
          // along an arris, never whether a flat field spontaneously chips.
          // Suppressed on the seam itself so the panel joint reads as a dark
          // recess rather than a bright line drawn round every panel.
          const chip = clamp01((smoothstep(0.30, 0.80, c.edge) * (0.34 + chipNoise * 1.1)
            + smoothstep(0.88, 0.99, chipNoise) * 0.55) * (1 - seamWide * 0.80));
          const chipped = smoothstep(0.40, 0.50, chip);
          const paint = clamp01(1 - Math.max(chipped, rusted));

          const pt = 0.82 + c.h * 0.30;
          let r = mix(C_STEEL[0], C_PAINT[0] * pt, paint);
          let g = mix(C_STEEL[1], C_PAINT[1] * pt, paint);
          let b = mix(C_STEEL[2], C_PAINT[2] * pt, paint);

          const rt = 0.65 + chipNoise * 0.7;
          r = mix(r, mix(C_RUST_DARK[0], C_RUST[0], rt), rusted);
          g = mix(g, mix(C_RUST_DARK[1], C_RUST[1], rt), rusted);
          b = mix(b, mix(C_RUST_DARK[2], C_RUST[2], rt), rusted);

          // Dirt packs into the lapped joint. A panel seam is a dark line on a
          // real structure, never a bright one.
          const grime = clamp01(c.cavity * 0.55 + seam * 0.55 + seamWide * 0.30);
          r *= 1 - grime * 0.34; g *= 1 - grime * 0.36; b *= 1 - grime * 0.37;

          out[0] = r; out[1] = g; out[2] = b;
          // Paint is a rough dielectric, bare steel a smooth conductor, rust a
          // very rough dielectric — one mask pair drives all three.
          out[3] = clamp(mix(mix(0.32, 0.60, paint), 0.94, rusted) - c.edge * 0.06, 0.12, 1.0);
          // Only genuinely bare steel is a conductor. Paint and oxide are not.
          out[4] = clamp01((1 - paint) * (1 - rusted));
          out[5] = 1;
        },
      };
    },
  },

  /* ===================================================== corrugated sheeting */
  corrugated: {
    label: 'Corrugated galvanised sheet',
    description: '125 mm trapezoidal profile with zinc spangle, rust creeping out of the valleys and along the cut edges.',
    tags: ['prop', 'industrial', 'wall'],
    minSize: 512, reliefM: 0.028, masks: 3,
    aoStrength: 1.0, curvGain: 0.7,
    detail: 'brushed', detailMetres: 0.20, detailStrength: 0.26,
    macro: 0.12, triplanar: false, worldScale: 1.0,
    build(seed, opts = {}) {
      const M = metrics(opts, 1.0);
      const RIBS = M.count(0.125, 2);             // 125 mm rib pitch
      const spangle = worley(seed + 51, M.per(0.030, 6), 1.0);
      const dent = fbm(seed + 52, M.per(0.30, 8), 3, 0.5);
      const rustF = warped(fbm01(seed + 53, M.per(0.28, 8), 4, 0.6), seed + 54, M.f(0.08), 3, 2);
      const runs = fbm01(seed + 55, M.per(0.20, 8), 3, 0.6);
      const cA = new Cell();
      return {
        sample(u, v, out) {
          // Trapezoidal profile: a raised cosine flattened at the crowns.
          const s = Math.cos(u * RIBS * Math.PI * 2);
          const profile = Math.sign(s) * Math.pow(Math.abs(s), 0.6);
          spangle(u, v, cA);
          const facet = cA.rand(3);
          out[0] = profile * 0.5 + dent(u, v) * 0.05 + (facet - 0.5) * 0.010;
          out[1] = clamp01(rustF(u, v) + runs(u * 3, v) * 0.35 - 0.2);
          out[2] = facet;
          out[3] = profile * 0.5 + 0.5;
        },
        shade(u, v, c, m, out) {
          const rustBase = m[0], facet = m[1], crown = m[2];
          const rust = clamp01(rustBase + (1 - crown) * 0.24 + c.cavity * 0.20 - c.edge * 0.22 - 0.10);
          const rusted = smoothstep(0.520, 0.615, rust);
          const zt = 0.82 + facet * 0.36;
          let r = C_ZINC[0] * zt, g = C_ZINC[1] * zt, b = C_ZINC[2] * zt;
          // Partial coverage, not a hard two-tone swap: weathered galvanising
          // goes through a long dull-grey stage before it goes orange, and a
          // binary zinc/oxide split reads as printed stripes.
          const ox = rusted * (0.55 + facet * 0.40);
          const rr = mix(C_RUST_DARK[0], C_RUST[0], 0.35 + facet * 0.5);
          const rg = mix(C_RUST_DARK[1], C_RUST[1], 0.35 + facet * 0.5);
          const rb = mix(C_RUST_DARK[2], C_RUST[2], 0.35 + facet * 0.5);
          r = mix(r * (1 - rusted * 0.30), rr, ox);
          g = mix(g * (1 - rusted * 0.32), rg, ox);
          b = mix(b * (1 - rusted * 0.33), rb, ox);
          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(mix(0.42 + facet * 0.14, 0.93, rusted), 0.18, 1.0);
          // Zinc is a conductor; the oxide that replaces it is not.
          out[4] = clamp01(1 - ox);
          out[5] = 1;
        },
      };
    },
  },

  /* ================================================================== sand */
  sand: {
    label: 'Wind-rippled sand',
    description: '90 mm ripple train over metre-scale drift, scattered gravel lag and damp compaction in the troughs.',
    tags: ['ground', 'terrain'],
    minSize: 512, reliefM: 0.090, masks: 3,
    aoStrength: 0.85, curvGain: 0.8,
    detail: 'grain', detailMetres: 0.07, detailStrength: 0.60,
    macro: 0.16, triplanar: true, worldScale: 2.0,
    build(seed, opts = {}) {
      const M = metrics(opts, 2.0);
      const RIPPLES = M.count(0.090, 3);          // 90 mm wind ripples
      const dune = fbm(seed + 61, M.per(1.6, 8), 4, 0.55);
      const crest = ridged(seed + 66, M.per(1.1, 8), 3, 0.5, 2.6);
      const warp = fbm(seed + 62, M.per(0.6, 8), 2, 0.5);
      const grain = fbm(seed + 63, M.per(0.004, 8), 2, 0.5);
      const peb = worley(seed + 64, M.per(0.065, 6), 1.0);
      const drift = fbm01(seed + 65, M.per(0.9, 8), 3, 0.6);
      const cA = new Cell();
      return {
        sample(u, v, out) {
          // Ripples are a phase-modulated train, not a sine: crests are sharp
          // and troughs broad because that is how saltation piles it. Dune
          // crests are ridges — the slip face is a discontinuity in transport,
          // so a ridged multifractal is the correct primitive.
          const dn = dune(u, v) * 0.60 + (crest(u, v) - 0.42) * 0.95;
          const ph = v * RIPPLES + warp(u, v) * 2.4 + dn * 1.6;
          const s = 0.5 + 0.5 * Math.cos(ph * Math.PI * 2);
          const ripple = s * s * Math.sqrt(s) * 0.5 + s * s * 0.5;   // ~pow(s,1.7)
          const cover = smoothstep(0.35, 0.65, drift(u, v));

          peb(u, v, cA);
          const stone = smoothstep(0.34, 0.12, cA.f1) * (cA.rand(4) > 0.86 ? 1 : 0) * (1 - cover * 0.6);

          out[0] = dn * 0.55 + ripple * 0.16 * cover + grain(u, v) * 0.05 + stone * 0.22;
          out[1] = stone; out[2] = ripple * cover; out[3] = cover;
        },
        shade(u, v, c, m, out) {
          const stone = m[0], ripple = m[1];
          // Sand's signature: warm, bright, and a very tight distribution —
          // the only real variable is moisture.
          const t = 0.86 + c.h * 0.26;
          let r = C_SAND[0] * t, g = C_SAND[1] * t, b = C_SAND[2] * t;
          const damp = c.cavity * 0.75;
          r = mix(r, C_SAND_DARK[0], damp * 0.68);
          g = mix(g, C_SAND_DARK[1], damp * 0.68);
          b = mix(b, C_SAND_DARK[2], damp * 0.70);
          const dry = c.edge * 0.35 + ripple * 0.22;
          r = mix(r, r * 1.14 + 0.010, dry);
          g = mix(g, g * 1.13 + 0.009, dry);
          b = mix(b, b * 1.11 + 0.007, dry);

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
    description: 'Packed crushed stone: 45 mm and 18 mm grades bedded in fines, dust washed into the interstices.',
    tags: ['ground', 'terrain'],
    minSize: 512, reliefM: 0.050, masks: 3,
    aoStrength: 1.25, curvGain: 0.9,
    detail: 'grain', detailMetres: 0.10, detailStrength: 0.55,
    macro: 0.15, triplanar: true, worldScale: 1.0,
    build(seed, opts = {}) {
      const M = metrics(opts, 1.0);
      const big = worley(seed + 71, M.per(0.045, 7), 1.0);
      const small = worley(seed + 72, M.per(0.018, 5), 1.0);
      const fines = fbm(seed + 73, M.per(0.020, 7), 3, 0.55);
      const dustF = fbm01(seed + 74, M.per(0.5, 8), 3, 0.6);
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
          r = mix(r, r * 1.3 + 0.015, c.edge * 0.45);
          g = mix(g, g * 1.28 + 0.014, c.edge * 0.45);
          b = mix(b, b * 1.26 + 0.013, c.edge * 0.45);
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
    description: 'Bitumen-bound 10 mm aggregate: exposed stone at the surface, fatigue cracking, oil staining in the ruts.',
    tags: ['ground', 'road'],
    minSize: 512, reliefM: 0.014, masks: 3,
    aoStrength: 1.0, curvGain: 1.0,
    detail: 'grain', detailMetres: 0.06, detailStrength: 0.55,
    macro: 0.13, triplanar: true, worldScale: 1.2,
    build(seed, opts = {}) {
      const M = metrics(opts, 1.2);
      const agg = worley(seed + 81, M.per(0.011, 5), 1.0);
      const fine = worley(seed + 82, M.per(0.0045, 4), 1.0);
      const binder = fbm(seed + 83, M.per(0.45, 8), 4, 0.6);
      const cracks = worley(seed + 84, M.per(0.35, 8), 0.9);
      const wobble = fbm(seed + 85, M.per(0.30, 8), 2, 0.5);
      const oil = fbm01(seed + 86, M.per(0.60, 8), 3, 0.6);
      const cA = new Cell(), cB = new Cell(), cC = new Cell();
      return {
        sample(u, v, out) {
          agg(u, v, cA);
          fine(u, v, cB);
          const a = smoothstep(0.30, 0.08, cA.f1) * (0.4 + cA.rand(10) * 0.6);
          const f = smoothstep(0.28, 0.08, cB.f1) * 0.45;

          const wu = u + wobble(u, v) * M.f(0.05);
          const wv = v + wobble(u + 5.3, v + 1.1) * M.f(0.05);
          cracks(wu, wv, cC);
          const crack = smoothstep(0.045, 0.006, cC.f2 - cC.f1)
            * smoothstep(0.42, 0.66, oil(u * 2, v * 2));

          out[0] = binder(u, v) * 0.20 + a * 0.30 + f * 0.14 - crack * 0.85;
          out[1] = a; out[2] = crack; out[3] = oil(u, v);
        },
        shade(u, v, c, m, out) {
          const a = m[0], crack = m[1], oily = m[2];
          const t = 0.88 + c.h * 0.24;
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
    minSize: 512, reliefM: 0.014, masks: 4,
    aoStrength: 1.0, curvGain: 1.0,
    detail: 'grain', detailMetres: 0.06, detailStrength: 0.50,
    macro: 0.13, triplanar: false, worldScale: 1.2,
    build(seed, opts = {}) {
      const M = metrics(opts, 1.2);
      const base = RECIPES.asphalt.build(seed, opts);
      // 120 mm stripe unless the caller says otherwise, expressed in metres.
      const halfWidth = (opts.lineWidthM ?? 0.12) * 0.5 / M.ws;
      const centre = opts.lineCentre ?? 0.5;
      const ragged = fbm(seed + 91, M.per(0.10, 7), 3, 0.55);
      const flake = fbm01(seed + 92, M.per(0.045, 6), 2, 0.6);
      return {
        sample(u, v, out) {
          base.sample(u, v, out);
          // The stripe edge is chipped, not straight: perturb it with a field
          // stretched along the stripe direction.
          const edge = halfWidth + ragged(u * 6, v) * M.f(0.012);
          out[4] = 1 - smoothstep(edge - M.f(0.006), edge, Math.abs(v - centre));
          // Paint adds ~1.5 mm of build — small, but it is what makes the
          // stripe catch a grazing light.
          out[0] += out[4] * 0.10;
        },
        shade(u, v, c, m, out) {
          base.shade(u, v, c, m, out);
          const stripe = m[3];
          if (stripe <= 0.001) return;
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
    description: '165 mm sawn softwood boards: growth rings raised by weathering, knots, split ends and grey UV-bleached crowns.',
    tags: ['prop', 'architecture', 'floor'],
    minSize: 512, reliefM: 0.008, masks: 4,
    aoStrength: 1.0, curvGain: 1.0,
    detail: 'brushed', detailMetres: 0.24, detailStrength: 0.45,
    macro: 0.14, triplanar: false, worldScale: 1.1,
    build(seed, opts = {}) {
      const M = metrics(opts, 1.1);
      const PLANKS = M.count(0.165, 2);            // 165 mm boards
      const grainW = fbm(seed + 101, M.per(0.20, 8), 4, 0.55);
      const ringN = fbm(seed + 102, M.per(0.40, 8), 3, 0.5);
      const fibre = fbm(seed + 103, M.per(0.004, 8), 2, 0.5);
      const knots = worley(seed + 104, M.per(0.30, 8), 0.9, 2.6);
      const wearN = fbm01(seed + 105, M.per(0.30, 8), 3, 0.6);
      const cA = new Cell();
      const gapW = 0.004 / (M.ws / PLANKS);        // 4 mm board gap, cell units
      // 6 mm growth rings across the board.
      const RINGS = Math.max(3, Math.round(0.165 / 0.006) * 0.5);
      return {
        sample(u, v, out) {
          const row = Math.floor(v * PLANKS);
          const ly = v * PLANKS - row;
          const gap = 1 - smoothstep(gapW * 0.4, gapW * 1.6, Math.min(ly, 1 - ly));
          const rnd = hash2f(0, ((row % PLANKS) + PLANKS) % PLANKS, seed + 106);

          // Growth rings: distance from the board's pith line, warped by the
          // long-grain field. Rings run *along* the plank, hence the stretch.
          const pith = (rnd - 0.5) * 0.9;
          const d = (ly - 0.5 - pith) * 2.2 + grainW(u, v) * 0.42;
          const ring = tri(Math.abs(d) * RINGS + ringN(u, v) * 1.3);
          const relief = Math.pow(ring, 1.6);

          knots(u, v, cA);
          const knotR = cA.f1 / (0.16 + cA.rand(11) * 0.10);
          const knot = clamp01(1 - knotR) * (cA.rand(12) > 0.70 ? 1 : 0);

          out[0] = relief * 0.28 + fibre(u, v) * 0.06 - gap * 1.0
            + (rnd - 0.5) * 0.07 + knot * 0.12;
          out[1] = relief; out[2] = knot; out[3] = rnd; out[4] = gap;
        },
        shade(u, v, c, m, out) {
          const ring = m[0], knot = m[1], rnd = m[2], gap = m[3];
          const t = 0.86 + rnd * 0.46;
          let r = mix(C_WOOD[0], C_WOOD_DARK[0], ring * 0.55) * t;
          let g = mix(C_WOOD[1], C_WOOD_DARK[1], ring * 0.55) * t;
          let b = mix(C_WOOD[2], C_WOOD_DARK[2], ring * 0.55) * t;
          r = mix(r, C_WOOD_DARK[0] * 0.55, knot);
          g = mix(g, C_WOOD_DARK[1] * 0.55, knot);
          b = mix(b, C_WOOD_DARK[2] * 0.55, knot);
          // UV bleaches exposed crowns to silver-grey; sheltered fibre keeps
          // its colour, which is why the effect tracks curvature.
          const bleach = clamp01(c.edge * 0.75 + wearN(u, v) * 0.35);
          const grey = 0.115;
          r = mix(r, grey * 1.02, bleach * 0.55);
          g = mix(g, grey, bleach * 0.55);
          b = mix(b, grey * 0.95, bleach * 0.55);
          const shade = c.cavity * 0.55 + gap;
          r *= 1 - shade * 0.45; g *= 1 - shade * 0.46; b *= 1 - shade * 0.46;
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
    minSize: 512, reliefM: 0.100, masks: 3,
    aoStrength: 1.35, curvGain: 0.8,
    detail: 'weave', detailMetres: 0.05, detailStrength: 0.70,
    macro: 0.12, triplanar: false, worldScale: 0.76,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.76);
      const COLS = M.count(0.38, 1);               // 380 x 190 mm laid bags
      const ROWS = M.count(0.19, 2);
      const L = { lx: 0, ly: 0, col: 0, row: 0, id: 0 };
      const slump = fbm(seed + 111, M.per(0.16, 8), 3, 0.55);
      const weave = fbm(seed + 112, M.per(0.010, 7), 2, 0.5);
      const STITCH = Math.max(6, Math.round(0.38 / 0.012));
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

          const seam = smoothstep(0.055, 0.008, Math.abs(sy)) * body;
          const stitch = seam * (0.5 + 0.5 * Math.cos(L.lx * STITCH * Math.PI * 2));

          const cloth = weave(u, v) * 0.05 + slump(u, v) * 0.09;
          out[0] = dome - seam * 0.16 + stitch * 0.05 + cloth * body;
          out[1] = body; out[2] = rnd; out[3] = seam;
        },
        shade(u, v, c, m, out) {
          const body = m[0], rnd = m[1], seam = m[2];
          const t = 0.74 + rnd * 0.40 + c.h * 0.20;
          let r = C_BURLAP[0] * t, g = C_BURLAP[1] * t, b = C_BURLAP[2] * t;
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
    description: '150 mm glazed field tile on a grout bed: cupped faces, crazed glaze, chipped arrises and grime in the joints.',
    tags: ['architecture', 'floor', 'wall'],
    minSize: 512, reliefM: 0.004, masks: 4,
    aoStrength: 1.2, curvGain: 1.1,
    detail: 'grain', detailMetres: 0.06, detailStrength: 0.18,
    macro: 0.10, triplanar: false, worldScale: 0.6,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.6);
      const COLS = M.count(0.15, 2);               // 150 mm tiles
      const ROWS = COLS;
      const L = { lx: 0, ly: 0, col: 0, row: 0, id: 0 };
      const craze = worley(seed + 121, M.per(0.012, 5), 0.85);
      const grout = fbm(seed + 122, M.per(0.006, 6), 2, 0.5);
      const chipN = worley(seed + 123, M.per(0.020, 5), 1.0);
      const cA = new Cell(), cB = new Cell();
      const jIn = 0.0015 / (M.ws / COLS), jOut = 0.005 / (M.ws / COLS);
      return {
        sample(u, v, out) {
          lattice(u, v, COLS, ROWS, 0, seed + 125, L);
          const face = Math.min(
            smoothstep(jIn, jOut, Math.min(L.lx, 1 - L.lx)),
            smoothstep(jIn, jOut, Math.min(L.ly, 1 - L.ly)),
          );
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
    minSize: 256, reliefM: 0.0005, masks: 3,
    aoStrength: 0.3, curvGain: 0.9,
    detail: null, detailMetres: 0.30, detailStrength: 0.2,
    macro: 0.06, triplanar: false, worldScale: 1.5,
    klass: 'physical',
    props: {
      transparent: true, opacity: 0.30, side: 2 /* THREE.DoubleSide */,
      roughness: 1.0, metalness: 0.0, ior: 1.52,
      envMapIntensity: 2.0, depthWrite: false,
    },
    build(seed, opts = {}) {
      const M = metrics(opts, 1.5);
      const wave = fbm(seed + 131, M.per(0.8, 8), 3, 0.5);
      const smear = warped(fbm01(seed + 132, M.per(0.35, 8), 3, 0.6), seed + 133, M.f(0.12), 3, 2);
      const scratch = worley(seed + 134, M.per(0.06, 6), 1.0, 6.0);
      const dustF = fbm01(seed + 135, M.per(0.18, 8), 3, 0.6);
      const cA = new Cell();
      return {
        sample(u, v, out) {
          scratch(u, v, cA);
          const sc = smoothstep(0.020, 0.002, cA.f2 - cA.f1) * (cA.rand(14) > 0.55 ? 1 : 0);
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
    description: 'Moulded EPDM: 1.5 mm pebble grain from the tool, scuffed high points, dust in the pores.',
    tags: ['prop', 'weapon'],
    minSize: 256, reliefM: 0.0012, masks: 2,
    aoStrength: 0.55, curvGain: 1.0,
    detail: 'pit', detailMetres: 0.012, detailStrength: 0.55,
    macro: 0, triplanar: false, worldScale: 0.5,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.5);
      const peb = worley(seed + 141, M.per(0.0015, 5), 1.0);
      const micro = fbm(seed + 142, M.per(0.0008, 6), 2, 0.5);
      const scuffF = fbm01(seed + 143, M.per(0.05, 8), 3, 0.6);
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
          const t = 0.90 + c.h * 0.16;
          let r = C_RUBBER[0] * t, g = C_RUBBER[1] * t, b = C_RUBBER[2] * t;
          // Scuffing only happens where something can touch: convex crowns.
          const scuff = clamp01(smoothstep(0.30, 0.9, c.edge) * (0.4 + scuffN * 0.9));
          r = mix(r, r * 1.6 + 0.010, scuff);
          g = mix(g, g * 1.6 + 0.010, scuff);
          b = mix(b, b * 1.6 + 0.011, scuff);
          r *= 1 - c.cavity * 0.25; g *= 1 - c.cavity * 0.26; b *= 1 - c.cavity * 0.26;
          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(0.84 - pebble * 0.08 + scuff * 0.10, 0.45, 1.0);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },

  /* ================================================================ canvas */
  canvas: {
    label: 'Canvas webbing',
    description: 'Plain-weave cotton duck: individual warp and weft threads at 1 mm pitch, frayed fibre, salt and dust worked into the crowns.',
    tags: ['prop', 'character', 'fabric'],
    minSize: 256, reliefM: 0.0015, masks: 2,
    aoStrength: 1.1, curvGain: 1.0,
    detail: 'weave', detailMetres: 0.02, detailStrength: 0.65,
    macro: 0, triplanar: false, worldScale: 0.6,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.6);
      // A real 1.2 mm thread pitch is ~1 texel at any bake size we can afford,
      // i.e. guaranteed moire. Cap it at ~5 texels and let the shared 'weave'
      // detail normal carry the true thread scale.
      const TH = M.per(0.0012, 5);
      const fuzz = fbm(seed + 151, M.per(0.0015, 6), 2, 0.5);
      const slub = fbm(seed + 152, M.per(0.05, 8), 3, 0.55);
      const wearN = fbm01(seed + 153, M.per(0.10, 8), 3, 0.6);
      return {
        sample(u, v, out) {
          const iu = Math.floor(u * TH), iv = Math.floor(v * TH);
          const fu = u * TH - iu, fv = v * TH - iv;
          // Plain weave: on each cell one thread crosses over the other.
          const over = ((iu + iv) & 1) === 0;
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
    label: 'Parkerised steel',
    description: 'Manganese-phosphate receiver: a matte DIELECTRIC conversion coating over bead-blast, machining witness marks, and holster wear polishing the arrises back to bare conductor.',
    tags: ['weapon', 'prop'],
    // A 0.5 mm bead-blast texture occludes essentially nothing. Baking a
    // strong AO term off a micro height field just makes the receiver muddy.
    minSize: 512, reliefM: 0.0006, masks: 2,
    aoStrength: 0.45, curvGain: 1.4,
    detail: 'brushed', detailMetres: 0.03, detailStrength: 0.30,
    // Macro is a WORLD-SPACE field. A viewmodel travels through world space, so
    // any macro term makes the blotches swim across the gun. Weapons get zero.
    macro: 0, triplanar: false, worldScale: 0.35,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.35);
      // The height field has to be dominated by ~20 mm forging form, not by
      // sub-millimetre blast grain. Curvature is normalised by its own RMS, so
      // a field made only of micro noise makes *every* texel read as an edge —
      // and edge drives the wear mask, which is why the receiver came out as a
      // field of white speckle. Micro belongs in the shader detail normal.
      const forge = fbm(seed + 162, M.per(0.022, 10), 3, 0.55);
      const dings = worley(seed + 163, M.per(0.018, 6), 1.0);
      // Two wear fields: where a hand or a holster actually touches (coarse
      // contact zones) and how ragged the boundary is inside a zone.
      const zoneN = fbm01(seed + 164, M.per(0.09, 10), 3, 0.55);
      const wearN = fbm01(seed + 165, M.per(0.025, 8), 3, 0.6);
      const cA = new Cell();
      const MACH = M.count(0.006, 8);              // 6 mm cutter witness pitch
      return {
        sample(u, v, out) {
          // Witness marks from the cutter: a fine periodic ripple in one axis
          // only, which is what makes machined steel read as machined.
          const mach = Math.cos(v * MACH * Math.PI * 2 + forge(u, v) * 3.0) * 0.5 + 0.5;
          dings(u, v, cA);
          const ding = smoothstep(0.10, 0.02, cA.f1) * (cA.rand(15) > 0.88 ? 1 : 0);
          out[0] = forge(u, v) * 0.62 + mach * 0.07 - ding * 0.55;
          out[1] = clamp01(smoothstep(0.44, 0.76, zoneN(u, v)) * (0.40 + wearN(u, v) * 0.95));
          out[2] = ding;
        },
        shade(u, v, c, m, out) {
          const wearN = m[0], ding = m[1];
          // Holster and hand wear polishes the phosphate off high curvature.
          // `wearN` is already the contact-zone mask; multiplying it by curvature
          // keeps polish-through to the arrises *inside* a contact zone only.
          const worn = clamp01(smoothstep(0.45, 1.15, c.edge) * wearN * 1.5);
          // Hard-ish threshold: the coating is either there or it is not.
          // Kept tight so bare conductor covers a few per cent of the receiver,
          // which is what holster wear on a service weapon actually looks like
          // — not the whole part.
          const bright = smoothstep(0.28, 0.62, worn);
          // A fresh ding cuts through to bare metal at its floor only.
          const bare = clamp01(Math.max(bright, smoothstep(0.55, 0.9, ding)));

          // Phosphate is a dark matte DIELECTRIC. Its diffuse albedo is ~0.05.
          const t = 0.90 + c.h * 0.18;
          let r = mix(C_PARKER[0] * t, C_STEEL[0], bare);
          let g = mix(C_PARKER[1] * t, C_STEEL[1], bare);
          let b = mix(C_PARKER[2] * t, C_STEEL[2], bare);

          // Carbon fouling in the recesses; keeps it from reading as clean CAD.
          const foul = c.cavity * 0.7;
          r *= 1 - foul * 0.34; g *= 1 - foul * 0.35; b *= 1 - foul * 0.35;

          out[0] = r; out[1] = g; out[2] = b;
          // Unworn phosphate floors at 0.55 — it is a matte coating, not a
          // mirror. Only the polished-through arrises get glossy.
          out[3] = clamp(mix(0.58, 0.17, bare) + foul * 0.12 - ding * 0.04, 0.12, 1.0);
          // CONDUCTOR ONLY WHERE THE COATING IS GONE. Writing 1 here
          // unconditionally turned the whole receiver into a sky mirror.
          out[4] = clamp01(bare);
          out[5] = 1;
        },
      };
    },
  },

  /* =============================================================== polymer */
  polymer: {
    label: 'Textured polymer',
    description: 'Glass-filled nylon furniture: a single-frequency moulded stipple, parting line, and gloss where hands have burnished it. Deliberately the flattest, lowest-variance recipe in the set.',
    tags: ['weapon', 'prop'],
    minSize: 256, reliefM: 0.0010, masks: 3,
    aoStrength: 0.45, curvGain: 1.2,
    detail: 'pit', detailMetres: 0.010, detailStrength: 0.45,
    macro: 0, triplanar: false, worldScale: 0.35,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.35);
      const stip = worley(seed + 171, M.per(0.0012, 5), 1.0);
      const flow = fbm(seed + 172, M.per(0.05, 8), 3, 0.5);
      const micro = fbm(seed + 173, M.per(0.0006, 6), 2, 0.5);
      const fillC = worley(seed + 174, M.per(0.0025, 5), 1.0, 3.2);
      const cA = new Cell(), cB = new Cell();
      return {
        sample(u, v, out) {
          stip(u, v, cA);
          // Moulded stipple: truncated pyramids, flat-topped, hard-edged.
          const p = clamp01(1 - cA.f1 / 0.30);
          const pyr = Math.min(1, p * 1.6);
          const fl = flow(u, v);
          // Glass fibre ends breaking the moulded skin — the only reason a
          // black polymer part is not a flat colour swatch in a photograph.
          fillC(u, v, cB);
          const fleck = smoothstep(0.16, 0.03, cB.f1) * (cB.rand(17) > 0.72 ? 1 : 0);
          out[0] = pyr * 0.45 + fl * 0.08 + micro(u, v) * 0.04 + fleck * 0.05;
          out[1] = pyr; out[2] = fl * 0.5 + 0.5; out[3] = fleck;
        },
        shade(u, v, c, m, out) {
          const pyr = m[0], flowN = m[1], fleck = m[2];
          // Very low colour variance by design — polymer's identity is a
          // near-uniform dark field whose story is told by the specular.
          const t = 0.94 + flowN * 0.10;
          let r = C_POLYMER[0] * t, g = C_POLYMER[1] * t, b = C_POLYMER[2] * t;
          // Exposed fibre is pale and matte.
          r = mix(r, r * 2.1 + 0.006, fleck * 0.55);
          g = mix(g, g * 2.1 + 0.006, fleck * 0.55);
          b = mix(b, b * 2.05 + 0.006, fleck * 0.55);
          const burnish = clamp01(smoothstep(0.35, 0.95, c.edge) * 0.9);
          r = mix(r, r * 1.25, burnish); g = mix(g, g * 1.25, burnish); b = mix(b, b * 1.26, burnish);
          r *= 1 - c.cavity * 0.18; g *= 1 - c.cavity * 0.19; b *= 1 - c.cavity * 0.19;
          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(0.66 - burnish * 0.34 - pyr * 0.04 + fleck * 0.16 + c.cavity * 0.08, 0.20, 1.0);
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
