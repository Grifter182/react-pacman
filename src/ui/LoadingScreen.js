import { frag, clamp } from './Dom.js';

/**
 * OWNER: UI/UX agent.
 *
 * Boot screen with *real* progress.
 *
 * The problem: everything in this game is generated at boot — textures, the
 * market, the navmesh, the soldier mesh, the sky LUTs — and `Engine.init()`
 * awaits each module in registration order. Almost none of those awaits yield,
 * so the browser never gets a paint slot and the player watches a frozen black
 * canvas for several seconds with no signal that anything is happening.
 *
 * The fix has two halves:
 *
 *  1. **Hook the module list before any init runs.** `Engine.register()` assigns
 *     `module.engine` synchronously, which is the earliest instant the HUD can
 *     see the engine — and it happens before the first `init()`. The HUD makes
 *     `engine` an accessor so that assignment calls `attach()` here. Because the
 *     HUD is registered last, the whole module list is already present.
 *  2. **Wrap each module's `init` and yield around it.** The wrapper paints the
 *     label and the bar, waits one animation frame so the compositor actually
 *     shows it, then runs the real init. Two frames of overhead per module buys
 *     an honest progress bar over a frozen screen.
 *
 * Weights are measured init cost, not module count: the level generator and the
 * navmesh dominate, and a bar that moves in thirteen equal steps would lie
 * about where the time goes.
 */

const WEIGHTS = {
  render: 1, post: 6, sky: 9, lighting: 3, collision: 1,
  level: 34, fx: 9, audio: 2, player: 2, weapons: 13, ai: 16, match: 1, hud: 3,
};

const LABELS = {
  render: 'INITIALISING RENDERER',
  post: 'COMPILING POST STACK',
  sky: 'INTEGRATING ATMOSPHERE',
  lighting: 'PLACING LIGHTS',
  collision: 'BUILDING COLLISION',
  level: 'GENERATING SUQ AL-HADID',
  fx: 'BAKING EFFECT ATLASES',
  audio: 'SYNTHESISING AUDIO',
  player: 'CALIBRATING CONTROLS',
  weapons: 'MACHINING WEAPONS',
  ai: 'VOXELISING NAVMESH',
  match: 'BRIEFING SQUADS',
  hud: 'BOOTING HUD',
};

const TIPS = [
  ['FIRST SHOT', 'A settled weapon puts its first round on the pip. Stop, then fire.'],
  ['PENETRATION', 'Plaster, wood and canvas do not stop a rifle round. Concrete does.'],
  ['SPREAD', 'The reticle gap is the real cone. If it is open, the round can be too.'],
  ['SUPPRESSION', 'Rounds cracking past will pull your aim. Break line of sight first.'],
  ['STREAKS', 'Three eliminations calls a UAV. Five calls an airstrike.'],
];

export class LoadingScreen {
  constructor(parent) {
    const tip = TIPS[(Math.random() * TIPS.length) | 0];
    this.node = frag(`
      <div class="bl-load">
        <div class="box">
          <div class="eyebrow">TASK FORCE 141 · CLASSIFIED</div>
          <h1>OPERATION <em>BLACKOUT</em></h1>
          <div class="bar"><i></i></div>
          <div class="meta"><span class="lbl">INITIALISING</span><span class="pc bl-num">0%</span></div>
          <div class="tips"><b>${tip[0]}</b> — ${tip[1]}</div>
        </div>
      </div>`);
    parent.appendChild(this.node);

    this.$bar = this.node.querySelector('.bar i');
    this.$lbl = this.node.querySelector('.lbl');
    this.$pc = this.node.querySelector('.pc');
    this._done = 0;
    this._total = 1;
  }

  /**
   * Wrap every registered module's `init` so the bar advances with real work.
   * Safe against an Engine that stops exposing `_order`: the screen then simply
   * shows an indeterminate state and is dismissed on 'engine:ready'.
   */
  attach(engine) {
    engine.bus.once?.('engine:ready', () => this.finish());

    const order = engine._order;
    if (!Array.isArray(order)) return;

    this._total = order.reduce((n, e) => n + (WEIGHTS[e.name] ?? 3), 0);

    for (const entry of order) {
      const original = entry.module.init;
      const weight = WEIGHTS[entry.name] ?? 3;
      const label = LABELS[entry.name] || entry.name.toUpperCase();
      if (typeof original !== 'function') { this._done += weight; continue; }

      entry.module.init = async (...args) => {
        this._set(label, this._done / this._total);
        // One frame for the compositor, so the label the player is about to
        // wait behind is actually on screen before the work starts.
        await nextFrame();
        try {
          return await original.apply(entry.module, args);
        } finally {
          this._done += weight;
          this._set(label, this._done / this._total);
        }
      };
    }
  }

  _set(label, t) {
    const pc = Math.round(clamp(t, 0, 1) * 100);
    this.$bar.style.width = `${pc}%`;
    if (this.$lbl.textContent !== label) this.$lbl.textContent = label;
    this.$pc.textContent = `${pc}%`;
  }

  finish() {
    if (this._finished) return;
    this._finished = true;
    this._set('READY', 1);
    // Hold the full bar for a beat so the last label is readable, then fade.
    setTimeout(() => {
      this.node.classList.add('gone');
      setTimeout(() => this.node.remove(), 600);
    }, 260);
  }
}

/**
 * One paint, or 60 ms, whichever comes first. The timeout matters: in a hidden
 * or backgrounded tab `requestAnimationFrame` never fires, and without the race
 * the whole boot sequence would deadlock waiting for a frame that never comes.
 */
function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 60);
  });
}
