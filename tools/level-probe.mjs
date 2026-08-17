/**
 * LEVEL LEGIBILITY PROBE.
 *
 * Three player complaints, all of them answerable from the navmesh rather than
 * from opinion:
 *
 *   "narrow corridors between buildings that feel like a flaw"
 *       -> for every walkable ground cell, how wide is the free space around it?
 *          A designed alley is wide and long; a construction seam between two
 *          building shells is a metre-wide dead end, and the difference is
 *          measurable.
 *   "I hardly see enemies, are they above me?"
 *       -> how much walkable surface is ELEVATED, and do the bots stand on it?
 *   "is there a way into buildings or on top of them, I don't see"
 *       -> is that elevated surface CONNECTED to the ground on foot? The navmesh
 *          labels connected components, so reachability is a lookup, not a guess.
 *
 * The navmesh is a multi-level voxel span graph: each column can carry several
 * walkable surfaces (street, first floor, roof), `nodeFlags & 1` marks nodes
 * eroded away as too close to a wall for the agent, and `nodeRegion` /
 * `mainRegion` give the connected components. That is exactly the structure
 * needed here, so this probe reads it directly.
 *
 * The viewport is deliberately tiny. This box renders at ~1.5 fps at 1280x720
 * under SwiftShader, which makes any measurement of bot BEHAVIOUR over time
 * useless; at 320x200 the simulation actually advances. The static geometry
 * answers do not depend on frame rate at all.
 *
 *   PW_CHROMIUM=/opt/pw-browsers/chromium node tools/level-probe.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const PORT = 5200 + Math.floor(Math.random() * 3000);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('vite did not start')), 30000);
  proc.stdout.on('data', (d) => {
    if (/Local:|ready in/i.test(String(d))) { clearTimeout(t); setTimeout(res, 600); }
  });
});

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}?quality=low&nofrontend=1`, { waitUntil: 'load' });
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 300000 });
await page.waitForTimeout(2000);

/* ---------------------------------------------------- static: the navmesh */
const geom = await page.evaluate(() => {
  const e = window.__engine;
  const nav = e.get('ai')?.nav || e.get('nav')?.nav || e.get('nav');
  if (!nav?.ready) return { error: 'no navmesh (looked at ai.nav and nav)' };

  const { gw, gd, cell, minX, minZ, nodeCount, cellFirst, cellCount, nodeY, nodeFlags,
    nodeRegion, mainRegion } = nav;
  const walkable = (n) => (nodeFlags[n] & 1) === 0;

  /* --- per-column surfaces: ground vs elevated --------------------------- */
  // The lowest surface in a column is the street or a floor slab; anything
  // more than a step above it is a distinct storey or a roof.
  const STOREY = 1.6;
  const groundNode = new Int32Array(gw * gd).fill(-1);
  let elevated = 0, elevatedReachable = 0, groundCells = 0;
  const elevBands = {};       // rounded height -> node count
  const elevReachBands = {};
  for (let c = 0; c < gw * gd; c++) {
    const first = cellFirst[c], n = cellCount[c];
    if (first < 0 || n === 0) continue;
    let lo = Infinity, loNode = -1;
    for (let k = 0; k < n; k++) {
      const nd = first + k;
      if (nodeY[nd] < lo) { lo = nodeY[nd]; loNode = nd; }
    }
    groundNode[c] = loNode;
    if (walkable(loNode)) groundCells++;
    for (let k = 0; k < n; k++) {
      const nd = first + k;
      if (nd === loNode || !walkable(nd)) continue;
      if (nodeY[nd] - lo < STOREY) continue;
      elevated++;
      const band = Math.round(nodeY[nd]);
      elevBands[band] = (elevBands[band] || 0) + 1;
      // Reachable on foot means: same connected component as the bulk of the
      // level. A roof in its own region is scenery the player can never stand on.
      if (nodeRegion[nd] === mainRegion) {
        elevatedReachable++;
        elevReachBands[band] = (elevReachBands[band] || 0) + 1;
      }
    }
  }

  /* --- corridor width at ground level ------------------------------------ */
  // March along +/-X and +/-Z from each open cell until blocked. The narrower
  // of the two spans is the corridor width the player's shoulders feel.
  const open = (c) => groundNode[c] >= 0 && walkable(groundNode[c]);
  const widthHist = {};
  const narrow = [];          // cells at or under NARROW metres
  const NARROW = 1.5;
  let measured = 0, narrowCells = 0;
  for (let z = 0; z < gd; z++) {
    for (let x = 0; x < gw; x++) {
      const c = z * gw + x;
      if (!open(c)) continue;
      let spanX = 1, spanZ = 1;
      for (let i = x - 1; i >= 0 && open(z * gw + i); i--) spanX++;
      for (let i = x + 1; i < gw && open(z * gw + i); i++) spanX++;
      for (let i = z - 1; i >= 0 && open(i * gw + x); i--) spanZ++;
      for (let i = z + 1; i < gd && open(i * gw + x); i++) spanZ++;
      const w = Math.min(spanX, spanZ) * cell;
      measured++;
      const b = (Math.round(w * 2) / 2).toFixed(1);
      widthHist[b] = (widthHist[b] || 0) + 1;
      if (w <= NARROW) {
        narrowCells++;
        narrow.push({ x: +(minX + x * cell).toFixed(1), z: +(minZ + z * cell).toFixed(1), w: +w.toFixed(2) });
      }
    }
  }

  // Cluster the narrow cells so the report names PLACES, not four hundred cells.
  const clusters = [];
  const claimed = new Set();
  const key = (p) => `${p.x},${p.z}`;
  for (const p of narrow) {
    if (claimed.has(key(p))) continue;
    const stack = [p]; const members = [];
    claimed.add(key(p));
    while (stack.length) {
      const q = stack.pop(); members.push(q);
      for (const r of narrow) {
        if (claimed.has(key(r))) continue;
        if (Math.abs(r.x - q.x) <= cell * 1.5 && Math.abs(r.z - q.z) <= cell * 1.5) {
          claimed.add(key(r)); stack.push(r);
        }
      }
    }
    if (members.length < 3) continue;
    const xs = members.map((m) => m.x), zs = members.map((m) => m.z);
    clusters.push({
      cells: members.length,
      areaM2: +(members.length * cell * cell).toFixed(1),
      minWidthM: +Math.min(...members.map((m) => m.w)).toFixed(2),
      xRange: [Math.min(...xs), Math.max(...xs)],
      zRange: [Math.min(...zs), Math.max(...zs)],
      lengthM: +Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)).toFixed(1),
    });
  }
  clusters.sort((a, b) => b.cells - a.cells);

  const m2 = cell * cell;
  return {
    cell, gw, gd, nodeCount,
    regionCount: nav.regionCount, mainRegion,
    groundAreaM2: +(groundCells * m2).toFixed(0),
    elevatedAreaM2: +(elevated * m2).toFixed(0),
    elevatedReachableM2: +(elevatedReachable * m2).toFixed(0),
    elevatedPctOfGround: +((elevated / Math.max(1, groundCells)) * 100).toFixed(1),
    reachablePctOfElevated: +((elevatedReachable / Math.max(1, elevated)) * 100).toFixed(1),
    elevatedByHeightM: elevBands,
    elevatedReachableByHeightM: elevReachBands,
    corridorWidthHistM: widthHist,
    narrowAreaM2: +(narrowCells * m2).toFixed(0),
    narrowPctOfGround: +((narrowCells / Math.max(1, measured)) * 100).toFixed(1),
    narrowClusters: clusters.slice(0, 14),
    narrowClusterCount: clusters.length,
  };
});

console.log('=== NAVMESH ===');
console.log(JSON.stringify(geom, null, 2));

/* ------------------------------------------- dynamic: where do bots stand? */
if (!geom.error) {
  const bots = await page.evaluate(async () => {
    const e = window.__engine;
    const ai = e.get('ai');
    const nav = ai?.nav;
    if (!ai?.actors?.length) return { error: 'no actors' };
    const samples = [];
    const f0 = e.frame;
    const t0 = performance.now();
    // 40 s of wall clock. At this viewport the loop actually advances; the frame
    // count is reported so a null result can be told from a slow one.
    while (performance.now() - t0 < 40000) {
      await new Promise((r) => setTimeout(r, 500));
      for (const a of ai.actors) {
        if (!a.alive) continue;
        const y = a.position?.y ?? a.mesh?.position?.y;
        if (y == null) continue;
        const ground = nav?.sampleHeight ? nav.sampleHeight(a.position) : null;
        samples.push({ y: +y.toFixed(2), above: ground == null ? null : +(y - ground).toFixed(2) });
      }
    }
    const ys = samples.map((s) => s.y);
    const band = {};
    for (const y of ys) { const b = Math.round(y); band[b] = (band[b] || 0) + 1; }
    const elevatedSamples = samples.filter((s) => s.y > 2.2).length;
    return {
      frames: e.frame - f0,
      simSeconds: +(e.elapsed).toFixed(1),
      actors: ai.actors.length,
      samples: samples.length,
      yByBand: band,
      minY: ys.length ? +Math.min(...ys).toFixed(2) : null,
      maxY: ys.length ? +Math.max(...ys).toFixed(2) : null,
      pctAbove2m2: samples.length ? +((elevatedSamples / samples.length) * 100).toFixed(1) : null,
    };
  });
  console.log('\n=== BOTS ===');
  console.log(JSON.stringify(bots, null, 2));
  await writeFile('shots/level-probe.json', JSON.stringify({ geom, bots }, null, 2));

  console.log('\n=== ANSWERS ===');
  console.log(`walkable elevated surface: ${geom.elevatedAreaM2} m2 (${geom.elevatedPctOfGround}% of the street area)`);
  console.log(`  of which reachable on foot: ${geom.elevatedReachableM2} m2 (${geom.reachablePctOfElevated}%)`);
  console.log(`narrow (<=1.5 m) walkable area: ${geom.narrowAreaM2} m2, ${geom.narrowPctOfGround}% of the ground, in ${geom.narrowClusterCount} clusters`);
  console.log(`bots standing above 2.2 m: ${bots.pctAbove2m2}% of ${bots.samples} samples over ${bots.frames} frames`);
}

await browser.close();
proc.kill();
process.exit(0);
