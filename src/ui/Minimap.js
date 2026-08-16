import { frag } from './Dom.js';
import { Config, QualityTier } from '../core/Config.js';

/**
 * OWNER: UI/UX agent.
 *
 * Rotating minimap.
 *
 * The floorplan is not hand-authored and it is not a top-down render of the
 * scene: it is rasterised once, at boot, straight off the collision mesh. Every
 * triangle whose centroid sits in the waist-to-head band (0.62 m .. 3.2 m) is
 * projected onto the XZ plane and filled into an offscreen canvas. That band is
 * exactly what a player collides with, so the plan shows walls, stalls and
 * containers while ignoring the ground plane and the roofs — which is what a
 * floorplan is. A second, lighter pass takes the 0.15 m .. 0.62 m band so low
 * cover reads as its own tone.
 *
 * ORIENTATION. World axes are +X east, +Z north; the camera's forward vector is
 * `(-sin yaw, -cos yaw)`. Map space flips Z so north is up before rotation, and
 * the canvas is then rotated by `PI - yaw`, which is the unique angle that puts
 * the player's forward vector on screen-up. Everything else — blips, the north
 * pip, the view cone — derives from those two facts rather than from a fudge
 * factor.
 *
 * Per frame this is one rotated `drawImage` plus a handful of arcs, redrawn at
 * a tier-gated rate. No DOM is touched and nothing is allocated.
 */

const MAP_PX = 512;           // floorplan raster resolution
const VIEW_RADIUS = 46;       // metres from the player to the map edge

const REDRAW_HZ = {
  [QualityTier.LOW]: 20,
  [QualityTier.MEDIUM]: 30,
  [QualityTier.HIGH]: 60,
  [QualityTier.ULTRA]: 60,
};

export class Minimap {
  constructor(parent) {
    this.node = frag(`
      <div class="bl-map">
        <div class="frame bl-panel">
          <canvas></canvas>
          <div class="rose"><b>N</b></div>
        </div>
        <div class="foot"><span class="nm">SUQ AL-HADID</span><span class="uav">UAV</span></div>
      </div>`);
    parent.appendChild(this.node);

    this.canvas = this.node.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.rose = this.node.querySelector('.rose b');
    this.uavTag = this.node.querySelector('.uav');

    this.plan = null;
    this.origin = { x: 0, z: 0, span: 1, scale: 1 };

    this._yaw = 0;
    this._acc = 0;
    this._blips = [];          // transient contacts: { x, z, t, dur, kind }
    this._sized = false;
    this.uav = false;
  }

  /** Rasterise the floorplan from the collision geometry. One-time cost. */
  build(collider, bounds) {
    if (!collider?.geometry || !bounds) return;
    const t0 = performance.now();

    const w = bounds.max.x - bounds.min.x;
    const d = bounds.max.z - bounds.min.z;
    const span = Math.max(w, d);
    const scale = MAP_PX / span;
    this.origin = {
      x: bounds.min.x - (span - w) * 0.5,
      z: bounds.min.z - (span - d) * 0.5,
      span, scale,
    };

    const plan = document.createElement('canvas');
    plan.width = plan.height = MAP_PX;
    const g = plan.getContext('2d');

    const pos = collider.geometry.getAttribute('position');
    const idx = collider.geometry.getIndex();
    const triCount = Math.floor((idx ? idx.count : pos.count) / 3);
    // Big colliders get sub-sampled: the plan is 512 px, so one triangle in
    // three is visually indistinguishable and keeps the boot cost flat.
    const step = triCount > 90000 ? 3 : triCount > 40000 ? 2 : 1;

    const ax = [0, 0, 0], ay = [0, 0, 0], az = [0, 0, 0];
    // Membership is by vertical *overlap*, not by centroid. A building wall is
    // often one quad from the floor to a roof six metres up; its centroid sits
    // well above head height, and a centroid test throws away exactly the
    // geometry a floorplan is made of.
    const passes = [
      { lo: 0.18, hi: 0.62, fill: 'rgba(122,152,180,0.30)', capped: true },   // low cover
      { lo: 0.62, hi: 3.40, fill: 'rgba(178,206,232,0.62)', capped: false },  // walls
    ];

    for (const pass of passes) {
      g.fillStyle = pass.fill;
      g.beginPath();
      for (let t = 0; t < triCount; t += step) {
        const base = t * 3;
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx.getX(base + k) : base + k;
          ax[k] = pos.getX(vi); ay[k] = pos.getY(vi); az[k] = pos.getZ(vi);
        }
        const minY = Math.min(ay[0], ay[1], ay[2]);
        const maxY = Math.max(ay[0], ay[1], ay[2]);
        if (maxY <= pass.lo || minY >= pass.hi) continue;
        // The low-cover pass wants only things you can see over, so anything
        // that also reaches the wall band belongs to the wall pass instead.
        if (pass.capped && maxY > 0.62) continue;

        // Near-horizontal triangles are floor and roof slabs; they would flood
        // the plan solid. Reject on vertical extent vs projected area.
        const dy = maxY - minY;
        const cross = (ax[1] - ax[0]) * (az[2] - az[0]) - (ax[2] - ax[0]) * (az[1] - az[0]);
        if (dy < 0.12 && Math.abs(cross) * 0.5 > 0.6) continue;

        // Winding matters. Every triangle goes into one path filled with the
        // nonzero rule, and the collider is front-face-only, so projected
        // triangles arrive with both handednesses — two overlapping sub-paths
        // that wind opposite ways cancel and punch a hole in the plan. Forcing
        // a consistent orientation turns the fill into a union, which is what a
        // floorplan actually is, and costs one comparison per triangle.
        const flip = cross < 0;
        for (let i = 0; i < 3; i++) {
          const k = flip ? 2 - i : i;
          const px = (ax[k] - this.origin.x) * scale;
          const py = (span - (az[k] - this.origin.z)) * scale;   // flip Z: north up
          if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.closePath();
      }
      g.fill();
    }

    this.plan = plan;
    console.info('[HUD] minimap plan rasterised in', (performance.now() - t0).toFixed(0),
      `ms (${Math.round(triCount / step)} tris)`);
  }

  /** A contact worth showing: enemy fire, a spot, an explosion. */
  ping(x, z, kind = 'contact', dur = 2.6) {
    // Fixed-capacity ring — a firefight must not grow this array.
    if (this._blips.length > 24) this._blips.shift();
    this._blips.push({ x, z, t: dur, dur, kind });
  }

  setUav(on) {
    if (this.uav === on) return;
    this.uav = on;
    this.uavTag.classList.toggle('on', on);
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 4) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(64, Math.round(r.width * dpr));
    if (this.canvas.width !== w) { this.canvas.width = this.canvas.height = w; }
    this._cssRadius = r.width * 0.5;
    this._sized = true;
  }

  /**
   * @param state { position, yaw, alive, actors, allies, uavActive }
   */
  update(dt, state) {
    this._acc += dt;
    const hz = REDRAW_HZ[Config.quality] || 30;
    if (this._acc < 1 / hz) return;
    const step = this._acc;
    this._acc = 0;

    if (!this._sized || this.canvas.width < 8) this._resize();
    if (!this._sized) return;

    // A hard-locked rotation jitters under mouse micro-movement; damping the
    // yaw the map uses keeps north readable without feeling laggy.
    this._yaw = dampAngle(this._yaw, state.yaw, 18, step);
    const rot = Math.PI - this._yaw;

    const c = this.ctx;
    const S = this.canvas.width;
    const R = S * 0.5;
    const ppm = R / VIEW_RADIUS;                 // canvas pixels per metre

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, S, S);
    c.save();
    // Circular clip: the frame is square but the readable region is a disc.
    c.beginPath(); c.arc(R, R, R - 1, 0, Math.PI * 2); c.clip();
    c.fillStyle = 'rgba(6,10,14,0.74)';
    c.fillRect(0, 0, S, S);

    c.translate(R, R);
    c.rotate(rot);

    const px = state.position.x, pz = state.position.z;

    /* --- floorplan --------------------------------------------------------- */
    if (this.plan) {
      const k = ppm / this.origin.scale;
      c.save();
      c.scale(k, k);
      c.translate(
        -(px - this.origin.x) * this.origin.scale,
        -(this.origin.span - (pz - this.origin.z)) * this.origin.scale,
      );
      c.drawImage(this.plan, 0, 0);
      c.restore();
    }

    /* --- range rings ------------------------------------------------------- */
    c.strokeStyle = 'rgba(196,214,232,0.09)';
    c.lineWidth = Math.max(1, S / 240);
    for (const m of [15, 30]) { c.beginPath(); c.arc(0, 0, m * ppm, 0, Math.PI * 2); c.stroke(); }

    /* --- blips ------------------------------------------------------------- */
    if (state.allies) {
      for (const a of state.allies) {
        this._blip(c, (a.x - px) * ppm, -(a.z - pz) * ppm, S, 'rgba(99,200,255,0.92)', 1);
      }
    }

    // Live enemies only while a UAV is up; otherwise the player reads decaying
    // contact marks left by whatever made noise.
    if (state.uavActive && state.actors) {
      for (const a of state.actors) {
        if (!a.alive) continue;
        this._blip(c, (a.position.x - px) * ppm, -(a.position.z - pz) * ppm, S, 'rgba(255,90,65,0.95)', 1.05);
      }
    }

    for (let i = this._blips.length - 1; i >= 0; i--) {
      const b = this._blips[i];
      b.t -= step;
      if (b.t <= 0) { this._blips.splice(i, 1); continue; }
      const k = b.t / b.dur;
      const rgb = b.kind === 'explosion' ? '255,181,69,' : '255,90,65,';
      const bx = (b.x - px) * ppm, by = -(b.z - pz) * ppm;
      // The contact pings outward once and fades: motion pulls the eye to the
      // edge of the map without needing a brighter dot.
      c.strokeStyle = `rgba(${rgb}${(k * 0.5).toFixed(3)})`;
      c.lineWidth = Math.max(1, S / 260);
      c.beginPath();
      c.arc(bx, by, 2 + (1 - k) * 8 * (S / 200), 0, Math.PI * 2);
      c.stroke();
      this._blip(c, bx, by, S, `rgba(${rgb}${k.toFixed(3)})`, 0.85);
    }

    c.restore();

    /* --- player marker + view cone (screen space, always pointing up) ------- */
    c.save();
    c.translate(R, R);
    const cone = S * 0.17;
    const grad = c.createLinearGradient(0, 0, 0, -cone);
    grad.addColorStop(0, 'rgba(221,231,241,0.28)');
    grad.addColorStop(1, 'rgba(221,231,241,0)');
    c.fillStyle = grad;
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, cone, -Math.PI / 2 - 0.46, -Math.PI / 2 + 0.46);
    c.closePath();
    c.fill();

    c.fillStyle = state.alive ? '#dde7f1' : '#ff5a41';
    c.beginPath();
    c.moveTo(0, -S * 0.034);
    c.lineTo(S * 0.024, S * 0.026);
    c.lineTo(0, S * 0.012);
    c.lineTo(-S * 0.024, S * 0.026);
    c.closePath();
    c.fill();
    c.restore();

    // North pip orbits the frame edge. North is (0,-1) in map space, so after
    // the rotation it lands at (sin yaw, cos yaw) on screen.
    const rr = (this._cssRadius || 84) * 0.82;
    this.rose.style.transform =
      `translate(-50%,-50%) translate(${(Math.sin(this._yaw) * rr).toFixed(1)}px,` +
      ` ${(Math.cos(this._yaw) * rr).toFixed(1)}px)`;
  }

  _blip(c, x, y, S, colour, scale) {
    const r = Math.max(1.5, S * 0.016 * scale);
    c.fillStyle = colour;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }

  dispose() { this.plan = null; }
}

/** Shortest-arc damping so the map never spins the long way round zero. */
function dampAngle(cur, target, rate, dt) {
  let d = ((target - cur + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return cur + d * (1 - Math.exp(-rate * dt));
}
