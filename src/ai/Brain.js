import * as THREE from 'three';

/**
 * OWNER: AI agent.
 *
 * The behaviour layer: a hierarchical state machine over one blackboard per
 * actor. Two tiers —
 *
 *   **Posture** (relaxed / alerted / combat) is chosen from perception alone
 *   and decides what the lower tier is even allowed to consider.
 *   **Tactic** is the concrete state: patrol, investigate, search, engage,
 *   take-cover, suppress, flank, reposition, retreat.
 *
 * The rules that stop bots being a firing squad walking into your crosshair:
 *
 *   - A bot that can see you and is *not* in cover moves to cover before it
 *     settles into a firing rhythm. It shoots on the way, badly.
 *   - A bot in cover peeks on a cycle with a randomised dwell, and re-peeks
 *     from a *different* slot when it can, so you cannot pre-aim one corner.
 *   - Cover is claimed, so two bots never pile into the same crate.
 *   - Standing in one place is punished: after a few seconds of trading shots
 *     the bot repositions, and roughly a third of the squad will flank rather
 *     than reposition laterally.
 *   - Losing sight of you does not reset the bot. It searches the last known
 *     position, then the places you could have gone from it.
 */

export const Tactic = {
  IDLE: 'idle',
  PATROL: 'patrol',
  SUSPICIOUS: 'suspicious',
  SEARCH: 'search',
  ENGAGE: 'engage',
  TAKE_COVER: 'takeCover',
  SUPPRESS: 'suppress',
  FLANK: 'flank',
  REPOSITION: 'reposition',
  RETREAT: 'retreat',
  DEAD: 'dead',
};

export function createBrain() {
  return {
    tactic: Tactic.IDLE,
    posture: 'relaxed',
    since: 0,
    timer: 0,
    dwell: 0,
    peekOut: false,
    peekTimer: 0,
    peekSide: 0,
    combatTime: 0,
    coverTime: 0,
    searchStep: 0,
    entered: true,
    searchOrigin: new THREE.Vector3(),
    patrolTarget: null,
    goal: new THREE.Vector3(),
    hasGoal: false,
    wantFire: false,
    crouch: false,
    desiredSpeed: 0,
    aimPoint: new THREE.Vector3(),
    strafe: 0,
    lastHurt: -99,
  };
}

export class Brain {
  constructor(ctx) { this.ctx = ctx; }

  /**
   * One decision tick. Runs at ~8 Hz per actor; the continuous parts (aim
   * point, fire permission) are refreshed every frame by `refresh`.
   */
  tick(dt, a) {
    const b = a.brain;
    const p = a.percept;
    const ctx = this.ctx;
    b.since += dt;

    if (!a.alive) { this._set(a, Tactic.DEAD); return; }

    // Steering intents are re-declared every tick; a state that wants them has
    // to say so, otherwise a stale goal from a previous tactic keeps pulling.
    b.hasGoal = false;
    b.strafe = 0;

    /* --- posture ---------------------------------------------------------- */
    const fresh = ctx.time - p.lastSeen;
    if (p.spotted || fresh < 2.5) b.posture = 'combat';
    else if (p.alert > 0.30 || ctx.time - p.lastHeard < 6) b.posture = 'alerted';
    else if (b.posture !== 'relaxed' && ctx.perception.forgotten(a, ctx.time)) b.posture = 'relaxed';

    if (b.posture === 'combat') b.combatTime += dt; else b.combatTime = 0;

    /* --- tactic ----------------------------------------------------------- */
    switch (b.posture) {
      case 'combat': this._combat(dt, a); break;
      case 'alerted': this._alerted(dt, a); break;
      default: this._relaxed(dt, a); break;
    }
  }

  _set(a, tactic) {
    const b = a.brain;
    if (b.tactic === tactic) return;
    const ctx = this.ctx;
    // Releasing the claim on the way out is what keeps cover circulating.
    if ((b.tactic === Tactic.ENGAGE || b.tactic === Tactic.TAKE_COVER) && a.cover
        && tactic !== Tactic.ENGAGE && tactic !== Tactic.TAKE_COVER) {
      ctx.cover.release(a.cover, a.id);
      a.cover = null;
    }
    b.tactic = tactic;
    b.since = 0;
    // Consumed by whichever state wants one-shot entry logic. `since` cannot
    // serve that purpose: the brain ticks at 8 Hz, so by the first update of a
    // new state `since` is already a full tick old.
    b.entered = true;
    b.peekOut = false;
    b.peekTimer = 0;
  }

  /* ---------------------------------------------------------------- relaxed */

  _relaxed(dt, a) {
    const b = a.brain;
    b.crouch = false;
    b.wantFire = false;

    if (b.tactic !== Tactic.PATROL && b.tactic !== Tactic.IDLE) this._set(a, Tactic.PATROL);

    if (b.tactic === Tactic.IDLE) {
      b.desiredSpeed = 0;
      b.timer -= dt;
      // Idle is a look-around, not a statue: the aim point wanders.
      if (b.since < 0.05 || !b.hasGoal) {
        b.aimPoint.copy(a.position).add(_v.set(Math.sin(a.yaw), 0, Math.cos(a.yaw)).multiplyScalar(6));
      }
      if (b.timer <= 0) this._set(a, Tactic.PATROL);
      return;
    }

    // PATROL: walk the navmesh between distant points, pausing at some of them.
    // Arrival is checked before a new leg is requested — the request clears
    // `pathDone`, so testing it afterwards would never see the arrival.
    b.desiredSpeed = 2.1;
    if (a.pathDone && a.path) {
      a.path = null;
      if (Math.random() < 0.45) { this._set(a, Tactic.IDLE); b.timer = 1.5 + Math.random() * 4; return; }
    }
    if (!a.path || a.pathDone) {
      const dest = this._patrolPoint(a);
      if (dest) this.ctx.requestPath(a, dest, 'patrol');
      else b.timer = 1;
    }
    this._lookAlongMotion(a);
  }

  _patrolPoint(a) {
    const ctx = this.ctx;
    // Authored waypoints when the level offers them — they follow the lanes and
    // read as patrolling; navmesh sampling as the fallback so this still works
    // on a level that publishes none.
    const wps = ctx.level?.navPoints;
    if (wps && wps.length) {
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < 6; i++) {
        const p = wps[(Math.random() * wps.length) | 0];
        const d = p.distanceTo(a.position);
        if (d < 7) continue;
        const score = -Math.abs(d - 26) + Math.random() * 12;
        if (score > bestScore) { bestScore = score; best = p; }
      }
      if (best) return best;
    }
    return ctx.nav.randomPoint(Math.random, a.position, 45);
  }

  /* ---------------------------------------------------------------- alerted */

  _alerted(dt, a) {
    const b = a.brain;
    const p = a.percept;
    b.wantFire = false;
    b.crouch = false;

    const known = p.lastKnown;
    const dist = a.position.distanceTo(known);

    if (b.tactic !== Tactic.SUSPICIOUS && b.tactic !== Tactic.SEARCH) {
      // A contact that never resolved: face it first, then go and look.
      this._set(a, dist > 4 ? Tactic.SEARCH : Tactic.SUSPICIOUS);
      b.searchOrigin.copy(known);
      b.searchStep = 0;
      b.timer = 1.2 + Math.random();
    }

    if (b.tactic === Tactic.SUSPICIOUS) {
      b.desiredSpeed = 0.6;
      b.aimPoint.copy(known).setY(known.y + 0.6);
      b.timer -= dt;
      if (b.timer <= 0) { this._set(a, Tactic.SEARCH); b.searchStep = 0; }
      return;
    }

    // SEARCH: last known position first, then a widening sweep of the places a
    // target could have reached in the time since. Bots clear rooms, not points.
    b.desiredSpeed = 3.0;
    b.aimPoint.copy(known).setY(known.y + 0.6);
    if (!a.path || a.pathDone) {
      let dest;
      if (b.searchStep === 0) {
        // Lead the last known position by the velocity they had when seen.
        dest = _v.copy(known).addScaledVector(p.lastKnownVel, 0.9);
        dest.y = known.y;
      } else {
        const r = 4 + b.searchStep * 3.5;
        const ang = Math.random() * Math.PI * 2;
        dest = _v.set(b.searchOrigin.x + Math.cos(ang) * r, b.searchOrigin.y,
          b.searchOrigin.z + Math.sin(ang) * r);
      }
      b.searchStep++;
      const snapped = this.ctx.nav.randomPoint(Math.random, dest, 6) || dest;
      this.ctx.requestPath(a, snapped, 'search');
      if (b.searchStep > 5) {
        // Given up: drop back to patrol from wherever the search ended.
        a.percept.alert = 0;
        a.percept.lastSeen = -999;
        a.percept.lastHeard = -999;
        this._set(a, Tactic.PATROL);
      }
    }
    this._lookAlongMotion(a, 0.4);
  }

  /* ----------------------------------------------------------------- combat */

  _combat(dt, a) {
    const b = a.brain;
    const p = a.percept;
    const ctx = this.ctx;
    const target = ctx.player.state.position;
    const dist = a.position.distanceTo(target);

    b.aimPoint.copy(p.spotted ? target : p.lastKnown);
    b.aimPoint.y += p.spotted ? 0.30 : 0.45;

    /* --- forced transitions ------------------------------------------------ */
    const hurt = a.health / a.maxHealth;
    if (hurt < 0.3 && b.tactic !== Tactic.RETREAT && Math.random() < dt * 1.4) {
      this._set(a, Tactic.RETREAT);
    }

    switch (b.tactic) {
      case Tactic.ENGAGE: this._engage(dt, a, dist); break;
      case Tactic.TAKE_COVER: this._takeCover(dt, a); break;
      case Tactic.SUPPRESS: this._suppress(dt, a); break;
      case Tactic.FLANK: this._flank(dt, a, dist); break;
      case Tactic.REPOSITION: this._reposition(dt, a); break;
      case Tactic.RETREAT: this._retreat(dt, a, dist); break;
      default:
        this._set(a, Tactic.TAKE_COVER);
        break;
    }
  }

  /** Move to the best cover against the current threat, shooting on the way. */
  _takeCover(dt, a) {
    const b = a.brain;
    const ctx = this.ctx;
    const threat = a.percept.spotted ? ctx.player.state.position : a.percept.lastKnown;

    if (!a.cover || b.since > 5.5) {
      const c = ctx.cover.best({
        from: a.position, threat, maxDist: b.since > 5.5 ? 30 : 20,
        now: ctx.time, actorId: a.id, crowd: ctx.actors,
        band: [8, 21],
      });
      if (c) {
        if (a.cover) ctx.cover.release(a.cover, a.id);
        a.cover = c;
        ctx.requestPath(a, c.pos, 'cover');
        b.since = 0;
      } else if (b.since > 2) {
        // Nowhere to hide: fight from where you stand rather than dithering.
        this._set(a, Tactic.ENGAGE);
        return;
      }
    }

    b.desiredSpeed = 5.0;
    b.crouch = false;
    // Suppressive fire while moving, at a heavy accuracy penalty (the combat
    // system's aim error is already wide because contact keeps breaking).
    b.wantFire = a.percept.spotted && Math.random() < 0.35;

    if (a.cover && a.position.distanceTo(a.cover.pos) < 1.1) {
      this._set(a, Tactic.ENGAGE);
      b.coverTime = 0;
    }
  }

  /**
   * The peek cycle. Dwell times are randomised per cycle and the slot
   * alternates, so a player who pre-aims the last corner gets punished.
   */
  _engage(dt, a, dist) {
    const b = a.brain;
    const ctx = this.ctx;
    b.coverTime += dt;

    const inCover = a.cover && a.position.distanceTo(a.cover.pos) < 1.6;
    // Refresh the claim: an occupied position must not come free under someone
    // who is still standing in it.
    if (a.cover) a.cover.lastUsed = ctx.time;
    if (!inCover) {
      // Not at cover: stand and fight, but keep moving laterally.
      b.desiredSpeed = 1.6;
      b.strafe = Math.sin(ctx.time * 1.3 + a.id) * 0.8;
      b.crouch = dist > 24;
      b.wantFire = a.percept.spotted;
      if (b.coverTime > 3.5) this._set(a, Tactic.TAKE_COVER);
      return;
    }

    b.strafe = 0;
    b.peekTimer -= dt;
    if (b.peekTimer <= 0) {
      b.peekOut = !b.peekOut;
      if (b.peekOut) {
        // Alternate slots when both exist; a bot that always leans the same way
        // is a bot you only have to learn once.
        const slots = [];
        if (a.cover.left) slots.push(1);
        if (a.cover.right) slots.push(-1);
        b.peekSide = slots.length ? slots[(Math.random() * slots.length) | 0] : 0;
        if (slots.length === 2 && b.peekSide === b.lastPeekSide && Math.random() < 0.75) {
          b.peekSide = -b.peekSide;
        }
        b.lastPeekSide = b.peekSide;
        b.peekTimer = 1.05 + Math.random() * 1.55;
      } else {
        b.peekTimer = 0.55 + Math.random() * 1.1;
      }
    }

    const slot = b.peekOut
      ? (b.peekSide > 0 ? a.cover.left : b.peekSide < 0 ? a.cover.right : a.cover.pos)
      : a.cover.pos;
    b.goal.copy(slot || a.cover.pos);
    b.hasGoal = true;
    b.desiredSpeed = 2.6;
    // Behind cover the bot crouches when the cover is low; peeking stands it up.
    b.crouch = a.cover.crouch && !b.peekOut;
    b.wantFire = b.peekOut && a.percept.spotted;

    if (!a.percept.spotted && ctx.time - a.percept.lastSeen > 1.4) {
      // Lost them from cover: pin the position rather than charging it.
      this._set(a, Math.random() < 0.55 ? Tactic.SUPPRESS : Tactic.FLANK);
      return;
    }

    // Grenades flush a target that is not moving.
    if (b.peekOut && a.percept.spotted) {
      const pv = ctx.player.state.velocity;
      if (Math.hypot(pv.x, pv.z) < 1.6 && dist > 6 && dist < 24) {
        ctx.combat.tryThrow(a, ctx.player.state.position, ctx.time);
      }
    }

    // Long trades get boring and predictable: move.
    if (b.coverTime > 5 + Math.random() * 5) {
      this._set(a, Math.random() < 0.42 ? Tactic.FLANK : Tactic.REPOSITION);
    }
  }

  /** Fire on the last known position to keep the player's head down. */
  _suppress(dt, a) {
    const b = a.brain;
    const ctx = this.ctx;
    b.desiredSpeed = 0;
    b.crouch = !!(a.cover && a.cover.crouch) && Math.random() < 0.5;
    b.wantFire = true;
    b.aimPoint.copy(a.percept.lastKnown);
    b.aimPoint.y += 0.55 + Math.sin(ctx.time * 3 + a.id) * 0.25;
    if (a.cover) { b.goal.copy(a.cover.pos); b.hasGoal = true; }

    if (a.percept.spotted) { this._set(a, Tactic.ENGAGE); return; }
    if (b.since > 2.2 + Math.random() * 2) {
      this._set(a, Math.random() < 0.5 ? Tactic.FLANK : Tactic.SEARCH);
    }
  }

  /** Wide arc onto the target's flank, using cover that faces the new angle. */
  _flank(dt, a, dist) {
    const b = a.brain;
    const ctx = this.ctx;
    const threat = a.percept.spotted ? ctx.player.state.position : a.percept.lastKnown;

    if (a.path && a.pathDone) { this._set(a, Tactic.ENGAGE); b.coverTime = 0; return; }

    if (!a.path || a.pathDone) {
      const c = ctx.cover.best({
        from: a.position, threat, maxDist: 34, now: ctx.time,
        actorId: a.id, crowd: ctx.actors, band: [7, 18], requireFlank: true,
      });
      if (c) {
        if (a.cover) ctx.cover.release(a.cover, a.id);
        a.cover = c;
        ctx.requestPath(a, c.pos, 'flank');
      } else {
        this._set(a, Tactic.TAKE_COVER);
        return;
      }
    }

    b.desiredSpeed = 5.4;
    b.crouch = false;
    // Flanking bots hold fire — the whole point is not to announce the move.
    b.wantFire = a.percept.spotted && dist < 9;
    if (b.since > 9) this._set(a, Tactic.TAKE_COVER);
  }

  /** Short lateral move to a different piece of cover on the same side. */
  _reposition(dt, a) {
    const b = a.brain;
    const ctx = this.ctx;
    const threat = a.percept.spotted ? ctx.player.state.position : a.percept.lastKnown;

    if (a.path && a.pathDone && b.since > 0.2) { this._set(a, Tactic.ENGAGE); b.coverTime = 0; return; }

    if (b.entered) {
      b.entered = false;
      const c = ctx.cover.best({
        from: a.position, threat, maxDist: 15, now: ctx.time, actorId: a.id,
        crowd: ctx.actors, band: [9, 20],
      });
      if (c && c !== a.cover) {
        if (a.cover) ctx.cover.release(a.cover, a.id);
        a.cover = c;
        ctx.requestPath(a, c.pos, 'reposition');
      } else { this._set(a, Tactic.ENGAGE); return; }
    }
    b.desiredSpeed = 5.2;
    b.crouch = false;
    b.wantFire = false;
    if (b.since > 6) this._set(a, Tactic.ENGAGE);
  }

  /** Break contact, heal, come back. */
  _retreat(dt, a, dist) {
    const b = a.brain;
    const ctx = this.ctx;
    b.wantFire = a.percept.spotted && dist < 12 && Math.random() < 0.25;
    b.desiredSpeed = 5.6;
    b.crouch = false;

    if (!a.path || a.pathDone) {
      const away = _v.subVectors(a.position, ctx.player.state.position).setY(0);
      if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
      away.normalize().multiplyScalar(18);
      const dest = _v2.copy(a.position).add(away);
      const snapped = ctx.nav.randomPoint(Math.random, dest, 9) || dest;
      ctx.requestPath(a, snapped, 'retreat');
    }

    // Bots heal out of contact, slowly. Coming back at 60% is what makes a
    // retreat a decision rather than a death sentence.
    if (ctx.time - a.lastDamaged > 4) a.health = Math.min(a.maxHealth, a.health + dt * 9);
    if (a.health > a.maxHealth * 0.62 || (dist > 32 && b.since > 6)) {
      this._set(a, Tactic.TAKE_COVER);
    }
  }

  _lookAlongMotion(a, blend = 1) {
    const b = a.brain;
    const v = a.velocity;
    if (Math.abs(v.x) + Math.abs(v.z) > 0.25) {
      _v.set(v.x, 0, v.z).normalize().multiplyScalar(8);
      b.aimPoint.lerp(_v2.copy(a.position).add(_v).setY(a.position.y + 0.4), blend);
    }
  }
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
