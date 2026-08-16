/**
 * OWNER: weapons agent.
 *
 * Runner for the weapon-only render probe (`probe.html` / `probe.js`).
 *
 *     node src/weapons/probe.mjs --out shots/weapon-probe
 *
 * WHY THIS EXISTS
 * The full capture harness renders a three-million-triangle city ten times to
 * answer questions that are entirely about one mesh — is the receiver reading
 * as parkerised steel, is the reticle on the screen, is the optic bell round.
 * Under software rasterisation that costs minutes of saturated CPU, which is
 * why "the reticle does not render" survived two rounds without ever being
 * measured: nobody could afford to ask twice.
 *
 * This boots the same viewmodel scene with a grey card behind it and shoots
 * four frames. It costs about fifteen seconds, so the loop is:
 *
 *   change the gunsmith -> run this -> look at the PNGs -> repeat
 *
 * It also dumps `report.json`, which is the part a reviewer cannot argue with:
 * measured silhouette coverage in NDC, the collimator's own account of where it
 * put the reticle and at what opacity, and a centre-patch pixel readback that
 * says whether the dot actually landed on the framebuffer. A screenshot can be
 * misread; `reticleLit: false` cannot.
 *
 * Flags: --out <dir>  --quality low|medium|high  --weapon rifle|smg|dmr
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const OUT = path.resolve(arg('out', 'shots/weapon-probe'));
const QUALITY = arg('quality', 'high');
const WEAPON = arg('weapon', 'rifle');
const W = 1600, H = 900;

await mkdir(OUT, { recursive: true });

const server = await createServer({ server: { port: 0 }, logLevel: 'warn' });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-lcd-text'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(`${base}/src/weapons/probe.html?quality=${QUALITY}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => document.body.dataset.ready === '1' || document.querySelector('#err').style.display === 'block',
  { timeout: 120000 });

const failed = await page.evaluate(() => document.querySelector('#err').style.display === 'block'
  ? document.querySelector('#err').textContent : null);
if (failed) {
  await writeFile(path.join(OUT, 'BOOT-FAILURE.txt'), failed);
  console.error(failed);
}

// Full-resolution bakes, exactly as the capture harness does it. Everything
// below this line is judged against the maps the game finally settles on, not
// against the 32px preview the first frame is drawn with.
const bake = await page.evaluate(async (w) => {
  const p = window.__probe;
  p.setWeapon(w);
  const t0 = performance.now();
  await p.flush();
  return { ms: Math.round(performance.now() - t0), slots: p.bakeState() };
}, WEAPON).catch((e) => ({ error: String(e) }));

const report = { weapon: WEAPON, quality: QUALITY, bake, shots: [] };

for (const [name, ads] of [['hip', 0], ['ads', 1], ['ads-half', 0.5]]) {
  const info = await page.evaluate(async (t) => {
    const p = window.__probe;
    p.setAds(t);
    const step = p.step();
    const sil = p.silhouetteNDC();
    const patch = p.centrePatch(24);
    return { step, sil, patch, parts: p.silhouetteByPart() };
  }, ads);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, type: 'png' });
  report.shots.push({
    name, ads, file,
    triangles: info.step.triangles,
    reticle: info.step.reticle,
    // Coverage of the frame the weapon's own vertices occupy. This is the
    // number the "still too large" complaint is about; ~0.18 is a normal
    // shipped hip silhouette, a third of the frame is not.
    silhouetteAreaFrac: +info.sil.areaFrac.toFixed(4),
    silhouetteNDC: { x0: +info.sil.x0.toFixed(3), x1: +info.sil.x1.toFixed(3), y0: +info.sil.y0.toFixed(3), y1: +info.sil.y1.toFixed(3) },
    clippedVerts: info.sil.clipped,
    // Peak luminance in the middle 48px. The reticle is the only thing that
    // can be bright and warm there, so this is a rendering proof, not a guess.
    centrePeak: info.patch.peak, centreWarm: info.patch.warm,
    reticleLit: info.patch.warm > 12,
    byPart: info.parts,
  });
  if (name === 'hip') {
    const rows = Object.entries(info.parts).sort((a, b) => b[1].areaFrac - a[1].areaFrac);
    for (const [k, r] of rows) console.log(`    ${k.padEnd(12)} ${(r.areaFrac * 100).toFixed(1).padStart(5)}%  ndc ${r.ndc.join(' ')}`);
  }
  console.log(`${name.padEnd(9)} sil=${(info.sil.areaFrac * 100).toFixed(1)}%  `
    + `reticle vis=${info.step.reticle.visible} off=${(info.step.reticle.offApertures ?? 0).toFixed(2)}ap `
    + `op=${(info.step.reticle.opacity ?? 0).toFixed(2)}  centre peak=${info.patch.peak} warm=${info.patch.warm}`);
}

report.logs = logs;
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
await writeFile(path.join(OUT, 'console.log'), logs.join('\n'));
console.log(`\nwrote ${OUT}`);

await browser.close();
await server.close();
