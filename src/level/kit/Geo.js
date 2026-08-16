import * as THREE from 'three';

/**
 * OWNER: level-art agent.
 *
 * Geometry substrate for the modular level kit.
 *
 * Everything the map is made of is emitted into a `GeoBuilder`: a flat polygon
 * soup with a current transform, which becomes exactly one BufferGeometry — and
 * therefore exactly one draw call — when it is closed. There is no per-prop
 * Mesh and no `mergeGeometries` pass over hundreds of small buffers; the merge
 * happens as the map is authored, which is both faster at boot and the only way
 * to keep several thousand kit pieces inside a sane draw-call budget.
 *
 * Three conventions hold throughout:
 *
 *  - **Nothing is an untrimmed box.** `box()` is a 24-vertex chamfered solid
 *    (6 faces, 12 edge bevels, 8 corner triangles). A 12 mm chamfer is what
 *    makes an edge catch the sun instead of dying into a hard aliased line, and
 *    it costs 32 extra triangles.
 *  - **UVs are a world-space planar projection**, chosen per polygon from the
 *    dominant axis of its normal and scaled in metres per texture tile. The
 *    architectural presets are triplanar in the shader so they ignore these,
 *    but the LOW tier drops the surface shader and falls back to UVs — this
 *    keeps that path correctly scaled instead of stretched.
 *  - **Weathering is per-vertex.** Every vertex carries `aWeather` (x = grime,
 *    y = water staining); see Weathering.js. Large faces are tessellated on a
 *    coarse grid purely so those fields have somewhere to live.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t0 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _wea = [0, 0];

/** Vertices below this height pick up ground splash-back by default. */
export const SPLASH_HEIGHT = 1.35;

/**
 * Chamfer level-of-detail.
 *
 * A bevel costs a flat 32 triangles no matter how small the solid is, and the
 * kit emits several thousand boxes that are trim bars, slats, glazing panes,
 * railing pipes and bolt heads. Measured on this map, boxes whose bevel was
 * under 15 mm — or whose smallest dimension was under 110 mm — accounted for
 * ~137k triangles of chamfer that can never resolve as a lit sliver: a 8 mm
 * bevel on a 35 mm window bar is below a pixel at any range the bar itself is
 * still readable at. Everything at or above these thresholds keeps its full
 * bevel, so plinths, cornices, crates, sandbags, jersey barriers, treads and
 * vehicle bodies are untouched.
 */
const MIN_CHAMFER = 0.0145;
const MIN_HALF_EXTENT = 0.055;

/**
 * Hard ceiling on the subdivisions `quad()` will emit along one axis. The
 * tessellation exists to give the per-vertex weathering field somewhere to
 * live; past this the field is already oversampled and the extra rows are pure
 * cost. Without it a single mis-typed step on a 280 m ground plane is 300k
 * triangles nobody notices until the frame budget is gone.
 */
const MAX_SUBDIV = 20;

/* --------------------------------------------------------------- noise ---- */

/** Deterministic 2D value hash in [0,1). Stable across loads and platforms. */
export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Smooth 2D value noise on a unit lattice, in [0,1]. */
export function noise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

/** Fractal value noise, `oct` octaves at half amplitude each. Returns [0,1]. */
export function fbm2(x, y, oct = 3, seed = 0) {
  let f = 1, a = 0.5, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += noise2(x * f, y * f, seed + i * 131) * a;
    norm += a;
    f *= 2.03; a *= 0.5;
  }
  return sum / norm;
}

/** Default weather field: grime rising out of the ground, none on up-faces. */
export function groundGrime(x, y, z, nx, ny, nz, out) {
  const up = ny;
  const splash = Math.max(0, 1 - y / SPLASH_HEIGHT);
  // Vertical faces wick dirt up from the pavement; up-facing faces collect
  // wind-blown dust instead, which is flatter and never fully clean.
  const vertical = 1 - Math.abs(up);
  out[0] = Math.min(1, splash * splash * vertical * 0.9 + Math.max(0, up) * 0.28);
  out[1] = 0;
}

export class GeoBuilder {
  /**
   * @param {object} opts
   * @param {number} opts.uvScale metres per texture tile
   * @param {Function} opts.weather (x,y,z,nx,ny,nz,out[2]) => void
   */
  constructor(opts = {}) {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.wea = [];
    this.uvScale = opts.uvScale ?? 2;
    this.weather = opts.weather || groundGrime;
    this._m = new THREE.Matrix4();
    this._nm = new THREE.Matrix3();
    this._hasM = false;
    this._f = new THREE.Matrix4();
    this._hasF = false;
  }

  get vertexCount() { return this.pos.length / 3; }
  get triangleCount() { return this.pos.length / 9; }

  /* ------------------------------------------------------------ transform */

  identity() { this._hasM = this._hasF; this._m.copy(this._f); this._nm.getNormalMatrix(this._m); return this; }

  /**
   * Push a base frame. Every subsequent `at()` is expressed *inside* it, which
   * is what lets a wall kit author piers, lintels and sills in comfortable
   * wall-local coordinates while the builder still emits world space.
   */
  frame(m) {
    if (!m) { this._hasF = false; this._f.identity(); return this.identity(); }
    this._f.copy(m);
    this._hasF = true;
    return this.identity();
  }

  clearFrame() { return this.frame(null); }

  setMatrix(m) {
    if (!m) return this.identity();
    if (this._hasF) this._m.multiplyMatrices(this._f, m);
    else this._m.copy(m);
    this._nm.getNormalMatrix(this._m);
    this._hasM = true;
    return this;
  }

  /** Place the cursor: translation, then Y-yaw, then X-pitch, then Z-roll. */
  at(x, y, z, ry = 0, rx = 0, rz = 0) {
    _e.set(rx, ry, rz, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(_v.set(x, y, z), _q, _one);
    return this.setMatrix(_m);
  }

  /** Run `fn` with a temporary weather field, then restore the previous one. */
  withWeather(fn, body) {
    const prev = this.weather;
    this.weather = fn;
    try { body(); } finally { this.weather = prev; }
    return this;
  }

  /* --------------------------------------------------------------- output */

  _vertex(x, y, z, nx, ny, nz) {
    _p.set(x, y, z);
    _n.set(nx, ny, nz);
    if (this._hasM) {
      _p.applyMatrix4(this._m);
      _n.applyNormalMatrix(this._nm);
    }
    this.pos.push(_p.x, _p.y, _p.z);
    this.nrm.push(_n.x, _n.y, _n.z);

    // Dominant-axis planar projection. Signs are chosen so opposite faces of a
    // solid do not mirror against each other, which shows up as a visible seam
    // where a chamfer meets a face.
    const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z);
    const s = 1 / this.uvScale;
    if (ay >= ax && ay >= az) this.uv.push(_p.x * s, _p.z * s);
    else if (ax >= az) this.uv.push(-_p.z * s, _p.y * s);
    else this.uv.push(_p.x * s, _p.y * s);

    _wea[0] = 0; _wea[1] = 0;
    if (this.weather) this.weather(_p.x, _p.y, _p.z, _n.x, _n.y, _n.z, _wea);
    this.wea.push(_wea[0], _wea[1]);
  }

  /** One flat triangle with an explicit normal. */
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz) {
    this._vertex(ax, ay, az, nx, ny, nz);
    this._vertex(bx, by, bz, nx, ny, nz);
    this._vertex(cx, cy, cz, nx, ny, nz);
    return this;
  }

  /**
   * Convex polygon, flat shaded, triangulated as a fan. `pts` is a flat array
   * of xyz triples. If `ref` is supplied the winding is corrected so the face
   * points away from it — for a convex solid, passing the solid's centre makes
   * winding automatic and impossible to get backwards.
   */
  poly(pts, ref = null) {
    const n = pts.length / 3;
    if (n < 3) return this;

    // Newell's method: correct for any planar polygon, unlike a single cross
    // product, which degenerates when the first three points are near-collinear.
    let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ix = pts[i * 3], iy = pts[i * 3 + 1], iz = pts[i * 3 + 2];
      const jx = pts[j * 3], jy = pts[j * 3 + 1], jz = pts[j * 3 + 2];
      nx += (iy - jy) * (iz + jz);
      ny += (iz - jz) * (ix + jx);
      nz += (ix - jx) * (iy + jy);
      cx += ix; cy += iy; cz += iz;
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return this;
    nx /= len; ny /= len; nz /= len;
    cx /= n; cy /= n; cz /= n;

    let flip = false;
    if (ref) {
      if ((cx - ref[0]) * nx + (cy - ref[1]) * ny + (cz - ref[2]) * nz < 0) flip = true;
    }
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }

    for (let i = 1; i < n - 1; i++) {
      const a = 0, b = flip ? i + 1 : i, c = flip ? i : i + 1;
      this._vertex(pts[a * 3], pts[a * 3 + 1], pts[a * 3 + 2], nx, ny, nz);
      this._vertex(pts[b * 3], pts[b * 3 + 1], pts[b * 3 + 2], nx, ny, nz);
      this._vertex(pts[c * 3], pts[c * 3 + 1], pts[c * 3 + 2], nx, ny, nz);
    }
    return this;
  }

  /**
   * Planar quad p0->p1->p2->p3 (CCW as seen from the front), optionally
   * tessellated on a grid so per-vertex weathering has resolution. `warp`, if
   * given, may displace each generated vertex — cloth sag uses it.
   *
   * `step` may be a single metre figure or `[alongP0P1, alongP0P3]`. The
   * anisotropic form is what a wall wants: the weathering field is a function
   * of height, so a 15 m run needs five rows vertically and exactly one column
   * horizontally, not seventy-five cells.
   */
  quad(p0, p1, p2, p3, step = 0, warp = null) {
    _t0.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    _t1.set(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]);
    _n.crossVectors(_t0, _t1).normalize();
    const nx = _n.x, ny = _n.y, nz = _n.z;

    const stepU = Array.isArray(step) ? step[0] : step;
    const stepV = Array.isArray(step) ? step[1] : step;
    const su = stepU > 0 ? Math.min(MAX_SUBDIV, Math.max(1, Math.round(_t0.length() / stepU))) : 1;
    const sv = stepV > 0 ? Math.min(MAX_SUBDIV, Math.max(1, Math.round(_t1.length() / stepV))) : 1;

    const P = (u, v, o) => {
      // Bilinear across the quad; correct for the trapezoids the wall kit emits.
      const a = 1 - u, b = 1 - v;
      o[0] = p0[0] * a * b + p1[0] * u * b + p2[0] * u * v + p3[0] * a * v;
      o[1] = p0[1] * a * b + p1[1] * u * b + p2[1] * u * v + p3[1] * a * v;
      o[2] = p0[2] * a * b + p1[2] * u * b + p2[2] * u * v + p3[2] * a * v;
      if (warp) warp(u, v, o);
    };
    const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0], D = [0, 0, 0];
    for (let i = 0; i < su; i++) {
      for (let j = 0; j < sv; j++) {
        P(i / su, j / sv, A);
        P((i + 1) / su, j / sv, B);
        P((i + 1) / su, (j + 1) / sv, C);
        P(i / su, (j + 1) / sv, D);
        if (warp) {
          // Sagging cloth is no longer planar, so each triangle gets its own
          // normal or the lighting reads as a flat sheet.
          this._triAuto(A, B, C);
          this._triAuto(A, C, D);
        } else {
          this._vertex(A[0], A[1], A[2], nx, ny, nz);
          this._vertex(B[0], B[1], B[2], nx, ny, nz);
          this._vertex(C[0], C[1], C[2], nx, ny, nz);
          this._vertex(A[0], A[1], A[2], nx, ny, nz);
          this._vertex(C[0], C[1], C[2], nx, ny, nz);
          this._vertex(D[0], D[1], D[2], nx, ny, nz);
        }
      }
    }
    return this;
  }

  _triAuto(a, b, c) {
    _t0.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    _t1.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    _n.crossVectors(_t0, _t1).normalize();
    this._vertex(a[0], a[1], a[2], _n.x, _n.y, _n.z);
    this._vertex(b[0], b[1], b[2], _n.x, _n.y, _n.z);
    this._vertex(c[0], c[1], c[2], _n.x, _n.y, _n.z);
  }

  /**
   * Chamfered box centred on the cursor. `c` is the chamfer width in metres;
   * `grid` tessellates the six main faces so weathering gradients have vertex
   * resolution (0 = one quad per face).
   */
  box(w, h, d, c = 0.02, grid = 0) {
    const hx = w * 0.5, hy = h * 0.5, hz = d * 0.5;
    let cc = Math.min(c, hx * 0.9, hy * 0.9, hz * 0.9);
    // Chamfer LOD — see MIN_CHAMFER. Small parts fall back to a plain solid,
    // which is 12 triangles instead of 44.
    if (cc < MIN_CHAMFER || Math.min(hx, hy, hz) < MIN_HALF_EXTENT) cc = 0;
    const ax = hx - cc, ay = hy - cc, az = hz - cc;
    const O = [0, 0, 0];

    // Six main faces, inset by the chamfer on all four sides.
    this.quad([hx, -ay, -az], [hx, -ay, az], [hx, ay, az], [hx, ay, -az], grid);
    this.quad([-hx, -ay, az], [-hx, -ay, -az], [-hx, ay, -az], [-hx, ay, az], grid);
    this.quad([-ax, hy, az], [ax, hy, az], [ax, hy, -az], [-ax, hy, -az], grid);
    this.quad([-ax, -hy, -az], [ax, -hy, -az], [ax, -hy, az], [-ax, -hy, az], grid);
    this.quad([-ax, -ay, hz], [ax, -ay, hz], [ax, ay, hz], [-ax, ay, hz], grid);
    this.quad([ax, -ay, -hz], [-ax, -ay, -hz], [-ax, ay, -hz], [ax, ay, -hz], grid);

    if (cc <= 1e-4) return this;

    // Twelve edge bevels.
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sx = -1; sx <= 1; sx += 2) {
        this.poly([sx * hx, sy * ay, -az, sx * hx, sy * ay, az,
          sx * ax, sy * hy, az, sx * ax, sy * hy, -az], O);
      }
      for (let sz = -1; sz <= 1; sz += 2) {
        this.poly([-ax, sy * ay, sz * hz, ax, sy * ay, sz * hz,
          ax, sy * hy, sz * az, -ax, sy * hy, sz * az], O);
      }
    }
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        this.poly([sx * hx, -ay, sz * az, sx * hx, ay, sz * az,
          sx * ax, ay, sz * hz, sx * ax, -ay, sz * hz], O);
      }
    }
    // Eight corner triangles.
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          this.poly([sx * hx, sy * ay, sz * az, sx * ax, sy * hy, sz * az,
            sx * ax, sy * ay, sz * hz], O);
        }
      }
    }
    return this;
  }

  /**
   * Vertical cylinder / cone frustum with chamfered rims, centred on the
   * cursor. Used for pillars, barrels, pipes, bollards and palm trunks.
   */
  cyl(rBottom, rTop, h, seg = 12, c = 0.02, capTop = true, capBottom = true) {
    const hy = h * 0.5;
    const cc = Math.min(c, hy * 0.45, Math.min(rBottom, rTop) * 0.45);
    const ringsY = [-hy, -hy + cc, hy - cc, hy];
    const lerp = (t) => rBottom + (rTop - rBottom) * t;
    const ringsR = [
      lerp(0) - cc, lerp(cc / h), lerp(1 - cc / h), lerp(1) - cc,
    ];
    const cs = [], sn = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      cs.push(Math.cos(a)); sn.push(Math.sin(a));
    }
    for (let r = 0; r < 3; r++) {
      const y0 = ringsY[r], y1 = ringsY[r + 1];
      const r0 = ringsR[r], r1 = ringsR[r + 1];
      // An unchamfered cylinder collapses its two rim bands to zero height and
      // zero radius change: 2/3 of the triangles are degenerate. Skipping them
      // is what makes `cyl(..., 0)` an honest 1-band primitive, and there are
      // several hundred of those on the map — hoops, collars, ferrules.
      if (Math.abs(y1 - y0) < 1e-5 && Math.abs(r1 - r0) < 1e-5) continue;
      for (let i = 0; i < seg; i++) {
        this.quad(
          [cs[i] * r0, y0, sn[i] * r0],
          [cs[i + 1] * r0, y0, sn[i + 1] * r0],
          [cs[i + 1] * r1, y1, sn[i + 1] * r1],
          [cs[i] * r1, y1, sn[i] * r1],
        );
      }
    }
    if (capTop) {
      const pts = [];
      for (let i = 0; i < seg; i++) pts.push(cs[i] * ringsR[3], hy, sn[i] * ringsR[3]);
      this.poly(pts, [0, hy - 1, 0]);
    }
    if (capBottom) {
      const pts = [];
      for (let i = 0; i < seg; i++) pts.push(cs[i] * ringsR[0], -hy, sn[i] * ringsR[0]);
      this.poly(pts, [0, -hy + 1, 0]);
    }
    return this;
  }

  /**
   * Right-triangular prism: a ramp rising along +Z from y=0 to y=h, `w` wide.
   * This is the collision proxy under every staircase — a 12-triangle slope the
   * capsule solver glides up, instead of 14 boxes it has to step over.
   */
  ramp(w, h, len, c = 0.02) {
    const hw = w * 0.5, hl = len * 0.5;
    const O = [0, h / 3, 0];
    const A = [-hw, 0, -hl], B = [hw, 0, -hl], C = [hw, 0, hl], D = [-hw, 0, hl];
    const E = [hw, h, hl], F = [-hw, h, hl];
    this.poly([...A, ...B, ...C, ...D], O);              // underside
    this.poly([...A, ...B, ...E, ...F], O);              // slope
    this.poly([...C, ...E, ...F, ...D], O);              // riser at the top
    this.poly([...B, ...C, ...E], O);
    this.poly([...A, ...D, ...F], O);
    void c;
    return this;
  }

  /**
   * Square-section tube following a polyline. Cables, conduit and hand rails
   * all use it; a 4-sided section is invisible at 20 mm and costs 8 triangles
   * per span.
   */
  tube(points, radius, closedEnds = true) {
    const n = points.length;
    if (n < 2) return this;
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const side = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const ring = [];
    for (let i = 0; i < n; i++) {
      const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
      dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      side.crossVectors(dir, up);
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
      side.normalize();
      nrm.crossVectors(side, dir).normalize();
      const p = points[i];
      const r = radius;
      ring.push([
        [p[0] + side.x * r, p[1] + side.y * r, p[2] + side.z * r],
        [p[0] + nrm.x * r, p[1] + nrm.y * r, p[2] + nrm.z * r],
        [p[0] - side.x * r, p[1] - side.y * r, p[2] - side.z * r],
        [p[0] - nrm.x * r, p[1] - nrm.y * r, p[2] - nrm.z * r],
      ]);
    }
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        this.quad(ring[i][k], ring[i][k2], ring[i + 1][k2], ring[i + 1][k]);
      }
    }
    if (closedEnds) {
      this.poly([...ring[0][0], ...ring[0][1], ...ring[0][2], ...ring[0][3]], points[1]);
      const l = n - 1;
      this.poly([...ring[l][0], ...ring[l][1], ...ring[l][2], ...ring[l][3]], points[n - 2]);
    }
    return this;
  }

  /** Absorb another builder's soup (already in the same space). */
  concat(other) {
    for (let i = 0; i < other.pos.length; i++) this.pos.push(other.pos[i]);
    for (let i = 0; i < other.nrm.length; i++) this.nrm.push(other.nrm[i]);
    for (let i = 0; i < other.uv.length; i++) this.uv.push(other.uv[i]);
    for (let i = 0; i < other.wea.length; i++) this.wea.push(other.wea[i]);
    return this;
  }

  toGeometry(withWeather = true) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    if (withWeather) {
      g.setAttribute('aWeather', new THREE.BufferAttribute(new Float32Array(this.wea), 2));
    }
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/* ------------------------------------------------------------- collision */

/**
 * The collision proxy set. Every solid the player can touch is registered here
 * as an oriented box or a ramp — never as the render geometry, which carries
 * chamfers, mouldings, awning cloth and instanced clutter that the BVH would
 * pay for on every capsule sweep and every bullet trace.
 *
 * Typical ratio for this map: ~4k proxy triangles against ~500k rendered.
 */
export class ProxySet {
  constructor() {
    this.pos = [];
    this._m = new THREE.Matrix4();
  }

  get triangleCount() { return this.pos.length / 9; }

  _push(builder) {
    for (let i = 0; i < builder.pos.length; i++) this.pos.push(builder.pos[i]);
  }

  /** Axis-aligned or yaw-rotated solid box. */
  box(x, y, z, w, h, d, ry = 0) {
    const b = new GeoBuilder({ weather: null });
    b.at(x, y, z, ry).box(w, h, d, 0);
    this._push(b);
    return this;
  }

  /** Box specified by its min/max corners. */
  extent(x0, y0, z0, x1, y1, z1) {
    return this.box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2,
      Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  }

  /** Walkable slope rising along +Z in the rotated frame. */
  ramp(x, y, z, w, h, len, ry = 0) {
    const b = new GeoBuilder({ weather: null });
    b.at(x, y, z, ry).ramp(w, h, len, 0);
    this._push(b);
    return this;
  }

  toMesh() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ visible: false }));
    mesh.name = 'LevelCollision';
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }
}

/* ---------------------------------------------------------------- helpers */

/** Deterministic per-map RNG so the layout is identical on every load. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
