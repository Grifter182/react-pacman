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
 *
 * And the rule that stops them being ghosts, which is the newer problem:
 *
 *   - Out of contact a bot does not wander. It goes to the place the squad has
 *     looked at least recently (SquadIntel coverage), or to a decaying report
 *     of contact if there is one (SquadIntel marks). Neither channel is told
 *     where the player is; the first is pure map coverage and the second is a
 *     rumour with a half-life. Together they are why a fight starts at all.
 *   - Only a bounded number of the squad have permission to shoot the player at
 *     once (`a.mayFire`, set by AiModule). The rest keep manoeuvring. Finding
 *     the player more often must not mean being shot by seven rifles at once.
 */

export const Tactic = {
  IDLE: 'idle',
  PATROL: 'patrol',
  SUSPICIOUS: 'suspicious',
  ADVANCE: 'advance',
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
    sweepGoal: null,     // coverage cell this bot owes a visit to
    mark: null,          // SquadIntel contact this bot is walking to, if any
    markTimer: 0,
    blindUntil: 0,       // sweepers ignore unseen contacts until this time
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
    // A bot that stops patrolling is no longer going where it said it would.
    // Handing the claim back is what stops one interrupted sweep leg marking a
    // corner of the map as covered for the rest of the match.
    if (b.tactic === Tactic.PATROL && tactic !== Tactic.PATROL) ctx.intel?.release(a.id);
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
    const ctx = this.ctx;
    b.crouch = false;
    b.wantFire = false;

    // A live contact anywhere the squad knows about outranks routine patrol.
    // This is the whole reason the two sides meet: one bot seeing something,
    // one bot going down, one loud shot, and the rest of the squad has a place
    // to be. The mark decays (SquadIntel, ~6 s half-life) so this pull fades
    // on its own if nothing further happens.
    if (b.tactic !== Tactic.ADVANCE && a.role !== 'sweep') {
      b.markTimer -= dt;
      if (b.markTimer <= 0) {
        b.markTimer = 1.1 + Math.random() * 0.8;
        const m = ctx.intel?.best(a.position, ctx.time, { minHeat: 0.22, maxDist: 95, maxClaims: 4 });
        if (m) {
          ctx.intel.claim(m, ctx.time);
          b.mark = m;
          this._set(a, Tactic.ADVANCE);
          ctx.requestPath(a, m.pos, 'advance');
          b.timer = 0;
        }
      }
    }

    if (b.tactic === Tactic.ADVANCE) { this._advance(dt, a); return; }

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

    // PATROL: cover ground. The old rule picked a waypoint uniformly at random
    // about 26 m off, which is a random walk — measured, a bot's expected
    // displacement over a 60 s window was under 40 m on a map 85 m deep, so the
    // half of the level the player was standing in simply never got visited.
    // Now the destination is the *stalest* place the squad can reach, and the
    // long pauses are gone: patrol is a job, not a stroll.
    b.desiredSpeed = 3.6;
    if (a.pathDone && a.path) {
      a.path = null;
      if (Math.random() < 0.12) { this._set(a, Tactic.IDLE); b.timer = 0.7 + Math.random() * 1.8; return; }
    }
    if (!a.path || a.pathDone) {
      // If the last sweep leg was interrupted (shot at, pulled into a search)
      // and that ground is still unwatched, finish it. Re-deciding from scratch
      // every time is how the frontier stopped moving: the squad kept picking
      // the nearest stale cell to wherever the last interruption left it.
      let dest = null;
      if (b.sweepGoal && ctx.intel && (a.pathFails || 0) < 2
          && ctx.intel.ageAt(b.sweepGoal, ctx.time) > 25
          && a.position.distanceTo(b.sweepGoal) > 7) {
        dest = b.sweepGoal;
      } else {
        b.sweepGoal = null;
        dest = this._patrolPoint(a);
        if (dest && ctx.intel) b.sweepGoal = dest.clone();
      }
      // A rejected leg must give the ground back, or the coverage map records
      // where the squad *meant* to go instead of where it has been.
      if (!dest || !ctx.requestPath(a, dest, 'patrol')) {
        if (dest) ctx.intel?.unpledge(dest);
        b.sweepGoal = null;
        b.timer = 1;
      }
    }
    this._lookAlongMotion(a);
  }

  /**
   * Walk to a reported contact and look at it. Nothing here knows where the
   * player is: the destination is a decaying *place*, and on arrival the mark
   * is cooled so an empty room stops attracting the rest of the squad. A player
   * who broke line of sight and left is not followed — they are missed, at the
   * spot they were last relevant.
   */
  _advance(dt, a) {
    const b = a.brain;
    const ctx = this.ctx;
    const m = b.mark;
    if (!m || ctx.intel?.heat(m, ctx.time) < 0.12) { b.mark = null; this._set(a, Tactic.PATROL); return; }

    b.desiredSpeed = 4.3;
    b.aimPoint.copy(m.pos).setY(m.pos.y + 0.7);
    this._lookAlongMotion(a, 0.65);

    // `pathDone`, not `!path`: requestPath clears pathDone the moment the leg is
    // asked for, and a failed A* sets it again — so this one flag covers
    // arrival, an unreachable mark, and a search that never got served.
    const near = a.position.distanceTo(m.pos) < 6;
    if (near || a.pathDone || b.since > 22) {
      if (near) ctx.intel.clear(m, ctx.time);
      b.mark = null;
      b.markTimer = 3.5 + Math.random() * 3;   // do not immediately re-latch
      this._set(a, Tactic.PATROL);
    }
  }

  /**
   * Where to look next. Coverage first — SquadIntel hands back the position of
   * a real navmesh node in the main region, so "worth visiting" and "reachable"
   * are the same structure and a patrol leg cannot be issued to a ledge no bot
   * can path onto. The authored waypoint list is the fallback for a level that
   * publishes no navmesh coverage, and random sampling behind that.
   */
  _patrolPoint(a) {
    const ctx = this.ctx;
    const sweep = ctx.intel?.stalest(a.position, ctx.time, a.id);
    if (sweep) return sweep;

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

    // A bot on sweep duty that has not actually SEEN anything does not go
    // hunting a bearing: it turns, looks, and gets back to walking the map.
    // Measured, the five-leg room-clear was consuming most of the squad's time
    // on contacts that could never resolve — the shooter was a friendly
    // operator sim with no body in the world — and while it ran, nobody was
    // covering ground. Seeing something still triggers the full search.
    const blind = this.ctx.time - p.lastSeen > 12;
    if (a.role === 'sweep' && blind) {
      // Already looked recently: keep sweeping. Without this cooldown a sweeper
      // under sustained fire from an unseen shooter oscillates between patrol
      // and a standing stare forever — measured, one sat 28.9 m from the player
      // for thirty seconds doing exactly that, which is also why it never got
      // inside the 25 m the acceptance probe counts.
      if (this.ctx.time < (b.blindUntil || 0)) {
        p.alert = 0; p.lastHeard = -999;
        this._relaxed(dt, a);
        return;
      }
      if (b.tactic !== Tactic.SUSPICIOUS) { this._set(a, Tactic.SUSPICIOUS); b.timer = 1.3 + Math.random(); }
      // Looking, not stopping: a bot that plants itself is a bot that is not
      // covering ground.
      b.desiredSpeed = 1.8;
      b.aimPoint.copy(known).setY(known.y + 0.6);
      b.timer -= dt;
      if (b.timer <= 0) {
        p.alert = 0; p.lastHeard = -999;
        b.blindUntil = this.ctx.time + 13 + Math.random() * 6;
        this._set(a, Tactic.PATROL);
      }
      return;
    }

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
      // A bot that actually saw something clears the room properly. One that
      // only took a round from an unseen bearing gives it two looks and gets
      // back to work — measured, the five-step sweep was eating most of the
      // squad's time on contacts that were never resolvable.
      if (b.searchStep > (blind ? 2 : 5)) {
        // Given up: drop back to patrol from wherever the search ended.
        a.percept.alert = 0;
        a.percept.lastSeen = -999;
        a.percept.lastHeard = -999;
        // Searched and found nothing: cool whatever report sent the squad here,
        // so the rest of them stop converging on an empty room.
        const stale = this.ctx.intel?.best(b.searchOrigin, this.ctx.time, { minHeat: 0.05, maxDist: 14, maxClaims: 99 });
        if (stale) this.ctx.intel.clear(stale, this.ctx.time);
        b.markTimer = 4;
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
    b.wantFire = a.percept.spotted && a.mayFire !== false && Math.random() < 0.35;

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
      b.wantFire = a.percept.spotted && a.mayFire !== false;
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
    b.wantFire = b.peekOut && a.percept.spotted && a.mayFire !== false;

    if (!a.percept.spotted && ctx.time - a.percept.lastSeen > 1.4) {
      // Lost them from cover: pin the position rather than charging it.
      this._set(a, Math.random() < 0.55 ? Tactic.SUPPRESS : Tactic.FLANK);
      return;
    }

    // No permission to shoot: do something useful with the time rather than
    // stand in cover miming a firefight. This is what turns a capped squad into
    // an encircling one instead of a queue.
    if (a.mayFire === false && a.percept.spotted && b.coverTime > 1.3) {
      this._set(a, Math.random() < 0.65 ? Tactic.FLANK : Tactic.REPOSITION);
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
    b.wantFire = a.mayFire !== false;
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
    b.wantFire = a.percept.spotted && a.mayFire !== false && dist < 9;
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
    b.wantFire = a.percept.spotted && a.mayFire !== false && dist < 12 && Math.random() < 0.25;
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
