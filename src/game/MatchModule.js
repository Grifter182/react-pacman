import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { Roster, TEAM } from './Roster.js';
import { SpawnSelector } from './Spawns.js';
import { StreakSystem } from './Streaks.js';

/**
 * OWNER: gameplay agent.
 *
 * Team deathmatch: the round, the score, the squads and the flow out of it.
 *
 * STATE MACHINE
 *   warmup -> live -> (overtime) -> post
 *   `warmup` holds while the front end is up; the clock does not run behind a
 *   menu. `overtime` only exists if the clock expires level — it is sudden
 *   death, and the objective strip says so.
 *
 * WHERE THE KILLS COME FROM
 *   - The player shooting a hostile: the AI module resolves it and emits
 *     `actor:killed` with `by: 'player'`.
 *   - A friendly operator shooting a hostile: this module applies real damage
 *     through the AI module's own damage path, so the same `actor:killed` comes
 *     back with the operator's callsign. One code path, one killfeed entry.
 *   - A hostile shooting the player: `player:died` carries `bot<id>`, which maps
 *     straight back onto the roster entry bound to that actor.
 *   - A hostile shooting a friendly operator: resolved here, since friendlies
 *     have no body in the world for the AI to hit.
 *
 * Nothing is scored that did not happen.
 *
 * EVENTS OUT
 *   match:state     { state }
 *   match:killfeed  { attacker, victim, weapon, headshot, attackerTeam, victimTeam, involvesPlayer }
 *   match:callout   { title, sub, kind, dwell }
 *   match:objective { text, sub, dwell }   an announcement, not a pinned banner
 *   match:uav       { active }
 *   match:end       summary for the HUD's post-match screen
 * EVENTS IN
 *   actor:killed player:died ui:deploy ui:restart ui:pause weapon:fire
 */

export const MatchState = {
  WARMUP: 'warmup',
  LIVE: 'live',
  OVERTIME: 'overtime',
  POST: 'post',
};

const OVERTIME_SEC = 120;
const SIM_RANGE = 52;               // metres a light operator will engage at

export class MatchModule {
  constructor() {
    this.state = MatchState.WARMUP;
    this.timeLeft = Config.match.timeLimitSec;
    this.paused = false;
    this.overtime = false;

    this.roster = new Roster();
    this.time = 0;

    this._respawnTimer = 0;
    this._regenDelay = 0;
    this._deathSite = null;
    this._shotsFired = 0;
    this._shotsHit = 0;
    this._allyBuf = [];
    this._view = {
      scoreA: 0, scoreB: 0, scoreLimit: Config.match.scoreLimit,
      timeLeft: 0, overtime: false, respawnIn: 0, uavActive: false,
      allyPositions: this._allyBuf,
    };

    // Legacy field kept for anything still reading `match.score`.
    this.score = { player: 0, enemy: 0 };
  }

  /* ------------------------------------------------------------------ init */

  async init(engine) {
    this.engine = engine;
    this.ai = engine.get('ai');
    this.level = engine.get('level');
    this.collision = engine.get('collision');
    this.player = engine.get('player');

    this.spawns = new SpawnSelector(this.level, this.collision);
    this.roster.build(this.ai?.actors, this.level?.navPoints);
    this.streaks = new StreakSystem(engine, {
      actors: () => this.ai?.actors || [],
      applyDamage: (actor, dmg, info) => this._damageActor(actor, dmg, info),
      restoreObjective: () => {
        if (this.state === MatchState.OVERTIME) {
          this.engine.bus.emit('match:objective', { text: 'SUDDEN DEATH', sub: 'NEXT ELIMINATION WINS', dwell: 9 });
        } else if (this.state !== MatchState.POST) {
          this._announceObjective();
        }
      },
    });

    this._bind(engine);
    this._setState(MatchState.LIVE);
    // The HUD reads `view()` from its first frame, which can be before the
    // match has ticked once (the front end holds the clock).
    this._syncView();
    // The HUD is registered after this module, so anything published during
    // init() is shouted into an empty room. The opening objective waits for
    // 'engine:ready', by which point every subscriber exists.
    engine.bus.once('engine:ready', () => this._announceObjective());

    engine.match = this;
  }

  _bind(engine) {
    const bus = engine.bus;

    bus.on('ui:pause', ({ paused }) => { this.paused = !!paused; });
    bus.on('ui:deploy', () => {
      if (this.state === MatchState.POST) this.restart();
      else if (this.state === MatchState.WARMUP) this._setState(MatchState.LIVE);
    });
    bus.on('ui:restart', () => this.restart());

    bus.on('actor:killed', ({ actor, by, headshot }) => this._onActorKilled(actor, by, headshot));
    bus.on('player:died', ({ by, position }) => this._onPlayerDied(by, position));

    // Accuracy for the post-match card. Every `weapon:fire` is one round out of
    // the barrel; `hit:actor` is one that found a body.
    bus.on('weapon:fire', () => { this._shotsFired++; });
    bus.on('hit:actor', () => { this._shotsHit++; });
  }

  /* ---------------------------------------------------------------- deaths */

  _onActorKilled(actor, by, headshot) {
    const victim = this.roster.byActor(actor);
    if (!victim) return;
    const killer = by === 'player' ? this.roster.player
      : by === 'airstrike' ? this.roster.player
      : this.roster.byName(String(by || '').toUpperCase()) || null;

    const streak = this.roster.credit(killer, victim, headshot);
    victim.respawnAt = this.time + 6;

    this._feed(killer, victim, by === 'airstrike' ? 'airstrike' : 'rifle', headshot);

    if (killer && killer.isPlayer) {
      this.score.player += headshot ? 150 : 100;
      const reward = this.streaks.onStreak(streak);
      if (!reward && streak >= 2) {
        this.engine.bus.emit('match:callout', {
          title: headshot ? 'HEADSHOT' : `${streak} STREAK`,
          // Alpha's team score *is* the count of hostiles Alpha has put down.
          sub: `${this.roster.teams[TEAM.ALPHA].score} HOSTILES DOWN`,
          kind: 'streak', dwell: 1.6,
        });
      }
    }
    this._checkScoreLimit();
  }

  _onPlayerDied(by, position) {
    const killer = this._rosterFromKillerTag(by);
    this.roster.credit(killer, this.roster.player, false);
    this.streaks.onPlayerDeath();
    this._deathSite = position ? position.clone() : null;
    this._respawnTimer = Config.match.respawnDelaySec;
    this.score.enemy += 100;

    this._feed(killer, this.roster.player,
      by === 'fall' ? 'world' : by === 'airstrike' ? 'airstrike' : 'rifle', false);
    this.engine.bus.emit('match:state', { state: 'respawning' });
    this._checkScoreLimit();
  }

  /** `bot3` -> the roster entry bound to actor id 3. */
  _rosterFromKillerTag(by) {
    if (typeof by !== 'string') return null;
    const m = /^bot(\d+)$/.exec(by);
    if (m) {
      const id = parseInt(m[1], 10);
      for (const p of this.roster.players) if (p.actor && p.actor.id === id) return p;
      return null;
    }
    return this.roster.byName(by.toUpperCase());
  }

  _feed(attacker, victim, weapon, headshot) {
    this.engine.bus.emit('match:killfeed', {
      attacker: attacker ? attacker.name : 'THE WORLD',
      victim: victim ? victim.name : '—',
      attackerTeam: attacker ? attacker.team : TEAM.BRAVO,
      victimTeam: victim ? victim.team : TEAM.ALPHA,
      weapon, headshot: !!headshot,
      involvesPlayer: !!(attacker?.isPlayer || victim?.isPlayer),
    });
  }

  /* ------------------------------------------------------------------ loop */

  update(dt, engine) {
    if (this.paused || this.state === MatchState.POST) return;
    this.time += dt;
    this.streaks.update(dt);

    if (this.state === MatchState.WARMUP) return;

    /* --- clock -------------------------------------------------------------- */
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      if (this.state === MatchState.LIVE && this._tied()) this._enterOvertime();
      else return this._end();
    } else if (this.state === MatchState.LIVE && this.timeLeft < 30 && !this._warned) {
      this._warned = true;
      engine.bus.emit('match:callout', { title: '30 SECONDS', sub: '', kind: 'bad', dwell: 2 });
    }

    this._tickPlayer(dt, engine);
    this._tickSquads(dt);
    this._syncView();
  }

  _tickPlayer(dt, engine) {
    const player = this.player || engine.get('player');
    if (!player) return;
    const s = player.state;

    if (!s.alive) {
      this._respawnTimer -= dt;
      if (this._respawnTimer <= 0) this._respawnPlayer(player);
      return;
    }

    // Regeneration, campaign-style: a long delay then a fast heal. `_regenDelay`
    // is written by Vitals on every hit, which is why it is a field and not a
    // local timer.
    if (s.health < s.maxHealth) {
      this._regenDelay = Math.max(0, (this._regenDelay ?? 0) - dt);
      if (this._regenDelay <= 0) s.health = Math.min(s.maxHealth, s.health + 32 * dt);
    }
  }

  _respawnPlayer(player) {
    const spawn = this.spawns.pick(
      TEAM.ALPHA,
      (this.ai?.actors || []),
      this.roster.livingSims(TEAM.ALPHA).map((p) => ({ position: p.sim.position })),
      this._deathSite,
    );
    player.state.position.copy(spawn.position)
      .setY(spawn.position.y + Config.player.height * 0.5 + 0.05);
    player.state.yaw = spawn.yaw;
    player.state.velocity.set(0, 0, 0);
    player.state.health = player.state.maxHealth;
    player.state.alive = true;
    this.roster.player.alive = true;
    this._regenDelay = 0;
    this.engine.bus.emit('player:spawn', { position: player.state.position, yaw: player.state.yaw });
    this.engine.bus.emit('match:state', { state: this.state });
  }

  /**
   * The two squads either side of the player, on one engagement model.
   *
   * Every non-player combatant — friendly operator or hostile actor — owns a
   * fire timer on its roster entry. When it expires the combatant looks for the
   * nearest enemy inside 52 m with a clear line, and if it finds one it puts a
   * burst into it. Four or five bursts kill, so a target that breaks contact
   * survives, and the exchange rate on both sides comes out of the same
   * numbers. That symmetry is the point: the player is the asymmetry.
   *
   * Damage into a hostile goes through the AI module's resolver so the body
   * really falls over; damage into a friendly operator is resolved here,
   * because a friendly operator has no body for anything else to hit.
   */
  _tickSquads(dt) {
    const actors = this.ai?.actors || [];
    const navPoints = this.level?.navPoints || [];
    const friends = this.roster.livingSims(TEAM.ALPHA);

    for (const p of this.roster.players) {
      if (p.isPlayer) continue;

      /* --- liveness --------------------------------------------------------- */
      if (p.actor) {
        // The AI module owns hostile bodies, including their respawn; the
        // scoreboard only mirrors what the world already decided.
        p.alive = p.actor.alive;
        if (!p.alive) continue;
      } else if (p.sim) {
        if (!p.alive) {
          if (this.time >= p.respawnAt) {
            const spawn = this.spawns.pick(p.team, actors, [], null);
            p.sim.position.copy(spawn.position);
            p.sim.health = 100;
            p.alive = true;
          }
          continue;
        }
        /* --- patrol --------------------------------------------------------- */
        _v.copy(p.sim.goal).sub(p.sim.position);
        _v.y = 0;
        const d = _v.length();
        if (d < 2.2 && navPoints.length) {
          p.sim.goal.copy(navPoints[(Math.random() * navPoints.length) | 0]);
        } else if (d > 1e-3) {
          p.sim.position.addScaledVector(_v.multiplyScalar(1 / d), p.sim.speed * dt);
        }
      } else {
        continue;
      }

      /* --- engagement -------------------------------------------------------- */
      p.fireTimer -= dt;
      if (p.fireTimer > 0) continue;

      const from = p.actor ? p.actor.position : p.sim.position;
      const burst = (20 + Math.random() * 16) * p.skill;

      if (p.team === TEAM.ALPHA) {
        const target = this._nearestVisibleActor(from, actors);
        if (!target) { p.fireTimer = 1.1; continue; }
        p.fireTimer = 3.2 + Math.random() * 2.4;
        this._fireNoise(from);
        this._damageActor(target, burst, { by: p.name, position: from });
      } else {
        const target = this._nearestVisibleFriend(from, friends);
        if (!target) { p.fireTimer = 1.1; continue; }
        p.fireTimer = 3.2 + Math.random() * 2.4;
        target.sim.health -= burst;
        if (target.sim.health > 0) continue;
        target.sim.health = 0;
        this.roster.credit(p, target, false);
        target.respawnAt = this.time + 6;
        this._feed(p, target, 'rifle', false);
        this._checkScoreLimit();
      }
    }
  }

  /** A friendly operator's burst, heard in the world at their position. */
  _fireNoise(position) {
    this.engine.bus.emit('audio:play', {
      id: 'enemy_fire', position: position.clone(), volume: 0.38, pitch: 1.06,
    });
  }

  /* ----------------------------------------------------------------- damage */

  /**
   * Route damage into the AI module's own resolver so a death produced here is
   * indistinguishable from one the player caused — same ragdoll, same FX, same
   * `actor:killed`. Guarded, because that resolver is another agent's private
   * surface; without it, friendly operators simply stop scoring rather than
   * leaving half-dead bots standing around.
   */
  _damageActor(actor, damage, info) {
    const ai = this.ai;
    if (!actor?.alive || !ai) return;
    if (typeof ai._damageActor !== 'function') return;

    _dir.copy(actor.position).sub(info.position || actor.position);
    _dir.y = 0;
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1); else _dir.normalize();
    _pt.copy(actor.position).setY(actor.position.y + 0.15);

    ai._damageActor(actor, damage, {
      point: _pt, direction: _dir, headshot: !!info.headshot,
      limb: 'chest', by: info.by,
    }, this.engine);

    // The AI's damage path treats every hit as evidence of the *player's*
    // position, because until now the player was the only thing that could
    // shoot. Point the contact at whoever actually fired instead.
    if (actor.alive && actor.percept && info.position) {
      actor.percept.lastKnown.copy(info.position);
    }
  }

  _nearestVisibleActor(from, actors) {
    let best = null, bestD = SIM_RANGE;
    for (const a of actors) {
      if (!a.alive) continue;
      const d = from.distanceTo(a.position);
      if (d >= bestD) continue;
      if (!this._visible(from, a.position)) continue;
      best = a; bestD = d;
    }
    return best;
  }

  _nearestVisibleFriend(from, friends) {
    let best = null, bestD = SIM_RANGE;
    for (const f of friends) {
      const d = from.distanceTo(f.sim.position);
      if (d >= bestD) continue;
      if (!this._visible(from, f.sim.position)) continue;
      best = f; bestD = d;
    }
    return best;
  }

  _visible(a, b) {
    if (!this.collision?.raycast) return true;
    _from.copy(a).setY(a.y + 1.4);
    _dir.copy(b).setY(b.y + 1.0).sub(_from);
    const dist = _dir.length();
    if (dist < 1) return true;
    _dir.multiplyScalar(1 / dist);
    return !this.collision.raycast(_from, _dir, dist - 0.4);
  }

  /* ------------------------------------------------------------------ flow */

  _tied() { return this.roster.teams[0].score === this.roster.teams[1].score; }

  _checkScoreLimit() {
    const limit = Config.match.scoreLimit;
    const a = this.roster.teams[0].score, b = this.roster.teams[1].score;
    if (this.state === MatchState.OVERTIME && a !== b) return this._end();
    if (a >= limit || b >= limit) this._end();
  }

  _enterOvertime() {
    this.overtime = true;
    this.timeLeft = OVERTIME_SEC;
    this._setState(MatchState.OVERTIME);
    this.engine.bus.emit('match:callout', {
      title: 'OVERTIME', sub: 'SUDDEN DEATH — NEXT ELIMINATION WINS', kind: 'bad', dwell: 3.4,
    });
    this.engine.bus.emit('match:objective', { text: 'SUDDEN DEATH', sub: 'NEXT ELIMINATION WINS', dwell: 9 });
  }

  _end() {
    if (this.state === MatchState.POST) return;
    this._setState(MatchState.POST);
    const a = this.roster.teams[0].score, b = this.roster.teams[1].score;
    const me = this.roster.player;
    const summary = {
      result: a > b ? 'win' : b > a ? 'lose' : 'draw',
      teamA: this.roster.teams[0].name, teamB: this.roster.teams[1].name,
      scoreA: a, scoreB: b,
      kills: me.kills, deaths: me.deaths, score: me.score,
      headshots: me.headshots, bestStreak: me.bestStreak,
      accuracy: this._shotsFired ? Math.round((this._shotsHit / this._shotsFired) * 100) : 0,
      board: this.roster.snapshot(),
    };
    this.engine.bus.emit('match:objective', { text: '', sub: '' });
    this.engine.bus.emit('match:end', summary);
  }

  restart() {
    this.roster.reset();
    this.streaks.reset();
    this.timeLeft = Config.match.timeLimitSec;
    this.overtime = false;
    this._warned = false;
    this._shotsFired = this._shotsHit = 0;
    this.score.player = this.score.enemy = 0;
    this._respawnTimer = 0;
    this.engine.bus.emit('match:uav', { active: false });
    this._announceObjective();
    this._setState(MatchState.LIVE);
    const player = this.player;
    if (player) { player.state.alive = true; this._respawnPlayer(player); }
  }

  /**
   * The objective is announced, not displayed.
   *
   * `match:objective` used to be a request to pin a banner up for the rest of
   * the round. It is now an announcement with a dwell: the HUD shows it as a
   * card on the top-centre axis and dismisses it. This matters here and not
   * only in the HUD, because it changes when this module is allowed to speak —
   * an announcement is only worth making on a real change of situation (round
   * start, sudden death, a restart, a killstreak reward handing control back),
   * which is exactly the set of callers below. Re-emitting the same text on a
   * timer would put the banner straight back.
   *
   * `dwell` is the sender's call because the sender knows the weight: the
   * opening brief can afford a long read, sudden death cannot be missed.
   */
  _announceObjective() {
    this.engine.bus.emit('match:objective', {
      text: 'ELIMINATE HOSTILE FORCES',
      sub: `FIRST TO ${Config.match.scoreLimit} ELIMINATIONS`,
      dwell: 7,
    });
  }

  _setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.engine?.bus.emit('match:state', { state: next });
  }

  /* ------------------------------------------------------------------- api */

  _syncView() {
    const v = this._view;
    v.scoreA = this.roster.teams[0].score;
    v.scoreB = this.roster.teams[1].score;
    v.scoreLimit = Config.match.scoreLimit;
    v.timeLeft = this.timeLeft;
    v.overtime = this.overtime;
    v.respawnIn = this._respawnTimer;
    v.uavActive = this.streaks.uavActive;

    // Written in place: the HUD reads this every frame and must not be handed a
    // fresh array sixty times a second.
    const sims = this.roster.livingSims(TEAM.ALPHA);
    this._allyBuf.length = 0;
    for (const p of sims) this._allyBuf.push(p.sim.position);
    v.allyPositions = this._allyBuf;
  }

  /** HUD read surface. */
  view() { return this._view; }
  scoreboard() { return this.roster.snapshot(); }

  dispose() {}
}

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _from = new THREE.Vector3();
const _pt = new THREE.Vector3();
