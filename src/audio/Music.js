import { noiseVoice, startVoice, decayTo } from './Synth.js';

/**
 * OWNER: audio agent.
 *
 * Adaptive score.
 *
 * Three layers, each permanently running and crossfaded by one number — the
 * combat intensity:
 *
 *   PAD      Two detuned saw voices a fifth apart through a slow low-pass. Never
 *            silent; it is the floor the rest of the mix sits on.
 *   PULSE    A sub kick plus a filtered noise tick on a 96 BPM grid, scheduled
 *            with a lookahead so the timing is sample-accurate rather than
 *            frame-accurate. Fades in from about 25% intensity.
 *   TENSION  A minor-second cluster high in the register with a slow tremolo.
 *            Only audible at the top of the intensity range; it is dissonant on
 *            purpose and would be exhausting if it were ever the whole cue.
 *
 * INTENSITY is an accumulator, not a switch. Firing, being shot at, taking
 * damage and enemies being visible all push it up by different amounts; it
 * decays on a time constant of about six seconds, so the score keeps running
 * for a while after the shooting stops instead of cutting out mid-phrase, which
 * is what makes it read as a *response* rather than a trigger.
 *
 * The whole thing is diegetically restrained: the root moves only when the
 * match phase changes, so it never fights the sound design for the same octave.
 */

const BPM = 96;
const BEAT = 60 / BPM;
const ROOT = 55;             // A1 — everything above is a ratio of this

export class Music {
  constructor(ctx, mixer, noise) {
    this.ctx = ctx;
    this.mix = mixer;
    this.noise = noise;
    this.intensity = 0;
    this._target = 0;
    this._started = false;
    this._nextBeat = 0;
    this._beat = 0;
    this.enabled = true;
  }

  start() {
    if (this._started) return;
    this._started = true;
    const ctx = this.ctx;
    const out = this.mix.bus.music;

    /* --- pad ---------------------------------------------------------------- */
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.22;
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 420;
    padFilter.Q.value = 0.9;
    this.padFilter = padFilter;
    padFilter.connect(this.padGain);
    this.padGain.connect(out);

    this._pad = [];
    // Root, fifth, octave — and every voice detuned a few cents off its
    // neighbour so the stack beats slowly instead of sitting still.
    for (const [mult, detune, level] of [[1, -6, 0.5], [1.5, 4, 0.34], [2, -3, 0.20], [1.5, -9, 0.22]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = ROOT * mult;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g); g.connect(padFilter);
      o.start();
      this._pad.push({ osc: o, gain: g, mult });
    }
    // Slow filter movement so the pad breathes.
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.037;
    const depth = ctx.createGain(); depth.gain.value = 130;
    lfo.connect(depth); depth.connect(padFilter.frequency);
    lfo.start();
    this._lfo = lfo;

    /* --- pulse / tension buses ---------------------------------------------- */
    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = 0;
    this.pulseGain.connect(out);

    this.tensionGain = ctx.createGain();
    this.tensionGain.gain.value = 0;
    this.tensionGain.connect(out);

    this._tension = [];
    for (const [mult, det] of [[8, 0], [8.47, 6], [12, -5]]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = ROOT * mult;
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = 0.12;
      o.connect(g); g.connect(this.tensionGain);
      o.start();
      this._tension.push(o);
    }
    const trem = ctx.createOscillator(); trem.frequency.value = 4.7;
    const tdepth = ctx.createGain(); tdepth.gain.value = 0.05;
    trem.connect(tdepth); tdepth.connect(this.tensionGain.gain);
    trem.start();
    this._trem = trem;

    this._nextBeat = ctx.currentTime + BEAT;
  }

  /** Push the intensity accumulator. */
  bump(amount) { this._target = Math.min(1, this._target + amount); }

  /** Raise the accumulator to at least `v`; never lowers it. */
  setIntensity(v) { this._target = Math.max(this._target, Math.min(1, v)); }

  /** Direct set, for phase changes (warmup vs live vs overtime). */
  setFloor(v) { this._floor = v; }

  update(dt) {
    if (!this._started || !this.enabled) return;
    // Six-second decay; the floor keeps a base tension during overtime.
    this._target = Math.max(this._floor || 0, this._target - dt * 0.17);
    this.intensity += (this._target - this.intensity) * Math.min(1, dt * 0.9);

    // Layer gains move on time constants of half a second or more, so pushing
    // new targets at frame rate is 240 automation events a second describing a
    // curve nobody can hear change. Ten hertz is more than enough.
    this._paramAcc = (this._paramAcc || 0) + dt;
    if (this._paramAcc >= 0.1) {
      this._paramAcc = 0;
      const t = this.ctx.currentTime;
      const i = this.intensity;
      this.padGain.gain.setTargetAtTime(0.16 + i * 0.16, t, 0.5);
      this.padFilter.frequency.setTargetAtTime(360 + i * 900, t, 0.7);
      this.pulseGain.gain.setTargetAtTime(smooth(i, 0.22, 0.7) * 0.55, t, 0.4);
      this.tensionGain.gain.setTargetAtTime(smooth(i, 0.62, 1.0) * 0.16, t, 0.9);
    }

    this._schedule();
  }

  /**
   * Lookahead scheduler. WebAudio events are placed on the audio clock up to
   * 250 ms ahead, so the groove does not inherit the render loop's jitter.
   */
  _schedule() {
    const ctx = this.ctx;
    const horizon = ctx.currentTime + 0.25;
    let guard = 16;
    while (this._nextBeat < horizon && guard-- > 0) {
      this._playBeat(this._nextBeat, this._beat % 8);
      this._beat++;
      this._nextBeat += BEAT / 2;              // eighth notes
    }
    if (guard <= 0) this._nextBeat = ctx.currentTime + BEAT / 2;
  }

  _playBeat(t, step) {
    const out = this.pulseGain;
    // Kick on 0 and 5, the classic displaced pattern — it drives without
    // becoming a march.
    if (step === 0 || step === 5) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(96, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.10);
      const g = this.ctx.createGain();
      decayTo(g.gain, t, 0.75, 0.16);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + 0.22);
    }
    // Ticks on the offbeats, quiet, high, band-limited — pulse without hi-hat.
    if (step % 2 === 1) {
      const v = noiseVoice(this.ctx, this.noise, { type: 'bandpass', freq: 7200, q: 6, rate: 3 });
      decayTo(v.gain, t, 0.10, 0.03);
      v.connect(out);
      startVoice(v, t, 0.05);
    }
    // A low pluck at the top of every bar keeps harmonic motion alive.
    if (step === 0) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = ROOT * 2;
      const g = this.ctx.createGain();
      decayTo(g.gain, t, 0.14, 0.5);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + 0.6);
    }
  }

  /** Shift the whole score for a match phase. */
  setKey(semitones) {
    const r = Math.pow(2, semitones / 12);
    const t = this.ctx.currentTime;
    for (const p of this._pad || []) p.osc.frequency.setTargetAtTime(ROOT * p.mult * r, t, 1.5);
  }

  dispose() {
    for (const p of this._pad || []) { try { p.osc.stop(); } catch { /* stopped */ } }
    for (const o of this._tension || []) { try { o.stop(); } catch { /* stopped */ } }
    try { this._lfo?.stop(); this._trem?.stop(); } catch { /* stopped */ }
  }
}

/** Smoothstep between two thresholds — used for every layer crossfade. */
function smooth(x, a, b) {
  const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-4, b - a)));
  return t * t * (3 - 2 * t);
}
