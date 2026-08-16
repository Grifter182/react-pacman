import { Config } from '../core/Config.js';

/**
 * OWNER: player-feel agent.
 *
 * Every source of player intent — keyboard, mouse, gamepad — normalised into
 * one frame-stable snapshot the controller reads. Nothing downstream ever asks
 * "which device did this come from".
 *
 * Two things make this more than a key-state Set:
 *
 *  1. **Look is accumulated, not sampled.** Pointer events fire at the mouse's
 *     report rate (often 500-1000 Hz), which is faster than the render loop and
 *     *slower* than the 120 Hz fixed step. Deltas are summed into `lookDx/Dy`
 *     and drained once per frame, so no motion is ever dropped or double
 *     counted regardless of how the two rates interleave.
 *  2. **Actions are edge-triggered.** `pressed()` reports the rising edge only
 *     and stays true for the whole frame it happened in, so a fixed step that
 *     runs zero or four times still sees exactly one jump.
 *
 * Settings (sensitivity, FOV, invert, deadzone, gamepad response) live here,
 * persist to localStorage, and are mirrored into `Config` so the modules that
 * already read `Config.input.sensitivity` keep working untouched.
 */

const STORE_KEY = 'blackout.input.v1';

export const DEFAULT_SETTINGS = {
  sensitivity: 0.0022,     // radians per raw pointer count
  adsSensScale: 0.72,      // multiplier while aiming (per-optic scaling on top)
  invertY: false,
  fov: 80,                 // vertical-equivalent base FOV, degrees
  viewmodelFov: 55,
  padLookSpeed: 3.1,       // radians/second at full stick
  padCurve: 2.2,           // exponent of the response curve (>1 = fine centre)
  padDeadzone: 0.16,
  padAssistScale: 1.0,     // slow-down factor multiplier near a target
  bobScale: 1.0,
  shakeScale: 1.0,
};

/** Actions the controller asks about by name, not by key code. */
const BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  use: ['KeyE'],
};

export class InputMap {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this._load();

    this.keys = new Set();          // legacy-compatible raw key set
    this._edge = new Set();         // codes that went down this frame
    this._consumed = new Set();

    this.lookDx = 0;
    this.lookDy = 0;
    this.moveX = 0;                 // -1..1 strafe (right positive)
    this.moveY = 0;                 // -1..1 forward (forward positive)
    this.pointerLocked = false;

    this.pad = null;
    this.padIndex = -1;
    this._padPrev = new Uint8Array(20);
    this._padEdge = new Uint8Array(20);
    this._padAxes = [0, 0, 0, 0];
    this.usingPad = false;

    this.fireHeld = false;
    this.adsHeld = false;
  }

  /* ------------------------------------------------------------- settings */

  _load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(this.settings, JSON.parse(raw));
    } catch { /* private mode / disabled storage — defaults are fine */ }
    this._applyToConfig();
  }

  _save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
  }

  _applyToConfig() {
    const s = this.settings;
    Config.input.sensitivity = s.sensitivity;
    Config.input.adsSensScale = s.adsSensScale;
    Config.input.invertY = s.invertY;
    Config.camera.fovBase = s.fov;
    Config.camera.viewmodelFov = s.viewmodelFov;
  }

  /** Set one setting, clamped to a sane range, persisted, mirrored to Config. */
  set(key, value) {
    if (!(key in this.settings)) return this.settings[key];
    const lim = LIMITS[key];
    if (typeof value === 'number' && lim) value = Math.max(lim[0], Math.min(lim[1], value));
    this.settings[key] = value;
    this._applyToConfig();
    this._save();
    return value;
  }

  /* ----------------------------------------------------------------- bind */

  bind(engine) {
    this.engine = engine;
    const canvas = engine.canvas;

    this._onKeyDown = (e) => {
      const k = e.code;
      if (!this.keys.has(k)) this._edge.add(k);
      this.keys.add(k);
      this.usingPad = false;
      if (k === 'Space' || k.startsWith('Arrow')) e.preventDefault();
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); };
    this._onBlur = () => { this.keys.clear(); this.fireHeld = this.adsHeld = false; };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);

    canvas.addEventListener('click', () => {
      if (!this.pointerLocked) canvas.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
      // Losing the pointer must release every held input through the same path
      // a real release takes, or the weapon module keeps firing at a menu.
      if (!this.pointerLocked) { this._setFire(false); this._setAds(false); this.keys.clear(); }
      engine.bus.emit('ui:pointerlock', { locked: this.pointerLocked });
    });

    this._onMove = (e) => {
      if (!this.pointerLocked) return;
      this.usingPad = false;
      // Raw counts: sensitivity and the ADS scale are applied at drain time so
      // a mid-flick ADS transition cannot double-scale part of the movement.
      this.lookDx += e.movementX || 0;
      this.lookDy += e.movementY || 0;
    };
    window.addEventListener('mousemove', this._onMove);

    this._onDown = (e) => {
      if (!this.pointerLocked) return;
      if (e.button === 0) this._setFire(true);
      if (e.button === 2) this._setAds(true);
    };
    this._onUp = (e) => {
      if (e.button === 0) this._setFire(false);
      if (e.button === 2) this._setAds(false);
    };
    window.addEventListener('mousedown', this._onDown);
    window.addEventListener('mouseup', this._onUp);
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('gamepadconnected', (e) => {
      this.padIndex = e.gamepad.index;
      engine.bus.emit('ui:notify', { kind: 'input', text: 'GAMEPAD CONNECTED' });
    });
    window.addEventListener('gamepaddisconnected', () => { this.padIndex = -1; this.pad = null; });
  }

  _setFire(down) {
    if (this.fireHeld === down) return;
    this.fireHeld = down;
    this.engine.bus.emit('input:fire', { down });
  }

  _setAds(down) {
    if (this.adsHeld === down) return;
    this.adsHeld = down;
    this.engine.bus.emit('input:ads', { down });
  }

  /** Weapon controls live on window keydown; synthesise them for the pad. */
  _synthKey(code) {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
  }

  /* ---------------------------------------------------------------- frame */

  /**
   * Called once per rendered frame, before any consumer. Polls the gamepad,
   * folds stick look into the pending mouse delta, and resolves the movement
   * axes. Edge sets are cleared by `endFrame`.
   */
  beginFrame(dt) {
    this._pollPad(dt);
    this.syncAxes();
  }

  /**
   * Resolve the movement axes from whatever the devices currently say. Cheap
   * enough to call from the fixed step as well as the frame, which is what
   * keeps the controller from running a frame behind the stick.
   */
  syncAxes() {
    const kx = (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0);
    const ky = (this.down('forward') ? 1 : 0) - (this.down('back') ? 1 : 0);

    let mx = kx, my = ky;
    if (this.pad) {
      const ax = deadzone(this._padAxes[0], this.settings.padDeadzone);
      const ay = deadzone(this._padAxes[1], this.settings.padDeadzone);
      if (Math.abs(ax) + Math.abs(ay) > 0) { mx = ax; my = -ay; this.usingPad = true; }
    }
    // Diagonals must not be faster than cardinals, but a half-tilted stick must
    // stay a half-tilted stick: clamp the magnitude instead of normalising it.
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    this.moveX = mx; this.moveY = my;
  }

  endFrame() {
    this._edge.clear();
    this._consumed.clear();
    this._padEdge.fill(0);
  }

  /**
   * Drain the accumulated look delta as radians.
   * @param adsBlend 0..1, scales sensitivity toward the ADS setting.
   * @param zoomScale extra scale from the optic's magnification.
   */
  drainLook(adsBlend = 0, zoomScale = 1) {
    const s = this.settings;
    const sens = s.sensitivity * lerp(1, s.adsSensScale, adsBlend) * zoomScale;
    const yaw = -this.lookDx * sens;
    const pitch = -this.lookDy * sens * (s.invertY ? -1 : 1);
    this.lookDx = 0; this.lookDy = 0;
    return { yaw, pitch };
  }

  down(action) {
    const codes = BINDINGS[action];
    if (codes) for (const c of codes) if (this.keys.has(c)) return true;
    return this._padDown(action);
  }

  /**
   * Rising edge, consumed on read. The fixed step can run up to eight times per
   * frame; without consumption a single jump press would be seen eight times.
   */
  pressed(action) {
    const codes = BINDINGS[action];
    if (codes) {
      for (const c of codes) {
        if (this._edge.has(c)) { this._edge.delete(c); return true; }
      }
    }
    return this._padPressed(action);
  }

  /* -------------------------------------------------------------- gamepad */

  _pollPad(dt) {
    if (this.padIndex < 0 || !navigator.getGamepads) { this.pad = null; return; }
    const pads = navigator.getGamepads();
    const p = pads && pads[this.padIndex];
    if (!p || !p.connected) { this.pad = null; return; }
    this.pad = p;

    for (let i = 0; i < 4; i++) this._padAxes[i] = p.axes[i] ?? 0;

    for (let i = 0; i < this._padPrev.length; i++) {
      const b = p.buttons[i];
      const now = b ? (b.pressed ? 1 : 0) : 0;
      if (now && !this._padPrev[i]) this._padEdge[i] = 1;
      this._padPrev[i] = now;
    }

    // Triggers are analogue on every standard-mapping pad; treat >45% as held
    // so a light pull aims but does not fire.
    const rt = p.buttons[7] ? p.buttons[7].value : 0;
    const lt = p.buttons[6] ? p.buttons[6].value : 0;
    if (rt > 0.45 || lt > 0.2) this.usingPad = true;
    if (this.pointerLocked || this.usingPad) {
      this._setFire(rt > 0.45);
      this._setAds(lt > 0.35);
    }

    if (this._padEdge[2]) this._synthKey('KeyR');      // X / square: reload
    if (this._padEdge[3]) this._synthKey('Digit2');    // Y / triangle: swap
    if (this._padEdge[9]) this._synthKey('KeyX');      // start: fire mode

    // Right stick look. A power curve gives a wide precision zone at the centre
    // and full turn rate at the rim; the result is converted into the same raw
    // "pointer count" space the mouse uses so downstream code sees one signal.
    const rx = deadzone(this._padAxes[2], this.settings.padDeadzone);
    const ry = deadzone(this._padAxes[3], this.settings.padDeadzone);
    if (rx || ry) {
      this.usingPad = true;
      const c = this.settings.padCurve;
      const sx = Math.sign(rx) * Math.pow(Math.abs(rx), c);
      const sy = Math.sign(ry) * Math.pow(Math.abs(ry), c);
      const rad = this.settings.padLookSpeed * dt;
      const toCounts = 1 / Math.max(1e-6, this.settings.sensitivity);
      this.lookDx += -sx * rad * toCounts;
      this.lookDy += -sy * rad * toCounts * (this.settings.invertY ? -1 : 1);
    }
  }

  _padDown(action) {
    const p = this.pad;
    if (!p) return false;
    switch (action) {
      case 'jump': return !!p.buttons[0]?.pressed;
      case 'crouch': return !!p.buttons[1]?.pressed || !!p.buttons[10]?.pressed;
      case 'sprint': return !!p.buttons[11]?.pressed;
      case 'use': return !!p.buttons[4]?.pressed;
      default: return false;
    }
  }

  _padPressed(action) {
    const take = (i) => { if (this._padEdge[i]) { this._padEdge[i] = 0; return true; } return false; };
    switch (action) {
      case 'jump': return take(0);
      case 'crouch': return take(1) || take(10);
      case 'prone': return take(5);
      case 'use': return take(4);
      default: return false;
    }
  }

  /** Rumble, when the pad supports it. Silently no-ops otherwise. */
  rumble(strong = 0.4, weak = 0.2, ms = 120) {
    const act = this.pad?.vibrationActuator;
    if (!act || typeof act.playEffect !== 'function') return;
    act.playEffect('dual-rumble', {
      startDelay: 0, duration: ms,
      strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak),
    }).catch(() => {});
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('mousemove', this._onMove);
    window.removeEventListener('mousedown', this._onDown);
    window.removeEventListener('mouseup', this._onUp);
  }
}

const LIMITS = {
  sensitivity: [0.0002, 0.02],
  adsSensScale: [0.1, 2],
  fov: [60, 120],
  viewmodelFov: [35, 90],
  padLookSpeed: [0.5, 8],
  padCurve: [1, 4],
  padDeadzone: [0, 0.5],
  padAssistScale: [0, 2],
  bobScale: [0, 2],
  shakeScale: [0, 2],
};

function deadzone(v, dz) {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  // Rescale so the axis still reaches 1.0 at the rim after the dead zone is
  // removed — otherwise a large dead zone quietly costs you top turn rate.
  return Math.sign(v) * (a - dz) / (1 - dz);
}

function lerp(a, b, t) { return a + (b - a) * t; }
