import { el, frag, clamp, clock } from './Dom.js';

/**
 * OWNER: UI/UX agent.
 *
 * The readouts that live at the edges of the frame: vitals, ammunition, the
 * match bar, callouts and the respawn counter.
 *
 * Every one of them writes only when the *displayed* value changes. A health
 * bar being told `width: 73.4182%` sixty times a second costs a style
 * recalculation each frame for a number the player cannot read; rounding to the
 * nearest tenth first cuts that to the handful of frames where it matters.
 */

/* ------------------------------------------------------------------ vitals */

/**
 * Stance silhouettes, on a 16x22 box. Deliberately abstract: at fifteen pixels
 * tall an anatomically drawn soldier is mush, whereas a head plus one mass
 * whose proportion and axis change with the stance is readable instantly.
 * `stand` is never drawn — it is the resting state, and the whole point of a
 * transient glyph is that the default costs nothing on screen.
 */
const STANCE_ART = {
  crouch: '<circle cx="8" cy="6.2" r="3"/><path d="M4.3 10.2h7.4a1.8 1.8 0 0 1 1.8 1.8v7.8a1.8 1.8 0 0 1-1.8 1.8H4.3a1.8 1.8 0 0 1-1.8-1.8V12a1.8 1.8 0 0 1 1.8-1.8z"/>',
  prone: '<circle cx="3.4" cy="16.8" r="3"/><path d="M6.4 14.3h7.4a2.3 2.3 0 0 1 0 5H6.4z"/>',
  sprint: '<circle cx="10.2" cy="3.4" r="3"/><path d="M6.6 7.4h5.2L8.4 21.6H3.2z"/>',
  ads: '<path d="M1 8V2h6v2.2H3.2V8zM15 8V2H9v2.2h3.8V8zM1 14v6h6v-2.2H3.2V14zM15 14v6H9v-2.2h3.8V14z"/><circle cx="8" cy="11" r="1.7"/>',
};

export class VitalsPanel {
  constructor(parent) {
    // ONE ENCODING. The block used to say the same thing four ways — "100",
    // "/100", a segmented bar with a lagging ghost, and the word STABLE. A
    // player reads exactly one of those, and it is the big number; the rest was
    // dashboard for its own sake. What is left is the numeral, which changes
    // hue as it falls, and the screen-edge vignette that already exists as the
    // second, non-textual channel.
    this.node = frag(`
      <div class="bl-bl">
        <span class="bl-hpval bl-num bl-t1">100</span>
        <div class="bl-stance"><svg viewBox="0 0 16 22" aria-hidden="true"></svg></div>
      </div>`);
    parent.appendChild(this.node);

    this.$val = this.node.querySelector('.bl-hpval');
    this.$stance = this.node.querySelector('.bl-stance');
    this.$stanceArt = this.$stance.querySelector('svg');

    this._hp = -1; this._cls = '';
    this._stance = 'stand';
    this._stanceHold = 0;
  }

  /** Priority order: what you are doing beats what you are standing on. */
  static _stanceOf(s) {
    if (s.ads) return 'ads';
    if (s.prone) return 'prone';
    if (s.crouching) return 'crouch';
    if (s.sprinting) return 'sprint';
    return 'stand';
  }

  update(dt, s, vitals) {
    const ratio = clamp(s.health / s.maxHealth, 0, 1);
    const hp = Math.ceil(s.health);
    if (hp !== this._hp) {
      this._hp = hp;
      this.$val.textContent = String(Math.max(0, hp));
    }

    const cls = 'bl-bl' + (ratio <= 0.28 ? ' bl-crit' : ratio <= 0.6 ? ' bl-hurt' : '')
      + (vitals?.regenerating && ratio < 1 ? ' bl-regen' : '');
    if (cls !== this._cls) { this.node.className = cls; this._cls = cls; }

    /* --- stance glyph ------------------------------------------------------ */
    // Shown on the transition, held briefly, then faded. Aiming is the one
    // stance held long enough to be worth persisting, and it is accented
    // because it is the one that changes what the reticle means.
    const st = VitalsPanel._stanceOf(s);
    if (st !== this._stance) {
      this._stance = st;
      if (st === 'stand') {
        this._stanceHold = 0;
        this.$stance.classList.remove('on');
      } else {
        this.$stanceArt.innerHTML = STANCE_ART[st];
        this.$stance.classList.toggle('acc', st === 'ads');
        this.$stance.classList.add('on');
        this._stanceHold = 1.6;
      }
    }
    if (this._stanceHold > 0) {
      // Aiming holds the glyph up for as long as it lasts; everything else is a
      // momentary confirmation that the input registered.
      if (st === 'ads') this._stanceHold = 1.6;
      else {
        this._stanceHold -= dt;
        if (this._stanceHold <= 0) this.$stance.classList.remove('on');
      }
    }
  }
}

/* -------------------------------------------------------------------- ammo */

export class AmmoPanel {
  constructor(parent) {
    this.node = frag(`
      <div class="bl-br">
        <div class="bl-wname bl-t2">M4A1</div>
        <div class="bl-wmode bl-t3">AUTO · ASSAULT</div>
        <div class="bl-ammo">
          <span class="bl-mag bl-num bl-t1">30</span>
          <span class="bl-res bl-num bl-t3">/ 210</span>
        </div>
        <div class="bl-pips"></div>
        <div class="bl-reload"><i></i></div>
      </div>`);
    parent.appendChild(this.node);

    this.$mag = this.node.querySelector('.bl-mag');
    this.$res = this.node.querySelector('.bl-res');
    this.$pips = this.node.querySelector('.bl-pips');
    this.$name = this.node.querySelector('.bl-wname');
    this.$mode = this.node.querySelector('.bl-wmode');
    this.$reload = this.node.querySelector('.bl-reload');
    this.$reloadFill = this.$reload.querySelector('i');

    this._pipCount = 0;
    this._mag = -1; this._res = -1; this._cls = ''; this._name = ''; this._mode = '';
    this._reloading = false;
  }

  /** Pips are rebuilt only when the magazine *capacity* changes (a weapon swap). */
  _syncPips(capacity) {
    const n = Math.min(capacity, 32);
    if (n === this._pipCount) return;
    this._pipCount = n;
    this.$pips.textContent = '';
    for (let i = 0; i < n; i++) this.$pips.appendChild(el('i'));
    this._pips = [...this.$pips.children];
  }

  update(dt, w) {
    if (!w?.def) return;
    const cap = w.def.magazine;
    this._syncPips(cap);

    if (w.ammo !== this._mag) {
      this._mag = w.ammo;
      this.$mag.textContent = String(w.ammo);
      const shown = Math.round((w.ammo / cap) * this._pipCount);
      const warn = w.ammo <= Math.max(3, cap * 0.25);
      for (let i = 0; i < this._pipCount; i++) {
        const lit = i < shown;
        this._pips[i].className = lit ? (warn ? 'warn' : 'on') : '';
      }
    }
    if (w.reserve !== this._res) {
      this._res = w.reserve;
      this.$res.textContent = `/ ${w.reserve}`;
    }

    const cls = 'bl-br' + (w.ammo === 0 ? ' bl-empty' : w.ammo <= Math.max(3, cap * 0.25) ? ' bl-low' : '');
    if (cls !== this._cls) { this.node.className = cls; this._cls = cls; }

    if (w.def.name !== this._name) { this._name = w.def.name; this.$name.textContent = w.def.name; }
    const mode = `${String(w.fireModes?.get(w.current) || w.def.fireMode).toUpperCase()} · ${w.def.class?.toUpperCase() || ''}`;
    if (mode !== this._mode) { this._mode = mode; this.$mode.textContent = mode; }

    /* --- reload progress -------------------------------------------------- */
    // Read straight off the clip player: the bar is the animation's own clock,
    // so it can never disagree with the moment the magazine actually seats.
    const clip = w.clips;
    const active = !!w.reloading && !!clip?.clip;
    if (active !== this._reloading) {
      this._reloading = active;
      this.$reload.classList.toggle('on', active);
    }
    if (active) {
      const p = clamp(clip.time / Math.max(0.01, clip.clip.duration), 0, 1);
      this.$reloadFill.style.width = `${(p * 100).toFixed(1)}%`;
    }
  }
}

/* --------------------------------------------------------------- match bar */

export class MatchBar {
  constructor(parent) {
    this.node = frag(`
      <div class="bl-match bl-panel">
        <span class="sc a bl-num">0</span>
        <span class="rule"></span>
        <span class="clk bl-num">10:00</span>
        <span class="rule"></span>
        <span class="sc b bl-num">0</span>
        <div class="bl-scorebar"><i></i><b></b></div>
      </div>`);
    parent.appendChild(this.node);
    this.$a = this.node.querySelector('.sc.a');
    this.$b = this.node.querySelector('.sc.b');
    this.$clk = this.node.querySelector('.clk');
    this.$fa = this.node.querySelector('.bl-scorebar i');
    this.$fb = this.node.querySelector('.bl-scorebar b');
    this._a = -1; this._b = -1; this._t = '';
  }

  update(m) {
    if (!m) return;
    if (m.scoreA !== this._a) {
      this._a = m.scoreA;
      this.$a.textContent = String(m.scoreA);
      this.$fa.style.width = `${clamp((m.scoreA / m.scoreLimit) * 50, 0, 50).toFixed(2)}%`;
    }
    if (m.scoreB !== this._b) {
      this._b = m.scoreB;
      this.$b.textContent = String(m.scoreB);
      this.$fb.style.width = `${clamp((m.scoreB / m.scoreLimit) * 50, 0, 50).toFixed(2)}%`;
    }
    const t = m.overtime ? 'OT' : clock(m.timeLeft);
    if (t !== this._t) {
      this._t = t;
      this.$clk.textContent = t;
      this.$clk.classList.toggle('warn', m.overtime || m.timeLeft < 60);
    }
  }
}

/* ------------------------------------------------------------ callout deck */

export class Callouts {
  constructor(parent) {
    this.node = el('div.bl-toasts');
    parent.appendChild(this.node);
    this.slots = [];
    for (let i = 0; i < 3; i++) {
      const n = frag('<div class="bl-toast"><b></b><span></span></div>');
      n.style.display = 'none';
      this.node.appendChild(n);
      this.slots.push({ node: n, life: 0 });
    }
  }

  /** @param kind 'streak' | 'reward' | 'bad' | '' */
  push(title, sub = '', kind = '', dwell = 2.6) {
    let slot = this.slots[0];
    for (const s of this.slots) if (s.life < slot.life) slot = s;
    slot.node.className = `bl-toast ${kind}`;
    slot.node.children[0].textContent = title;
    slot.node.children[1].textContent = sub;
    slot.node.style.display = '';
    slot.life = dwell;
    this.node.appendChild(slot.node);
    void slot.node.offsetWidth;
    slot.node.classList.add('in');
  }

  update(dt) {
    for (const s of this.slots) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0.35) s.node.classList.remove('in');
      if (s.life <= 0) s.node.style.display = 'none';
    }
  }
}

/* --------------------------------------------------------------- objective */

/**
 * The objective is a card, not a banner.
 *
 * It used to be pinned to bottom centre and left up for the whole match, where
 * two things were true of it in every captured frame: the weapon occluded it,
 * and on the frames where it was visible it said the same eight words it had
 * said ten minutes earlier. Bottom centre in a first-person game is the
 * viewmodel's, unconditionally.
 *
 * It now sits on the top-centre axis under the score panel, and it dismisses
 * itself. `set()` is called on a genuine change of objective — round start,
 * overtime, a streak reward expiring — and each call buys a few seconds of
 * screen time. An empty text clears it immediately.
 */
const OBJECTIVE_DWELL = 7;

export class ObjectiveStrip {
  constructor(parent) {
    this.node = frag('<div class="bl-obj"><b></b><span></span></div>');
    parent.appendChild(this.node);
    this._text = null;
    this._life = 0;
  }

  set(text, sub = '', dwell = OBJECTIVE_DWELL) {
    if (!text) {
      this._text = null;
      this._life = 0;
      this.node.classList.remove('on');
      return;
    }
    // A repeat of the objective already showing does not restart its clock;
    // otherwise a module that re-announces on a timer pins it up forever.
    if (text === this._text && this._life > 0) return;
    this._text = text;
    this.node.children[0].textContent = text;
    this.node.children[1].textContent = sub || '';
    this._life = dwell > 0 ? dwell : OBJECTIVE_DWELL;
    this.node.classList.add('on');
  }

  update(dt) {
    if (this._life <= 0) return;
    this._life -= dt;
    if (this._life <= 0) this.node.classList.remove('on');
  }
}

/* ----------------------------------------------------------- respawn timer */

export class RespawnOverlay {
  constructor(parent) {
    this.node = frag(`
      <div class="bl-respawn">
        <b>YOU WERE KILLED</b>
        <div class="n bl-num bl-t1">4</div>
        <span class="bl-t3">REDEPLOYING</span>
      </div>`);
    parent.appendChild(this.node);
    this.$n = this.node.querySelector('.n');
    this.$b = this.node.querySelector('b');
    this._shown = false; this._n = -1;
  }

  update(active, seconds, killer) {
    if (active !== this._shown) {
      this._shown = active;
      this.node.classList.toggle('on', active);
    }
    if (!active) return;
    const n = Math.max(0, Math.ceil(seconds));
    if (n !== this._n) { this._n = n; this.$n.textContent = String(n); }
    const label = killer ? `KILLED BY ${killer}` : 'YOU WERE KILLED';
    if (this.$b.textContent !== label) this.$b.textContent = label;
  }
}
