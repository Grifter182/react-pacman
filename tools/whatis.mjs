/**
 * WHAT IS THAT PIXEL? — names the viewmodel surface under a screen coordinate.
 *
 * A visual review can say "the pale blocky thing next to the magazine looks
 * like printed camouflage" but cannot say WHICH part or WHICH material that is,
 * and guessing from a screenshot is how the last three passes fixed the wrong
 * surface. This casts a ray from the viewmodel camera through the given pixel
 * and reports the mesh, the authored part label, the material slot and the
 * recipe id, plus the rendered colour of that pixel.
 *
 *   PW_CHROMIUM=/opt/pw-browsers/chromium node tools/whatis.mjs \
 *     --pose ads --points 1100,720 750,680 800,555
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const list = (n) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
};

const PORT = parseInt(arg('port', String(5200 + Math.floor(Math.random() * 3000))), 10);
const POSE = arg('pose', 'ads');
const W = 1600, H = 900;
const POINTS = (list('points').length ? list('points') : ['800,450']).map((s) => s.split(',').map(Number));

const T0 = Date.now();
const say = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('vite timeout')), 30000);
  proc.stdout.on('data', (d) => { if (/Local:|ready in/i.test(String(d))) { clearTimeout(t); setTimeout(res, 400); } });
});
say('vite up');

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage', '--no-sandbox', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?quality=high`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => document.body.dataset.ready === '1' || document.querySelector('pre'),
  null, { timeout: 900000 });
say('booted');

await page.evaluate(async (pose) => {
  const g = window.__game; g.setCaptureMode(true); g.flushMaterialBakes(); await g.materialsReady();
  const e = window.__engine;
  const p = e.get('player'), w = e.get('weapons');
  const shot = pose === 'ads'
    ? { pos: [0, 1.0, 18], yaw: Math.PI, pitch: -0.02, ads: true }
    : { pos: [0, 1.0, 20], yaw: Math.PI, pitch: 0.0, ads: false };
  for (let i = 0; i < 90; i++) {
    p.state.position.set(...shot.pos);
    p.state.velocity.set(0, 0, 0);
    p.state.yaw = shot.yaw; p.state.pitch = shot.pitch;
    p.state.ads = shot.ads; p.state.sprinting = false;
    w.reloading = false; w._switching = false; w.firing = false;
    await new Promise((r) => requestAnimationFrame(r));
  }
}, POSE);
say('pose settled');

const report = await page.evaluate(({ pts, w, h }) => {
  const e = window.__engine;
  const cam = e.viewmodelCamera;
  const V3 = e.camera.position.constructor;
  const RC = e.get('collision')._raycaster.constructor;
  cam.updateMatrixWorld(true);
  const meshes = [];
  e.viewmodelScene.traverseVisible((o) => { if (o.isMesh) meshes.push(o); });

  const rc = new RC();
  rc.firstHitOnly = false;
  rc.near = 0; rc.far = 6;
  const origin = new V3().setFromMatrixPosition(cam.matrixWorld);

  return pts.map(([px, py]) => {
    const ndc = new V3((px / w) * 2 - 1, -(py / h) * 2 + 1, 0.5).unproject(cam);
    rc.set(origin, ndc.sub(origin).normalize());
    const hits = rc.intersectObjects(meshes, false);
    const rows = hits.slice(0, 3).map((hit) => {
      const g = hit.object.geometry;
      const parts = g.userData && g.userData.parts;
      const vi = hit.face ? hit.face.a : -1;
      let part = null;
      if (parts) for (const q of parts) if (vi >= q.start && vi < q.start + q.count) { part = q; break; }
      const m = hit.object.material;
      const mat = Array.isArray(m) ? m[hit.face ? hit.face.materialIndex : 0] : m;
      return {
        d: +hit.distance.toFixed(4),
        mesh: hit.object.name || '(unnamed)',
        parent: hit.object.parent?.name || '-',
        part: part ? part.label : null,
        slot: part ? part.slot : (hit.face ? hit.face.materialIndex : null),
        recipe: (mat && (mat.name || mat.userData?.preset)) || '(unnamed)',
        color: mat?.color ? mat.color.toArray().map((v) => +v.toFixed(3)) : null,
        rough: mat?.roughness ?? null, metal: mat?.metalness ?? null,
        aoI: mat?.aoMapIntensity ?? null,
        mapSize: mat?.map?.image ? `${mat.map.image.width}x${mat.map.image.height}` : null,
        repeat: mat?.map?.repeat ? mat.map.repeat.toArray().map((v) => +v.toFixed(2)) : null,
      };
    });
    return { px, py, rows };
  });
}, { pts: POINTS, w: W, h: H });

for (const r of report) {
  console.log(`\n(${r.px}, ${r.py})`);
  if (!r.rows.length) console.log('   nothing in the viewmodel — this is the world behind it');
  for (const s of r.rows) {
    console.log(`   ${s.d.toFixed(4)}m  ${s.mesh}/${s.part ?? '-'}  slot=${s.slot}  recipe=${s.recipe}`
      + `  map=${s.mapSize} repeat=${s.repeat}  rough=${s.rough} metal=${s.metal} aoI=${s.aoI}`
      + `  color=${s.color}`);
  }
}

await browser.close();
proc.kill('SIGTERM');
say('done');
