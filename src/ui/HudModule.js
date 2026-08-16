/**
 * OWNER: UI/UX agent.
 *
 * DOM-based HUD layered over the canvas: crosshair with dynamic spread,
 * hitmarkers, health/shield, ammo, compass, minimap, killfeed, damage
 * indicators, scoreboard, and the front-end menus.
 *
 * Everything is driven from bus events — the HUD never reaches into
 * simulation state except through `engine.get(...)` reads in `update`.
 */
export class HudModule {
  constructor() {
    this.root = null;
    this._hitmarkerTimer = 0;
    this._damageTimer = 0;
    this._killfeed = [];
  }

  async init(engine) {
    this.root = document.getElementById('ui');
    this.root.innerHTML = '';
    this._injectStyles();

    this.root.insertAdjacentHTML('beforeend', `
      <div class="hud">
        <div class="crosshair" id="xh">
          <i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i>
          <em class="dot"></em>
        </div>
        <div class="hitmarker" id="hm"><i></i><i></i><i></i><i></i></div>
        <div class="dmg" id="dmg"></div>

        <div class="bottom-left">
          <div class="health"><div class="bar" id="hpbar"></div></div>
          <div class="label">HEALTH</div>
        </div>

        <div class="bottom-right">
          <div class="ammo"><span id="mag">30</span><small id="res">/ 210</small></div>
          <div class="label" id="wname">M4A1</div>
        </div>

        <div class="killfeed" id="kf"></div>
        <div class="compass"><div class="strip" id="cmp"></div><i class="tick"></i></div>
        <div class="perf" id="perf"></div>
      </div>
      <div class="prompt" id="prompt"><b>CLICK TO DEPLOY</b><span>WASD move · SHIFT sprint · CTRL crouch · R reload · RMB aim</span></div>
    `);

    this.$xh = document.getElementById('xh');
    this.$hm = document.getElementById('hm');
    this.$dmg = document.getElementById('dmg');
    this.$hp = document.getElementById('hpbar');
    this.$mag = document.getElementById('mag');
    this.$res = document.getElementById('res');
    this.$kf = document.getElementById('kf');
    this.$cmp = document.getElementById('cmp');
    this.$perf = document.getElementById('perf');
    this.$prompt = document.getElementById('prompt');

    engine.bus.on('ui:pointerlock', ({ locked }) => {
      this.$prompt.classList.toggle('hidden', locked);
    });
    engine.bus.on('hit:actor', () => { this._hitmarkerTimer = 0.16; });
    engine.bus.on('actor:killed', ({ headshot }) => {
      this._hitmarkerTimer = 0.3;
      this._pushKill(headshot ? 'HEADSHOT' : 'ELIMINATED');
    });
    engine.bus.on('player:damaged', () => { this._damageTimer = 0.55; });
  }

  _pushKill(text) {
    const el = document.createElement('div');
    el.className = 'kfrow';
    el.innerHTML = `<b>YOU</b><i></i><span>${text}</span>`;
    this.$kf.prepend(el);
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3800);
    while (this.$kf.children.length > 5) this.$kf.lastChild.remove();
  }

  update(dt, engine) {
    const player = engine.get('player');
    const weapons = engine.get('weapons');
    if (!player) return;
    const s = player.state;

    // Crosshair spread reacts to movement, fire and stance.
    const speed = Math.hypot(s.velocity.x, s.velocity.z);
    const ads = weapons?._adsBlend ?? 0;
    const spread = (7 + speed * 2.4 + (weapons?._recoil.y ?? 0) * 260) * (1 - ads * 0.85);
    this.$xh.style.setProperty('--s', `${spread.toFixed(1)}px`);
    this.$xh.style.opacity = String(1 - ads * 0.9);

    this._hitmarkerTimer = Math.max(0, this._hitmarkerTimer - dt);
    this.$hm.style.opacity = String(Math.min(1, this._hitmarkerTimer * 7));
    this.$hm.style.transform = `translate(-50%,-50%) scale(${1 + (1 - Math.min(1, this._hitmarkerTimer * 7)) * 0.35})`;

    this._damageTimer = Math.max(0, this._damageTimer - dt);
    this.$dmg.style.opacity = String(this._damageTimer * 1.1);

    this.$hp.style.width = `${(s.health / s.maxHealth) * 100}%`;
    this.$hp.style.background = s.health > 55 ? '#d8e4ee' : s.health > 25 ? '#e8b23c' : '#d8452f';

    if (weapons) {
      this.$mag.textContent = String(weapons.ammo);
      this.$res.textContent = `/ ${weapons.reserve}`;
      this.$mag.classList.toggle('low', weapons.ammo <= 6);
    }

    // Compass strip scrolls with yaw.
    const deg = ((-s.yaw * 180 / Math.PI) % 360 + 360) % 360;
    this.$cmp.style.transform = `translateX(${-deg * 4}px)`;

    if (engine.frame % 15 === 0) {
      this.$perf.textContent = `${engine.perf.fps.toFixed(0)} FPS`;
    }
  }

  _injectStyles() {
    if (document.getElementById('hud-style')) return;
    const st = document.createElement('style');
    st.id = 'hud-style';
    st.textContent = `
      .hud { position:absolute; inset:0; font-family:inherit; color:#e8eef5; letter-spacing:.06em; }
      .crosshair { --s:8px; position:absolute; left:50%; top:50%; width:0; height:0; transition:opacity .12s; }
      .crosshair i { position:absolute; background:#eaf2fb; box-shadow:0 0 3px rgba(0,0,0,.9); }
      .crosshair .t { width:2px; height:8px; left:-1px; top:calc(-1 * var(--s) - 8px); }
      .crosshair .b { width:2px; height:8px; left:-1px; top:var(--s); }
      .crosshair .l { height:2px; width:8px; top:-1px; left:calc(-1 * var(--s) - 8px); }
      .crosshair .r { height:2px; width:8px; top:-1px; left:var(--s); }
      .crosshair .dot { position:absolute; width:2px; height:2px; left:-1px; top:-1px; background:#eaf2fb; opacity:.55; }
      .hitmarker { position:absolute; left:50%; top:50%; width:26px; height:26px; transform:translate(-50%,-50%); opacity:0; }
      .hitmarker i { position:absolute; width:9px; height:2px; background:#fff; box-shadow:0 0 4px #000; }
      .hitmarker i:nth-child(1){ top:3px; left:2px; transform:rotate(45deg); }
      .hitmarker i:nth-child(2){ top:3px; right:2px; transform:rotate(-45deg); }
      .hitmarker i:nth-child(3){ bottom:3px; left:2px; transform:rotate(-45deg); }
      .hitmarker i:nth-child(4){ bottom:3px; right:2px; transform:rotate(45deg); }
      .dmg { position:absolute; inset:0; opacity:0; background:radial-gradient(ellipse at center, transparent 42%, rgba(150,20,12,.55) 100%); }
      .bottom-left { position:absolute; left:38px; bottom:34px; }
      .bottom-right { position:absolute; right:38px; bottom:34px; text-align:right; }
      .health { width:220px; height:5px; background:rgba(255,255,255,.13); border-radius:1px; overflow:hidden; }
      .health .bar { height:100%; width:100%; background:#d8e4ee; transition:width .18s ease-out, background .3s; }
      .label { margin-top:7px; font-size:11px; opacity:.5; font-weight:600; }
      .ammo { font-size:44px; font-weight:700; line-height:1; text-shadow:0 2px 10px rgba(0,0,0,.8); }
      .ammo small { font-size:17px; opacity:.5; margin-left:5px; font-weight:600; }
      .ammo #mag.low { color:#e2503a; }
      .killfeed { position:absolute; right:38px; top:88px; display:flex; flex-direction:column; gap:5px; align-items:flex-end; }
      .kfrow { display:flex; align-items:center; gap:9px; font-size:12px; padding:5px 11px; background:rgba(8,11,16,.62); border-left:2px solid #d8452f; transition:opacity .5s; }
      .kfrow.out { opacity:0; }
      .kfrow b { color:#7fd0ff; }
      .kfrow i { width:12px; height:1px; background:rgba(255,255,255,.35); }
      .compass { position:absolute; left:50%; top:26px; transform:translateX(-50%); width:340px; height:26px; overflow:hidden;
                 mask-image:linear-gradient(90deg,transparent,#000 22%,#000 78%,transparent); }
      .compass .strip { position:absolute; left:50%; white-space:nowrap; font-size:12px; opacity:.65; font-weight:600; }
      .compass .tick { position:absolute; left:50%; top:0; width:1px; height:9px; background:#fff; opacity:.8; }
      .perf { position:absolute; left:14px; top:12px; font-size:11px; opacity:.35; font-variant-numeric:tabular-nums; }
      .prompt { position:absolute; inset:0; display:flex; flex-direction:column; gap:12px; align-items:center; justify-content:center;
                background:rgba(4,6,10,.55); backdrop-filter:blur(3px); transition:opacity .28s; color:#e8eef5; }
      .prompt.hidden { opacity:0; pointer-events:none; }
      .prompt b { font-size:26px; letter-spacing:.28em; font-weight:700; }
      .prompt span { font-size:12px; opacity:.55; letter-spacing:.12em; }
    `;
    document.head.appendChild(st);

    // Build the compass strip once.
    requestAnimationFrame(() => {
      const cmp = document.getElementById('cmp');
      if (!cmp) return;
      const marks = [];
      for (let d = 0; d < 720; d += 15) {
        const label = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }[d % 360];
        marks.push(`<span style="display:inline-block;width:60px;text-align:center">${label || '·'}</span>`);
      }
      cmp.innerHTML = marks.join('');
    });
  }

  dispose() { if (this.root) this.root.innerHTML = ''; }
}
