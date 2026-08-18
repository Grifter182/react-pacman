import { Engine } from './core/Engine.js';
import { Config, autoDetectQuality } from './core/Config.js';
import { ATMO } from './world/Atmosphere.js';
import { flushMaterialBakes, materialsReady } from './materials/TextureFactory.js';

import { RenderModule } from './render/RenderModule.js';
import { PostStack } from './render/PostStack.js';
import { SkyModule } from './world/SkyModule.js';
import { LightingModule } from './world/LightingModule.js';
import { LevelModule } from './level/LevelModule.js';
import { GltfLevelModule } from './level/GltfLevelModule.js';
import { selectedMap } from './level/MapRegistry.js';
import { CollisionModule } from './physics/CollisionModule.js';
import { PlayerModule } from './player/PlayerModule.js';
import { WeaponModule } from './weapons/WeaponModule.js';
import { FxModule } from './fx/FxModule.js';
import { AiModule } from './ai/AiModule.js';
import { AudioModule } from './audio/AudioModule.js';
import { HudModule } from './ui/HudModule.js';
import { MatchModule } from './game/MatchModule.js';

/**
 * Registration order defines init order and per-frame update order.
 * Dependencies flow strictly downward: a module may only look up modules
 * registered above it during init().
 */

/**
 * Night, expressed as the one number the whole atmosphere derives from.
 *
 * Atmosphere.js generates the sky, the aerial perspective, the sun's colour and
 * the IBL from `ATMO`, precisely so the horizon cannot seam against the fog. So
 * a night preset must not paint a dark sky and leave a noon sun lighting the
 * ground: it drops the sun below the horizon and scales the solar constant, and
 * every dependent term follows on its own.
 *
 * Must run BEFORE SkyModule.init, which samples these to bake its cubemap.
 */
function applyNightSky() {
  ATMO.sunElevationDeg = -3.5;   // just under the horizon: dusk, not pitch black
  ATMO.E0 = 0.55;                // moonlight is roughly a millionth of sunlight;
                                 // this is the cinematic version, not the real one
}

async function boot() {
  const canvas = document.getElementById('view');
  const engine = new Engine(canvas);
  window.__engine = engine; // debug + automated visual capture hook

  const render = engine.register('render', new RenderModule());
  await render.init(engine);              // renderer must exist for capability probe
  Config.quality = autoDetectQuality(render.renderer);
  render._resizeTargets(engine.width, engine.height);
  render.init = async () => {};           // already initialised

  engine.register('post', new PostStack());
  engine.register('sky', new SkyModule());
  engine.register('lighting', new LightingModule());
  engine.register('collision', new CollisionModule());
  // Which map boots is a registry lookup, not a hard-coded class. Both
  // implementations satisfy the same contract, so nothing below this line
  // knows or cares which one it got. See MapRegistry.js.
  const map = selectedMap();
  engine.mapDef = map;
  // `?night=0` forces daylight on a night map and `?night=1` the reverse, so a
  // dark frame can be told from a missing one without editing the registry.
  let night = map.lighting?.preset === 'night';
  try {
    const q = new URLSearchParams(location.search).get('night');
    if (q === '0') night = false; else if (q === '1') night = true;
  } catch { /* ignore */ }
  if (night) applyNightSky();
  engine.register('level', map.kind === 'gltf'
    ? new GltfLevelModule(map)
    : new LevelModule());
  engine.register('fx', new FxModule());
  engine.register('audio', new AudioModule());
  engine.register('player', new PlayerModule());
  engine.register('weapons', new WeaponModule());
  engine.register('ai', new AiModule());
  engine.register('match', new MatchModule());
  engine.register('hud', new HudModule());

  await engine.init();
  engine.start();

  // Headless capture control surface.
  //
  // Procedural textures bake progressively on a per-frame time budget so the
  // game is playable while they refine. Under software rasterisation frames
  // take ~160ms, so that budget is never met and the capture would photograph
  // 32px preview maps upscaled — which is exactly what a review would then
  // (reasonably) call "blurry camouflage". Capture must force completion.
  window.__game = {
    engine,
    flushMaterialBakes,
    materialsReady,
    /** Hide debug overlays that must never appear in a captured frame. */
    setCaptureMode(on) {
      Config.debug.showStats = !on && Config.debug.showStats;
      Config.debug.captureMode = !!on;
      document.body.classList.toggle('capture-mode', !!on);
      if (on && !document.getElementById('capture-style')) {
        const st = document.createElement('style');
        st.id = 'capture-style';
        // Debug readouts and the click-to-deploy overlay are development
        // affordances, not part of the game's presentation.
        st.textContent = `.capture-mode .perf,
          .capture-mode .stats,
          .capture-mode .debug-only,
          .capture-mode .prompt { display: none !important; }`;
        document.head.appendChild(st);
      }
      engine.bus.emit('ui:capture', { capture: !!on });
    },
  };

  // Signal to headless capture that the first frame has presented.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.dataset.ready = '1';
  }));
}

boot().catch((err) => {
  console.error('[boot] fatal', err);
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;inset:0;padding:24px;color:#f66;background:#0a0c10;font:13px/1.5 monospace;white-space:pre-wrap;z-index:999';
  el.textContent = `Boot failure\n\n${err?.stack || err}`;
  document.body.appendChild(el);
});
