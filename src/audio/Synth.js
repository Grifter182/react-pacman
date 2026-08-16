/**
 * OWNER: audio agent.
 *
 * Signal-generation primitives. Nothing in this project loads a sample, so
 * every sound starts from one of these: a noise buffer, an impulse response, or
 * an oscillator with a shaped envelope.
 *
 * The buffers here are generated once at boot and shared by every voice —
 * allocating a fresh 2-second noise buffer per gunshot would be several
 * megabytes a second during automatic fire.
 */

/** White noise, uniform. The workhorse for transients and air. */
export function whiteNoise(ctx, seconds = 2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * Pink noise via the Voss-McCartney update: 1/f spectrum, which is what wind,
 * distant traffic and room tone actually look like. White noise as an ambience
 * bed reads as tape hiss; pink reads as air.
 */
export function pinkNoise(ctx, seconds = 4) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buf;
}

/**
 * Synthetic impulse response.
 *
 * A convolution reverb is only as good as its IR's *early* structure — the tail
 * is just noise under an envelope, but the first 80 ms is what tells the ear how
 * big the room is and how far away the walls are. So the early section is built
 * from discrete reflections at increasing density (a Poisson-ish sprinkle whose
 * rate rises with time), and only after that does it hand over to a smooth
 * exponentially decaying noise tail. The two channels are decorrelated so the
 * result is wide rather than a mono blob in the middle.
 *
 * @param opts.seconds   total IR length
 * @param opts.decay     tail exponent — higher is drier
 * @param opts.predelay  seconds of silence before the first reflection
 * @param opts.damping   0..1 high-frequency loss over the tail
 */
export function impulseResponse(ctx, { seconds = 2, decay = 2.4, predelay = 0.008, damping = 0.5 } = {}) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  const pre = Math.floor(rate * predelay);

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // One-pole low-pass state, so the tail loses treble the way a real room does.
    let lp = 0;
    const coeff = 1 - Math.pow(damping, 0.35);
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre);
      const env = Math.pow(1 - t, decay);
      // Early reflection density ramps from sparse to dense over ~90 ms.
      const early = (i - pre) / rate < 0.09;
      const density = early ? 0.0025 + ((i - pre) / rate) * 0.9 : 1;
      let s = Math.random() < density ? (Math.random() * 2 - 1) : 0;
      if (early) s *= 1.6;
      lp += (s - lp) * coeff;
      d[i] = lp * env;
    }
  }
  return buf;
}

/** Exponential decay to a floor — the only safe shape for `exponentialRamp`. */
export function decayTo(param, t0, peak, seconds, floor = 0.0006) {
  param.setValueAtTime(Math.max(floor, peak), t0);
  param.exponentialRampToValueAtTime(floor, t0 + Math.max(0.008, seconds));
}

/** Attack then decay, both exponential. `attack` in seconds. */
export function pluck(param, t0, peak, attack, release, floor = 0.0006) {
  param.setValueAtTime(floor, t0);
  param.exponentialRampToValueAtTime(Math.max(floor, peak), t0 + attack);
  param.exponentialRampToValueAtTime(floor, t0 + attack + release);
}

/** A one-shot noise voice: source -> filter -> gain. Returns the gain node. */
export function noiseVoice(ctx, buffer, { type = 'bandpass', freq = 1000, q = 1, rate = 1, offset = null } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const filt = ctx.createBiquadFilter();
  filt.type = type;
  filt.frequency.value = freq;
  filt.Q.value = q;
  const g = ctx.createGain();
  g.gain.value = 0;
  src.connect(filt); filt.connect(g);
  // Starting at a random offset stops repeated shots from sounding identical:
  // the same buffer read from a different place is a different transient.
  g._src = src;
  g._filt = filt;
  g._offset = offset === null ? Math.random() * Math.max(0.01, buffer.duration - 0.6) : offset;
  return g;
}

/**
 * Start a voice, clamping the random read offset so the source cannot run off
 * the end of the shared buffer mid-sound. Playback rate is folded in because a
 * source playing at 2x consumes twice the buffer for the same wall-clock time.
 */
export function startVoice(g, t0, dur) {
  const buf = g._src.buffer;
  const rate = g._src.playbackRate.value || 1;
  let off = g._offset;
  if (buf) off = Math.max(0, Math.min(off, buf.duration - dur * rate));
  try { g._src.start(t0, off, dur); } catch { g._src.start(t0); }
  g._src.stop(t0 + dur + 0.02);
}

/** A shaper curve for gentle saturation — used on the weapon bus. */
export function softClipCurve(amount = 2.2, n = 1024) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

export const SPEED_OF_SOUND = 343;   // m/s at 20 °C — used for report delay
