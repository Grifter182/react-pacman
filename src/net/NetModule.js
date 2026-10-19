import * as THREE from 'three';
import { Config, QualityTier } from '../core/Config.js';
import { soldierAsset } from '../ai/Soldier.js';
import { RemotePlayer } from './RemotePlayer.js';
import { NetPanel } from './NetPanel.js';
import {
  PROTOCOL_VERSION, TICK_HZ, INTERP_DELAY_MS, NET_PATH, DEFAULT_PORT,
  sanitizeName, sanitizeRoom, vec3, isVec3,
} from './Protocol.js';

/**
 * OWNER: netcode agent.
 *
 * Online play: other people in the same match, through a relay
 * (server/relay.mjs). Inert unless asked for, so single-player, the capture
 * harness and every probe tool behave exactly as before.
 *
 * TURNING IT ON (URL parameters)
 *   ?online=1                  connect to the relay at this page's origin, /net
 *   ?server=ws://host:8787/net connect to a specific relay (implies online)
 *   ?room=alpha                room to join (default "public")
 *   ?name=GHOST                callsign (default: random)
 *   ?bots=N                    keep N local bots; online defaults to none,
 *                              because bots are simulated per client and
 *                              would be different soldiers on every screen
 *
 * WHAT CROSSES THE WIRE — see Protocol.js for the message table.
 *
 * HOW IT PLUGS IN (bus first, per the engine contract)
 *   - Local 'weapon:fire' is tested against remote bodies here and, on a hit,
 *     re-published as 'hit:actor' so the hitmarker, blood, impact audio and
 *     accuracy stat all come from their usual owners.
 *   - A remote shot is re-published as 'ai:fire' + 'audio:play' + 'hit:surface'
 *     so tracers, muzzle light, minimap contact ping, sound and decals come
 *     from their usual owners too.
 *   - A remote death is 'actor:killed', with `by: 'player'` when it was ours.
 *   - Incoming damage goes through the player's public `damage()` surface,
 *     which raises 'player:damaged' / 'player:died' itself.
 *   - Remote players are given entries in the match roster (guarded, the same
 *     way MatchModule reaches into the AI's damage path) so the killfeed and
 *     scoreboard name them and credit kills correctly in both directions.
 */

export function netOptions(search = (typeof location !== 'undefined' ? location.search : '')) {
  let q;
  try { q = new URLSearchParams(search); } catch { q = new URLSearchParams(); }
  const flag = (q.get('online') || '').toLowerCase();
  const server = q.get('server');
  const enabled = flag === '0' || flag === 'false' ? false
    : (flag === '1' || flag === 'true' || flag === 'yes' || !!server || q.has('room'));
  return {
    enabled,
    server,
    room: sanitizeRoom(q.get('room')),
    name: sanitizeName(q.get('name')) || `OPERATOR${(Math.random() * 900 + 100) | 0}`,
    botsExplicit: q.has('bots'),
  };
}

function relayUrl(opts) {
  if (opts.server) return opts.server;
  const secure = location.protocol === 'https:';
  // A page opened from disk has no origin to share; fall back to a local relay.
  if (!location.host) return `ws://127.0.0.1:${DEFAULT_PORT}${NET_PATH}`;
  return `${secure ? 'wss' : 'ws'}://${location.host}${NET_PATH}`;
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _m = new THREE.Vector3();
const _p = new THREE.Vector3();

export class NetModule {
  constructor(opts = netOptions()) {
    this.opts = opts;
    this.enabled = !!opts.enabled;
    this.remotes = new Map();      // id -> RemotePlayer
    this.scores = new Map();       // id -> { k, d }
    this.myId = null;
    this.myName = opts.name;
    this.room = opts.room;
    this.connected = false;
    this.rtt = NaN;

    this._ws = null;
    this._retry = 0;
    this._fatal = false;
    this._sendAcc = 0;
    this._offset = 0;              // server ms - performance.now()
    this._hasOffset = false;
    this._time = 0;
    this._lastAlive = null;
    this._lastHit = null;          // { by, hs, at } most recent incoming hit
  }

  async init(engine) {
    this.engine = engine;
    engine.net = this;
    if (!this.enabled) return;

    this.player = engine.get('player');
    this.weapons = engine.get('weapons');
    this.collision = engine.get('collision');
    this.match = engine.get('match');
    this.ai = engine.get('ai');

    this.root = new THREE.Group();
    this.root.name = 'NetPlayers';
    engine.scene.add(this.root);
    const tier = Config.quality;
    this.asset = soldierAsset(tier === QualityTier.HIGH || tier === QualityTier.ULTRA ? 2 : 1);
    this.footIK = tier !== QualityTier.LOW;

    this.panel = new NetPanel(document.body);
    this.panel.setRoom(this.room);
    this.panel.setCount(1);

    const bus = engine.bus;
    this._offs = [
      bus.on('weapon:fire', (e) => this._onLocalFire(e)),
      bus.on('player:died', (e) => this._onLocalDied(e)),
    ];

    this.url = relayUrl(this.opts);
    this._connect();
  }

  /* ============================================================ transport */

  _connect() {
    if (this._fatal) return;
    this.panel.setState('connecting', this._retry ? 'RECONNECTING' : 'CONNECTING');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      console.warn('[net] bad relay url', this.url, err);
      this._fatal = true;
      this.panel.setState('offline', 'BAD RELAY URL');
      return;
    }
    this._ws = ws;
    ws.onopen = () => {
      this._send({ t: 'hello', v: PROTOCOL_VERSION, name: this.myName, room: this.room });
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m && typeof m.t === 'string') this._onMessage(m);
    };
    ws.onclose = () => {
      if (this._ws !== ws) return;
      const was = this.connected;
      this.connected = false;
      this._ws = null;
      clearInterval(this._heartbeat);
      this.myId = null;
      for (const id of [...this.remotes.keys()]) this._removeRemote(id);
      this.panel.setCount(1);
      this.panel.setPing(NaN);
      if (this._fatal) return;
      if (was) this.panel.log('CONNECTION LOST');
      this.panel.setState('offline', 'OFFLINE');
      const delay = Math.min(10000, 1000 * 2 ** Math.min(4, this._retry++));
      this._retryTimer = setTimeout(() => this._connect(), delay);
    };
    ws.onerror = () => { /* 'close' follows and owns the retry */ };
  }

  _send(msg) {
    const ws = this._ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  /* ============================================================= messages */

  _onMessage(m) {
    switch (m.t) {
      case 'welcome': {
        this.connected = true;
        this._retry = 0;
        this.myId = m.id;
        this.myName = m.name;
        this.room = m.room;
        this.scores.clear();
        this.scores.set(m.id, { k: 0, d: 0 });
        for (const p of m.players || []) {
          this._addRemote(p.id, p.name);
          this.scores.set(p.id, { k: p.k | 0, d: p.d | 0 });
        }
        this.panel.setState('online', `ONLINE · ${m.name}`);
        this.panel.setRoom(m.room);
        this.panel.log(`JOINED ROOM ${m.room.toUpperCase()}`);
        this._refreshBoard();
        this._sendState(true);
        // The heartbeat runs on a timer, not the frame loop: a backgrounded tab
        // stops requestAnimationFrame entirely, and a player who alt-tabs must
        // not be dropped by the relay's idle sweep and lose their score.
        clearInterval(this._heartbeat);
        this._heartbeat = setInterval(() => this._send({ t: 'ping', c: performance.now() }), 2000);
        this._send({ t: 'ping', c: performance.now() });
        break;
      }
      case 'join':
        this._addRemote(m.id, m.name);
        this.scores.set(m.id, { k: 0, d: 0 });
        this.panel.log(`${m.name} JOINED`);
        this._refreshBoard();
        break;
      case 'leave': {
        const r = this.remotes.get(m.id);
        if (r) this.panel.log(`${r.name} LEFT`);
        this._removeRemote(m.id);
        this.scores.delete(m.id);
        this._refreshBoard();
        break;
      }
      case 'snap': this._onSnapshot(m); break;
      case 'fire': this._onRemoteFire(m); break;
      case 'hit': this._onRemoteHit(m); break;
      case 'kill': this._onKill(m); break;
      case 'pong': {
        const now = performance.now();
        const rtt = now - m.c;
        this.rtt = Number.isFinite(this.rtt) ? this.rtt + (rtt - this.rtt) * 0.3 : rtt;
        this.panel.setPing(this.rtt);
        this._refreshBoard();
        break;
      }
      case 'error':
        console.warn('[net] relay refused:', m.reason);
        this._fatal = true;
        this.panel.setState('offline', String(m.reason || 'REFUSED').toUpperCase());
        break;
      default: break;
    }
  }

  _onSnapshot(m) {
    const now = performance.now();
    // Server clock offset from the fastest-arriving snapshot seen: a snapshot
    // that arrives "early" relative to the estimate lowers the latency floor
    // immediately; drift the other way is followed slowly so one late packet
    // cannot yank every remote body backwards.
    const est = m.s - now;
    if (!this._hasOffset || est > this._offset) { this._offset = est; this._hasOffset = true; }
    else this._offset += (est - this._offset) * 0.002;

    for (const st of m.ps || []) {
      if (st.id === this.myId || !isVec3(st.p)) continue;
      let r = this.remotes.get(st.id);
      if (!r) r = this._addRemote(st.id, `OPERATOR${st.id}`);
      r.push(m.s, st);
    }
  }

  /* ============================================================== remotes */

  _addRemote(id, name) {
    if (id === this.myId) return null;
    const existing = this.remotes.get(id);
    if (existing) return existing;
    const r = new RemotePlayer(id, name, this.asset, this.root);
    this.remotes.set(id, r);
    this._rosterAdd(r);
    this.panel.setCount(this.remotes.size + 1);
    return r;
  }

  _removeRemote(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    this._rosterRemove(r);
    r.dispose();
    this.remotes.delete(id);
    this.panel.setCount(this.remotes.size + 1);
  }

  /**
   * Bind a roster entry to the remote body. The roster is the gameplay agent's
   * data, reached through `match.roster` with every access guarded, the same
   * pattern MatchModule uses for the AI's damage path. If its shape ever
   * changes, online play loses killfeed names and nothing else.
   */
  _rosterAdd(r) {
    const roster = this.match?.roster;
    if (!roster || !Array.isArray(roster.players) || typeof roster._make !== 'function') return;
    let name = r.name;
    if (typeof roster.byName === 'function' && roster.byName(name)) name = `${name}-${r.id}`;
    const entry = roster._make({ name, team: 1 });
    entry.actor = r.actor;
    entry.remote = true;
    entry.fireTimer = Infinity;   // never let the light-squad sim fire for a human
    roster.players.push(entry);
    r.rosterName = name;
    r.rosterEntry = entry;
  }

  _rosterRemove(r) {
    const list = this.match?.roster?.players;
    if (!Array.isArray(list) || !r.rosterEntry) return;
    const i = list.indexOf(r.rosterEntry);
    if (i >= 0) list.splice(i, 1);
  }

  /** `restart()` resets fire timers and `build()` would drop our entries. */
  _rosterMaintain() {
    const list = this.match?.roster?.players;
    if (!Array.isArray(list)) return;
    for (const r of this.remotes.values()) {
      if (!r.rosterEntry) continue;
      if (!list.includes(r.rosterEntry)) list.push(r.rosterEntry);
      r.rosterEntry.fireTimer = Infinity;
    }
  }

  /* ========================================================== local play */

  _sendState(force = false) {
    const p = this.player;
    if (!p || !this.connected) return;
    const s = p.state;
    const half = p.controller?.halfHeight ?? Config.player.height * 0.5;
    _p.set(s.position.x, s.position.y - half, s.position.z);
    if (!force && this._lastAlive === s.alive && this._sendAcc < 1 / TICK_HZ) return;
    this._lastAlive = s.alive;
    this._send({
      t: 'st',
      p: vec3(_p),
      v: vec3(s.velocity),
      y: Math.round(s.yaw * 1000) / 1000,
      pi: Math.round(s.pitch * 1000) / 1000,
      s: s.stance | 0,
      a: !!s.alive,
      w: this.weapons?.current || 'rifle',
      ads: !!s.ads,
    });
  }

  /**
   * Our round against everyone else's body. The test runs against the bodies
   * as drawn on this screen, i.e. INTERP_DELAY in the past, which is the
   * shooter-favouring lag compensation: if it was on your crosshair, it hit.
   */
  _onLocalFire(e) {
    if (!this.connected) return;
    const origin = e.eyeOrigin || e.origin;
    const dir = e.direction;
    if (!origin || !dir) return;
    let maxT = e.hit ? e.hit.distance : 400;

    // A bot standing in front of the remote player takes the round instead.
    for (const a of this.ai?.actors || []) {
      if (!a.alive) continue;
      const t = rayActorCoarse(origin, dir, a.position);
      if (t !== null && t < maxT) maxT = t;
    }

    let best = null;
    for (const r of this.remotes.values()) {
      const h = r.raycast(origin, dir, best ? best.t : maxT);
      if (h) best = { ...h, r };
    }

    _e.copy(origin).addScaledVector(dir, best ? best.t : Math.min(maxT, 120));
    this._send({
      t: 'fire',
      o: vec3(origin), d: vec3(dir, 1000), e: vec3(_e),
      n: !best && e.hit?.normal ? vec3(e.hit.normal, 1000) : null,
      m: !best && e.hit ? (e.hit.object?.material?.userData?.preset || 'concrete') : null,
      w: e.weapon,
    });
    if (!best) return;

    const base = typeof e.damage === 'number' ? e.damage : 33;
    const limbMul = this.weapons?.limbFactor
      ? this.weapons.limbFactor(best.limb, e.weapon)
      : (best.limb === 'head' ? 2 : 1);
    const damage = Math.round(base * limbMul * 10) / 10;
    const headshot = best.limb === 'head';
    this._send({ t: 'hit', to: best.r.id, dmg: damage, hs: headshot, limb: best.limb });

    best.r.react(dir, damage, best.limb);
    this.engine.bus.emit('hit:actor', {
      actor: best.r.actor,
      point: _e.clone(),
      normal: dir.clone().negate(),
      damage, headshot, limb: best.limb,
    });
  }

  _onRemoteFire(m) {
    const r = this.remotes.get(m.id);
    if (!r || !r.actor.alive) return;
    const bus = this.engine.bus;
    _d.set(m.d[0], m.d[1], m.d[2]).normalize();
    r.muzzle(_m);
    if (m.e) _e.set(m.e[0], m.e[1], m.e[2]);
    else _e.copy(_m).addScaledVector(_d, 120);
    // Re-aim from the muzzle we actually draw to where their round actually
    // went, so the tracer leaves the rifle on screen rather than their eye.
    _o.copy(_e).sub(_m);
    const len = _o.length();
    if (len > 1e-3) _o.multiplyScalar(1 / len); else _o.copy(_d);

    bus.emit('ai:fire', {
      actor: r.actor, origin: _m.clone(), direction: _o.clone(), end: _e.clone(), hitPlayer: false,
    });
    bus.emit('audio:play', {
      id: 'enemy_fire', position: _m.clone(), volume: 0.6, pitch: 0.96 + Math.random() * 0.1,
    });
    if (m.e && m.n) {
      bus.emit('hit:surface', {
        point: _e.clone(), normal: new THREE.Vector3(m.n[0], m.n[1], m.n[2]),
        material: m.m || 'concrete', impulse: 0.85,
      });
    }

    // A round cracking past our head pins us, exactly as a bot's would.
    const p = this.player;
    if (p?.state.alive && typeof p.suppress === 'function') {
      const eye = this.engine.camera.position;
      _p.copy(eye).sub(_m);
      const t = THREE.MathUtils.clamp(_p.dot(_o), 0, len);
      const miss = _p.addScaledVector(_o, -t).length();
      if (miss < 2.2 && t > 2) p.suppress(0.22 * (1 - miss / 2.2));
    }
  }

  _onRemoteHit(m) {
    const p = this.player;
    if (!p?.state.alive) return;
    const r = this.remotes.get(m.by);
    const origin = r ? r.eye(new THREE.Vector3())
      : isVec3(m.o) ? new THREE.Vector3(m.o[0], m.o[1], m.o[2]) : null;
    this._lastHit = { by: m.by, hs: !!m.hs, at: this._time };
    p.damage(Number(m.dmg) || 0, r ? r.rosterName : 'HOSTILE', { origin, headshot: !!m.hs });
  }

  _onLocalDied({ by }) {
    if (!this.connected) return;
    let killer = null, hs = false;
    for (const r of this.remotes.values()) if (r.rosterName === by) { killer = r.id; break; }
    if (killer !== null && this._lastHit?.by === killer) hs = this._lastHit.hs;
    this._send({ t: 'died', by: killer, hs });
    this._sendState(true);
  }

  _onKill(m) {
    for (const s of m.score || []) this.scores.set(s.id, { k: s.k | 0, d: s.d | 0 });
    this._refreshBoard();

    const killerName = m.killer === this.myId ? 'YOU'
      : this.remotes.get(m.killer)?.name || null;
    const victimName = m.victim === this.myId ? 'YOU' : this.remotes.get(m.victim)?.name || '?';
    this.panel.log(killerName ? `${killerName} ▸ ${victimName}${m.hs ? ' ⊕' : ''}` : `${victimName} DIED`);

    if (m.victim === this.myId) return;     // our own death was handled locally
    const r = this.remotes.get(m.victim);
    if (!r) return;
    const killer = m.killer === this.myId ? null : this.remotes.get(m.killer);
    const from = m.killer === this.myId ? this.engine.camera.position
      : killer ? killer.actor.position : null;
    const wasAlive = r.actor.alive;
    r.kill(from, this.collision);
    if (!wasAlive) return;
    this.engine.bus.emit('actor:killed', {
      actor: r.actor,
      by: m.killer === this.myId ? 'player' : killer ? killer.rosterName : null,
      headshot: !!m.hs,
    });
  }

  _refreshBoard() {
    if (!this.panel) return;
    const rows = [];
    if (this.myId !== null) {
      const s = this.scores.get(this.myId) || { k: 0, d: 0 };
      rows.push({ name: this.myName, k: s.k, d: s.d, me: true,
        ping: Number.isFinite(this.rtt) ? Math.round(this.rtt) : '' });
    }
    for (const r of this.remotes.values()) {
      const s = this.scores.get(r.id) || { k: 0, d: 0 };
      rows.push({ name: r.name, k: s.k, d: s.d });
    }
    this.panel.setBoard(rows);
  }

  /* ================================================================ frame */

  update(dt, engine) {
    if (!this.enabled) return;
    this._time += dt;

    if (this.connected) {
      this._sendAcc += dt;
      if (this._sendAcc >= 1 / TICK_HZ) {
        this._sendState(true);
        this._sendAcc %= 1 / TICK_HZ;
      } else {
        this._sendState(false);     // only goes out on a life-state change
      }
    }

    if (!this.remotes.size) return;
    const rt = performance.now() + this._offset - INTERP_DELAY_MS;
    const ctx = {
      collision: this.collision, camPos: engine.camera.position,
      footIK: this.footIK, time: this._time,
    };
    for (const r of this.remotes.values()) r.update(dt, rt, ctx);
    this._rosterMaintain();
  }

  dispose() {
    this._fatal = true;
    clearTimeout(this._retryTimer);
    clearInterval(this._heartbeat);
    for (const off of this._offs || []) off();
    try { this._ws?.close(); } catch { /* ignore */ }
    for (const id of [...this.remotes.keys()]) this._removeRemote(id);
    this.panel?.dispose();
    if (this.root) this.engine.scene.remove(this.root);
  }
}

/** Whole-body capsule only: enough to decide that a bot is in the way. */
function rayActorCoarse(origin, dir, centre) {
  _o.copy(centre).sub(origin);
  const t = _o.dot(dir);
  if (t < 0) return null;
  _o.addScaledVector(dir, -t);
  // Vertical extent ±1 m about the capsule centre, radius 0.4 m.
  if (Math.abs(_o.y) > 1.0) return null;
  return Math.hypot(_o.x, _o.z) < 0.4 ? t : null;
}
