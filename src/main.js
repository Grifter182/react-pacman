import { Engine } from './core/Engine.js';
import { Config, autoDetectQuality } from './core/Config.js';

import { RenderModule } from './render/RenderModule.js';
import { PostStack } from './render/PostStack.js';
import { SkyModule } from './world/SkyModule.js';
import { LightingModule } from './world/LightingModule.js';
import { LevelModule } from './level/LevelModule.js';
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
  engine.register('level', new LevelModule());
  engine.register('fx', new FxModule());
  engine.register('audio', new AudioModule());
  engine.register('player', new PlayerModule());
  engine.register('weapons', new WeaponModule());
  engine.register('ai', new AiModule());
  engine.register('match', new MatchModule());
  engine.register('hud', new HudModule());

  await engine.init();
  engine.start();

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
