/**
 * OWNER: netcode agent.
 *
 * The online-session readout: connection state, room, head count and round
 * trip in one quiet strip; a short event log for joins, leaves and kills; and
 * the relay's authoritative scoreboard while Tab is held.
 *
 * Built from plain DOM with scoped styles so it neither depends on nor
 * restyles the HUD agent's components. It borrows the HUD's `--font` token
 * when present, so it reads as part of the same interface.
 */

const CSS = `
/* Left edge, under the minimap: top-centre is the score and compass, top-right
   the killfeed, the bottom corners vitals and ammo. */
.bl-net { position: fixed; left: var(--safe, 32px);
  top: calc(var(--safe, 32px) + var(--u, 8px) * 21 + 44px);
  z-index: 40; pointer-events: none; display: flex; flex-direction: column;
  align-items: flex-start; gap: 6px;
  font-family: var(--font, "Bahnschrift","DIN Alternate","Roboto Condensed","Arial Narrow",sans-serif);
  color: #e9e4da; text-transform: uppercase; }
.bl-net-strip { display: flex; gap: 12px; align-items: center; padding: 4px 12px;
  font-size: 11px; letter-spacing: .18em; font-weight: 600;
  background: linear-gradient(180deg, rgba(14,16,20,.62), rgba(14,16,20,.38));
  border: 1px solid rgba(233,228,218,.12); border-radius: 2px; }
.bl-net-dot { width: 7px; height: 7px; border-radius: 50%; background: #8a8f98;
  box-shadow: 0 0 6px currentColor; }
.bl-net[data-state="online"] .bl-net-dot { background: #6fdc8c; color: #6fdc8c; }
.bl-net[data-state="connecting"] .bl-net-dot { background: #f2c14e; color: #f2c14e;
  animation: bl-net-pulse 1s ease-in-out infinite; }
.bl-net[data-state="offline"] .bl-net-dot { background: #ff5c46; color: #ff5c46; }
.bl-net-dim { opacity: .55; }
.bl-net-log { display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  font-size: 11px; letter-spacing: .14em; }
.bl-net-log div { padding: 2px 10px; background: rgba(14,16,20,.45);
  transition: opacity .6s ease; }
.bl-net-board { display: none; min-width: 300px; margin-top: 4px; padding: 8px 12px;
  background: rgba(14,16,20,.78); border: 1px solid rgba(233,228,218,.14);
  font-size: 12px; letter-spacing: .12em; }
.bl-net.show-board .bl-net-board { display: block; }
.bl-net-board table { width: 100%; border-collapse: collapse; }
.bl-net-board th { text-align: left; font-weight: 600; opacity: .55; font-size: 10px;
  padding-bottom: 4px; }
.bl-net-board td { padding: 2px 0; }
.bl-net-board td.n, .bl-net-board th.n { text-align: right; width: 44px; }
.bl-net-board tr.me td { color: #f2c14e; }
.capture-mode .bl-net { display: none !important; }
@keyframes bl-net-pulse { 50% { opacity: .35; } }
`;

export class NetPanel {
  constructor(parent = document.body) {
    if (!document.getElementById('bl-net-style')) {
      const st = document.createElement('style');
      st.id = 'bl-net-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.root = document.createElement('div');
    this.root.className = 'bl-net';
    this.root.dataset.state = 'connecting';
    this.root.innerHTML = `
      <div class="bl-net-strip">
        <span class="bl-net-dot"></span>
        <span class="bl-net-status">CONNECTING</span>
        <span class="bl-net-room bl-net-dim"></span>
        <span class="bl-net-count"></span>
        <span class="bl-net-ping bl-net-dim"></span>
      </div>
      <div class="bl-net-log"></div>
      <div class="bl-net-board"><table><thead><tr>
        <th>OPERATOR</th><th class="n">K</th><th class="n">D</th><th class="n">PING</th>
      </tr></thead><tbody></tbody></table></div>`;
    parent.appendChild(this.root);

    this.$status = this.root.querySelector('.bl-net-status');
    this.$room = this.root.querySelector('.bl-net-room');
    this.$count = this.root.querySelector('.bl-net-count');
    this.$ping = this.root.querySelector('.bl-net-ping');
    this.$log = this.root.querySelector('.bl-net-log');
    this.$body = this.root.querySelector('tbody');

    this._onKey = (e) => {
      if (e.code !== 'Tab') return;
      this.root.classList.toggle('show-board', e.type === 'keydown');
    };
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
  }

  setState(state, text) {
    this.root.dataset.state = state;
    this.$status.textContent = text;
  }

  setRoom(room) { this.$room.textContent = room ? `ROOM ${room}` : ''; }

  setCount(n) { this.$count.textContent = `${n} OPERATOR${n === 1 ? '' : 'S'}`; }

  setPing(ms) { this.$ping.textContent = Number.isFinite(ms) ? `${Math.round(ms)} MS` : ''; }

  /** Brief line under the strip; the newest four stay, each fades after 5 s. */
  log(text) {
    const d = document.createElement('div');
    d.textContent = text;
    this.$log.prepend(d);
    while (this.$log.children.length > 4) this.$log.lastChild.remove();
    setTimeout(() => { d.style.opacity = '0'; }, 5000);
    setTimeout(() => d.remove(), 5700);
  }

  /** @param rows [{ name, k, d, me, ping }] */
  setBoard(rows) {
    rows.sort((a, b) => (b.k - a.k) || (a.d - b.d));
    this.$body.replaceChildren(...rows.map((r) => {
      const tr = document.createElement('tr');
      if (r.me) tr.className = 'me';
      for (const [v, cls] of [[r.name, ''], [r.k, 'n'], [r.d, 'n'], [r.ping ?? '', 'n']]) {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = String(v);
        tr.appendChild(td);
      }
      return tr;
    }));
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKey);
    this.root.remove();
  }
}
