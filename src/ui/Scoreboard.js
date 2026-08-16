import { el, frag } from './Dom.js';

/**
 * OWNER: UI/UX agent.
 *
 * TAB scoreboard. Rows are pooled per team and only re-read while the board is
 * actually on screen, at 5 Hz — a scoreboard that repaints every frame is pure
 * waste for a panel nobody is looking at 99% of the time.
 */
export class Scoreboard {
  constructor(parent, rowsPerTeam = 8) {
    this.node = frag(`
      <div class="bl-sb">
        <div class="wrap">
          <h2>TEAM DEATHMATCH · SUQ AL-HADID</h2>
          <div class="teams"></div>
        </div>
      </div>`);
    parent.appendChild(this.node);

    this.teams = [];
    const host = this.node.querySelector('.teams');
    for (let t = 0; t < 2; t++) {
      const panel = frag(`
        <div class="bl-sbteam bl-panel ${t === 0 ? 'a' : 'b'}">
          <div class="hd"><b></b><span class="bl-lab"></span><span class="s bl-num">0</span></div>
          <div class="bl-sbrow head"><span>OPERATOR</span><span>K</span><span>D</span><span>STK</span><span>SCORE</span></div>
          <div class="body"></div>
        </div>`);
      host.appendChild(panel);
      const body = panel.querySelector('.body');
      const rows = [];
      for (let i = 0; i < rowsPerTeam; i++) {
        const r = el('div.bl-sbrow');
        r.innerHTML = '<span class="nm"></span><span class="k"></span><span class="d"></span><span class="st"></span><span class="sc"></span>';
        r.style.display = 'none';
        body.appendChild(r);
        rows.push(r);
      }
      this.teams.push({
        panel, rows,
        $name: panel.querySelector('.hd b'),
        $tag: panel.querySelector('.hd .bl-lab'),
        $score: panel.querySelector('.hd .s'),
      });
    }

    this.visible = false;
    this._acc = 99;
  }

  show(v) {
    if (this.visible === v) return;
    this.visible = v;
    this.node.classList.toggle('on', v);
    this._acc = 99;                       // force an immediate refresh on open
  }

  /**
   * @param getData a *thunk*, not the data. Building the snapshot allocates
   *        arrays and objects, and doing that every frame for a panel that is
   *        on screen for two seconds a match is exactly the kind of waste this
   *        HUD is not allowed to have.
   */
  update(dt, getData) {
    if (!this.visible) return;
    this._acc += dt;
    if (this._acc < 0.2) return;
    this._acc = 0;
    const data = typeof getData === 'function' ? getData() : getData;
    if (data) this.render(data);
  }

  /** @param data { teams: [{ name, tag, score, players: [...] }] } */
  render(data) {
    for (let t = 0; t < this.teams.length; t++) {
      const src = data.teams[t];
      const dst = this.teams[t];
      if (!src) continue;
      dst.$name.textContent = src.name;
      dst.$tag.textContent = src.tag || '';
      dst.$score.textContent = String(src.score);

      const list = src.players.slice().sort((a, b) => b.score - a.score || b.kills - a.kills);
      for (let i = 0; i < dst.rows.length; i++) {
        const row = dst.rows[i];
        const p = list[i];
        if (!p) { row.style.display = 'none'; continue; }
        row.style.display = '';
        row.className = `bl-sbrow${p.isPlayer ? ' you' : ''}${p.alive ? '' : ' dead'}`;
        row.children[0].textContent = p.name;
        row.children[1].textContent = String(p.kills);
        row.children[2].textContent = String(p.deaths);
        row.children[3].textContent = String(p.bestStreak || 0);
        row.children[4].textContent = String(p.score);
      }
    }
  }
}
