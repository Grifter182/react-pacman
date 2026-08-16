import { noiseVoice, startVoice, decayTo, pluck, SPEED_OF_SOUND } from './Synth.js';

/**
 * OWNER: audio agent.
 *
 * Gunfire, layer by layer.
 *
 * A rifle report is not one sound. What the ear resolves is:
 *
 *   1. MUZZLE BLAST   The propellant gas leaving the bore — a broadband
 *                     transient, effectively an impulse, brightest on axis.
 *   2. BODY           The blast reflected off the shooter and the ground in the
 *                     first few milliseconds; a band-limited noise burst whose
 *                     centre falls as the wavefront expands.
 *   3. PUNCH          The low-frequency pressure step. This is the layer that
 *                     makes a rifle feel like a rifle rather than a firecracker.
 *   4. MECHANISM      Bolt unlocking, carrier travelling, buffer spring ringing,
 *                     bolt slamming into battery. It arrives 8-30 ms *after* the
 *                     shot and it is the single strongest cue that a weapon is
 *                     a machine. Every weapon here has its own spring note.
 *   5. TAIL           The room. Sent to the convolver, weighted by how open the
 *                     space is — a shot in a covered alley is nearly all tail.
 *
 * DISTANCE is modelled properly rather than by turning the volume down:
 *   - arrival is delayed by `d / 343` seconds, so a shot 120 m away lands a
 *     third of a second after its muzzle flash;
 *   - air absorption rolls the top off exponentially with range, which is why
 *     distant fire is a thud and close fire is a crack;
 *   - the crack/tail balance inverts with range, because the direct blast falls
 *     off faster than the reflected energy;
 *   - a slap-back tap at 2·d/343 gives the far report its characteristic double
 *     hit off the far side of the street.
 */

const PROFILES = {
  rifle: {
    gain: 1.00, crack: 3200, crackQ: 0.85, crackDur: 0.055,
    body: [900, 165], bodyDur: 0.24, punch: [195, 44], punchDur: 0.115,
    mech: { delay: 0.018, freq: 3300, ring: 190, level: 0.34 },
    tail: 0.45, spread: 0.9,
  },
  smg: {
    gain: 0.80, crack: 4300, crackQ: 1.05, crackDur: 0.038,
    body: [1150, 260], bodyDur: 0.16, punch: [155, 58], punchDur: 0.075,
    mech: { delay: 0.012, freq: 4100, ring: 260, level: 0.40 },
    tail: 0.30, spread: 0.7,
  },
  dmr: {
    gain: 1.25, crack: 2350, crackQ: 0.7, crackDur: 0.075,
    body: [700, 120], bodyDur: 0.34, punch: [245, 36], punchDur: 0.16,
    mech: { delay: 0.026, freq: 2700, ring: 150, level: 0.30 },
    tail: 0.70, spread: 1.0,
  },
};

export class WeaponAudio {
  constructor(ctx, mixer, noise, opts = {}) {
    this.ctx = ctx;
    this.mix = mixer;
    this.noise = noise;
    this.panningModel = opts.panningModel || 'equalpower';
    this.space = 0.6;
  }

  setSpace(o) { this.space = o; }

  /** Positional node, or a direct connection for the player's own weapon. */
  _out(position, refDistance = 6) {
    if (!position) return { node: this.mix.bus.weapons, panner: null };
    const p = this.ctx.createPanner();
    p.panningModel = this.panningModel;
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.rolloffFactor = 0.85;
    p.maxDistance = 400;
    setPos(p, position);
    p.connect(this.mix.bus.weapons);
    return { node: p, panner: p };
  }

  /**
   * @param o.weapon    weapon id
   * @param o.position  world position, or null for the player's own weapon
   * @param o.distance  metres (computed by the caller from the listener)
   * @param o.volume    0..1 scalar on top of the profile
   */
  fire(o = {}) {
    const prof = PROFILES[o.weapon] || PROFILES.rifle;
    const dist = Math.max(0, o.distance || 0);
    const own = !o.position;
    if (!this.mix.take(own ? 1 : 0.6, 0.6 + prof.tail)) return;

    const ctx = this.ctx;
    const t0 = ctx.currentTime + (own ? 0 : dist / SPEED_OF_SOUND);
    const vol = (o.volume ?? 1) * prof.gain;

    const { node: out } = this._out(o.position);

    // Air absorption: 18 kHz at the muzzle down to a few hundred hertz at the
    // far end of the map. One filter for the whole shot keeps the layers
    // coherent — filtering them separately smears the transient.
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = clamp(18000 * Math.exp(-dist / 42), 380, 20000);
    air.Q.value = 0.6;
    const bus = ctx.createGain();
    bus.gain.value = vol;
    air.connect(bus); bus.connect(out);

    // Direct blast falls off faster than the reverberant field, so the mix
    // between "crack" and "room" inverts across the map.
    const near = Math.exp(-dist / 55);
    const far = 1 - near;

    /* --- 1. muzzle blast ---------------------------------------------------- */
    const crack = noiseVoice(ctx, this.noise, {
      type: 'bandpass', freq: prof.crack, q: prof.crackQ,
      rate: 1 + (Math.random() - 0.5) * 0.10,
    });
    decayTo(crack.gain, t0, 1.15 * (0.35 + near * 0.65), prof.crackDur);
    crack.connect(air);
    startVoice(crack, t0, prof.crackDur + 0.05);

    /* --- 2. body ------------------------------------------------------------ */
    const body = noiseVoice(ctx, this.noise, {
      type: 'lowpass', freq: prof.body[0], q: 0.9, rate: 0.75,
    });
    body._filt.frequency.setValueAtTime(prof.body[0], t0);
    body._filt.frequency.exponentialRampToValueAtTime(prof.body[1], t0 + prof.bodyDur);
    decayTo(body.gain, t0, 0.85, prof.bodyDur * 1.1);
    body.connect(air);
    startVoice(body, t0, prof.bodyDur + 0.08);

    /* --- 3. punch ----------------------------------------------------------- */
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(prof.punch[0], t0);
    osc.frequency.exponentialRampToValueAtTime(prof.punch[1], t0 + prof.punchDur);
    const og = ctx.createGain();
    decayTo(og.gain, t0, 0.75 * (0.45 + near * 0.55), prof.punchDur * 1.15);
    osc.connect(og); og.connect(bus);        // bypasses `air`: the low end carries
    osc.start(t0); osc.stop(t0 + prof.punchDur + 0.06);

    /* --- 4. mechanism ------------------------------------------------------- */
    // Only audible near the shooter; at 40 m nobody hears your bolt.
    if (near > 0.12) this._mech(prof, t0, bus, near * prof.mech.level);

    /* --- 5. tail ------------------------------------------------------------ */
    const tailAmt = prof.tail * (0.35 + this.space * 0.85) * (0.45 + far * 1.25);
    const tail = noiseVoice(ctx, this.noise, {
      type: 'bandpass', freq: 700 + this.space * 900, q: 0.5, rate: 0.55,
    });
    pluck(tail.gain, t0, tailAmt * 0.5, 0.012, 0.28 + prof.tail);
    tail.connect(out);
    startVoice(tail, t0, 0.35 + prof.tail);

    // Slap-back off the far side of the street, only when the shot is far
    // enough away for the reflection to separate from the direct sound.
    if (dist > 18) {
      const slap = noiseVoice(ctx, this.noise, { type: 'bandpass', freq: 900, q: 0.7, rate: 0.6 });
      const st = t0 + Math.min(0.42, (dist * 0.9) / SPEED_OF_SOUND);
      pluck(slap.gain, st, 0.22 * far, 0.02, 0.30);
      slap.connect(out);
      startVoice(slap, st, 0.4);
    }
  }

  /**
   * The action cycling. Two metallic transients (unlock, lock) plus the buffer
   * spring, which is a fast tremolo on a decaying low sine — that ringing is the
   * sound an AR pattern rifle is recognised by.
   */
  _mech(prof, t0, out, level) {
    const ctx = this.ctx;
    const m = prof.mech;
    for (let i = 0; i < 2; i++) {
      const at = t0 + m.delay + i * (m.delay * 1.9);
      const v = noiseVoice(ctx, this.noise, {
        type: 'bandpass', freq: m.freq * (i ? 0.72 : 1), q: 5.5, rate: 2.2,
      });
      decayTo(v.gain, at, level * (i ? 0.8 : 1), 0.035);
      v.connect(out);
      startVoice(v, at, 0.06);
    }
    // Buffer spring: a sine at the spring note, amplitude-modulated by a second
    // oscillator so it warbles rather than hums.
    const ring = ctx.createOscillator();
    ring.type = 'sine';
    ring.frequency.value = m.ring;
    const trem = ctx.createOscillator();
    trem.type = 'sine';
    trem.frequency.value = 46;
    const tremG = ctx.createGain();
    tremG.gain.value = level * 0.35;
    const rg = ctx.createGain();
    rg.gain.value = 0;
    decayTo(rg.gain, t0 + m.delay, level * 0.42, 0.14);
    trem.connect(tremG); tremG.connect(rg.gain);
    ring.connect(rg); rg.connect(out);
    ring.start(t0 + m.delay); ring.stop(t0 + m.delay + 0.2);
    trem.start(t0 + m.delay); trem.stop(t0 + m.delay + 0.2);
  }

  /* ---------------------------------------------------------------- foley */

  /** Hammer falling on an empty chamber: all mechanism, no report. */
  dryFire() {
    if (!this.mix.take(0.4, 0.1)) return;
    const t = this.ctx.currentTime;
    const v = noiseVoice(this.ctx, this.noise, { type: 'bandpass', freq: 2600, q: 7, rate: 2.6 });
    decayTo(v.gain, t, 0.32, 0.045);
    v.connect(this.mix.bus.foley);
    startVoice(v, t, 0.08);
  }

  /**
   * Reload foley. Each phase is a different mechanism with its own mass, so
   * they get different centre frequencies, different decay times and different
   * amounts of spring.
   */
  reload(phase, weaponId = 'rifle') {
    const prof = PROFILES[weaponId] || PROFILES.rifle;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.mix.bus.foley;
    if (!this.mix.take(0.5, 0.4)) return;

    switch (phase) {
      case 'magRelease': {                       // catch button, light and sharp
        const v = noiseVoice(ctx, this.noise, { type: 'bandpass', freq: 3800, q: 9, rate: 3 });
        decayTo(v.gain, t, 0.30, 0.03);
        v.connect(out); startVoice(v, t, 0.06);
        break;
      }
      case 'magout': {                           // magazine leaving the well
        const v = noiseVoice(ctx, this.noise, { type: 'bandpass', freq: 1500, q: 2.4, rate: 1.4 });
        decayTo(v.gain, t, 0.34, 0.13);
        v.connect(out); startVoice(v, t, 0.18);
        this._thunk(t + 0.02, 240, 0.16, out);
        break;
      }
      case 'magin': {                            // the seat: a real mechanical stop
        const v = noiseVoice(ctx, this.noise, { type: 'bandpass', freq: 1900, q: 3.2, rate: 1.7 });
        decayTo(v.gain, t, 0.42, 0.075);
        v.connect(out); startVoice(v, t, 0.12);
        this._thunk(t, 165, 0.30, out);
        break;
      }
      case 'bolt': {                             // carrier slamming into battery
        const v = noiseVoice(ctx, this.noise, { type: 'bandpass', freq: prof.mech.freq, q: 4, rate: 2.4 });
        decayTo(v.gain, t, 0.52, 0.05);
        v.connect(out); startVoice(v, t, 0.09);
        this._thunk(t + 0.004, prof.mech.ring, 0.34, out, 0.13);
        break;
      }
      case 'charge': {                           // charging handle drawn back
        const v = noiseVoice(ctx, this.noise, { type: 'bandpass', freq: 2200, q: 1.6, rate: 0.8 });
        pluck(v.gain, t, 0.26, 0.05, 0.11);
        v.connect(out); startVoice(v, t, 0.2);
        break;
      }
      case 'selector': {                         // fire-mode detent
        const v = noiseVoice(ctx, this.noise, { type: 'bandpass', freq: 5200, q: 12, rate: 3.4 });
        decayTo(v.gain, t, 0.22, 0.018);
        v.connect(out); startVoice(v, t, 0.04);
        break;
      }
      default: break;
    }
  }

  /** A pitched metallic thunk: the mass behind a mechanical stop. */
  _thunk(t, freq, level, out, dur = 0.09) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.55, t + dur);
    const g = this.ctx.createGain();
    decayTo(g.gain, t, level, dur);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + dur + 0.03);
  }

  /** Ejected case landing. Pitch and count vary so a firefight is not a metronome. */
  shell(position) {
    if (!this.mix.take(0.2, 0.2)) return;
    const ctx = this.ctx;
    const { node: out } = this._out(position, 3);
    const t = ctx.currentTime;
    const bounces = 2 + ((Math.random() * 2) | 0);
    for (let i = 0; i < bounces; i++) {
      const at = t + i * (0.06 + Math.random() * 0.05) * (1 + i * 0.4);
      const v = noiseVoice(ctx, this.noise, {
        type: 'bandpass', freq: 5200 + Math.random() * 2600, q: 14, rate: 3,
      });
      decayTo(v.gain, at, 0.13 * Math.pow(0.62, i), 0.06);
      v.connect(out);
      startVoice(v, at, 0.09);
    }
  }

  /**
   * A round passing close by. The crack of a supersonic round is a shock cone,
   * and what the ear gets as it sweeps past is a fast downward frequency
   * sweep — that sweep, not the level, is what makes it read as *past you*.
   */
  whizz(volume = 0.5, pitch = 1) {
    if (!this.mix.take(0.7, 0.2)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const v = noiseVoice(ctx, this.noise, { type: 'bandpass', freq: 4200 * pitch, q: 3.5, rate: 2 });
    v._filt.frequency.setValueAtTime(5200 * pitch, t);
    v._filt.frequency.exponentialRampToValueAtTime(900 * pitch, t + 0.10);
    pluck(v.gain, t, volume, 0.006, 0.09);
    // Panned hard-ish to a random side: a round that missed did so on one side.
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) {
      pan.pan.value = (Math.random() * 2 - 1) * 0.75;
      v.connect(pan); pan.connect(this.mix.bus.sfx);
    } else {
      v.connect(this.mix.bus.sfx);
    }
    startVoice(v, t, 0.16);
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function setPos(panner, p) {
  if (panner.positionX) {
    panner.positionX.value = p.x; panner.positionY.value = p.y; panner.positionZ.value = p.z;
  } else if (panner.setPosition) {
    panner.setPosition(p.x, p.y, p.z);
  }
}

export { setPos, PROFILES };
