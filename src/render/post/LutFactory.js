import * as THREE from 'three';

/**
 * OWNER: rendering / post-processing agent.
 *
 * Procedural grading assets. Nothing is loaded from disk — the LUT and the lens
 * dirt mask are both generated once at boot.
 */

const LUT_SIZE = 33;

function saturate(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/**
 * Neutral-plus-teal/orange creative LUT.
 *
 * The look is the standard modern-military-shooter grade, built from four
 * stacked operations that are each cheap to reason about:
 *
 *   1. A filmic S-curve in log space. Contrast applied in log rather than
 *      display space keeps the toe from clipping shadow detail to black.
 *   2. Split toning: shadows pushed to teal, highlights to warm amber, with a
 *      luminance-squared weight so midtones (skin, concrete) stay neutral.
 *   3. Global desaturation with a luminance-dependent floor — deep shadows lose
 *      more chroma than highlights, which is what makes the image read as
 *      "graded" rather than "greyed".
 *   4. Channel crosstalk: a small amount of each channel bled into the others,
 *      the thing that stops saturated reds (muzzle flash, blood) from turning
 *      into flat clipped patches.
 */
export function makeGradeLUT() {
  const n = LUT_SIZE;
  const data = new Uint8Array(n * n * n * 4);

  const shadowTint = [-0.010, 0.030, 0.062];   // teal
  const highTint = [0.055, 0.020, -0.028];     // amber
  const toneStrength = 0.85;
  const contrast = 1.13;
  const pivot = 0.42;
  const desat = 0.80;
  const crosstalk = 0.055;

  let p = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        let c = [r / (n - 1), g / (n - 1), b / (n - 1)];

        // --- 1. log-space S-curve ---------------------------------------
        for (let i = 0; i < 3; i++) {
          const lg = Math.log2(Math.max(c[i], 1e-4) + 0.01);
          const pv = Math.log2(pivot + 0.01);
          c[i] = Math.max(0, Math.pow(2, pv + (lg - pv) * contrast) - 0.01);
        }
        // A gentle shoulder so the top end rolls instead of clipping.
        for (let i = 0; i < 3; i++) c[i] = c[i] / (1.0 + Math.max(0, c[i] - 0.82) * 0.9);

        // --- 2. split toning ---------------------------------------------
        let l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        const ws = Math.pow(1 - saturate(l), 2.2);
        const wh = Math.pow(saturate(l), 2.0);
        for (let i = 0; i < 3; i++) {
          c[i] += (shadowTint[i] * ws + highTint[i] * wh) * toneStrength;
        }

        // --- 3. luminance-aware desaturation ------------------------------
        l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        const s = desat - 0.14 * (1 - saturate(l));
        for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * s;

        // --- 4. crosstalk --------------------------------------------------
        const cr = c[0], cg = c[1], cb = c[2];
        c[0] = cr * (1 - crosstalk * 2) + cg * crosstalk + cb * crosstalk;
        c[1] = cg * (1 - crosstalk * 2) + cr * crosstalk + cb * crosstalk;
        c[2] = cb * (1 - crosstalk * 2) + cr * crosstalk * 0.6 + cg * crosstalk * 1.4;

        // Lift the very bottom off pure black — real film never reaches 0, and
        // a slightly blue floor keeps night interiors from looking like holes.
        c[0] += 0.006; c[1] += 0.008; c[2] += 0.013;

        data[p++] = Math.round(saturate(c[0]) * 255);
        data[p++] = Math.round(saturate(c[1]) * 255);
        data[p++] = Math.round(saturate(c[2]) * 255);
        data[p++] = 255;
      }
    }
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
