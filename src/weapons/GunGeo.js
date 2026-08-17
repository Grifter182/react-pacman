import * as THREE from 'three';

/**
 * OWNER: weapons agent.
 *
 * Geometry substrate for the procedural gunsmith. Everything a weapon is made
 * of is emitted through this file, and the rules are the same three that the
 * level kit follows, for the same reasons:
 *
 *  - **Nothing is an untrimmed box.** `chamferBox()` lofts an octagonal
 *    cross-section, so all twelve edges carry a real bevel. At viewmodel range
 *    a hard 90-degree arris is a single aliased line; a 0.6 mm chamfer is two
 *    pixels of moving specular and is the difference between "machined" and
 *    "cube".
 *  - **Flat where it is flat, smooth where it is round.** Lofted hard-surface
 *    parts are emitted non-indexed and get per-face normals, which keeps the
 *    facets crisp. Turned parts (barrels, optic tubes, turrets) come from
 *    `lathe()` and keep smooth normals, because a barrel is a surface of
 *    revolution and reads wrong faceted.
 *  - **UVs are a dominant-axis planar projection in weapon space**, scaled in
 *    metres per texture tile to match the recipe's `worldScale` (0.35 m for
 *    gunmetal/polymer). Parts therefore share one continuous grain instead of
 *    each carrying its own arbitrary unwrap. **Turned parts are the exception**:
 *    a dominant-axis projection applied to a surface of revolution flips
 *    projection plane every ~45 degrees around the ring, so the grain shears at
 *    eight seams and the wear mask beats against itself into visible speckle
 *    banding. Anything from `lathe()`/`tube()`/`cyl()` therefore carries a
 *    cylindrical unwrap hint (angle x radius across, axial along), applied in
 *    the part's own local space so mirrored copies stay coherent. Faces whose
 *    normal runs along the axis (end caps, rims) fall back to a planar
 *    projection in the cross-section plane, because a cylindrical unwrap
 *    collapses them to a line.
 *
 * Parts are accumulated into a `Kit`, which merges everything sharing a
 * material slot into one buffer with one draw group. A finished weapon body is
 * three or four draw calls, not sixty.
 */

/* --------------------------------------------------------------- profiles */

/** Rectangle with its four corners cut — the cross-section of a chamfered box. */
export function octagon(w, h, c) {
  const hw = w * 0.5, hh = h * 0.5;
  const k = Math.min(c, hw * 0.98, hh * 0.98);
  return [
    [hw, -hh + k], [hw, hh - k], [hw - k, hh], [-hw + k, hh],
    [-hw, hh - k], [-hw, -hh + k], [-hw + k, -hh], [hw - k, -hh],
  ];
}

/** Rounded rectangle, `seg` segments per corner. Used for grips and tubes. */
export function roundRect(w, h, r, seg = 3) {
  const hw = Math.max(1e-4, w * 0.5 - r), hh = Math.max(1e-4, h * 0.5 - r);
  const pts = [];
  const corners = [[hw, -hh, -Math.PI / 2], [hw, hh, 0], [-hw, hh, Math.PI / 2], [-hw, -hh, Math.PI]];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
}

/** Regular n-gon, flat side down — handguard and buffer-tube cross-sections. */
export function ngon(radius, n, phase = Math.PI / n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    pts.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return pts;
}

/* ------------------------------------------------------------------- loft */

/**
 * Sweep a closed profile through a list of rings. Each ring is
 * `{ z, scale?, scaleY?, dx?, dy?, roll? , pts? }`; the profile may be
 * overridden per ring as long as the point count matches.
 *
 * Returns a non-indexed BufferGeometry with flat normals — the chamfer facets
 * must not be smoothed into each other or the whole point of them is lost.
 */
export function loft(profile, rings, { capStart = true, capEnd = true } = {}) {
  const n = profile.length;
  const R = rings.length;
  const px = new Float32Array(n * R), py = new Float32Array(n * R), pz = new Float32Array(R);

  for (let r = 0; r < R; r++) {
    const ring = rings[r];
    const src = ring.pts || profile;
    const sx = ring.scale ?? 1;
    const sy = ring.scaleY ?? ring.scale ?? 1;
    const roll = ring.roll ?? 0;
    const cr = Math.cos(roll), sr = Math.sin(roll);
    pz[r] = ring.z;
    for (let i = 0; i < n; i++) {
      const x = src[i][0] * sx, y = src[i][1] * sy;
      px[r * n + i] = x * cr - y * sr + (ring.dx ?? 0);
      py[r * n + i] = x * sr + y * cr + (ring.dy ?? 0);
    }
  }

  const tris = [];
  const push = (r, i) => { tris.push(px[r * n + i], py[r * n + i], pz[r]); };

  for (let r = 0; r < R - 1; r++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // a=(r,i) b=(r,j) c=(r+1,j) d=(r+1,i) — CCW profiles with increasing z
      // give outward-facing normals.
      push(r, i); push(r, j); push(r + 1, j);
      push(r, i); push(r + 1, j); push(r + 1, i);
    }
  }

  const cap = (r, flip) => {
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += px[r * n + i]; cy += py[r * n + i]; }
    cx /= n; cy /= n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (flip) { tris.push(cx, cy, pz[r]); push(r, j); push(r, i); }
      else { tris.push(cx, cy, pz[r]); push(r, i); push(r, j); }
    }
  };
  if (capStart) cap(0, true);
  if (capEnd) cap(R - 1, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris), 3));
  geo.computeVertexNormals();       // non-indexed → per-face normals
  return geo;
}

/**
 * Chamfered solid. `c` is the bevel width; the front and back faces are inset
 * by the same amount so corners are cut in all three axes.
 */
export function chamferBox(w, h, d, c = 0.0016) {
  const prof = octagon(w, h, c);
  const hd = d * 0.5;
  const kx = Math.max(0.02, (w - 2 * c) / w);
  const ky = Math.max(0.02, (h - 2 * c) / h);
  return loft(prof, [
    { z: -hd, scale: kx, scaleY: ky },
    { z: -hd + c, scale: 1 },
    { z: hd - c, scale: 1 },
    { z: hd, scale: kx, scaleY: ky },
  ]);
}

/** Chamfered wedge: the +Y face slopes from `h0` at -Z to `h1` at +Z. */
export function chamferWedge(w, h0, h1, d, c = 0.0016) {
  const prof = octagon(w, 1, c / Math.max(h0, h1));
  const hd = d * 0.5;
  const kx = Math.max(0.02, (w - 2 * c) / w);
  return loft(prof, [
    { z: -hd, scale: kx, scaleY: h0 - 2 * c },
    { z: -hd + c, scale: 1, scaleY: h0 },
    { z: hd - c, scale: 1, scaleY: h1 },
    { z: hd, scale: kx, scaleY: h1 - 2 * c },
  ]);
}

/* ------------------------------------------------------------------ lathe */

/**
 * Surface of revolution about the weapon's forward axis. `profile` is a list of
 * `[radius, z]` pairs **in weapon Z** (forward is negative); a zero radius
 * closes an end. Smooth normals, because these are genuinely smooth surfaces.
 *
 * three's LatheGeometry revolves about +Y and derives its normals from the
 * profile's direction of travel, so the profile is negated into Y (putting the
 * muzzle end at +Y) and re-ordered if the caller listed it front-to-back. Get
 * that wrong and the part renders inside out, which is invisible until a
 * specular highlight lands on it.
 */
export function lathe(profile, segments = 24) {
  let p = profile;
  if (p.length > 1 && p[p.length - 1][1] > p[0][1]) p = p.slice().reverse();
  const pts = p.map(([r, z]) => new THREE.Vector2(Math.max(1e-5, r), -z));
  const geo = new THREE.LatheGeometry(pts, segments);
  geo.rotateX(-Math.PI / 2);      // +Y (muzzle end) -> -Z
  let rMax = 1e-4;
  for (const [r] of p) rMax = Math.max(rMax, r);
  return cylindricalUnwrap(geo, rMax);
}

/**
 * Tag a geometry so `Kit` unwraps it about the given axis instead of using the
 * dominant-axis planar projection. `radius` sets the across-the-surface texel
 * density: the u coordinate is `angle * radius`, so the grain runs at the same
 * metres-per-texel as the planar-projected parts it sits next to.
 */
export function cylindricalUnwrap(geo, radius, axis = 'z') {
  geo.userData.uv = { mode: 'cylindrical', axis, radius };
  return geo;
}

/**
 * Hollow tube: a closed annular cross-section revolved about the weapon axis,
 * with real end faces and a real bore.
 *
 * This exists because a sight you cannot see through is not a sight. A lathe
 * profile that starts or ends at radius zero caps the tube with a solid disc,
 * and at hip fire nobody notices — the moment the player aims, the optic is a
 * black plug over the middle of the screen.
 */
export function tube(rOuter, rInner, z0, z1, segments = 28) {
  return lathe([
    [rOuter, z0], [rOuter, z1],          // outer wall, rear -> front
    [rInner, z1], [rInner, z0],          // bore, front -> rear (normals inward)
    [rOuter, z0],                        // close the section
  ], segments);
}

/**
 * Hollow tube whose bore is a CONE rather than a cylinder — the shape a sight
 * has to be if the player is to see the whole of its aperture.
 *
 * A straight bore is not see-through, and the reason is pure perspective. The
 * eye is a point, so the pencil of rays that reaches it through a tube is a
 * cone that *widens* going downrange. A cylindrical bore of radius r and length
 * L, with the eye d behind the rear rim, therefore stops the cone at the FRONT
 * rim: the largest half-angle that survives is r/(d+L), not r/d. On the red dot
 * that is 15.2 mm of aperture reduced to an effective 10.9 mm — 48% of the area
 * of the hole the player can see is tube wall, seen end-on at a grazing angle,
 * which renders as an opaque grey annulus filling most of the sight.
 *
 * `boredTube` takes the eye position and the clear half-angle the sight is
 * designed around and lays the bore ON that cone, so every ray that clears the
 * rear rim also clears the front one. Real optics do exactly this — it is why
 * an objective bell is wider than an ocular — and it costs nothing: the wall
 * simply thins toward the front, where it is furthest from the eye anyway.
 *
 * @param outer  [[r, z], ...] outer profile, REAR to FRONT (z decreasing)
 * @param bore   (z) => radius   the clear-cone radius at that z
 * @param slack  extra bore radius over the cone, in metres
 */
export function boredTube(outer, bore, segments = 32, slack = 0.0006) {
  const prof = outer.slice();
  // Walk the outer profile back to front, then return along the cone. Sampling
  // the bore at every outer station keeps the inner wall a true cone rather than
  // a stack of cylinders, so nothing steps into the sight line *between*
  // stations — which is the failure mode a single rear-rim check misses.
  // Repeated z values (a square shoulder in the outer wall) would emit a
  // zero-area ring, so they collapse to one.
  let prevZ = NaN;
  for (let i = outer.length - 1; i >= 0; i--) {
    const z = outer[i][1];
    if (z === prevZ) continue;
    prevZ = z;
    prof.push([bore(z) + slack, z]);
  }
  prof.push([outer[0][0], outer[0][1]]);
  return lathe(prof, segments);
}

/**
 * Solid cylinder or truncated cone running along local +Z from z = 0 to
 * z = len. Used for the dozens of small turned bosses — turrets, plungers,
 * thumbscrews, pins — where a full profile is overkill and getting the winding
 * wrong is easy.
 */
export function cyl(rNear, rFar, len, segments = 16, capped = true) {
  const g = new THREE.CylinderGeometry(rFar, rNear, len, segments, 1, !capped);
  g.rotateX(Math.PI / 2);          // +Y -> +Z
  g.translate(0, 0, len * 0.5);
  return cylindricalUnwrap(g, Math.max(rNear, rFar));
}

/** Knurled collar: `n` fine ridges around a cylinder of the given radius. */
export function knurl(n, radius, len, { width = 0.0018, depth = 0.0016 } = {}) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    parts.push({
      geo: chamferBox(width, depth, len, 0.0003),
      m: new THREE.Matrix4().makeRotationZ(a)
        .multiply(new THREE.Matrix4().makeTranslation(0, radius, 0)),
    });
  }
  return parts;
}

/** Flat annulus — lens rims, washers, sling-loop plates. */
export function ring(inner, outer, segments = 32) {
  return new THREE.RingGeometry(inner, outer, segments);
}

/* ------------------------------------------------------- composite pieces */

/**
 * MIL-STD-1913 rail: a base bar with recoil slots cut between the teeth. The
 * pitch is the real 10 mm; at 55-degree viewmodel FOV those teeth are three or
 * four pixels each and they are the single strongest "this is a gun" cue in the
 * silhouette.
 */
export function picatinny(length, { width = 0.0212, base = 0.0032, tooth = 0.0044, pitch = 0.0100, slot = 0.0053, detail = 1 } = {}) {
  const parts = [];
  const bar = chamferBox(width, base, length, 0.0008);
  parts.push({ geo: bar, m: _mat(0, base * 0.5, 0) });

  if (detail <= 0) {
    // LOW tier: one continuous ridge instead of 20 teeth.
    parts.push({ geo: chamferBox(width * 0.78, tooth, length, 0.0008), m: _mat(0, base + tooth * 0.5, 0) });
    return parts;
  }

  const span = pitch - slot;
  const count = Math.max(1, Math.floor(length / pitch));
  const z0 = -length * 0.5 + (length - count * pitch) * 0.5 + pitch * 0.5;
  // The teeth are trapezoidal in section (the 1913 spec's 45-degree flanks).
  const prof = octagon(width * 0.86, tooth, 0.0007);
  for (let i = 0; i < count; i++) {
    const g = loft(prof, [
      { z: -span * 0.5, scale: 0.90 },
      { z: -span * 0.5 + 0.0006, scale: 1 },
      { z: span * 0.5 - 0.0006, scale: 1 },
      { z: span * 0.5, scale: 0.90 },
    ]);
    parts.push({ geo: g, m: _mat(0, base + tooth * 0.5, z0 + i * pitch) });
  }
  return parts;
}

/**
 * M-LOK slot row. Built upward from the shell face for the reason spelled out
 * on `recessPanel`: geometry placed below a solid surface renders nowhere. The
 * slot floor is the shell itself and the frame stands proud of it, so the row
 * reads as a line of dark recesses between lit ribs — which is what a slotted
 * handguard looks like at arm's length, for 60 triangles instead of a boolean.
 *
 * The caller must place the row on the shell's **face** (its apothem), not on
 * its circumscribed radius; an n-gon's faces sit at `r * cos(pi/n)` and a row
 * dropped at `r` floats above the surface on the flats and sinks into it at
 * the corners.
 */
export function mlokSlots(count, { pitch = 0.032, len = 0.0195, wide = 0.0075, depth = 0.0026, z0 = 0 } = {}) {
  const parts = [];
  const t = 0.0018, hd = depth * 0.5;
  for (let i = 0; i < count; i++) {
    const z = z0 + i * pitch;
    parts.push({ geo: chamferBox(t, depth, len + t * 2, 0.0004), m: _mat(wide * 0.5 + t * 0.5, hd, z) });
    parts.push({ geo: chamferBox(t, depth, len + t * 2, 0.0004), m: _mat(-wide * 0.5 - t * 0.5, hd, z) });
    parts.push({ geo: chamferBox(wide, depth, t, 0.0004), m: _mat(0, hd, z + len * 0.5 + t * 0.5) });
    parts.push({ geo: chamferBox(wide, depth, t, 0.0004), m: _mat(0, hd, z - len * 0.5 - t * 0.5) });
  }
  return parts;
}

/**
 * A rectangular depression in a wall, framed by four proud lips. The outward
 * normal is +Y, so the caller rotates the frame onto whichever flank it belongs
 * on and places the origin **on the shell's face**, not below it.
 *
 * That placement rule is the whole point. Without CSG a slot cannot be removed
 * from a solid, and the obvious construction — a floor plate dropped `depth`
 * below the surface with walls running down to it — puts every triangle
 * *inside* the shell, where it is invisible. The last pass shipped exactly that
 * and the M-LOK rows and the charging-handle raceway rendered as nothing at
 * all. Building the frame *upward* instead gives the same read: the untouched
 * shell face becomes the floor, and four lips standing `depth` proud cast the
 * contact shadow and catch the rim highlight that say "recess".
 */
export function recessPanel(w, len, depth, { lip = 0.0016, chamfer = 0.0005 } = {}) {
  const hd = depth * 0.5;
  return [
    { geo: chamferBox(lip, depth, len + lip * 2, chamfer), m: _mat(w * 0.5 + lip * 0.5, hd, 0) },
    { geo: chamferBox(lip, depth, len + lip * 2, chamfer), m: _mat(-w * 0.5 - lip * 0.5, hd, 0) },
    { geo: chamferBox(w, depth, lip, chamfer), m: _mat(0, hd, len * 0.5 + lip * 0.5) },
    { geo: chamferBox(w, depth, lip, chamfer), m: _mat(0, hd, -len * 0.5 - lip * 0.5) },
  ];
}

/** Shallow inset panel line — the seam between two mouldings. */
export function panelLine(length, { width = 0.0012, depth = 0.0009, axis = 'z' } = {}) {
  return axis === 'z'
    ? chamferBox(width, depth, length, 0.0003)
    : chamferBox(length, depth, width, 0.0003);
}

/** Radial flutes cut into a barrel or handguard — n grooves around the axis. */
export function flutes(n, radius, length, { width = 0.0028, depth = 0.0016 } = {}) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const m = new THREE.Matrix4()
      .makeRotationZ(a)
      .multiply(new THREE.Matrix4().makeTranslation(0, radius - depth * 0.5, 0));
    parts.push({ geo: chamferBox(width, depth, length, 0.0004), m });
  }
  return parts;
}

/* ------------------------------------------------------------------- kit */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _n3 = new THREE.Matrix3();

function _mat(x, y, z) { return new THREE.Matrix4().makeTranslation(x, y, z); }

/**
 * Accumulates transformed part geometries per material slot and merges each
 * slot into one buffer. `build()` returns a single BufferGeometry carrying one
 * draw group per slot, so a weapon body is one mesh with N materials.
 */
export class Kit {
  constructor(uvScale = 1 / 0.35) {
    this.uvScale = uvScale;
    this.slots = new Map();
    this._pending = [];
    /**
     * Provenance tag stamped onto every part added from here on. It costs one
     * string per part and it is what makes the merged buffer auditable: the
     * whole point of merging is that the finished weapon is one geometry with
     * no part boundaries left in it, which also means a UV defect on the
     * ejection port is indistinguishable from one on the buffer tube by the
     * time anything can measure it. `build()` writes the ranges out to
     * `geometry.userData.parts`, and `src/weapons/uv-audit.mjs` reads them.
     */
    this.label = 'unlabelled';
  }

  /**
   * @param {THREE.BufferGeometry} geo
   * @param {number} slot material index
   * @param {object} t  { pos:[x,y,z], rot:[x,y,z], scale:number|[x,y,z], m:Matrix4 }
   */
  add(geo, slot, t = {}) {
    const m = t.m ? t.m.clone() : _compose(t);
    let list = this.slots.get(slot);
    if (!list) { list = []; this.slots.set(slot, list); }
    // The unwrap hint rides on the geometry (set by lathe/tube/cyl) unless the
    // caller overrides it, and it is evaluated in the part's own local space.
    list.push({ geo, m, uv: t.uv ?? geo.userData?.uv ?? null, label: t.label ?? this.label });
    return this;
  }

  /** Add a list of `{ geo, m }` produced by the composite helpers. */
  addParts(parts, slot, t = {}) {
    const base = t.m ? t.m.clone() : _compose(t);
    for (const p of parts) this.add(p.geo, slot, { m: base.clone().multiply(p.m), uv: t.uv, label: t.label });
    return this;
  }

  /** Mirror everything added inside `fn` across the YZ plane (left/right pairs). */
  mirrored(fn) {
    const before = new Map();
    for (const [k, v] of this.slots) before.set(k, v.length);
    fn(this);
    const flip = new THREE.Matrix4().makeScale(-1, 1, 1);
    for (const [k, list] of this.slots) {
      const start = before.get(k) ?? 0;
      const added = list.slice(start);
      for (const item of added) list.push({ geo: item.geo, m: flip.clone().multiply(item.m), uv: item.uv, label: item.label });
    }
    return this;
  }

  build() {
    const slots = [...this.slots.keys()].sort((a, b) => a - b);
    let total = 0;
    const baked = [];
    for (const s of slots) {
      let count = 0;
      const items = [];
      for (const { geo, m, uv, label } of this.slots.get(s)) {
        const g = geo.index ? geo.toNonIndexed() : geo;
        const n = g.attributes.position.count;
        items.push({ g, m, n, uv, label });
        count += n;
      }
      baked.push({ slot: s, items, count, start: total });
      total += count;
    }

    const pos = new Float32Array(total * 3);
    const nrm = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    let o = 0;
    const planar = [];
    const provenance = [];
    for (const b of baked) {
      for (const { g, m, n, uv: hint, label } of b.items) {
        provenance.push({ label, slot: b.slot, start: o, count: n, uv: hint ? hint.mode : 'planar' });
        const sp = g.attributes.position.array;
        const sn = g.attributes.normal ? g.attributes.normal.array : null;
        _n3.getNormalMatrix(m);
        // A mirrored transform reverses triangle winding; swap two corners of
        // every triangle back or the mirrored half renders inside-out.
        const flip = m.determinant() < 0;
        for (let i = 0; i < n; i++) {
          const src = flip ? (i - (i % 3)) + [0, 2, 1][i % 3] : i;
          _v.set(sp[src * 3], sp[src * 3 + 1], sp[src * 3 + 2]).applyMatrix4(m);
          pos[(o + i) * 3] = _v.x; pos[(o + i) * 3 + 1] = _v.y; pos[(o + i) * 3 + 2] = _v.z;
          if (sn) {
            _v.set(sn[src * 3], sn[src * 3 + 1], sn[src * 3 + 2]).applyMatrix3(_n3).normalize();
            nrm[(o + i) * 3] = _v.x; nrm[(o + i) * 3 + 1] = _v.y; nrm[(o + i) * 3 + 2] = _v.z;
          }
        }
        // Turned parts unwrap in their own local frame; everything else takes
        // the shared world-space planar projection so the grain stays continuous.
        if (hint && hint.mode === 'cylindrical') cylindricalUV(sp, n, flip, uv, o, hint, this.uvScale);
        else planar.push(o, n);
        o += n;
      }
    }

    for (let i = 0; i < planar.length; i += 2) projectUV(pos, nrm, uv, this.uvScale, planar[i], planar[i + 1]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    for (const b of baked) geo.addGroup(b.start, b.count, b.slot);
    geo.userData.parts = provenance;
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

function _compose(t) {
  const p = t.pos || [0, 0, 0];
  const r = t.rot || [0, 0, 0];
  const s = t.scale ?? 1;
  const sc = Array.isArray(s) ? s : [s, s, s];
  _e.set(r[0], r[1], r[2]);
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(
    _v.set(p[0], p[1], p[2]).clone(), _q, new THREE.Vector3(sc[0], sc[1], sc[2])
  );
}

/**
 * Dominant-axis planar UV projection, per triangle. Doing it per triangle
 * rather than per vertex means a chamfer facet never inherits a stretched
 * projection from the face it adjoins.
 */
export function projectUV(pos, nrm, uv, scale, start = 0, count = -1) {
  const n = count < 0 ? pos.length / 3 - start : count;
  const t0 = start / 3;
  const tri = n / 3;
  for (let tt = 0; tt < tri; tt++) {
    const t = t0 + tt;
    const i0 = t * 9;
    // Face normal from the geometric edges — robust even if normals are zero.
    const ax = pos[i0 + 3] - pos[i0], ay = pos[i0 + 4] - pos[i0 + 1], az = pos[i0 + 5] - pos[i0 + 2];
    const bx = pos[i0 + 6] - pos[i0], by = pos[i0 + 7] - pos[i0 + 1], bz = pos[i0 + 8] - pos[i0 + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const anx = Math.abs(nx), any = Math.abs(ny), anz = Math.abs(nz);
    for (let k = 0; k < 3; k++) {
      const j = t * 3 + k;
      const x = pos[j * 3], y = pos[j * 3 + 1], z = pos[j * 3 + 2];
      let u, v;
      if (anx >= any && anx >= anz) { u = z; v = y; }
      else if (any >= anz) { u = x; v = z; }
      else { u = x; v = y; }
      uv[j * 2] = u * scale;
      uv[j * 2 + 1] = v * scale;
    }
  }
}

/**
 * Cylindrical unwrap for a surface of revolution, evaluated on the part's own
 * *untransformed* vertices so a mirrored instance produces a mirrored unwrap
 * rather than a sheared one.
 *
 * Two things make this correct rather than merely round:
 *  - the seam. `atan2` jumps by 2pi somewhere on every ring, and a triangle
 *    that straddles the jump would smear the whole texture across itself. The
 *    three corners are unwrapped relative to the first, so the seam becomes a
 *    single edge instead of a band of garbage — and the branch cut is rotated
 *    to the *underside* of the part, because one unavoidable discontinuity in
 *    the grain belongs where a barrel meets its handguard, not up the flank
 *    the player looks at. (The dominant-axis projection this replaces had
 *    four such breaks per ring, each rotating the grain 90 degrees, which is
 *    what read as speckle banding.)
 *  - the caps. A disc whose normal runs along the axis has a constant axial
 *    coordinate, so the cylindrical v collapses and the texture streaks to
 *    infinity. Those faces get a planar projection in the cross-section plane.
 */
function cylindricalUV(src, n, flip, uv, out, hint, scale) {
  const axis = hint.axis || 'z';
  const R = hint.radius || 0.01;
  // Component indices: a = across, b = across, c = along the axis.
  const ai = axis === 'x' ? 1 : 0;
  const bi = axis === 'y' ? 2 : (axis === 'x' ? 2 : 1);
  const ci = axis === 'x' ? 0 : (axis === 'y' ? 1 : 2);
  const tri = n / 3;
  for (let t = 0; t < tri; t++) {
    const p0 = (t * 3) * 3;
    // Face normal from the untransformed edges; only its axial share matters.
    const ax = src[p0 + 3] - src[p0], ay = src[p0 + 4] - src[p0 + 1], az = src[p0 + 5] - src[p0 + 2];
    const bx = src[p0 + 6] - src[p0], by = src[p0 + 7] - src[p0 + 1], bz = src[p0 + 8] - src[p0 + 2];
    const fn = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    const len = Math.hypot(fn[0], fn[1], fn[2]) || 1;
    const axial = Math.abs(fn[ci]) / len > 0.72;

    let a0 = 0;
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      const s = flip ? (i - (i % 3)) + FLIP3[i % 3] : i;
      const pa = src[s * 3 + ai], pb = src[s * 3 + bi], pc = src[s * 3 + ci];
      let u, v;
      if (axial) { u = pa; v = pb; }
      else {
        // Branch cut at the bottom of the section (-b), not at -a.
        let ang = Math.atan2(pb, pa) + Math.PI * 0.5;
        if (ang < 0) ang += Math.PI * 2;
        if (k === 0) a0 = ang;
        else {
          while (ang - a0 > Math.PI) ang -= Math.PI * 2;
          while (ang - a0 < -Math.PI) ang += Math.PI * 2;
        }
        u = ang * R; v = pc;
      }
      uv[(out + i) * 2] = u * scale;
      uv[(out + i) * 2 + 1] = v * scale;
    }
  }
}

const FLIP3 = [0, 2, 1];

export { _mat as translate };
