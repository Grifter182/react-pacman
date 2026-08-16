/**
 * OWNER: weapons agent.
 *
 * A tiny keyframed clip system, written because the viewmodel needs authored
 * *timing* — a reload is a sequence of mechanical beats, not a curve — while
 * everything around it stays procedural and additive.
 *
 * A clip is a set of channels. A channel names a node and a component
 * (`'mag.py'`, `'weapon.rx'`) and carries keys `[time, value, easeOut]`. The
 * player samples every channel into a flat pose object which the animator adds
 * on top of the procedural layers, so a clip never fights the sway spring or
 * the recoil — it offsets them.
 *
 * Clips also carry discrete events (`magOut`, `magIn`, `boltRelease`) which
 * fire exactly once as playback crosses their timestamp, even if the frame
 * that crossed them was long. That is what keeps the mag actually leaving the
 * gun on the frame the sound plays, at 30 fps and at 240.
 *
 * Channel component codes:  px py pz  (position)   rx ry rz  (rotation)
 */

/* ------------------------------------------------------------------ ease */

export const Ease = {
  linear: (t) => t,
  sineIn: (t) => 1 - Math.cos(t * Math.PI * 0.5),
  sineOut: (t) => Math.sin(t * Math.PI * 0.5),
  sineInOut: (t) => 0.5 - 0.5 * Math.cos(t * Math.PI),
  quadIn: (t) => t * t,
  quadOut: (t) => t * (2 - t),
  cubicIn: (t) => t * t * t,
  cubicOut: (t) => 1 - Math.pow(1 - t, 3),
  cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  quintOut: (t) => 1 - Math.pow(1 - t, 5),
  expoOut: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  /** Overshoots and settles — mechanical parts that slam into a stop. */
  backOut: (t) => {
    const c = 1.9;
    const u = t - 1;
    return 1 + (c + 1) * u * u * u + c * u * u;
  },
  /** Snap: fast break, long settle. Bolts, latches, mag releases. */
  snap: (t) => 1 - Math.pow(1 - t, 6),
  /** Decaying oscillation for a part that rings after it lands. */
  elasticOut: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -9 * t) * Math.cos(t * 22)),
  step: (t) => (t >= 1 ? 1 : 0),
};

/* ------------------------------------------------------------------ clip */

export class Clip {
  /**
   * @param {string} name
   * @param {number} duration seconds
   * @param {Object<string, Array>} channels  channel -> [[t, value, ease], ...]
   * @param {Array<[number,string]>} events   [time, eventName]
   */
  constructor(name, duration, channels, events = []) {
    this.name = name;
    this.duration = duration;
    this.events = events.slice().sort((a, b) => a[0] - b[0]);
    this.channels = [];
    for (const key of Object.keys(channels)) {
      const keys = channels[key].map((k) => ({
        t: k[0], v: k[1], ease: typeof k[2] === 'function' ? k[2] : Ease[k[2] || 'cubicInOut'],
      })).sort((a, b) => a.t - b.t);
      const dot = key.indexOf('.');
      this.channels.push({ node: key.slice(0, dot), comp: key.slice(dot + 1), keys });
    }
  }

  /** Sample one channel. Values hold flat before the first and after the last key. */
  static sampleChannel(ch, t) {
    const k = ch.keys;
    if (t <= k[0].t) return k[0].v;
    const last = k[k.length - 1];
    if (t >= last.t) return last.v;
    let i = 0;
    while (i < k.length - 1 && k[i + 1].t <= t) i++;
    const a = k[i], b = k[i + 1];
    const span = b.t - a.t;
    const u = span > 1e-6 ? (t - a.t) / span : 1;
    // The ease belongs to the *incoming* key: it describes how the value
    // arrives at b, which is how an animator thinks about a mechanical beat.
    return a.v + (b.v - a.v) * (b.ease ? b.ease(u) : u);
  }

  /** Accumulate this clip's pose at time `t` into `out`, scaled by `weight`. */
  sample(t, out, weight = 1) {
    for (const ch of this.channels) {
      const v = Clip.sampleChannel(ch, t) * weight;
      if (v === 0) continue;
      const node = out[ch.node] || (out[ch.node] = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 });
      node[ch.comp] += v;
    }
  }
}

/* ---------------------------------------------------------------- player */

/**
 * Plays one clip at a time with a blend-in/blend-out envelope, so switching
 * from a reload to a draw never pops. `onEvent` receives each clip event once.
 */
export class ClipPlayer {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.clip = null;
    this.time = 0;
    this.speed = 1;
    this.weight = 0;
    this._targetWeight = 0;
    this._blend = 12;
    this._eventIndex = 0;
    this._pending = null;
  }

  get playing() { return this.clip !== null; }
  get remaining() { return this.clip ? Math.max(0, (this.clip.duration - this.time) / this.speed) : 0; }

  play(clip, { speed = 1, blend = 12 } = {}) {
    this.clip = clip;
    this.time = 0;
    this.speed = speed;
    this._blend = blend;
    this._eventIndex = 0;
    this._targetWeight = 1;
    // Start from whatever weight the previous clip left behind: an interrupted
    // reload blends out of its own pose rather than snapping to rest first.
    if (this.weight <= 0) this.weight = 0;
  }

  stop(fast = false) {
    this._targetWeight = 0;
    this._blend = fast ? 22 : 9;
  }

  update(dt) {
    this.weight += (this._targetWeight - this.weight) * Math.min(1, dt * this._blend);
    if (!this.clip) { this.weight *= Math.max(0, 1 - dt * 10); return; }

    const prev = this.time;
    this.time += dt * this.speed;

    const ev = this.clip.events;
    while (this._eventIndex < ev.length && ev[this._eventIndex][0] <= this.time) {
      const [, name] = ev[this._eventIndex++];
      // Fire even if the frame overshot several beats — order is preserved.
      this.onEvent?.(name, this.clip);
    }

    if (this.time >= this.clip.duration) {
      this.time = this.clip.duration;
      this._targetWeight = 0;
      if (this.weight < 0.02) { this.clip = null; this.weight = 0; }
    }
    void prev;
  }

  sample(out) {
    if (this.clip && this.weight > 1e-4) this.clip.sample(this.time, out, this.weight);
  }
}

/* ---------------------------------------------------------- clip library */

/**
 * Every clip is generated from the weapon's own timings so a 1.7 s SMG reload
 * and a 3.2 s DMR reload have the same beats at different tempos, instead of
 * one authored clip stretched until it looks wrong.
 *
 * Node names used below:
 *   weapon      the whole gun, relative to the current hip/ADS pose
 *   mag         magazine
 *   charge      charging handle
 *   bolt        bolt carrier
 *   boltCatch   bolt release paddle
 *   left/right  the two hands
 */
export function buildClips(def, anchors) {
  const out = {};
  const magDrop = -0.26;
  // Where the left hand has to travel to reach the magazine, in weapon space,
  // measured from its resting position on the handguard.
  const gx = anchors.magGrab.x - anchors.leftHand.x;
  const gy = anchors.magGrab.y - anchors.leftHand.y;
  const gz = anchors.magGrab.z - anchors.leftHand.z;

  /* ------------------------------------------------------ tactical reload */
  {
    const T = def.reloadTime;
    const t = (f) => f * T;
    out.reload = new Clip('reload', T, {
      // The gun cants toward the shooter so the magwell is visible, dips as
      // the support hand leaves it, and recovers as the hand returns.
      'weapon.py': [[0, 0], [t(0.16), -0.036, 'cubicOut'], [t(0.62), -0.030], [t(0.88), 0.004, 'backOut'], [T, 0]],
      'weapon.pz': [[0, 0], [t(0.16), 0.028, 'cubicOut'], [t(0.70), 0.024], [T, 0, 'cubicInOut']],
      'weapon.rx': [[0, 0], [t(0.18), 0.30, 'cubicOut'], [t(0.66), 0.26], [t(0.90), -0.05, 'backOut'], [T, 0]],
      'weapon.rz': [[0, 0], [t(0.18), -0.52, 'cubicOut'], [t(0.70), -0.46], [T, 0, 'cubicInOut']],
      'weapon.ry': [[0, 0], [t(0.20), 0.16, 'cubicOut'], [t(0.72), 0.14], [T, 0, 'cubicInOut']],

      // Magazine: released, falls free, replaced by a fresh one driven up hard.
      'mag.py': [[0, 0], [t(0.26), 0, 'step'], [t(0.30), -0.030, 'quadIn'], [t(0.46), magDrop, 'quadIn'],
        [t(0.47), magDrop * 1.2, 'step'], [t(0.62), -0.075, 'cubicOut'], [t(0.78), 0, 'snap'], [T, 0]],
      'mag.pz': [[0, 0], [t(0.30), 0.004], [t(0.46), 0.030, 'quadIn'],
        [t(0.47), 0.055, 'step'], [t(0.62), 0.012, 'cubicOut'], [t(0.76), 0, 'snap'], [T, 0]],
      'mag.rx': [[0, 0], [t(0.34), -0.20, 'quadIn'], [t(0.46), -0.55, 'quadIn'],
        [t(0.47), 0.42, 'step'], [t(0.66), 0.10, 'cubicOut'], [t(0.78), 0, 'snap'], [T, 0]],

      // Support hand: down to the mag, out of frame with it, back with a
      // fresh one, then a slap on the floorplate and home to the handguard.
      'left.px': [[0, 0], [t(0.24), gx * 0.9, 'cubicOut'], [t(0.46), gx * 1.3], [t(0.62), gx * 0.9, 'cubicOut'], [t(0.86), 0, 'cubicInOut'], [T, 0]],
      'left.py': [[0, 0], [t(0.24), gy * 0.85, 'cubicOut'], [t(0.46), gy * 1.5, 'quadIn'], [t(0.60), gy * 1.05, 'cubicOut'], [t(0.80), gy * 0.25, 'cubicOut'], [t(0.94), 0, 'cubicInOut'], [T, 0]],
      'left.pz': [[0, 0], [t(0.24), gz * 0.9, 'cubicOut'], [t(0.46), gz * 1.2], [t(0.62), gz * 0.95], [t(0.88), 0, 'cubicInOut'], [T, 0]],
      'left.rx': [[0, 0], [t(0.26), -0.55, 'cubicOut'], [t(0.62), -0.35], [t(0.90), 0, 'cubicInOut'], [T, 0]],

      // Trigger finger comes off the shoe during the reload and returns.
      'right.rx': [[0, 0], [t(0.20), 0.10, 'cubicOut'], [t(0.80), 0.06], [T, 0, 'cubicInOut']],
    }, [
      [t(0.26), 'magRelease'],
      [t(0.30), 'magOut'],
      [t(0.62), 'magIn'],
      [t(0.80), 'magSeated'],
      [T, 'end'],
    ]);
  }

  /* --------------------------------------------------------- empty reload */
  {
    const T = def.reloadEmptyTime;
    const t = (f) => f * T;
    const r = out.reload;
    // The empty reload is the tactical one with the beats moved earlier to
    // make room for the bolt release, plus the bolt-catch action itself.
    const ch = {};
    for (const c of r.channels) {
      ch[`${c.node}.${c.comp}`] = c.keys.map((k) => [k.t / r.duration * T * 0.82, k.v, k.ease]);
    }
    ch['boltCatch.px'] = [[0, 0], [t(0.86), 0, 'step'], [t(0.885), 0.0045, 'snap'], [t(0.93), 0, 'backOut'], [T, 0]];
    ch['bolt.pz'] = [[0, 0.030], [t(0.885), 0.030, 'step'], [t(0.905), -0.004, 'snap'], [t(0.925), 0, 'backOut'], [T, 0]];
    ch['left.px'] = [...ch['left.px'], [t(0.86), 0.030, 'cubicOut'], [t(0.90), 0.030], [t(0.97), 0, 'cubicInOut'], [T, 0]];
    ch['left.py'] = [...ch['left.py'], [t(0.86), -0.010, 'cubicOut'], [t(0.90), -0.010], [t(0.97), 0, 'cubicInOut'], [T, 0]];
    ch['weapon.rz'] = [...ch['weapon.rz'], [t(0.84), -0.30], [t(0.92), -0.10, 'cubicOut'], [T, 0]];
    out.reloadEmpty = new Clip('reloadEmpty', T, ch, [
      [t(0.22), 'magRelease'],
      [t(0.25), 'magOut'],
      [t(0.51), 'magIn'],
      [t(0.66), 'magSeated'],
      [t(0.885), 'boltRelease'],
      [T, 'end'],
    ]);
  }

  /* ------------------------------------------------------------ draw/holster */
  {
    const T = def.drawTime;
    out.draw = new Clip('draw', T, {
      'weapon.py': [[0, -0.22], [T * 0.62, 0.012, 'cubicOut'], [T, 0, 'backOut']],
      'weapon.pz': [[0, 0.10], [T * 0.7, -0.006, 'cubicOut'], [T, 0, 'cubicInOut']],
      'weapon.rx': [[0, -0.95], [T * 0.62, 0.07, 'cubicOut'], [T, 0, 'backOut']],
      'weapon.ry': [[0, 0.55], [T * 0.7, -0.03, 'cubicOut'], [T, 0, 'cubicInOut']],
      'weapon.rz': [[0, 0.42], [T * 0.7, -0.04, 'cubicOut'], [T, 0, 'cubicInOut']],
      'charge.pz': [[0, 0.030], [T * 0.30, 0.030, 'step'], [T * 0.40, 0, 'snap'], [T, 0]],
      'left.py': [[0, -0.10], [T * 0.75, 0, 'cubicOut'], [T, 0]],
      'right.py': [[0, -0.14], [T * 0.70, 0, 'cubicOut'], [T, 0]],
    }, [[T * 0.34, 'boltRelease'], [T, 'end']]);

    const H = def.holsterTime;
    out.holster = new Clip('holster', H, {
      'weapon.py': [[0, 0], [H, -0.24, 'cubicIn']],
      'weapon.pz': [[0, 0], [H, 0.09, 'cubicIn']],
      'weapon.rx': [[0, 0], [H, -1.02, 'cubicIn']],
      'weapon.ry': [[0, 0], [H, 0.50, 'cubicIn']],
      'weapon.rz': [[0, 0], [H, 0.44, 'cubicIn']],
      'left.py': [[0, 0], [H, -0.12, 'cubicIn']],
    }, [[H, 'end']]);
  }

  /* ---------------------------------------------------------------- inspect */
  {
    const T = 2.6;
    out.inspect = new Clip('inspect', T, {
      // Roll the gun over to read the receiver, check the magwell, come back.
      'weapon.px': [[0, 0], [0.35, 0.030, 'cubicOut'], [1.15, 0.010], [1.75, -0.020, 'sineInOut'], [T, 0, 'cubicInOut']],
      'weapon.py': [[0, 0], [0.35, 0.028, 'cubicOut'], [1.20, 0.010], [1.80, -0.032, 'sineInOut'], [T, 0, 'cubicInOut']],
      'weapon.pz': [[0, 0], [0.40, 0.052, 'cubicOut'], [1.60, 0.040], [T, 0, 'cubicInOut']],
      'weapon.rx': [[0, 0], [0.35, -0.22, 'cubicOut'], [1.10, -0.10], [1.85, 0.42, 'sineInOut'], [T, 0, 'cubicInOut']],
      'weapon.ry': [[0, 0], [0.40, -0.62, 'cubicOut'], [1.20, -0.50], [1.90, 0.55, 'sineInOut'], [T, 0, 'cubicInOut']],
      'weapon.rz': [[0, 0], [0.40, 0.85, 'cubicOut'], [1.25, 0.70], [1.90, -0.45, 'sineInOut'], [T, 0, 'cubicInOut']],
      'left.py': [[0, 0], [0.5, -0.030, 'cubicOut'], [1.6, -0.020], [T, 0, 'cubicInOut']],
      'left.pz': [[0, 0], [0.5, 0.030, 'cubicOut'], [1.6, 0.020], [T, 0, 'cubicInOut']],
      'charge.pz': [[0, 0], [1.28, 0, 'step'], [1.40, 0.024, 'cubicOut'], [1.52, 0, 'snap'], [T, 0]],
      'cover.rz': [[0, 0], [1.30, 0, 'step'], [1.42, -1.30, 'cubicOut'], [2.10, -1.20], [2.30, 0, 'backOut'], [T, 0]],
    }, [[1.40, 'inspectCharge'], [T, 'end']]);
  }

  return out;
}
