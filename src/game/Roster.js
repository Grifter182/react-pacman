import * as THREE from 'three';

/**
 * OWNER: gameplay agent.
 *
 * The two squads, as data.
 *
 * WHAT IS REAL AND WHAT IS NOT — read this before changing anything.
 *
 * The AI module owns a fixed squad of fully simulated soldiers, and every one
 * of them is on the hostile team: they navigate, take cover, shoot at the
 * player and die with ragdolls. Those actors are bound one-to-one to hostile
 * roster entries here, so when the player kills one, the scoreboard entry that
 * takes the death is the same soldier that just fell over.
 *
 * The friendly squad has no equivalent in the AI module — its actors all target
 * the player by construction. Rather than fake a second set of bodies, friendly
 * operators are *light* combatants: they hold a real position, patrol the real
 * waypoint graph, and when they engage they deal real damage to a real hostile
 * actor through the AI module's own damage path, so the kill, the ragdoll, the
 * killfeed entry and the score all come from one event. What they do not have
 * is a mesh, a navmesh path or a perception model. They read on the minimap and
 * in the killfeed exactly as they behave.
 *
 * The upshot: nothing on the scoreboard is invented. Every kill in the feed
 * corresponds to a soldier that actually died in the world.
 */

const CALLSIGNS_A = ['HOLLOW', 'BRAVO', 'MERLIN', 'PIKE', 'ROOK', 'ASHEN', 'VECTOR', 'GRANITE', 'HALO', 'CINDER'];
const CALLSIGNS_B = ['JACKAL', 'VULTURE', 'SCORPION', 'ADDER', 'CARRION', 'HYENA', 'LOCUST', 'MANTIS', 'SERAPH', 'WRAITH'];

export const TEAM = { ALPHA: 0, BRAVO: 1 };

export class Roster {
  constructor() {
    this.players = [];
    this.teams = [
      { id: TEAM.ALPHA, name: 'ALPHA', tag: 'FRIENDLY', score: 0 },
      { id: TEAM.BRAVO, name: 'BRAVO', tag: 'HOSTILE', score: 0 },
    ];
    this.player = null;
  }

  /**
   * @param actors    the AI module's actor list (all hostile)
   * @param navPoints authored waypoints the friendly squad patrols
   */
  build(actors, navPoints) {
    this.players.length = 0;
    const usedA = shuffle(CALLSIGNS_A.slice());
    const usedB = shuffle(CALLSIGNS_B.slice());

    this.player = this._make({
      name: 'YOU', team: TEAM.ALPHA, isPlayer: true,
    });
    this.players.push(this.player);

    // Match the friendly squad to the hostile one so neither side is outnumbered.
    const hostiles = actors ? actors.length : 6;
    for (let i = 0; i < Math.max(1, hostiles - 1); i++) {
      const p = this._make({ name: usedA[i % usedA.length], team: TEAM.ALPHA });
      p.sim = makeSim(navPoints, TEAM.ALPHA, i);
      this.players.push(p);
    }
    for (let i = 0; i < hostiles; i++) {
      const p = this._make({ name: usedB[i % usedB.length], team: TEAM.BRAVO });
      p.actor = actors ? actors[i] : null;
      if (p.actor) p.actor.rosterName = p.name;
      this.players.push(p);
    }
  }

  _make({ name, team, isPlayer = false }) {
    return {
      name, team, isPlayer,
      actor: null, sim: null,
      kills: 0, deaths: 0, score: 0,
      streak: 0, bestStreak: 0,
      alive: true, respawnAt: 0,
      headshots: 0,
      // Engagement cadence lives on the roster entry, not on the body, so both
      // squads run the identical firing model whether or not they have a mesh.
      fireTimer: 1 + Math.random() * 4,
      skill: 0.78 + Math.random() * 0.26,
    };
  }

  reset() {
    for (const p of this.players) {
      p.kills = p.deaths = p.score = p.streak = p.bestStreak = p.headshots = 0;
      p.alive = true; p.respawnAt = 0;
      p.fireTimer = 1 + Math.random() * 4;
      if (p.sim) p.sim.health = 100;
    }
    this.teams[0].score = 0;
    this.teams[1].score = 0;
  }

  byActor(actor) {
    for (const p of this.players) if (p.actor === actor) return p;
    return null;
  }

  byName(name) {
    for (const p of this.players) if (p.name === name) return p;
    return null;
  }

  team(id) { return this.players.filter((p) => p.team === id); }

  /** Live friendly operators, for the minimap. */
  livingSims(team) {
    const out = [];
    for (const p of this.players) if (p.team === team && p.sim && p.alive) out.push(p);
    return out;
  }

  /** Award a kill and return the credited streak level. */
  credit(killer, victim, headshot) {
    if (victim) {
      victim.deaths++;
      victim.streak = 0;
      victim.alive = false;
    }
    if (!killer) return 0;
    killer.kills++;
    killer.score += headshot ? 150 : 100;
    if (headshot) killer.headshots++;
    killer.streak++;
    killer.bestStreak = Math.max(killer.bestStreak, killer.streak);
    // Team score in deathmatch is the kill count; the personal score is points.
    const t = this.teams[killer.team];
    if (t && killer.team !== victim?.team) t.score++;
    return killer.streak;
  }

  snapshot() {
    return {
      teams: this.teams.map((t) => ({
        name: t.name, tag: t.tag, score: t.score,
        players: this.players.filter((p) => p.team === t.id).map((p) => ({
          name: p.name, kills: p.kills, deaths: p.deaths, score: p.score,
          bestStreak: p.bestStreak, alive: p.alive, isPlayer: p.isPlayer,
        })),
      })),
    };
  }
}

/**
 * A friendly operator's movement state. They walk the authored waypoint graph
 * at a plausible pace so their minimap blips and their engagement ranges are
 * real distances, not decoration.
 */
function makeSim(navPoints, team, index) {
  const pts = navPoints && navPoints.length ? navPoints : [new THREE.Vector3()];
  const start = pts[(index * 5 + 3) % pts.length];
  return {
    position: start.clone(),
    goal: pts[(index * 7 + 11) % pts.length].clone(),
    speed: 2.4 + Math.random() * 1.1,
    health: 100,
    team,
  };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
