import { Config } from '../core/Config.js';

/**
 * OWNER: gameplay agent.
 *
 * Match flow: state machine (warmup -> live -> post), score, streaks,
 * respawn handling, objective logic and end-of-match summary.
 * Emits 'match:state' whenever the phase changes.
 */
export const MatchState = {
  WARMUP: 'warmup',
  LIVE: 'live',
  POST: 'post',
};

export class MatchModule {
  constructor() {
    this.state = MatchState.WARMUP;
    this.timeLeft = Config.match.timeLimitSec;
    this.score = { player: 0, enemy: 0 };
    this.streak = 0;
    this._respawnTimer = 0;
  }

  async init(engine) {
    engine.bus.on('actor:killed', ({ by, headshot }) => {
      if (by !== 'player') return;
      this.score.player += headshot ? 150 : 100;
      this.streak++;
      engine.bus.emit('ui:notify', {
        kind: 'streak',
        text: this.streak >= 3 ? `${this.streak} KILLSTREAK` : '',
      });
    });

    engine.bus.on('player:died', () => {
      this.streak = 0;
      this._respawnTimer = Config.match.respawnDelaySec;
      engine.bus.emit('match:state', { state: 'respawning' });
    });

    this._setState(MatchState.LIVE, engine);
    engine.match = this;
  }

  _setState(next, engine) {
    if (this.state === next) return;
    this.state = next;
    engine.bus.emit('match:state', { state: next });
  }

  update(dt, engine) {
    if (this.state !== MatchState.LIVE) return;

    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this._setState(MatchState.POST, engine);
      return;
    }

    const player = engine.get('player');
    if (player && !player.state.alive) {
      this._respawnTimer -= dt;
      if (this._respawnTimer <= 0) this._respawnPlayer(engine, player);
    } else if (player) {
      // Regenerating health, CoD-style: delay then fast heal.
      const s = player.state;
      if (s.health < s.maxHealth) {
        this._regenDelay = Math.max(0, (this._regenDelay ?? 0) - dt);
        if (this._regenDelay <= 0) s.health = Math.min(s.maxHealth, s.health + 32 * dt);
      }
    }
  }

  _respawnPlayer(engine, player) {
    const level = engine.get('level');
    const spawn = level?.pickSpawn(0);
    if (spawn) {
      player.state.position.copy(spawn.position).setY(Config.player.height * 0.5 + 0.05);
      player.state.yaw = spawn.yaw;
    }
    player.state.velocity.set(0, 0, 0);
    player.state.health = player.state.maxHealth;
    player.state.alive = true;
    engine.bus.emit('player:spawn', { position: player.state.position, yaw: player.state.yaw });
    this._setState(MatchState.LIVE, engine);
  }

  dispose() {}
}
