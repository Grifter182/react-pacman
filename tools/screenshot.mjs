/**
 * Headless capture harness.
 *
 * Boots the game in Chromium (SwiftShader software GL), drives the engine
 * through scripted camera shots, and writes PNGs plus a console-error log.
 * This is the ground truth for every visual-critique pass — a shot that fails
 * to render is a bug, not a bad camera angle.
 *
 *   node tools/screenshot.mjs --out shots/pass1 --shots default
 *   node tools/screenshot.mjs --url http://localhost:5173 --width 1920 --height 1080
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const OUT = path.resolve(arg('out', 'shots/latest'));
const WIDTH = parseInt(arg('width', '1600'), 10);
const HEIGHT = parseInt(arg('height', '900'), 10);
// Random high port so concurrent critique passes never collide.
const PORT = parseInt(arg('port', String(5200 + Math.floor(Math.random() * 3000))), 10);
const URL = arg('url', null);
const SETTLE = parseInt(arg('settle', '2500'), 10);

/**
 * Camera shots. Each entry positions the player and runs optional actions.
 * `pos` is the player capsule centre; `yaw`/`pitch` are radians.
 */
const SHOT_SETS = {
  default: [
    { name: '01-spawn-vista', pos: [0, 1.0, 34], yaw: Math.PI, pitch: -0.04 },
    { name: '02-midfield', pos: [0, 1.0, 20], yaw: Math.PI, pitch: 0.0 },
    { name: '03-cover-detail', pos: [-20, 1.0, -8], yaw: 2.2, pitch: -0.06 },
    { name: '04-ads', pos: [0, 1.0, 18], yaw: Math.PI, pitch: -0.02, ads: true },
    { name: '05-firing', pos: [0, 1.0, 18], yaw: Math.PI, pitch: -0.02, fire: true },
    { name: '06-sun-flare', pos: [10, 1.0, 10], yaw: 0.85, pitch: 0.28 },
    { name: '07-shadow-read', pos: [16, 1.0, -2], yaw: -1.6, pitch: -0.14 },
    { name: '08-ground-material', pos: [0, 1.0, 26], yaw: Math.PI, pitch: -0.62 },
    { name: '09-skyline', pos: [-30, 1.0, 30], yaw: 2.5, pitch: 0.12 },
    { name: '10-enemy-engage', pos: [0, 1.0, 12], yaw: Math.PI, pitch: -0.02, ads: true, fire: true },
  ],
};

async function startServer() {
  if (URL) return { url: URL, kill: () => {} };
  const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start in 30s')), 30000);
    proc.stdout.on('data', (d) => {
      if (/Local:|ready in/i.test(String(d))) { clearTimeout(timer); setTimeout(resolve, 400); }
    });
    proc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    proc.on('exit', (c) => { clearTimeout(timer); reject(new Error(`vite exited ${c}`)); });
  });
  return { url: `http://127.0.0.1:${PORT}`, kill: () => proc.kill('SIGTERM') };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await startServer();

  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });

  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));

  // Force the quality tier. Headless runs on SwiftShader, which the runtime
  // probe demotes to MEDIUM — correct for a real player on software GL, but it
  // would mean every visual review judged an image with the top-tier effects
  // switched off. Reviews must see what the game is actually trying to render.
  const quality = arg('quality', 'high');
  const target = `${server.url}${server.url.includes('?') ? '&' : '?'}quality=${quality}`;
  await page.goto(target, { waitUntil: 'load', timeout: 60000 });

  // Wait for the engine to present its first frame.
  await page.waitForFunction(() => document.body.dataset.ready === '1' || document.querySelector('pre'), { timeout: 90000 })
    .catch(() => logs.push('[harness] timed out waiting for first frame'));

  const boot = await page.evaluate(() => {
    const pre = document.querySelector('pre');
    return { failed: !!pre, message: pre ? pre.textContent : null, hasEngine: !!window.__engine };
  });
  if (boot.failed) {
    await writeFile(path.join(OUT, 'BOOT-FAILURE.txt'), boot.message || 'unknown');
    logs.push('[harness] BOOT FAILURE — see BOOT-FAILURE.txt');
  }

  // Force every procedural texture to full resolution and hide debug overlays.
  // Without this the capture photographs low-res preview maps, because the
  // progressive bake budget is never met under software rasterisation.
  const prep = await page.evaluate(async () => {
    const g = window.__game;
    if (!g) return { ok: false, reason: 'window.__game missing' };
    g.setCaptureMode(true);
    const t0 = performance.now();
    g.flushMaterialBakes();
    await g.materialsReady();
    return { ok: true, bakeMs: Math.round(performance.now() - t0) };
  }).catch((e) => ({ ok: false, reason: String(e) }));
  if (!prep.ok) logs.push(`[harness] capture prep failed: ${prep.reason}`);
  else console.log(`[harness] material bake flush ${prep.bakeMs}ms`);

  await page.waitForTimeout(SETTLE);

  const shots = SHOT_SETS[arg('shots', 'default')] || SHOT_SETS.default;
  const manifest = [];

  for (const shot of shots) {
    await page.evaluate(async (s) => {
      const e = window.__engine;
      if (!e) return;
      const p = e.get('player');
      if (p) {
        p.state.position.set(s.pos[0], s.pos[1], s.pos[2]);
        p.state.velocity.set(0, 0, 0);
        p.state.yaw = s.yaw;
        p.state.pitch = s.pitch;
        p.state.ads = !!s.ads;
      }
      const w = e.get('weapons');
      if (w) {
        w._adsBlend = s.ads ? 1 : 0;
        if (s.fire) { w._cooldown = 0; w.firing = true; }
        else w.firing = false;
      }
    }, shot);

    // Let bob/ADS/exposure settle, then hold a couple of frames.
    await page.waitForTimeout(shot.fire ? 220 : 520);

    const file = path.join(OUT, `${shot.name}.png`);
    // Under SwiftShader a single composited frame can take well over Playwright's
    // 30s screenshot default, which aborts the whole run mid-capture.
    await page.screenshot({ path: file, type: 'png', timeout: 180000 });
    manifest.push({ name: shot.name, file, ...shot });

    if (shot.fire) await page.evaluate(() => { const w = window.__engine?.get('weapons'); if (w) w.firing = false; });
  }

  const stats = await page.evaluate(() => {
    const e = window.__engine;
    if (!e?.renderer) return null;
    const i = e.renderer.info;
    return {
      fps: Math.round(e.perf.fps),
      drawCalls: i.render.calls,
      triangles: i.render.triangles,
      programs: i.programs?.length ?? 0,
      textures: i.memory.textures,
      geometries: i.memory.geometries,
      quality: e.config.quality,
    };
  });

  await writeFile(path.join(OUT, 'console.log'), logs.join('\n') || '(no errors or warnings)');
  await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify({ stats, shots: manifest, logs }, null, 2));

  console.log(JSON.stringify({ out: OUT, stats, shotCount: shots.length, errorCount: logs.length }, null, 2));
  if (logs.length) console.log('\n--- console ---\n' + logs.slice(0, 40).join('\n'));

  await browser.close();
  server.kill();
}

main().catch(async (e) => { console.error(e); process.exit(1); });
