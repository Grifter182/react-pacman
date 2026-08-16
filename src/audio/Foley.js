import { noiseVoice, startVoice, decayTo, pluck } from './Synth.js';
import { setPos } from './WeaponAudio.js';

/**
 * OWNER: audio agent.
 *
 * Everything that is not a gunshot: footsteps, impacts, explosions, body foley,
 * UI stings and the low-health heartbeat.
 *
 * FOOTSTEPS ARE A MATERIAL, NOT A SOUND. A step is the sum of three events —
 * the heel strike (a filtered impulse whose centre frequency is set by the
 * stiffness of the surface), the scuff (broadband noise under the roll of the
 * foot), and, on loose surfaces, granular debris (a handful of very short
 * grains scattered over 60 ms). Concrete is nearly all strike; sand is nearly
 * all scuff; gravel is mostly grains. Those three weights are the whole
 * surface table, and they are what makes walking off tarmac onto sand audible.
 *
 * The gait scales all three: a sprint hits harder and scuffs longer, a crouch
 * loses the strike almost entirely and keeps the fabric, prone is drag only.
 */

const SURFACES = {
  //                strike  scuff  grain   freq   decay  bright
  concrete:   { strike: 1.00, scuff: 0.35, grain: 0.05, freq: 1500, decay: 0.075, bright: 1.00 },
  asphalt:    { strike: 0.85, scuff: 0.45, grain: 0.12, freq: 1150, decay: 0.085, bright: 0.85 },
  asphalt_line: { strike: 0.85, scuff: 0.45, grain: 0.12, freq: 1150, decay: 0.085, bright: 0.85 },
  tile:       { strike: 1.10, scuff: 0.25, grain: 0.02, freq: 2600, decay: 0.11, bright: 1.25 },
  brick:      { strike: 0.92, scuff: 0.38, grain: 0.10, freq: 1350, decay: 0.08, bright: 0.92 },
  plaster:    { strike: 0.80, scuff: 0.40, grain: 0.08, freq: 1250, decay: 0.07, bright: 0.86 },
  wood:       { strike: 0.95, scuff: 0.30, grain: 0.03, freq: 620, decay: 0.16, bright: 0.72 },
  metal:      { strike: 1.05, scuff: 0.22, grain: 0.02, freq: 2900, decay: 0.22, bright: 1.35 },
  gunmetal:   { strike: 1.05, scuff: 0.22, grain: 0.02, freq: 2900, decay: 0.22, bright: 1.35 },
  corrugated: { strike: 1.00, scuff: 0.28, grain: 0.03, freq: 2200, decay: 0.26, bright: 1.30 },
  sand:       { strike: 0.28, scuff: 1.00, grain: 0.55, freq: 480, decay: 0.13, bright: 0.42 },
  gravel:     { strike: 0.45, scuff: 0.70, grain: 1.00, freq: 900, decay: 0.10, bright: 0.78 },
  sandbag:    { strike: 0.30, scuff: 0.90, grain: 0.35, freq: 520, decay: 0.12, bright: 0.46 },
  canvas:     { strike: 0.35, scuff: 0.85, grain: 0.10, freq: 900, decay: 0.09, bright: 0.60 },
  rubber:     { strike: 0.60, scuff: 0.50, grain: 0.03, freq: 380, decay: 0.09, bright: 0.48 },
  glass:      { strike: 0.70, scuff: 0.30, grain: 0.70, freq: 4200, decay: 0.09, bright: 1.4 },
  polymer:    { strike: 0.75, scuff: 0.35, grain: 0.04, freq: 1700, decay: 0.08, bright: 1.0 },
  default:    { strike: 0.85, scuff: 0.45, grain: 0.15, freq: 1200, decay: 0.09, bright: 0.9 },
};

/** How the gait weights the three layers, plus the gear that rides on top. */
const GAITS = {
  walk:   { level: 0.55, strike: 1.0, scuff: 0.9, grain: 1.0, gear: 0.30, spread: 0.020 },
  sprint: { level: 1.00, strike: 1.35, scuff: 1.5, grain: 1.3, gear: 0.75, spread: 0.032 },
  crouch: { level: 0.24, strike: 0.35, scuff: 1.1, grain: 0.7, gear: 0.14, spread: 0.045 },
  prone:  { level: 0.16, strike: 0.10, scuff: 1.4, grain: 0.5, gear: 0.10, spread: 0.070 },
};

const IMPACTS = {
  concrete: { freq: 3200, q: 2.2, dur: 0.085, grit: 0.7, thump: 140 },
  asphalt: { freq: 2400, q: 1.8, dur: 0.09, grit: 0.8, thump: 120 },
  brick: { freq: 2900, q: 2.0, dur: 0.09, grit: 0.9, thump: 130 },
  plaster: { freq: 2100, q: 1.4, dur: 0.10, grit: 1.0, thump: 110 },
  wood: { freq: 1400, q: 2.6, dur: 0.12, grit: 0.5, thump: 180 },
  metal: { freq: 5200, q: 9.0, dur: 0.24, grit: 0.2, thump: 320 },
  gunmetal: { freq: 5200, q: 9.0, dur: 0.24, grit: 0.2, thump: 320 },
  corrugated: { freq: 3800, q: 7.0, dur: 0.30, grit: 0.3, thump: 260 },
  glass: { freq: 6800, q: 6.0, dur: 0.18, grit: 1.2, thump: 0 },
  tile: { freq: 4600, q: 5.0, dur: 0.13, grit: 1.0, thump: 150 },
  sand: { freq: 700, q: 0.9, dur: 0.10, grit: 0.9, thump: 70 },
  gravel: { freq: 1500, q: 1.1, dur: 0.10, grit: 1.3, thump: 90 },
  sandbag: { freq: 800, q: 0.8, dur: 0.11, grit: 0.7, thump: 60 },
  canvas: { freq: 1200, q: 1.0, dur: 0.08, grit: 0.3, thump: 0 },
  rubber: { freq: 600, q: 1.4, dur: 0.09, grit: 0.2, thump: 90 },
  flesh: { freq: 420, q: 0.9, dur: 0.11, grit: 0.15, thump: 95 },
  default: { freq: 2600, q: 2.0, dur: 0.09, grit: 0.7, thump: 130 },
};

export class Foley {
  constructor(ctx, mixer, noise, opts = {}) {
    this.ctx = ctx;
    this.mix = mixer;
    this.noise = noise;
    this.panningModel = opts.panningModel || 'equalpower';
    this._lastFoot = 0;
  }

  _panned(position, ref = 4, roll = 1.1) {
    if (!position) return this.mix.bus.foley;
    const p = this.ctx.createPanner();
    p.panningModel = this.panningModel;
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = roll;
    p.maxDistance = 160;
    setPos(p, position);
    p.connect(this.mix.bus.sfx);
    return p;
  }

  /**
   * @param o.surface  material preset under the foot
   * @param o.gait     'walk' | 'sprint' | 'crouch' | 'prone'
   * @param o.position world position, or null for the player's own feet
   * @param o.speed    m/s, scales the strike
   */
  footstep(o = {}) {
    const s = SURFACES[o.surface] || SURFACES.default;
    const g = GAITS[o.gait] || GAITS.walk;
    if (!this.mix.take(0.3, 0.3)) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this._panned(o.position, 3.2, 1.4);
    const level = (o.volume ?? 1) * g.level;
    // Two feet are never identical: a small random detune per step is the
    // difference between walking and a drum machine.
    const detune = 0.88 + Math.random() * 0.26;

    /* --- heel strike -------------------------------------------------------- */
    if (s.strike * g.strike > 0.05) {
      const v = noiseVoice(ctx, this.noise, {
        type: 'bandpass', freq: s.freq * detune, q: 1.6 + s.bright, rate: 1.6,
      });
      decayTo(v.gain, t, level * s.strike * g.strike * 0.55, s.decay);
      v.connect(out);
      startVoice(v, t, s.decay + 0.05);

      // Low body of the step — the weight of a person, absent on tile and glass.
      if (s.bright < 1.2) {
        const o2 = ctx.createOscillator();
        o2.type = 'sine';
        const f = 110 * detune;
        o2.frequency.setValueAtTime(f, t);
        o2.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.07);
        const og = ctx.createGain();
        decayTo(og.gain, t, level * s.strike * g.strike * 0.22, 0.075);
        o2.connect(og); og.connect(out);
        o2.start(t); o2.stop(t + 0.12);
      }
    }

    /* --- scuff -------------------------------------------------------------- */
    const scuff = noiseVoice(ctx, this.noise, {
      type: 'highpass', freq: 1400 * s.bright, q: 0.6, rate: 0.9 + Math.random() * 0.3,
    });
    pluck(scuff.gain, t + 0.008, level * s.scuff * g.scuff * 0.30, 0.012, g.spread * 4);
    scuff.connect(out);
    startVoice(scuff, t, g.spread * 5 + 0.05);

    /* --- grains ------------------------------------------------------------- */
    const grains = Math.round(s.grain * g.grain * 7);
    for (let i = 0; i < grains; i++) {
      const at = t + Math.random() * g.spread * 3;
      const v = noiseVoice(ctx, this.noise, {
        type: 'bandpass', freq: 2600 + Math.random() * 4200, q: 9, rate: 3,
      });
      decayTo(v.gain, at, level * 0.10 * (0.4 + Math.random() * 0.6), 0.02);
      v.connect(out);
      startVoice(v, at, 0.035);
    }

    /* --- gear --------------------------------------------------------------- */
    // Webbing, sling and magazines. Only on the player's own steps, where it is
    // body-conducted and always present regardless of surface.
    if (!o.position && g.gear > 0.05) {
      const v = noiseVoice(ctx, this.noise, { type: 'bandpass', freq: 3400, q: 1.2, rate: 1.4 });
      pluck(v.gain, t + 0.012 + Math.random() * 0.02, level * g.gear * 0.10, 0.01, 0.06);
      v.connect(this.mix.bus.foley);
      startVoice(v, t, 0.12);
    }
  }

  /** Bullet striking a surface. */
  impact(o = {}) {
    const m = IMPACTS[o.material] || IMPACTS.default;
    if (!this.mix.take(0.45, 0.4)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this._panned(o.position, 5, 1.0);
    const level = (o.volume ?? 0.7) * (0.6 + (o.impulse ?? 0.5) * 0.7);

    const v = noiseVoice(ctx, this.noise, {
      type: 'bandpass', freq: m.freq * (0.85 + Math.random() * 0.3), q: m.q, rate: 2 + Math.random(),
    });
    decayTo(v.gain, t, level, m.dur);
    v.connect(out);
    startVoice(v, t, m.dur + 0.06);

    if (m.thump > 0) {
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.setValueAtTime(m.thump, t);
      o2.frequency.exponentialRampToValueAtTime(m.thump * 0.5, t + 0.06);
      const og = ctx.createGain();
      decayTo(og.gain, t, level * 0.45, 0.07);
      o2.connect(og); og.connect(out);
      o2.start(t); o2.stop(t + 0.11);
    }

    // Spalled material: the debris that comes off the hole, scattered in time.
    const bits = Math.round(m.grit * 4);
    for (let i = 0; i < bits; i++) {
      const at = t + 0.02 + Math.random() * 0.16;
      const b = noiseVoice(ctx, this.noise, { type: 'bandpass', freq: 3800 + Math.random() * 4000, q: 11, rate: 3 });
      decayTo(b.gain, at, level * 0.09, 0.025);
      b.connect(out);
      startVoice(b, at, 0.04);
    }
  }

  /**
   * Explosion. Three layers with different arrival times: the shock (immediate,
   * broadband), the fireball (a downward-swept low roar), and the debris rain
   * that follows a quarter of a second later.
   */
  explosion(o = {}) {
    if (!this.mix.take(1, 2.2)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this._panned(o.position, 14, 0.7);
    const level = o.volume ?? 1;

    const shock = noiseVoice(ctx, this.noise, { type: 'lowpass', freq: 6000, q: 0.7, rate: 0.9 });
    shock._filt.frequency.setValueAtTime(6000, t);
    shock._filt.frequency.exponentialRampToValueAtTime(220, t + 0.5);
    decayTo(shock.gain, t, level * 1.5, 0.55);
    shock.connect(out);
    startVoice(shock, t, 0.7);

    const roar = noiseVoice(ctx, this.noise, { type: 'lowpass', freq: 900, q: 1.2, rate: 0.42 });
    roar._filt.frequency.setValueAtTime(900, t);
    roar._filt.frequency.exponentialRampToValueAtTime(70, t + 1.6);
    pluck(roar.gain, t, level * 1.1, 0.03, 1.7);
    roar.connect(out);
    startVoice(roar, t, 1.9);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(85, t);
    sub.frequency.exponentialRampToValueAtTime(24, t + 0.7);
    const sg = ctx.createGain();
    decayTo(sg.gain, t, level * 1.0, 0.8);
    sub.connect(sg); sg.connect(out);
    sub.start(t); sub.stop(t + 0.95);

    for (let i = 0; i < 10; i++) {
      const at = t + 0.22 + Math.random() * 0.9;
      const b = noiseVoice(ctx, this.noise, { type: 'bandpass', freq: 1400 + Math.random() * 4200, q: 6, rate: 2.4 });
      decayTo(b.gain, at, level * 0.10 * Math.random(), 0.07);
      b.connect(out);
      startVoice(b, at, 0.1);
    }
  }

  /** Grenade leaving the hand — cloth, then the spoon pinging off. */
  throwGrenade(position) {
    if (!this.mix.take(0.4, 0.3)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this._panned(position, 6, 1.1);
    const cloth = noiseVoice(ctx, this.noise, { type: 'highpass', freq: 2200, q: 0.7, rate: 1.1 });
    pluck(cloth.gain, t, 0.18, 0.02, 0.14);
    cloth.connect(out); startVoice(cloth, t, 0.2);
    const ping = ctx.createOscillator();
    ping.type = 'triangle';
    ping.frequency.value = 3400;
    const pg = ctx.createGain();
    decayTo(pg.gain, t + 0.06, 0.10, 0.16);
    ping.connect(pg); pg.connect(out);
    ping.start(t + 0.06); ping.stop(t + 0.26);
  }

  /* ------------------------------------------------------------------- body */

  /** Landing from a fall: knees, boots and everything strapped to the player. */
  land(impact = 6, surface = 'default') {
    const hard = Math.min(1, impact / 12);
    this.footstep({ surface, gait: hard > 0.5 ? 'sprint' : 'walk', volume: 0.7 + hard * 0.8 });
    if (hard < 0.35) return;
    if (!this.mix.take(0.5, 0.3)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(72, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    const g = ctx.createGain();
    decayTo(g.gain, t, 0.42 * hard, 0.19);
    o.connect(g); g.connect(this.mix.bus.foley);
    o.start(t); o.stop(t + 0.24);
  }

  /** Sliding: continuous grit under the hip for the duration of the slide. */
  slide(on) {
    const ctx = this.ctx;
    if (on && !this._slide) {
      // `noiseVoice` hands back the GainNode itself, so the automated parameter
      // is `v.gain` — the source and filter hang off it as `_src` / `_filt`.
      const v = noiseVoice(ctx, this.noise, { type: 'bandpass', freq: 1100, q: 0.8, rate: 1.2 });
      v._src.loop = true;
      v.gain.setValueAtTime(0.0006, ctx.currentTime);
      v.gain.exponentialRampToValueAtTime(0.34, ctx.currentTime + 0.06);
      v.connect(this.mix.bus.foley);
      try { v._src.start(ctx.currentTime, v._offset); } catch { v._src.start(); }
      this._slide = v;
    } else if (!on && this._slide) {
      const v = this._slide;
      this._slide = null;
      const t = ctx.currentTime;
      v.gain.cancelScheduledValues(t);
      v.gain.setValueAtTime(Math.max(0.0006, v.gain.value), t);
      v.gain.exponentialRampToValueAtTime(0.0006, t + 0.18);
      v._src.stop(t + 0.22);
    }
  }

  /** Mantling: a grunt of effort plus the scrape of gear over an edge. */
  mantle() {
    if (!this.mix.take(0.4, 0.4)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const v = noiseVoice(ctx, this.noise, { type: 'bandpass', freq: 900, q: 0.9, rate: 0.7 });
    pluck(v.gain, t, 0.26, 0.04, 0.30);
    v.connect(this.mix.bus.foley);
    startVoice(v, t, 0.4);
  }

  /**
   * Heartbeat. Two thumps, lub-dub, with the second lighter and slightly higher;
   * a single thump reads as a drum, the pair reads as a body.
   */
  heartbeat(volume = 0.3, pitch = 1) {
    if (!this.mix.take(0.6, 0.4)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const at = t + i * 0.155;
      const f = (52 + i * 9) * pitch;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f * 1.6, at);
      o.frequency.exponentialRampToValueAtTime(f, at + 0.05);
      const g = ctx.createGain();
      decayTo(g.gain, at, volume * (i ? 0.62 : 1), 0.14);
      o.connect(g); g.connect(this.mix.bus.ui);
      o.start(at); o.stop(at + 0.2);
    }
  }

  /* --------------------------------------------------------------------- ui */

  /** Hit confirmation. Three grades, matching the three hitmarkers. */
  hitmarker(kind = 'body') {
    if (!this.mix.take(0.9, 0.2)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const spec = kind === 'kill' ? [1240, 0.16, 'square']
      : kind === 'head' ? [1720, 0.08, 'square']
      : [980, 0.045, 'square'];
    const o = ctx.createOscillator();
    o.type = spec[2];
    o.frequency.value = spec[0];
    const g = ctx.createGain();
    decayTo(g.gain, t, kind === 'kill' ? 0.14 : 0.10, spec[1]);
    o.connect(g); g.connect(this.mix.bus.ui);
    o.start(t); o.stop(t + spec[1] + 0.05);
    if (kind === 'kill') {
      // A second, lower note a beat later turns the confirmation into a cadence.
      const o2 = ctx.createOscillator();
      o2.type = 'square';
      o2.frequency.value = 830;
      const g2 = ctx.createGain();
      decayTo(g2.gain, t + 0.075, 0.11, 0.16);
      o2.connect(g2); g2.connect(this.mix.bus.ui);
      o2.start(t + 0.075); o2.stop(t + 0.3);
    }
  }

  /** Front-end and callout stings. */
  ui(kind = 'click') {
    if (!this.mix.take(0.9, 0.3)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const notes = kind === 'reward' ? [520, 780, 1040]
      : kind === 'bad' ? [420, 300]
      : kind === 'streak' ? [660, 990]
      : [900];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      const at = t + i * 0.075;
      decayTo(g.gain, at, 0.10, 0.16);
      o.connect(g); g.connect(this.mix.bus.ui);
      o.start(at); o.stop(at + 0.22);
    });
  }
}

export { SURFACES };
