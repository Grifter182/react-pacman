/**
 * OWNER: level-art agent.  DEV TOOL — nothing imports this; it is not bundled.
 *
 *     node src/level/_triaudit.mjs
 *
 * Triangle-budget instrumentation for the level builder. It monkey-patches
 * every primitive emitter on `GeoBuilder`, builds the whole map headlessly (no
 * WebGL needed — the material bake produces DataTextures), and attributes every
 * triangle to the batcher bucket and the source line that asked for it. It then
 * prints four ranked tables: scene totals, per mesh, per bucket, per call site.
 *
 * This exists because rounds 1 and 2 both moved the budget by guessing. The
 * harness reports one aggregate number and an aggregate number cannot tell you
 * that 34k of it is sandbags, that 24k is window surrounds, or that the
 * cascade multiplier is charged on `receiveShadow` rather than `castShadow`.
 * Ranked per call site, it can, in two seconds and without touching the GPU.
 *
 * Read the per-mesh table alongside `LevelModule._budget`: the cost of a mesh
 * is its triangle count times five if it casts OR receives, times one if it
 * does neither.
 */
import * as THREE from 'three';
import { GeoBuilder, ProxySet } from './kit/Geo.js';

globalThis.__AUDIT = { site: new Map(), bucket: new Map(), depth: 0 };

function callsite() {
  const e = new Error();
  const lines = e.stack.split('\n').slice(2);
  const out = [];
  for (const l of lines) {
    const m = l.match(/at\s+(?:([\w$.<>]+)\s+)?\(?(?:file:\/\/)?([^\s()]+):(\d+):\d+/);
    if (!m) continue;
    const file = m[2];
    if (file.includes('/kit/Geo.js')) continue;
    if (file.includes('_triaudit')) continue;
    if (file.includes('node_modules')) continue;
    const short = file.replace(/^.*\/src\//, '');
    out.push(`${short}:${m[3]} ${m[1] || '?'}`);
    if (out.length >= 3) break;
  }
  return out[0] || 'unknown';
}

// Wrap the primitive emitters.
for (const name of ['box', 'quad', 'poly', 'cyl', 'tube', 'ramp', 'absorb', 'tri']) {
  const orig = GeoBuilder.prototype[name];
  GeoBuilder.prototype[name] = function (...args) {
    if (globalThis.__AUDIT.depth > 0) return orig.apply(this, args);
    globalThis.__AUDIT.depth++;
    const before = this.pos.length;
    let r;
    try { r = orig.apply(this, args); } finally { globalThis.__AUDIT.depth--; }
    const tris = (this.pos.length - before) / 9;
    if (tris > 0) {
      const site = (this._key || '?') + ' | ' + callsite() + `  [${name}]`;
      const A = globalThis.__AUDIT;
      const s = A.site.get(site) || { tris: 0, calls: 0 };
      s.tris += tris; s.calls++; A.site.set(site, s);
      const key = this._key || '(proxy/proto)';
      const bk = A.bucket.get(key) || { tris: 0 };
      bk.tris += tris; A.bucket.set(key, bk);
    }
    return r;
  };
}

// Minimal DOM/GL shims are not needed; materials bake to DataTextures.
const { LevelModule } = await import('./LevelModule.js');

const scene = new THREE.Scene();
const engine = {
  scene, bus: { emit() {}, on() {}, off() {} },
  camera: new THREE.PerspectiveCamera(),
  get(n) { return n === 'collision' ? { build() {} } : null; },
};
const lm = new LevelModule();
await lm.init(engine);

// Count what actually landed in the scene.
let sceneTris = 0, drawables = 0;
const perMesh = [];
scene.traverse((o) => {
  if (!o.isMesh) return;
  const g = o.geometry;
  const c = g.index ? g.index.count : g.getAttribute('position').count;
  const t = (c / 3) * (o.isInstancedMesh ? o.count : 1);
  if (o.material && o.material.visible === false) return;
  sceneTris += t;
  drawables++;
  perMesh.push([o.name, t, o.isInstancedMesh ? o.count : 1, o.castShadow]);
});

const A = globalThis.__AUDIT;
const fmt = (n) => n.toLocaleString('en-US');

console.log('\n===== SCENE TOTALS =====');
console.log('meshes(drawables):', drawables, ' triangles:', fmt(sceneTris));
console.log('level.stats:', JSON.stringify(lm.stats));

console.log('\n===== PER MESH (top 40) =====');
perMesh.sort((a, b) => b[1] - a[1]);
for (const [n, t, c, cs] of perMesh.slice(0, 40)) {
  console.log(String(fmt(t)).padStart(9), (c > 1 ? `x${c} ` : '   ') + (cs ? 'S ' : '  '), n);
}
console.log('  ...', perMesh.length, 'meshes total; tail sum',
  fmt(perMesh.slice(40).reduce((s, r) => s + r[1], 0)));

console.log('\n===== PER BUCKET =====');
const bk = [...A.bucket].sort((a, b) => b[1].tris - a[1].tris);
let tot = 0;
for (const [k, v] of bk) { tot += v.tris; console.log(String(fmt(v.tris)).padStart(10), k); }
console.log(String(fmt(tot)).padStart(10), 'TOTAL emitted');

console.log('\n===== PER CALL SITE (top 45) =====');
const st = [...A.site].sort((a, b) => b[1].tris - a[1].tris);
for (const [k, v] of st.slice(0, 45)) {
  console.log(String(fmt(v.tris)).padStart(10), String(v.calls).padStart(7), 'calls ',
    (v.tris / v.calls).toFixed(0).padStart(6), '/call  ', k);
}
console.log('  ...', st.length, 'sites; tail sum', fmt(st.slice(45).reduce((s, r) => s + r[1].tris, 0)));

