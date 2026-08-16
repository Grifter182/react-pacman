/**
 * OWNER: materials / texturing agent.
 *
 * Tileable procedural noise primitives used by every surface recipe.
 *
 * Everything in here is *periodic on the unit square*: a generator built with
 * period P wraps exactly at u=1 / v=1, so a baked texture tiles seamlessly no
 * matter how many octaves are stacked, as long as every octave's period is an
 * integer multiple of the base. That constraint is why the lattice indices are
 * wrapped with an explicit modulo instead of relying on a permutation table.
 *
 * The inner loops are allocation free and use integer hashing rather than a
 * seeded PRNG lookup, so a field can be evaluated a few million times during a
 * bake without tripping the GC.
 */

/* ------------------------------------------------------------------ hashing */

/** Deterministic 32-bit scalar PRNG — kept for callers that want a stream. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2D integer lattice hash -> uint32. Avalanches well enough for gradients. */
export function hash2i(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Hash to a float in [0,1). */
export function hash2f(x, y, seed) {
  return hash2i(x, y, seed) / 4294967296;
}

/* ---------------------------------------------------------------- gradients */

// 16 evenly spaced unit gradients. A power-of-two table lets the index come
// straight out of the low bits of the hash.
const GX = new Float32Array(16);
const GY = new Float32Array(16);
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2;
  GX[i] = Math.cos(a);
  GY[i] = Math.sin(a);
}

const wrap = (v, p) => ((v % p) + p) % p;

/**
 * Periodic 2D gradient (Perlin) noise. `period` is in lattice cells; the
 * caller feeds coordinates already scaled into that lattice.
 * Returns roughly [-1, 1] (raw Perlin peaks near +-0.707, so it is rescaled).
 */
export function perlin(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  // Quintic fade — C2 continuous, so derived normals have no lattice creases.
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

  // Single-modulo wrap. This runs a few hundred million times per boot, so the
  // extra `((v % p) + p) % p` the generic helper does is worth avoiding here.
  let x0 = xi % period; if (x0 < 0) x0 += period;
  let y0 = yi % period; if (y0 < 0) y0 += period;
  let x1 = x0 + 1; if (x1 === period) x1 = 0;
  let y1 = y0 + 1; if (y1 === period) y1 = 0;

  const g00 = hash2i(x0, y0, seed) & 15;
  const g10 = hash2i(x1, y0, seed) & 15;
  const g01 = hash2i(x0, y1, seed) & 15;
  const g11 = hash2i(x1, y1, seed) & 15;

  const n00 = GX[g00] * xf + GY[g00] * yf;
  const n10 = GX[g10] * (xf - 1) + GY[g10] * yf;
  const n01 = GX[g01] * xf + GY[g01] * (yf - 1);
  const n11 = GX[g11] * (xf - 1) + GY[g11] * (yf - 1);

  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return (a + v * (b - a)) * 1.4142;
}

/* -------------------------------------------------------------------- fbm's */

/**
 * Fractal brownian motion over periodic gradient noise.
 * Every octave doubles the lattice period so the whole stack stays tileable.
 * Returns a closure `(u, v) => [-1, 1]` taking unit-square coordinates.
 */
export function fbm(seed, basePeriod = 4, octaves = 5, gain = 0.5, lacunarity = 2) {
  const P = [], A = [], S = [];
  let p = Math.max(1, Math.round(basePeriod));
  let amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    P.push(p); A.push(amp); S.push((seed + o * 7919) | 0);
    norm += amp;
    amp *= gain;
    p = Math.max(1, Math.round(p * lacunarity));
  }
  const inv = 1 / norm;
  const n = P.length;
  return (u, v) => {
    let sum = 0;
    for (let o = 0; o < n; o++) sum += perlin(u * P[o], v * P[o], P[o], S[o]) * A[o];
    return sum * inv;
  };
}

/** Same as `fbm` remapped to [0, 1]. */
export function fbm01(seed, basePeriod, octaves, gain, lacunarity) {
  const f = fbm(seed, basePeriod, octaves, gain, lacunarity);
  return (u, v) => f(u, v) * 0.5 + 0.5;
}

/**
 * Ridged multifractal. Each octave is folded (`1 - |n|`) and sharpened, then
 * weighted by the previous octave so ridges only branch where the coarse layer
 * is already high. This is what gives rock/crack/erosion structure rather than
 * the soft blobs plain fbm produces.
 */
export function ridged(seed, basePeriod = 4, octaves = 5, gain = 0.5, sharpness = 2) {
  const P = [], A = [], S = [];
  let p = Math.max(1, Math.round(basePeriod));
  let amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    P.push(p); A.push(amp); S.push((seed + o * 6151) | 0);
    norm += amp;
    amp *= gain;
    p = Math.max(1, Math.round(p * 2));
  }
  const inv = 1 / norm;
  const n = P.length;
  return (u, v) => {
    let sum = 0, weight = 1;
    for (let o = 0; o < n; o++) {
      let s = 1 - Math.abs(perlin(u * P[o], v * P[o], P[o], S[o]));
      s *= s;
      if (sharpness !== 2) s = Math.pow(s, sharpness * 0.5);
      s *= weight;
      weight = s < 0 ? 0 : (s > 1 ? 1 : s);
      sum += s * A[o];
    }
    return sum * inv;
  };
}

/* ------------------------------------------------------------------- worley */

/** Reusable output record so the cellular evaluator never allocates. */
export class Cell {
  constructor() { this.f1 = 0; this.f2 = 0; this.id = 0; this.cx = 0; this.cy = 0; }
  /** Per-cell deterministic float in [0,1) from an independent hash lane. */
  rand(lane = 0) { return hash2f(this.cx, this.cy, 0x51ed270b + lane * 9176); }
}

/**
 * Periodic Worley / cellular noise.
 *
 * `f1` is the distance to the nearest feature point, `f2` to the second —
 * `f2 - f1` is the classic crack / cell-border field, `f1` alone gives pebbles.
 * Distances are normalised so a jitter-1 grid lands roughly in [0, 1].
 *
 * `stretch` scales the y axis of the distance metric only, which turns round
 * cells into elongated ones (bricks, planks, gravel that has been rolled flat)
 * without breaking periodicity.
 */
export function worley(seed, period = 8, jitter = 1.0, stretch = 1.0) {
  const P = Math.max(1, Math.round(period));
  const J = jitter / 65536;
  return (u, v, out) => {
    const x = u * P, y = v * P;
    const xi = Math.floor(x), yi = Math.floor(y);
    let f1 = 1e9, f2 = 1e9, bx = 0, by = 0;
    for (let oy = -1; oy <= 1; oy++) {
      const cy = yi + oy;
      let wy = cy % P; if (wy < 0) wy += P;
      const dyBase = cy + 0.5 - y;
      for (let ox = -1; ox <= 1; ox++) {
        const cx = xi + ox;
        let wx = cx % P; if (wx < 0) wx += P;
        const h = hash2i(wx, wy, seed);
        const dx = cx + 0.5 + ((h & 0xffff) * J - jitter * 0.5) - x;
        const dy = (dyBase + (((h >>> 16) & 0xffff) * J - jitter * 0.5)) * stretch;
        const d = dx * dx + dy * dy;
        if (d < f1) { f2 = f1; f1 = d; bx = wx; by = wy; }
        else if (d < f2) { f2 = d; }
      }
    }
    out.f1 = Math.sqrt(f1);
    out.f2 = Math.sqrt(f2);
    out.cx = bx; out.cy = by;
    out.id = hash2i(bx, by, seed ^ 0x5bd1e995);
    return out;
  };
}

/* -------------------------------------------------------------- domain warp */

/**
 * Domain warping: offset the sample point by two independent noise fields
 * before evaluating `field`. This is the single cheapest way to stop procedural
 * surfaces from looking like filtered static — it converts isotropic blobs into
 * flow, erosion and smear structure.
 *
 * The warp offsets are in unit-square units, so an amplitude of 0.05 shifts by
 * 5% of a tile.
 */
export function warped(field, seed, amp = 0.06, warpPeriod = 3, octaves = 3) {
  const wx = fbm(seed ^ 0x1b873593, warpPeriod, octaves, 0.5);
  const wy = fbm(seed ^ 0x2f5a1c77, warpPeriod, octaves, 0.5);
  return (u, v) => field(u + wx(u, v) * amp, v + wy(u, v) * amp);
}

/* ---------------------------------------------------------------- utilities */

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const mix = (a, b, t) => a + (b - a) * t;

export function smoothstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Tileable "sawtooth to triangle" helper — a periodic ramp on [0,1). */
export function tri(x) {
  const f = x - Math.floor(x);
  return f < 0.5 ? f * 2 : 2 - f * 2;
}

/**
 * Regular running-bond lattice (bricks, planks, tiles).
 * Returns the local coordinates inside a unit cell plus a stable cell id, all
 * periodic on the unit square when `cols` and `rows` are integers.
 */
export function lattice(u, v, cols, rows, offset, seed, out) {
  const row = Math.floor(v * rows);
  const shift = ((row % 2) !== 0) ? offset : 0;
  const uu = u * cols + shift;
  const col = Math.floor(uu);
  out.lx = uu - col;
  out.ly = v * rows - row;
  out.col = wrap(col, cols);
  out.row = wrap(row, rows);
  out.id = hash2i(out.col, out.row, seed);
  return out;
}
