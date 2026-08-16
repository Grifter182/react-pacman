/** Throwaway diagnostic: why is the ground not drawing? */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 5200 + Math.floor(Math.random() * 3000);
const log = (...a) => console.log('[probe]', ...a);

const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
proc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('vite timeout')), 30000);
  proc.stdout.on('data', (d) => {
    if (/Local:|ready in/i.test(String(d))) { clearTimeout(t); setTimeout(res, 600); }
  });
});

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});
const p = await b.newPage({ viewport: { width: 480, height: 320 } });
p.on('pageerror', (e) => log('PAGEERROR', e.message));
p.on('console', (m) => { if (m.type() === 'error') log('CONSOLE', m.text()); });
await p.goto(`http://127.0.0.1:${PORT}?quality=high`, { waitUntil: 'load' });
await p.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
await p.waitForTimeout(1500);

const out = await p.evaluate(() => {
  const e = window.__engine;
  const level = e.get('level');
  const M = level.materials;

  const describe = (name) => {
    const m = M[name];
    if (!m) return { name, missing: true };
    const t = (tex) => tex ? {
      uuid: tex.uuid.slice(0, 8), img: !!tex.image,
      w: tex.image?.width, h: tex.image?.height,
      cs: tex.colorSpace, rep: tex.repeat?.toArray?.().map((n) => +n.toFixed(2)),
      disposed: tex.image === undefined,
    } : null;
    return {
      name, authored: m.userData?.authored ?? null, type: m.type,
      visible: m.visible, transparent: m.transparent, opacity: m.opacity,
      color: m.color?.getHexString?.(),
      rough: m.roughness, metal: m.metalness,
      map: t(m.map), normalMap: t(m.normalMap), ormMap: t(m.roughnessMap),
      hasOnBeforeCompile: !!m.onBeforeCompile,
      defines: m.defines ? Object.keys(m.defines) : null,
      version: m.version,
    };
  };

  // Which meshes actually carry the ground materials, and are they in frame?
  const groundMeshes = [];
  e.scene.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m && (m === M.sand || m === M.sandFar)) {
        groundMeshes.push({
          name: o.name || o.type,
          visible: o.visible,
          parentVisible: o.parent?.visible,
          tris: (o.geometry?.index?.count ?? o.geometry?.attributes?.position?.count ?? 0) / 3,
          hasUV: !!o.geometry?.attributes?.uv,
          hasUV1: !!o.geometry?.attributes?.uv1,
          hasNormal: !!o.geometry?.attributes?.normal,
          frustumCulled: o.frustumCulled,
        });
      }
    }
  });

  return {
    materials: ['sand', 'sandFar', 'gravel', 'metal'].map(describe),
    groundMeshCount: groundMeshes.length,
    groundMeshes: groundMeshes.slice(0, 6),
    usingProbe: e.get('sky')?.usingProbe,
    background: e.scene.background?.isTexture ? 'texture' : String(e.scene.background),
  };
});
log(JSON.stringify(out, null, 2));

await b.close();
proc.kill('SIGTERM');
process.exit(0);
