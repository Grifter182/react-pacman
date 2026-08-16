import { noiseVoice, startVoice, decayTo, pluck } from './Synth.js';

/**
 * OWNER: audio agent.
 *
 * The bed. Two continuous layers plus a sparse event generator.
 *
 *   WIND      Pink noise through a resonant low-pass whose cutoff and gain are
 *             both driven by slow, mutually detuned LFOs. Two oscillators at
 *             incommensurate rates (0.043 Hz and 0.11 Hz) never line up, so the
 *             gusting has no audible period — which is the entire difference
 *             between wind and a fan.
 *   MARKET    A band-limited murmur an octave lower and much quieter, standing
 *             in for the town beyond the walls. It sits under everything and is
 *             what makes the silence between firefights feel occupied.
 *   EVENTS    Corrugated sheet flexing, a shutter, a distant dog, canvas
 *             snapping in a gust. Scheduled on a Poisson process rather than a
 *             timer so two never arrive on the same beat.
 *
 * All of it runs on four permanently-live nodes plus whatever one-shots the
 * event generator is currently playing, which is the whole CPU cost.
 */
export class Ambience {
  constructor(ctx, mixer, pink, white) {
    this.ctx = ctx;
    this.mix = mixer;
    this.pink = pink;
    this.white = white;
    this._next = 3 + Math.random() * 5;
    this._started = false;
    this.intensity = 0;
  }

  start() {
    if (this._started) return;
    this._started = true;
    const ctx = this.ctx;
    const out = this.mix.bus.ambience;

    /* --- wind --------------------------------------------------------------- */
    const wind = ctx.createBufferSource();
    wind.buffer = this.pink;
    wind.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'lowpass';
    wf.frequency.value = 520;
    wf.Q.value = 1.6;
    const wg = ctx.createGain();
    wg.gain.value = 0.30;

    // Two LFOs on the cutoff at unrelated rates: the sum never repeats.
    const lfoA = ctx.createOscillator(); lfoA.frequency.value = 0.043;
    const lfoB = ctx.createOscillator(); lfoB.frequency.value = 0.11;
    const depthA = ctx.createGain(); depthA.gain.value = 300;
    const depthB = ctx.createGain(); depthB.gain.value = 140;
    lfoA.connect(depthA); depthA.connect(wf.frequency);
    lfoB.connect(depthB); depthB.connect(wf.frequency);

    // A third LFO on the level gives the gusts their swell.
    const lfoC = ctx.createOscillator(); lfoC.frequency.value = 0.071;
    const depthC = ctx.createGain(); depthC.gain.value = 0.13;
    lfoC.connect(depthC); depthC.connect(wg.gain);

    wind.connect(wf); wf.connect(wg); wg.connect(out);
    wind.start(); lfoA.start(); lfoB.start(); lfoC.start();

    /* --- distant town -------------------------------------------------------- */
    const town = ctx.createBufferSource();
    town.buffer = this.pink;
    town.loop = true;
    town.playbackRate.value = 0.55;
    const tf = ctx.createBiquadFilter();
    tf.type = 'bandpass';
    tf.frequency.value = 340;
    tf.Q.value = 0.8;
    const tg = ctx.createGain();
    tg.gain.value = 0.16;
    const lfoD = ctx.createOscillator(); lfoD.frequency.value = 0.029;
    const depthD = ctx.createGain(); depthD.gain.value = 0.07;
    lfoD.connect(depthD); depthD.connect(tg.gain);
    town.connect(tf); tf.connect(tg); tg.connect(out);
    town.start(); lfoD.start();

    this._nodes = [wind, town, lfoA, lfoB, lfoC, lfoD];
    this._wind = wg;
    this._windFilter = wf;
  }

  /**
   * @param openness 0..1 from the world probe — indoors the wind loses its top
   *        end and drops away, which is most of what "being inside" sounds like.
   */
  setSpace(openness) {
    if (!this._started) return;
    const t = this.ctx.currentTime;
    this._wind.gain.setTargetAtTime(0.10 + openness * 0.26, t, 1.2);
    this._windFilter.frequency.setTargetAtTime(240 + openness * 520, t, 1.2);
  }

  update(dt) {
    if (!this._started) return;
    this._next -= dt;
    if (this._next > 0) return;
    // Exponential inter-arrival times: a memoryless process, so the gap between
    // two events carries no information about the next one.
    this._next = -Math.log(1 - Math.random()) * (7 + this.intensity * 9);
    this._event();
  }

  _event() {
    const ctx = this.ctx;
    const out = this.mix.bus.ambience;
    const t = ctx.currentTime;
    const pick = Math.random();

    if (pick < 0.34) {
      // Corrugated roofing flexing in the wind: a metallic wobble.
      const v = noiseVoice(ctx, this.white, { type: 'bandpass', freq: 1800 + Math.random() * 1400, q: 9, rate: 1.4 });
      pluck(v.gain, t, 0.055, 0.06, 0.45);
      const wob = ctx.createOscillator();
      wob.frequency.value = 5 + Math.random() * 7;
      const wd = ctx.createGain(); wd.gain.value = 700;
      wob.connect(wd); wd.connect(v._filt.frequency);
      wob.start(t); wob.stop(t + 0.7);
      v.connect(out); startVoice(v, t, 0.6);
    } else if (pick < 0.58) {
      // Canvas awning snapping.
      const v = noiseVoice(ctx, this.white, { type: 'bandpass', freq: 900, q: 1.1, rate: 1.9 });
      decayTo(v.gain, t, 0.09, 0.09);
      v.connect(out); startVoice(v, t, 0.14);
    } else if (pick < 0.78) {
      // A distant shutter or gate, low and reverberant.
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(180 + Math.random() * 90, t);
      o.frequency.exponentialRampToValueAtTime(90, t + 0.3);
      const g = ctx.createGain();
      decayTo(g.gain, t, 0.055, 0.35);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + 0.45);
    } else {
      // A bird lifting off — three short chirps on a falling contour.
      for (let i = 0; i < 3; i++) {
        const at = t + i * (0.07 + Math.random() * 0.05);
        const o = ctx.createOscillator();
        o.type = 'sine';
        const f = 2600 - i * 260 + Math.random() * 300;
        o.frequency.setValueAtTime(f, at);
        o.frequency.exponentialRampToValueAtTime(f * 0.7, at + 0.05);
        const g = ctx.createGain();
        decayTo(g.gain, at, 0.030, 0.06);
        o.connect(g); g.connect(out);
        o.start(at); o.stop(at + 0.1);
      }
    }
  }

  dispose() {
    for (const n of this._nodes || []) { try { n.stop(); } catch { /* already stopped */ } }
  }
}
