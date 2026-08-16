import { el, frag, clamp, damp } from './Dom.js';

/**
 * OWNER: UI/UX agent.
 *
 * Reticle and hit feedback.
 *
 * THE GAP IS NOT A GUESS. `AccuracyModel.spread()` returns the cone half-angle
 * in radians for the shot that is about to leave the barrel. A point at that
 * angle off the optical axis lands at
 *
 *      px = tan(theta) / tan(fovY / 2) * (viewportHeight / 2)
 *
 * pixels from screen centre, so the blades sit exactly on the circle the rounds
 * can fall inside. Move, jump, crouch, spray or let the weapon settle and the
 * reticle reports it, because it is reading the same number the bullet does.
 *
 * The gap is damped rather than tracked instantly: the spread value steps on
 * every shot, and a reticle that steps with it strobes. 26/s upward and 12/s
 * downward keeps the bloom legible while the recovery stays readable.
 */
export class Crosshair {
  constructor(parent) {
    this.node = frag(`
      <div class="bl-xh">
        <b class="t"></b><b class="b"></b><b class="l"></b><b class="r"></b><b class="dot"></b>
      </div>`);
    parent.appendChild(this.node);

    this.hm = frag(`
      <div class="bl-hm">
        <i></i><i></i><i></i><i></i>
        <span class="bl-x"><b></b><b></b></span>
      </div>`);
    parent.appendChild(this.hm);

    this._gap = 9;
    this._alpha = 1;
    this._hit = 0;          // 0..1 hitmarker life
    this._hitKind = '';
    this._pendingKind = '';
    this._lastGap = -1;
    this._lastAlpha = -1;
  }

  /**
   * @param kind 'body' | 'head' | 'kill'
   * Escalation only: a kill marker never gets downgraded to a body marker by a
   * second pellet landing in the same frame.
   */
  hit(kind) {
    const rank = { body: 0, head: 1, kill: 2 };
    if (this._hit > 0 && rank[kind] <= rank[this._hitKind]) {
      this._hit = Math.max(this._hit, kind === 'kill' ? 1 : 0.85);
      return;
    }
    this._hitKind = kind;
    this._hit = 1;
    this.hm.className = `bl-hm ${kind === 'head' ? 'bl-head' : kind === 'kill' ? 'bl-kill' : ''}`;
  }

  /**
   * @param spread  cone half-angle in radians (from the weapons module)
   * @param fovY    camera vertical FOV in degrees
   * @param height  viewport height in CSS pixels
   * @param ads     0..1 aim blend — the reticle yields to the optic
   * @param hidden  true while sprinting / reloading / dead
   */
  update(dt, { spread, fovY, height, ads, hidden, obstructed }) {
    const half = Math.tan((fovY * Math.PI) / 360);
    const px = half > 1e-5 ? (Math.tan(spread) / half) * (height * 0.5) : 0;
    // A floor of 4px: below that the four blades collapse into the dot and the
    // reticle stops communicating anything at all.
    const target = clamp(px, 4, height * 0.42);
    this._gap = damp(this._gap, target, target > this._gap ? 26 : 12, dt);

    const aTarget = hidden ? 0 : (1 - ads * 0.92);
    this._alpha = damp(this._alpha, aTarget, 14, dt);

    // Two style writes per frame, and only when the rounded value moved.
    const g = Math.round(this._gap * 10) / 10;
    if (g !== this._lastGap) { this.node.style.setProperty('--gap', `${g}px`); this._lastGap = g; }
    const a = Math.round(this._alpha * 100) / 100;
    if (a !== this._lastAlpha) { this.node.style.setProperty('--a', a); this._lastAlpha = a; }
    this.node.classList.toggle('bl-idle', !!obstructed);

    /* --- hitmarker ------------------------------------------------------- */
    if (this._hit > 0) {
      const life = this._hitKind === 'kill' ? 2.6 : 4.6;    // 1/seconds
      this._hit = Math.max(0, this._hit - dt * life);
      const k = this._hit;
      // Snap in, ease out: the marker punches to full size in one frame and
      // relaxes outward, which is what makes a hit read as an impact.
      const scale = 1.34 - 0.34 * k;
      this.hm.style.opacity = String(Math.min(1, k * 1.9));
      this.hm.style.transform = `translate(-50%,-50%) scale(${scale.toFixed(3)})`;
    } else if (this.hm.style.opacity !== '0') {
      this.hm.style.opacity = '0';
    }
  }

  setVisible(v) { this.node.style.display = v ? '' : 'none'; this.hm.style.display = v ? '' : 'none'; }
}

/**
 * Directional damage arcs. Eight pooled wedges, each an SVG arc rotated to the
 * bearing the shot came from; nothing is created after construction.
 *
 * The bearing is delivered by Vitals as a signed angle relative to the view, so
 * the wedge only has to be rotated — it stays correct while the player turns
 * because a *new* indicator is issued per hit, and older ones are world-locked
 * by storing their world bearing and re-deriving screen angle each frame.
 */
export class DamageIndicators {
  constructor(parent) {
    this.wrap = el('div.bl-dmgwrap');
    // One gradient definition shared by every wedge.
    this.wrap.innerHTML = `<svg width="0" height="0" style="position:absolute"><defs>
      <linearGradient id="bl-dmg-grad" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="rgba(255,70,48,0)"/>
        <stop offset="55%" stop-color="rgba(255,74,50,.55)"/>
        <stop offset="100%" stop-color="rgba(255,150,120,.95)"/>
      </linearGradient></defs></svg>`;
    parent.appendChild(this.wrap);

    this.pool = [];
    for (let i = 0; i < 8; i++) {
      const n = frag(`<div class="bl-dmg"><svg viewBox="-50 -50 100 100">
        <path d="M -17 -40 A 43.5 43.5 0 0 1 17 -40 L 12 -31 A 33 33 0 0 0 -12 -31 Z"/>
      </svg></div>`);
      this.wrap.appendChild(n);
      this.pool.push({ node: n, life: 0, dur: 1, world: 0, mag: 1 });
    }
    this._next = 0;
  }

  /**
   * @param angle  signed radians relative to the current view (0 = ahead)
   * @param yaw    the player's yaw at the moment of the hit
   * @param amount damage, scales the wedge's weight and dwell
   */
  add(angle, yaw, amount) {
    const s = this.pool[this._next % this.pool.length];
    this._next++;
    s.world = angle + yaw;            // remember the world bearing, not the screen one
    s.mag = clamp(0.45 + amount / 55, 0.45, 1.35);
    s.dur = 1.1 + s.mag * 0.5;
    s.life = s.dur;
  }

  update(dt, yaw) {
    for (const s of this.pool) {
      if (s.life <= 0) {
        if (s.node.style.opacity !== '0') s.node.style.opacity = '0';
        continue;
      }
      s.life -= dt;
      const k = Math.max(0, s.life / s.dur);
      // Hold near full for the first third, then fall away on a cubic.
      const a = k > 0.66 ? 1 : Math.pow(k / 0.66, 1.7);
      const deg = ((s.world - yaw) * 180) / Math.PI;
      s.node.style.opacity = (a * clamp(s.mag, 0, 1)).toFixed(3);
      s.node.style.transform = `rotate(${deg.toFixed(1)}deg) scale(${(0.94 + s.mag * 0.16 + (1 - a) * 0.1).toFixed(3)})`;
    }
  }
}
