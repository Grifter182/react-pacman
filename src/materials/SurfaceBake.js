import * as THREE from 'three';

/**
 * OWNER: materials / texturing agent.
 *
 * The bake pipeline: turns a recipe (height + mask sampler, shading function)
 * into a tileable PBR texture set, without blocking the main thread for the
 * seconds a megapixel of multi-octave noise would otherwise cost.
 *
 * Strategy
 * --------
 * 1. A *coarse* pass runs synchronously at 1/16 resolution and splats the
 *    result into the full-resolution byte buffers. The material is usable on
 *    the very first frame — blocky, but correctly coloured and lit, and the
 *    shader-side detail normal is already full rate.
 * 2. *Refine* passes are generators that walk the same recipe at half and
 *    then full resolution in row slices, yielding often enough that the
 *    scheduler keeps every slice near a millisecond. Each stage re-uploads
 *    the byte buffers in place; the THREE.Texture objects (and any clones
 *    sharing their Source) never change identity, so nothing has to be
 *    re-linked and no shader is recompiled.
 *
 * Derived channels
 * ----------------
 * Normal, ambient occlusion, edge wear and cavity dirt all come out of the
 * height field, not out of extra noise. Wear that is not tied to curvature
 * reads as dirt sprayed on top of a surface; wear that follows curvature reads
 * as a surface that has been used.
 */

/* --------------------------------------------------------------- transfer */

// sRGB OETF as a 1025-entry LUT with linear interpolation. Recipes author in
// *linear* reflectance (the physically meaningful quantity); the albedo texture
// is flagged SRGBColorSpace, so the bytes we store must be sRGB encoded.
const SRGB_LUT = new Float32Array(1025);
for (let i = 0; i <= 1024; i++) {
  const l = i / 1024;
  SRGB_LUT[i] = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}

export function linearToSrgb8(l) {
  if (l <= 0) return 0;
  if (l >= 1) return 255;
  const f = l * 1024;
  const i = f | 0;
  const t = f - i;
  return (SRGB_LUT[i] + (SRGB_LUT[i + 1] - SRGB_LUT[i]) * t) * 255 + 0.5 | 0;
}

/* ----------------------------------------------------------- field filters */

/**
 * Separable box blur with wrap-around addressing, O(N^2) regardless of radius.
 * Two of these at different radii give a multi-scale curvature decomposition
 * for free: `H - blur(H, r)` is a band-pass whose sign is the local convexity.
 */
export function blurWrap(src, dst, tmp, N, radius) {
  const r = Math.max(1, Math.min(radius | 0, (N >> 1) - 1));
  const w = r * 2 + 1;
  const inv = 1 / w;

  // horizontal
  for (let y = 0; y < N; y++) {
    const row = y * N;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + ((k % N) + N) % N];
    for (let x = 0; x < N; x++) {
      tmp[row + x] = sum * inv;
      const outIdx = (x - r + N) % N;
      const inIdx = (x + r + 1) % N;
      sum += src[row + inIdx] - src[row + outIdx];
    }
  }
  // vertical
  for (let x = 0; x < N; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[(((k % N) + N) % N) * N + x];
    for (let y = 0; y < N; y++) {
      dst[y * N + x] = sum * inv;
      const outIdx = (y - r + N) % N;
      const inIdx = (y + r + 1) % N;
      sum += tmp[inIdx * N + x] - tmp[outIdx * N + x];
    }
  }
  return dst;
}

/**
 * Rescale a field into [0,1] around its mean, clipping beyond +-k sigma.
 *
 * Plain min/max normalisation is wrong for these fields: one deep crack or one
 * tall pebble sets the range and squashes the entire base surface into a few
 * codes, which is exactly how a bake ends up looking like flat mush. Clipping
 * on sigma keeps the bulk of the surface using the bulk of the range and lets
 * rare extremes saturate — which is what a crack should do anyway.
 *
 * Post-condition: sigma of the result is 1 / (2k), which the curvature and AO
 * passes rely on to stay preset-independent.
 */
export function normaliseRobust(field, k = 3) {
  const n = field.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += field[i];
  mean /= n;
  let varr = 0;
  for (let i = 0; i < n; i++) { const d = field[i] - mean; varr += d * d; }
  const sigma = Math.sqrt(varr / n);
  if (sigma < 1e-7) { field.fill(0.5); return 0; }
  const s = 1 / (2 * k * sigma);
  for (let i = 0; i < n; i++) {
    const v = 0.5 + (field[i] - mean) * s;
    field[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return sigma;
}

/**
 * Derive curvature and ambient occlusion from a height field.
 *
 * `fine` is the small-radius band-pass — the signal that says "this texel sits
 * on a raised lip" (positive) or "in a crack" (negative). That is the mask
 * paint chips off and grime collects in.
 *
 * `ao` accumulates how much a texel sits below its neighbourhood at three
 * radii. Occlusion from a 2-texel dent and occlusion from a 32-texel hollow are
 * different phenomena and a single radius cannot express both.
 */
export function deriveCurvatureAO(H, N, out, opts = {}) {
  const aoStrength = opts.aoStrength ?? 1.0;
  const curvGain = opts.curvGain ?? 1.0;
  const scale = N / 512;

  const b1 = out.b1 || (out.b1 = new Float32Array(N * N));
  const b2 = out.b2 || (out.b2 = new Float32Array(N * N));
  const b3 = out.b3 || (out.b3 = new Float32Array(N * N));
  const tmp = out.tmp || (out.tmp = new Float32Array(N * N));

  blurWrap(H, b1, tmp, N, Math.max(1, Math.round(2 * scale)));
  blurWrap(H, b2, tmp, N, Math.max(2, Math.round(9 * scale)));
  blurWrap(H, b3, tmp, N, Math.max(4, Math.round(30 * scale)));

  const curv = out.curv || (out.curv = new Float32Array(N * N));
  const ao = out.ao || (out.ao = new Float32Array(N * N));

  let cs = 0;
  for (let i = 0; i < H.length; i++) {
    const h = H[i];
    // Convexity: the fine band-pass dominates, the macro band biases it so a
    // texel on a small lip that sits inside a large hollow still reads as
    // sheltered.
    const c = (h - b1[i]) * 2.4 + (h - b2[i]) * 1.0;
    curv[i] = c;
    cs += c * c;

    // Occlusion: only the part of the neighbourhood that sits *above* us
    // occludes. Weight the wide radii less — they subtend a smaller solid angle
    // difference per unit of height.
    const o1 = b1[i] - h, o2 = b2[i] - h, o3 = b3[i] - h;
    const occ = ((o1 > 0 ? o1 : 0) * 1.6 + (o2 > 0 ? o2 : 0) * 1.1 + (o3 > 0 ? o3 : 0) * 0.7)
      * 6 * aoStrength;
    // Visibility falls off exponentially with accumulated occluder mass.
    const a = Math.exp(-occ * 1.2);
    ao[i] = a < 0.12 ? 0.12 : a;
  }

  // Express curvature in units of its own RMS. A recipe whose height field
  // happens to be gentle then produces the same edge/cavity coverage as a
  // violent one, so the wear thresholds can live in the baker instead of being
  // retuned per preset.
  const rms = Math.sqrt(cs / H.length);
  const k = (rms > 1e-8 ? 1 / rms : 0) * curvGain;
  for (let i = 0; i < curv.length; i++) curv[i] *= k;
  return out;
}

/* -------------------------------------------------------------- normal map */

/**
 * Central-difference normal with wrap-around addressing.
 *
 * `relief` is the physical height range of the field expressed as a fraction of
 * the tile's width — a 2 m tile carrying 3 cm of relief is relief = 0.015. The
 * slope in tile units is therefore dH * relief * N / 2, which makes the encoded
 * normal identical at 512 and at 2048 instead of getting steeper with
 * resolution the way a fixed pixel-space gain does.
 */
export function encodeNormals(H, N, bytes, relief, stride = 4, offset = 0) {
  const k = relief * N * 0.5;
  for (let y = 0; y < N; y++) {
    const yp = ((y + 1) % N) * N;
    const ym = ((y - 1 + N) % N) * N;
    const row = y * N;
    for (let x = 0; x < N; x++) {
      const xp = (x + 1) % N;
      const xm = (x - 1 + N) % N;
      const dx = (H[row + xp] - H[row + xm]) * k;
      const dy = (H[yp + x] - H[ym + x]) * k;
      let nx = -dx, ny = -dy, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (row + x) * stride + offset;
      bytes[i] = (nx * 0.5 + 0.5) * 255 + 0.5 | 0;
      bytes[i + 1] = (ny * 0.5 + 0.5) * 255 + 0.5 | 0;
      bytes[i + 2] = (nz * 0.5 + 0.5) * 255 + 0.5 | 0;
      bytes[i + 3] = 255;
    }
  }
}

/* ---------------------------------------------------------------- textures */

export function makeDataTexture(data, N, srgb, anisotropy) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/* --------------------------------------------------------------- scheduler */

/**
 * Cooperative bake scheduler. Jobs are generators; the scheduler runs them
 * until a time budget for the current tick is exhausted, then hands the thread
 * back. Boot therefore costs one coarse pass per material (single-digit ms)
 * instead of a full-resolution bake.
 */
class BakeScheduler {
  constructor(budgetMs = 5) {
    this.budgetMs = budgetMs;
    this._jobs = [];
    this._pumping = false;
    this._idleWaiters = [];
  }

  get pending() { return this._jobs.length; }

  add(gen, label = '') {
    this._jobs.push({ gen, label });
    this._schedule();
  }

  /** Resolves once every queued bake has finished. */
  whenIdle() {
    if (!this._jobs.length) return Promise.resolve();
    return new Promise((res) => this._idleWaiters.push(res));
  }

  /** Force everything to completion synchronously (used by headless captures). */
  flush() {
    while (this._jobs.length) {
      const job = this._jobs[0];
      let r = job.gen.next();
      while (!r.done) r = job.gen.next();
      this._jobs.shift();
    }
    this._drain();
  }

  _schedule() {
    if (this._pumping) return;
    this._pumping = true;
    const run = () => { this._pumping = false; this._pump(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  _pump() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // Boot queues every material at once; a one-off bake later (a new prop, a
    // debug preset) should not steal the same slice. Widen the budget only
    // while the queue is actually deep.
    const budget = this._jobs.length > 2 ? this.budgetMs * 1.7 : this.budgetMs;
    // Round-robin, not FIFO. Draining one material to completion before
    // starting the next would leave the wall at preview resolution while the
    // ground went sharp; rotating brings the whole frame up together.
    let guard = 0;
    while (this._jobs.length && now() - t0 < budget && guard++ < 4096) {
      const job = this._jobs.shift();
      const r = job.gen.next();
      if (!r.done) this._jobs.push(job);
    }
    if (this._jobs.length) this._schedule();
    else this._drain();
  }

  _drain() {
    const w = this._idleWaiters;
    this._idleWaiters = [];
    for (const res of w) res();
  }
}

export const bakeScheduler = new BakeScheduler(5);
