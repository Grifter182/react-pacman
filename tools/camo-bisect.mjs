/**
 * WHAT IS PAINTING THE VIEWMODEL WITH BLOCKS?
 *
 * The buttpad, the gloves and the sleeve render as roughly 8 px screen-aligned
 * tan squares — the "digital camouflage" every previous pass has chased. Two
 * things are already known and neither of them is the usual suspect:
 *
 *   - the bakes are clean and complete (tools/texdump.mjs): albedo, ARM and
 *     normal are all 2-4 texel pebble fields at full allocation, ready = true;
 *   - the world, which uses the same factory and the same shader, is not
 *     blocky anywhere in the same frame — so it is not the bake ladder, and it
 *     is not the post stack, which the viewmodel is drawn after anyway.
 *
 * So the cause is something the viewmodel does differently. This boots once,
 * freezes a hip pose, and photographs the same crop with one contributor
 * removed at a time. Map swaps recompile a program and need `needsUpdate`;
 * uniform changes must not set it, or every variant pays a SwiftShader compile.
 *
 *   PW_CHROMIUM=/opt/pw-browsers/chromium node tools/camo-bisect.mjs --out shots/camo
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = path.resolve(arg('out', 'shots/camo'));
const PORT = parseInt(arg('port', String(5200 + Math.floor(Math.random() * 3000))), 10);
const VARIANTS = arg('variants', 'base,unlit,no-albedo,no-normal,no-armmap,repeat4').split(',');
const W = 1600, H = 900;

const T0 = Date.now();
const say = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

await mkdir(OUT, { recursive: true });
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('vite timeout')), 30000);
  proc.stdout.on('data', (d) => { if (/Local:|ready in/i.test(String(d))) { clearTimeout(t); setTimeout(res, 400); } });
});

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

const setup = await page.evaluate(async () => {
  const g = window.__game; g.setCaptureMode(true); g.flushMaterialBakes(); await g.materialsReady();
  const e = window.__engine;
  const p = e.get('player'), w = e.get('weapons');
  for (let i = 0; i < 8; i++) {
    p.state.position.set(0, 1.0, 20); p.state.velocity.set(0, 0, 0);
    p.state.yaw = Math.PI; p.state.pitch = 0; p.state.ads = false; p.state.sprinting = false;
    w.reloading = false; w._switching = false; w.firing = false;
    await new Promise((r) => requestAnimationFrame(r));
  }

  // Every (mesh, slot) binding in the viewmodel, with its original material.
  const binds = [];
  let Basic = null;
  e.viewmodelScene.traverseVisible((o) => {
    if (!o.isMesh) return;
    const arr = Array.isArray(o.material) ? o.material : null;
    const list = arr || [o.material];
    list.forEach((m, i) => {
      if (m.isMeshBasicMaterial && !Basic) Basic = m.constructor;
      binds.push({ o, i, arr, m, save: {
        map: m.map, normalMap: m.normalMap, aoMap: m.aoMap,
        roughnessMap: m.roughnessMap, metalnessMap: m.metalnessMap,
        repeat: m.map ? m.map.repeat.x : null,
      } });
    });
  });
  window.__binds = binds;
  // A flat unlit stand-in, from the app's own three build (borrowed off the
  // reticle emitter, which is the one MeshBasicMaterial in the viewmodel).
  window.__flat = Basic ? new Basic() : null;
  if (window.__flat) window.__flat.color.setRGB(0.45, 0.45, 0.45);

  window.__variant = (which) => {
    for (const b of window.__binds) {
      const { o, i, arr, m, save } = b;
      if (arr) arr[i] = m; else o.material = m;
      let recompile = false;
      const set = (k, v) => { if (m[k] !== v) { m[k] = v; recompile = true; } };
      set('map', save.map); set('normalMap', save.normalMap); set('aoMap', save.aoMap);
      set('roughnessMap', save.roughnessMap); set('metalnessMap', save.metalnessMap);
      if (save.repeat != null && m.map) m.map.repeat.set(save.repeat, save.repeat);

      if (which === 'no-albedo') set('map', null);
      if (which === 'no-normal') set('normalMap', null);
      if (which === 'no-armmap') { set('aoMap', null); set('roughnessMap', null); set('metalnessMap', null); }
      if (which === 'repeat4' && m.map) m.map.repeat.set(save.repeat * 4, save.repeat * 4);
      if (which === 'unlit' && window.__flat) { if (arr) arr[i] = window.__flat; else o.material = window.__flat; }

      // The detail layer, in full. Zeroing only sfDetail.y (the normal gain)
      // leaves the albedo and roughness modulation running, which is how an
      // earlier pass "ruled out" detail while it was still painting the
      // surface. All three terms have to go together.
      const u = m.userData && m.userData.surfaceUniforms;
      if (u) {
        if (!b.uSave) {
          b.uSave = {
            detail: u.sfDetail ? u.sfDetail.value.clone() : null,
            alb: u.sfDetailAlb ? u.sfDetailAlb.value : null,
            macro: u.sfMacro ? u.sfMacro.value.clone() : null,
            macroLo: u.sfMacroLo ? u.sfMacroLo.value.clone() : null,
          };
        }
        if (u.sfDetail && b.uSave.detail) u.sfDetail.value.copy(b.uSave.detail);
        if (u.sfDetailAlb && b.uSave.alb != null) u.sfDetailAlb.value = b.uSave.alb;
        if (u.sfMacro && b.uSave.macro) u.sfMacro.value.copy(b.uSave.macro);
        if (u.sfMacroLo && b.uSave.macroLo) u.sfMacroLo.value.copy(b.uSave.macroLo);

        if (which === 'no-detail') {
          if (u.sfDetail) { u.sfDetail.value.y = 0; u.sfDetail.value.z = 0; }
          if (u.sfDetailAlb) u.sfDetailAlb.value = 0;
        }
        if (which === 'no-macro') {
          if (u.sfMacro) u.sfMacro.value.set(u.sfMacro.value.x, 0, 0, u.sfMacro.value.w);
          if (u.sfMacroLo) u.sfMacroLo.value.set(0, 0);
        }
        if (which === 'detail-only-normal' && u.sfDetailAlb) u.sfDetailAlb.value = 0;
      }
      if (recompile) m.needsUpdate = true;
    }
  };
  return { binds: binds.length, haveFlat: !!window.__flat };
});
say(`pose frozen, ${setup.binds} bindings, flat=${setup.haveFlat}`);

for (const v of VARIANTS) {
  await page.evaluate(async (which) => {
    window.__variant(which);
    const e = window.__engine;
    const p = e.get('player'), w = e.get('weapons');
    // Re-pin every frame: without this the player state drifts between
    // variants and the shots stop being the same frame.
    for (let i = 0; i < 4; i++) {
      p.state.position.set(0, 1.0, 20); p.state.velocity.set(0, 0, 0);
      p.state.yaw = Math.PI; p.state.pitch = 0; p.state.ads = false; p.state.sprinting = false;
      w.reloading = false; w._switching = false; w.firing = false;
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, v);
  await page.screenshot({ path: path.join(OUT, `${v}.png`), type: 'png', timeout: 180000,
    clip: { x: 950, y: 560, width: 400, height: 300 } });
  say(`shot ${v}`);
}

await browser.close();
proc.kill('SIGTERM');
say('done');
