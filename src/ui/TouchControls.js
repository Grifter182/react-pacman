import { el } from './Dom.js';

/**
 * Touch controls for phones and tablets.
 *
 * WHY THIS IS NOT JUST "BUTTONS ON THE SCREEN". A shooter needs two analogue
 * axes at once — move and look — plus fire, and a thumb cannot chase a fixed
 * pad. So:
 *
 *   - The move stick is FLOATING. It materialises wherever the left thumb
 *     lands and recentres there, which is what makes a stick usable without
 *     looking at it. A fixed stick means the thumb drifts off it within
 *     seconds and the player walks into a wall.
 *   - Look is a DRAG ANYWHERE on the right half, not a second stick. Relative
 *     dragging matches how the mouse path already works, so it feeds the exact
 *     same `addLook()` the desktop path uses and inherits its sensitivity,
 *     smoothing and ADS scaling for free.
 *   - Fire is a HOLD, and it does not steal the look drag: the same finger can
 *     hold fire and keep aiming, because the fire button reports its own
 *     pointer id and the look handler ignores only that id.
 *
 * Every control is pointer-id tracked, so two thumbs never fight over one
 * gesture and losing a finger off the edge of the screen cannot leave an input
 * stuck on — which is the single most common way touch shooters break.
 *
 * The whole layer is inert unless the device actually has a coarse pointer, so
 * desktop is untouched.
 */

const LOOK_SENS = 1.35;      // multiplier over mouse sensitivity; thumbs travel less than a mouse

export class TouchControls {
  constructor(parent, engine) {
    this.engine = engine;
    this.enabled = false;
    this.node = null;

    // A hybrid laptop with a touchscreen should still get mouse + keyboard, so
    // the test is "coarse pointer AND no hover", not "touch events exist".
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    const noHover = window.matchMedia?.('(hover: none)').matches;
    const forced = new URLSearchParams(location.search).has('touch');
    if (!((coarse && noHover) || forced)) return;

    this.enabled = true;
    this._build(parent);
    this._bind();
  }

  _build(parent) {
    this.node = el('div.bl-touch');
    // THE HIT SURFACE MUST BE A REAL ELEMENT.
    //
    // `.bl-touch` is `pointer-events: none` so the HUD never eats taps, and the
    // stick/look handlers were bound to it — which meant they never fired at
    // all, because an element with `pointer-events: none` does not receive
    // pointer events, they pass through to the canvas. The buttons worked
    // (they are children with `pointer-events: auto`) while moving and looking
    // were completely dead, with nothing on screen to explain why.
    //
    // This surface is full-screen, transparent, and explicitly hit-testable.
    // It is the FIRST child so the button clusters stack above it, and they
    // stopPropagation, so a thumb on a button never also drags the view.
    this.node.innerHTML = `
      <div class="tc-surface" id="tc-surface"></div>
      <div class="tc-stick" id="tc-stick"><i class="ring"></i><i class="knob"></i></div>
      <div class="tc-right">
        <button class="tc-btn tc-fire" id="tc-fire" aria-label="Fire"></button>
        <button class="tc-btn tc-ads" id="tc-ads" aria-label="Aim">ADS</button>
      </div>
      <div class="tc-top">
        <button class="tc-btn" id="tc-menu" aria-label="Menu">MENU</button>
      </div>
      <div class="tc-left-btns">
        <button class="tc-btn tc-sm" id="tc-jump" aria-label="Jump">JUMP</button>
        <button class="tc-btn tc-sm" id="tc-crouch" aria-label="Crouch">CROUCH</button>
        <button class="tc-btn tc-sm" id="tc-reload" aria-label="Reload">RELOAD</button>
      </div>`;
    parent.appendChild(this.node);

    this.$surface = this.node.querySelector('#tc-surface');
    this.$stick = this.node.querySelector('#tc-stick');
    this.$knob = this.node.querySelector('.knob');
    this.$fire = this.node.querySelector('#tc-fire');
    this.$ads = this.node.querySelector('#tc-ads');

    this.move = { x: 0, y: 0 };
    this._stickId = null;
    this._lookId = null;
    this._stickOrigin = { x: 0, y: 0 };
    this._lastLook = { x: 0, y: 0 };
    this._adsLatched = false;
  }

  _bind() {
    const input = this.engine.get('player')?.input;
    const bus = this.engine.bus;
    const half = () => window.innerWidth * 0.5;

    /* --- movement: floating stick on the left half ----------------------- */
    const stickStart = (e) => {
      if (this._stickId !== null || e.clientX > half()) return;
      this._stickId = e.pointerId;
      this._stickOrigin = { x: e.clientX, y: e.clientY };
      this.$stick.style.left = `${e.clientX}px`;
      this.$stick.style.top = `${e.clientY}px`;
      this.$stick.classList.add('on');
      this._stickMove(e);
    };
    const stickEnd = (id) => {
      if (this._stickId !== id) return;
      this._stickId = null;
      this.move.x = this.move.y = 0;
      this.$stick.classList.remove('on');
      this.$knob.style.transform = 'translate(-50%, -50%)';
    };

    /* --- look: relative drag on the right half --------------------------- */
    const lookStart = (e) => {
      if (this._lookId !== null || e.clientX <= half()) return;
      if (e.target.closest?.('.tc-btn')) return;   // buttons own their own gesture
      this._lookId = e.pointerId;
      this._lastLook = { x: e.clientX, y: e.clientY };
    };

    this._onDown = (e) => { stickStart(e); lookStart(e); };
    this._onMove = (e) => {
      if (e.pointerId === this._stickId) { this._stickMove(e); return; }
      if (e.pointerId === this._lookId) {
        const dx = e.clientX - this._lastLook.x;
        const dy = e.clientY - this._lastLook.y;
        this._lastLook = { x: e.clientX, y: e.clientY };
        // Feed the same accumulator the mouse uses, so sensitivity, ADS
        // scaling and smoothing all behave identically.
        input?.addLook?.(dx * LOOK_SENS, dy * LOOK_SENS);
      }
    };
    // pointercancel matters as much as pointerup: the browser steals the
    // pointer on scroll, notification pull-down and app switch, and without
    // this the player keeps walking after their thumb is gone.
    this._onUp = (e) => {
      stickEnd(e.pointerId);
      if (e.pointerId === this._lookId) this._lookId = null;
    };

    const opts = { passive: false };
    this.$surface.addEventListener('pointerdown', this._onDown, opts);
    window.addEventListener('pointermove', this._onMove, opts);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);

    /* --- action buttons --------------------------------------------------- */
    const hold = (node, down, up) => {
      let id = null;
      node.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        id = e.pointerId; node.classList.add('down'); down();
      }, opts);
      const release = (e) => {
        if (id === null || (e && e.pointerId !== id)) return;
        id = null; node.classList.remove('down'); up();
      };
      node.addEventListener('pointerup', release);
      node.addEventListener('pointercancel', release);
      window.addEventListener('pointerup', release);
    };

    hold(this.$fire, () => bus.emit('input:fire', { down: true }),
      () => bus.emit('input:fire', { down: false }));

    // ADS is a toggle on touch. Holding a second thumb down for the whole
    // engagement is not something a phone player can do while also moving and
    // looking, so aiming latches until it is tapped off.
    this.$ads.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      this._adsLatched = !this._adsLatched;
      this.$ads.classList.toggle('down', this._adsLatched);
      bus.emit('input:ads', { down: this._adsLatched });
    }, opts);

    const key = (code, down) => window.dispatchEvent(
      new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
    hold(this.node.querySelector('#tc-jump'), () => key('Space', true), () => key('Space', false));
    hold(this.node.querySelector('#tc-crouch'), () => key('ControlLeft', true), () => key('ControlLeft', false));
    this.node.querySelector('#tc-reload').addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      key('KeyR', true); setTimeout(() => key('KeyR', false), 40);
    }, opts);

    // The pause menu is normally reached by releasing pointer lock, which a
    // phone never takes. Go through the HUD's own screen transition rather than
    // synthesising Escape, because that path also drops the held inputs, stops
    // the match clock and puts the HUD in the right state.
    this.node.querySelector('#tc-menu').addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      // Release everything first: a menu that opens with fire still latched
      // leaves the weapon firing behind it.
      stickEnd(this._stickId);
      this._lookId = null;
      if (this._adsLatched) {
        this._adsLatched = false;
        this.$ads.classList.remove('down');
        bus.emit('input:ads', { down: false });
      }
      bus.emit('input:fire', { down: false });
      this.$fire.classList.remove('down');
      this.engine.get('hud')?.showPause?.();
    }, opts);
  }

  _stickMove(e) {
    const R = 54;
    let dx = e.clientX - this._stickOrigin.x;
    let dy = e.clientY - this._stickOrigin.y;
    const len = Math.hypot(dx, dy);
    if (len > R) { dx *= R / len; dy *= R / len; }
    this.$knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    // Dead zone stops a resting thumb from creeping the player forward, and
    // the remaining travel is rescaled to the full 0..1 range so the stick
    // still reaches walk speed at the edge rather than topping out short.
    const dead = 0.18;
    const mag = Math.min(1, len / R);
    const scaled = mag < dead ? 0 : (mag - dead) / (1 - dead);
    const gain = mag > 1e-3 ? scaled / mag : 0;
    this.move.x = (dx / R) * gain;
    this.move.y = (dy / R) * gain;
  }

  /** Called by InputMap each frame; returns -1..1 axes, screen convention. */
  axes() {
    return this.enabled ? this.move : null;
  }

  dispose() {
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    this.node?.remove();
  }
}
