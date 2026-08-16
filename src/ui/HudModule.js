import { installStyles } from './UiStyles.js';
import { el, clamp, damp } from './Dom.js';
import { Crosshair, DamageIndicators } from './Crosshair.js';
import { Minimap } from './Minimap.js';
import { Compass } from './Compass.js';
import { Killfeed } from './Killfeed.js';
import { VitalsPanel, AmmoPanel, MatchBar, Callouts, ObjectiveStrip, RespawnOverlay } from './StatusPanels.js';
import { Scoreboard } from './Scoreboard.js';
import { Menus } from './Menus.js';
import { LoadingScreen } from './LoadingScreen.js';
import { Config } from '../core/Config.js';

/**
 * OWNER: UI/UX agent.
 *
 * The whole presentation layer: gameplay HUD, front end, and the boot screen.
 *
 * ARCHITECTURE
 *   - Everything is DOM + CSS inside `#ui`. Nothing is created per frame; every
 *     repeating element (killfeed rows, damage arcs, callouts, scoreboard rows)
 *     is pooled at construction. The only canvas is the minimap, which is the
 *     right tool for a rotating raster.
 *   - Simulation state is read, never written. The HUD subscribes to the bus for
 *     events and samples `engine.get(...)` for continuous values (health,
 *     ammunition, spread), exactly as the module contract allows.
 *   - The front end is a five-state machine — loading, title, live, pause,
 *     summary — driven by pointer-lock changes and match events, so ESC always
 *     means the same thing.
 *
 * HEADLESS. The visual-capture harness drives the camera with no user gesture,
 * so a title screen would sit over every screenshot every other agent relies on.
 * When `navigator.webdriver` is set (or `?nofrontend=1` is passed) the front end
 * is skipped entirely and the HUD boots straight into its live layout.
 *
 * EVENTS IN
 *   ui:pointerlock ui:vitals ui:damage ui:notify ui:settings
 *   hit:actor actor:killed weapon:reload weapon:switch weapon:fire
 *   ai:fire fx:explosion player:died player:spawn
 *   match:state match:killfeed match:callout match:objective match:end
 *   match:uav match:respawn
 * EVENTS OUT
 *   ui:deploy { weapon }   ui:restart   ui:pause { paused }
 */

const State = { LOADING: 'loading', TITLE: 'title', LIVE: 'live', PAUSE: 'pause', SUMMARY: 'summary' };

export class HudModule {
  constructor() {
    installStyles();

    // The HUD is constructed at registration time, before any init() runs, so
    // it can put the loading screen up before the generators start. If the host
    // page ever ships without #ui, make one rather than taking the boot down.
    let host = document.getElementById('ui');
    if (!host) {
      host = document.createElement('div');
      host.id = 'ui';
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:10';
      document.body.appendChild(host);
    }
    this.host = host;
    this.root = el('div.bl-root');
    host.appendChild(this.root);

    this.loading = new LoadingScreen(this.root);
    this.state = State.LOADING;

    // `?frontend=1` forces the menus on under automation, which is the only way
    // to inspect the front end from the capture harness.
    const params = new URLSearchParams(location.search);
    this.headless = (!!navigator.webdriver || params.has('nofrontend')) && !params.has('frontend');

    this._flash = 0;
    this._low = 0;
    this._suppress = 0;
    this._lastKiller = null;
    this._matchView = null;

    // `Engine.register()` assigns `module.engine` synchronously, before any
    // module's init() has run. That assignment is the only hook early enough to
    // report real boot progress, so it is intercepted here.
    let _engine = null;
    Object.defineProperty(this, 'engine', {
      configurable: true,
      get: () => _engine,
      set: (e) => { _engine = e; if (e) this.loading.attach(e); },
    });
  }

  /* ------------------------------------------------------------------ init */

  async init(engine) {
    this.hud = el('div.bl-hud');
    this.root.appendChild(this.hud);

    /* --- gameplay layer ---------------------------------------------------- */
    this.crosshair = new Crosshair(this.hud);
    this.damage = new DamageIndicators(this.hud);
    this.$flash = el('div.bl-flash'); this.hud.appendChild(this.$flash);
    this.$low = el('div.bl-lowhp'); this.hud.appendChild(this.$low);
    this.$suppress = el('div.bl-suppress'); this.hud.appendChild(this.$suppress);

    this.map = new Minimap(this.hud);
    this.compass = new Compass(this.hud);
    this.matchBar = new MatchBar(this.hud);
    this.vitals = new VitalsPanel(this.hud);
    this.ammo = new AmmoPanel(this.hud);
    this.killfeed = new Killfeed(this.hud);
    this.callouts = new Callouts(this.hud);
    this.objective = new ObjectiveStrip(this.hud);
    this.respawn = new RespawnOverlay(this.hud);
    // `debug-only` is the hook `setCaptureMode()` in main.js hides on: the FPS
    // readout is a development affordance and must never be photographed.
    this.$perf = el('div.bl-perf.debug-only'); this.hud.appendChild(this.$perf);
    this._capture = false;

    /* --- overlays ---------------------------------------------------------- */
    this.scoreboard = new Scoreboard(this.root);
    // A thunk, so the snapshot is only built on the frames the board repaints.
    this._boardThunk = () => engine.get('match')?.scoreboard?.();
    this.menus = new Menus(this.root, {
      onDeploy: () => this.deploy(),
      onResume: () => this.resume(),
      onRestart: () => { engine.bus.emit('ui:restart', {}); this.deploy(); },
      onWeapon: (id) => engine.get('weapons')?.switchTo(id),
      onSetting: (k, v) => engine.get('player')?.setSetting(k, v) ?? v,
      onQuality: (q) => this._setQuality(q, engine),
      onVolume: (bus, v) => engine.get('audio')?.setVolume?.(bus, v),
      getSettings: () => engine.get('player')?.settings || {},
      getVolumes: () => engine.get('audio')?.volumes?.() || {},
    });

    const weapons = engine.get('weapons');
    const table = weapons?.constructor?.WEAPONS;
    if (table) this.menus.setWeapons(table, weapons.current);

    /* --- minimap floorplan ------------------------------------------------- */
    const level = engine.get('level');
    const collision = engine.get('collision');
    this.map.build(collision?.collider || level?.collider, level?.bounds);

    this._bind(engine);
    this.crosshair.resize(engine.width, engine.height);

    // The harness gets the live HUD with no overlay; a human gets the title.
    if (this.headless) { this.state = State.LIVE; this.menus.hide(); }
    else engine.bus.once('engine:ready', () => this.showTitle());

    engine.hud = this;
  }

  /* ------------------------------------------------------------------ bind */

  _bind(engine) {
    const bus = engine.bus;

    bus.on('ui:pointerlock', ({ locked }) => {
      if (locked) {
        if (this.state === State.PAUSE || this.state === State.TITLE) this._enterLive();
      } else if (this.state === State.LIVE) {
        this.showPause();
      }
    });

    /* --- combat feedback --------------------------------------------------- */
    bus.on('hit:actor', ({ headshot }) => this.crosshair.hit(headshot ? 'head' : 'body'));
    bus.on('actor:killed', ({ by }) => { if (by === 'player') this.crosshair.hit('kill'); });

    bus.on('ui:damage', ({ angle, amount }) => {
      const s = engine.get('player')?.state;
      this.damage.add(angle, s ? s.yaw : 0, amount);
      this._flash = Math.min(1, this._flash + clamp(amount / 42, 0.22, 0.85));
    });

    bus.on('ui:vitals', (v) => { this._vitalsState = v; });

    // The capture harness photographs the presentation, not the instrumentation.
    bus.on('ui:capture', ({ capture }) => { this._capture = !!capture; });

    /* --- contacts on the map ----------------------------------------------- */
    bus.on('ai:fire', ({ origin }) => { if (origin) this.map.ping(origin.x, origin.z, 'contact', 2.8); });
    bus.on('fx:explosion', ({ position }) => { if (position) this.map.ping(position.x, position.z, 'explosion', 3.4); });

    /* --- weapon ------------------------------------------------------------ */
    bus.on('weapon:switch', ({ to }) => this.menus.selectWeapon(to));
    bus.on('ui:notify', ({ kind, text }) => {
      if (!text) return;
      this.callouts.push(text, '', kind === 'streak' ? 'streak' : '', 1.9);
    });

    /* --- match ------------------------------------------------------------- */
    bus.on('match:killfeed', (e) => this.killfeed.push(e));
    bus.on('match:callout', ({ title, sub, kind, dwell }) => this.callouts.push(title, sub, kind, dwell ?? 2.6));
    bus.on('match:objective', ({ text, sub, dwell }) => this.objective.set(text, sub, dwell));
    bus.on('match:uav', ({ active }) => this.map.setUav(active));
    bus.on('match:end', (summary) => this.showSummary(summary));
    bus.on('match:state', ({ state }) => {
      if (state === 'live' && this.state === State.SUMMARY) this._enterLive();
    });
    bus.on('player:died', ({ by }) => { this._lastKiller = labelFor(by); });

    /* --- keyboard ---------------------------------------------------------- */
    this._onKeyDown = (e) => {
      if (e.code === 'Tab') {
        e.preventDefault();
        if (this.state === State.LIVE) this.scoreboard.show(true);
      } else if (e.code === 'Escape') {
        // Pointer lock exit already fires 'ui:pointerlock'; this only covers the
        // path back out of a menu that is open without lock ever being taken.
        if (this.state === State.PAUSE) this.resume();
      } else if (e.code === 'Enter' && this.state === State.TITLE) {
        this.deploy();
      }
    };
    this._onKeyUp = (e) => { if (e.code === 'Tab') this.scoreboard.show(false); };
    this._onBlur = () => this.scoreboard.show(false);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  /* --------------------------------------------------------------- screens */

  showTitle() {
    if (this.headless) return;
    this.state = State.TITLE;
    this.hud.classList.add('bl-off');
    this.scoreboard.show(false);
    this.menus.showTitle();
    this.engine?.bus.emit('ui:pause', { paused: true });
  }

  showPause() {
    if (this.headless) return;
    this.state = State.PAUSE;
    this.hud.classList.add('bl-off');
    this.scoreboard.show(false);
    this.menus.showPause();
    this.engine?.bus.emit('ui:pause', { paused: true });
  }

  showSummary(summary) {
    this.state = State.SUMMARY;
    this._matchView = null;
    if (this.headless) return;
    this.hud.classList.add('bl-off');
    this.scoreboard.show(false);
    this.menus.showSummary(summary);
    document.exitPointerLock?.();
  }

  /** Leave the front end and take pointer lock. */
  deploy() {
    this.engine?.bus.emit('ui:deploy', { weapon: this.menus.weapon });
    this._enterLive();
    this._requestLock();
  }

  resume() {
    this._enterLive();
    this._requestLock();
  }

  _enterLive() {
    this.state = State.LIVE;
    this.menus.hide();
    this.hud.classList.remove('bl-off');
    this.engine?.bus.emit('ui:pause', { paused: false });
  }

  /**
   * Pointer lock is rate limited: a request made too soon after the user pressed
   * ESC is rejected. Swallow that and retry once, rather than leaving the player
   * in a live HUD with a dead mouse.
   */
  _requestLock() {
    const canvas = this.engine?.canvas;
    if (!canvas?.requestPointerLock) return;
    const attempt = () => {
      try {
        const p = canvas.requestPointerLock();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* rejected — the retry below covers it */ }
    };
    attempt();
    clearTimeout(this._lockRetry);
    this._lockRetry = setTimeout(() => {
      if (this.state === State.LIVE && document.pointerLockElement !== canvas) attempt();
    }, 1250);
  }

  _setQuality(tier, engine) {
    if (Config.quality === tier) return;
    Config.quality = tier;
    engine.bus.emit('ui:notify', { kind: 'system', text: `QUALITY · ${tier.toUpperCase()}` });
    // Modules that size render targets from the tier re-read them on resize.
    // Another agent's resize path throwing must not take the menu down with it.
    try { engine._onResize?.(); } catch (err) { console.warn('[HUD] quality resize failed', err); }
  }

  /* --------------------------------------------------------------- perframe */

  update(dt, engine) {
    const player = engine.get('player');
    const weapons = engine.get('weapons');
    const match = engine.get('match');
    if (!player) return;
    const s = player.state;

    /* --- reticle ----------------------------------------------------------- */
    if (weapons?.def) {
      const hidden = s.sprinting || weapons.reloading || !s.alive || weapons._switching
        || this.state !== State.LIVE;
      this.crosshair.update(dt, {
        spread: weapons.spread,
        fovY: engine.camera.fov,
        height: engine.height,
        ads: weapons._adsBlend,
        hidden,
        obstructed: s.sprinting,
      });
    }
    this.damage.update(dt, s.yaw);

    /* --- screen states ----------------------------------------------------- */
    this._flash = Math.max(0, this._flash - dt * 1.9);
    setOpacity(this.$flash, this._flash);

    const v = this._vitalsState;
    this._low = damp(this._low, v ? v.low : 0, 4, dt);
    // Low-health rim pulses with the same heartbeat Vitals is driving audio from.
    const beat = 0.82 + 0.18 * Math.sin(engine.elapsed * (5.6 + this._low * 5));
    setOpacity(this.$low, this._low * beat);
    this._suppress = damp(this._suppress, v ? v.suppression : 0, 6, dt);
    setOpacity(this.$suppress, this._suppress * 0.75);

    /* --- panels ------------------------------------------------------------ */
    this.vitals.update(dt, s, v);
    if (weapons) this.ammo.update(dt, weapons);
    this.compass.update(s.yaw);
    this.killfeed.update(dt);
    this.callouts.update(dt);
    // The objective is a timed card now, so it needs a clock of its own.
    this.objective.update(dt);

    const mv = match?.view?.();
    if (mv) {
      this._matchView = mv;
      this.matchBar.update(mv);
      this.respawn.update(!s.alive && mv.respawnIn > 0, mv.respawnIn, this._lastKiller);
      this.map.setUav(!!mv.uavActive);
    }

    this.map.update(dt, {
      position: s.position,
      yaw: s.yaw,
      alive: s.alive,
      actors: engine.get('ai')?.actors,
      allies: mv?.allyPositions,
      uavActive: !!mv?.uavActive,
    });

    this.scoreboard.update(dt, this._boardThunk);

    if (!this._capture && engine.frame % 20 === 0) {
      this.$perf.textContent = `${engine.perf.fps.toFixed(0)} FPS · ${engine.perf.smoothMs.toFixed(1)} MS`;
    }
  }

  resize(w, h) {
    this.map?._resize();
    this.crosshair?.resize(w, h);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    clearTimeout(this._lockRetry);
    this.map?.dispose();
    this.root?.remove();
  }
}

function setOpacity(node, value) {
  const v = value < 0.004 ? 0 : Math.min(1, value);
  const s = v.toFixed(3);
  if (node.style.opacity !== s) node.style.opacity = s;
}

function labelFor(by) {
  if (!by) return null;
  if (typeof by === 'string' && by.startsWith('bot')) return `HOSTILE ${by.slice(3).padStart(2, '0')}`;
  if (by === 'fall') return 'THE FALL';
  return String(by).toUpperCase();
}
