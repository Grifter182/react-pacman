/**
 * OWNER: weapons agent.
 *
 *     node src/weapons/uv-audit.mjs [rifle|smg|dmr|all]
 *
 * Per-part UV report for the merged weapon body. Runs in plain node with no
 * browser and no GL, because everything it measures is in the buffers.
 *
 * WHY THIS EXISTS
 * "The receiver looks like digital camouflage" was blamed on the UVs for two
 * rounds — wrapping seams, sub-pixel texel density, degenerate triangles. Those
 * are all real failure modes and all of them are cheap to rule out, but only if
 * the merged buffer remembers which part each triangle came from. `Kit` stamps
 * that provenance into `geometry.userData.parts`; this reads it back.
 *
 * WHAT EACH COLUMN MEANS
 *   u/v range   UV bounds for the part. A span above ~1 on a part that is
 *               supposed to be one tile means the projection is stretching it.
 *   texels/mm   Texel density on the surface, at the material's full bake size
 *               and including its `repeat`. This is the number that decides
 *               whether a part looks soft next to its neighbour: a 2x step
 *               between adjacent parts is visible, a 10x step is a defect.
 *   zeroUV%     Fraction of triangles with real area in space but effectively
 *               none in UV. These sample a single texel and read as flat
 *               colour, which is the classic "untextured facet".
 *   maxEdge     Longest UV edge on the part, in tiles. A value near or above 1
 *               with RepeatWrapping means a single triangle smears the whole
 *               texture across itself.
 *
 * The verdict line at the end is the one to read: it fails loudly if any of the
 * three defects is present, so this can be run as a check rather than studied.
 */
import { WEAPONS } from './WeaponDefs.js';
import { buildWeapon, weaponMaterials } from './Gunsmith.js';

const which = process.argv[2] || 'rifle';
const ids = which === 'all' ? Object.keys(WEAPONS) : [which];

const mats = weaponMaterials();
const slotInfo = (slot) => {
  const m = mats[slot];
  return {
    // `map.image.width` is the ALLOCATED size — what the bake ladder converges
    // to. `userData.surface.resolution` is whatever rung it has reached so far,
    // which outside a browser is always the 32px preview and is not the number
    // this report is about.
    size: m?.map?.image?.width ?? 0,
    repeat: m?.map?.repeat?.x ?? 1,
    name: m?.userData?.preset ?? `slot${slot}`,
  };
};

let worst = { zero: 0, edge: 0, ratio: 1 };

for (const id of ids) {
  const build = buildWeapon(WEAPONS[id], mats);
  const geo = build.body.geometry;
  const pos = geo.attributes.position.array;
  const uv = geo.attributes.uv.array;
  const parts = geo.userData.parts || [];

  // Parts are per-`kit.add` call, which is far too fine to read. Fold them into
  // the labelled assemblies the gunsmith actually builds.
  const groups = new Map();
  for (const p of parts) {
    const key = `${p.label}/${p.slot}/${p.uv}`;
    let g = groups.get(key);
    if (!g) {
      g = { label: p.label, slot: p.slot, mode: p.uv, ranges: [], n: 0 };
      groups.set(key, g);
    }
    g.ranges.push(p);
    g.n += p.count;
  }

  console.log(`\n=== ${id} — ${(pos.length / 9) | 0} triangles, ${parts.length} parts `
    + `in ${groups.size} assemblies ===`);
  console.log('assembly          slot mode        u span  v span  texels/mm  zeroUV%  maxEdge  tris');

  const rows = [];
  for (const g of groups.values()) {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    let area3 = 0, area2 = 0, zero = 0, maxEdge = 0, tris = 0;
    for (const r of g.ranges) {
      for (let i = r.start; i < r.start + r.count; i++) {
        const u = uv[i * 2], v = uv[i * 2 + 1];
        if (u < u0) u0 = u; if (u > u1) u1 = u;
        if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      for (let t = r.start / 3; t < (r.start + r.count) / 3; t++) {
        const a = t * 3, b = a + 1, c = a + 2;
        const e1 = [pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]];
        const e2 = [pos[c * 3] - pos[a * 3], pos[c * 3 + 1] - pos[a * 3 + 1], pos[c * 3 + 2] - pos[a * 3 + 2]];
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const A3 = 0.5 * Math.hypot(cr[0], cr[1], cr[2]);
        const f1 = [uv[b * 2] - uv[a * 2], uv[b * 2 + 1] - uv[a * 2 + 1]];
        const f2 = [uv[c * 2] - uv[a * 2], uv[c * 2 + 1] - uv[a * 2 + 1]];
        const A2 = 0.5 * Math.abs(f1[0] * f2[1] - f1[1] * f2[0]);
        area3 += A3; area2 += A2; tris++;
        if (A3 > 1e-10 && A2 / A3 < 1e-3) zero++;
        maxEdge = Math.max(maxEdge, Math.hypot(f1[0], f1[1]), Math.hypot(f2[0], f2[1]));
      }
    }
    const S = slotInfo(g.slot);
    const density = area3 > 0 ? Math.sqrt(area2 / area3) * S.size * S.repeat / 1000 : 0;
    rows.push({
      label: g.label, slot: g.slot, mode: g.mode,
      spanU: u1 - u0, spanV: v1 - v0, density,
      zero: tris ? (100 * zero) / tris : 0, maxEdge, tris,
    });
  }

  rows.sort((a, b) => a.density - b.density);
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(17)} ${String(r.slot).padEnd(4)} ${r.mode.padEnd(11)}`
      + ` ${r.spanU.toFixed(2).padStart(6)}  ${r.spanV.toFixed(2).padStart(6)}`
      + ` ${r.density.toFixed(2).padStart(10)}`
      + ` ${r.zero.toFixed(1).padStart(8)}`
      + ` ${r.maxEdge.toFixed(2).padStart(8)}`
      + ` ${String(r.tris).padStart(6)}`);
    worst.zero = Math.max(worst.zero, r.zero);
    worst.edge = Math.max(worst.edge, r.maxEdge);
  }

  const d = rows.map((r) => r.density).filter((x) => x > 0).sort((a, b) => a - b);
  const ratio = d[d.length - 1] / d[0];
  worst.ratio = Math.max(worst.ratio, ratio);
  console.log(`density  min ${d[0].toFixed(2)}  median ${d[d.length >> 1].toFixed(2)}`
    + `  max ${d[d.length - 1].toFixed(2)}  spread ${ratio.toFixed(1)}x`);
  for (let s = 0; s < 7; s++) {
    if (!rows.some((r) => r.slot === s)) continue;
    const S = slotInfo(s);
    console.log(`  slot ${s}  ${S.name.padEnd(9)} ${S.size}px  repeat ${S.repeat.toFixed(2)}`);
  }
}

const fail = [];
if (worst.zero > 1) fail.push(`degenerate UV triangles: ${worst.zero.toFixed(1)}% on one assembly`);
if (worst.edge > 1.0) fail.push(`UV edge spans ${worst.edge.toFixed(2)} tiles — texture will smear`);
if (worst.ratio > 6) fail.push(`texel density spread ${worst.ratio.toFixed(1)}x across assemblies`);
console.log(fail.length ? `\nFAIL\n  - ${fail.join('\n  - ')}` : '\nPASS — no seam, density or degeneracy defect in the weapon UVs.');
process.exit(fail.length ? 1 : 0);
