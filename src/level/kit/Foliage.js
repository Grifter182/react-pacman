import * as THREE from 'three';
import { GeoBuilder, rng, lerp, clamp01 } from './Geo.js';

/**
 * OWNER: level-art agent.
 *
 * Instanced, alpha-tested foliage with wind.
 *
 * Three constraints shape this: no external textures, no per-frame CPU cost,
 * and no alpha blending (sorting a thousand transparent cards against a
 * deferred-ish post stack is not worth it). So: procedurally baked RGBA cards,
 * `alphaTest` cutout, one InstancedMesh per species part, and the motion lives
 * entirely in the vertex shader driven by a single time uniform.
 *
 * The cards' normals are deliberately *not* the card's geometric normal. A flat
 * quad lit by its own normal goes black the moment it turns edge-on to the sun,
 * which is exactly when a palm should be glowing. Instead each vertex is given
 * a normal blended toward the crown's outward/upward direction, which
 * approximates the light response of the volume the card is standing in for.
 *
 * TODO(materials): a `palm_frond` / `dry_scrub` recipe with proper translucency
 * (a two-sided wrap term) would beat these hand-rolled cards. Until then the
 * albedo/alpha is baked here and the material is a plain standard material.
 */

/* ------------------------------------------------------------- textures */

function makeTexture(N, fill) {
  const data = new Uint8Array(N * N * 4);
  fill(data, N);
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/**
 * One palm frond, pointing along +U with the rachis on the V centre line.
 * Leaflets are drawn as tapering wedges swept back from the rachis at a
 * shallow angle, thinning and drying toward the tip.
 */
function bakeFrond(N = 256) {
  return makeTexture(N, (d) => {
    const r = rng(0x9a71);
    const nLeaf = 34;
    const leaves = [];
    for (let i = 0; i < nLeaf; i++) {
      const t = i / (nLeaf - 1);
      leaves.push({ t, side: i % 2 ? 1 : -1, len: 0.30 * Math.sin(Math.PI * clamp01(t * 1.15)) * (0.75 + r() * 0.5), sweep: 0.42 + r() * 0.16 });
    }
    for (let y = 0; y < N; y++) {
      const v = (y + 0.5) / N - 0.5;          // -0.5 .. 0.5 across the frond
      for (let x = 0; x < N; x++) {
        const u = (x + 0.5) / N;              // 0 at base, 1 at tip
        const i = (y * N + x) * 4;
        let a = 0, dry = 0;

        // Rachis: a thin spine that tapers to nothing.
        const spine = 0.016 * (1 - u * 0.85);
        if (Math.abs(v) < spine && u < 0.99) a = 1;

        for (const lf of leaves) {
          if (u < lf.t) continue;
          const du = u - lf.t;
          if (du > lf.sweep) continue;
          // Leaflet centre-line: sweeps outward from the rachis and back.
          const centre = lf.side * (du / lf.sweep) * lf.len;
          const halfW = (0.012 + 0.010 * Math.sin((du / lf.sweep) * Math.PI)) * (1 - du / lf.sweep * 0.55);
          if (Math.abs(v - centre) < halfW) {
            a = 1;
            dry = Math.max(dry, clamp01((u - 0.55) / 0.5) * 0.9 + (du / lf.sweep) * 0.25);
          }
        }
        if (a > 0) {
          // Green through to sun-bleached straw at the tips, with a darker
          // midrib on every leaflet.
          const shade = 0.82 + 0.18 * Math.sin(v * 420.0);
          const g = lerp(0.30, 0.62, dry) * shade;
          d[i] = (lerp(0.13, 0.55, dry) * 255) | 0;
          d[i + 1] = (g * 255) | 0;
          d[i + 2] = (lerp(0.05, 0.26, dry) * 255) | 0;
          d[i + 3] = 255;
        } else {
          d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0;
        }
      }
    }
  });
}

/** Dry scrub / thorn bush: a tangle of fine twigs and sparse leaves. */
function bakeScrub(N = 128) {
  return makeTexture(N, (d, S) => {
    const r = rng(0x51c3);
    const alpha = new Float32Array(S * S);
    const stems = 26;
    for (let s = 0; s < stems; s++) {
      let x = S * (0.36 + r() * 0.28), y = S - 1;
      let ang = -Math.PI / 2 + (r() - 0.5) * 1.5;
      const len = S * (0.35 + r() * 0.55);
      for (let step = 0; step < len; step++) {
        ang += (r() - 0.5) * 0.22;
        x += Math.cos(ang); y += Math.sin(ang);
        if (x < 1 || x > S - 2 || y < 1 || y > S - 1) break;
        const w = step < len * 0.7 ? 1 : 0;
        for (let oy = -w; oy <= w; oy++) {
          for (let ox = -w; ox <= w; ox++) {
            const px = (x + ox) | 0, py = (y + oy) | 0;
            if (px >= 0 && px < S && py >= 0 && py < S) alpha[py * S + px] = 1;
          }
        }
        if (step > len * 0.3 && r() < 0.06) {
          // Leaf clump.
          const lr = 2 + r() * 3;
          for (let oy = -lr; oy <= lr; oy++) {
            for (let ox = -lr; ox <= lr; ox++) {
              if (ox * ox + oy * oy > lr * lr) continue;
              const px = (x + ox) | 0, py = (y + oy) | 0;
              if (px >= 0 && px < S && py >= 0 && py < S) alpha[py * S + px] = 2;
            }
          }
        }
      }
    }
    for (let i = 0; i < S * S; i++) {
      const j = i * 4;
      const a = alpha[i];
      if (a === 0) { d[j] = d[j + 1] = d[j + 2] = d[j + 3] = 0; continue; }
      const leaf = a > 1;
      const n = 0.85 + 0.3 * ((i * 2654435761) % 97) / 97;
      d[j] = ((leaf ? 0.34 : 0.30) * n * 255) | 0;
      d[j + 1] = ((leaf ? 0.40 : 0.26) * n * 255) | 0;
      d[j + 2] = ((leaf ? 0.16 : 0.14) * n * 255) | 0;
      d[j + 3] = 255;
    }
  });
}

/* --------------------------------------------------------------- shader */

const WIND_PARS = /* glsl */`
attribute float aFlex;
uniform float uWindTime;
uniform vec3 uWind;     // xy direction in object space, z amplitude
`;

const WIND_BODY = /* glsl */`
  #ifdef USE_INSTANCING
    vec3 lvOrigin = instanceMatrix[3].xyz;
  #else
    vec3 lvOrigin = vec3( 0.0 );
  #endif
  // Phase from world position: neighbouring plants must not move in lockstep,
  // and a hash of the instance origin is free and stable across frames.
  float ph = dot( lvOrigin.xz, vec2( 0.73, 0.41 ) );
  float t = uWindTime;
  // Three octaves: a slow breathing sway, the gust that rides on it, and a
  // fast flutter that only the tips (high aFlex) really express.
  float sway = sin( t * 1.15 + ph ) * 0.62
             + sin( t * 2.43 + ph * 1.7 ) * 0.26
             + sin( t * 5.90 + ph * 0.6 ) * 0.12;
  float f = aFlex * aFlex;
  transformed.xz += uWind.xy * ( sway * uWind.z * f );
  // Foreshortening: a bent frond is no longer as long as a straight one.
  transformed.y -= abs( sway ) * uWind.z * f * 0.22;
`;

function makeFoliageMaterial(map, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map,
    alphaTest: opts.alphaTest ?? 0.45,
    side: THREE.DoubleSide,
    roughness: 0.82,
    metalness: 0.0,
    envMapIntensity: 0.9,
    dithering: true,
  });
  const uniforms = {
    uWindTime: { value: 0 },
    uWind: { value: new THREE.Vector3(opts.dirX ?? 0.85, opts.dirZ ?? 0.35, opts.amp ?? 0.16) },
  };
  mat.userData.windUniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WIND_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_BODY);
  };
  mat.customProgramCacheKey = () => 'lvfoliage';
  return mat;
}

/* ------------------------------------------------------------ geometry */

/** Push one card, with `flex` ramping 0 (root) → 1 (tip) along the card. */
function card(b, flexArr, quadPts, uv, flexAt) {
  const start = b.vertexCount;
  b.quad(quadPts[0], quadPts[1], quadPts[2], quadPts[3], 0);
  const added = b.vertexCount - start;
  // quad() emits two triangles as p0,p1,p2 / p0,p2,p3.
  const order = [0, 1, 2, 0, 2, 3];
  for (let i = 0; i < added; i++) flexArr.push(flexAt[order[i % 6]]);
  // Rewrite the UVs the builder generated from its planar projection: a card
  // needs its own texture space, not a world projection.
  const uvo = [uv[0], uv[1], uv[2], uv[3]];
  const base = start * 2;
  for (let i = 0; i < added; i++) {
    const k = order[i % 6];
    b.uv[base + i * 2] = uvo[k][0];
    b.uv[base + i * 2 + 1] = uvo[k][1];
  }
}

/**
 * Palm crown: fronds radiating from the origin, drooping under their own
 * weight. Returns { geometry, } with the aFlex attribute attached.
 */
function buildCrown(seed = 4) {
  const b = new GeoBuilder({ uvScale: 1, weather: null });
  const flex = [];
  const r = rng(seed);
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.3;
    const len = 2.5 + r() * 0.9;
    const w = 0.52 + r() * 0.16;
    const droop = 0.55 + r() * 0.5;
    const lift = 0.65 + r() * 0.45;
    const ca = Math.cos(a), sa = Math.sin(a);
    // Base, mid and tip of the rachis: rises then falls.
    const P = (t) => [ca * len * t, lift * Math.sin(t * 1.5) - droop * t * t * 1.6, sa * len * t];
    const side = [-sa * w, 0, ca * w];
    for (let seg = 0; seg < 3; seg++) {
      const t0 = seg / 3, t1 = (seg + 1) / 3;
      const p0 = P(t0), p1 = P(t1);
      const w0 = (1 - t0 * 0.55), w1 = (1 - t1 * 0.55);
      // A slight twist along the frond so it is not a flat plane.
      const tw = (t) => Math.sin(t * 2.2) * 0.13;
      const q = [
        [p0[0] - side[0] * w0, p0[1] - tw(t0), p0[2] - side[2] * w0],
        [p1[0] - side[0] * w1, p1[1] - tw(t1), p1[2] - side[2] * w1],
        [p1[0] + side[0] * w1, p1[1] + tw(t1), p1[2] + side[2] * w1],
        [p0[0] + side[0] * w0, p0[1] + tw(t0), p0[2] + side[2] * w0],
      ];
      card(b, flex, q, [[t0, 0], [t1, 0], [t1, 1], [t0, 1]], [t0, t1, t1, t0]);
    }
  }
  const g = b.toGeometry(false);
  g.setAttribute('aFlex', new THREE.BufferAttribute(new Float32Array(flex), 1));
  softenNormals(g, 0.75);
  return g;
}

/** Crossed cards for low scrub. */
function buildScrub(seed = 9) {
  const b = new GeoBuilder({ uvScale: 1, weather: null });
  const flex = [];
  const r = rng(seed);
  const blades = 3;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI + r() * 0.4;
    const w = 0.62 + r() * 0.3, h = 0.72 + r() * 0.35;
    const ca = Math.cos(a) * w * 0.5, sa = Math.sin(a) * w * 0.5;
    card(b, flex,
      [[-ca, 0, -sa], [ca, 0, sa], [ca, h, sa], [-ca, h, -sa]],
      [[0, 1], [1, 1], [1, 0], [0, 0]],
      [0, 0, 1, 1]);
  }
  const g = b.toGeometry(false);
  g.setAttribute('aFlex', new THREE.BufferAttribute(new Float32Array(flex), 1));
  softenNormals(g, 0.9);
  return g;
}

/**
 * Blend each vertex normal toward the direction radiating out of the plant's
 * own centre. This is the cheap stand-in for scattering through a canopy.
 */
function softenNormals(geo, amount) {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Bias the reference point below the crown so even drooping tips resolve
    // to an upward-and-outward normal rather than pointing at the ground.
    v.y += 1.6;
    if (v.lengthSq() < 1e-6) v.set(0, 1, 0);
    v.normalize();
    n.fromBufferAttribute(nrm, i);
    // Keep the card's own facing on the side the light is on; flipping is
    // handled by DoubleSide at raster time.
    if (n.dot(v) < 0) n.negate();
    n.lerp(v, amount).normalize();
    nrm.setXYZ(i, n.x, n.y, n.z);
  }
  nrm.needsUpdate = true;
}

/* ---------------------------------------------------------------- module */

/**
 * Owns the foliage instanced meshes and their wind clock.
 * Gated by quality tier through `density`.
 */
export class Foliage {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'Foliage';
    this._mats = [];
    this._time = 0;
    this.palms = [];
    this.scrubs = [];
  }

  /** @param {THREE.Material} trunkMaterial supplied by the level (bark). */
  build(trunkMaterial, opts = {}) {
    const frondTex = bakeFrond(opts.frondSize ?? 256);
    const scrubTex = bakeScrub(128);
    const frondMat = makeFoliageMaterial(frondTex, { alphaTest: 0.42, amp: opts.windAmp ?? 0.17 });
    const scrubMat = makeFoliageMaterial(scrubTex, { alphaTest: 0.5, amp: (opts.windAmp ?? 0.17) * 0.45 });
    this._mats.push(frondMat, scrubMat);

    // Trunk: a tapered, gently leaning stack of chamfered drums — palm trunks
    // are ringed by old frond scars, which is most of their read at distance.
    //
    // Built at the *nominal* height rather than unit height, and instanced with
    // a uniform scale near 1. A unit-height prototype stretched 7x would smear
    // the bark texture by the same factor; ±15% is invisible.
    const H = this.nominalHeight = 7.5;
    const tb = new GeoBuilder({ uvScale: 1.4, weather: null });
    const rings = 22;
    const seg = H / rings;
    for (let i = 0; i < rings; i++) {
      const t = i / rings;
      const rr = lerp(0.21, 0.135, t);
      const lean = Math.sin(t * 1.6) * 0.34;
      tb.at(lean, t * H + seg / 2, 0).cyl(rr * 1.05, rr * 0.99, seg * 1.04, 9, 0.014, false, i === 0);
      if (i % 2 === 0) {
        tb.at(lean, t * H + seg * 0.34, 0).cyl(rr * 1.17, rr * 1.17, 0.05, 9, 0.012, false, false);
      }
    }
    const trunkGeo = tb.toGeometry(false);

    this.trunkMesh = null;
    this._trunkGeo = trunkGeo;
    this._trunkMat = trunkMaterial;
    this._frondGeo = buildCrown();
    this._frondMat = frondMat;
    this._scrubGeo = buildScrub();
    this._scrubMat = scrubMat;
    return this;
  }

  /** Queue a palm. `height` is the trunk height in metres (6–9 reads right). */
  addPalm(x, z, height, yaw = 0, tilt = 0) {
    this.palms.push({ x, z, height, yaw, tilt });
  }

  addScrub(x, z, scale = 1, yaw = 0) {
    this.scrubs.push({ x, z, scale, yaw });
  }

  /** Realise the instanced meshes. Call once, after all placements. */
  flush() {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();

    if (this.palms.length) {
      const trunks = new THREE.InstancedMesh(this._trunkGeo, this._trunkMat, this.palms.length);
      const crowns = new THREE.InstancedMesh(this._frondGeo, this._frondMat, this.palms.length);
      trunks.name = 'inst:palmTrunk';
      crowns.name = 'inst:palmCrown';
      const NH = this.nominalHeight;
      this.palms.forEach((p, i) => {
        const k = p.height / NH;
        e.set(p.tilt * 0.5, p.yaw, 0, 'YXZ');
        q.setFromEuler(e);
        s.set(k, k, k);
        m.compose(v.set(p.x, 0, p.z), q, s);
        trunks.setMatrixAt(i, m);
        // The crown rides the top of the trunk, including its lean.
        const leanX = Math.sin(1.6) * 0.34 * k;
        m.compose(v.set(p.x + Math.cos(p.yaw) * leanX, p.height * 0.985,
          p.z - Math.sin(p.yaw) * leanX), q, s);
        crowns.setMatrixAt(i, m);
      });
      trunks.instanceMatrix.needsUpdate = true;
      crowns.instanceMatrix.needsUpdate = true;
      trunks.castShadow = true; trunks.receiveShadow = true;
      // Cutout foliage is skipped by the shadow pass: three would render it
      // with a depth material that has neither the alpha map nor the wind
      // displacement, so it would cast a solid rectangle that swims.
      crowns.castShadow = false; crowns.receiveShadow = true;
      trunks.computeBoundingSphere(); crowns.computeBoundingSphere();
      this.group.add(trunks, crowns);
    } else {
      this._trunkGeo.dispose(); this._frondGeo.dispose();
    }

    if (this.scrubs.length) {
      const im = new THREE.InstancedMesh(this._scrubGeo, this._scrubMat, this.scrubs.length);
      im.name = 'inst:scrub';
      this.scrubs.forEach((p, i) => {
        e.set(0, p.yaw, 0, 'YXZ');
        q.setFromEuler(e);
        s.set(p.scale, p.scale * (0.85 + (i % 5) * 0.07), p.scale);
        m.compose(v.set(p.x, 0, p.z), q, s);
        im.setMatrixAt(i, m);
      });
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = false;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      this.group.add(im);
    } else {
      this._scrubGeo.dispose();
    }
    return this.group;
  }

  update(dt) {
    this._time += dt;
    for (const m of this._mats) m.userData.windUniforms.uWindTime.value = this._time;
  }

  dispose() {
    for (const m of this._mats) { m.map?.dispose(); m.dispose(); }
    this.group.traverse((o) => o.geometry?.dispose?.());
  }
}
