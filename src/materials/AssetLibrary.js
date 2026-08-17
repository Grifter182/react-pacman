import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

/**
 * Authored art assets, as opposed to the procedurally generated ones.
 *
 * Everything here is built by `tools/build_assets.py` from the raw ambientCG
 * downloads and lives in `public/`:
 *
 *   textures/<name>/color.jpg    sRGB albedo
 *   textures/<name>/normal.jpg   tangent-space normal, OpenGL convention
 *   textures/<name>/orm.jpg      AO in R, roughness in G, metalness in B
 *   env/<name>.hdr               equirect RGBE radiance probe
 *   env/<name>.json              sun direction and luminance, measured from it
 *
 * ORM PACKING. MeshStandardMaterial samples `aoMap.r`, `roughnessMap.g` and
 * `metalnessMap.b`, so pointing all three at one texture is not a trick — it
 * is exactly the glTF convention, and it turns three samplers into one.
 *
 * COLOUR SPACE. Only the albedo is sRGB. Normal and ORM carry measurements,
 * not colour, and decoding them through a gamma curve would bend every normal
 * and skew every roughness value. This is the single easiest thing to get
 * wrong and it looks like a lighting bug, not a texture bug.
 *
 * Loading is lazy and cached: nothing is fetched until something asks for it,
 * and asking twice returns the same promise.
 */

const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';

/** Materials shipped as authored texture sets. */
export const TEXTURE_SETS = {
  rock063: { tiling: 2.0, label: 'Rock / rubble ground' },
  metal053c: { tiling: 1.0, label: 'Painted sheet metal' },
};

export const ENVIRONMENTS = {
  daysky: { label: 'Exterior daylight' },
  indoor: { label: 'Interior bounce' },
};

const _texCache = new Map();
const _envCache = new Map();
const _texLoader = new THREE.TextureLoader();
let _hdrLoader = null;

function url(p) {
  return `${BASE}${p}`.replace(/([^:])\/{2,}/g, '$1/');
}

function loadTexture(path, { srgb = false, aniso = 8 } = {}) {
  return new Promise((resolve, reject) => {
    _texLoader.load(url(path), (t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = aniso;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.needsUpdate = true;
      resolve(t);
    }, undefined, reject);
  });
}

/**
 * Load one authored texture set.
 * @returns {Promise<{map, normalMap, ormMap}>}
 */
export function loadTextureSet(name, { anisotropy = 8 } = {}) {
  const key = `${name}:${anisotropy}`;
  if (_texCache.has(key)) return _texCache.get(key);
  const p = Promise.all([
    loadTexture(`textures/${name}/color.jpg`, { srgb: true, aniso: anisotropy }),
    loadTexture(`textures/${name}/normal.jpg`, { aniso: anisotropy }),
    loadTexture(`textures/${name}/orm.jpg`, { aniso: anisotropy }),
  ]).then(([map, normalMap, ormMap]) => ({ map, normalMap, ormMap }));
  _texCache.set(key, p);
  return p;
}

/**
 * Build a MeshStandardMaterial from an authored set.
 *
 * `repeat` is in tiles across one unit of UV. Callers that lay out geometry in
 * metres should pass metres-per-tile through `worldScale` instead, so the
 * texel density is decided by the surface's real size rather than by whatever
 * UV range it happens to have.
 */
export async function makeAuthoredMaterial(name, opts = {}) {
  const set = await loadTextureSet(name, { anisotropy: opts.anisotropy ?? 8 });
  const repeat = opts.repeat ?? TEXTURE_SETS[name]?.tiling ?? 1;

  // Textures are shared between materials, so a per-material repeat has to be
  // its own clone or the last caller wins for everyone.
  const map = set.map.clone();
  const normalMap = set.normalMap.clone();
  const ormMap = set.ormMap.clone();
  for (const t of [map, normalMap, ormMap]) {
    t.repeat.set(repeat, repeat);
    t.needsUpdate = true;
  }

  const mat = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    aoMap: ormMap,
    roughnessMap: ormMap,
    metalnessMap: ormMap,
    // The scalar multiplies the map, so it must be 1 for the map to survive.
    roughness: 1.0,
    metalness: 1.0,
    normalScale: new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1),
    envMapIntensity: opts.envMapIntensity ?? 1.0,
    ...(opts.material || {}),
  });
  mat.userData.authored = name;
  return mat;
}

/**
 * Load an HDRI probe plus the sun measured from it at build time.
 * @returns {Promise<{texture, meta}>} texture is equirect-mapped, ready for
 *   `scene.background` or PMREM.
 */
export function loadEnvironment(name) {
  if (_envCache.has(name)) return _envCache.get(name);
  if (!_hdrLoader) _hdrLoader = new HDRLoader();

  const tex = new Promise((resolve, reject) => {
    _hdrLoader.load(url(`env/${name}.hdr`), (t) => {
      t.mapping = THREE.EquirectangularReflectionMapping;
      resolve(t);
    }, undefined, reject);
  });

  // The sidecar is an optimisation, not a requirement — a missing or malformed
  // one must not take the environment down with it.
  const meta = fetch(url(`env/${name}.json`))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  const p = Promise.all([tex, meta]).then(([texture, m]) => ({ texture, meta: m }));
  _envCache.set(name, p);
  return p;
}

/**
 * Sun direction from a probe's metadata, as a unit vector pointing FROM the
 * world TO the sun — the same convention `engine.sunDirection` uses.
 */
export function sunDirectionFromMeta(meta, fallback = [0.42, 0.52, -0.74]) {
  const d = meta?.direction && meta.direction.length === 3 ? meta.direction : fallback;
  return new THREE.Vector3(d[0], d[1], d[2]).normalize();
}

export function disposeAssets() {
  for (const p of _texCache.values()) {
    p.then((s) => { s.map.dispose(); s.normalMap.dispose(); s.ormMap.dispose(); }).catch(() => {});
  }
  _texCache.clear();
  for (const p of _envCache.values()) {
    p.then(({ texture }) => texture.dispose()).catch(() => {});
  }
  _envCache.clear();
}
