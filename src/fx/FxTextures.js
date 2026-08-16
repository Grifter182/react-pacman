import * as THREE from 'three';

/**
 * OWNER: VFX agent.
 *
 * Every texture the effects system uses, generated in code at boot: one RGBA
 * atlas of particle sprites, and a pair of atlases (albedo+coverage / tangent
 * normal) for projected impact decals.
 *
 * Both atlases are 4x4. Sprites are authored in a normalised [-1,1] tile space
 * so a generator is pure geometry and never has to think about pixels, and each
 * tile's outer 14% is forced to zero coverage: the atlas is mipmapped (particles
 * are frequently 4px on screen and alias horribly without it) and a hard-edged
 * tile would bleed into its neighbour at the coarse mips.
 *
 * Decal tiles are authored as a *height field* first. Albedo and the tangent
 * normal are then both derived from that one field, which is why the shading of
 * a crater's rim agrees with its lighting instead of being two unrelated
 * paintings of the same hole.
 */

/* ------------------------------------------------------------------ noise */

const TAU = Math.PI * 2;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Integer hash -> [0,1). Math.imul keeps the mixing in 32-bit lanes. */
function hash2i(x, y, s) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise2(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2i(xi, yi, s), b = hash2i(xi + 1, yi, s);
  const c = hash2i(xi, yi + 1, s), d = hash2i(xi + 1, yi + 1, s);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

function fbm2(x, y, s, oct = 4, gain = 0.5, lac = 2.07) {
  let sum = 0, amp = 0.5, norm = 0, fx = x, fy = y;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise2(fx, fy, s + i * 131);
    norm += amp;
    amp *= gain;
    fx *= lac; fy *= lac;
  }
  return sum / norm;
}

/** Ridged noise — the sharp creases read as cracks and splinter edges. */
function ridge2(x, y, s, oct = 3) {
  let sum = 0, amp = 0.5, norm = 0, fx = x, fy = y;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(noise2(fx, fy, s + i * 77) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    fx *= 2.11; fy *= 2.11;
  }
  return sum / norm;
}

/* -------------------------------------------------------- particle atlas */

export const PT = {
  SMOKE: 0, WISP: 1, DUST: 2, SPARK: 3,
  FLAME: 4, FLARE: 5, CHIP: 6, BLOOD: 7,
  RING: 8, SPLINTER: 9, GLASS: 10, MOTE: 11,
  WATER: 12, DENSE: 13, SPALL: 14, CRACK: 15,
};

/** Tile UV size in the 4x4 atlas — shaders need it to address a tile. */
export const ATLAS_COLS = 4;

const PARTICLE_TILES = [
  // 0 SMOKE — turbulent puff, the workhorse for dust and lingering smoke.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const warp = fbm2(u * 2.2 + 9, v * 2.2 - 4, 11, 4) - 0.5;
    const rr = r * (1 + warp * 0.8);
    const det = fbm2(u * 4.6 + 31, v * 4.6 + 17, 12, 5);
    let a = smoothstep(1.0, 0.12, rr) * (0.40 + 0.80 * det);
    a = clamp01(a);
    const shade = 0.70 + 0.30 * det;
    o[0] = shade; o[1] = shade; o[2] = shade; o[3] = a;
  },
  // 1 WISP — the same cloud stretched and torn, so a smoke column is not
  // sixteen copies of one silhouette.
  (u, v, o) => {
    const r = Math.hypot(u * 1.35, v * 0.8);
    const warp = fbm2(u * 1.6 - 21, v * 3.4 + 6, 41, 4) - 0.5;
    const rr = r * (1 + warp * 1.15);
    const det = fbm2(u * 3.1 + 7, v * 6.2 - 3, 42, 5);
    let a = smoothstep(1.0, 0.08, rr) * (0.25 + 0.95 * det);
    a = clamp01(a) * 0.9;
    const shade = 0.66 + 0.34 * det;
    o[0] = shade; o[1] = shade; o[2] = shade; o[3] = a;
  },
  // 2 DUST — grainier and thinner; holds together at 3px.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const det = fbm2(u * 7.0 - 12, v * 7.0 + 25, 61, 4);
    let a = smoothstep(1.0, 0.05, r * (1 + (det - 0.5) * 0.5)) * (0.30 + 0.9 * det);
    a = clamp01(a) * 0.85;
    o[0] = 0.92; o[1] = 0.90; o[2] = 0.88; o[3] = a;
  },
  // 3 SPARK — tight core with a short bloom; stretched by the shader into arcs.
  (u, v, o) => {
    const r2 = u * u + v * v;
    const a = clamp01(Math.exp(-r2 * 14.0) + Math.exp(-r2 * 2.6) * 0.16);
    o[0] = 1.0; o[1] = 0.92; o[2] = 0.80; o[3] = a;
  },
  // 4 FLAME — hot turbulent blob. The tile itself cools toward the edge so a
  // fireball has a white core without needing two draws.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const turb = fbm2(u * 2.8 + 3, v * 2.8 - 11, 81, 5);
    const rr = r * (1 + (turb - 0.5) * 0.7);
    const a = clamp01(smoothstep(1.0, 0.1, rr) * (0.5 + 0.7 * turb));
    const core = smoothstep(0.62, 0.0, rr);
    o[0] = 1.0;
    o[1] = 0.42 + 0.58 * core;
    o[2] = 0.12 + 0.80 * core * core;
    o[3] = a;
  },
  // 5 FLARE — muzzle-flash star: six lobes over a hot core plus one long
  // horizontal streak, the signature of a compensator's side ports.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const ang = Math.atan2(v, u);
    let a = Math.exp(-r * r * 9.0);
    a += Math.pow(Math.abs(Math.cos(ang * 3.0)), 9) * Math.exp(-r * 2.6) * 0.85;
    a += Math.pow(Math.abs(Math.cos(ang)), 48) * Math.exp(-r * 1.7) * 0.55;
    a = clamp01(a * (0.85 + 0.3 * noise2(ang * 4.0, r * 6.0, 91)));
    const core = smoothstep(0.45, 0.0, r);
    o[0] = 1.0; o[1] = 0.66 + 0.34 * core; o[2] = 0.30 + 0.70 * core; o[3] = a;
  },
  // 6 CHIP — an opaque irregular flake, for concrete spall and grit.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const ang = Math.atan2(v, u);
    const edge = 0.55 + 0.30 * noise2(Math.cos(ang) * 2.2 + 5, Math.sin(ang) * 2.2 - 7, 101);
    const a = smoothstep(edge + 0.06, edge - 0.06, r);
    // Fake AO toward the silhouette so the flake reads as a solid body.
    const l = 0.55 + 0.45 * smoothstep(edge, edge * 0.25, r);
    o[0] = l; o[1] = l * 0.98; o[2] = l * 0.94; o[3] = a;
  },
  // 7 BLOOD — a cluster of droplets rather than one disc.
  (u, v, o) => {
    let a = 0;
    for (let i = 0; i < 5; i++) {
      const ax = (hash2i(i, 3, 121) - 0.5) * 0.9;
      const ay = (hash2i(i, 9, 122) - 0.5) * 0.9;
      const rad = 0.18 + hash2i(i, 17, 123) * 0.30;
      a = Math.max(a, smoothstep(rad, rad * 0.35, Math.hypot(u - ax, v - ay)));
    }
    a *= 0.55 + 0.45 * fbm2(u * 5 + 2, v * 5 - 6, 124, 3);
    o[0] = 1.0; o[1] = 0.24; o[2] = 0.16; o[3] = clamp01(a);
  },
  // 8 RING — a thin soft annulus for shockwaves and expanding shells.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const d = (r - 0.78) / 0.11;
    const a = Math.exp(-d * d) * (0.7 + 0.3 * noise2(Math.atan2(v, u) * 3.0, 0, 141));
    o[0] = 1.0; o[1] = 1.0; o[2] = 1.0; o[3] = clamp01(a);
  },
  // 9 SPLINTER — a tapered sliver of wood.
  (u, v, o) => {
    const w = 0.16 * (1 - Math.abs(v)) * (1 - Math.abs(v));
    const a = smoothstep(w + 0.03, w - 0.03, Math.abs(u + v * 0.18));
    const l = 0.5 + 0.5 * noise2(v * 9.0, 0, 151);
    o[0] = 0.78 * l; o[1] = 0.58 * l; o[2] = 0.34 * l; o[3] = clamp01(a);
  },
  // 10 GLASS — an angular shard with a bright specular edge.
  (u, v, o) => {
    const ang = Math.atan2(v, u);
    const r = Math.hypot(u, v);
    const edge = 0.40 + 0.34 * Math.abs(Math.cos(ang * 1.5 + 0.6));
    const a = smoothstep(edge + 0.03, edge - 0.03, r);
    const rim = smoothstep(edge - 0.20, edge, r);
    const l = 0.35 + 0.9 * rim;
    o[0] = l * 0.86; o[1] = l * 0.95; o[2] = l; o[3] = clamp01(a);
  },
  // 11 MOTE — a dust speck in the air: a point with a faint halo.
  (u, v, o) => {
    const r2 = u * u + v * v;
    const a = clamp01(Math.exp(-r2 * 22.0) + Math.exp(-r2 * 3.2) * 0.10);
    o[0] = 1.0; o[1] = 0.98; o[2] = 0.94; o[3] = a;
  },
  // 12 WATER — droplet with a bright leading rim.
  (u, v, o) => {
    const r = Math.hypot(u, v * 1.25);
    const a = smoothstep(0.62, 0.30, r);
    const rim = smoothstep(0.30, 0.60, r) * smoothstep(0.66, 0.55, r);
    const l = 0.55 + 0.75 * rim;
    o[0] = l * 0.82; o[1] = l * 0.92; o[2] = l; o[3] = clamp01(a);
  },
  // 13 DENSE — packed grenade smoke, near-opaque in the middle.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const warp = fbm2(u * 1.7 + 44, v * 1.7 + 12, 161, 4) - 0.5;
    const det = fbm2(u * 3.4 - 8, v * 3.4 + 21, 162, 5);
    const a = clamp01(smoothstep(1.0, 0.30, r * (1 + warp * 0.55)) * (0.7 + 0.5 * det));
    const shade = 0.62 + 0.38 * det;
    o[0] = shade; o[1] = shade; o[2] = shade; o[3] = a;
  },
  // 14 SPALL — a lumpy cluster: pulverised masonry leaving the wall.
  (u, v, o) => {
    let a = 0;
    for (let i = 0; i < 6; i++) {
      const ax = (hash2i(i, 5, 171) - 0.5) * 1.0;
      const ay = (hash2i(i, 11, 172) - 0.5) * 1.0;
      const rad = 0.22 + hash2i(i, 23, 173) * 0.26;
      a = Math.max(a, smoothstep(rad, rad * 0.15, Math.hypot(u - ax, v - ay)));
    }
    const det = fbm2(u * 6 + 13, v * 6 - 5, 174, 4);
    a *= 0.45 + 0.75 * det;
    const l = 0.6 + 0.4 * det;
    o[0] = l; o[1] = l * 0.97; o[2] = l * 0.92; o[3] = clamp01(a);
  },
  // 15 CRACK — radial fracture lines, used as a glass-impact flash sprite.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const ang = Math.atan2(v, u);
    const spokes = 11;
    const k = Math.abs(((ang / TAU * spokes + 0.5 + noise2(r * 3.0, 0, 181) * 0.35) % 1) - 0.5) * 2;
    let a = smoothstep(0.16, 0.0, k) * smoothstep(1.0, 0.1, r);
    a = Math.max(a, smoothstep(0.05, 0.0, Math.abs(r - 0.42)) * 0.5);
    o[0] = 0.9; o[1] = 0.96; o[2] = 1.0; o[3] = clamp01(a);
  },
];

/**
 * @param {number} tile pixels per tile
 * @returns {THREE.DataTexture} 4x4 RGBA atlas, sRGB, mipmapped
 */
export function buildParticleAtlas(tile = 128) {
  const W = tile * ATLAS_COLS, H = tile * ATLAS_COLS;
  const data = new Uint8Array(W * H * 4);
  const o = [0, 0, 0, 0];

  for (let t = 0; t < PARTICLE_TILES.length; t++) {
    const gen = PARTICLE_TILES[t];
    const ox = (t % ATLAS_COLS) * tile;
    const oy = Math.floor(t / ATLAS_COLS) * tile;
    for (let y = 0; y < tile; y++) {
      const v = ((y + 0.5) / tile) * 2 - 1;
      for (let x = 0; x < tile; x++) {
        const u = ((x + 0.5) / tile) * 2 - 1;
        gen(u, v, o);
        // Keep the tile border empty so coarse mips cannot bleed neighbours in.
        const border = 1 - smoothstep(0.86, 1.0, Math.max(Math.abs(u), Math.abs(v)));
        const i = ((oy + y) * W + (ox + x)) * 4;
        data[i] = clamp01(o[0]) * 255;
        data[i + 1] = clamp01(o[1]) * 255;
        data[i + 2] = clamp01(o[2]) * 255;
        data[i + 3] = clamp01(o[3]) * border * 255;
      }
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.name = 'fx-particle-atlas';
  return tex;
}

/* ----------------------------------------------------------- decal atlas */

export const DT = {
  CONCRETE: 0, METAL: 1, WOOD: 2, GLASS: 3,
  SAND: 4, PLASTER: 5, BRICK: 6, SCORCH: 7,
  FABRIC: 8, BLOOD: 9,
};

/**
 * Each generator writes [height, coverage, r, g, b].
 * `height` is depth INTO the surface (1 = deepest), used for the normal map.
 */
const DECAL_TILES = [
  // 0 CONCRETE — punched hole, pulverised spall ring, dust halo.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const n = fbm2(u * 3.1 + 5, v * 3.1 - 2, 21, 4);
    const rn = r * (1 + (n - 0.5) * 0.40);
    const hole = smoothstep(0.30, 0.07, rn);
    const spall = smoothstep(0.66, 0.24, rn) * (0.35 + 0.65 * fbm2(u * 6 + 3, v * 6 + 8, 22, 3));
    const dust = smoothstep(1.0, 0.42, rn) * 0.7 * fbm2(u * 5 - 9, v * 5 + 4, 23, 3);
    o[0] = clamp01(hole + spall * 0.30);
    o[1] = clamp01(hole * 1.2 + spall * 0.9 + dust * 0.45);
    const l = 0.07 + 0.55 * spall * (1 - hole) + 0.85 * dust * (1 - hole);
    o[2] = l; o[3] = l * 0.985; o[4] = l * 0.95;
  },
  // 1 METAL — a small clean perforation with a bright burred lip and heat tint.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const ang = Math.atan2(v, u);
    const petal = 1 + 0.16 * Math.cos(ang * 5.0 + noise2(u * 4, v * 4, 31) * 3.0);
    const rn = r * petal;
    const hole = smoothstep(0.20, 0.09, rn);
    const lip = smoothstep(0.16, 0.26, rn) * smoothstep(0.40, 0.27, rn);
    const scuff = smoothstep(0.75, 0.20, rn) * fbm2(u * 9 + 2, v * 9 - 4, 32, 3) * 0.6;
    // The lip is raised metal, so it gets a *negative* depth.
    o[0] = clamp01(hole - lip * 0.55 + 0.5);
    o[1] = clamp01(hole * 1.3 + lip * 1.1 + scuff * 0.55);
    const bright = 0.06 + 0.95 * lip + 0.30 * scuff;
    // Bare steel under paint reads slightly blue; the heat ring runs warm.
    o[2] = bright * (1 + 0.18 * lip);
    o[3] = bright * (1 + 0.05 * lip);
    o[4] = bright * (1 + 0.10 * (1 - lip));
  },
  // 2 WOOD — a ragged hole with fibres torn along the grain.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const grain = ridge2(u * 1.4, v * 11.0, 41, 3);
    const rn = r * (1 + (grain - 0.5) * 0.55);
    const hole = smoothstep(0.26, 0.08, rn);
    const tear = smoothstep(0.70, 0.20, rn) * Math.pow(grain, 1.6);
    o[0] = clamp01(hole + tear * 0.35);
    o[1] = clamp01(hole * 1.25 + tear * 1.0);
    // Exposed inner wood is paler than the weathered face.
    const l = 0.05 + 0.72 * tear * (1 - hole);
    o[2] = l * 1.0; o[3] = l * 0.80; o[4] = l * 0.52;
  },
  // 3 GLASS — radial fracture with concentric shear rings.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const ang = Math.atan2(v, u);
    const spokes = 13;
    const jitter = noise2(r * 4.0, ang * 2.0, 51) * 0.5;
    const k = Math.abs(((ang / TAU * spokes + 0.5 + jitter) % 1) - 0.5) * 2;
    const radial = smoothstep(0.20, 0.0, k) * smoothstep(1.0, 0.06, r);
    const rings = smoothstep(0.05, 0.0, Math.abs(r - 0.34)) * 0.6
      + smoothstep(0.04, 0.0, Math.abs(r - 0.58)) * 0.4;
    const hole = smoothstep(0.11, 0.03, r);
    const cracks = clamp01(radial + rings * smoothstep(1.0, 0.2, r));
    o[0] = clamp01(hole + cracks * 0.5);
    o[1] = clamp01(hole * 1.4 + cracks * 0.95);
    const l = 0.02 + 0.95 * cracks * (1 - hole);
    o[2] = l * 0.88; o[3] = l * 0.95; o[4] = l;
  },
  // 4 SAND — a soft crater with no rim; grains slump back into it.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const n = fbm2(u * 4.0 - 3, v * 4.0 + 9, 61, 4);
    const rn = r * (1 + (n - 0.5) * 0.30);
    const pit = smoothstep(0.55, 0.0, rn);
    const throwOut = smoothstep(1.0, 0.45, rn) * n * 0.8;
    o[0] = clamp01(pit * 0.8);
    o[1] = clamp01(pit * 1.1 + throwOut * 0.5);
    // Damp sand from below is darker; the thrown grains are paler and drier.
    const l = 0.30 - 0.18 * pit + 0.55 * throwOut;
    o[2] = l * 1.0; o[3] = l * 0.91; o[4] = l * 0.72;
  },
  // 5 PLASTER — small entry hole inside a large flaked patch of paint.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const flakeEdge = 0.52 + 0.28 * fbm2(u * 2.4 + 17, v * 2.4 - 6, 71, 3);
    const flake = smoothstep(flakeEdge + 0.05, flakeEdge - 0.05, r);
    const hole = smoothstep(0.17, 0.05, r * (1 + (noise2(u * 5, v * 5, 72) - 0.5) * 0.4));
    o[0] = clamp01(hole + flake * 0.18);
    o[1] = clamp01(hole * 1.4 + flake * 0.95);
    const l = 0.05 + 0.88 * flake * (1 - hole);
    o[2] = l; o[3] = l * 0.985; o[4] = l * 0.96;
  },
  // 6 BRICK / TILE — an angular chip, not a round hole: fired clay shears.
  (u, v, o) => {
    const ang = Math.atan2(v, u);
    const r = Math.hypot(u, v);
    const facets = 0.34 + 0.26 * Math.abs(Math.cos(ang * 2.0 + noise2(u * 3, v * 3, 81) * 2.4));
    const chip = smoothstep(facets + 0.04, facets - 0.04, r);
    const dust = smoothstep(0.95, facets, r) * 0.45 * fbm2(u * 6 - 2, v * 6 + 5, 82, 3);
    o[0] = clamp01(chip * 0.9);
    o[1] = clamp01(chip * 1.3 + dust * 0.6);
    const l = 0.10 + 0.55 * chip + 0.7 * dust;
    o[2] = l * 1.0; o[3] = l * 0.72; o[4] = l * 0.60;
  },
  // 7 SCORCH — the wide soot star an explosion leaves.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const ang = Math.atan2(v, u);
    const lobes = 0.72 + 0.28 * fbm2(Math.cos(ang) * 1.6, Math.sin(ang) * 1.6, 91, 3);
    const soot = smoothstep(lobes, 0.05, r) * (0.5 + 0.5 * fbm2(u * 3.5 + 4, v * 3.5 - 8, 92, 4));
    const streak = Math.pow(clamp01(1 - Math.abs(((ang / TAU * 17 + 0.5) % 1) - 0.5) * 3), 3)
      * smoothstep(1.0, 0.2, r) * 0.5;
    o[0] = 0.5;                                   // soot is a stain, not a dent
    o[1] = clamp01(soot * 1.1 + streak * 0.5);
    const l = 0.03 + 0.06 * (1 - soot);
    o[2] = l; o[3] = l * 0.95; o[4] = l * 0.90;
  },
  // 8 FABRIC — a puncture that tears rather than cuts.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const ang = Math.atan2(v, u);
    const tear = Math.pow(clamp01(1 - Math.abs(((ang / TAU * 4 + 0.5 + noise2(r * 3, 0, 101) * 0.3) % 1) - 0.5) * 4), 2);
    const hole = smoothstep(0.16 + tear * 0.22, 0.03, r);
    const fray = smoothstep(0.45, 0.12, r) * fbm2(u * 8 + 6, v * 8 - 2, 102, 3) * 0.7;
    o[0] = clamp01(hole * 0.8 + fray * 0.2);
    o[1] = clamp01(hole * 1.4 + fray * 0.8);
    const l = 0.04 + 0.35 * fray * (1 - hole);
    o[2] = l; o[3] = l * 0.95; o[4] = l * 0.88;
  },
  // 9 BLOOD — a splat with directional cast-off droplets.
  (u, v, o) => {
    const r = Math.hypot(u, v);
    const blob = smoothstep(0.42 + 0.16 * fbm2(u * 2.6 + 3, v * 2.6 + 7, 111, 3), 0.05, r);
    let drops = 0;
    for (let i = 0; i < 9; i++) {
      const a = hash2i(i, 1, 112) * TAU;
      const d = 0.35 + hash2i(i, 2, 113) * 0.6;
      const rad = 0.03 + hash2i(i, 3, 114) * 0.06;
      drops = Math.max(drops, smoothstep(rad, 0.0, Math.hypot(u - Math.cos(a) * d, v - Math.sin(a) * d)));
    }
    o[0] = 0.5;
    o[1] = clamp01(blob + drops);
    const l = 0.10 + 0.10 * (1 - blob);
    o[2] = l * 3.2; o[3] = l * 0.35; o[4] = l * 0.28;
  },
];

/**
 * @param {number} tile pixels per tile
 * @returns {{albedo:THREE.DataTexture, normal:THREE.DataTexture, tiles:number}}
 */
export function buildDecalAtlas(tile = 128) {
  const W = tile * ATLAS_COLS, H = tile * ATLAS_COLS;
  const albedo = new Uint8Array(W * H * 4);
  const normal = new Uint8Array(W * H * 4);
  const height = new Float32Array(tile * tile);
  const o = [0, 0, 0, 0, 0];

  for (let t = 0; t < DECAL_TILES.length; t++) {
    const gen = DECAL_TILES[t];
    const ox = (t % ATLAS_COLS) * tile;
    const oy = Math.floor(t / ATLAS_COLS) * tile;

    for (let y = 0; y < tile; y++) {
      const v = ((y + 0.5) / tile) * 2 - 1;
      for (let x = 0; x < tile; x++) {
        const u = ((x + 0.5) / tile) * 2 - 1;
        gen(u, v, o);
        const border = 1 - smoothstep(0.88, 1.0, Math.max(Math.abs(u), Math.abs(v)));
        const cov = clamp01(o[1]) * border;
        height[y * tile + x] = clamp01(o[0]) * cov;
        const i = ((oy + y) * W + (ox + x)) * 4;
        albedo[i] = clamp01(o[2]) * 255;
        albedo[i + 1] = clamp01(o[3]) * 255;
        albedo[i + 2] = clamp01(o[4]) * 255;
        albedo[i + 3] = cov * 255;
      }
    }

    // Tangent normal from the height field. The gradient is scaled by the tile
    // resolution so a crater's slope is resolution independent.
    const strength = 2.4;
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const xm = Math.max(x - 1, 0), xp = Math.min(x + 1, tile - 1);
        const ym = Math.max(y - 1, 0), yp = Math.min(y + 1, tile - 1);
        const dx = (height[y * tile + xp] - height[y * tile + xm]) * strength;
        const dy = (height[yp * tile + x] - height[ym * tile + x]) * strength;
        // Height is depth, so a positive gradient tilts the surface away.
        let nx = dx, ny = dy, nz = 1 / 3.0;
        const inv = 1 / Math.hypot(nx, ny, nz);
        nx *= inv; ny *= inv; nz *= inv;
        const i = ((oy + y) * W + (ox + x)) * 4;
        normal[i] = (nx * 0.5 + 0.5) * 255;
        normal[i + 1] = (ny * 0.5 + 0.5) * 255;
        normal[i + 2] = (nz * 0.5 + 0.5) * 255;
        normal[i + 3] = 255;
      }
    }
  }

  const albedoTex = new THREE.DataTexture(albedo, W, H, THREE.RGBAFormat);
  albedoTex.colorSpace = THREE.SRGBColorSpace;
  albedoTex.minFilter = THREE.LinearMipmapLinearFilter;
  albedoTex.magFilter = THREE.LinearFilter;
  albedoTex.generateMipmaps = true;
  albedoTex.needsUpdate = true;
  albedoTex.name = 'fx-decal-albedo';

  const normalTex = new THREE.DataTexture(normal, W, H, THREE.RGBAFormat);
  normalTex.colorSpace = THREE.NoColorSpace;
  normalTex.minFilter = THREE.LinearMipmapLinearFilter;
  normalTex.magFilter = THREE.LinearFilter;
  normalTex.generateMipmaps = true;
  normalTex.needsUpdate = true;
  normalTex.name = 'fx-decal-normal';

  return { albedo: albedoTex, normal: normalTex, tiles: ATLAS_COLS };
}

/* ------------------------------------------------------- flash sprites */

/**
 * The viewmodel muzzle flash draws with built-in materials (it renders after
 * the post stack, so it needs three's tonemap/colour-space chunks), which means
 * it needs its own small textures rather than a tile of the atlas.
 */
export function buildFlashTexture(size = 128, kind = 'star') {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = ((y + 0.5) / size) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const r = Math.hypot(u, v);
      const ang = Math.atan2(v, u);
      let a, g, b;
      if (kind === 'star') {
        a = Math.exp(-r * r * 11.0)
          + Math.pow(Math.abs(Math.cos(ang * 2.5)), 10) * Math.exp(-r * 3.0) * 0.8
          + Math.pow(Math.abs(Math.cos(ang)), 60) * Math.exp(-r * 2.0) * 0.6;
        a *= 0.8 + 0.4 * noise2(ang * 5.0, r * 5.0, 201);
        const core = smoothstep(0.40, 0.0, r);
        g = 0.55 + 0.45 * core; b = 0.20 + 0.80 * core;
      } else if (kind === 'core') {
        a = Math.exp(-r * r * 6.0) * (0.75 + 0.5 * fbm2(u * 3 + 4, v * 3 - 2, 202, 3));
        const core = smoothstep(0.55, 0.0, r);
        g = 0.62 + 0.38 * core; b = 0.28 + 0.72 * core;
      } else { // 'cone' — the gas column leaving the crown, brightest at the base
        const along = clamp01((v + 1) * 0.5);
        const width = 0.10 + 0.55 * along * along;
        a = smoothstep(width, 0.0, Math.abs(u)) * (1 - along) * (0.6 + 0.6 * noise2(u * 6, v * 4, 203));
        g = 0.60; b = 0.30;
      }
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = clamp01(g) * 255;
      data[i + 2] = clamp01(b) * 255;
      data[i + 3] = clamp01(a) * (1 - smoothstep(0.88, 1.0, Math.max(Math.abs(u), Math.abs(v)))) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.name = `fx-flash-${kind}`;
  return tex;
}
