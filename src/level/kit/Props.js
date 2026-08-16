import * as THREE from 'three';
import { GeoBuilder, rng, lerp } from './Geo.js';

/**
 * OWNER: level-art agent.
 *
 * Set dressing. Two families:
 *
 *  - **Prototypes** (`proto*`) return a finished BufferGeometry authored around
 *    the origin, ready to hand to an InstancedMesh. Anything that appears more
 *    than three times on the map lives here: crates, barrels, sandbags, jersey
 *    barriers, pallets, tyres, AC units, bollards, rubble, pipe bundles.
 *  - **Placers** (`place*`) emit one-off geometry straight into a batcher
 *    bucket. Vehicles and market stalls are placers: they are big, there are
 *    only a handful of each, and they want per-instance variation that would
 *    cost more as separate instanced kinds than as merged triangles.
 *
 * Cover heights are the reason most of these exist, so they are dimensioned to
 * the two that matter: 1.10 m (breaks line of sight when crouched, shoot over
 * standing) and 1.50 m (breaks line of sight standing, must lean or move).
 */

/* ------------------------------------------------------------ prototypes */

function build(fn, uvScale = 1.4) {
  const b = new GeoBuilder({ uvScale, weather: null });
  fn(b);
  return b.toGeometry(false);
}

/** Ammunition/produce crate. 0.62 m — three stacked make crouch cover. */
export function protoCrate(size = 0.62) {
  return build((b) => {
    const s = size;
    b.at(0, s / 2, 0).box(s, s, s, 0.016);
    // Corner braces and a lid rail: the difference between a crate and a cube.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.at(sx * (s / 2 - 0.03), s / 2, sz * (s / 2 - 0.03)).box(0.075, s + 0.012, 0.075, 0.012);
      }
    }
    b.at(0, s - 0.035, 0).box(s + 0.02, 0.055, s + 0.02, 0.012);
    b.at(0, 0.045, 0).box(s + 0.02, 0.055, s + 0.02, 0.012);
    b.at(0, s / 2, s / 2 + 0.004).box(s * 0.55, 0.10, 0.012, 0.004);
  }, 0.9);
}

/** 200 litre drum: 0.58 m across, 0.88 m tall, rolled hoops. */
export function protoBarrel() {
  return build((b) => {
    const r = 0.29, h = 0.88;
    b.at(0, h / 2, 0).cyl(r, r, h, 16, 0.02);
    // Rolling hoops. Unchamfered on purpose: at 55 mm tall the bevel is below
    // a pixel at any range, and `cyl` now emits one band instead of three.
    for (const y of [h * 0.28, h * 0.5, h * 0.72]) {
      b.at(0, y, 0).cyl(r + 0.022, r + 0.022, 0.055, 14, 0, false, false);
    }
    b.at(0, h - 0.012, 0).cyl(r - 0.02, r - 0.02, 0.05, 16, 0.012);
    b.at(0.13, h + 0.012, 0.05).cyl(0.045, 0.045, 0.05, 8, 0.008);
  }, 0.8);
}

/** Sandbag: an ellipsoid-ish lozenge, deliberately lumpy. */
function sandbagLump(b, x, y, z, ry, len = 0.46, wid = 0.26, hgt = 0.17, seed = 1) {
  const r = rng(seed);
  // Two overlapping chamfered slabs of slightly different size and yaw read as
  // a slumped bag; a third adds nothing a revetment wall of ninety bags can
  // show, and the wall is instanced twenty times.
  b.at(x, y, z, ry);
  b.box(len, hgt, wid, hgt * 0.45);
  b.at(x + (r() - 0.5) * 0.06, y + hgt * 0.14, z, ry + (r() - 0.5) * 0.28);
  b.box(len * 0.84, hgt * 0.82, wid * 0.94, hgt * 0.4);
}

/**
 * A sandbag wall section, 2.0 m long. `courses` sets the height:
 * 6 courses ≈ 1.05 m (crouch cover), 9 ≈ 1.55 m (standing cover).
 */
export function protoSandbagWall(courses = 6, length = 2.0, seed = 3) {
  return build((b) => {
    const bagL = 0.46, bagH = 0.17;
    const per = Math.max(2, Math.round(length / bagL));
    const r = rng(seed);
    for (let c = 0; c < courses; c++) {
      const y = bagH * 0.86 * (c + 0.5);
      const stagger = (c & 1) ? bagL * 0.5 : 0;
      const inset = c * 0.012;                    // battered face, like a real revetment
      for (let i = 0; i < per; i++) {
        const x = -length / 2 + bagL * (i + 0.5) + stagger - bagL * 0.25;
        if (Math.abs(x) > length / 2) continue;
        sandbagLump(b, x, y, (r() - 0.5) * 0.04 + inset * 0.3,
          (r() - 0.5) * 0.13, bagL - inset, 0.26 - inset * 0.5, bagH, seed + c * 7 + i);
      }
    }
  }, 0.7);
}

/** Concrete jersey barrier, 2.0 m, 0.82 m tall — classic crouch cover. */
export function protoJersey() {
  return build((b) => {
    const L = 2.0;
    b.at(0, 0.10, 0).box(L, 0.20, 0.60, 0.03);
    b.at(0, 0.34, 0).box(L, 0.30, 0.44, 0.06);
    b.at(0, 0.66, 0).box(L, 0.36, 0.26, 0.04);
    b.at(0, 0.84, 0).box(L + 0.04, 0.06, 0.30, 0.02);
    // Lift holes and the joint lug that lets barriers chain together.
    for (const s of [-1, 1]) b.at(s * (L / 2), 0.55, 0).box(0.07, 0.5, 0.16, 0.02);
  }, 1.2);
}

/** Euro pallet. Flat cover, stack fodder, and a leaning prop. */
export function protoPallet() {
  return build((b) => {
    const w = 1.2, d = 0.8;
    for (let i = 0; i < 3; i++) {
      const z = -d / 2 + 0.075 + (d - 0.15) * (i / 2);
      b.at(0, 0.055, z).box(w, 0.10, 0.14, 0.012);
    }
    for (let i = 0; i < 6; i++) {
      const x = -w / 2 + 0.05 + (w - 0.1) * (i / 5);
      b.at(x, 0.125, 0).box(0.09, 0.022, d, 0.006);
    }
    for (let i = 0; i < 3; i++) {
      const z = -d / 2 + 0.075 + (d - 0.15) * (i / 2);
      b.at(0, 0.008, z).box(w, 0.018, 0.10, 0.005);
    }
  }, 0.7);
}

/** Truck tyre. */
export function protoTyre() {
  return build((b) => {
    const R = 0.42, r = 0.14, seg = 16;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      // Six-sided torus section: cheap, and the flat facets catch light like
      // the blocks of a tyre tread do.
      const ring = [];
      for (let k = 0; k < 6; k++) {
        const t = (k / 6) * Math.PI * 2;
        ring.push([Math.cos(t) * r, Math.sin(t) * r]);
      }
      for (let k = 0; k < 6; k++) {
        const k2 = (k + 1) % 6;
        const p = (c, s, e) => [c * (R + e[0]), e[1], s * (R + e[0])];
        b.quad(p(c0, s0, ring[k]), p(c1, s1, ring[k]), p(c1, s1, ring[k2]), p(c0, s0, ring[k2]));
      }
    }
  }, 0.5);
}

/** Rooftop air-conditioning unit with a fan cowl and a grille. */
export function protoAcUnit() {
  return build((b) => {
    b.at(0, 0.34, 0).box(0.92, 0.68, 0.72, 0.03);
    b.at(0, 0.70, 0).box(0.98, 0.06, 0.78, 0.02);
    b.at(0, 0.76, 0).cyl(0.27, 0.27, 0.10, 12, 0.02);
    for (let i = 0; i < 4; i++) {
      b.at(0, 0.80, 0, (i / 4) * Math.PI).box(0.46, 0.014, 0.07, 0.005);
    }
    for (let i = 0; i < 6; i++) {
      b.at(-0.46 - 0.005, 0.16 + i * 0.09, 0).box(0.02, 0.045, 0.6, 0.006);
    }
    for (const s of [-1, 1]) {
      for (const t of [-1, 1]) b.at(s * 0.38, 0.03, t * 0.28).box(0.1, 0.06, 0.1, 0.012);
    }
  }, 0.9);
}

/** Bundle of five pipes on a low cradle. */
export function protoPipeBundle() {
  return build((b) => {
    const L = 3.2;
    const lay = [[-0.34, 0.17], [0, 0.17], [0.34, 0.17], [-0.17, 0.47], [0.17, 0.47]];
    for (const [x, y] of lay) {
      b.at(x, y, 0, 0, Math.PI / 2).cyl(0.16, 0.16, L, 12, 0.012);
    }
    for (const z of [-L / 2 + 0.4, L / 2 - 0.4]) {
      b.at(0, 0.035, z).box(1.1, 0.07, 0.14, 0.015);
      for (const s of [-1, 1]) b.at(s * 0.52, 0.2, z).box(0.07, 0.4, 0.12, 0.015);
    }
  }, 1.0);
}

/** Rubble heap: a cluster of angular chunks with dust between them. */
export function protoRubble(seed = 11) {
  return build((b) => {
    const r = rng(seed);
    const n = 16;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const rad = Math.pow(r(), 0.6) * 1.15;
      const s = lerp(0.10, 0.42, Math.pow(1 - rad / 1.2, 1.5) * r());
      const y = Math.max(0.05, (0.55 - rad * 0.42) * (0.5 + r() * 0.9));
      b.at(Math.cos(a) * rad, y * 0.5 + 0.02, Math.sin(a) * rad, r() * 3.14, r() * 0.5, r() * 0.5);
      b.box(s * 1.6, s, s * 1.3, s * 0.22);
    }
    // Exposed rebar.
    for (let i = 0; i < 4; i++) {
      const a = r() * Math.PI * 2, rad = r() * 0.7;
      const pts = [];
      for (let k = 0; k < 4; k++) {
        pts.push([Math.cos(a) * rad + k * 0.09 * Math.cos(a + 1), 0.2 + k * 0.16 - k * k * 0.02,
          Math.sin(a) * rad + k * 0.09 * Math.sin(a + 1)]);
      }
      b.tube(pts, 0.012);
    }
  }, 1.0);
}

/** Short bollard / kerb stone. */
export function protoBollard() {
  return build((b) => {
    b.at(0, 0.06, 0).box(0.34, 0.12, 0.34, 0.02);
    b.at(0, 0.5, 0).cyl(0.115, 0.10, 0.78, 10, 0.02);
    b.at(0, 0.9, 0).cyl(0.13, 0.09, 0.07, 10, 0.015);
  }, 0.6);
}

/** Plastic water tank on a stand — a rooftop silhouette staple. */
export function protoWaterTank() {
  return build((b) => {
    b.at(0, 0.86, 0).cyl(0.56, 0.52, 1.10, 14, 0.05);
    b.at(0, 1.43, 0).cyl(0.20, 0.20, 0.08, 10, 0.02);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      b.at(Math.cos(a) * 0.46, 0.16, Math.sin(a) * 0.46).box(0.08, 0.32, 0.08, 0.015);
    }
    b.at(0, 0.33, 0).box(1.18, 0.07, 1.18, 0.02);
  }, 0.9);
}

/** Satellite dish, the other rooftop staple. */
export function protoDish() {
  return build((b) => {
    b.at(0, 0.28, 0).box(0.26, 0.56, 0.26, 0.02);
    b.at(0, 0.72, 0, 0, -0.5).cyl(0.44, 0.40, 0.09, 14, 0.03);
    b.at(0, 0.86, 0.16).box(0.05, 0.05, 0.34, 0.01);
    b.at(0, 0.92, 0.32).box(0.09, 0.09, 0.12, 0.02);
  }, 0.7);
}

/* --------------------------------------------------------------- placers */

/**
 * Market stall: timber frame, a striped cloth roof with sag, a counter, and a
 * pile of goods. Placed rather than instanced because its cloth and its goods
 * want to differ from stall to stall.
 */
export function placeStall(kit, o) {
  const { batch, proxy } = kit;
  const w = o.width ?? 2.6, d = o.depth ?? 1.8;
  const yaw = o.yaw ?? 0;
  const postH = 2.35;
  const seed = o.seed ?? 5;
  const r = rng(seed);

  const y0 = o.y ?? 0;
  const frame = new THREE.Matrix4().compose(
    new THREE.Vector3(o.x, y0, o.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ')),
    new THREE.Vector3(1, 1, 1));

  const t = batch.at('timber', o.x, o.z);
  t.frame(frame);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      t.at(sx * (w / 2 - 0.06), postH / 2, sz * (d / 2 - 0.06)).box(0.09, postH, 0.09, 0.018);
    }
  }
  t.at(0, postH - 0.05, -d / 2 + 0.06).box(w, 0.08, 0.08, 0.018);
  t.at(0, postH - 0.05, d / 2 - 0.06).box(w, 0.08, 0.08, 0.018);
  // Counter at 0.92 m with a plank top and a valance board.
  t.at(0, 0.90, d / 2 - 0.34).box(w - 0.1, 0.07, 0.68, 0.015);
  t.at(0, 0.55, d / 2 - 0.04).box(w - 0.12, 0.62, 0.05, 0.012);
  for (const sx of [-1, 1]) t.at(sx * (w / 2 - 0.12), 0.45, d / 2 - 0.34).box(0.07, 0.9, 0.6, 0.015);
  t.clearFrame();

  const c = batch.at(o.clothBucket || 'awning', o.x, o.z);
  c.frame(frame);
  c.identity();
  const yH = postH + 0.16, yL = postH - 0.02;
  const warp = (u, v, p) => { p[1] -= Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 0.13; };
  c.quad([-w / 2 - 0.2, yH, -d / 2 - 0.2], [w / 2 + 0.2, yH, -d / 2 - 0.2],
    [w / 2 + 0.2, yL, d / 2 + 0.25], [-w / 2 - 0.2, yL, d / 2 + 0.25], 0.28, warp);
  // Front valance, dipping between the posts.
  const n = 5;
  for (let i = 0; i < n; i++) {
    const x0 = -w / 2 - 0.2 + (w + 0.4) * (i / n), x1 = -w / 2 - 0.2 + (w + 0.4) * ((i + 1) / n);
    c.poly([x0, yL, d / 2 + 0.25, x1, yL, d / 2 + 0.25,
      (x0 + x1) / 2, yL - 0.22, d / 2 + 0.22], null);
  }
  c.clearFrame();

  // Goods on the counter: sacks and stacked produce boxes.
  const g = batch.at(o.goodsBucket || 'sack', o.x, o.z);
  g.frame(frame);
  for (let i = 0; i < 5; i++) {
    const x = -w / 2 + 0.3 + (w - 0.6) * (i / 4);
    g.at(x + (r() - 0.5) * 0.1, 1.06, d / 2 - 0.34 + (r() - 0.5) * 0.2, r() * 3.14)
      .box(0.34, 0.24, 0.3, 0.09);
  }
  for (let i = 0; i < 3; i++) {
    g.at(-w / 2 + 0.4 + r() * (w - 0.8), 0.17 + r() * 0.3, -d / 2 + 0.4 + r() * 0.5, r() * 3.14)
      .box(0.4, 0.32, 0.36, 0.11);
  }
  g.clearFrame();

  if (o.collide !== false) {
    proxy.box(o.x, y0 + 0.62, o.z, w, 1.24, d * 0.72, yaw);
    proxy.box(o.x, y0 + postH - 0.1, o.z, w, 0.3, d, yaw);
  }
}

/**
 * Civilian vehicle, blocked out and chamfered. Three variants share one
 * builder because the differences that matter at gameplay distance are the
 * silhouette proportions, not the panel work.
 *
 * @param {'sedan'|'pickup'|'van'} kind
 */
export function placeVehicle(kit, o) {
  const { batch, proxy } = kit;
  const kind = o.kind || 'sedan';
  const yaw = o.yaw ?? 0;
  const body = batch.at(o.bodyBucket || 'carpaint', o.x, o.z);
  const trimB = batch.at('chrome', o.x, o.z);
  const glassB = batch.at('glass', o.x, o.z);
  const tyreB = batch.at('tyre', o.x, o.z);

  const frame = new THREE.Matrix4().compose(
    new THREE.Vector3(o.x, 0, o.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ')),
    new THREE.Vector3(1, 1, 1));
  body.frame(frame); trimB.frame(frame); glassB.frame(frame); tyreB.frame(frame);

  const P = {
    sedan: { L: 4.4, W: 1.78, wheelbase: 2.62, sillY: 0.52, roofY: 1.44, cabZ: -0.1, cabL: 2.0, hoodY: 1.0 },
    pickup: { L: 5.3, W: 1.95, wheelbase: 3.2, sillY: 0.68, roofY: 1.86, cabZ: -0.75, cabL: 1.7, hoodY: 1.26 },
    van: { L: 4.9, W: 1.9, wheelbase: 2.9, sillY: 0.6, roofY: 2.05, cabZ: -0.4, cabL: 3.2, hoodY: 1.35 },
  }[kind];

  const { L, W, sillY, roofY, cabZ, cabL, hoodY } = P;
  const rideH = o.flat ? 0.24 : 0.32;

  // Lower body: sills, a slightly narrower rocker, and wheel-arch blisters.
  body.at(0, sillY, 0).box(W, (sillY - rideH) * 2 + 0.18, L, 0.09, 1.0);
  body.at(0, sillY + 0.30, 0).box(W - 0.06, 0.5, L - 0.5, 0.10, 1.0);
  // Bonnet / bed.
  if (kind === 'pickup') {
    body.at(0, hoodY - 0.18, cabZ + cabL / 2 + 1.15).box(W - 0.05, 0.72, 2.3, 0.06, 1.0);
    body.at(0, hoodY - 0.5, cabZ + cabL / 2 + 1.15).box(W - 0.3, 0.1, 2.1, 0.03, 0);
    body.at(0, hoodY - 0.62, -L / 2 + 0.9).box(W - 0.08, 0.5, 1.5, 0.07, 0.8);
  } else {
    body.at(0, hoodY - 0.06, -L / 2 + 0.85).box(W - 0.12, 0.34, 1.5, 0.07, 0.8);
    if (kind === 'sedan') body.at(0, hoodY - 0.02, L / 2 - 0.8).box(W - 0.14, 0.38, 1.3, 0.07, 0.8);
  }
  // Cabin: a tapered box, so the greenhouse is narrower than the sills.
  const cabH = roofY - hoodY + 0.1;
  body.at(0, hoodY + cabH / 2 - 0.05, cabZ).box(W - 0.22, cabH, cabL, 0.12, 0.8);
  body.at(0, roofY - 0.03, cabZ).box(W - 0.34, 0.10, cabL - 0.16, 0.05, 0);

  // Glazing, inset so the pillars read.
  const gI = 0.03;
  for (const s of [-1, 1]) {
    glassB.at(s * (W / 2 - 0.13 + gI), hoodY + cabH * 0.5, cabZ)
      .box(0.02, cabH - 0.34, cabL - 0.42, 0.008, 0);
  }
  glassB.at(0, hoodY + cabH * 0.46, cabZ - cabL / 2 + 0.06).box(W - 0.42, cabH - 0.3, 0.02, 0.008, 0);
  glassB.at(0, hoodY + cabH * 0.46, cabZ + cabL / 2 - 0.06).box(W - 0.42, cabH - 0.34, 0.02, 0.008, 0);

  // Bumpers, lights, mirrors, exhaust.
  for (const s of [-1, 1]) {
    trimB.at(0, 0.56, s * (L / 2 - 0.06)).box(W + 0.03, 0.24, 0.16, 0.04, 0);
    for (const t of [-1, 1]) {
      trimB.at(t * (W / 2 - 0.28), 0.82, s * (L / 2 - 0.02)).box(0.4, 0.18, 0.08, 0.02, 0);
    }
  }
  for (const s of [-1, 1]) {
    trimB.at(s * (W / 2 + 0.04), hoodY + cabH * 0.55, cabZ - cabL / 2 + 0.2).box(0.18, 0.11, 0.07, 0.02, 0);
  }
  trimB.at(W / 2 - 0.4, 0.34, L / 2 - 0.05).cyl(0.035, 0.04, 0.16, 8, 0.01);

  // Wheels: four tyres with a hub face, sunk if the vehicle is derelict.
  const wb = P.wheelbase;
  const tyreR = kind === 'sedan' ? 0.33 : 0.38;
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const wy = o.flat && sz < 0 ? tyreR * 0.68 : tyreR;
      tyreB.at(sx * (W / 2 - 0.11), wy, sz * wb / 2, 0, 0, Math.PI / 2)
        .cyl(tyreR, tyreR, 0.24, 14, 0.06);
      trimB.at(sx * (W / 2 - 0.09), wy, sz * wb / 2, 0, 0, Math.PI / 2)
        .cyl(tyreR * 0.55, tyreR * 0.55, 0.26, 10, 0.03);
    }
  }

  body.clearFrame(); trimB.clearFrame(); glassB.clearFrame(); tyreB.clearFrame();

  if (o.collide !== false) {
    proxy.box(o.x, 0.55, o.z, W + 0.1, 1.1, L, yaw);
    // Local +Z maps to world (sin yaw, 0, cos yaw), so the cabin proxy has to
    // be pushed along that, not along world Z.
    proxy.box(o.x + Math.sin(yaw) * cabZ, hoodY + cabH / 2 - 0.05,
      o.z + Math.cos(yaw) * cabZ, W - 0.2, cabH, cabL, yaw);
  }
}

/**
 * Hanging rug / carpet on a rail. Vertical cloth with a slow horizontal wave;
 * the single best readability cue in an alley because it breaks the sightline
 * without blocking movement.
 */
export function placeHangingRug(kit, o) {
  const { batch } = kit;
  const w = o.width ?? 1.5, h = o.height ?? 2.1;
  const yaw = o.yaw ?? 0;
  const top = o.top ?? 3.0;
  const c = batch.at(o.bucket || 'rug', o.x, o.z);
  const frame = new THREE.Matrix4().compose(
    new THREE.Vector3(o.x, 0, o.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ')),
    new THREE.Vector3(1, 1, 1));
  c.frame(frame);
  c.identity();
  const phase = o.phase ?? 0;
  const warp = (u, v, p) => {
    // A hanging textile is stiff at the rail and free at the hem.
    p[2] += Math.sin(u * 6.0 + phase) * 0.055 * (0.2 + v);
    p[0] += Math.sin(u * 3.0 + phase) * 0.02 * v;
  };
  c.quad([-w / 2, top, 0], [w / 2, top, 0], [w / 2, top - h, 0], [-w / 2, top - h, 0], 0.22, warp);
  // Fringe.
  for (let i = 0; i < 10; i++) {
    const x = -w / 2 + w * ((i + 0.5) / 10);
    c.at(x, top - h - 0.045, 0).box(w / 14, 0.09, 0.012, 0.004);
  }
  c.clearFrame();
}

/**
 * Overhead cable run between two anchors, hanging in a real catenary.
 * `sag` is the drop at mid-span in metres.
 */
export function placeCable(kit, a, bPt, sag = 0.5, radius = 0.018, bucket = 'ironwork') {
  const { batch } = kit;
  const g = batch.at(bucket, (a[0] + bPt[0]) / 2, (a[2] + bPt[2]) / 2);
  g.identity();
  const N = 10;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // cosh-shaped, normalised so the endpoints are exact and the mid-span drop
    // equals `sag`. A parabola would be visually identical here but this is the
    // shape a cable actually takes and it costs one extra cosh.
    const u = (t - 0.5) * 2;
    const k = (Math.cosh(u * 1.8) - Math.cosh(1.8)) / (1 - Math.cosh(1.8));
    pts.push([
      lerp(a[0], bPt[0], t),
      lerp(a[1], bPt[1], t) - sag * k,
      lerp(a[2], bPt[2], t),
    ]);
  }
  g.tube(pts, radius, false);
}

/** Painted sign board on a wall or a post. */
export function placeSign(kit, o) {
  const { batch } = kit;
  const w = o.width ?? 1.8, h = o.height ?? 0.62;
  const yaw = o.yaw ?? 0;
  const y = o.y ?? 2.6;
  const s = batch.at(o.bucket || 'signage', o.x, o.z);
  s.at(o.x, y, o.z, yaw).box(w, h, 0.06, 0.012, 0);
  const f = batch.at('ironwork', o.x, o.z);
  f.at(o.x, y, o.z, yaw).box(w + 0.06, h + 0.06, 0.03, 0.008, 0);
  if (o.posts) {
    for (const sx of [-1, 1]) {
      f.at(o.x + Math.cos(yaw) * sx * (w / 2 - 0.1), y / 2 + h / 2,
        o.z - Math.sin(yaw) * sx * (w / 2 - 0.1), yaw).box(0.06, y + h / 2, 0.06, 0.012, 0);
    }
  }
}

/**
 * Wall-mounted or pole-mounted light fixture. Returns the world position of
 * the emitter so the caller can register a point light there.
 */
export function placeLamp(kit, o) {
  const { batch } = kit;
  const yaw = o.yaw ?? 0;
  const m = batch.at('ironwork', o.x, o.z);
  const e = batch.at('emissive', o.x, o.z);
  const dx = Math.cos(yaw), dz = -Math.sin(yaw);
  if (o.style === 'pendant') {
    m.at(o.x, o.y + 0.24, o.z).box(0.035, 0.48, 0.035, 0.008, 0);
    m.at(o.x, o.y - 0.02, o.z).cyl(0.20, 0.06, 0.16, 10, 0.02);
    e.at(o.x, o.y - 0.10, o.z).cyl(0.055, 0.055, 0.12, 8, 0.02);
    return [o.x, o.y - 0.10, o.z];
  }
  // Gooseneck bracket off a wall.
  const ax = o.x + dx * 0.16, az = o.z + dz * 0.16;
  m.at(ax, o.y, az, yaw).box(0.12, 0.22, 0.12, 0.02, 0);
  m.at(o.x + dx * 0.42, o.y + 0.06, o.z + dz * 0.42, yaw).box(0.05, 0.05, 0.55, 0.01, 0);
  m.at(o.x + dx * 0.7, o.y - 0.04, o.z + dz * 0.7, yaw).cyl(0.24, 0.10, 0.16, 10, 0.02);
  e.at(o.x + dx * 0.7, o.y - 0.13, o.z + dz * 0.7).cyl(0.13, 0.13, 0.035, 10, 0.01);
  return [o.x + dx * 0.7, o.y - 0.16, o.z + dz * 0.7];
}

/**
 * A beam spanning a street, on corbel brackets at both ends, with optional
 * cross-joists and a plank deck over part of it.
 *
 * This is a composition tool rather than a set piece. Every reference frame
 * from a shipped military shooter has something dark inside four metres of the
 * camera that frames the lit street beyond it and gives the eye a black to
 * measure the midtones against; on this map there was nothing in that band
 * except the weapon. A beam at 2.7 m does it without costing the player a
 * single metre of movement.
 *
 * @param {object} o
 *   x0,z0,x1,z1  the span, wall face to wall face
 *   y            underside of the beam (default 2.7)
 *   depth        beam depth (default 0.26)
 *   joists       number of cross members over the span (default 0)
 *   deck         0..1 fraction of the span planked over (default 0)
 */
export function placeSpan(kit, o) {
  const { batch } = kit;
  const y = o.y ?? 2.7;
  const dep = o.depth ?? 0.26;
  const wid = o.width ?? 0.20;
  const dx = o.x1 - o.x0, dz = o.z1 - o.z0;
  const len = Math.hypot(dx, dz) || 1;
  const yaw = Math.atan2(-dz, dx);
  const cx = (o.x0 + o.x1) / 2, cz = (o.z0 + o.z1) / 2;
  const b = batch.at(o.bucket || 'timber', cx, cz);
  const frame = new THREE.Matrix4().compose(
    new THREE.Vector3(cx, 0, cz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ')),
    new THREE.Vector3(1, 1, 1));
  b.frame(frame);
  b.at(0, y + dep / 2, 0).box(len, dep, wid, 0.03, 0);
  // Corbels: a beam that meets a wall in a butt joint reads as a floating bar.
  for (const s of [-1, 1]) {
    b.at(s * (len / 2 - 0.28), y - 0.10, 0).box(0.5, 0.20, wid + 0.10, 0.025, 0);
    b.at(s * (len / 2 - 0.16), y - 0.34, 0, 0, 0, s * 0.7).box(0.44, 0.13, wid, 0.02, 0);
  }
  const joists = o.joists ?? 0;
  for (let i = 0; i < joists; i++) {
    const t = -len / 2 + (len * (i + 1)) / (joists + 1);
    b.at(t, y + dep * 0.42, 0).box(0.13, 0.13, wid + 0.9, 0.02, 0);
  }
  if (o.deck) {
    const dl = len * o.deck;
    for (let i = 0; i < 6; i++) {
      b.at((o.deckOffset ?? 0) * len, y + dep + 0.03, -0.45 + i * 0.18).box(dl, 0.05, 0.16, 0.014, 0);
    }
  }
  b.clearFrame();
  return { yaw, len };
}

/**
 * A run of textiles hung from a wire across a street: rugs, sheets, sacking.
 * The hem sits at `clear` metres so the player walks under it untouched, and
 * the sheet occupies the top half of the frame — which is where a near-field
 * occluder actually has to be to frame the midground.
 */
export function placeWashLine(kit, o) {
  const y = o.y ?? 4.4;
  const clear = o.clear ?? 2.35;
  const n = o.count ?? 4;
  const dx = o.x1 - o.x0, dz = o.z1 - o.z0;
  const len = Math.hypot(dx, dz) || 1;
  const yaw = Math.atan2(-dz, dx) + Math.PI / 2;
  const r = rng(o.seed ?? 13);
  // A wire has to be attached to something. Where the run crosses a street it
  // is pinned to the two facades and needs nothing; anywhere else — across a
  // roof, across open ground — it gets a pole at each end, or it reads as a
  // line of laundry floating in mid-air.
  if (o.posts) {
    const { batch, proxy } = kit;
    const p = batch.at(o.postBucket || 'timber', o.x0, o.z0);
    for (const [px, pz] of [[o.x0, o.z0], [o.x1, o.z1]]) {
      const base = o.postBase ?? 0;
      p.at(px, (y + 0.1 + base) / 2, pz).box(0.11, y + 0.1 - base, 0.11, 0.02, 0);
      p.at(px, y + 0.06, pz).box(0.34, 0.08, 0.10, 0.015, 0);
      if (o.collide !== false) proxy.box(px, (y + base) / 2, pz, 0.2, y - base, 0.2);
    }
  }
  placeCable(kit, [o.x0, y, o.z0], [o.x1, y, o.z1], o.sag ?? 0.35, 0.016);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n + (r() - 0.5) * 0.08;
    const sag = Math.sin(Math.PI * t) * (o.sag ?? 0.35);
    const top = y - sag - 0.03;
    const h = Math.max(0.5, top - clear - r() * 0.35);
    placeHangingRug(kit, {
      x: o.x0 + dx * t, z: o.z0 + dz * t, yaw,
      width: (o.width ?? 1.5) * (0.8 + r() * 0.5),
      height: h, top, phase: i * 1.9 + (o.seed ?? 0),
      bucket: o.bucket,
    });
  }
}

/** Scatter of small debris chunks, merged straight into a ground bucket. */
export function placeDebris(kit, o) {
  const { batch } = kit;
  const g = batch.at(o.bucket || 'rubblebits', o.x, o.z);
  const r = rng(o.seed ?? 17);
  const n = o.count ?? 24;
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const rad = Math.sqrt(r()) * (o.radius ?? 3);
    const s = lerp(0.05, 0.2, r() * r());
    g.at(o.x + Math.cos(a) * rad, s * 0.35, o.z + Math.sin(a) * rad,
      r() * 3.14, r() * 0.6, r() * 0.6).box(s * 1.7, s * 0.7, s * 1.2, s * 0.2);
  }
}
