import * as THREE from 'three';
import { groundGrime, clamp01, lerp } from './Geo.js';

/**
 * OWNER: level-art agent.
 *
 * The architectural kit. Every wall, opening, stair, pillar, arch and awning in
 * the compound is one of these calls; there is no bespoke building geometry
 * anywhere in the map, which is what makes the whole thing re-composable.
 *
 * SCALE IS LAW. The player is 1.75 m with a 1.62 m eye. Everything here is
 * dimensioned against that and the numbers are not decorative:
 *
 *   door clear height   2.10 m      window sill        0.95 m (leans on it)
 *   storey height       3.00 m      window head        2.35 m
 *   crouch cover        1.10 m      stand cover        1.50 m
 *   wall thickness      0.35 m      parapet            1.05 m above roof
 *   stair rise/going    0.175 / 0.29 m  (≈31°, comfortably under the 48° limit)
 *
 * Two outputs are produced side by side: render geometry into a `Batcher`
 * bucket, and a *separate, far simpler* proxy into a `ProxySet`. A pier that
 * renders as a chamfered box with a plinth, a cornice and a moulded reveal
 * collides as one untrimmed box.
 */

export const SCALE = {
  door: 2.10,
  doorWide: 1.15,
  storey: 3.00,
  wallT: 0.35,
  sill: 0.95,
  windowH: 1.40,
  crouch: 1.10,
  stand: 1.50,
  parapet: 1.05,
  rise: 0.175,
  going: 0.29,
};

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);

/** World matrix for a wall running from (x0,z0) to (x1,z1) with its base at y. */
function wallFrame(x0, z0, x1, z1, y) {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz) || 1;
  // Local +X follows the wall. A yaw of `a` maps local +X to (cos a, 0, -sin a).
  const a = Math.atan2(-dz, dx);
  _e.set(0, a, 0, 'YXZ');
  _q.setFromEuler(_e);
  _m.compose(_v.set((x0 + x1) / 2, y, (z0 + z1) / 2), _q, _one);
  return { m: _m.clone(), len, yaw: a };
}

function localToWorld(frame, x, y, z, out) {
  return out.set(x, y, z).applyMatrix4(frame);
}

/**
 * Weathering field for a walled surface. Grime climbs out of the ground and
 * pools under overhangs; staining hangs below every window sill and below the
 * cornice drip line. Evaluated in wall-local space, so a window at local x
 * stains the wall directly beneath it and nothing else.
 */
function wallWeather(frameInv, openings, height, opts = {}) {
  const corniceStain = opts.corniceStain ?? 0.55;
  const p = new THREE.Vector3();
  return (x, y, z, nx, ny, nz, out) => {
    groundGrime(x, y, z, nx, ny, nz, out);
    p.set(x, y, z).applyMatrix4(frameInv);
    const lx = p.x, ly = p.y;

    let stain = 0;
    for (let i = 0; i < openings.length; i++) {
      const o = openings[i];
      const sill = o.sill ?? 0;
      if (sill < 0.4 || ly > sill) continue;             // doors do not stain
      const half = o.w * 0.5 + 0.22;
      const across = 1 - clamp01((Math.abs(lx - o.x) - half * 0.55) / (half * 0.75));
      const down = clamp01(1 - (sill - ly) / 2.6);
      stain = Math.max(stain, across * down * down);
    }
    // The cornice sheds water down the top of the wall on every face.
    stain = Math.max(stain, clamp01((ly - (height - 1.9)) / 1.9) * corniceStain);
    // Only vertical faces streak; a soffit or a coping washes clean.
    out[1] = stain * (1 - Math.abs(ny));
    out[0] = Math.min(1, out[0] + stain * 0.25);
  };
}

/* ------------------------------------------------------------------ walls */

/**
 * One wall segment with openings.
 *
 * @param {object} kit  { batch, proxy }
 * @param {object} o
 *   x0,z0,x1,z1  ground-plane run
 *   base         y of the wall foot (default 0)
 *   height       wall height above `base`
 *   thickness    default SCALE.wallT
 *   bucket       render bucket key
 *   trim         bucket for plinth / cornice / sills (default = bucket)
 *   openings     [{ x, w, h, sill }] in wall-local metres, x measured from the
 *                centre of the run
 *   plinth       height of the splayed base course, 0 to omit
 *   cornice      height of the crowning band, 0 to omit
 *   collide      emit collision proxies (default true)
 *   grid         face tessellation for weathering (default 0.8 m)
 */
export function wall(kit, o) {
  const { batch, proxy } = kit;
  const base = o.base ?? 0;
  const H = o.height;
  const T = o.thickness ?? SCALE.wallT;
  const f = wallFrame(o.x0, o.z0, o.x1, o.z1, base);
  const L = f.len;
  const bucket = o.bucket || 'plaster';
  const trimBucket = o.trim || bucket;
  const openings = (o.openings || []).filter((k) => Math.abs(k.x) + k.w * 0.5 < L * 0.5 - 0.1);
  const grid = o.grid ?? 0.8;
  const chamfer = o.chamfer ?? 0.035;
  const collide = o.collide !== false;

  const cx = (o.x0 + o.x1) / 2, cz = (o.z0 + o.z1) / 2;
  const b = batch.at(bucket, cx, cz);
  b.frame(f.m);

  const inv = f.m.clone().invert();
  const weather = wallWeather(inv, openings, H, o);

  b.withWeather(weather, () => {
    if (!openings.length) {
      b.at(0, H / 2, 0).box(L, H, T, chamfer, grid);
    } else {
      // Sort openings and walk the run: pier, opening (with lintel above and
      // apron below), pier, ... The pier side faces double as the reveals.
      const ops = openings.slice().sort((p, q) => p.x - q.x);
      let cursor = -L / 2;
      for (const k of ops) {
        const l = k.x - k.w / 2, r = k.x + k.w / 2;
        const sill = k.sill ?? 0;
        const head = sill + k.h;
        if (l - cursor > 0.02) {
          const w = l - cursor;
          b.at(cursor + w / 2, H / 2, 0).box(w, H, T, chamfer, grid);
        }
        if (sill > 0.02) b.at(k.x, sill / 2, 0).box(k.w, sill, T, chamfer, grid);
        if (H - head > 0.02) {
          b.at(k.x, (head + H) / 2, 0).box(k.w, H - head, T, chamfer, grid);
        }
        cursor = r;
      }
      if (L / 2 - cursor > 0.02) {
        const w = L / 2 - cursor;
        b.at(cursor + w / 2, H / 2, 0).box(w, H, T, chamfer, grid);
      }
    }
  });

  // Plinth and cornice: the two mouldings that stop a wall reading as a slab.
  const tb = batch.at(trimBucket, cx, cz);
  tb.frame(f.m);
  const plinth = o.plinth ?? 0.34;
  if (plinth > 0) {
    tb.withWeather(weather, () => {
      // No face tessellation: a 340 mm plinth is entirely inside the splash
      // zone, so its weathering is constant and the extra vertices buy nothing.
      tb.at(0, plinth / 2, 0).box(L + 0.04, plinth, T + 0.11, 0.03, 0);
    });
  }
  const cornice = o.cornice ?? 0;
  if (cornice > 0) {
    tb.at(0, H - cornice * 0.5, 0).box(L + 0.06, cornice, T + 0.19, 0.04, 0);
    tb.at(0, H - cornice - 0.055, 0).box(L + 0.02, 0.11, T + 0.09, 0.025, 0);
  }

  // Openings get a moulded surround — drawn as separate bars, never as a slab,
  // so the hole stays a hole — plus a projecting sill. Exterior face only:
  // there are ~200 openings on this map and a mirrored inner surround doubles
  // their cost for trim that is only ever seen from inside four buildings.
  for (const k of openings) {
    const sill = k.sill ?? 0;
    const head = sill + k.h;
    const side = -(T / 2 + 0.045);
    for (const sx of [-1, 1]) {
      tb.at(k.x + sx * (k.w / 2 + 0.075), (sill + head) / 2, side)
        .box(0.15, k.h + 0.22, 0.09, 0.022, 0);
    }
    tb.at(k.x, head + 0.07, side).box(k.w + 0.30, 0.14, 0.10, 0.025, 0);
    if (sill > 0.3) {
      tb.at(k.x, sill - 0.05, -(T / 2 + 0.085)).box(k.w + 0.36, 0.10, 0.28, 0.025, 0);
    } else {
      tb.at(k.x, 0.055, side).box(k.w + 0.28, 0.11, 0.10, 0.02, 0);          // threshold
    }
  }

  if (collide) {
    const y0 = base, y1 = base + H;
    const push = (lx, w, ya, yb) => {
      localToWorld(f.m, lx, (ya + yb) / 2 - base, 0, _v);
      proxy.box(_v.x, _v.y, _v.z, w, yb - ya, T, f.yaw);
    };
    if (!openings.length) {
      push(0, L, y0, y1);
    } else {
      const ops = openings.slice().sort((p, q) => p.x - q.x);
      let cursor = -L / 2;
      for (const k of ops) {
        const l = k.x - k.w / 2, r = k.x + k.w / 2;
        const sill = base + (k.sill ?? 0);
        const head = sill + k.h;
        if (l - cursor > 0.05) push(cursor + (l - cursor) / 2, l - cursor, y0, y1);
        if (sill - y0 > 0.05) push(k.x, k.w, y0, sill);
        if (y1 - head > 0.05) push(k.x, k.w, head, y1);
        cursor = r;
      }
      if (L / 2 - cursor > 0.05) push(cursor + (L / 2 - cursor) / 2, L / 2 - cursor, y0, y1);
    }
  }

  b.clearFrame();
  tb.clearFrame();
  return f;
}

/* ---------------------------------------------------------------- windows */

/**
 * Fill an opening: recessed shutter board, a grille, and a glass pane.
 * Without this every window on the map is a black rectangle, which is the
 * single fastest way to make a blockout look like a blockout.
 *
 * CONVENTION: every wall run in this kit is authored so that **local -Z is the
 * exterior**. The fill is therefore stacked on the +Z side, deepest first, and
 * the player looking in from the street sees the reveal, then the grille, then
 * the glass, then the shutter behind it.
 */
export function windowFill(kit, frame, k, T, opts = {}) {
  const { batch } = kit;
  const sill = k.sill ?? 0;
  const cy = sill + k.h / 2;
  const p = localToWorld(frame, k.x, cy, 0, _v.clone());

  const sh = batch.at(opts.shutter || 'shutter', p.x, p.z);
  sh.frame(frame);
  sh.at(k.x, cy, T * 0.30).box(k.w - 0.06, k.h - 0.06, 0.07, 0.02, 0);
  const slats = Math.max(2, Math.min(4, Math.round(k.h / 0.42)));
  for (let i = 0; i < slats; i++) {
    const y = sill + 0.14 + (k.h - 0.28) * (i / (slats - 1 || 1));
    sh.at(k.x, y, T * 0.30 - 0.055).box(k.w - 0.12, 0.10, 0.035, 0.012, 0);
  }
  sh.clearFrame();

  if (opts.bars) {
    const mb = batch.at(opts.barBucket || 'ironwork', p.x, p.z);
    mb.frame(frame);
    const n = Math.max(2, Math.round(k.w / 0.34));
    for (let i = 0; i < n; i++) {
      const x = k.x - k.w / 2 + (k.w * (i + 0.5)) / n;
      mb.at(x, cy, T * 0.08).box(0.035, k.h - 0.05, 0.035, 0.008, 0);
    }
    mb.at(k.x, sill + k.h * 0.55, T * 0.08).box(k.w - 0.05, 0.035, 0.035, 0.008, 0);
    mb.clearFrame();
  }

  if (opts.glass !== false) {
    const g = batch.at('glass', p.x, p.z);
    g.frame(frame);
    g.at(k.x, cy, T * 0.19).box(k.w - 0.08, k.h - 0.08, 0.018, 0.006, 0);
    g.clearFrame();
  }
}

/* ------------------------------------------------------------------ roofs */

/**
 * Flat roof slab with a parapet and coping. `inset` pulls the parapet in from
 * the footprint so the slab overhangs it slightly, which is what casts the
 * dark line under the roof edge that reads as thickness at 40 m.
 */
export function roof(kit, o) {
  const { batch, proxy } = kit;
  const { x0, z0, x1, z1 } = o;
  const y = o.y;
  const bucket = o.bucket || 'concrete';
  const trim = o.trim || 'plaster';
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const w = Math.abs(x1 - x0), d = Math.abs(z1 - z0);
  const th = o.thickness ?? 0.30;

  const b = batch.at(bucket, cx, cz);
  b.at(cx, y - th / 2, cz).box(w + 0.34, th, d + 0.34, 0.05, 1.6);

  if (o.parapet !== 0) {
    const ph = o.parapet ?? SCALE.parapet;
    const pt = 0.26;
    const tb = batch.at(trim, cx, cz);
    // `sides` omits a run where a stair landing or a plank bridge arrives —
    // a roof you can reach but not step onto is worse than no roof at all.
    const sides = o.sides ?? 'nsew';
    const rails = [];
    if (sides.includes('s')) rails.push([x0, z0, x1, z0]);
    if (sides.includes('n')) rails.push([x0, z1, x1, z1]);
    if (sides.includes('w')) rails.push([x0, z0, x0, z1]);
    if (sides.includes('e')) rails.push([x1, z0, x1, z1]);
    for (const [ax, az, bx, bz] of rails) {
      const f = wallFrame(ax, az, bx, bz, y);
      const L = f.len;
      tb.frame(f.m);
      tb.at(0, ph / 2, 0).box(L, ph, pt, 0.03, 1.0);
      tb.at(0, ph + 0.045, 0).box(L + 0.10, 0.10, pt + 0.14, 0.028, 0);   // coping
      // Weep slots: a parapet with no drainage reads as a solid extruded band.
      const slots = Math.max(1, Math.floor(L / 3.4));
      for (let i = 0; i < slots; i++) {
        const x = -L / 2 + (L * (i + 0.5)) / slots;
        tb.at(x, ph - 0.30, 0).box(0.24, 0.24, pt + 0.05, 0.02, 0);
      }
      tb.clearFrame();
      if (o.collide !== false) {
        localToWorld(f.m, 0, ph / 2, 0, _v);
        proxy.box(_v.x, _v.y, _v.z, L, ph, pt, f.yaw);
      }
    }
  }
  if (o.collide !== false) proxy.extent(x0, y - th, z0, x1, y, z1);
  return y;
}

/* ----------------------------------------------------------------- stairs */

/**
 * A run of stairs climbing along +Z in its own frame, with a nosing on every
 * tread. Collision is a single ramp: the capsule solver glides, and the BVH
 * carries 12 triangles instead of 200.
 */
export function stairs(kit, o) {
  const { batch, proxy } = kit;
  const w = o.width;
  const rise = o.rise ?? SCALE.rise;
  const steps = Math.max(1, Math.round(o.height / rise));
  const r = o.height / steps;
  const going = o.going ?? SCALE.going;
  const len = steps * going;

  _e.set(0, o.yaw ?? 0, 0, 'YXZ');
  _q.setFromEuler(_e);
  _m.compose(_v.set(o.x, o.y ?? 0, o.z), _q, _one);
  const frame = _m.clone();

  const b = batch.at(o.bucket || 'concrete', o.x, o.z);
  b.frame(frame);
  for (let i = 0; i < steps; i++) {
    const z = -len / 2 + going * (i + 0.5);
    const h = r * (i + 1);
    b.at(0, h / 2, z).box(w, h, going, 0.02, 1.2);
    // Nosing: a 30 mm lip that throws a shadow line and stops the flight
    // reading as a smooth wedge at distance.
    b.at(0, h - 0.018, z - going / 2 - 0.015).box(w - 0.06, 0.05, 0.06, 0.012, 0);
  }
  // Stringers down both sides give the flight a silhouette from the front.
  for (const s of [-1, 1]) {
    b.at(s * (w / 2 + 0.055), o.height / 2, 0).box(0.12, o.height, len, 0.025, 1.2);
  }
  b.clearFrame();

  proxy.ramp(o.x, o.y ?? 0, o.z, w + 0.2, o.height, len, o.yaw ?? 0);
  return { len, steps };
}

/* --------------------------------------------------------------- railings */

/** Pipe railing: posts, top rail, mid rail. Collides as one thin wall. */
export function railing(kit, o) {
  const { batch, proxy } = kit;
  const f = wallFrame(o.x0, o.z0, o.x1, o.z1, o.y ?? 0);
  const L = f.len;
  const h = o.height ?? 1.05;
  const b = batch.at(o.bucket || 'ironwork', (o.x0 + o.x1) / 2, (o.z0 + o.z1) / 2);
  b.frame(f.m);
  const n = Math.max(2, Math.round(L / 1.3));
  for (let i = 0; i <= n; i++) {
    const x = -L / 2 + (L * i) / n;
    b.at(x, h / 2, 0).box(0.05, h, 0.05, 0.012, 0);
  }
  b.at(0, h - 0.03, 0).box(L, 0.06, 0.06, 0.015, 0);
  b.at(0, h * 0.52, 0).box(L, 0.04, 0.04, 0.01, 0);
  b.clearFrame();
  if (o.collide !== false) {
    localToWorld(f.m, 0, h / 2, 0, _v);
    proxy.box(_v.x, _v.y, _v.z, L, h, 0.12, f.yaw);
  }
}

/* ---------------------------------------------------------------- pillars */

/** Square pillar with a splayed base and a stepped capital. */
export function pillar(kit, o) {
  const { batch, proxy } = kit;
  const s = o.size ?? 0.42;
  const h = o.height;
  const b = batch.at(o.bucket || 'plaster', o.x, o.z);
  const y = o.y ?? 0;
  b.at(o.x, y + 0.14, o.z).box(s + 0.20, 0.28, s + 0.20, 0.035, 0);
  b.at(o.x, y + h / 2, o.z).box(s, h, s, 0.03, 1.2);
  b.at(o.x, y + h - 0.20, o.z).box(s + 0.14, 0.16, s + 0.14, 0.03, 0);
  b.at(o.x, y + h - 0.06, o.z).box(s + 0.26, 0.14, s + 0.26, 0.035, 0);
  if (o.collide !== false) proxy.box(o.x, y + h / 2, o.z, s + 0.16, h, s + 0.16);
}

/** Round column, for the market hall colonnade. */
export function column(kit, o) {
  const { batch, proxy } = kit;
  const r = o.radius ?? 0.24;
  const h = o.height;
  const y = o.y ?? 0;
  const b = batch.at(o.bucket || 'plaster', o.x, o.z);
  b.at(o.x, y + 0.16, o.z).box(r * 2.6, 0.32, r * 2.6, 0.04, 0);
  b.at(o.x, y + h / 2, o.z).cyl(r * 1.06, r * 0.94, h, 14, 0.03);
  b.at(o.x, y + h - 0.22, o.z).cyl(r * 1.15, r * 1.32, 0.24, 14, 0.03);
  b.at(o.x, y + h - 0.05, o.z).box(r * 3.0, 0.16, r * 3.0, 0.035, 0);
  if (o.collide !== false) proxy.box(o.x, y + h / 2, o.z, r * 2.1, h, r * 2.1);
}

/* ----------------------------------------------------------------- arches */

/**
 * Segmental arch built from real voussoirs. Each stone is a chamfered box
 * rotated to its own radial angle — this is what an arch has to be if the
 * shadowing along its intrados is going to look like masonry.
 */
export function archway(kit, o) {
  const { batch, proxy } = kit;
  const span = o.span;
  const springY = o.springY ?? SCALE.door;
  const riseH = o.rise ?? span * 0.42;
  const T = o.thickness ?? SCALE.wallT;
  const depth = o.depth ?? 0.42;
  const b = batch.at(o.bucket || 'brick', o.x, o.z);
  const yaw = o.yaw ?? 0;
  _e.set(0, yaw, 0, 'YXZ');
  _q.setFromEuler(_e);
  _m.compose(_v.set(o.x, o.y ?? 0, o.z), _q, _one);
  const frame = _m.clone();
  b.frame(frame);

  // Circular segment through (-span/2, springY), (0, springY+rise), (span/2, springY)
  const a = span / 2;
  const R = (a * a + riseH * riseH) / (2 * riseH);
  const cy = springY + riseH - R;
  const halfAngle = Math.asin(a / R);
  const n = o.stones ?? Math.max(7, Math.round((2 * halfAngle * R) / 0.42));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const ang = lerp(-halfAngle, halfAngle, t);
    const px = Math.sin(ang) * R;
    const py = cy + Math.cos(ang) * R;
    const arcW = (2 * halfAngle * R) / n + 0.02;
    // Rotate the voussoir about its own Z so its faces stay radial.
    _e.set(0, 0, -ang, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(_v.set(px, py, 0), _q, _one);
    b.setMatrix(_m);
    b.box(arcW, depth, T + 0.06, 0.022, 0);
  }
  // Keystone.
  _e.set(0, 0, 0, 'YXZ');
  _q.setFromEuler(_e);
  _m.compose(_v.set(0, springY + riseH + depth * 0.32, 0), _q, _one);
  b.setMatrix(_m);
  b.box(0.34, depth * 0.9, T + 0.14, 0.03, 0);
  b.clearFrame();

  if (o.collide !== false) {
    // Collide the arch as a flat lintel at the springing line: the crown is
    // above head height, so nobody can tell and the BVH stays cheap.
    localToWorld(frame, 0, springY + riseH * 0.5 + 0.35, 0, _v);
    proxy.box(_v.x, _v.y, _v.z, span, Math.max(0.2, riseH * 0.6), T, yaw);
  }
}

/* ---------------------------------------------------------------- awnings */

/**
 * Market awning: two poles, a rail, and a sagging cloth. The cloth is a
 * tessellated quad with catenary droop in both directions — a flat plane reads
 * as cardboard, and this is the piece of set dressing the player walks under
 * most often.
 */
export function awning(kit, o) {
  const { batch, proxy } = kit;
  const w = o.width, d = o.depth;
  const yaw = o.yaw ?? 0;
  const yHigh = o.height ?? 2.85;
  const yLow = yHigh - (o.drop ?? 0.55);
  _e.set(0, yaw, 0, 'YXZ');
  _q.setFromEuler(_e);
  _m.compose(_v.set(o.x, 0, o.z), _q, _one);
  const frame = _m.clone();

  const wood = batch.at(o.frameBucket || 'timber', o.x, o.z);
  wood.frame(frame);
  wood.at(0, yHigh + 0.04, -d / 2).box(w + 0.2, 0.09, 0.09, 0.02, 0);
  wood.at(0, yLow + 0.04, d / 2).box(w + 0.2, 0.09, 0.09, 0.02, 0);
  if (o.posts !== false) {
    for (const s of [-1, 1]) {
      wood.at(s * (w / 2), yLow / 2, d / 2).box(0.10, yLow, 0.10, 0.02, 0);
      wood.at(s * (w / 2), yHigh - 0.35, -d / 2 + 0.28).box(0.07, 0.07, 0.62, 0.015, 0);
    }
  }
  wood.clearFrame();

  const cloth = batch.at(o.clothBucket || 'awning', o.x, o.z);
  cloth.frame(frame);
  cloth.identity();
  const sag = o.sag ?? 0.16;
  const warp = (u, v, p) => {
    // Product of two half-sines: maximal droop mid-span in both directions,
    // pinned at all four attachment points.
    p[1] -= Math.sin(u * Math.PI) * Math.sin(Math.min(1, v * 1.35) * Math.PI) * sag;
  };
  const A = [-w / 2, yHigh, -d / 2], B = [w / 2, yHigh, -d / 2];
  const C = [w / 2, yLow, d / 2], D = [-w / 2, yLow, d / 2];
  // One sheet only — the cloth material is double sided, so the underside is
  // free and its normals are flipped by the rasteriser.
  cloth.quad(A, B, C, D, 0.3, warp);
  // Scalloped valance along the low edge.
  const scal = Math.max(2, Math.round(w / 0.5));
  for (let i = 0; i < scal; i++) {
    const x0 = -w / 2 + (w * i) / scal, x1 = -w / 2 + (w * (i + 1)) / scal;
    const dip = 0.16 + (i % 2) * 0.05;
    cloth.poly([x0, yLow, d / 2, x1, yLow, d / 2, (x0 + x1) / 2, yLow - dip, d / 2 - 0.02], null);
  }
  cloth.clearFrame();

  if (o.collide !== false && o.posts !== false) {
    for (const s of [-1, 1]) {
      localToWorld(frame, s * (w / 2), yLow / 2, d / 2, _v);
      proxy.box(_v.x, _v.y, _v.z, 0.16, yLow, 0.16, yaw);
    }
  }
}

/* ------------------------------------------------------------- composites */

/**
 * A closed building shell: four walls, a roof, a parapet, and window fills.
 * `interior: false` collides as one solid box — the player cannot get inside,
 * so there is no reason to make the BVH carry four walls.
 *
 * @param {object} o
 *   x0,z0,x1,z1  outer footprint
 *   storeys      integer, 3.00 m each unless `storeyHeight` says otherwise
 *   faces        { n, s, e, w } each { doors:[x...], windows:'auto'|[...] , blank:true }
 */
export function building(kit, o) {
  const { proxy } = kit;
  const storeys = o.storeys ?? 2;
  const sh = o.storeyHeight ?? SCALE.storey;
  const H = o.height ?? storeys * sh;
  const T = o.thickness ?? SCALE.wallT;
  const { x0, z0, x1, z1 } = o;
  const bucket = o.bucket || 'plaster';
  const trim = o.trim || 'plaster';
  const interior = !!o.interior;

  // Wall centre-lines are inset by half the thickness so the stated footprint
  // is the outside of the building, which is what the layout reasons about.
  const h = T / 2;
  const runs = {
    s: [x0 + h, z0 + h, x1 - h, z0 + h],
    n: [x1 - h, z1 - h, x0 + h, z1 - h],
    e: [x1 - h, z0 + h, x1 - h, z1 - h],
    w: [x0 + h, z1 - h, x0 + h, z0 + h],
  };

  for (const key of ['s', 'n', 'e', 'w']) {
    const spec = (o.faces && o.faces[key]) || {};
    if (spec.omit) continue;
    const [ax, az, bx, bz] = runs[key];
    const len = Math.hypot(bx - ax, bz - az);
    const openings = buildOpenings(len, H, storeys, sh, spec, o.seed + key.charCodeAt(0));
    const f = wall(kit, {
      x0: ax, z0: az, x1: bx, z1: bz,
      height: H, thickness: T, bucket, trim,
      openings, plinth: o.plinth ?? 0.34,
      cornice: o.cornice ?? 0.24,
      collide: !interior ? false : true,
      grid: o.grid ?? 0.8,
    });
    for (const k of openings) {
      if ((k.sill ?? 0) < 0.4) continue;
      windowFill(kit, f.m, k, T, { shutter: o.shutter, glass: o.glass, bars: k.bars });
    }
  }

  roof(kit, {
    x0: x0 + 0.04, z0: z0 + 0.04, x1: x1 - 0.04, z1: z1 - 0.04,
    y: H, bucket: o.roofBucket || 'concrete', trim,
    parapet: o.parapet, sides: o.parapetSides, thickness: 0.28,
    collide: true,
  });

  if (!interior) {
    // One box for the whole shell. 12 triangles instead of ~90.
    proxy.extent(x0, -0.5, z0, x1, H, z1);
  }
  return H;
}

/**
 * Window rhythm for a face. Bays are spaced on a fixed module and centred on
 * the run, which is why the elevations read as designed rather than random.
 */
function buildOpenings(len, H, storeys, sh, spec, seed) {
  const out = [];
  if (spec.blank) return spec.doors ? doorList(spec, out) : out;
  const module = spec.module ?? 3.0;
  const bays = Math.max(0, Math.floor((len - 1.4) / module));
  const w = spec.windowW ?? 0.95;
  let s = (seed | 0) || 7;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let st = 0; st < storeys; st++) {
    const base = st * sh;
    if (base + SCALE.sill + SCALE.windowH + 0.35 > H) break;
    for (let i = 0; i < bays; i++) {
      const x = -((bays - 1) * module) / 2 + i * module;
      // A few bays are bricked up. Real streets are never fully glazed and the
      // irregularity is most of what sells the elevation.
      if (rnd() < 0.12) continue;
      out.push({
        x, w, h: SCALE.windowH, sill: base + SCALE.sill,
        bars: st === 0 ? true : rnd() < 0.4,
      });
    }
  }
  return doorList(spec, out);
}

function doorList(spec, out) {
  for (const d of spec.doors || []) {
    out.push({ x: typeof d === 'number' ? d : d.x, w: (d.w ?? SCALE.doorWide), h: (d.h ?? SCALE.door), sill: 0 });
  }
  return out;
}

export { wallFrame, localToWorld };
