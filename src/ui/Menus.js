import { el, frag, clamp, weaponIcon } from './Dom.js';
import { Config, QualityTier } from '../core/Config.js';

/**
 * OWNER: UI/UX agent.
 *
 * The front end: title, loadout, settings, pause and the end-of-match summary.
 * One container, one nav column, one swapped pane — so every screen shares the
 * same grid, the same type ramp and the same focus order, and the transition
 * between them is a pane swap rather than five competing full-screen layouts.
 *
 * Everything here is DOM built once at construction. Screens are shown by
 * class, never rebuilt, except the summary, whose numbers only exist at the end
 * of a match.
 *
 * SETTINGS ARE LIVE. Sensitivity and FOV go through `player.setSetting`, which
 * persists them and mirrors them into `Config`; the quality tier writes
 * `Config.quality` directly, which every module reads through the `Config.gfx`
 * getter. The tier switch is honest about what it can and cannot change on the
 * fly — render targets and baked textures are sized at boot, so the pane says
 * so rather than pretending.
 */

const QUALITY_ORDER = [QualityTier.LOW, QualityTier.MEDIUM, QualityTier.HIGH, QualityTier.ULTRA];

const KEYMAP = [
  ['W A S D', 'Move'], ['SHIFT', 'Sprint'], ['CTRL / C', 'Crouch'], ['Z', 'Prone'],
  ['SPACE', 'Jump / mantle'], ['LMB', 'Fire'], ['RMB', 'Aim'], ['R', 'Reload'],
  ['1 2 3', 'Weapon'], ['X', 'Fire mode'], ['F', 'Inspect'], ['TAB', 'Scoreboard'],
  ['ESC', 'Pause'],
];

export class Menus {
  /** @param hooks { onDeploy, onResume, onRestart, onWeapon, onSetting, onQuality, onVolume } */
  constructor(parent, hooks) {
    this.hooks = hooks;
    this.screen = null;
    this.weapon = 'rifle';

    this.node = frag(`
      <div class="bl-menu">
        <div class="bl-mwrap">
          <div class="bl-title">
            <div class="eyebrow">TASK FORCE 141 · CLASSIFIED</div>
            <h1>OPERATION <em>BLACKOUT</em></h1>
            <div class="sub">SUQ AL-HADID · 06:40 LOCAL · TEAM DEATHMATCH</div>
            <div class="rule"></div>
          </div>
          <div class="bl-cols">
            <div class="bl-nav"></div>
            <div class="bl-pane bl-panel"></div>
          </div>
        </div>
      </div>`);
    parent.appendChild(this.node);

    this.$title = this.node.querySelector('.bl-title');
    this.$h1 = this.node.querySelector('.bl-title h1');
    this.$sub = this.node.querySelector('.bl-title .sub');
    this.$eyebrow = this.node.querySelector('.eyebrow');
    this.$nav = this.node.querySelector('.bl-nav');
    this.$pane = this.node.querySelector('.bl-pane');

    this.panes = {
      brief: this._buildBrief(),
      loadout: this._buildLoadout(),
      settings: this._buildSettings(),
      summary: this._buildSummary(),
    };
  }

  /* ------------------------------------------------------------------ nav */

  _nav(items) {
    this.$nav.textContent = '';
    for (const it of items) {
      const b = el('button.bl-btn' + (it.primary ? '.primary' : ''), {
        type: 'button',
        onclick: (e) => { e.stopPropagation(); it.action(); },
      });
      b.appendChild(el('span', { text: it.label }));
      if (it.key) b.appendChild(el('span.k', { text: it.key }));
      if (it.disabled) b.disabled = true;
      this.$nav.appendChild(b);
    }
  }

  _setPane(name) {
    const next = this.panes[name];
    if (this.$pane.firstChild === next) return;
    this.$pane.textContent = '';
    if (next) this.$pane.appendChild(next);
  }

  /* -------------------------------------------------------------- screens */

  showTitle() {
    this.screen = 'title';
    this.$eyebrow.textContent = 'TASK FORCE 141 · CLASSIFIED';
    this.$h1.innerHTML = 'OPERATION <em>BLACKOUT</em>';
    this.$sub.textContent = 'SUQ AL-HADID · 06:40 LOCAL · TEAM DEATHMATCH';
    this._nav([
      { label: 'DEPLOY', key: 'ENTER', primary: true, action: () => this.hooks.onDeploy?.() },
      { label: 'LOADOUT', action: () => this.showLoadout('title') },
      { label: 'SETTINGS', action: () => this.showSettings('title') },
      { label: 'BRIEFING', action: () => this._setPane('brief') },
    ]);
    this._setPane('brief');
    this._open();
  }

  showPause() {
    this.screen = 'pause';
    this.$eyebrow.textContent = 'MISSION PAUSED';
    this.$h1.innerHTML = 'STAND <em>BY</em>';
    this.$sub.textContent = 'THE OPERATION CONTINUES WITHOUT YOU';
    this._nav([
      { label: 'RESUME', key: 'ESC', primary: true, action: () => this.hooks.onResume?.() },
      { label: 'LOADOUT', action: () => this.showLoadout('pause') },
      { label: 'SETTINGS', action: () => this.showSettings('pause') },
      { label: 'RESTART MATCH', action: () => this.hooks.onRestart?.() },
    ]);
    this._setPane('brief');
    this._open();
  }

  showLoadout(back) {
    this.screen = 'loadout';
    this.$eyebrow.textContent = 'ARMOURY';
    this.$h1.innerHTML = 'SELECT <em>LOADOUT</em>';
    this.$sub.textContent = 'PRIMARY WEAPON · APPLIES ON NEXT DRAW';
    this._nav([
      { label: 'CONFIRM', primary: true, action: () => (back === 'pause' ? this.hooks.onResume?.() : this.hooks.onDeploy?.()) },
      { label: 'BACK', action: () => (back === 'pause' ? this.showPause() : this.showTitle()) },
    ]);
    this._setPane('loadout');
    this._open();
  }

  showSettings(back) {
    this.screen = 'settings';
    this.$eyebrow.textContent = 'SYSTEM';
    this.$h1.innerHTML = 'SET<em>TINGS</em>';
    this.$sub.textContent = 'INPUT · VIEW · GRAPHICS · AUDIO';
    this._nav([
      { label: 'BACK', primary: true, action: () => (back === 'pause' ? this.showPause() : this.showTitle()) },
    ]);
    this._setPane('settings');
    this.refreshSettings();
    this._open();
  }

  showSummary(summary) {
    this.screen = 'summary';
    this.$eyebrow.textContent = 'MISSION COMPLETE';
    // The verdict is the pane's headline; repeating it in the masthead would
    // just be the same word twice at two sizes.
    this.$h1.innerHTML = 'DE<em>BRIEF</em>';
    this.$sub.textContent = `SUQ AL-HADID · ${summary.teamA} ${summary.scoreA} — ${summary.scoreB} ${summary.teamB}`;
    this._nav([
      { label: 'PLAY AGAIN', primary: true, action: () => this.hooks.onRestart?.() },
      { label: 'LOADOUT', action: () => this.showLoadout('title') },
      { label: 'SETTINGS', action: () => this.showSettings('title') },
    ]);
    this._fillSummary(summary);
    this._setPane('summary');
    this._open();
  }

  hide() { this.screen = null; this.node.classList.remove('on'); }
  _open() { this.node.classList.add('on'); }
  get open() { return this.screen !== null; }

  /* ---------------------------------------------------------------- panes */

  _buildBrief() {
    const n = el('div');
    n.appendChild(el('h3', { text: 'SITUATION' }));
    n.appendChild(el('p', {
      text: 'A pre-dawn raid on the ironmongers\' souk. Two squads, one market, '
        + 'sixty metres of frontage and no safe lane. Hold the score line before the clock runs out — '
        + 'a tie at zero goes to sudden-death overtime.',
    }));
    n.appendChild(el('h3', { text: 'CONTROLS', style: 'margin-top:24px' }));
    const keys = el('div.bl-keys');
    for (const [k, label] of KEYMAP) {
      const row = el('div');
      row.appendChild(el('kbd', { text: k }));
      row.appendChild(el('span', { text: label }));
      keys.appendChild(row);
    }
    n.appendChild(keys);
    return n;
  }

  /* --- loadout ----------------------------------------------------------- */

  _buildLoadout() {
    const n = el('div');
    n.appendChild(el('h3', { text: 'PRIMARY' }));
    this.$guns = el('div.bl-guns');
    n.appendChild(this.$guns);
    this._gunCards = new Map();
    return n;
  }

  /**
   * Populate from the live weapon table. Bars are normalised against the whole
   * table rather than against absolute constants, so adding a fourth weapon
   * rescales the comparison instead of breaking it.
   */
  setWeapons(table, current) {
    if (!this.$guns || !table) return;
    this.weapon = current || this.weapon;
    const ids = Object.keys(table);
    const max = { damage: 0, rpm: 0, range: 0, acc: 0, hand: 0 };
    const stat = (d) => ({
      damage: d.damage,
      rpm: d.rpm,
      range: d.falloffEnd,
      acc: 1 / Math.max(1e-4, d.spreadHip),
      hand: 1 / Math.max(1e-3, d.adsTime),
    });
    for (const id of ids) {
      const s = stat(table[id]);
      for (const k in s) max[k] = Math.max(max[k], s[k]);
    }

    this.$guns.textContent = '';
    this._gunCards.clear();
    for (const id of ids) {
      const d = table[id];
      const s = stat(d);
      const card = el('button.bl-gun', { type: 'button' });
      card.innerHTML =
        `<div class="cls">${(d.class || '').toUpperCase()} · SLOT ${d.slot}</div>
         <div class="nm">${d.name}</div>
         ${weaponIcon(id)}
         ${bar('DAMAGE', s.damage / max.damage)}
         ${bar('CADENCE', s.rpm / max.rpm)}
         ${bar('RANGE', s.range / max.range)}
         ${bar('ACCURACY', s.acc / max.acc)}
         ${bar('HANDLING', s.hand / max.hand)}`;
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectWeapon(id);
        this.hooks.onWeapon?.(id);
      });
      this.$guns.appendChild(card);
      this._gunCards.set(id, card);
    }
    this.selectWeapon(this.weapon);
  }

  selectWeapon(id) {
    this.weapon = id;
    for (const [k, card] of this._gunCards) card.classList.toggle('on', k === id);
  }

  /* --- settings ---------------------------------------------------------- */

  _buildSettings() {
    const n = el('div');
    this._sliders = [];
    this._segs = [];

    const group = (title) => n.appendChild(el('h3', { text: title, style: 'margin-top:20px' }));

    group('INPUT');
    this._slider(n, 'sensitivity', 'MOUSE SENSITIVITY', 0.0004, 0.0080, 0.0001,
      (v) => (v * 10000).toFixed(1), 'Radians turned per raw mouse count, ×10⁴.');
    this._slider(n, 'adsSensScale', 'AIM SENSITIVITY', 0.20, 1.40, 0.01, (v) => `${Math.round(v * 100)}%`);
    this._toggle(n, 'invertY', 'INVERT VERTICAL');

    group('VIEW');
    this._slider(n, 'fov', 'FIELD OF VIEW', 65, 115, 1, (v) => `${Math.round(v)}°`);
    this._slider(n, 'viewmodelFov', 'WEAPON FOV', 40, 80, 1, (v) => `${Math.round(v)}°`);
    this._slider(n, 'bobScale', 'VIEW BOB', 0, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`);
    this._slider(n, 'shakeScale', 'CAMERA SHAKE', 0, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`);

    group('GRAPHICS');
    this._seg(n, 'quality', 'QUALITY TIER', QUALITY_ORDER.map((q) => [q, q.toUpperCase()]),
      (v) => this.hooks.onQuality?.(v),
      'Shadows, post and particle budgets update live. Render-target size and '
      + 'baked texture resolution are fixed at boot.');

    group('AUDIO');
    for (const [busName, label] of [['master', 'MASTER'], ['sfx', 'EFFECTS'], ['weapons', 'WEAPONS'], ['music', 'MUSIC'], ['ambience', 'AMBIENCE']]) {
      this._volume(n, busName, label);
    }
    return n;
  }

  _row(parent, label) {
    const row = el('div.bl-set');
    row.appendChild(el('span.nm', { text: label }));
    parent.appendChild(row);
    return row;
  }

  _slider(parent, key, label, min, max, step, fmt, hint) {
    const row = this._row(parent, label);
    const input = el('input', { type: 'range', min, max, step });
    const val = el('span.val');
    row.appendChild(input); row.appendChild(val);
    if (hint) parent.lastChild.appendChild(el('span.hint', { text: hint }));
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      const applied = this.hooks.onSetting?.(key, v) ?? v;
      val.textContent = fmt(applied);
    });
    this._sliders.push({ key, input, val, fmt });
  }

  _toggle(parent, key, label) {
    const row = this._row(parent, label);
    const seg = el('div.bl-seg');
    const mk = (text, v) => {
      const b = el('button', { type: 'button', text });
      b.addEventListener('click', () => {
        this.hooks.onSetting?.(key, v);
        this.refreshSettings();
      });
      seg.appendChild(b);
      return b;
    };
    const off = mk('OFF', false), on = mk('ON', true);
    row.appendChild(seg);
    this._segs.push({ key, kind: 'bool', off, on });
  }

  _seg(parent, key, label, options, apply, hint) {
    const row = this._row(parent, label);
    const seg = el('div.bl-seg');
    const buttons = [];
    for (const [value, text] of options) {
      const b = el('button', { type: 'button', text });
      b.addEventListener('click', () => { apply(value); this.refreshSettings(); });
      seg.appendChild(b);
      buttons.push([value, b]);
    }
    row.appendChild(seg);
    if (hint) parent.lastChild.appendChild(el('span.hint', { text: hint }));
    this._segs.push({ key, kind: 'enum', buttons });
  }

  _volume(parent, bus, label) {
    const row = this._row(parent, label);
    const input = el('input', { type: 'range', min: 0, max: 1, step: 0.01 });
    const val = el('span.val');
    row.appendChild(input); row.appendChild(val);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      this.hooks.onVolume?.(bus, v);
      val.textContent = `${Math.round(v * 100)}%`;
    });
    this._sliders.push({ bus, input, val, fmt: (v) => `${Math.round(v * 100)}%` });
  }

  /** Pull current values back out of the systems that own them. */
  refreshSettings() {
    const s = this.hooks.getSettings?.() || {};
    const mix = this.hooks.getVolumes?.() || {};
    for (const sl of this._sliders) {
      const v = sl.bus ? mix[sl.bus] : s[sl.key];
      if (typeof v !== 'number') continue;
      sl.input.value = String(v);
      sl.val.textContent = sl.fmt(v);
    }
    for (const sg of this._segs) {
      if (sg.kind === 'bool') {
        const v = !!s[sg.key];
        sg.on.classList.toggle('on', v);
        sg.off.classList.toggle('on', !v);
      } else {
        for (const [value, b] of sg.buttons) b.classList.toggle('on', value === Config.quality);
      }
    }
  }

  /* --- summary ----------------------------------------------------------- */

  _buildSummary() {
    const n = el('div.bl-sum');
    n.innerHTML = `
      <div class="verdict"></div>
      <div class="score"></div>
      <div class="bl-cards"></div>
      <div class="bl-lab" style="text-align:center">MATCH REPORT</div>`;
    this.$verdict = n.querySelector('.verdict');
    this.$score = n.querySelector('.score');
    this.$cards = n.querySelector('.bl-cards');
    return n;
  }

  _fillSummary(s) {
    this.$verdict.className = `verdict ${s.result}`;
    this.$verdict.textContent = s.result === 'win' ? 'VICTORY' : s.result === 'lose' ? 'DEFEAT' : 'DRAW';
    this.$score.textContent = `${s.teamA} ${s.scoreA}  —  ${s.scoreB} ${s.teamB}`;
    const cards = [
      ['ELIMINATIONS', s.kills, `${s.headshots} headshot${s.headshots === 1 ? '' : 's'}`],
      ['DEATHS', s.deaths, `K/D ${(s.kills / Math.max(1, s.deaths)).toFixed(2)}`],
      ['BEST STREAK', s.bestStreak, s.bestStreak >= 5 ? 'AIRSTRIKE EARNED' : s.bestStreak >= 3 ? 'UAV EARNED' : '—'],
      ['SCORE', s.score, `${s.accuracy}% accuracy`],
    ];
    this.$cards.textContent = '';
    for (const [l, v, sub] of cards) {
      const c = el('div.bl-card.bl-panel');
      c.innerHTML = `<div class="l">${l}</div><div class="v bl-num">${v}</div><div class="s">${sub}</div>`;
      this.$cards.appendChild(c);
    }
  }
}

function bar(label, t) {
  const pct = Math.round(clamp(t, 0.06, 1) * 100);
  return `<div class="bl-stat"><span class="l">${label}</span><span class="m"><i style="width:${pct}%"></i></span></div>`;
}
