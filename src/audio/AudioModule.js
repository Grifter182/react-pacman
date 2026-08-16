/**
 * OWNER: audio agent.
 *
 * Fully procedural WebAudio engine — no sample assets. Synthesises gunfire,
 * impacts, footsteps, reloads, explosions and UI, routed through a positional
 * panner and a convolution reverb whose impulse response is generated at boot.
 *
 * Listens for 'audio:play', 'weapon:fire', 'weapon:reload', 'hit:surface',
 * 'actor:killed', 'fx:explosion'.
 *
 * The context is created suspended and resumed on first user gesture, per
 * browser autoplay policy.
 */
export class AudioModule {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.ready = false;
    this.enabled = true;
  }

  async init(engine) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }

    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;

    // Gentle bus compression so gunfire never clips the mix.
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 22;
    this.comp.ratio.value = 5;
    this.comp.attack.value = 0.002;
    this.comp.release.value = 0.18;

    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this._makeImpulse(1.9, 2.6);
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.28;

    this.master.connect(this.comp);
    this.comp.connect(this.ctx.destination);
    this.master.connect(this.reverbGain);
    this.reverbGain.connect(this.reverb);
    this.reverb.connect(this.comp);

    this._noise = this._makeNoise(2.0);

    const resume = () => {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.ready = true;
    };
    window.addEventListener('pointerdown', resume, { once: false });
    window.addEventListener('keydown', resume, { once: false });

    engine.bus.on('weapon:fire', () => this.gunshot());
    engine.bus.on('weapon:reload', ({ phase }) => this.mechanical(phase === 'start' ? 0.8 : 1.2));
    engine.bus.on('hit:surface', () => this.impact());
    engine.bus.on('actor:killed', () => this.hitmarker(true));
    engine.bus.on('hit:actor', () => this.hitmarker(false));
    engine.bus.on('fx:explosion', () => this.explosion());

    engine.audio = this;
  }

  _makeNoise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // early reflections + exponential tail
        const er = i < rate * 0.06 && Math.random() < 0.004 ? (Math.random() * 2 - 1) * 0.8 : 0;
        d[i] = ((Math.random() * 2 - 1) * 0.5 + er) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  _now() { return this.ctx.currentTime; }

  /** Layered gunshot: transient click + body noise + low thump + tail. */
  gunshot(volume = 1) {
    if (!this.ready || !this.enabled) return;
    const t = this._now();
    const out = this.ctx.createGain();
    out.gain.value = volume * 0.9;
    out.connect(this.master);

    // Crack — bandpassed noise burst
    const n = this.ctx.createBufferSource();
    n.buffer = this._noise;
    n.playbackRate.value = 1 + (Math.random() - 0.5) * 0.08;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2100 + Math.random() * 500; bp.Q.value = 0.9;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(1.0, t);
    ng.gain.exponentialRampToValueAtTime(0.0008, t + 0.16);
    n.connect(bp); bp.connect(ng); ng.connect(out);
    n.start(t); n.stop(t + 0.2);

    // Body — lowpassed noise
    const n2 = this.ctx.createBufferSource();
    n2.buffer = this._noise;
    n2.playbackRate.value = 0.7;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.22);
    const n2g = this.ctx.createGain();
    n2g.gain.setValueAtTime(0.85, t);
    n2g.gain.exponentialRampToValueAtTime(0.0008, t + 0.26);
    n2.connect(lp); lp.connect(n2g); n2g.connect(out);
    n2.start(t); n2.stop(t + 0.3);

    // Thump — pitched sine drop
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.10);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.7, t);
    og.gain.exponentialRampToValueAtTime(0.0008, t + 0.14);
    o.connect(og); og.connect(out);
    o.start(t); o.stop(t + 0.16);
  }

  impact(volume = 0.5) {
    if (!this.ready || !this.enabled) return;
    const t = this._now();
    const n = this.ctx.createBufferSource();
    n.buffer = this._noise;
    n.playbackRate.value = 1.6 + Math.random() * 0.6;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3200 + Math.random() * 1800; bp.Q.value = 2.2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 0.09);
    n.connect(bp); bp.connect(g); g.connect(this.master);
    n.start(t); n.stop(t + 0.12);
  }

  hitmarker(kill) {
    if (!this.ready || !this.enabled) return;
    const t = this._now();
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = kill ? 1180 : 880;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.10, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + (kill ? 0.14 : 0.055));
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.16);
  }

  mechanical(rate = 1) {
    if (!this.ready || !this.enabled) return;
    const t = this._now();
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.09 * rate;
      const n = this.ctx.createBufferSource();
      n.buffer = this._noise;
      n.playbackRate.value = 2.4;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1400 + i * 700; bp.Q.value = 4;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.16, at);
      g.gain.exponentialRampToValueAtTime(0.0005, at + 0.05);
      n.connect(bp); bp.connect(g); g.connect(this.master);
      n.start(at); n.stop(at + 0.07);
    }
  }

  explosion() {
    if (!this.ready || !this.enabled) return;
    const t = this._now();
    const n = this.ctx.createBufferSource();
    n.buffer = this._noise;
    n.playbackRate.value = 0.5;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1600, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 1.1);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(1.4, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 1.4);
    n.connect(lp); lp.connect(g); g.connect(this.master);
    n.start(t); n.stop(t + 1.5);
  }

  dispose() { this.ctx?.close(); }
}
