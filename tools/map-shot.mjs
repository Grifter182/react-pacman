/** Two quick frames: the map picker, and the map itself. */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
const MAP = process.env.MAP || 'forest';
const OUT = process.env.OUT || 'shots/mapsel';
const EXTRA = process.env.EXTRA || '';
const PORT = 5200 + Math.floor(Math.random() * 3000);
await mkdir(OUT, { recursive: true });
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => { const t = setTimeout(() => j(new Error('vite')), 30000); proc.stdout.on('data', d => { if (/Local:|ready in/i.test(String(d))) { clearTimeout(t); setTimeout(r, 600); } }); });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));

// 1. the picker, on the title screen
await p.goto(`http://127.0.0.1:${PORT}?quality=low&frontend=1&map=${MAP}${EXTRA}`, { waitUntil: 'load' });
await p.waitForFunction(() => !!document.querySelector('.bl-menu.on .bl-btn'), null, { timeout: 300000 });
await p.waitForTimeout(2000);
await p.evaluate(() => {
  const b = [...document.querySelectorAll('.bl-menu .bl-btn')].find(n => /MAPS/i.test(n.textContent || ''));
  b?.click();
});
await p.waitForTimeout(1200);
console.log('picker cards:', await p.evaluate(() => [...document.querySelectorAll('.bl-mapcard')].map(c => c.querySelector('.nm')?.textContent)));
console.log('credit shown:', await p.evaluate(() => !!document.querySelector('.bl-mapcredit')?.textContent?.includes('dasy444')));
await p.screenshot({ path: `${OUT}/00-picker.png` });

// 2. the map in play
await p.goto(`http://127.0.0.1:${PORT}?quality=low&nofrontend=1&map=${MAP}${EXTRA}`, { waitUntil: 'load' });
await p.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 300000 });
await p.waitForTimeout(6000);
const info = await p.evaluate(() => {
  const e = window.__engine, s = e.get('player').state;
  window.__step = (sec) => { const dt = 1 / 120; for (let i = 0, n = Math.round(sec / dt); i < n; i++) for (const { m } of []) {} };
  return { pos: s.position.toArray().map(v => +v.toFixed(1)), spawns: e.get('level').spawnPoints?.length };
});
console.log('player at', JSON.stringify(info));
await p.screenshot({ path: `${OUT}/01-spawn.png` });
// look around: three yaws so a black frame can be told from a bad camera angle
for (const [i, yaw] of [0, Math.PI / 2, Math.PI].entries()) {
  await p.evaluate((y) => { window.__engine.get('player').state.yaw = y; }, yaw);
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${OUT}/1${i}-yaw.png` });
}
// brightness readout, so "too dark" is a number not an impression
const lum = await p.evaluate(() => {
  const c = document.getElementById('view');
  const t = document.createElement('canvas'); t.width = 160; t.height = 90;
  t.getContext('2d').drawImage(c, 0, 0, 160, 90);
  const d = t.getContext('2d').getImageData(0, 0, 160, 90).data;
  let sum = 0, mx = 0, dark = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l; mx = Math.max(mx, l); if (l < 8) dark++;
  }
  const n = d.length / 4;
  return { meanLuma: +(sum / n).toFixed(1), maxLuma: +mx.toFixed(0), pctNearBlack: +((dark / n) * 100).toFixed(1) };
});
console.log('frame luminance:', JSON.stringify(lum));
console.log(errs.length ? `ERRORS: ${errs.slice(0, 4).join(' | ')}` : 'no page errors');
await b.close(); proc.kill(); process.exit(0);
