import * as THREE from 'three';

/**
 * OWNER: materials / texturing agent.
 *
 * All surface detail is generated procedurally at runtime — there are no
 * external image assets, so the build stays self-contained and every material
 * ships a full PBR set (albedo / normal / roughness / AO / height).
 *
 * Extend this file with real multi-octave noise, worley cells, edge wear,
 * grunge overlays and per-material dirt masks. `makeMaterial()` is the single
 * entry point every other module should use.
 */

const _cache = new Map();

/* ------------------------------------------------------------------ noise */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tiling value noise with smooth interpolation. */
function valueNoise2D(rand, size) {
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const g = (ix, iy) => grid[((iy % size) + size) % size * size + (((ix % size) + size) % size)];
    const a = g(xi, yi), b = g(xi + 1, yi), c = g(xi, yi + 1), d = g(xi + 1, yi + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

/** Fractal brownian motion over tiling value noise. */
export function fbm(rand, baseSize = 8, octaves = 6, lacunarity = 2, gain = 0.5) {
  const layers = [];
  let size = baseSize;
  for (let o = 0; o < octaves; o++) {
    layers.push({ n: valueNoise2D(rand, Math.max(2, Math.round(size))), size });
    size *= lacunarity;
  }
  return (u, v) => {
    let sum = 0, amp = 1, norm = 0;
    for (const { n, size: s } of layers) {
      sum += n(u * s, v * s) * amp;
      norm += amp;
      amp *= gain;
    }
    return sum / norm;
  };
}

/* -------------------------------------------------------------- generators */

/**
 * Build a height field and derive albedo/normal/roughness/AO from it.
 * `shade(u, v, h, out)` writes rgb 0..1 into `out` and may return roughness.
 */
export function generateSurface({
  size = 1024,
  seed = 1,
  height,             // (u, v) => 0..1
  shade,              // (u, v, h) => [r, g, b, roughness, metalness]
  normalStrength = 2.0,
  aoStrength = 0.9,
  repeat = 1,
  anisotropy = 16,
} = {}) {
  const rand = mulberry32(seed);
  const N = size;
  const H = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      H[y * N + x] = height(x / N, y / N, rand);
    }
  }

  const albedo = new Uint8Array(N * N * 4);
  const normal = new Uint8Array(N * N * 4);
  const arm = new Uint8Array(N * N * 4); // r=AO g=roughness b=metalness

  const at = (x, y) => H[(((y % N) + N) % N) * N + (((x % N) + N) % N)];

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const h = H[y * N + x];

      // Sobel gradient -> tangent-space normal
      const dx = (at(x + 1, y) - at(x - 1, y)) * normalStrength * N / 512;
      const dy = (at(x, y + 1) - at(x, y - 1)) * normalStrength * N / 512;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      normal[i] = (nx * 0.5 + 0.5) * 255;
      normal[i + 1] = (ny * 0.5 + 0.5) * 255;
      normal[i + 2] = (nz * 0.5 + 0.5) * 255;
      normal[i + 3] = 255;

      // cheap cavity AO from local height difference
      let acc = 0;
      for (let o = 1; o <= 3; o++) {
        acc += (at(x + o, y) + at(x - o, y) + at(x, y + o) + at(x, y - o)) * 0.25 - h;
      }
      const ao = 1 - Math.min(1, Math.max(0, acc / 3) * 3 * aoStrength);

      const s = shade(x / N, y / N, h, rand);
      albedo[i] = Math.min(255, s[0] * 255);
      albedo[i + 1] = Math.min(255, s[1] * 255);
      albedo[i + 2] = Math.min(255, s[2] * 255);
      albedo[i + 3] = 255;

      arm[i] = ao * 255;
      arm[i + 1] = Math.min(255, (s[3] ?? 0.8) * 255);
      arm[i + 2] = Math.min(255, (s[4] ?? 0.0) * 255);
      arm[i + 3] = 255;
    }
  }

  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = anisotropy;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  };

  return { map: mk(albedo, true), normalMap: mk(normal, false), armMap: mk(arm, false) };
}

/**
 * Single entry point. `preset` names a surface recipe; results are cached.
 * Add new presets here rather than building materials inline elsewhere.
 */
export function makeMaterial(preset, opts = {}) {
  const key = `${preset}:${JSON.stringify(opts)}`;
  if (_cache.has(key)) return _cache.get(key);

  const size = opts.size ?? 512;
  const repeat = opts.repeat ?? 1;
  const seed = opts.seed ?? 1337;
  const rand = mulberry32(seed);
  const n = fbm(rand, 6, 6);
  const fine = fbm(mulberry32(seed + 77), 24, 4);

  let surface;
  switch (preset) {
    case 'concrete': {
      surface = generateSurface({
        size, seed, repeat, normalStrength: 1.4,
        height: (u, v) => n(u, v) * 0.6 + fine(u, v) * 0.4,
        shade: (u, v, h) => {
          const g = 0.36 + h * 0.22;
          const stain = Math.max(0, fine(u * 0.5, v * 0.5) - 0.55) * 0.6;
          return [g - stain * 0.4, g - stain * 0.38, g * 0.98 - stain * 0.32, 0.86 - h * 0.12, 0.0];
        },
      });
      break;
    }
    case 'metal': {
      surface = generateSurface({
        size, seed, repeat, normalStrength: 0.8,
        height: (u, v) => fine(u, v * 0.15) * 0.7 + n(u, v) * 0.3,
        shade: (u, v, h) => {
          const g = 0.42 + h * 0.18;
          const rust = Math.max(0, n(u * 1.3, v * 1.3) - 0.62) * 2.2;
          return [
            g + rust * 0.30, g * 0.94 + rust * 0.10, g * 0.9 + rust * 0.02,
            0.34 + h * 0.2 + rust * 0.4, 1.0 - rust * 0.85,
          ];
        },
      });
      break;
    }
    case 'sand': {
      surface = generateSurface({
        size, seed, repeat, normalStrength: 1.1,
        height: (u, v) => n(u, v) * 0.35 + fine(u, v) * 0.65,
        shade: (u, v, h) => {
          const g = 0.56 + h * 0.16;
          return [g * 1.06, g * 0.94, g * 0.72, 0.94 - h * 0.06, 0.0];
        },
      });
      break;
    }
    case 'plaster':
    default: {
      surface = generateSurface({
        size, seed, repeat, normalStrength: 1.0,
        height: (u, v) => n(u, v) * 0.7 + fine(u, v) * 0.3,
        shade: (u, v, h) => {
          const g = 0.62 + h * 0.16;
          return [g * 1.02, g * 0.99, g * 0.93, 0.8 - h * 0.1, 0.0];
        },
      });
    }
  }

  const mat = new THREE.MeshStandardMaterial({
    map: surface.map,
    normalMap: surface.normalMap,
    aoMap: surface.armMap,
    roughnessMap: surface.armMap,
    metalnessMap: surface.armMap,
    roughness: 1.0,
    metalness: 1.0,
    normalScale: new THREE.Vector2(1, 1),
    envMapIntensity: opts.envMapIntensity ?? 1.0,
    ...(opts.material || {}),
  });
  mat.userData.preset = preset;
  _cache.set(key, mat);
  return mat;
}

export function clearMaterialCache() {
  for (const m of _cache.values()) {
    m.map?.dispose(); m.normalMap?.dispose(); m.aoMap?.dispose(); m.dispose();
  }
  _cache.clear();
}

export { mulberry32 };
