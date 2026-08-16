import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { Config } from './Config.js';

/**
 * ============================================================================
 *  MODULE CONTRACT  —  read this before touching any subsystem.
 * ============================================================================
 *  Every subsystem is a class registered with `engine.register(name, module)`.
 *  A module may implement any of these optional hooks:
 *
 *    async init(engine)      Called once, in registration order, before the
 *                            first frame. May load/generate assets. Modules
 *                            may read `engine.get('otherModule')` here, but
 *                            only for modules registered BEFORE them.
 *    fixedUpdate(dt, engine) Called at a fixed 120 Hz (accumulator driven).
 *                            All physics/simulation belongs here.
 *    update(dt, engine)      Called once per rendered frame, variable dt.
 *                            Animation, camera, UI, audio panning.
 *    lateUpdate(dt, engine)  After update, before render. Camera shake, IK.
 *    render(engine)          Only the render module implements this.
 *    resize(w, h, engine)    Viewport changed (CSS pixels).
 *    dispose()               Free GPU resources.
 *
 *  Shared, engine-owned state (do NOT recreate these in a module):
 *    engine.scene            THREE.Scene — the world
 *    engine.camera           THREE.PerspectiveCamera — the player view
 *    engine.viewmodelScene   THREE.Scene — first-person arms/weapon, drawn
 *                            with a separate near-clip camera over the world
 *    engine.viewmodelCamera  THREE.PerspectiveCamera
 *    engine.bus              EventBus — cross-module signalling
 *    engine.clock            elapsed/delta timing
 *    engine.frame            monotonically increasing frame index
 *
 *  Cross-module communication is via `engine.bus` ONLY. Canonical events:
 *    'player:spawn'    { position, yaw }
 *    'player:died'     { by, position }
 *    'player:damaged'  { amount, from, direction }
 *    'weapon:fire'     { weapon, origin, direction, seed }
 *    'weapon:reload'   { weapon, phase }
 *    'weapon:switch'   { from, to }
 *    'hit:surface'     { point, normal, material, impulse }
 *    'hit:actor'       { actor, point, normal, damage, headshot }
 *    'actor:killed'    { actor, by, headshot }
 *    'fx:explosion'    { position, radius, power }
 *    'audio:play'      { id, position, volume, pitch }
 *    'ui:notify'       { kind, text }
 *    'match:state'     { state }
 * ============================================================================
 */
export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.bus = new EventBus();
    this.config = Config;

    this.scene = new THREE.Scene();
    this.scene.name = 'World';

    this.camera = new THREE.PerspectiveCamera(
      Config.camera.fovBase, 1, Config.camera.near, Config.camera.far
    );
    this.camera.name = 'PlayerCamera';
    this.camera.rotation.order = 'YXZ';

    this.viewmodelScene = new THREE.Scene();
    this.viewmodelScene.name = 'Viewmodel';
    this.viewmodelCamera = new THREE.PerspectiveCamera(
      Config.camera.viewmodelFov, 1, 0.005, 12
    );
    this.viewmodelCamera.rotation.order = 'YXZ';

    this._modules = new Map();
    this._order = [];

    this.frame = 0;
    this.elapsed = 0;
    this.delta = 0;
    this.running = false;

    this._fixedStep = 1 / 120;
    this._accumulator = 0;
    this._last = 0;
    this._maxFrameTime = 0.25;

    this.width = 1;
    this.height = 1;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    /** Rolling perf telemetry used by the adaptive-resolution controller. */
    this.perf = { fps: 60, frameMs: 16.7, smoothMs: 16.7, gpuBoundHint: 0 };

    this._onResize = this._onResize.bind(this);
    this._tick = this._tick.bind(this);
    window.addEventListener('resize', this._onResize, { passive: true });
  }

  register(name, module) {
    if (this._modules.has(name)) throw new Error(`Module "${name}" already registered`);
    this._modules.set(name, module);
    this._order.push({ name, module });
    module.engine = this;
    return module;
  }

  get(name) {
    return this._modules.get(name) || null;
  }

  has(name) { return this._modules.has(name); }

  async init() {
    this._onResize();
    for (const { name, module } of this._order) {
      if (typeof module.init === 'function') {
        const t0 = performance.now();
        await module.init(this);
        const ms = performance.now() - t0;
        if (ms > 60) console.info(`[Engine] ${name}.init() ${ms.toFixed(0)}ms`);
      }
    }
    this.bus.emit('engine:ready', this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now() / 1000;
    requestAnimationFrame(this._tick);
  }

  stop() { this.running = false; }

  _onResize() {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.width = w; this.height = h;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    const aspect = w / h;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewmodelCamera.aspect = aspect;
    this.viewmodelCamera.updateProjectionMatrix();

    for (const { module } of this._order) {
      if (typeof module.resize === 'function') module.resize(w, h, this);
    }
  }

  _tick(nowMs) {
    if (!this.running) return;
    requestAnimationFrame(this._tick);

    const now = nowMs / 1000;
    let dt = now - this._last;
    this._last = now;
    if (dt > this._maxFrameTime) dt = this._maxFrameTime;
    this.delta = dt;
    this.elapsed += dt;
    this.frame++;

    // --- fixed-step simulation -------------------------------------------
    this._accumulator += dt;
    let steps = 0;
    while (this._accumulator >= this._fixedStep && steps < 8) {
      for (const { module } of this._order) {
        if (typeof module.fixedUpdate === 'function') module.fixedUpdate(this._fixedStep, this);
      }
      this._accumulator -= this._fixedStep;
      steps++;
    }
    if (steps >= 8) this._accumulator = 0; // bail out of a death spiral

    // --- variable-step update --------------------------------------------
    for (const { module } of this._order) {
      if (typeof module.update === 'function') module.update(dt, this);
    }
    for (const { module } of this._order) {
      if (typeof module.lateUpdate === 'function') module.lateUpdate(dt, this);
    }

    // --- present ----------------------------------------------------------
    for (const { module } of this._order) {
      if (typeof module.render === 'function') module.render(this);
    }

    const frameMs = (performance.now() / 1000 - now) * 1000;
    this.perf.frameMs = frameMs;
    this.perf.smoothMs += (dt * 1000 - this.perf.smoothMs) * 0.06;
    this.perf.fps = 1000 / Math.max(1e-3, this.perf.smoothMs);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    for (const { module } of this._order) {
      if (typeof module.dispose === 'function') module.dispose();
    }
    this._modules.clear();
    this._order.length = 0;
    this.bus.clear();
  }
}
