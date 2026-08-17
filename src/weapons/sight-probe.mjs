/**
 * OWNER: weapons agent.  Runner for `sight-probe.html`.
 *
 *   PW_CHROMIUM=/opt/pw-browsers/chromium node src/weapons/sight-probe.mjs --out <dir>
 *
 * Shoots hip / half-ADS / full-ADS for each weapon and reports `apertureFrac`:
 * the share of the centre disc that is the downrange target board rather than
 * the weapon. That number is the sight picture, expressed so a reviewer cannot
 * argue with it — 0 means the sight is a plug.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = path.resolve(arg('out', 'shots/sight-probe'));
const QUALITY = arg('quality', 'high');
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

await page.goto(`${base}/src/weapons/sight-probe.html?quality=${QUALITY}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(
  () => document.body.dataset.ready === '1' || document.querySelector('#err').style.display === 'block',
  { timeout: 180000 });

const boom = await page.evaluate(() => document.querySelector('#err').style.display === 'block'
  ? document.querySelector('#err').textContent : null);
if (boom) { console.error(boom); await writeFile(path.join(OUT, 'BOOT-FAILURE.txt'), boom); }

const report = [];
for (const weapon of (arg('weapon', 'rifle,smg,dmr')).split(',')) {
  await page.evaluate(async (w) => { window.__sight.setWeapon(w); await window.__sight.flush(); }, weapon);
  for (const [name, ads] of [['ads', 1], ['ads-half', 0.5], ['hip', 0]]) {
    const info = await page.evaluate((t) => {
      window.__sight.setAds(t);
      const s = window.__sight.step();
      return { s, ap: window.__sight.aperture(0.06) };
    }, ads);
    await page.screenshot({ path: path.join(OUT, `${weapon}-${name}.png`), type: 'png' });
    const row = {
      weapon, name, ads,
      apertureFrac: +info.ap.frac.toFixed(3),
      reticleVisible: info.s.reticle.visible,
      reticleOpacity: +(info.s.reticle.opacity ?? 0).toFixed(2),
      triangles: info.s.triangles, drawCalls: info.s.calls,
    };
    report.push(row);
    console.log(`${weapon.padEnd(6)} ${name.padEnd(9)} aperture=${(row.apertureFrac * 100).toFixed(0)}%  `
      + `reticle=${row.reticleVisible}/${row.reticleOpacity}  tris=${row.triangles} calls=${row.drawCalls}`);
  }
}

await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ quality: QUALITY, report, logs }, null, 2));
await writeFile(path.join(OUT, 'console.log'), logs.join('\n'));
console.log(`\nwrote ${OUT}`);
await browser.close();
await server.close();
