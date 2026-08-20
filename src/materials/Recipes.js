import {
  fbm, fbm01, worley, warped, Cell, lattice,
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
 *
 * and the three ACCENT recipes, which exist for a different reason. The seven
 * above are a neutral field; measured on this tree every one of them, and every
 * other level surface with any saturation at all, sat inside hue 14-54 degrees
 * — a 40-degree warm window with nothing outside it but near-neutrals. A real
 * street is a neutral field with a few saturated things standing in front of
 * it, so these three exist to BE those things, and they take their colour as a
 * bake parameter rather than as a multiply:
 *
 *   recipe       what it is                 chroma  where it belongs
 *   car_paint    clearcoat over base coat   HIGH    vehicle panels
 *   sign_enamel  fired glass on steel       HIGH    shopfronts, lane markers
 *   tile(paint)  glazed field tile          MED     thresholds, counters, wet
 *
 * plus `paint` on metal / wood / corrugated / canvas / plaster, which turns the
 * existing neutrals into painted shutters, joinery, awnings and washed facades
 * without a second bake pipeline.
 *
 * The five viewmodel surfaces at the bottom of the file play the same game
 * against each other, on a much tighter pitch — every one of them is a dark
 * near-neutral, so what has to separate them is process, not colour:
 *
 * Every number in the `rendered rough` column is MEASURED on the bake at the
 * size and seed the caller actually asks for, after that slot's multiplier —
 * mean, then (min..max). None of the five clips at either end and none of them
 * is bimodal; see the roughness block in `receiver_phosphate` for why that is
 * the property that matters rather than the mean.
 *
 *   recipe             albedo (lin)  rendered rough        identity band  cond.
 *   barrel_nitride     0.080 = F0    0.34 (0.27..0.48)     5 mm turning   ALWAYS
 *   furniture_polymer  0.036 warm    0.60 (0.32..0.74)     1.8 mm stipple never
 *   receiver_phosphate 0.048 warm    0.72 (0.41..0.88)     3 mm scallops  never
 *   rail_anodised      0.035 neutral 0.80 (0.72..0.89)     4 mm die lines never
 *   grip_rubber        0.031 neutral 0.88 (0.65..0.93)     1.6 mm pebble  never
 *
 * Ordered by gloss on purpose: five parts, five specular registers, and the
 * gaps between them are what makes the assembly read as an assembly rather
 * than as one steel wearing five hats. The barrel is the only hard highlight,
 * the grip the only genuinely dead surface, and the receiver sits in the
 * middle where a phosphate conversion coating belongs.
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
/**
 * Phosphate that has been worn back — the DIFFUSE colour of it.
 *
 * This is the constant the "blue digital camouflage" turned out to be. The
 * receiver recipe used to blend its wear mask straight to `C_STEEL`, which is
 * correct only if the surface is then shaded as a CONDUCTOR: a conductor has
 * essentially no diffuse reflectance, and 0.75 is its *specular* F0, delivered
 * through the metalness channel the recipe also writes (`out[4] = bare`).
 *
 * The viewmodel forces `metalness: 0` on the whole receiver — deliberately, see
 * `DIELECTRIC` in Gunsmith.js, because writing 1 there turned the gun into a
 * sky mirror. That override throws away the conductor mask but keeps the
 * conductor's albedo, so every worn speckle was being rendered as a 0.75-albedo
 * DIELECTRIC. That is the reflectance of white paint. Scattered in ~90 mm
 * contact zones over a 0.26 coating and lit by a blue sky, a field of white
 * speckles on dark blue-grey is, precisely, a digital camouflage print — which
 * is what two reviews in a row called it.
 *
 * Worn parkerising is burnished, not stripped: it goes a little lighter and a
 * lot glossier. The lightness lives here and stays modest; the gloss lives in
 * the roughness channel, which is where a real receiver's wear actually reads
 * and which costs no albedo contrast at all.
 */
const C_WORN = srgb(0.40, 0.398, 0.412);
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

/* ------------------------------------------------- weapon-surface palette */
/*
 * Five processes, five colours, and they are deliberately NOT five samples of
 * one grey. A rifle is an assembly, and the eye reads "assembly" from the
 * *steps* between adjacent parts, not from the wear inside any one of them.
 *
 *   part                 linear luma   hue           process
 *   receiver phosphate      0.048      warm charcoal chemical conversion coat
 *   rail hard anodising     0.035      neutral       ceramic Al2O3, no metal
 *   barrel nitride          0.086 F0   neutral       CONDUCTOR, glossy
 *   furniture nylon         0.036      warm neutral  moulded, satin
 *   grip overmould          0.031      neutral       moulded, dead matte
 *
 * The receiver is authored WARM on purpose. Measured off the round-3 capture,
 * a 40x20 px patch of unoccluded receiver flat came back rgb 25,26,30 — the
 * darkest object in a desert frame was also its bluest, which is most of what
 * "blue-black digital camouflage" actually names. Only +2% of that blue is in
 * the albedo; the rest is sky IBL, which is nearly all the light a matte dark
 * dielectric returns. So the coating is biased ~13% red to land neutral once
 * the sky has been added back, which is also what manganese phosphate looks
 * like: a warm charcoal, never a blue-black.
 */
const C_PHOSPHATE = srgb(0.258, 0.246, 0.232);   // 0.048 linear, warm charcoal
/**
 * Phosphate that a hand or a holster has BURNISHED — not stripped.
 *
 * 1.6x the coating's reflectance, and that ceiling is the point. The previous
 * generation blended worn phosphate to `C_WORN` (0.133 linear, 2.8x) and before
 * that to `C_STEEL` (0.53 linear, 11x); an 11x albedo step scattered in islands
 * is a camouflage print by construction. Polished phosphate is still phosphate.
 * Its wear reads through GLOSS, which costs no albedo contrast at all.
 */
const C_PHOS_BURNISH = srgb(0.315, 0.305, 0.296);
const C_ANODISE = srgb(0.210, 0.208, 0.211);     // 0.0345 linear, type-III black
const C_ANODISE_SCUFF = srgb(0.295, 0.288, 0.276); // oxide dust + substrate
/**
 * Nitrided barrel steel, used as CONDUCTOR F0 — not as a diffuse colour.
 *
 * Bare steel's real F0 is 0.53-0.58 and putting that on a viewmodel under a sky
 * environment produces a mirror, which is the single failure mode this file and
 * Gunsmith.js both already carry warnings about. A QPQ-nitrided, fired barrel is
 * not bare steel: it is an iron-nitride case that has been carbon-loaded by use,
 * and 0.086 is a defensible reflectance for it. It also keeps the barrel about
 * 0.2x the sand's radiance, i.e. clearly the darkest metal in the frame, while
 * still being the only part with a hard moving highlight.
 */
const C_NITRIDE = srgb(0.325, 0.322, 0.320);
const C_CARBON = srgb(0.140, 0.136, 0.134);      // 0.0165 linear — combustion soot
const C_FURNITURE = srgb(0.216, 0.212, 0.207);   // 0.036 linear — glass-filled nylon
const C_FIBRE = srgb(0.40, 0.39, 0.37);          // glass fibre ends in the skin
const C_OVERMOULD = srgb(0.200, 0.199, 0.200);   // 0.031 linear — grip elastomer
/**
 * Urban grime. This used to be srgb(0.24, 0.20, 0.15) — a warm brown, and it is
 * mixed into the cavity of nearly every architectural recipe, so every recess,
 * every rain streak and every soot bed in the level was pulling toward the same
 * hue as the sunlight. The frame was reviewed as "warm-dominant to the point of
 * monochrome" and this constant is one of the reasons: the shade had no colour
 * of its own to be separated by. Real soot and road film are a neutral-to-cool
 * grey-brown; the warmth in a dirty wall comes from the wall, not the dirt.
 */
const C_DIRT = srgb(0.215, 0.202, 0.192);

/* ------------------------------------------------------------------ paint */

/**
 * COLOUR IS BAKED, NOT MULTIPLIED.
 * =================================
 * Measured on this tree (node, 128px bake, the world scales LevelModule asks
 * for): every level material with any saturation at all sits between hue 14 deg
 * and 54 deg —
 *
 *   brick 14  wood 27  gravel 35  sandbag 38  sand 39  plaster 41  metal 43
 *   canvas 54
 *
 * and everything outside that 40-degree window (asphalt, rubber, gunmetal,
 * polymer, corrugated) is a near-neutral at saturation 0.01-0.05, i.e. its
 * "hue" is dither on a grey. Intra-material hue spread is 0-13 deg. The library
 * was one colour in twenty hats, and the rendered frames agree: the captured
 * market shots carry a circular hue standard deviation of 9-35 deg with one
 * 30-degree bin holding 46-65% of every chromatic pixel, against 114-122 deg
 * and 20-40% for the forest map shot on the same rig.
 *
 * The level DID try to place accents — `M.shutter` is documented as "faded teal
 * joinery", `M.signage` as a blue sign, `M.rug` as a red rug — through
 * `material.color`. That path cannot work here and the arithmetic says why:
 * a THREE material colour MULTIPLIES the baked albedo. Teal 0x4d6f74 is linear
 * (0.076, 0.164, 0.187); wood bakes to linear (0.152, 0.084, 0.040). The
 * product is (0.012, 0.014, 0.007) — a near-black olive at 1.4% reflectance.
 * The shutter is not a faded teal, it is a dark smudge, and that is exactly
 * what the frames show. Multiplication can only ever darken and can only ever
 * pull toward the intersection of two spectra; it cannot put a colour on a
 * surface that did not already have it.
 *
 * So a painted surface takes its coat colour as a BAKE PARAMETER. The recipe
 * substitutes the coat and keeps every mask it already had — the chipping still
 * follows curvature, the rust still blooms out of the cavities, the grime still
 * packs into the seam — because what changes when a shutter is painted teal is
 * the coat, not the physics of how it fails.
 *
 * Recipes that accept one declare `paintable: true`; TextureFactory routes a
 * caller's `material.color` into this parameter for those recipes and drops the
 * multiply, so no call site has to change to get its colour back. Materials
 * whose tint is *meant* to be a shallow multiply — the ground decals, which are
 * documented as such — are deliberately NOT paintable and keep the old path.
 */

/** sRGB hex or [r,g,b] in 0..1 sRGB -> linear triple. Null when unpainted. */
function paintOf(opts, key = 'paint') {
  const p = opts?.[key];
  if (p == null) return null;
  if (typeof p === 'number') {
    return srgb(((p >> 16) & 255) / 255, ((p >> 8) & 255) / 255, (p & 255) / 255);
  }
  if (Array.isArray(p) && p.length >= 3) return srgb(p[0], p[1], p[2]);
  return null;
}

/**
 * Coat weathering, applied to a paint colour before it is laid down.
 *
 * A painted surface outdoors is never the colour it left the tin. UV takes the
 * chroma out of it first and the value second, so a sun-faded coat is *paler
 * and less saturated*, not simply darker; and the fade is uneven, which is what
 * makes a real shutter read as painted-then-weathered rather than as a flat
 * swatch. `t` is 0 (sheltered, full strength) to 1 (fully bleached).
 */
function faded(c, t, toward = 0.42, keepChroma = 0.50) {
  const l = Math.max(1e-4, c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722);
  // Where the value ends up. Dark paints lift, near-white ones settle.
  const target = mix(l, toward, 0.5 * t);
  // Rescale the colour to that value FIRST — a uniform scale is hue-preserving
  // — then blend toward the neutral of the same value to take the chroma out.
  //
  // Doing it the other way round (blend straight toward a grey) is what the
  // first cut of this did, and it was wrong in a way that only showed up on
  // measurement: at full bleach it landed every colour on one common grey, so
  // a teal roller shutter baked out at saturation 0.01 with 123 degrees of
  // intra-material hue spread — i.e. dither. Fading is a loss of chroma at
  // constant hue, not a walk to grey.
  const s = target / l;
  const keep = mix(1, keepChroma, t);
  return [
    mix(target, c[0] * s, keep),
    mix(target, c[1] * s, keep),
    mix(target, c[2] * s, keep),
  ];
}

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
    macro: 0.16, macroHue: 0.58, triplanar: true, worldScale: 1.2,
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
    // The largest surface in the level by area after the ground, so it is the
    // one that decides whether the frame has any chroma range at all. macroHue
    // is raised well above the 0.40 default because on a facade the warm/cool
    // swing IS the read: a sunlit wall and a damp shaded one are two colours,
    // not two brightnesses, and at 0.40 the difference was inside the dither.
    macro: 0.18, macroHue: 0.66, triplanar: true, worldScale: 0.9,
    paintable: true,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.9);
      // Limewash. Note this is the coat colour, not a multiplier — see the
      // paint block at the top of the file for why a multiply cannot put a
      // colour on a surface. `washStrength` is how much pigment is in it.
      const WASH = paintOf(opts);
      const WASH_W = clamp01(opts.washStrength ?? 0.42);
      // Metric brick: 215 x 65 mm unit on a 10 mm joint -> 225 x 75 mm course.
      const COLS = M.count(0.225, 2);
      const ROWS = M.count(0.075, 4);
      const L = { lx: 0, ly: 0, col: 0, row: 0, id: 0 };

      const trowel = fbm(seed + 21, M.per(0.55, 8), 3, 0.55);
      const skim = fbm(seed + 22, M.per(0.16, 6), 3, 0.5);
      const grit = fbm(seed + 23, M.per(0.006, 8), 2, 0.5);
      // WHY THIS IS 1.25 m AND NOT 0.65 m, AND WHY THE THRESHOLD MOVED.
      //
      // The blown-render mask switches between lime coat (0.59 linear) and bare
      // brick (0.10 linear) — a 6:1 step, the largest single contrast in the
      // whole library. At a 0.65 m period thresholded at the median it covered
      // half the wall in patches small enough that six or seven of them fitted
      // inside one 2 m tile. Measured off the bake, that left the albedo with a
      // standard deviation of 25 out of 255 STILL PRESENT at 250 mm per texel:
      // low-frequency, high-contrast, and repeating on a 2 m lattice. That is
      // precisely the "repeating blocky pattern at mid distance" in the review,
      // and no amount of macro breakup can hide a signal that strong.
      //
      // A render sheet blows off in one or two big pieces per bay, not in a
      // dither. Bigger patches, far fewer of them: the tile now holds one or
      // two events instead of half a dozen, so the repeat has much less to
      // announce, and what is left the world-space macro can actually cover.
      const blown = warped(fbm01(seed + 24, M.per(1.25, 8), 4, 0.58), seed + 25, M.f(0.10), 3, 2);
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
          // lime render sheets off in flakes, it does not fade out. The
          // threshold sits well below the median so the coat is the rule and
          // the bare patch is the exception: about a fifth of the wall, which
          // is what a neglected but still-standing building looks like.
          const p = smoothstep(0.375, 0.455, blown(u, v));

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
          // What is exposed when a render sheet lets go is not clean brick: the
          // scratch coat stays keyed to the masonry and the whole patch is
          // powdered with the lime that came off it. Left as bare brick the
          // step from coat to substrate was 4-5x in reflectance — the single
          // biggest low-frequency contrast in the library, sitting on a 2 m
          // lattice. Residue takes it to about 2.5x, which is both what the
          // wall actually looks like and enough for the world-space macro to
          // finish hiding the repeat.
          const residue = 0.46 + bTone * 0.16;
          r = mix(r, C_PLASTER_2[0] * 0.80, residue);
          g = mix(g, C_PLASTER_2[1] * 0.79, residue);
          b = mix(b, C_PLASTER_2[2] * 0.78, residue);
          let rough = mix(0.90, 0.96, mortar);

          /* the coat itself — bright, warm, and very low variance. The only
             colour movement is the float sweep and the older coat showing
             through where the top skim is thin. */
          let pr = mix(C_PLASTER_2[0], C_PLASTER[0], sweep);
          let pg = mix(C_PLASTER_2[1], C_PLASTER[1], sweep);
          let pb = mix(C_PLASTER_2[2], C_PLASTER[2], sweep);
          if (WASH) {
            // Limewash. It tints the COAT and nothing else: the blown patches
            // stay fired clay and lime residue, because the wash went on after
            // the render and came off with it. That asymmetry is why a washed
            // facade with a patch missing reads as damaged rather than as two
            // materials sharing a boundary.
            //
            // Applied at partial strength on purpose. Lime is a thin, chalky,
            // translucent binder — it shifts a wall's hue, it does not repaint
            // it — and a facade at the full chroma of the pigment is a
            // cartoon. WASH_W stays under half by default for that reason.
            pr = mix(pr, WASH[0] * (0.86 + sweep * 0.26), WASH_W);
            pg = mix(pg, WASH[1] * (0.86 + sweep * 0.26), WASH_W);
            pb = mix(pb, WASH[2] * (0.86 + sweep * 0.26), WASH_W);
          }
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

          // Cavity dirt, and it goes COOLER as it goes darker rather than
          // warmer. The old weights (r 0.34, g 0.36, b 0.37) took blue down
          // fastest, which warmed every recess on every wall in the level and
          // left the frame with a single hue at two brightnesses. A recess is
          // filled by sky, not by sun; taking red down fastest is both what the
          // light does and what gives the image somewhere cool to sit.
          const dirt = c.cavity * 0.55;
          r *= 1 - dirt * 0.40; g *= 1 - dirt * 0.36; b *= 1 - dirt * 0.30;

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
    macro: 0.17, macroHue: 0.60, triplanar: true, worldScale: 0.9,
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
          // Soot in the beds. Red-first, for the same reason as plaster's
          // cavity dirt: a shaded joint is lit by sky and has no business
          // being the warmest thing on the wall.
          const soot = c.cavity * 0.7;
          r *= 1 - soot * 0.48; g *= 1 - soot * 0.44; b *= 1 - soot * 0.37;

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
    macro: 0.12, macroHue: 0.52, triplanar: false, worldScale: 1.4,
    paintable: true,
    build(seed, opts = {}) {
      const M = metrics(opts, 1.4);
      // The coat. Olive drab is only the default; a caller that wants a blue
      // sign, a green car panel or a red kiosk front asks for it here and gets
      // the same chipping, rusting and seam grime laid over a different paint.
      const COAT = paintOf(opts) || C_PAINT;
      const COAT_SUN = faded(COAT, 1, 0.50);
      const PC = M.count(0.60, 1);                 // 600 mm panels
      const PR = M.count(0.70, 1);
      const L = { lx: 0, ly: 0, col: 0, row: 0, id: 0 };
      const oilcan = fbm(seed + 41, M.per(0.35, 8), 3, 0.5);
      const mill = fbm(seed + 42, M.per(0.10, 7), 2, 0.5);
      const rustF = warped(fbm01(seed + 43, M.per(0.45, 8), 4, 0.6), seed + 44, M.f(0.10), 3, 2);
      const runs = fbm01(seed + 45, M.per(0.22, 8), 3, 0.6);
      const chipN = fbm01(seed + 46, M.per(0.10, 7), 3, 0.6);
      const scab = fbm(seed + 47, M.per(0.012, 7), 2, 0.5);
      // Half-metre UV fade field. Sun does not bleach a panel evenly and the
      // unevenness is most of what separates a painted object from a swatch.
      const sunF = fbm01(seed + 49, M.per(0.55, 8), 3, 0.62);

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
          // Fade tracks exposure: the crowns catch the sun, the cavities do
          // not, so the coat holds its chroma exactly where the geometry
          // shelters it. One field, two registers of the same colour.
          const sun = clamp01(smoothstep(0.30, 0.85, sunF(u, v)) * 0.75 + c.edge * 0.45);
          const cr = mix(COAT[0], COAT_SUN[0], sun) * pt;
          const cg = mix(COAT[1], COAT_SUN[1], sun) * pt;
          const cb = mix(COAT[2], COAT_SUN[2], sun) * pt;
          let r = mix(C_STEEL[0], cr, paint);
          let g = mix(C_STEEL[1], cg, paint);
          let b = mix(C_STEEL[2], cb, paint);

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

  /* ============================================================== car paint */
  /*
   * A LEVEL ACCENT, NOT A SHOWROOM FINISH.
   *
   * `LevelModule` carried a TODO asking for this: its two vehicle bodies were
   * `metal` tinted 0x6f7d74 and 0x9a8f7c, i.e. rusting riveted industrial plate
   * multiplied by a grey — the frame shows a car body wearing a shipping
   * container's panel seams and rivet lines, and the tint could only darken it.
   * A car is one of about four objects in a market street that is allowed to be
   * a strong flat colour, and vehicles sit in the middle of lanes where the
   * player is looking; giving up that accent to a rivet field is a bad trade.
   *
   * The three things that make automotive paint read as automotive paint and
   * are all cheap here:
   *   - ORANGE PEEL. The reason a car highlight wobbles and a fridge highlight
   *     does not. True peel is a ~3 mm undulation, which at a 1.6 m tile is
   *     under two texels even at 1024 and would alias rather than shade, so the
   *     bake carries the ~12 mm band it can actually resolve and the 'brushed'
   *     detail normal at 110 mm/tile carries the rest. Claiming 3 mm in the
   *     bake would have been a number the texture cannot hold.
   *   - A SPECULAR/DIFFUSE SPLIT. Clearcoat is a smooth dielectric over a
   *     coloured base, so the surface stays glossy where it is clean and goes
   *     matte only where road film and oxidation have killed the clear.
   *   - FAILURE AT THE BOTTOM. Stone chips, road film and sill rot all live in
   *     the lower third of a panel and nowhere else. Wear that is uniform over
   *     a body panel is the single clearest tell of a procedural surface.
   */
  car_paint: {
    label: 'Automotive paint',
    description: 'Colour base under clearcoat: orange peel, swage line, shut line, stone chipping and road film up the lower panel, clear gone chalky on the horizontal.',
    tags: ['prop', 'vehicle'],
    minSize: 512, reliefM: 0.004, masks: 4,
    aoStrength: 0.85, curvGain: 1.0,
    klass: 'physical',
    props: { clearcoat: 1.0, clearcoatRoughness: 0.09 },
    detail: 'brushed', detailMetres: 0.11, detailStrength: 0.16, detailAlbedo: 0.10,
    macro: 0.10, macroHue: 0.44, triplanar: false, worldScale: 1.6,
    paintable: true,
    build(seed, opts = {}) {
      const M = metrics(opts, 1.6);
      const BODY = paintOf(opts) || srgb(0.66, 0.67, 0.68);
      // Automotive pigment does not fade the way a limewash does: the clear
      // goes first and takes the gloss, then the base chalks. So the faded
      // register is the same hue at lower chroma, never a different hue.
      const BODY_OX = faded(BODY, 1, 0.30, 0.62);   // the clear dies before the pigment does
      const SWAGE = M.count(0.90, 1);              // one crease per body side
      const peel = fbm(seed + 201, M.per(0.003, 4), 2, 0.5);
      const panelF = fbm(seed + 202, M.per(0.50, 8), 3, 0.55);
      const chipC = worley(seed + 203, M.per(0.010, 5), 1.0);
      const filmF = fbm01(seed + 204, M.per(0.28, 8), 3, 0.6);
      const oxF = fbm01(seed + 205, M.per(0.60, 8), 3, 0.58);
      const cA = new Cell();
      const shutW = 0.005 / M.ws;                  // 5 mm panel gap
      return {
        sample(u, v, out) {
          // Swage: a shallow crease running the length of the panel, plus one
          // vertical shut line where two panels meet.
          const sy = v * SWAGE;
          const crease = Math.pow(Math.abs(Math.sin(sy * Math.PI)), 3.0);
          const shutU = Math.abs(((u * 2) % 1) - 0.5) * 2;
          const shut = 1 - smoothstep(shutW * 0.5, shutW * 3.0, (1 - shutU) * 0.5);

          chipC(u, v, cA);
          // Stone chips: below the waistline only, and rarer the higher you go.
          const low = smoothstep(0.75, 0.20, v);
          const chip = smoothstep(0.20, 0.02, cA.f1) * (cA.rand(7) > 0.965 - low * 0.03 ? 1 : 0) * low;

          out[0] = crease * 0.30 + peel(u, v) * 0.10 - shut * 1.0 - chip * 0.45
            + panelF(u, v) * 0.05;
          out[1] = chip; out[2] = shut; out[3] = low; out[4] = filmF(u, v);
        },
        shade(u, v, c, m, out) {
          const chip = m[0], shut = m[1], low = m[2], film = m[3];
          // Clear dies where the sun hits hardest, which on a parked car is the
          // horizontal — approximated by the panel field, not by noise alone.
          const ox = clamp01(smoothstep(0.42, 0.88, oxF(u, v)) * 0.8 + c.edge * 0.35);
          let r = mix(BODY[0], BODY_OX[0], ox);
          let g = mix(BODY[1], BODY_OX[1], ox);
          let b = mix(BODY[2], BODY_OX[2], ox);

          // Road film: a neutral grey-brown wash climbing the lower panel, with
          // its own upper edge. This is the tide line every dirty car has.
          const grime = clamp01(low * (0.30 + film * 0.9) - 0.18) * 0.9;
          r = mix(r, C_DIRT[0] * 1.35, grime * 0.55);
          g = mix(g, C_DIRT[1] * 1.33, grime * 0.56);
          b = mix(b, C_DIRT[2] * 1.28, grime * 0.56);

          // A chip goes clear -> colour -> primer -> steel, and the rust starts
          // at its edge. Primer is the pale ring that makes a chip read as a
          // chip rather than as a dark speck.
          const prim = smoothstep(0.15, 0.55, chip);
          const bare = smoothstep(0.62, 0.90, chip);
          r = mix(r, 0.130, prim); g = mix(g, 0.126, prim); b = mix(b, 0.120, prim);
          r = mix(r, C_RUST[0] * 0.8, bare); g = mix(g, C_RUST[1] * 0.8, bare); b = mix(b, C_RUST[2] * 0.8, bare);

          const seam = clamp01(shut + c.cavity * 0.5);
          r *= 1 - seam * 0.45; g *= 1 - seam * 0.47; b *= 1 - seam * 0.48;

          out[0] = r; out[1] = g; out[2] = b;
          // Clean clear is the glossiest surface in the level; oxidised clear
          // and road film are not. This spread is the whole material.
          out[3] = clamp(0.10 + ox * 0.46 + grime * 0.34 + prim * 0.35 + bare * 0.45, 0.06, 1.0);
          // Base coat and clear are both dielectric. Only a chip through to the
          // panel is a conductor, and only briefly before it rusts.
          out[4] = clamp01(bare * (1 - smoothstep(0.75, 0.95, chip)));
          out[5] = 1;
        },
      };
    },
  },

  /* =========================================================== enamel sign */
  /*
   * The other half of the LevelModule TODO. A vitreous-enamel shopfront sign is
   * the one surface in a street that is ALLOWED to be a pure saturated colour
   * — it is fired glass on steel, it does not fade, and it is why photographs
   * of markets have chroma in them that the surrounding masonry does not.
   *
   * It is a wayfinding tool as much as a material: a sign is small, bright and
   * always at a doorway, so three lanes signed in three colours give a player
   * something to navigate by in a level whose walls are necessarily all the
   * same render. That is the intended use here; the recipe is cheap enough to
   * carry three tints of the same bake.
   */
  sign_enamel: {
    label: 'Vitreous enamel sign',
    description: 'Fired enamel on pressed steel: rolled edge, screw fixings, star-chipped to bare metal with rust haloes, glass-smooth everywhere else.',
    tags: ['prop', 'signage', 'accent'],
    minSize: 256, reliefM: 0.003, masks: 3,
    aoStrength: 0.9, curvGain: 1.2,
    detail: 'brushed', detailMetres: 0.08, detailStrength: 0.12, detailAlbedo: 0.08,
    macro: 0.08, macroHue: 0.35, triplanar: false, worldScale: 1.0,
    paintable: true,
    build(seed, opts = {}) {
      const M = metrics(opts, 1.0);
      const FACE = paintOf(opts) || srgb(0.13, 0.30, 0.44);   // enamel blue
      const TRIM = paintOf(opts, 'trim') || srgb(0.88, 0.87, 0.83);
      // Border inset in metres; enamel signs are always framed in the second
      // colour and the frame is most of what identifies them at 20 m.
      const borderF = M.f(opts.borderM ?? 0.035);
      const chipC = worley(seed + 211, M.per(0.014, 5), 1.0);
      const rustF = fbm01(seed + 212, M.per(0.10, 7), 3, 0.6);
      const dustF = fbm01(seed + 213, M.per(0.22, 8), 3, 0.55);
      // Four fixings, one per corner, set inside the rolled edge.
      const scrR = 0.008 / M.ws;                    // 16 mm pan head
      const scrInset = borderF * 1.6;
      const cA = new Cell();
      return {
        sample(u, v, out) {
          const dEdge = Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v));
          // Rolled edge: the sheet turns over, so the outer few millimetres are
          // proud and the border line is a shallow score, not a colour change.
          const roll = smoothstep(borderF * 1.4, borderF * 0.2, dEdge);
          const score = 1 - smoothstep(borderF * 0.06, borderF * 0.30, Math.abs(dEdge - borderF));

          // Distance to the nearest corner fixing: fold the tile into its own
          // quadrant, then measure from the inset point in that quadrant.
          const qu = Math.min(u, 1 - u) - scrInset;
          const qv = Math.min(v, 1 - v) - scrInset;
          const screw = smoothstep(scrR * 1.25, scrR * 0.35, Math.hypot(qu, qv));

          chipC(u, v, cA);
          // Enamel does not scratch, it SHATTERS — a star chip with a hard rim,
          // clustered at the edges and the fixings where the sheet flexes.
          const prone = clamp01(roll * 0.9 + screw * 0.8 + 0.06);
          const chip = smoothstep(0.16, 0.02, cA.f1) * (cA.rand(9) < prone * 0.55 ? 1 : 0);

          out[0] = roll * 0.30 - score * 0.35 - screw * 0.45 - chip * 0.55;
          out[1] = chip; out[2] = roll; out[3] = screw;
        },
        shade(u, v, c, m, out) {
          const chip = m[0], roll = m[1], screw = m[2];
          const border = smoothstep(0.35, 0.65, roll);
          let r = mix(FACE[0], TRIM[0], border);
          let g = mix(FACE[1], TRIM[1], border);
          let b = mix(FACE[2], TRIM[2], border);

          // Under the enamel is the steel it was fired onto, and the rust
          // spreads out of the chip rather than sitting inside it.
          const bare = smoothstep(0.25, 0.60, chip);
          const halo = smoothstep(0.05, 0.40, chip) * clamp01(0.4 + rustF(u, v));
          r = mix(r, C_RUST[0], halo * 0.7); g = mix(g, C_RUST[1], halo * 0.7); b = mix(b, C_RUST[2], halo * 0.7);
          r = mix(r, C_RUST_DARK[0], bare); g = mix(g, C_RUST_DARK[1], bare); b = mix(b, C_RUST_DARK[2], bare);
          r = mix(r, C_STEEL[0] * 0.55, screw * 0.7);
          g = mix(g, C_STEEL[1] * 0.55, screw * 0.7);
          b = mix(b, C_STEEL[2] * 0.55, screw * 0.7);

          // Street dust, and only in the cavities: an enamel face sheds it.
          const dust = clamp01(c.cavity * 0.8 + dustF(u, v) * 0.25 - 0.15);
          r = mix(r, C_DIRT[0] * 1.5, dust * 0.40);
          g = mix(g, C_DIRT[1] * 1.5, dust * 0.41);
          b = mix(b, C_DIRT[2] * 1.5, dust * 0.41);

          out[0] = r; out[1] = g; out[2] = b;
          // Fired glass. This is deliberately the smoothest dielectric in the
          // library — the sign's job is to be the one hard highlight in a lane
          // of matte render, and that contrast is what makes it findable.
          out[3] = clamp(0.09 + bare * 0.75 + halo * 0.40 + dust * 0.30, 0.05, 1.0);
          out[4] = clamp01(screw * 0.6 + bare * 0.25 * (1 - halo));
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
    macro: 0.12, macroHue: 0.52, triplanar: false, worldScale: 1.0,
    paintable: true,
    build(seed, opts = {}) {
      const M = metrics(opts, 1.0);
      // Optional coat over the galvanising. A painted roller shutter is the
      // largest single flat colour on a market street and the one a player
      // navigates by; unpainted, this recipe stays bare zinc.
      const COAT = paintOf(opts);
      const COAT_SUN = COAT ? faded(COAT, 1, 0.48) : null;
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
          let coat = 0;
          if (COAT) {
            // Paint survives in the valleys and is scoured off the crowns —
            // the opposite of where the rust starts, which is why a painted
            // sheet reads as ribbed at a distance where the profile itself has
            // gone below a pixel.
            // Coverage is high by default and comes OFF at the crowns and the
            // arrises — a shutter is painted all over and wears through where
            // it is handled and where the roller drags it, not in half.
            // Measured: at the first cut (a 0.25 floor rising to 1.0 in the
            // valleys) the zinc phase is four times the paint's reflectance and
            // won the mean outright, so the sheet baked out at saturation 0.04
            // and read as galvanised with a blue cast. Bare metal on a painted
            // object has to be a minority phase by AREA and by LUMINANCE both.
            coat = clamp01(0.94 - crown * 0.22 - c.edge * 0.75);
            const sun = clamp01(crown * 0.8 + facet * 0.25);
            r = mix(r, mix(COAT[0], COAT_SUN[0], sun), coat);
            g = mix(g, mix(COAT[1], COAT_SUN[1], sun), coat);
            b = mix(b, mix(COAT[2], COAT_SUN[2], sun), coat);
          }
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
          out[3] = clamp(mix(mix(0.42 + facet * 0.14, 0.66 + facet * 0.10, coat), 0.93, rusted), 0.18, 1.0);
          // Zinc is a conductor; the oxide that replaces it is not, and neither
          // is paint. Coverage subtracts from the conductor phase exactly as
          // the oxide does.
          out[4] = clamp01((1 - ox) * (1 - coat));
          out[5] = 1;
        },
      };
    },
  },

  /* ================================================================== sand */
  /* ==================================================================== sand
   *
   * This recipe is a third of almost every frame on this map, and through two
   * rounds of review it was the flattest thing in the image. Measured off its
   * own bake, the previous version delivered an 8-bit albedo standard deviation
   * of 7 out of 255 — a 3% surface — and the frame agreed with it: a 540x260
   * crop of near ground in the round-2 capture came back at sd 7.2 with a mean
   * horizontal gradient of 1.4 code values. That is not a soft material, it is
   * no material.
   *
   * Two separate causes, both fixed here.
   *
   * 1. THE RELIEF BUDGET WAS SPENT ON THE WRONG BAND. `reliefM` is a total, and
   *    the dune/crest terms took 0.55 + 0.95 of the height field against the
   *    ripple train's 0.16. So 90 mm of the 90 mm went into features with a
   *    1.1-1.6 m period — which at a 2 m tile is one and a half bumps, i.e. a
   *    gentle undulation with no shading contrast at all — and the band a
   *    player standing on it actually reads was left with a couple of
   *    millimetres. Broad drift is the terrain mesh's job, not the normal
   *    map's. The dune term is now a fifth of what it was, the ripple train and
   *    the gravel lag own the budget, and reliefM comes down to 60 mm to match
   *    a real 90 mm-pitch ripple.
   *
   * 2. THE ALBEDO HAD NOTHING IN IT. "The only real variable is moisture" is
   *    true of a laboratory sand sample and false of ground people walk on.
   *    What is actually there, in ascending scale: individual coarse grains and
   *    chips, a gravel lag left behind where the fines have blown out, wind
   *    sorting into alternating coarse and fine patches at a third of a metre,
   *    and damp scour hollows. Four bands, all of them inside the range a
   *    single 2 m tile can hold, and every one of them carries VALUE, not just
   *    a nudge of the same tan.
   *
   * The damp end is also pulled toward a cool grey rather than a darker tan.
   * Wet sand in shade is lit by sky, and the frame was criticised for being one
   * hue at two brightnesses; the ground is the largest single surface available
   * to fix that with.
   */
  sand: {
    label: 'Wind-rippled sand over gravel lag',
    description: '90 mm ripple train, deflation lag of 20-50 mm gravel, wind sorting into coarse and fine patches at a third of a metre, damp scour hollows.',
    tags: ['ground', 'terrain'],
    minSize: 512, reliefM: 0.060, masks: 5,
    aoStrength: 1.05, curvGain: 0.95,
    detail: 'grain', detailMetres: 0.06, detailStrength: 0.72, detailAlbedo: 0.80,
    // Ground has no straight lines in it, so it is the one family that can take
    // a projection warp — and it is the family that needs it most, because a
    // flat plane shows a tile lattice from further away than a facade does.
    macro: 0.30, macroHue: 0.55, warpTiles: 0.26,
    triplanar: true, worldScale: 2.0,
    build(seed, opts = {}) {
      const M = metrics(opts, 2.0);
      const RIPPLES = M.count(0.090, 3);           // 90 mm wind ripples
      const dune = fbm(seed + 61, M.per(1.6, 8), 3, 0.55);
      const warp = fbm(seed + 62, M.per(0.50, 8), 2, 0.5);
      const grain = fbm(seed + 63, M.per(0.004, 8), 2, 0.5);
      const lag = worley(seed + 64, M.per(0.045, 6), 1.0);   // deflation gravel
      const chip = worley(seed + 68, M.per(0.014, 4), 1.0);  // coarse grains/chips
      const drift = fbm01(seed + 65, M.per(0.85, 8), 3, 0.6);
      // Wind sorting: the single most useful band on this surface. Alternating
      // coarse (dark, grey, matt) and fine (pale, warm) patches at 0.3 m is
      // what a sand sheet actually looks like from standing height.
      const sort = fbm01(seed + 69, M.per(0.30, 8), 3, 0.58);
      const scour = fbm01(seed + 70, M.per(0.45, 8), 3, 0.55);
      const cA = new Cell(), cB = new Cell();
      return {
        sample(u, v, out) {
          // Ripples are a phase-modulated train, not a sine: crests are sharp
          // and troughs broad because that is how saltation piles it.
          const dn = dune(u, v) * 0.12;
          const ph = v * RIPPLES + warp(u, v) * 2.2 + dn * 6.0;
          const s = 0.5 + 0.5 * Math.cos(ph * Math.PI * 2);
          const ripple = s * s * Math.sqrt(s) * 0.5 + s * s * 0.5;   // ~pow(s,1.7)
          const cover = smoothstep(0.30, 0.62, drift(u, v));
          const sorted = sort(u, v);
          // Coarse patches are where the lag sits; the ripple train needs fines
          // to exist at all, so the two are mutually exclusive by construction.
          const coarse = smoothstep(0.44, 0.72, sorted);
          const hollow = smoothstep(0.42, 0.78, scour(u, v));

          lag(u, v, cA);
          chip(u, v, cB);
          // Ellipsoid caps, not gaussians: a real edge for the curvature pass.
          const stone = Math.sqrt(clamp01(1 - cA.f1 / (0.30 + cA.rand(4) * 0.16)))
            * (cA.rand(5) > 0.46 ? 1 : 0) * (0.35 + coarse * 0.65);
          const grit = Math.sqrt(clamp01(1 - cB.f1 / 0.34)) * (cB.rand(6) > 0.55 ? 1 : 0);

          out[0] = dn
            + ripple * 0.40 * cover * (1 - coarse * 0.55)
            + stone * 0.34
            + grit * 0.11
            + grain(u, v) * 0.05
            - hollow * 0.10;
          out[1] = stone;
          out[2] = ripple * cover;
          out[3] = coarse;
          out[4] = hollow;
          out[5] = cB.rand(7);
        },
        shade(u, v, c, m, out) {
          const stone = m[0], ripple = m[1], coarse = m[2], hollow = m[3], chipRnd = m[4];

          // Base tone. `c.h` is the normalised height field, so this alone
          // already reads the ripple train and the lag as value.
          const t = 0.78 + c.h * 0.42;
          let r = C_SAND[0] * t, g = C_SAND[1] * t, b = C_SAND[2] * t;

          // Wind sorting. Coarse patches have lost their fines and sit a good
          // 25% darker and markedly greyer; fine patches are the pale warm
          // blown sand that drifted in on top.
          r = mix(r, mix(r, C_STONE[0] * 0.92, 0.55), coarse);
          g = mix(g, mix(g, C_STONE[1] * 0.92, 0.55), coarse);
          b = mix(b, mix(b, C_STONE[2] * 0.94, 0.58), coarse);
          const fine = (1 - coarse) * (0.45 + ripple * 0.55);
          r = mix(r, r * 1.20 + 0.014, fine * 0.5);
          g = mix(g, g * 1.17 + 0.012, fine * 0.5);
          b = mix(b, b * 1.11 + 0.008, fine * 0.5);

          // Damp. Wet sand is roughly 45% of its dry reflectance and it goes
          // COOL, not simply dark — in shade the only thing lighting it is the
          // sky. This is the ground's contribution to getting some colour
          // separation into a frame that reads as one hue at two brightnesses.
          const damp = clamp01(hollow * 0.85 + c.cavity * 0.55);
          r = mix(r, C_SAND_DARK[0] * 0.80, damp * 0.72);
          g = mix(g, C_SAND_DARK[1] * 0.86, damp * 0.72);
          b = mix(b, C_SAND_DARK[2] * 1.14, damp * 0.74);

          // Sun-baked crust on the crests.
          const dry = c.edge * 0.40;
          r = mix(r, r * 1.16 + 0.012, dry);
          g = mix(g, g * 1.14 + 0.010, dry);
          b = mix(b, b * 1.10 + 0.007, dry);

          // Lag gravel. A real spread of stone types, not one grey: some
          // ironstone-dark, some pale limestone. This is the band that gives
          // the ground something to read at 1-3 m.
          const st = 0.48 + hash2f((u * 4096) | 0, (v * 4096) | 0, 7) * 0.95;
          const sr = st > 1.0 ? C_STONE[0] * st : mix(C_DIRT[0], C_STONE[0], st);
          const sg = st > 1.0 ? C_STONE[1] * st : mix(C_DIRT[1], C_STONE[1], st);
          const sb = st > 1.0 ? C_STONE[2] * st * 1.04 : mix(C_DIRT[2], C_STONE[2] * 1.04, st);
          r = mix(r, sr, stone); g = mix(g, sg, stone); b = mix(b, sb, stone);

          // Individual coarse grains, half a pixel across at 512 — they read as
          // grit rather than as resolvable stones, which is the point.
          const gk = (chipRnd - 0.5) * 0.30 * (0.35 + coarse * 0.65);
          r *= 1 + gk; g *= 1 + gk * 0.96; b *= 1 + gk * 0.88;

          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(0.95 - stone * 0.24 - damp * 0.16 + coarse * 0.03, 0.42, 1.0);
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
    macro: 0.16, macroHue: 0.54, triplanar: true, worldScale: 1.0,
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
          // Crushed stone is not one grey at a range of exposures — a bed of it
          // is a mix of rock types, and the value spread between them is the
          // whole reason gravel reads as gravel from six feet away. Scaling one
          // colour gave an 8-bit albedo sigma of 9; a bimodal split between a
          // dark basaltic fraction and a pale limestone one roughly doubles it
          // for the cost of one extra mix.
          const dark = tint < 0.38 ? 1 : 0;
          const t = dark ? (0.42 + tint * 0.55) : (0.78 + (tint - 0.38) * 1.05);
          let r = mix(C_STONE[0], C_DIRT[0] * 1.5, dark * 0.55) * t;
          let g = mix(C_STONE[1], C_DIRT[1] * 1.5, dark * 0.55) * t;
          let b = mix(C_STONE[2], C_DIRT[2] * 1.6, dark * 0.52) * t;
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
    macro: 0.15, macroHue: 0.50, triplanar: true, worldScale: 1.2,
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
    macro: 0.14, macroHue: 0.50, triplanar: false, worldScale: 1.1,
    paintable: true,
    build(seed, opts = {}) {
      const M = metrics(opts, 1.1);
      // Painted joinery. Paint on wood does NOT recolour the timber — it sits
      // on it as a coat and fails off it, so the shutter that reads as painted
      // is the one where the grain shows through at the arrises and along the
      // splits. Board-to-board variation is deliberate: joinery is repainted a
      // board at a time and never twice from the same tin.
      const COAT = paintOf(opts);
      const COAT_SUN = COAT ? faded(COAT, 1, 0.46) : null;
      const peelN = COAT ? fbm01(seed + 107, M.per(0.22, 8), 3, 0.62) : null;
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
          let rough = 0.78 + ring * 0.10 + bleach * 0.10 - knot * 0.30;
          if (COAT) {
            // Coverage: paint survives on the flats, lifts off the arrises and
            // the raised grain, and is gone in the board gaps. `rnd` is the
            // per-board hash, so one board in a run is always noticeably more
            // worn than its neighbours.
            const wear = clamp01(smoothstep(0.35, 0.90, c.edge) * (0.45 + peelN(u, v) * 1.1)
              + smoothstep(0.86, 0.99, peelN(u, v)) * 0.7
              + ring * 0.22 * (0.6 + rnd * 0.8));
            const cover = clamp01(1 - smoothstep(0.34, 0.72, wear)) * (1 - gap);
            // Fade is per board plus a slow field, so a repainted board next to
            // a sun-killed one is normal rather than a bug.
            const sun = clamp01(0.20 + rnd * 0.55 + peelN(u, v) * 0.35);
            const cr = mix(COAT[0], COAT_SUN[0], sun);
            const cg = mix(COAT[1], COAT_SUN[1], sun);
            const cb = mix(COAT[2], COAT_SUN[2], sun);
            // Primer ghost under a chip: the coat's own value, near-neutral.
            const edgeChalk = smoothstep(0.55, 0.95, wear) * (1 - cover) * 0.35;
            r = mix(r, cr, cover); g = mix(g, cg, cover); b = mix(b, cb, cover);
            const chalk = 0.30;
            r = mix(r, chalk, edgeChalk); g = mix(g, chalk * 0.98, edgeChalk); b = mix(b, chalk * 0.94, edgeChalk);
            // Alkyd joinery paint is satin when new and chalks flat as it goes.
            rough = mix(rough, 0.46 + sun * 0.34, cover);
          }
          const shade = c.cavity * 0.55 + gap;
          r *= 1 - shade * 0.45; g *= 1 - shade * 0.46; b *= 1 - shade * 0.46;
          out[0] = r; out[1] = g; out[2] = b;
          out[3] = clamp(rough, 0.30, 1.0);
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
    macro: 0.13, macroHue: 0.50, triplanar: false, worldScale: 0.76,
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
    paintable: true,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.6);
      // Glaze colour. A glazed threshold, stall counter or fountain surround is
      // the one place in a street where a genuinely saturated colour is not a
      // stylistic choice but a building material, and a tiled doorstep is worth
      // more to wayfinding than any amount of noise: it is small, it is bright,
      // and it marks the entrance the player is looking for.
      //
      // `accent` is a second glaze; tiles pick between the two on their own
      // hash, which is how a real field of tile is laid.
      const GLAZE = paintOf(opts) || C_TILE;
      const ACCENT = paintOf(opts, 'accent');
      const accentMix = opts.accentMix ?? 0.28;
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
          // Tile-to-tile firing variation is multiplicative on the glaze, so a
          // strong colour varies in value without wandering in hue — which is
          // how a fired batch actually varies.
          const useAcc = ACCENT && rnd < accentMix;
          const G = useAcc ? ACCENT : GLAZE;
          let r = G[0] * t, g = G[1] * t, b = G[2] * t;
          // A chip goes through the glaze to the biscuit, which is unfired clay
          // — pale and warm whatever colour the glaze was.
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
    paintable: true,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.6);
      // Dyed duck. `paint` is the dye; `stripe` (a second colour) turns it into
      // the woven awning stripe that is the single most recognisable object in
      // a market street, and the stripe is a WEAVE feature, so it runs along
      // the warp and the dye sits in the thread rather than on top of it.
      // `stripeM` is the band pitch in metres — awnings run 90-160 mm.
      const DYE = paintOf(opts) || C_CANVAS;
      const STRIPE = paintOf(opts, 'stripe');
      const stripeM = opts.stripeM ?? 0.12;
      const BANDS = STRIPE ? Math.max(2, Math.round(M.ws / Math.max(0.02, stripeM))) : 0;
      // Cloth hung outdoors is the fastest-fading thing in the level: the top
      // of an awning is close to white by its second summer while the shadowed
      // underside keeps the dye. That difference is the reason cloth reads as
      // cloth at 30 m and it is worth two colour constants.
      const DYE_SUN = faded(DYE, 1, 0.55, 0.34);   // cloth is the fastest fader here
      const STRIPE_SUN = STRIPE ? faded(STRIPE, 1, 0.55, 0.34) : null;
      const sunF = fbm01(seed + 155, M.per(0.30, 8), 3, 0.6);
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
          // Which colour this thread carries. The band edge is deliberately
          // soft over one thread pitch — a woven stripe has no hard edge, it
          // has a transition thread, and a hard one is what makes a procedural
          // stripe read as a decal.
          let base = DYE, baseSun = DYE_SUN;
          if (BANDS) {
            // Thresholded sine rather than a test on the band index. The index
            // form is the obvious way to write this and it is wrong at the
            // seam: feathering "toward the edge" inside each band sends the two
            // sides of a boundary toward OPPOSITE colours, so every band edge
            // came out as a one-thread line of the wrong dye. A sine has no
            // seam to get wrong — it wraps by construction — and the threshold
            // width is the transition thread.
            const which = smoothstep(-0.10, 0.10, Math.sin(u * BANDS * Math.PI * 2));
            base = [mix(DYE[0], STRIPE[0], which), mix(DYE[1], STRIPE[1], which), mix(DYE[2], STRIPE[2], which)];
            baseSun = [mix(DYE_SUN[0], STRIPE_SUN[0], which), mix(DYE_SUN[1], STRIPE_SUN[1], which), mix(DYE_SUN[2], STRIPE_SUN[2], which)];
          }
          const sun = clamp01(smoothstep(0.25, 0.85, sunF(u, v)) * 0.7 + c.edge * 0.4);
          let r = mix(base[0], baseSun[0], sun) * t;
          let g = mix(base[1], baseSun[1], sun) * t;
          let b = mix(base[2], baseSun[2], sun) * t;
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
  /*
   * NOT THE VIEWMODEL RECEIVER ANY MORE. `receiver_phosphate` at the bottom of
   * this file is, and it is authored specifically for a surface held 300 mm
   * from the eye and for the x1.90 roughness multiplier the viewmodel applies.
   *
   * This recipe stays because the LEVEL uses it (`LevelModule.M.chrome`) for
   * props seen at two to ten metres, where its 20 mm forging form and its 3%
   * conductor speckle are the right call and its texel budget is a tenth of the
   * viewmodel's. Retuning it for the gun would have degraded those props, which
   * belong to another agent; splitting the two uses is the whole reason
   * `Gunsmith.preset` looks the weapon presets up by name.
   *
   * DO NOT "FIX" THIS RECIPE'S ROUGHNESS. Measured in Node on the current tree:
   * at the level's x1.0 it bakes a mean of 0.585, sd 0.071, unimodal — a
   * perfectly reasonable prop steel. At the viewmodel's x1.90 the same bytes
   * become 97.7% top-decile with a 2.3% tail, which is the binary gloss mask
   * every review of the weapon has been describing. The defect was the pairing,
   * not this recipe, and the pairing no longer exists on any live path. Changing
   * the numbers here now only moves the level's props.
   */
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
          // Shallower dings. `ding` feeds the height field, the height field
          // drives curvature, and curvature drives BOTH the wear mask and the
          // cavity term that darkens the albedo. At 0.55 a ding was a crater
          // more than half as deep as the entire forging relief, so it printed
          // a hard dark disc into the albedo. A holster ding is a bruise in a
          // conversion coating, not a hole.
          out[0] = forge(u, v) * 0.62 + mach * 0.07 - ding * 0.26;
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
          //
          // THE ALBEDO IS ALMOST FLAT, AND THAT IS THE POINT. This is the fix
          // for the "blue digital camo" the last two reviews named, and it is
          // an albedo defect, not a lighting one — measured off the bake, the
          // previous version had a standard deviation of 21 code values out of
          // 255 on a mean of 67. That is a 46-88 swing, near enough 4x in
          // linear reflectance, laid down in ~20 mm patches by the height
          // field's forging and ding terms. Multiply a patchwork like that by
          // a blue sky IBL — which is most of what a matte black dielectric
          // shows — and you get blue-grey blobs at roughly 15 px on a receiver
          // held 500 mm from the eye. That is a camouflage print, and no amount
          // of retiling or AO scaling removes it, because it is IN the colour.
          //
          // A phosphate conversion coating is one of the most uniform surfaces
          // on a rifle: it is a chemical film, not paint, and its variation is
          // sheen, not value. So the height tint drops from +-9% to +-4% and
          // the fouling from 34% to 15%. What still separates this from flat
          // grey is the roughness channel and the polished arrises, which is
          // where a real receiver's read comes from anyway.
          const t = 0.95 + c.h * 0.08;
          let r = mix(C_PARKER[0] * t, C_WORN[0], bare);
          let g = mix(C_PARKER[1] * t, C_WORN[1], bare);
          let b = mix(C_PARKER[2] * t, C_WORN[2], bare);

          // Carbon fouling in the recesses; keeps it from reading as clean CAD.
          // Warm-biased: soot on gunmetal kills the blue first, which also
          // stops the recesses reading as sky-coloured holes.
          const foul = c.cavity * 0.7;
          r *= 1 - foul * 0.13; g *= 1 - foul * 0.15; b *= 1 - foul * 0.17;

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

  /* ========================================================================
   * ===================================================== WEAPON SURFACES ==
   * ========================================================================
   *
   * WHY THESE EXIST AS SEPARATE RECIPES, AND WHAT THEY MUST CARRY.
   *
   * `Gunsmith.weaponMaterials` asks the library for five presets by name —
   * `receiver_phosphate`, `rail_anodised`, `barrel_nitride`,
   * `furniture_polymer`, `grip_rubber` — and falls back to `gunmetal` /
   * `polymer` / `rubber` plus a compensating *shim* when the library has not
   * published them. Publishing them here takes the direct branch, and
   * `Gunsmith.preset` deliberately DROPS THE SHIM when it does, because the
   * shim's whole job was to bend the wrong recipe into roughly the right
   * shape. So each recipe below has to stand on its own. Concretely, the shim
   * used to supply, and these recipes now supply for themselves:
   *
   *   rail    a 0.20 m bake scale + a repeat correction  -> worldScale below
   *           a 0.62 grey colour multiplier              -> C_ANODISE
   *           `metalness: 0` (DIELECTRIC)                -> out[4] = 0
   *           `aoMapIntensity: 0.22`                     -> aoStrength 0.14
   *   barrel  a 0.26 m bake scale + a repeat correction  -> worldScale below
   *           `metalness: 0.62`, `roughness: 0.46`       -> out[4]/out[3]
   *           `envMapIntensity: 1.75`                    -> C_NITRIDE F0
   *           `aoMapIntensity: 0.22`                     -> aoStrength 0.12
   *
   * The receiver, furniture and grip keep their caller options (those live in
   * `opts`, not in the shim) — including the receiver's ROUGHNESS x1.90, which
   * these recipes are authored against; see `receiver_phosphate`.
   *
   * -------------------------------------------------------------------------
   * AUTHORING FRAME: worldScale IS THE ON-SCREEN SIZE OF ONE TILE.
   *
   * The merged viewmodel body is projected at one UV scale for every slot
   * (`BODY_TILE` = 0.35 m per UV unit), and each slot gets its own metres-per-
   * tile only by tiling its texture. So the metres a tile actually covers ON
   * THE GUN is `BODY_TILE / repeat`, and every recipe below sets its
   * `worldScale` to exactly that number:
   *
   *   slot        caller repeat            worldScale = 0.35/repeat   texels
   *   receiver    2.4                      0.1458 m       1024 ->  0.14 mm
   *   rail        1 (shim dropped)         0.35   m        512 ->  0.68 mm
   *   barrel      1 (shim dropped)         0.35   m        512 ->  0.68 mm
   *   furniture   2.4 x 0.85  = 2.04       0.1716 m        512 ->  0.34 mm
   *   grip        (0.35/0.5) x 2.4 x 1.6   0.1302 m        512 ->  0.25 mm
   *              = 2.688
   *
   * The payoff is that a millimetre written in one of these recipes is a
   * millimetre on the weapon. Every previous attempt at this surface reasoned
   * about feature size through a stack of three multiplied correction factors,
   * and every review since has called the result a pattern.
   *
   * IF THE CALLER'S `repeat` CHANGES, THESE `worldScale` VALUES MUST CHANGE
   * WITH IT. That is the one coupling this arrangement buys its clarity with.
   *
   * -------------------------------------------------------------------------
   * WHAT THE SCREEN CAN ACTUALLY RESOLVE.
   *
   * At full ADS the receiver spans ~600 px for ~180 mm of part, i.e. 3.3 px per
   * millimetre. That sets the whole feature budget:
   *
   *   > 20 mm   66+ px   MUST BE FLAT. Any contrast in this band is a printed
   *                      pattern; this is the band every "digital camouflage"
   *                      review has been pointing at.
   *   5-20 mm   16-66 px process form — forging flow, contact bands. Low
   *                      contrast, no hard edges.
   *   1-5 mm    3-16 px  THE IDENTITY BAND. Cutter scallops, mould stipple,
   *                      pebble grain. This is what says "machined" or
   *                      "moulded" rather than "generated".
   *   < 1 mm    < 3 px   Belongs in the shader detail normal, which is
   *                      resolution-independent — never in the bake, where it
   *                      is either aliasing or wasted texels.
   *
   * The rail and the barrel sit at 0.68 mm per texel, so their bakes carry NO
   * albedo feature under ~3 mm at all; their close-range character is delivered
   * entirely by the `brushed` detail normal, which runs at the same on-screen
   * frequency as the receiver's and therefore hides the 5x texel-density step
   * between the two parts.
   *
   * -------------------------------------------------------------------------
   * THE MEASUREMENT THAT DROVE ALL OF THIS.
   *
   * The receiver's visible pattern was never in the albedo. Baked at full
   * resolution the previous `gunmetal` measured an 8-bit albedo sd of 6.4 on a
   * mean of 65 — a 10% surface, genuinely flat. Its ARM map is where the
   * pattern lives:
   *
   *   roughness, after the caller's x1.90:  96.4% of texels in the top decile,
   *                                         2.2% at 0.30-0.40, nothing between.
   *
   * That is a BINARY GLOSS MASK. 96% of the receiver is clipped to dead matte
   * and a 2% population of isolated, curvature-thresholded islands is the only
   * thing in the frame reflecting the sky. On a 0.05-albedo surface those
   * islands are 10-20x the local diffuse, so they render as hard bright specks
   * scattered over near-black — which is what a 8x crop of the round-3 capture
   * shows, and which is exactly how a camouflage print is constructed.
   *
   * That measurement was re-run from scratch on the current tree, in Node,
   * against the live recipe objects rather than a screenshot: `gunmetal` baked
   * at 1024 and multiplied by 1.90 still lands 97.7% of its texels in the top
   * decile with a 2.3% tail and a hole between, so the diagnosis was right and
   * it is reproducible. It is also NOT what the weapon renders any more —
   * `gunmetal` is only the fallback for this slot and `receiver_phosphate`
   * below is what the game takes. Note that the same recipe is well behaved at
   * the multiplier the LEVEL calls it with (mean 0.585 at x1.0, unimodal): the
   * pathology was never in `gunmetal` alone, it was in `gunmetal` x 1.90.
   *
   * Hence the three rules every recipe below follows:
   *
   *  1. NO THRESHOLDED WEAR. Every wear term is a continuous ramp. `smoothstep`
   *     appears only to shape a *zone*, never to decide whether a texel is worn.
   *  2. WEAR IS ANCHORED TO PROCESS GEOMETRY, NOT TO NOISE. The coating thins
   *     on the crests of the cutter marks, inside the bands a hand and a sling
   *     actually touch. Both of those are directional and both run along the
   *     part, so what survives at 3 px reads as a satin sheen with a grain
   *     direction — not as a field of dots, which has no direction at all and
   *     is therefore indistinguishable from print.
   *  3. THE FIELD HAS TO LIVE WHERE A GGX LOBE EXISTS. Removing the clipping is
   *     necessary and not sufficient: a continuous ramp that sits entirely
   *     above roughness 0.85 renders as flat plastic just as reliably as a
   *     clipped one, because the specular peak goes as 1/alpha^2 = 1/r^4 and by
   *     0.9 it has fallen under the diffuse it is sitting on. The revision
   *     before this one had 0% clipping and 82.7% of the receiver above 0.80,
   *     and it was still the flattest-looking part on the gun. Every slot's
   *     mean and range are now stated in the table at the top of this file, and
   *     they are measured, not intended.
   */

  /* ================================================ receiver: phosphated */
  receiver_phosphate: {
    label: 'Receiver, manganese phosphate',
    description: 'Forged and machined receiver under a matte phosphate conversion coating: 3 mm fly-cutter scallops, bead-blast micro, and hand/sling contact bands that burnish the coating to a satin sheen along the part.',
    tags: ['weapon', 'viewmodel'],
    // 0.22 mm of relief is roughly 15x what a real cutter scallop measures, and
    // the exaggeration is deliberate: at 0.14 mm per texel an honest 15 um mark
    // produces a normal deviation of about one 8-bit code value, i.e. it is
    // quantised out of existence. The choice is an exaggerated mark or no mark.
    // It is also bounded — the first pass at this used 0.35 mm, which over a
    // 3 mm pitch is a 13 degree flank, i.e. corrugated sheet rather than a
    // machined flat. 0.22 mm keeps the marks under 3 degrees, which reads as a
    // fine grain at ADS and disappears into the mip chain at hip.
    minSize: 512, reliefM: 0.00022, masks: 5,
    // A conversion coating over a machined flat occludes essentially nothing,
    // and the AO channel is the second-largest contributor to the patterning:
    // it multiplies indirect diffuse, which under a sky is most of what this
    // surface returns. The caller already holds it at 0.22 intensity; keeping
    // the baked field near white as well means the two cannot compound.
    aoStrength: 0.14, curvGain: 1.0,
    // detailScale = 0.1458 / 0.0065 = 22.4 tiles per base tile, so one detail
    // tile is 0.35 / (2.4 x 22.4) = 6.5 mm on the gun and the `brushed` map's
    // 24 streaks across it land at a 0.27 mm pitch — bead-blast and draw-mark
    // scale, below what the bake could ever hold. detailAlbedo is pulled right
    // down from the 0.55 default: a machined surface's micro is GLOSS, and a
    // +-27% albedo swing at 1 px is the definition of sparkle.
    detail: 'brushed', detailMetres: 0.0065, detailStrength: 0.42, detailAlbedo: 0.16,
    macro: 0, triplanar: false, worldScale: 0.1458,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.1458);
      // 3 mm fly-cutter/broach scallops. Resolution-capped via `per`, so the
      // coarse stages of the refine ladder degrade to a soft ripple rather than
      // to aliasing. Lines of constant v, i.e. running ALONG the part — u is the
      // weapon's long axis in the merged body's projection.
      const MACH = M.per(0.003, 6);
      const CHAT = M.per(0.012, 6);              // cutter chatter, 12 mm
      const flow = fbm(seed + 181, M.per(0.045, 10), 2, 0.5);   // forging flow
      const blast = fbm(seed + 182, M.per(0.0011, 5), 2, 0.5);  // bead blast
      // Contact bands. Sampled at (u, v*3) so the field is three times shorter
      // across the part than along it: 16 mm wide bands running fore-and-aft,
      // which is where a firing hand, a sling and a plate carrier actually rub.
      // The integer 3 matters — a fractional stretch would break tiling.
      const zoneN = fbm01(seed + 183, M.per(0.055, 8), 3, 0.55);
      const foulN = fbm01(seed + 184, M.per(0.028, 8), 3, 0.6);
      const dingC = worley(seed + 185, M.per(0.009, 6), 1.0);
      // Long-wave sheen. A phosphated flat is not uniform in GLOSS even where it
      // is uniform in colour: the coating grows thicker and coarser where the
      // part was cooler in the bath, and every hour of handling since has
      // levelled some of that off. Two octaves at 75 mm, sampled at (u, v*2) so
      // it is 75 mm along the part and 37 mm across it — a soft directional
      // gradient, not a blob field. It is deliberately the WEAKEST of the four
      // gloss terms (0.14 of the span, i.e. 0.06 of rendered roughness); its job
      // is to stop a whole flat sitting at one exact value, and anything
      // stronger at this frequency is the patch camouflage this file's header
      // spends a page on.
      const sheenN = fbm01(seed + 186, M.per(0.075, 8), 2, 0.5);
      const cA = new Cell();
      return {
        sample(u, v, out) {
          // Phase-jittered so it does not read as corduroy, amplitude-modulated
          // by the chatter so consecutive cutter passes differ slightly. Both
          // are what a real fly-cut flat does and both cost one multiply.
          const chat = Math.cos(v * CHAT * Math.PI * 2 + flow(u, v) * 2.2);
          const mach = Math.cos(v * MACH * Math.PI * 2 + flow(u, v) * 1.7)
            * (0.78 + chat * 0.22);
          dingC(u, v, cA);
          // Handling dings: rare, shallow, and a bruise in a coating rather
          // than a hole. Kept at ~4% of cells so they are punctuation.
          const ding = smoothstep(0.075, 0.02, cA.f1) * (cA.rand(21) > 0.955 ? 1 : 0);
          // Weights, in the order they matter. The cutter marks lead, because
          // the fine periodic band has to own the height field — curvature and
          // AO are both derived from it, and whichever band owns it owns the
          // wear mask and the occlusion too. But they do not own it OUTRIGHT:
          // a receiver is bead-blasted before it is coated, and blasting mostly
          // erases the mill marks. At 0.46/0.15 the surface came out as pure
          // corduroy; at 0.40/0.22 the marks show *through* a blasted field,
          // which is what a phosphated receiver actually looks like and which
          // also stops the whole part reading as one brushed wrap.
          out[0] = mach * 0.40 + chat * 0.09 + blast(u, v) * 0.22
            + flow(u, v) * 0.11 - ding * 0.20;
          out[1] = zoneN(u, v * 3);
          out[2] = mach * 0.5 + 0.5;             // cutter crest, 0..1 continuous
          out[3] = ding;
          out[4] = foulN(u, v);
          out[5] = sheenN(u, v * 2);             // long-wave gloss, 0..1 continuous
        },
        shade(u, v, c, m, out) {
          const zoneRaw = m[0], crest = m[1], ding = m[2], foulRaw = m[3];
          const sheenRaw = m[4];

          // Where the gun is HELD. A zone, so smoothstep is legitimate here —
          // it decides the extent of a contact band, never whether an
          // individual texel is worn.
          const contact = smoothstep(0.46, 0.80, zoneRaw);
          // Inside a contact band the coating polishes off the crests of the
          // cutter marks first, and it does it gradually. `crest` is the ripple
          // itself, so `burnish` is a continuous 3 mm gradient with a direction,
          // not a thresholded island. That single change is what turns a field
          // of specular dots into a directional satin sheen.
          //
          // The weights matter as much as the shape. `contact` only GATES; the
          // swing is carried by `crest`, so nearly all of the gloss variance
          // sits at the 3 mm cutter pitch and only the envelope sits at the
          // 16-50 mm band size. Measured on the bake, that puts the roughness
          // sd at 26 in the 2 mm band against 9 in the 36 mm band — a surface
          // with a grain, rather than a surface with patches.
          const burnish = clamp01(contact * (0.10 + crest * 1.08));

          // Albedo does almost nothing, and that is correct. A phosphate coat is
          // a chemical film: its variation is sheen, not value. +-2.5% from the
          // height field, at most a 1.4x lift where it is burnished through.
          const t = 0.975 + c.h * 0.05;
          let r = mix(C_PHOSPHATE[0] * t, C_PHOS_BURNISH[0], burnish * 0.55);
          let g = mix(C_PHOSPHATE[1] * t, C_PHOS_BURNISH[1], burnish * 0.55);
          let b = mix(C_PHOSPHATE[2] * t, C_PHOS_BURNISH[2], burnish * 0.55);

          // Combustion residue collects in the scallop troughs and around the
          // port. Warm-biased, because soot on gunmetal kills the blue first and
          // a recess on this weapon has no business reading as a sky-coloured
          // hole.
          const foul = clamp01(c.cavity * 0.5 + foulRaw * 0.30 - 0.10);
          r = mix(r, C_CARBON[0], foul * 0.30);
          g = mix(g, C_CARBON[1], foul * 0.32);
          b = mix(b, C_CARBON[2], foul * 0.34);

          out[0] = r; out[1] = g; out[2] = b;

          /* ---------------------------------------------------------------
           * ROUGHNESS. Read this before changing a number in it.
           *
           * AUTHORED AGAINST THE VIEWMODEL'S x1.90 MULTIPLIER. Gunsmith sets
           * `material.roughness = 1.90` on this slot and the shader computes
           * `roughness * armMap.g`, so every value below is pre-divided:
           * multiply by 1.90 to get what renders. Nothing here may exceed
           * 0.526, which is where the product clips to 1.0.
           *
           * WHAT WAS WRONG, MEASURED. Two generations of this channel have
           * failed in opposite directions and both produced "no specular":
           *
           *  gen 1 (`gunmetal`)  96.4% of texels in the top decile after the
           *        multiplier, 2.2% at 0.30-0.40, NOTHING between. A binary
           *        gloss mask: a dead-matte field with a sparse population of
           *        curvature-thresholded islands as the only thing reflecting
           *        the sky, which on a 0.05-albedo surface is 10-20x the local
           *        diffuse — i.e. a camouflage print built in the ARM map.
           *
           *  gen 2 (this recipe, previous revision)  the thresholding was gone
           *        — 0% clipped, a continuous ramp — but the whole ramp sat at
           *        the matte end. Baked at 1024 and measured after x1.90:
           *        mean 0.875, sd 0.108, 82.7% of the area above roughness
           *        0.80 and 64.2% above 0.90. A GGX lobe at alpha = r^2 = 0.9
           *        peaks at F0/(pi*alpha^2) ~ 0.005 against a diffuse of
           *        albedo/pi = 0.0153, so the specular was ~30% of the local
           *        diffuse AT THE CENTRE OF THE HIGHLIGHT. There was no
           *        highlight to see. The receiver also came out MATTER than
           *        the rail (0.851), which the rail's own comment calls the
           *        flattest surface on the weapon.
           *
           * WHAT REPLACES IT. `polish` is a WEIGHTED AVERAGE of four terms
           * whose weights sum to exactly 1, so it is in [0,1] by construction
           * and no clamp is needed to keep it there. That matters: a clamp on
           * a sum of gloss terms is how you get a flat plateau at the floor,
           * and a plateau is a thresholded island wearing a ramp's clothes.
           *
           *   0.30 crest    the 3 mm cutter ripple. Continuous, directional,
           *                 and the largest single term — the grain is what
           *                 says "machined" at 3 px per millimetre.
           *   0.34 burnish  hand / sling / holster contact. Already crest-
           *                 weighted, so it deepens the same grain rather
           *                 than laying a second field over it.
           *   0.22 arris    `c.edge`, the curvature ramp. A machined arris is
           *                 the first thing to burnish and the last thing to
           *                 hold coating. Used raw and continuous — the ramp
           *                 is the whole point, a threshold here is gen 1.
           *   0.14 sheen    the 75 mm long-wave field; see `sheenN`.
           *
           * The rendered result, MEASURED on the bake (identical at 512 and at
           * 1024, so the refine ladder converges rather than shifting):
           *
           *   polish 0    0.445 -> 0.846   fresh coating, sheltered, matte
           *   mean        0.380 -> 0.722   a broad soft sheen across a flat
           *   observed min        -> 0.410 burnished arris inside a contact
           *                                band: satin, ~6x its own diffuse
           *   observed max        -> 0.879 fouled recess
           *   sd                  ->  0.08 84% of the area under 0.80,
           *                                0% clipped, unimodal, no gap
           *
           * Where that variance sits, by spatial band (sd of the field minus
           * its own box blur): 0.051 under 2 mm, 0.074 under 6 mm, 0.080
           * total. So 92% of the gloss variance is finer than 6 mm and only
           * 0.006 of it is coarser than 40 mm — a grain, not a patch field.
           * That ratio is the acceptance criterion for this channel, not the
           * mean: gen 1's failure was a patch field, and a patch field with a
           * correct mean is still a camouflage print.
           *
           * At 0.722 the specular peak is ~0.96x the local diffuse, so the
           * flats brighten by about a stop where the key reflects and fall
           * away smoothly — a sheen with a direction, which is what phosphate
           * over a machined flat does. The barrel stays the only HARD
           * highlight on the weapon (0.34) and the grip the only dead surface
           * (0.89); the receiver now sits between them instead of next to the
           * grip.
           *
           * On top of all of this the shader adds +-0.07 of detail-map micro
           * before the multiplier (SurfaceShader `sfDetail.z`, fixed at 0.14
           * and not forwarded from here), i.e. +-0.133 rendered at the 0.27 mm
           * bead-blast pitch. That is the fine grain riding the field, and it
           * is only visible at all because the field itself is no longer
           * pinned against 1.0.
           * --------------------------------------------------------------- */
          const arris = c.edge;
          const polish = 0.30 * crest + 0.34 * burnish + 0.22 * arris
            + 0.14 * sheenRaw;
          // The clamp is a guard, not a shaper: the expression's own range is
          // 0.220..0.500 and neither bound is reachable from inside it.
          out[3] = clamp(0.445 - polish * 0.245 + foul * 0.045 - ding * 0.015,
            0.19, 0.52);

          // NO CONDUCTOR MASK, ANYWHERE. Phosphate is a dielectric conversion
          // coating and it wears by burnishing, not by stripping; the fraction
          // that is genuinely bare metal on a service weapon is well under 1%
          // and it reads through gloss, which is above. A thresholded metalness
          // map on a magnified surface is the documented origin of the
          // sky-coloured blocks — the viewmodel forces `metalness: 0` for that
          // reason, and this recipe agrees with it rather than fighting it.
          out[4] = 0;
          out[5] = 1 - ding * 0.12;
        },
      };
    },
  },

  /* ================================================== rail / handguard shell */
  rail_anodised: {
    label: 'Rail, type-III hard anodising',
    description: 'Extruded 6061 under a hardcoat anodic oxide: darker and much rougher than the receiver, longitudinal die flow, corner scuffs to oxide dust, and no bright-steel wear anywhere because there is no steel and no coating to wear through.',
    tags: ['weapon', 'viewmodel'],
    minSize: 256, reliefM: 0.00040, masks: 4,
    // aoMapIntensity is 1.0 on this slot now that the shim is gone, so the
    // baked AO has to be near white on its own or it comes back as the same
    // ~20 mm blotch field that started this whole investigation.
    aoStrength: 0.10, curvGain: 1.0,
    // 0.35 / 0.016 = 21.9 detail tiles per base tile -> a 16 mm detail tile with
    // the brushed map's streaks landing at 0.67 mm. This is the ONLY thing
    // carrying sub-3 mm character on this slot, by design: at 0.68 mm per texel
    // the bake cannot hold anything finer without aliasing it.
    detail: 'brushed', detailMetres: 0.016, detailStrength: 0.50, detailAlbedo: 0.12,
    macro: 0, triplanar: false, worldScale: 0.35,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.35);
      // Die flow: the broad longitudinal banding an extrusion carries, three
      // times longer along the part than across it. 25 mm across, ~75 mm along.
      const flowF = fbm(seed + 191, M.per(0.025, 8), 3, 0.55);
      // 4 mm die lines. Right at the resolution floor (5.8 texels) and no
      // finer — anything below this belongs to the detail normal.
      const LINE = M.per(0.004, 6);
      const scuffN = fbm01(seed + 192, M.per(0.030, 8), 3, 0.6);
      const grimeN = fbm01(seed + 193, M.per(0.050, 8), 3, 0.55);
      return {
        sample(u, v, out) {
          const flow = flowF(u, v * 3);
          const line = Math.cos(v * LINE * Math.PI * 2 + flow * 2.4) * 0.5 + 0.5;
          // THE DIE LINES DOMINATE THE HEIGHT FIELD, NOT THE FLOW. Curvature and
          // AO are both derived from this field, so whichever band owns it also
          // owns the wear mask and the occlusion. Letting the 25 mm flow term
          // dominate is precisely how a rail ends up wearing a 25 mm blotch
          // field in its AO channel — which is the mechanism behind every
          // "digital camouflage" review this weapon has collected. Measured on
          // the bake: with the weights this way round the AO sd above 10 mm is
          // 3.9 out of 255; with them the other way it was 9.8.
          out[0] = line * 0.55 + flow * 0.22;
          out[1] = scuffN(u, v * 2);
          out[2] = grimeN(u, v);
          // The die lines and the die flow are carried through to `shade` so the
          // ROUGHNESS channel can use them. Previously they existed only in the
          // height field, which is why this slot baked at an almost constant
          // gloss — measured sd 0.028 over the whole part. A rail is extruded
          // through a polished die and then anodised: the flats that ran against
          // the die land are slicker than the ones that did not, and that
          // difference runs the length of the part.
          out[3] = line;
          // 25 mm x 75 mm die-flow banding, remapped to 0..1. Costs no extra
          // noise evaluation — `flow` is already computed for the height field.
          out[4] = flow * 0.5 + 0.5;
        },
        shade(u, v, c, m, out) {
          const scuffN = m[0], grimeN = m[1], line = m[2], flowSheen = m[3];

          // Anodising does NOT polish to bright metal. It is a ceramic oxide
          // grown INTO the aluminium, roughly 50 um thick, and when something
          // drags across a corner hard enough it powders and takes a little of
          // the substrate with it. So the wear colour is a grey-brown dust,
          // about 2x the coating, and there is no conductor phase at any point
          // in the part's life. This is the single clearest way to make the rail
          // read as a different process from the receiver next to it: same
          // family of darkness, completely different wear behaviour.
          const scuff = clamp01(c.edge * (0.30 + scuffN * 0.85) * 0.85);

          const t = 0.97 + c.h * 0.06;
          let r = mix(C_ANODISE[0] * t, C_ANODISE_SCUFF[0], scuff * 0.45);
          let g = mix(C_ANODISE[1] * t, C_ANODISE_SCUFF[1], scuff * 0.45);
          let b = mix(C_ANODISE[2] * t, C_ANODISE_SCUFF[2], scuff * 0.45);

          // A rail is a dust and carbon trap — slots, gaps, screw heads.
          const grime = clamp01(c.cavity * 0.6 + grimeN * 0.35 - 0.12);
          r = mix(r, C_CARBON[0], grime * 0.34);
          g = mix(g, C_CARBON[1], grime * 0.35);
          b = mix(b, C_CARBON[2], grime * 0.36);

          out[0] = r; out[1] = g; out[2] = b;
          // No caller multiplier on this slot, so these are the rendered values.
          //
          // Hardcoat is the flattest METAL on the weapon — a porous oxide
          // scatters most of what hits it, which is why a rail looks dull next
          // to a barrel even though both are near-black. But "flattest" was
          // being rendered as "featureless": the previous revision was a
          // constant 0.86 with a scuff term that only reached the corners, and
          // it measured sd 0.028 across the whole part, i.e. no specular
          // structure at all. Anodised aluminium is satin, not chalk.
          //
          // Same construction as the receiver: `polish` is a weighted average
          // whose weights sum to 1, so it cannot leave [0,1] and the clamp
          // below never shapes anything. The die lines lead, because a
          // directional 4 mm grain is what tells the eye this part was extruded
          // rather than moulded, and because a term at that pitch cannot become
          // a patch field. The span is deliberately half the receiver's: this
          // slot has to stay visibly the duller of the two.
          //
          //   polish 0   -> 0.860   die valley, unscuffed oxide
          //   mean       -> 0.803   satin hardcoat (measured, sd 0.039)
          //   observed             0.718 .. 0.886, 0% clipped
          //   + grime    -> 0.910   dust-packed slot (ceiling, unreached)
          const polish = 0.46 * line + 0.30 * scuff + 0.24 * flowSheen;
          out[3] = clamp(0.86 - polish * 0.17 + grime * 0.05, 0.55, 0.97);
          // Al2O3 is a dielectric. Not "mostly"; entirely.
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },

  /* ================================================ barrel / gas block / can */
  barrel_nitride: {
    label: 'Barrel, QPQ nitride',
    description: 'Turned and salt-bath nitrided steel: the only conductor on the weapon and the only part with a hard moving highlight, near-black, carbon-loaded toward the muzzle.',
    tags: ['weapon', 'viewmodel'],
    minSize: 256, reliefM: 0.00025, masks: 2,
    aoStrength: 0.10, curvGain: 1.0,
    detail: 'brushed', detailMetres: 0.016, detailStrength: 0.26, detailAlbedo: 0.08,
    macro: 0, triplanar: false, worldScale: 0.35,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.35);
      // Turning marks. A lathe leaves a helix, which on an unrolled cylinder is
      // a fine line set — 5 mm here, and the sub-millimetre reality goes to the
      // detail normal as with the rail.
      const TURN = M.per(0.005, 6);
      const runout = fbm(seed + 201, M.per(0.040, 8), 2, 0.5);
      const sootN = fbm01(seed + 202, M.per(0.060, 8), 3, 0.6);
      return {
        sample(u, v, out) {
          const turn = Math.cos(v * TURN * Math.PI * 2 + runout(u, v) * 1.4) * 0.5 + 0.5;
          // Same rule as the rail: the fine periodic band owns the height field
          // so the derived AO and curvature stay at the turning pitch instead of
          // becoming a 40 mm blotch field.
          out[0] = turn * 0.55 + runout(u, v) * 0.25;
          out[1] = sootN(u, v * 2);
          out[2] = turn;
        },
        shade(u, v, c, m, out) {
          const sootN = m[0], turn = m[1];

          // CONDUCTOR, UNIFORMLY. This is the one part of the weapon where
          // metalness 1 is correct, and it is safe here precisely because it is
          // a CONSTANT: the failure mode this file keeps warning about is a
          // *thresholded* conductor mask, which paints sky-coloured islands
          // wherever the curvature field happens to be under-resolved. A uniform
          // 1 cannot do that. What controls how bright the barrel gets is F0 —
          // see C_NITRIDE — not the metalness channel.
          const soot = clamp01(sootN * 0.7 + c.cavity * 0.5 - 0.20);
          const t = 0.94 + c.h * 0.11;
          let r = mix(C_NITRIDE[0] * t, C_CARBON[0], soot * 0.55);
          let g = mix(C_NITRIDE[1] * t, C_CARBON[1], soot * 0.55);
          let b = mix(C_NITRIDE[2] * t, C_CARBON[2], soot * 0.56);

          out[0] = r; out[1] = g; out[2] = b;
          // The glossiest surface on the weapon by a wide margin — a measured
          // mean of 0.34 against the receiver's 0.72, the rail's 0.80 and the
          // grip's 0.88. That contrast is the whole read: a barrel carries a
          // highlight that travels along it as the weapon moves, and nothing
          // else on the gun does. Carbon deadens it toward the muzzle, which is
          // the only reason the value moves at all.
          //
          // The gap is now a gap between four live surfaces rather than between
          // one glossy part and three matte ones, and it did not need widening
          // to stay legible: this slot is untouched by the specular pass that
          // rewrote the other four, because it was the only one that already
          // had a lobe.
          out[3] = clamp(0.30 + soot * 0.26 - turn * 0.03, 0.20, 0.68);
          out[4] = 1;
          out[5] = 1;
        },
      };
    },
  },

  /* ============================================== stock / grip / magazine */
  furniture_polymer: {
    label: 'Furniture, glass-filled nylon',
    description: 'Injection-moulded polyamide: a regular 1.8 mm tool stipple, a parting line off the mould halves, glass fibre breaking the skin, and a satin sheen that goes glossy only where a hand rides.',
    tags: ['weapon', 'viewmodel'],
    minSize: 256, reliefM: 0.00090, masks: 4,
    // The caller runs this slot at aoMapIntensity 0.44 — twice the metal slots,
    // because a 1 mm moulded stipple genuinely does self-shadow. Measured off
    // the old `polymer` bake, 25% of texels sat below AO 0.4, and at 0.44
    // intensity that is the pale checker visible on the magazine face in the
    // round-3 capture. The stipple keeps its occlusion; the low-frequency part
    // of the field does not.
    aoStrength: 0.28, curvGain: 1.1,
    detail: 'pit', detailMetres: 0.0075, detailStrength: 0.45, detailAlbedo: 0.20,
    macro: 0, triplanar: false, worldScale: 0.1716,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.1716);
      // 1.8 mm tool stipple: 5.4 texels per cell, which is the smallest cell
      // this slot can hold without it turning into a dither.
      const stip = worley(seed + 211, M.per(0.0018, 5), 1.0);
      const flowF = fbm(seed + 212, M.per(0.035, 8), 3, 0.5);   // mould flow
      const fibreC = worley(seed + 213, M.per(0.0026, 5), 1.0, 3.2);
      const wearN = fbm01(seed + 214, M.per(0.030, 8), 3, 0.6);   // contact field
      const seamW = fbm(seed + 215, M.per(0.060, 8), 2, 0.5);
      const cA = new Cell(), cB = new Cell();
      return {
        sample(u, v, out) {
          stip(u, v, cA);
          // Truncated pyramids, flat-topped and hard-edged: an EDM-textured
          // tool prints a facet, not a dome. That flat top is why moulded nylon
          // has a sheen at all and why it is not just "rough plastic".
          const pyr = Math.min(1, clamp01(1 - cA.f1 / 0.30) * 1.7);
          fibreC(u, v, cB);
          const fibre = smoothstep(0.20, 0.04, cB.f1) * (cB.rand(17) > 0.66 ? 1 : 0);
          // The parting line where the two mould halves met: one flashed ridge
          // running along the part, 1.4 mm wide because that is four texels at
          // this slot's density and a physically honest 0.4 mm one would be a
          // single texel of dashed noise. The most unambiguous "this was
          // moulded rather than machined" cue available, and it costs two lines.
          const sy = v + seamW(u, v) * 0.02;
          const seam = smoothstep(0.004, 0.0, Math.abs(sy - 0.5));
          out[0] = pyr * 0.42 + flowF(u, v) * 0.10 + fibre * 0.05 + seam * 0.16;
          out[1] = pyr; out[2] = fibre; out[3] = wearN(u, v * 4); out[4] = seam;
        },
        shade(u, v, c, m, out) {
          const pyr = m[0], fibre = m[1], wearN = m[2], seam = m[3];
          const t = 0.965 + c.h * 0.07;
          let r = C_FURNITURE[0] * t, g = C_FURNITURE[1] * t, b = C_FURNITURE[2] * t;

          // Glass fibre ends breaking the moulded skin — the one thing that
          // stops a black polymer part being a flat colour swatch in a
          // photograph. Held to a 1.35x lift: the previous recipe used 2.1x,
          // which at 0.34 mm per texel is a one-pixel sparkle, i.e. the same
          // defect as the receiver's specular speckle in a different channel.
          r = mix(r, r * 1.35, fibre * 0.6);
          g = mix(g, g * 1.35, fibre * 0.6);
          b = mix(b, b * 1.34, fibre * 0.6);

          // Hands ride the grip and the magwell, and what they do to nylon is
          // polish the flat tops of the stipple. Same weighting rule as the
          // receiver, and for the same measured reason: `contact` only GATES,
          // the swing is carried by `pyr`, so the gloss variance lives at the
          // 1.8 mm stipple pitch instead of forming 30-50 mm clouds. Rendered
          // as a roughness map, those clouds are indistinguishable from the
          // camouflage this whole exercise is about — the first version of this
          // recipe had them and they are plainly visible in a dump of the
          // channel. The contact field is stretched 4:1 along the part on top
          // of that, so what is left of the envelope is a band, not a blob.
          const contact = smoothstep(0.44, 0.82, wearN);
          const burnish = clamp01(contact * (0.08 + pyr * 1.05));
          r = mix(r, r * 1.18, burnish); g = mix(g, g * 1.18, burnish); b = mix(b, b * 1.19, burnish);
          r *= 1 - c.cavity * 0.16; g *= 1 - c.cavity * 0.17; b *= 1 - c.cavity * 0.17;

          out[0] = r; out[1] = g; out[2] = b;
          // Satin, and clearly duller than the barrel but clearly glossier than
          // the rail — three parts, three specular registers. The seam is a
          // touch glossier than the field because it is skin that never touched
          // the textured part of the tool.
          //
          // `pyr` is weighted at 0.10 rather than 0.05 because the flat tops of
          // an EDM stipple are the ONLY reason moulded nylon has a specular
          // read at all: the tool's texture is a facet field, and a facet
          // reflects while the draft between facets does not. At 0.05 the
          // channel measured sd 0.031 across the part, so the stipple existed
          // in the normal map and nowhere else and the part rendered as one
          // even satin wash. This is the same grain-not-patches rule the
          // receiver's roughness block sets out, applied at the 1.8 mm pitch
          // this slot's identity lives on.
          out[3] = clamp(0.62 - burnish * 0.20 - seam * 0.10 - pyr * 0.10
            + fibre * 0.12 + c.cavity * 0.06, 0.26, 0.86);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },

  /* ============================================== grip panels / butt pad */
  grip_rubber: {
    label: 'Grip overmould, elastomer',
    description: 'Moulded santoprene overmould: 1.6 mm diamond pebble from the tool, dead matte, dust in the pores, and a low satin only on the crowns a palm has worked.',
    tags: ['weapon', 'viewmodel'],
    minSize: 256, reliefM: 0.00110, masks: 2,
    aoStrength: 0.30, curvGain: 1.0,
    detail: 'pit', detailMetres: 0.0057, detailStrength: 0.55, detailAlbedo: 0.25,
    macro: 0, triplanar: false, worldScale: 0.1302,
    build(seed, opts = {}) {
      const M = metrics(opts, 0.1302);
      const peb = worley(seed + 221, M.per(0.0016, 5), 1.0);
      const micro = fbm(seed + 222, M.per(0.0007, 6), 2, 0.5);
      const wearN = fbm01(seed + 223, M.per(0.028, 8), 3, 0.6);
      const cA = new Cell();
      return {
        sample(u, v, out) {
          peb(u, v, cA);
          const pebble = Math.pow(clamp01(1 - cA.f1 / 0.33), 0.55);
          out[0] = pebble * 0.52 + micro(u, v) * 0.12;
          out[1] = pebble; out[2] = wearN(u, v * 4);
        },
        shade(u, v, c, m, out) {
          const pebble = m[0], wearN = m[1];
          const t = 0.955 + c.h * 0.09;
          let r = C_OVERMOULD[0] * t, g = C_OVERMOULD[1] * t, b = C_OVERMOULD[2] * t;
          // A palm polishes the pebble crowns and packs dust into the valleys
          // between them. Both are continuous in the pebble field, so the whole
          // story sits at 1.6 mm — the frequency the eye reads as *grain*.
          const contact = smoothstep(0.42, 0.82, wearN);
          const polish = clamp01(contact * (0.07 + pebble * 1.05));
          r = mix(r, r * 1.22, polish); g = mix(g, g * 1.22, polish); b = mix(b, b * 1.23, polish);
          const dust = c.cavity * 0.7;
          r = mix(r, C_DIRT[0] * 0.55, dust * 0.22);
          g = mix(g, C_DIRT[1] * 0.55, dust * 0.22);
          b = mix(b, C_DIRT[2] * 0.56, dust * 0.22);
          out[0] = r; out[1] = g; out[2] = b;
          // The most matte surface on the weapon, which is what stops the grip
          // and the polymer furniture next to it reading as one moulding. It
          // stays matte — an elastomer overmould has no gloss to speak of and
          // giving it one would undo the separation — but the pebble crowns get
          // a small continuous term of their own so the 1.6 mm grain is present
          // in the specular even outside a contact band. Everything a palm has
          // NOT touched was previously one flat value.
          out[3] = clamp(0.90 - polish * 0.20 - pebble * 0.05 + dust * 0.04,
            0.55, 0.98);
          out[4] = 0;
          out[5] = 1;
        },
      };
    },
  },
};

/* --------------------------------------------------------------- aliases */

/** Names other modules may reasonably reach for, mapped onto a real recipe. */
/* --------------------------------------------------------------- palettes */

/**
 * COLOUR AS WAYFINDING.
 *
 * Suq al-Hadid has three lanes and, measured, they are the same colour: every
 * saturated surface in the level sits in a 40-degree warm window, so a player
 * standing in one lane has nothing in frame that says which lane it is. That is
 * a navigation problem before it is an art problem — a map where every corridor
 * looks identical is a map players get lost in, and the fix is not more detail,
 * it is a different colour at the end of each one.
 *
 * These are coat colours for the `paintable` recipes, chosen against the map's
 * constraints rather than off a wheel:
 *
 *  - They must survive a WARM KEY. This sun is low and orange, which multiplies
 *    every surface toward red and kills weak greens and blues outright, so the
 *    lane hues are picked far from the light's hue and carry enough chroma to
 *    still be reading after it. A pastel would come back as sand.
 *  - They must separate from EACH OTHER at low value. The captured frames sit
 *    at a median value near 0.2, so the three are spread around the wheel
 *    (~185, ~130, ~10 degrees) rather than being three blues.
 *  - There are three of them and no more. The point of an accent is that the
 *    field around it is neutral; a fourth and a fifth lane colour would put the
 *    level back where it started with a wider gamut.
 *
 * Usage: pass as `paint` (or as `material.color`, which routes to the same
 * place). `signage` is the loud one and belongs on the small enamel objects at
 * doorways; `joinery` and `shutter` are the same family knocked back, for the
 * large areas. Do NOT paint a whole facade in these — that is what
 * `plaster`'s `washStrength` limewash is for.
 */
export const ACCENTS = {
  /** North / alley: cold teal against the warmest light in the level. */
  alley: {
    signage: 0x1d7d8c,     // enamel, ~188 deg, the findable one
    joinery: 0x2f6f78,     // doors and shutters
    shutter: 0x24606b,     // roller shutters, corrugated
    cloth: 0x35707a,       // awning stripe partner
    vehicle: 0x2f5d7a,
  },
  /** East / motor yard: bottle green. Furthest from both the sun and the teal. */
  yard: {
    signage: 0x1f6b4a,     // ~150 deg
    joinery: 0x3d6b3c,
    shutter: 0x33583a,
    cloth: 0x4a7048,
    vehicle: 0x2e5c3f,
  },
  /** South / plaza: red oxide. Warm, but far enough round to read as a colour
   *  rather than as more sand, and it is the traditional paint here. */
  plaza: {
    signage: 0xa8332a,     // ~5 deg
    joinery: 0x8e3b30,
    shutter: 0x7a352c,
    cloth: 0xa8523c,
    vehicle: 0x8c2f26,
  },
  /** Shared, lane-independent. Glazed thresholds and the cream that every
   *  awning stripe and enamel border in this part of the world is paired with. */
  common: {
    tileGlaze: 0x2e6d84,
    tileAccent: 0xd9c9a0,
    trim: 0xe0d8c4,
    biscuit: 0xc9a878,
  },
};

export const ALIASES = {
  car: 'car_paint',
  vehicle: 'car_paint',
  sign: 'sign_enamel',
  enamel: 'sign_enamel',
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
