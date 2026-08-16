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

export class VitalsPanel {
  constructor(parent) {
    this.node = frag(`
      <div class="bl-bl">
        <div class="bl-hprow">
          <span class="bl-hpval bl-num bl-chroma">100</span>
          <span class="bl-hpmax bl-num">/100</span>
          <span class="bl-hpstate">STABLE</span>
        </div>
        <div class="bl-hpbar"><i class="ghost"></i><i class="fill"></i></div>
        <div class="bl-stance">
          <span data-k="sprint">SPRINT</span><span data-k="crouch">CROUCH</span>
          <span data-k="prone">PRONE</span><span data-k="ads">AIM</span>
        </div>
      </div>`);
    parent.appendChild(this.node);

    // Segment ticks at each quarter give the bar a scale to be read against.
    const bar = this.node.querySelector('.bl-hpbar');
    for (let i = 1; i < 4; i++) {
      bar.appendChild(el('i.seg', { style: `left:${i * 25}%` }));
    }

    this.$val = this.node.querySelector('.bl-hpval');
    this.$max = this.node.querySelector('.bl-hpmax');
    this.$state = this.node.querySelector('.bl-hpstate');
    this.$fill = this.node.querySelector('.fill');
    this.$ghost = this.node.querySelector('.ghost');
    this.$stance = [...this.node.querySelectorAll('.bl-stance span')];

    this._hp = -1; this._ghostPct = 100; this._cls = ''; this._state = '';
  }

  update(dt, s, vitals) {
    const ratio = clamp(s.health / s.maxHealth, 0, 1);
    const hp = Math.ceil(s.health);
    if (hp !== this._hp) {
      this._hp = hp;
      this.$val.textContent = String(Math.max(0, hp));
      this.$max.textContent = `/${s.maxHealth}`;
      this.$fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    }

    // The ghost bar chases the real one downward only, and slowly, so the size
    // of the hit you just took is legible after the fact.
    const pct = ratio * 100;
    if (pct < this._ghostPct) this._ghostPct = Math.max(pct, this._ghostPct - dt * 26);
    else this._ghostPct = pct;
    this.$ghost.style.width = `${this._ghostPct.toFixed(1)}%`;

    const cls = 'bl-bl' + (ratio <= 0.28 ? ' bl-crit' : ratio <= 0.6 ? ' bl-hurt' : '')
      + (vitals?.regenerating && ratio < 1 ? ' bl-regen' : '');
    if (cls !== this._cls) { this.node.className = cls; this._cls = cls; }

    const st = !s.alive ? 'DOWN'
      : vitals?.regenerating && ratio < 1 ? 'RECOVERING'
      : ratio <= 0.28 ? 'CRITICAL'
      : ratio <= 0.6 ? 'WOUNDED' : 'STABLE';
    if (st !== this._state) { this.$state.textContent = st; this._state = st; }

    const on = { sprint: s.sprinting, crouch: s.crouching, prone: s.prone, ads: s.ads };
    for (const nodeEl of this.$stance) {
      const want = !!on[nodeEl.dataset.k];
      if (nodeEl.classList.contains('on') !== want) nodeEl.classList.toggle('on', want);
    }
  }
}

/* -------------------------------------------------------------------- ammo */

export class AmmoPanel {
  constructor(parent) {
    this.node = frag(`
      <div class="bl-br">
        <div class="bl-wname">M4A1</div>
        <div class="bl-wmode">AUTO · ASSAULT</div>
        <div class="bl-ammo">
          <span class="bl-mag bl-num bl-chroma">30</span>
          <span class="bl-res bl-num">/ 210</span>
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

export class ObjectiveStrip {
  constructor(parent) {
    this.node = frag('<div class="bl-obj"><b></b><span></span></div>');
    parent.appendChild(this.node);
    this._text = null;
  }

  set(text, sub = '') {
    if (text === this._text) return;
    this._text = text;
    this.node.children[0].textContent = text || '';
    this.node.children[1].textContent = sub || '';
    this.node.classList.toggle('on', !!text);
  }
}

/* ----------------------------------------------------------- respawn timer */

export class RespawnOverlay {
  constructor(parent) {
    this.node = frag(`
      <div class="bl-respawn">
        <b>YOU WERE KILLED</b>
        <div class="n bl-num">4</div>
        <span>REDEPLOYING</span>
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
