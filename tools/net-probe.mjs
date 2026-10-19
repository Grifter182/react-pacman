/**
 * Online-play probe: two real clients, one real relay, one firefight.
 *
 *   npx vite build && PW_CHROMIUM=/opt/pw-browsers/chromium node tools/net-probe.mjs --out shots/net
 *
 * Boots server/relay.mjs on a random port serving dist/, opens two headless
 * Chromium pages in the same room, stands them face to face and has ALPHA
 * shoot BRAVO through the real weapon path (no synthetic events). Asserts:
 *
 *   presence   each client sees exactly one remote body, and it is visible
 *   motion     BRAVO's remote body on ALPHA's screen tracks BRAVO's position
 *   damage     BRAVO's own client takes 'player:damaged' from ALPHA
 *   kill       BRAVO dies, the relay credits ALPHA, both killfeeds name it
 *   leave      closing BRAVO removes the body from ALPHA's world
 *
 * Writes PNGs of ALPHA's view before and after the kill, console.log for both
 * pages, and result.json. Exits non-zero on any failed assertion.
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
const OUT = path.resolve(arg('out', 'shots/net'));
const PORT = parseInt(arg('port', String(9200 + Math.floor(Math.random() * 600))), 10);
const QUALITY = arg('quality', 'medium');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function startRelay() {
  const proc = spawn(process.execPath, ['server/relay.mjs', '--port', String(PORT), '--host', '127.0.0.1',
    // Both pages share one SwiftShader GPU process, so either can block the
    // other's main thread for tens of seconds; that is not a disconnect.
    '--idle', '600000'], {
    cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  proc.stdout.on('data', (d) => lines.push(String(d)));
  proc.stderr.on('data', (d) => lines.push(String(d)));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay did not start')), 10000);
    proc.stdout.on('data', (d) => { if (/relay on/.test(String(d))) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`relay exited ${c}`)); });
  });
  return { proc, lines };
}

async function openClient(browser, name) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  // Record the bus traffic the assertions need, from the first frame.
  await page.addInitScript(() => {
    window.__probe = { damaged: [], died: [], killfeed: [], hits: 0, killed: [] };
    const hook = () => {
      const e = window.__engine;
      if (!e) return setTimeout(hook, 50);
      e.bus.on('player:damaged', (x) => window.__probe.damaged.push({ amount: x.amount, from: x.from }));
      e.bus.on('player:died', (x) => window.__probe.died.push({ by: x.by }));
      e.bus.on('match:killfeed', (x) => window.__probe.killfeed.push({ a: x.attacker, v: x.victim }));
      e.bus.on('hit:actor', () => { window.__probe.hits++; });
      window.__probe.fires = [];
      e.bus.on('weapon:fire', (x) => {
        const r = [...(e.get('net')?.remotes.values() || [])][0];
        const o = x.eyeOrigin || x.origin;
        const h = r ? r.raycast(o, x.direction, 400) : null;
        window.__probe.fires.push({ world: x.hit ? +x.hit.distance.toFixed(2) : null, remote: h ? +h.t.toFixed(2) : null,
          alive: r?.actor.alive, connected: e.get('net')?.connected });
      });
      e.bus.on('actor:killed', (x) => window.__probe.killed.push({ by: x.by, net: !!x.actor?.net }));
    };
    hook();
  });
  const url = `http://127.0.0.1:${PORT}/?online=1&room=probe&name=${name}&quality=${QUALITY}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  return { page, logs, name };
}

async function ready(c) {
  await c.page.waitForFunction(
    () => document.body.dataset.ready === '1' || document.querySelector('pre'),
    null, { timeout: 150000 },
  );
  await c.page.evaluate(async () => {
    const g = window.__game;
    g.setCaptureMode(true);
    g.flushMaterialBakes();
    await g.materialsReady();
  });
}

/** Stand the player at a point, looking along a yaw, with no momentum. */
function place(c, pos, yaw, pitch = 0) {
  return c.page.evaluate(({ pos, yaw, pitch }) => {
    const p = window.__engine.get('player');
    p.state.position.set(pos[0], pos[1], pos[2]);
    p.state.velocity.set(0, 0, 0);
    p.state.yaw = yaw;
    p.state.pitch = pitch;
  }, { pos, yaw, pitch });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const relay = await startRelay();
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage', '--no-sandbox',
      '--hide-scrollbars', '--mute-audio',
      // Two pages, one focused: without these the other one's frame loop is
      // paused as a background tab and it stops simulating.
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows'],
  });

  let A, B;
  try {
    // Sequential boots: two SwiftShader level builds at once starve each other.
    A = await openClient(browser, 'ALPHA');
    await ready(A);
    // ALPHA's render loop on SwiftShader would starve BRAVO's boot; hold it.
    await A.page.evaluate(() => window.__engine.stop());
    B = await openClient(browser, 'BRAVO');
    await ready(B);
    await A.page.evaluate(() => window.__engine.start());

    /* --- presence --------------------------------------------------------- */
    await A.page.waitForFunction(() => window.__engine.get('net').remotes.size === 1, null, { timeout: 15000 }).catch(() => {});
    const pres = await Promise.all([A, B].map((c) => c.page.evaluate(() => {
      const n = window.__engine.get('net');
      return { connected: n.connected, id: n.myId, name: n.myName, remotes: [...n.remotes.values()].map((r) => r.name) };
    })));
    check('both clients connected', pres[0].connected && pres[1].connected, JSON.stringify(pres));
    check('ALPHA sees BRAVO', pres[0].remotes.length === 1 && pres[0].remotes[0] === 'BRAVO');
    check('BRAVO sees ALPHA', pres[1].remotes.length === 1 && pres[1].remotes[0] === 'ALPHA');

    /* --- motion ----------------------------------------------------------- */
    // Same spots the capture harness uses, so they are known to be open ground.
    await place(B, [0, 1.0, 12], Math.PI);           // looking +Z, at ALPHA
    await place(A, [0, 1.0, 20], 0, -0.03);          // looking -Z, at BRAVO
    await A.page.waitForFunction(() => {
      const r = [...window.__engine.get('net').remotes.values()][0];
      return r && r.actor.alive && Math.abs(r.actor.position.z - 12) < 1;
    }, null, { timeout: 60000 }).catch(() => {});
    await A.page.waitForTimeout(1000);
    const seen = await A.page.evaluate(() => {
      const r = [...window.__engine.get('net').remotes.values()][0];
      return { alive: r.actor.alive, visible: r.inst.mesh.visible, pos: r.actor.position.toArray().map((v) => +v.toFixed(2)) };
    });
    const truth = await B.page.evaluate(() => window.__engine.get('player').state.position.toArray().map((v) => +v.toFixed(2)));
    const err = Math.hypot(seen.pos[0] - truth[0], seen.pos[2] - truth[2]);
    check('remote body alive and visible', seen.alive && seen.visible, JSON.stringify(seen));
    check('remote body tracks real position (<0.5 m)', err < 0.5, `seen ${seen.pos} truth ${truth} err ${err.toFixed(2)} m`);

    await A.page.screenshot({ path: path.join(OUT, '01-alpha-sees-bravo.png'), timeout: 180000 });

    /* --- damage + kill ---------------------------------------------------- */
    // Aim at BRAVO's chest from ALPHA's eye and fire through the weapon's own
    // `_fire` — real spread, recoil, ballistics and 'weapon:fire' — once per
    // round. The trigger can't be held instead: SwiftShader manages well under
    // one frame a second here, and the weapon fires at most once per frame.
    await A.page.evaluate(() => {
      const e = window.__engine;
      const w = e.get('weapons');
      const p = e.get('player');
      for (let i = 0; i < 8; i++) {
        const r = [...e.get('net').remotes.values()][0];
        if (!r?.actor.alive) break;
        const chest = r.inst.byName.get('chest').getWorldPosition(r.actor.position.clone());
        e.camera.updateMatrixWorld(true);
        const eye = e.camera.position;
        const dx = chest.x - eye.x, dy = chest.y - eye.y, dz = chest.z - eye.z;
        p.state.yaw = Math.atan2(-dx, -dz);
        p.state.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        e.camera.rotation.set(p.state.pitch, p.state.yaw, 0, 'YXZ');
        e.camera.updateMatrixWorld(true);
        w._fire(e, w.def);
      }
    });
    await B.page.waitForFunction(() => window.__probe.died.length > 0, null, { timeout: 30000 }).catch(() => {});
    await A.page.waitForTimeout(1200);

    const pa = await A.page.evaluate(() => ({
      probe: window.__probe,
      scores: [...window.__engine.get('net').scores.entries()],
      me: window.__engine.get('net').myId,
      remoteAlive: [...window.__engine.get('net').remotes.values()][0]?.actor.alive,
      ragdoll: !![...window.__engine.get('net').remotes.values()][0]?.ragdoll?.active,
    }));
    const pb = await B.page.evaluate(() => ({ probe: window.__probe, alive: window.__engine.get('player').state.alive }));
    console.log('fires', JSON.stringify(pa.probe.fires.slice(0, 12)), 'total', pa.probe.fires.length);
    check('ALPHA registered hits on BRAVO', pa.probe.hits > 0, `hits ${pa.probe.hits}`);
    check('BRAVO took damage from ALPHA', pb.probe.damaged.some((d) => d.from === 'ALPHA'),
      JSON.stringify(pb.probe.damaged.slice(0, 6)));
    check('BRAVO died to ALPHA', pb.probe.died.some((d) => d.by === 'ALPHA'), JSON.stringify(pb.probe.died));
    const mine = new Map(pa.scores).get(pa.me);
    check('relay credited ALPHA with the kill', mine?.k === 1, JSON.stringify(pa.scores));
    check('ALPHA saw actor:killed by player', pa.probe.killed.some((k) => k.by === 'player' && k.net), JSON.stringify(pa.probe.killed));
    check('ALPHA killfeed: YOU -> BRAVO', pa.probe.killfeed.some((k) => k.a === 'YOU' && k.v === 'BRAVO'), JSON.stringify(pa.probe.killfeed));
    check('BRAVO killfeed: ALPHA -> YOU', pb.probe.killfeed.some((k) => k.a === 'ALPHA' && k.v === 'YOU'), JSON.stringify(pb.probe.killfeed));
    check('BRAVO body ragdolled on ALPHA screen', pa.remoteAlive === false && pa.ragdoll, JSON.stringify({ alive: pa.remoteAlive, ragdoll: pa.ragdoll }));

    await A.page.screenshot({ path: path.join(OUT, '02-alpha-after-kill.png'), timeout: 180000 });

    /* --- respawn ---------------------------------------------------------- */
    await A.page.waitForFunction(() => [...window.__engine.get('net').remotes.values()][0]?.actor.alive === true,
      // Respawn is 4 s of *game* time; at SwiftShader frame rates, with dt
      // clamped per frame, that is minutes of wall clock.
      null, { timeout: 240000 }).catch(() => {});
    const back = await A.page.evaluate(() => [...window.__engine.get('net').remotes.values()][0]?.actor.alive);
    check('BRAVO respawned on ALPHA screen', back === true);

    /* --- HUD --------------------------------------------------------------- */
    // The session panel is presentation, hidden only in capture mode; show it
    // with the relay scoreboard open (Tab held) to photograph it.
    await A.page.evaluate(() => {
      window.__game.setCaptureMode(false);
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' }));
    });
    await A.page.waitForTimeout(1500);
    const hud = await A.page.evaluate(() => {
      const el = document.querySelector('.bl-net');
      return {
        state: el?.dataset.state,
        status: el?.querySelector('.bl-net-status')?.textContent,
        rows: [...(el?.querySelectorAll('tbody tr') || [])].map((tr) => tr.textContent),
      };
    });
    check('session panel online with relay scoreboard', hud.state === 'online' && hud.rows.length === 2, JSON.stringify(hud));
    await A.page.screenshot({ path: path.join(OUT, '03-alpha-online-hud.png'), timeout: 180000 });

    /* --- leave ------------------------------------------------------------ */
    await B.page.close();
    await A.page.waitForFunction(() => window.__engine.get('net').remotes.size === 0, null, { timeout: 15000 }).catch(() => {});
    const left = await A.page.evaluate(() => window.__engine.get('net').remotes.size);
    check('leave removes the body', left === 0, `remotes ${left}`);
  } catch (e) {
    check('probe ran to completion', false, String(e?.stack || e));
  }

  const clean = (logs) => logs.filter((l) => !/GPU stall due to ReadPixels|Automatic fallback to software WebGL/i.test(l));
  for (const c of [A, B]) {
    if (!c) continue;
    await writeFile(path.join(OUT, `console-${c.name}.log`), c.logs.join('\n') || '(no errors or warnings)');
    check(`${c.name} console free of errors`, !clean(c.logs).some((l) => /^\[(error|pageerror)\]/.test(l)),
      clean(c.logs).slice(0, 5).join(' | '));
  }
  await writeFile(path.join(OUT, 'relay.log'), relay.lines.join(''));
  await writeFile(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2));

  await browser.close();
  relay.proc.kill('SIGTERM');
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
