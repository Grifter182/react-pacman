/**
 * OWNER: player-feel agent.
 *
 * Camera shake as a trauma model (Squirrel Eiserloh's formulation), not as
 * random jitter.
 *
 *   trauma  is a 0..1 reservoir that decays linearly with time
 *   shake   = trauma^2, so small hits are nearly invisible and big ones
 *             dominate — a linear mapping makes every event feel the same
 *   offsets are sampled from three *independent* 1-D Perlin channels at a
 *             fixed frequency, so the motion is continuous. Random per-frame
 *             offsets alias into buzz at any frame rate and, worse, look
 *             identical whether the frame took 4 ms or 40 ms.
 *
 * A high-frequency and a low-frequency octave are mixed per axis: the low one
 * is the recoil "push", the high one is the vibration riding on top.
 */

/** Classic 1-D gradient noise. Deterministic; seeded per axis. */
class Perlin1D {
  constructor(seed = 1) {
    this.g = new Float32Array(256);
    // xorshift so the table is reproducible across reloads and machines.
    let s = seed >>> 0 || 1;
    for (let i = 0; i < 256; i++) {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      this.g[i] = (s / 0xffffffff) * 2 - 1;
    }
  }

  at(x) {
    const i = Math.floor(x);
    const f = x - i;
    const a = this.g[i & 255];
    const b = this.g[(i + 1) & 255];
    // Quintic fade: C2 continuous, so the derivative of the shake is smooth
    // too and the camera never shows a kink at a lattice point.
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    // Gradient noise, not value noise: dot(gradient, distance).
    const va = a * f;
    const vb = b * (f - 1);
    return va + u * (vb - va);
  }

  /** Two octaves; the second is quieter and four times faster. */
  fbm(x) { return this.at(x) * 0.78 + this.at(x * 4.13 + 31.7) * 0.22; }
}

export class Trauma {
  constructor() {
    this.trauma = 0;
    this.decay = 1.35;            // trauma per second
    this.time = 0;

    this._n = [new Perlin1D(0x9E37), new Perlin1D(0x85EB), new Perlin1D(0xC2B2)];
    this._r = [new Perlin1D(0x27D4), new Perlin1D(0x1656), new Perlin1D(0x7F4A)];

    /** Positional shake, metres. */
    this.offset = { x: 0, y: 0, z: 0 };
    /** Rotational shake, radians — this is the part the eye actually reads. */
    this.rot = { x: 0, y: 0, z: 0 };

    this.frequency = 21.0;
    this.posScale = 0.055;
    this.rotScale = 0.075;
    this.scale = 1;
  }

  /** Add trauma. Additive, saturating — a burst does not reset the reservoir. */
  add(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Directional kick: biases the low-frequency component along a world axis. */
  impulse(amount, dirX = 0, dirY = 0, dirZ = 0) {
    this.add(amount);
    this._kickX = (this._kickX || 0) + dirX * amount;
    this._kickY = (this._kickY || 0) + dirY * amount;
    this._kickZ = (this._kickZ || 0) + dirZ * amount;
  }

  update(dt) {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - this.decay * dt);

    const s = this.trauma * this.trauma * this.scale;
    const t = this.time * this.frequency;

    if (s < 1e-5) {
      this.offset.x = this.offset.y = this.offset.z = 0;
      this.rot.x = this.rot.y = this.rot.z = 0;
    } else {
      const p = this.posScale * s;
      this.offset.x = this._n[0].fbm(t) * p;
      this.offset.y = this._n[1].fbm(t + 11.3) * p;
      this.offset.z = this._n[2].fbm(t + 23.9) * p * 0.55;

      const r = this.rotScale * s;
      this.rot.x = this._r[0].fbm(t * 0.87 + 5.1) * r;
      this.rot.y = this._r[1].fbm(t * 0.93 + 17.4) * r;
      this.rot.z = this._r[2].fbm(t * 1.07 + 41.2) * r * 1.35;   // roll reads loudest
    }

    // Directional kick decays much faster than the trauma tail: it is the
    // initial shove, not the ring-out.
    const k = Math.max(0, 1 - dt * 9);
    this._kickX = (this._kickX || 0) * k;
    this._kickY = (this._kickY || 0) * k;
    this._kickZ = (this._kickZ || 0) * k;
    this.offset.x += this._kickX * 0.10;
    this.offset.y += this._kickY * 0.10;
    this.offset.z += this._kickZ * 0.10;
  }

  reset() {
    this.trauma = 0;
    this._kickX = this._kickY = this._kickZ = 0;
    this.update(0);
  }
}
