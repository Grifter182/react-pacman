/**
 * TEXTURE STATE DUMP — what resolution did each viewmodel surface actually
 * reach, and what does its albedo look like?
 *
 * `bakePass` splats an MxM intermediate into the NxN buffer with nearest-
 * neighbour replication, so a surface stuck on an early rung of the refine
 * ladder renders as axis-aligned squares — a literal digital camouflage. This
 * reports `surface.resolution` / `surface.ready` per slot after the capture
 * flush, and writes the albedo of each out as a PNG so the pattern can be
 * looked at rather than argued about.
 *
 *   PW_CHROMIUM=/opt/pw-browsers/chromium node tools/texdump.mjs --out shots/tex
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = path.resolve(arg('out', 'shots/tex'));
const PORT = parseInt(arg('port', String(5200 + Math.floor(Math.random() * 3000))), 10);
const FLUSH = arg('flush', '1') === '1';

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
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?quality=high`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => document.body.dataset.ready === '1' || document.querySelector('pre'),
  null, { timeout: 900000 });
say('booted');

if (FLUSH) {
  const ms = await page.evaluate(async () => {
    const t = performance.now();
    window.__game.flushMaterialBakes();
    await window.__game.materialsReady();
    return Math.round(performance.now() - t);
  });
  say(`flushed in ${ms}ms`);
}

const dump = await page.evaluate(() => {
  const e = window.__engine;
  const w = e.get('weapons');
  const rows = [];
  const pngs = [];
  const seen = new Set();

  const record = (label, mat) => {
    if (!mat || seen.has(mat.uuid)) return;
    seen.add(mat.uuid);
    const s = mat.userData && mat.userData.surface;
    const img = mat.map && mat.map.image;
    rows.push({
      label,
      recipe: mat.name || (mat.userData && mat.userData.preset) || '(none)',
      alloc: img ? `${img.width}x${img.height}` : null,
      resolution: s ? s.resolution : null,
      ready: s ? s.ready : null,
      repeat: mat.map ? +mat.map.repeat.x.toFixed(2) : null,
      aoMapIntensity: mat.aoMapIntensity,
      roughness: mat.roughness, metalness: mat.metalness,
    });
    // Albedo alone cannot explain a pale blocky patch: AO multiplies indirect
    // diffuse and metalness turns a texel into a mirror of the sky, so the ARM
    // map is at least as likely a culprit. Dump all three.
    for (const [suffix, tex] of [['albedo', mat.map], ['arm', mat.aoMap], ['normal', mat.normalMap]]) {
      const im = tex && tex.image;
      if (!im || !im.data) continue;
      const c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      c.getContext('2d').putImageData(
        new ImageData(new Uint8ClampedArray(im.data), im.width, im.height), 0, 0);
      pngs.push({ label: `${label}-${suffix}`, data: c.toDataURL('image/png') });
    }
    // Channel statistics on the ARM map, because "is any of this a conductor?"
    // is a number, not a look.
    const arm = mat.aoMap && mat.aoMap.image;
    if (arm && arm.data) {
      const d = arm.data;
      let aoMin = 255, aoMax = 0, mMax = 0, mSum = 0, rMin = 255, rMax = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < aoMin) aoMin = d[i];
        if (d[i] > aoMax) aoMax = d[i];
        if (d[i + 1] < rMin) rMin = d[i + 1];
        if (d[i + 1] > rMax) rMax = d[i + 1];
        if (d[i + 2] > mMax) mMax = d[i + 2];
        mSum += d[i + 2];
      }
      const px = d.length / 4;
      rows[rows.length - 1].arm = {
        ao: [aoMin, aoMax], rough: [rMin, rMax], metalMax: mMax,
        metalMean: +(mSum / px).toFixed(1),
      };
    }
  };

  // Every material actually bound to a viewmodel mesh, walked from the scene so
  // nothing is missed and nothing unused is reported.
  e.viewmodelScene.traverseVisible((o) => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    ms.forEach((m, i) => record(`${o.name || '(unnamed)'}[${i}]`, m));
  });
  return { rows, pngs, weapon: w.current };
});

for (const r of dump.rows) {
  console.log(`${r.label.padEnd(22)} ${String(r.recipe).padEnd(20)} alloc=${r.alloc}`
    + ` baked=${r.resolution} ready=${r.ready} repeat=${r.repeat}`
    + ` aoI=${r.aoMapIntensity} rough=${r.roughness} metal=${r.metalness}`
    + (r.arm ? `  ARM ao=${r.arm.ao} rough=${r.arm.rough} metalMax=${r.arm.metalMax} metalMean=${r.arm.metalMean}` : ''));
}
for (const p of dump.pngs) {
  const file = path.join(OUT, `${p.label.replace(/[^\w.-]/g, '_')}.png`);
  await writeFile(file, Buffer.from(p.data.split(',')[1], 'base64'));
}
await writeFile(path.join(OUT, 'texstate.json'), JSON.stringify(dump.rows, null, 2));
say(`wrote ${dump.pngs.length} albedo maps to ${OUT}`);

await browser.close();
proc.kill('SIGTERM');
