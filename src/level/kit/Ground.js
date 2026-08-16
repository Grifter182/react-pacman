import { fbm2, noise2, hash2, clamp01, lerp, rng } from './Geo.js';

/**
 * OWNER: level-art agent.
 *
 * The ground.
 *
 * The ground is a third of almost every outdoor frame on this map and it used
 * to be one 280 m quad of a single material. Three things were wrong with that
 * and all three are fixed here.
 *
 *  1. **One tile scale for everything.** A single plane cannot be both crisp at
 *     1.5 m (where the player's own feet are) and free of visible repetition at
 *     90 m. So the ground is now three shells: a fine inner field over the
 *     walked area at the recipe's native tile scale, a mid apron, and a coarse
 *     distant ring whose tiles are big enough that the repeat is below the fog.
 *
 *  2. **Hard axis-aligned material boundaries.** `_pad()` drew a rectangle, so
 *     asphalt met sand along a ruled line the eye reads instantly as a
 *     rectangle of decal. `pave()` instead emits the region cell by cell and
 *     decides each cell against a noise field, so the boundary wanders, throws
 *     tongues out into the sand and leaves islands of sand inside the paving —
 *     the way a real surface fails at its edges.
 *
 *  3. **No value variation.** Every surface bucket now carries the level's
 *     per-vertex weathering attribute with a ground-specific field: broad
 *     drifts of pale dust, dark compacted tracks along the lines people and
 *     vehicles actually take, and a wet-dark band wicking out of every wall
 *     base. That is what stops 8,000 m² of pavement reading as one flat value.
 *
 * On top of that sit the decals — tyre tracks, oil, cracks, spill — which are
 * plain geometry on their own buckets, lifted a few centimetres and polygon
 * offset, because a real decal system is not worth its complexity for a map
 * whose ground never moves.
 */

/* ------------------------------------------------------------ weathering */

/**
 * Ground weather field factory.
 *
 * `aWeather.x` (grime) drives a dust film that flattens the albedo toward the
 * material's dust colour; `aWeather.y` (stain) darkens and smooths, which is
 * what damp compacted dirt, oil and tyre polish all look like.
 *
 * @param {object} o
 *   seed      lattice seed
 *   dust      0..1.4 gain on the broad dust drifts
 *   tracks    array of [x0,z0,x1,z1,halfWidth] worn lines (vehicle ruts, the
 *             desire path down the middle of a street)
 *   walls     array of [x0,z0,x1,z1] wall footprints; ground within ~1.2 m of
 *             one collects splash and shadow dirt
 */
export function groundWeather(o = {}) {
  const seed = o.seed ?? 4111;
  const dustGain = o.dust ?? 1.0;
  const tracks = o.tracks || [];
  const walls = o.walls || [];
  const trackGain = o.trackGain ?? 1.0;

  return (x, y, z, nx, ny, nz, out) => {
    // Two decorrelated scales of drift: 14 m patches of pale wind-blown dust
    // riding on 42 m of broad tonal shift. Both are cheap and both are the
    // difference between "a surface" and "a fill colour".
    const broad = fbm2(x * 0.024, z * 0.024, 2, seed);
    const patch = fbm2(x * 0.071, z * 0.071, 3, seed + 17);
    let grime = clamp01((broad * 0.55 + patch * 0.62 - 0.22) * dustGain);

    // Worn lines. A track is dark and smooth, not dusty, so it *removes* dust
    // and adds stain — exactly the inversion that makes a rut read as a rut.
    let wear = 0;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const ax = t[0], az = t[1], bx = t[2], bz = t[3], hw = t[4];
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz || 1;
      let s = ((x - ax) * dx + (z - az) * dz) / len2;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const px = ax + dx * s, pz = az + dz * s;
      // Wobble the centre-line so a rut is not a ruled band.
      const wob = (noise2(x * 0.09, z * 0.09, seed + 91) - 0.5) * hw * 0.9;
      const dist = Math.hypot(x - px, z - pz) + wob;
      wear = Math.max(wear, clamp01(1 - dist / hw));
    }
    wear *= trackGain;
    // Ruts are two wheel lines, not one wide smear.
    const twin = 0.55 + 0.45 * Math.abs(Math.sin(wear * 3.2));
    wear *= twin;

    // Splash-back and shade dirt at the foot of a wall.
    let base = 0;
    for (let i = 0; i < walls.length; i++) {
      const w = walls[i];
      const dx = Math.max(w[0] - x, 0, x - w[2]);
      const dz = Math.max(w[1] - z, 0, z - w[3]);
      base = Math.max(base, clamp01(1 - Math.hypot(dx, dz) / 1.35));
    }

    grime = clamp01(grime * (1 - wear * 0.85) + base * 0.45);
    out[0] = grime;
    out[1] = clamp01(wear * 0.9 + base * 0.5 + patch * 0.12);
  };
}

/* ---------------------------------------------------------------- paving */

/**
 * Emit a surface region as a noise-masked field of cells.
 *
 * The rectangle is only a *guide*: every cell is tested against a fractal
 * threshold that is biased hard positive well inside the region and hard
 * negative well outside it, so the interior is solid, the exterior is empty,
 * and a `feather`-wide band around the nominal edge dissolves into tongues and
 * islands. Cell corners are jittered by a lattice hash, which is shared between
 * neighbouring cells, so the field is continuous and never cracks.
 *
 * @param {object} kit  { batch }
 * @param {object} o
 *   bucket     batcher bucket key
 *   x0,z0,x1,z1  nominal extent
 *   y          height (default 0.02)
 *   step       cell size in metres (default 2.0)
 *   feather    width of the dissolving border, metres (default 1.8)
 *   jitter     corner jitter as a fraction of `step` (default 0.16)
 *   seed
 *   weather    per-vertex weather field
 *   coverage   -0.5..0.5 bias; positive grows the region, negative erodes it
 * @returns {{cells:number, keep:Function}} `keep(x,z)` reports whether a world
 *   point landed on the paving, so callers can scatter decals only where the
 *   surface actually exists.
 */
export function pave(kit, o) {
  const { batch } = kit;
  const x0 = Math.min(o.x0, o.x1), x1 = Math.max(o.x0, o.x1);
  const z0 = Math.min(o.z0, o.z1), z1 = Math.max(o.z0, o.z1);
  const y = o.y ?? 0.02;
  const step = o.step ?? 2.0;
  const feather = o.feather ?? 1.8;
  const jit = (o.jitter ?? 0.16) * step;
  const seed = o.seed ?? 7;
  const cov = o.coverage ?? 0;
  const nScale = o.noiseScale ?? 0.11;

  // Signed distance to the rectangle, positive inside.
  const sdf = (x, z) => {
    const dx = Math.min(x - x0, x1 - x), dz = Math.min(z - z0, z1 - z);
    if (dx > 0 && dz > 0) return Math.min(dx, dz);
    return -Math.hypot(Math.max(-dx, 0), Math.max(-dz, 0));
  };
  // Two scales of mask: ~9 m tongues that pull the whole edge in and out, plus
  // a ~2.5 m nibble on top so the boundary is ragged at cell resolution too.
  // One octave alone gives a wavy but still obviously continuous line.
  const keep = (x, z) => {
    const d = sdf(x, z);
    if (d > feather * 1.6) return true;
    if (d < -feather * 1.6) return false;
    const n = fbm2(x * nScale, z * nScale, 3, seed) - 0.5;
    const m = fbm2(x * nScale * 4.1, z * nScale * 4.1, 2, seed + 41) - 0.5;
    return d / feather + n * 2.1 + m * 0.75 + cov > 0;
  };

  // Lattice-hashed corner jitter: a function of the integer cell corner only,
  // so two cells sharing a corner agree on where it moved to.
  const jx = (i, j) => (hash2(i, j, seed + 5) - 0.5) * 2 * jit;
  const jz = (i, j) => (hash2(i, j, seed + 6) - 0.5) * 2 * jit;

  const i0 = Math.floor((x0 - feather) / step), i1 = Math.ceil((x1 + feather) / step);
  const j0 = Math.floor((z0 - feather) / step), j1 = Math.ceil((z1 + feather) / step);

  let cells = 0;
  for (let i = i0; i < i1; i++) {
    for (let j = j0; j < j1; j++) {
      const cx = (i + 0.5) * step, cz = (j + 0.5) * step;
      if (!keep(cx, cz)) continue;
      // Route every cell by its OWN position. Handing the whole region to one
      // `batch.at()` would put 90 m of motor yard into a single mesh, which is
      // inside the near shadow cascade and inside the view frustum from
      // everywhere on the map — the exact failure the Batcher's spatial cells
      // exist to prevent.
      const g = batch.at(o.bucket, cx, cz);
      const prev = g.weather;
      if (o.weather) g.weather = o.weather;
      const ax = i * step, bx = (i + 1) * step;
      const az = j * step, bz = (j + 1) * step;
      // Cell height wobbles by a couple of centimetres. Flat ground lit by a
      // low sun is the one case where sub-centimetre relief actually reads.
      const h = (a, b) => y + (noise2(a * 0.5, b * 0.5, seed + 3) - 0.5) * 0.028;
      const A = [ax + jx(i, j), h(i, j), az + jz(i, j)];
      const B = [bx + jx(i + 1, j), h(i + 1, j), az + jz(i + 1, j)];
      const C = [bx + jx(i + 1, j + 1), h(i + 1, j + 1), bz + jz(i + 1, j + 1)];
      const D = [ax + jx(i, j + 1), h(i, j + 1), bz + jz(i, j + 1)];
      g.quad(A, B, C, D, 0);
      g.weather = prev;
      cells++;
    }
  }
  return { cells, keep };
}

/**
 * The base terrain: a fine inner field over the play space and a coarse ring
 * out to the fog. Split so the inner shell can be tiled at the sand recipe's
 * native scale — roughly 2 m per tile, where its ripple train and gravel lag
 * are legible at arm's length — while the ring, which is only ever seen past
 * 60 m, carries a tile large enough that its repeat never resolves.
 */
export function baseTerrain(kit, o) {
  const { batch } = kit;
  const inner = o.inner ?? 52;
  const outer = o.outer ?? 150;

  // 3 m cells across the walked field: enough rows for the dust/track field to
  // curve, cheap enough to be noise in the budget (about 2.5k triangles). Each
  // cell is routed by its own centre so the field lands in the Batcher's
  // spatial buckets instead of becoming one 108 m mesh.
  const step = o.step ?? 3.0;
  const n = Math.ceil((inner * 2) / step);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const ax = -inner + (i * inner * 2) / n, bx = -inner + ((i + 1) * inner * 2) / n;
      const az = -inner + (j * inner * 2) / n, bz = -inner + ((j + 1) * inner * 2) / n;
      const g = batch.at(o.bucket || 'sand', (ax + bx) / 2, (az + bz) / 2);
      const prev = g.weather;
      if (o.weather) g.weather = o.weather;
      const h = (x, z) => (noise2(x * 0.13, z * 0.13, 991) - 0.5) * 0.05;
      g.quad([ax, h(ax, az), az], [bx, h(bx, az), az], [bx, h(bx, bz), bz], [ax, h(ax, bz), bz], 0);
      g.weather = prev;
    }
  }

  // The ring: four trapezoids from the inner square out to the horizon square,
  // on their own coarse-tiled bucket.
  const r = batch.at(o.farBucket || o.bucket || 'sand', 0, 0);
  r.identity();
  const rPrev = r.weather;
  r.weather = null;
  const I = inner, O = outer;
  r.quad([-O, -0.01, -O], [O, -0.01, -O], [I, -0.01, -I], [-I, -0.01, -I], 0);
  r.quad([O, -0.01, O], [-O, -0.01, O], [-I, -0.01, I], [I, -0.01, I], 0);
  r.quad([-O, -0.01, O], [-O, -0.01, -O], [-I, -0.01, -I], [-I, -0.01, I], 0);
  r.quad([O, -0.01, -O], [O, -0.01, O], [I, -0.01, I], [I, -0.01, -I], 0);
  r.weather = rPrev;
}

/* ---------------------------------------------------------------- decals */

/**
 * A ribbon laid on the ground along a polyline — tyre ruts, drag marks, the
 * dark polished line worn down the centre of a walked street. Width tapers to
 * nothing at both ends so the mark has no cut-off edge.
 */
export function track(kit, o) {
  const { batch } = kit;
  const pts = o.points;
  if (!pts || pts.length < 2) return;
  const w = o.width ?? 0.26;
  const y = o.y ?? 0.055;
  const wander = o.wander ?? 0.18;
  const seed = o.seed ?? 3;
  const g = batch.at(o.bucket || 'decal', pts[0][0], pts[0][1]);
  g.identity();

  // Resample the polyline so the ribbon can curve and taper smoothly.
  const N = o.segments ?? 22;
  const total = pts.length - 1;
  const at = (t) => {
    const f = t * total;
    const i = Math.min(total - 1, Math.floor(f));
    const u = f - i;
    return [lerp(pts[i][0], pts[i + 1][0], u), lerp(pts[i][1], pts[i + 1][1], u)];
  };
  let prev = null;
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const p = at(t);
    const q = at(Math.min(1, t + 1e-3));
    let dx = q[0] - p[0], dz = q[1] - p[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const off = (noise2(t * 7.0, seed, seed) - 0.5) * wander;
    const taper = Math.sin(Math.PI * clamp01(t)) ** 0.35;
    const hw = (w * 0.5) * taper * (0.75 + noise2(t * 11.0, seed + 4, seed) * 0.5);
    const cx = p[0] - dz * off, cz = p[1] + dx * off;
    const cur = [[cx - dz * hw, cz + dx * hw], [cx + dz * hw, cz - dx * hw]];
    if (prev && hw > 0.005) {
      g.quad([prev[0][0], y, prev[0][1]], [prev[1][0], y, prev[1][1]],
        [cur[1][0], y, cur[1][1]], [cur[0][0], y, cur[0][1]], 0);
    }
    prev = cur;
  }
}

/** A pair of ruts — one vehicle passing, not one smear. */
export function tyreTracks(kit, o) {
  const gauge = o.gauge ?? 1.55;
  const pts = o.points;
  for (const s of [-1, 1]) {
    const shifted = pts.map((p, i) => {
      const n = i < pts.length - 1 ? [pts[i + 1][0] - p[0], pts[i + 1][1] - p[1]]
        : [p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]];
      const l = Math.hypot(n[0], n[1]) || 1;
      return [p[0] - (n[1] / l) * s * gauge * 0.5, p[1] + (n[0] / l) * s * gauge * 0.5];
    });
    track(kit, { ...o, points: shifted, seed: (o.seed ?? 3) + (s > 0 ? 11 : 0) });
  }
}

/**
 * An irregular blot: oil under a vehicle, a damp patch, a scorch. Radial with a
 * noise-modulated radius, so it never reads as a disc or a rectangle.
 */
export function blot(kit, o) {
  const { batch } = kit;
  const r0 = o.radius ?? 0.8;
  const y = o.y ?? 0.05;
  const seed = o.seed ?? 5;
  const seg = o.segments ?? 14;
  const g = batch.at(o.bucket || 'decal', o.x, o.z);
  g.identity();
  const R = (a) => r0 * (0.52 + 0.9 * fbm2(Math.cos(a) * 1.7 + seed, Math.sin(a) * 1.7, 2, seed));
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const r0a = R(a0), r1a = R(a1);
    g.tri(o.x, y, o.z,
      o.x + Math.cos(a0) * r0a, y, o.z + Math.sin(a0) * r0a,
      o.x + Math.cos(a1) * r1a, y, o.z + Math.sin(a1) * r1a,
      0, 1, 0);
  }
}

/**
 * Cracking radiating from a point. Real pavement fails from an origin outward,
 * branching as it goes, which is why a straight painted line never convinces.
 */
export function cracks(kit, o) {
  const { batch } = kit;
  const g = batch.at(o.bucket || 'decal', o.x, o.z);
  g.identity();
  const r = rng(o.seed ?? 23);
  const y = o.y ?? 0.048;
  const arms = o.arms ?? 4;
  const reach = o.reach ?? 3.0;
  const w = o.width ?? 0.05;
  const walk = (sx, sz, ang, len, width) => {
    let x = sx, z = sz, a = ang;
    const steps = Math.max(3, Math.round(len / 0.45));
    for (let i = 0; i < steps; i++) {
      a += (r() - 0.5) * 0.65;
      const nx = x + Math.cos(a) * 0.45, nz = z + Math.sin(a) * 0.45;
      const hw0 = width * (1 - i / steps) * 0.5, hw1 = width * (1 - (i + 1) / steps) * 0.5;
      const px = -Math.sin(a), pz = Math.cos(a);
      g.quad([x + px * hw0, y, z + pz * hw0], [nx + px * hw1, y, nz + pz * hw1],
        [nx - px * hw1, y, nz - pz * hw1], [x - px * hw0, y, z - pz * hw0], 0);
      x = nx; z = nz;
      if (i === (steps >> 1) && r() < 0.55) walk(x, z, a + (r() < 0.5 ? 1 : -1) * 0.9, len * 0.45, width * 0.6);
    }
  };
  for (let i = 0; i < arms; i++) {
    walk(o.x, o.z, (i / arms) * Math.PI * 2 + r(), reach * (0.6 + r() * 0.7), w);
  }
}

/**
 * Rubble and dust spill along the foot of a wall run. Every wall in a place
 * like this sheds render, and the line where the wall meets the ground is the
 * single most-looked-at edge on the map — an unbroken 90° join is what makes a
 * blockout look like a blockout.
 */
export function wallSpill(kit, o) {
  const { batch } = kit;
  const g = batch.at(o.bucket || 'rubblebits', (o.x0 + o.x1) / 2, (o.z0 + o.z1) / 2);
  const r = rng(o.seed ?? 31);
  const dx = o.x1 - o.x0, dz = o.z1 - o.z0;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const px = -uz, pz = ux;                     // outward normal of the run
  const n = Math.max(4, Math.round(len * (o.density ?? 1.5)));
  const reach = o.reach ?? 0.75;
  for (let i = 0; i < n; i++) {
    const t = (i + r() * 0.9) / n;
    // Spill clusters rather than spreading evenly: gaps are what sell it.
    if (fbm2(t * 6.0, o.seed ?? 31, 2, 5) < 0.42) continue;
    const off = Math.pow(r(), 1.8) * reach + 0.05;
    const s = lerp(0.05, 0.26, r() * r());
    const x = o.x0 + ux * (t * len) + px * off;
    const z = o.z0 + uz * (t * len) + pz * off;
    g.at(x, (o.y ?? 0) + s * 0.34, z, r() * 3.14, r() * 0.5, r() * 0.5)
      .box(s * 1.9, s * 0.75, s * 1.3, s * 0.2);
  }
}
