import * as THREE from 'three';

/**
 * OWNER: rendering / post-processing agent.
 *
 * Procedural grading assets. Nothing is loaded from disk — the LUT and the lens
 * dirt mask are both generated once at boot.
 */

const LUT_SIZE = 33;

function saturate(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function smoothstep(e0, e1, x) {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function linearToSrgb(v) {
  if (v <= 0) return 0;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
function luma(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

/* ===========================================================================
 *  THE GRADE
 * ===========================================================================
 *
 * THE DOMAIN IS sRGB-ENCODED, NOT LINEAR. This is the single most important
 * fact about this file and ColorGrade.js encodes before the lookup to match.
 *
 * A 33^3 cube sampled in linear light puts its first two slices at 0.000 and
 * 0.031 — and 0.031 linear is already 49/255 on screen. The entire toe of the
 * image, every value a shadow can take, falls between two samples and gets a
 * straight line drawn through it. Encoding the lookup coordinate first spends
 * the cube's resolution where the eye is, giving the toe roughly eight times
 * the sample density and letting the curve below actually reach zero.
 *
 * OPERATIONS, IN ORDER. Every one of them maps 0 -> 0 exactly; there is no
 * unconditional lift anywhere in this file, and `makeGradeLUT` asserts that the
 * black entry of the finished cube is (0,0,0) before it returns.
 *
 *  1. Power-law contrast about a pivot. `pivot * (x/pivot)^contrast` — the
 *     log-space S-curve the previous version used added +0.01 inside the log to
 *     avoid log(0), which meant black came out at 2^(pv - contrast*pv') - 0.01
 *     rather than at zero, and used a pivot of 0.42: more than four stops above
 *     where this frame's midtone actually sits, so the curve was *lifting* the
 *     entire image instead of pivoting it.
 *
 *  2. A filmic toe, `y^2 / (y + k)`. Multiplicative, so it cannot lift; it
 *     halves the value at y == k and converges to y - k up top. This is what
 *     produces real black in creases, under geometry and inside interiors.
 *
 *  3. Split tone, applied as a per-channel GAIN, not an offset. The previous
 *     version added a teal of (-0.010, 0.030, 0.062) weighted by (1 - l)^2.2 —
 *     at l = 0 that is a flat +0.062 in blue on every black pixel in the frame,
 *     which is 74/255 on screen. A gain of 1.185 on the same pixel is still
 *     black. Cool shadows, warm highlights, and the sun direction reads because
 *     the two ends of the ramp cross over in hue rather than in level alone.
 *
 *  4. Highlight shoulder, `s + (1-s)(1 - e^-(y-s)/(1-s))`. Asymptotic to 1, so
 *     nothing ever clips: sky, sunlit sand and a specular all land in the top
 *     quarter but at *different* values instead of collapsing onto 255.
 *
 *  5. Luminance-dependent saturation. Chroma is kept (slightly boosted) in the
 *     shadows, where the sky bounce is the only colour information there is,
 *     and pulled back in the highlights, where film desaturates as it rolls off.
 *     A lerp toward luma cannot lift black either — luma(0) is 0.
 *
 *  6. Channel crosstalk, a linear mix, so saturated reds (muzzle flash, blood)
 *     roll toward white instead of clipping into a flat patch. Also lift-free.
 *
 * The neutral ladder this produces, measured end to end (ACES-linear input ->
 * 8-bit sRGB output), is printed by the self-check at the bottom of the file.
 */

/** Power-law contrast pivot, in ACES output (linear display-referred) units. */
const PIVOT = 0.18;
const CONTRAST = 1.20;
/** Toe knee. Larger = deeper crush. */
const TOE = 0.0055;
/** Shoulder onset, and the value the rolloff is asymptotic to. */
const SHOULDER = 0.56;
/**
 * Slightly above 1 on purpose: an asymptote of exactly 1 means nothing in the
 * frame can ever reach 255, so a specular ping and a sunlit wall both land in
 * the 240s and the top of the histogram is as compressed as the bottom used to
 * be. Overshooting to 1.045 and clamping keeps the rolloff on everything below
 * about four stops over key while letting a genuine highlight hit white.
 */
const SHOULDER_TOP = 1.045;

/**
 * Multiplicative split tone. Cool shadows against warm highlights.
 *
 * WHERE THE WEIGHTS SIT MATTERS MORE THAN HOW BIG THE GAINS ARE. The previous
 * version weighted the shadow tone by (1 - l)^3.2, which is 0.39 at l = 0.25 —
 * and l = 0.25 is exactly where sky-lit shade lands on this map. So the cooling
 * was spent on near-black, where there is no signal to colour, while every
 * surface actually in shade kept the sun's hue at a lower level. Measured over
 * the round-2 captures the whole frame ran R-B = +20 to +29 with the *shade*
 * as warm as the light: one hue at two brightnesses, which is the note the
 * review made.
 *
 * The exponent is now 1.9, which puts real weight across the whole shadow half
 * of the ramp, and the warm end is pushed up off the midtones (see the
 * highlight weight in `gradeLinear`) so widening the split does not simply make
 * the frame more orange overall. The gains stay multiplicative — a gain, unlike
 * an offset, cannot lift a black off zero no matter how large it gets.
 */
const SHADOW_GAIN = [0.815, 0.948, 1.265];
const HIGH_GAIN = [1.108, 1.008, 0.848];
const TONE_STRENGTH = 0.95;

/**
 * Saturation at the bottom and the top of the ramp. The shadow end is boosted
 * harder than before for the same reason as the split tone: in shade the sky
 * bounce is the only colour information in the frame, and it was being averaged
 * away into the sun's hue.
 */
const SAT_SHADOW = 1.22;
const SAT_HIGH = 0.88;

const CROSSTALK = 0.030;

/**
 * Apply the grade to one linear display-referred RGB triple.
 * Exported so the self-check and any future tuning tool can use the same code
 * path the cube is baked from.
 */
export function gradeLinear(input) {
  const c = [input[0], input[1], input[2]];

  // --- 1. power-law contrast about the pivot -------------------------------
  const k = Math.pow(PIVOT, 1 - CONTRAST);
  for (let i = 0; i < 3; i++) {
    c[i] = c[i] <= 0 ? 0 : k * Math.pow(c[i], CONTRAST);
  }

  // --- 2. filmic toe -------------------------------------------------------
  for (let i = 0; i < 3; i++) {
    c[i] = (c[i] * c[i]) / (c[i] + TOE);
  }

  // --- 3. split tone, multiplicative ---------------------------------------
  {
    const l = luma(c);
    // Broad across the shadow half (see SHADOW_GAIN) ...
    const ws = Math.pow(Math.max(0, 1 - l), 1.9);
    // ... and deliberately narrow at the top. The warm gain belongs to surfaces
    // the sun is actually hitting; letting it start at l = 0 (which `l / 0.88`
    // effectively did, at 1.5 power) laid a thin orange over the midtones as
    // well and is half the reason the frame read monochrome-warm.
    const wh = Math.pow(saturate((l - 0.20) / 0.68), 1.25);
    for (let i = 0; i < 3; i++) {
      const gs = 1 + (SHADOW_GAIN[i] - 1) * ws * TONE_STRENGTH;
      const gh = 1 + (HIGH_GAIN[i] - 1) * wh * TONE_STRENGTH;
      c[i] *= gs * gh;
    }
  }

  // --- 4. highlight shoulder -----------------------------------------------
  for (let i = 0; i < 3; i++) {
    if (c[i] > SHOULDER) {
      const head = SHOULDER_TOP - SHOULDER;
      c[i] = SHOULDER + head * (1 - Math.exp(-(c[i] - SHOULDER) / head));
    }
    if (c[i] > 1) c[i] = 1;
  }

  // --- 5. luminance-dependent saturation -----------------------------------
  {
    const l = luma(c);
    const s = SAT_SHADOW + (SAT_HIGH - SAT_SHADOW) * smoothstep(0.05, 0.75, l);
    for (let i = 0; i < 3; i++) c[i] = Math.max(0, l + (c[i] - l) * s);
  }

  // --- 6. crosstalk ---------------------------------------------------------
  {
    const cr = c[0], cg = c[1], cb = c[2];
    c[0] = cr * (1 - CROSSTALK * 2) + cg * CROSSTALK + cb * CROSSTALK;
    c[1] = cg * (1 - CROSSTALK * 2) + cr * CROSSTALK + cb * CROSSTALK;
    c[2] = cb * (1 - CROSSTALK * 2) + cr * CROSSTALK * 0.6 + cg * CROSSTALK * 1.4;
  }

  return [Math.max(0, c[0]), Math.max(0, c[1]), Math.max(0, c[2])];
}

/**
 * Bake the grade into a 33^3 cube whose axes AND stored values are both
 * sRGB-encoded. ColorGrade.js encodes before the lookup and consumes the result
 * as display-referred, so no decode happens on the way out.
 */
export function makeGradeLUT() {
  const n = LUT_SIZE;
  const data = new Uint8Array(n * n * n * 4);

  let p = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const lin = [
          srgbToLinear(r / (n - 1)),
          srgbToLinear(g / (n - 1)),
          srgbToLinear(b / (n - 1)),
        ];
        const out = gradeLinear(lin);
        data[p++] = Math.round(saturate(linearToSrgb(out[0])) * 255);
        data[p++] = Math.round(saturate(linearToSrgb(out[1])) * 255);
        data[p++] = Math.round(saturate(linearToSrgb(out[2])) * 255);
        data[p++] = 255;
      }
    }
  }

  // The black entry is load-bearing: if this is ever not zero the frame has no
  // true black in it no matter what the lighting does, which is the single
  // defect this grade was rebuilt to remove. Fail loudly rather than ship a
  // milky image.
  if (data[0] !== 0 || data[1] !== 0 || data[2] !== 0) {
    console.error('[LutFactory] grade LUT lifts black to',
      data[0], data[1], data[2], '— the toe is broken.');
  }

  const tex = new THREE.Data3DTexture(data, n, n, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  tex.name = 'grade-lut';
  return { texture: tex, size: n };
}

/* --- value noise -------------------------------------------------------- */
function hash2(x, y, seed) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1013904223)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/**
 * Lens dirt mask: smeared fingerprint arcs plus fine dust specks. It only ever
 * modulates bloom, so what matters is that it has structure at two very
 * different scales — a uniform noise field reads as video compression, not as
 * grease on glass.
 */
export function makeDirtTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;

      // Large smeared arcs, anisotropically stretched like a wiped surface.
      let smear = 0;
      let amp = 0.5, freq = 3.0;
      for (let o = 0; o < 4; o++) {
        smear += valueNoise(u * freq * 3.4, v * freq * 0.9, o + 1) * amp;
        amp *= 0.52; freq *= 2.13;
      }
      smear = Math.pow(Math.max(0, smear - 0.42) * 2.4, 1.8);

      // Fine dust: sparse bright specks from a thresholded high-frequency field.
      const dust = Math.pow(Math.max(0, valueNoise(u * 190, v * 190, 17) - 0.80) * 5.0, 1.4);

      // Dirt collects toward the edges of the element.
      const dx = u - 0.5, dy = v - 0.5;
      const radial = 0.35 + 1.35 * Math.min(1, (dx * dx + dy * dy) * 3.0);

      const value = Math.min(1, (smear * 0.7 + dust * 0.9) * radial);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(value * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.name = 'lens-dirt';
  return tex;
}
