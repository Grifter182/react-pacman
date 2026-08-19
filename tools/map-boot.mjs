/** Does an imported map boot, collide and hold the player up? */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const MAP = process.env.MAP || 'forest';
const PORT = 5200 + Math.floor(Math.random() * 3000);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => { const t = setTimeout(() => j(new Error('vite')), 30000); proc.stdout.on('data', d => { if (/Local:|ready in/i.test(String(d))) { clearTimeout(t); setTimeout(r, 600); } }); });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
const errs = [];
p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { const t = m.text(); if (/\[Level\]|\[AI\] navmesh/.test(t)) console.log('PAGE:', t.slice(0, 220)); if (m.type() === 'error') errs.push(t.slice(0, 200)); });
await p.goto(`http://127.0.0.1:${PORT}?quality=low&nofrontend=1&map=${MAP}`, { waitUntil: 'load' });
await p.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 300000 }).catch(() => errs.push('never became ready'));
await p.waitForTimeout(2500);
const out = await p.evaluate(() => {
  const e = window.__engine, lvl = e.get('level'), s = e.get('player').state;
  e.get('render')?.renderer?.info && null;
  window.__step = (sec) => { const dt = 1 / 120; for (let i = 0, n = Math.round(sec / dt); i < n; i++) for (const { module } of e._order) if (module.fixedUpdate) module.fixedUpdate(dt, e); };
  const y0 = s.position.y;
  window.__step(3);
  const i = e.renderer?.info || e.get('render')?.renderer?.info;
  return {
    map: e.mapDef?.id, stats: lvl.stats,
    bounds: lvl.bounds ? { min: lvl.bounds.min.toArray().map(v => +v.toFixed(1)), max: lvl.bounds.max.toArray().map(v => +v.toFixed(1)) } : null,
    spawns: lvl.spawnPoints?.length ?? 0,
    startY: +y0.toFixed(2), afterY: +s.position.y.toFixed(2), grounded: s.grounded,
    draws: i?.render?.calls ?? null, tris: i?.render?.triangles ?? null,
  };
});
console.log(JSON.stringify(out, null, 2));
console.log(errs.length ? `\nERRORS (${errs.length}):\n` + errs.slice(0, 6).join('\n') : '\nno page errors');
const fell = out.afterY < out.startY - 3;
console.log(`\nVERDICT: ${errs.length ? 'ERRORS' : 'clean boot'} | player ${fell ? 'FELL THROUGH THE MAP' : 'held up by collision'} | ${out.draws} draw calls`);
await b.close(); proc.kill(); process.exit(0);
