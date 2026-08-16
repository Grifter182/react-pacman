import { el, weaponIcon } from './Dom.js';

const HS_ICON = `<svg class="hs" viewBox="0 0 16 16" aria-hidden="true">
  <path d="M8 0a6 6 0 0 0-6 6c0 2 1 3 1 4v2h2v2h2v-2h2v2h2v-2h2v-2c0-1 1-2 1-4a6 6 0 0 0-6-6z"/>
  <circle cx="5.6" cy="6.4" r="1.7" fill="#111"/><circle cx="10.4" cy="6.4" r="1.7" fill="#111"/>
</svg>`;

/**
 * OWNER: UI/UX agent.
 *
 * Killfeed. Rows are pooled: six DOM nodes are created at construction and
 * recycled, so a hundred-kill match allocates nothing after boot. Ordering is
 * handled by re-appending the recycled node, which is one DOM move rather than
 * a create/destroy pair.
 *
 * Weapon glyphs are inline SVG from `Dom.js` — the project ships no images.
 */
export class Killfeed {
  constructor(parent, capacity = 6) {
    this.node = el('div.bl-kf');
    parent.appendChild(this.node);

    this.rows = [];
    for (let i = 0; i < capacity; i++) {
      const r = el('div.bl-kfrow');
      r.innerHTML = `<span class="who a"></span><span class="mid"></span><span class="who b"></span>`;
      r.style.display = 'none';
      this.node.appendChild(r);
      this.rows.push({ node: r, life: 0 });
    }
    this._n = 0;
  }

  /**
   * @param e { attacker, victim, weapon, headshot, attackerTeam, victimTeam, involvesPlayer }
   */
  push(e) {
    // Oldest slot wins; if everything is fresh the least-recently used one goes.
    let slot = this.rows[0];
    for (const r of this.rows) if (r.life < slot.life) slot = r;

    const teamCls = (t) => (t === 0 ? 'a' : 'b');
    const [a, b] = [slot.node.children[0], slot.node.children[2]];
    a.className = `who ${teamCls(e.attackerTeam)}`;
    a.textContent = e.attacker;
    b.className = `who ${teamCls(e.victimTeam)}`;
    b.textContent = e.victim;
    slot.node.children[1].innerHTML =
      (e.headshot ? HS_ICON : '') + weaponIcon(e.weapon || 'rifle');

    slot.node.className = `bl-kfrow${e.involvesPlayer ? ' me' : ''}`;
    slot.node.style.display = '';
    slot.life = 5.5;
    // Re-appending moves it to the bottom of the column — newest last, which is
    // the direction the eye is already travelling from the map above it.
    this.node.appendChild(slot.node);
    // Force a style flush so the entry transition actually plays on a recycled
    // node rather than being coalesced away.
    void slot.node.offsetWidth;
    slot.node.classList.add('in');
    this._n++;
  }

  update(dt) {
    for (const r of this.rows) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0.6 && !r.node.classList.contains('out')) r.node.classList.add('out');
      if (r.life <= 0) { r.node.style.display = 'none'; r.node.className = 'bl-kfrow'; }
    }
  }

  clear() {
    for (const r of this.rows) { r.life = 0; r.node.style.display = 'none'; r.node.className = 'bl-kfrow'; }
  }

  setVisible(v) { this.node.style.display = v ? '' : 'none'; }
}
