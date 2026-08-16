import { impulseResponse, softClipCurve } from './Synth.js';

/**
 * OWNER: audio agent.
 *
 * The mix bus, and the only place a node is allowed to reach the destination.
 *
 * SIGNAL PATH
 *
 *   voice --> bus gain --+--> bus sum --> saturator --> master --> limiter --> out
 *                        |
 *                        +--> reverb send --> [tight IR | open IR] --> master
 *
 * Two impulse responses, crossfaded. A market street and the inside of a
 * concrete stairwell are not the same room, and one IR set to the average of
 * both is wrong everywhere. `setSpace(openness)` slides between a tight, fast,
 * heavily damped IR and a long, bright one; the caller measures openness by
 * probing the world, so the tail follows the player through doorways.
 *
 * EAR STATE. Everything downstream of the buses passes through one low-pass and
 * one gain that model temporary hearing loss. An explosion collapses the cutoff
 * to a few hundred hertz, drops the level, and lifts a 4.6 kHz tinnitus tone;
 * all three recover over about eight seconds. Suppression uses the same path at
 * a fraction of the depth, so being shot at and being blown up sit on one
 * continuum rather than being two unrelated effects.
 *
 * VOICE BUDGET. Every one-shot registers with `take()`; over the cap the
 * quietest request is refused outright. A firefight with a dozen bots can ask
 * for a hundred simultaneous voices, and WebAudio will happily try.
 */

export const BUSES = ['weapons', 'sfx', 'foley', 'ui', 'music', 'ambience'];

const DEFAULT_LEVELS = {
  master: 0.85, weapons: 0.9, sfx: 0.85, foley: 0.7, ui: 0.7, music: 0.5, ambience: 0.45,
};

const STORE_KEY = 'blackout.audio.v1';

export class Mixer {
  constructor(ctx) {
    this.ctx = ctx;
    this.levels = { ...DEFAULT_LEVELS };
    this._load();

    /* --- output chain ------------------------------------------------------ */
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.14;
    this.limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.levels.master;

    // Ear state sits between the master and the limiter.
    this.earLP = ctx.createBiquadFilter();
    this.earLP.type = 'lowpass';
    this.earLP.frequency.value = 20000;
    this.earLP.Q.value = 0.7;
    this.earGain = ctx.createGain();
    this.earGain.gain.value = 1;

    this.master.connect(this.earLP);
    this.earLP.connect(this.earGain);
    this.earGain.connect(this.limiter);

    // Gentle programme saturation before the master: gunfire peaks stop poking
    // holes in the mix and the whole thing gets a little glue.
    this.sat = ctx.createWaveShaper();
    this.sat.curve = softClipCurve(1.9);
    this.sat.oversample = '2x';
    this.sat.connect(this.master);

    /* --- reverb ------------------------------------------------------------ */
    this.revTight = ctx.createConvolver();
    this.revTight.buffer = impulseResponse(ctx, { seconds: 1.1, decay: 3.6, predelay: 0.004, damping: 0.72 });
    this.revOpen = ctx.createConvolver();
    this.revOpen.buffer = impulseResponse(ctx, { seconds: 2.9, decay: 1.9, predelay: 0.016, damping: 0.34 });

    this.gTight = ctx.createGain(); this.gTight.gain.value = 0.5;
    this.gOpen = ctx.createGain(); this.gOpen.gain.value = 0.5;
    this.revTight.connect(this.gTight); this.gTight.connect(this.master);
    this.revOpen.connect(this.gOpen); this.gOpen.connect(this.master);

    /* --- buses ------------------------------------------------------------- */
    this.bus = {};
    this.send = {};
    const SEND = { weapons: 0.30, sfx: 0.26, foley: 0.12, ui: 0, music: 0.05, ambience: 0.08 };
    for (const name of BUSES) {
      const g = ctx.createGain();
      g.gain.value = this.levels[name] ?? 0.7;
      g.connect(this.sat);
      const s = ctx.createGain();
      s.gain.value = SEND[name] ?? 0.15;
      g.connect(s);
      s.connect(this.revTight);
      s.connect(this.revOpen);
      this.bus[name] = g;
      this.send[name] = s;
    }

    /* --- tinnitus ---------------------------------------------------------- */
    this.tin = ctx.createOscillator();
    this.tin.type = 'sine';
    this.tin.frequency.value = 4620;
    this.tinGain = ctx.createGain();
    this.tinGain.gain.value = 0;
    const tinShimmer = ctx.createOscillator();     // slow beat so it is not a test tone
    tinShimmer.frequency.value = 0.7;
    const tinDepth = ctx.createGain();
    tinDepth.gain.value = 0.35;
    tinShimmer.connect(tinDepth);
    tinDepth.connect(this.tinGain.gain);
    this.tin.connect(this.tinGain);
    this.tinGain.connect(this.limiter);
    this.tin.start(); tinShimmer.start();

    this._deaf = 0;          // 0..1 hearing damage
    this._supp = 0;          // 0..1 suppression, shares the ear path
    this._duck = 0;          // 0..1 music/ambience duck
    this.voices = 0;
    this.voiceCap = 44;
  }

  /* ---------------------------------------------------------------- levels */

  _load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(this.levels, JSON.parse(raw));
    } catch { /* storage disabled — defaults are fine */ }
  }

  _save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.levels)); } catch { /* ignore */ }
  }

  setLevel(name, value) {
    const v = Math.max(0, Math.min(1, value));
    this.levels[name] = v;
    const t = this.ctx.currentTime;
    if (name === 'master') this.master.gain.setTargetAtTime(v, t, 0.02);
    else if (this.bus[name]) this.bus[name].gain.setTargetAtTime(v, t, 0.02);
    this._save();
    return v;
  }

  /** Snapshot for the settings UI. */
  volumes() { return { ...this.levels }; }

  /* ----------------------------------------------------------------- space */

  /**
   * @param openness 0 (enclosed) .. 1 (open street)
   * Crossfaded rather than switched: walking through a doorway should hear like
   * a doorway, not a cut.
   */
  setSpace(openness) {
    const t = this.ctx.currentTime;
    const o = Math.max(0, Math.min(1, openness));
    this.gOpen.gain.setTargetAtTime(0.12 + o * 0.62, t, 0.35);
    this.gTight.gain.setTargetAtTime(0.10 + (1 - o) * 0.66, t, 0.35);
  }

  /* -------------------------------------------------------------- ear state */

  /** @param amount 0..1 — an explosion in the lap is 1. */
  deafen(amount) {
    this._deaf = Math.min(1, this._deaf + amount);
    // Apply immediately: the whole point of a concussion is that it is not
    // smoothed in over a quarter of a second.
    this._applyEar(0);
  }

  /**
   * Suppression rides the same path at a fraction of the depth, so being shot
   * at and being blown up sit on one continuum instead of being two unrelated
   * effects that can stack into nonsense.
   */
  suppress(v) { this._supp = Math.max(0, Math.min(1, v)); }

  _applyEar(smoothing) {
    const t = this.ctx.currentTime;
    const d = Math.max(this._deaf, (this._supp || 0) * 0.42);
    const cutoff = Math.max(240, 20000 * Math.pow(1 - d, 3.2) + 240);
    // The ring is generated in the ear, so it bypasses the ear filter and the
    // ear attenuation — but it still has to answer to the master fader.
    const tin = this._deaf * 0.085 * this.levels.master;
    if (smoothing > 0) {
      this.earLP.frequency.setTargetAtTime(cutoff, t, smoothing);
      this.earGain.gain.setTargetAtTime(1 - d * 0.55, t, smoothing);
      this.tinGain.gain.setTargetAtTime(tin, t, smoothing * 1.5);
    } else {
      this.earLP.frequency.cancelScheduledValues(t);
      this.earLP.frequency.setValueAtTime(cutoff, t);
      this.earGain.gain.setValueAtTime(1 - d * 0.55, t);
      this.tinGain.gain.cancelScheduledValues(t);
      this.tinGain.gain.setValueAtTime(tin, t);
    }
  }

  /**
   * Duck the beds so a firefight is not fighting the music. Called with the
   * combat intensity the music layer is already tracking.
   */
  duck(amount) {
    // Only re-target when the number has actually moved: the beds ride a
    // quarter-second time constant, so frame-rate automation buys nothing.
    if (Math.abs(amount - this._duck) < 0.02) return;
    const t = this.ctx.currentTime;
    this._duck = amount;
    this.bus.music.gain.setTargetAtTime(this.levels.music * (1 - amount * 0.45), t, 0.25);
    this.bus.ambience.gain.setTargetAtTime(this.levels.ambience * (1 - amount * 0.55), t, 0.3);
  }

  update(dt) {
    // Recovery is slow at first and then quick — the shape the effect has in
    // life, and the reason a long ring reads as an injury rather than a filter.
    const before = this._deaf;
    if (this._deaf > 0.0005) this._deaf = Math.max(0, this._deaf - dt * (0.06 + this._deaf * 0.22));
    if (before > 0.0005 || (this._supp || 0) > 0.002) this._applyEar(0.2);
  }

  /* ---------------------------------------------------------------- voices */

  /**
   * Claim a voice slot. Returns false when the budget is spent, and the caller
   * must then not build any nodes at all.
   * @param priority 0..1 — high-priority sounds evict nothing but are allowed
   *        slightly past the soft cap.
   */
  take(priority = 0.5, seconds = 0.5) {
    const cap = this.voiceCap * (0.75 + priority * 0.45);
    if (this.voices >= cap) return false;
    this.voices++;
    const release = () => { this.voices = Math.max(0, this.voices - 1); };
    setTimeout(release, Math.min(4000, (seconds + 0.15) * 1000));
    return true;
  }

  dispose() {
    try { this.tin.stop(); } catch { /* already stopped */ }
  }
}
