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
 * FROM PROJECTED TRIANGLES TO BUILDING FOOTPRINTS.
 * Projecting the collider and calling it a floorplan does not produce one. A
 * building in this level is a shell of separate wall quads with seams between
 * them, its walls are 20 cm thick, and at the scale the minimap is drawn a 20 cm
 * wall is a third of a pixel. Rasterising that directly gives what the review
 * described exactly: scattered confetti, no legible geometry. What is missing is
 * a *closing* — the morphological operation that turns a set of nearly-touching
 * marks into the solid region they outline.
 *
 * The first half of the answer is that a projected wall has to be STROKED, not
 * filled — it is a line segment with zero area, and filling it drew literally
 * nothing. The second half is a *closing*.
 *
 * So the projection now feeds a binary mask, and the mask is closed (dilate by
 * r, then erode by r) before anything is drawn from it. Closing joins anything
 * separated by less than 2r while leaving the outer boundary where it was, so a
 * shell of wall quads becomes one filled footprint and an alley wider than 2r
 * stays open. A final 1 px dilate guarantees that a wall thinner than a pixel
 * still occupies one. The footprint is then filled as a solid body with a
 * brighter 2 px edge lifted off it — body reads the shape, edge reads the
 * boundary, which is how a plan is drawn.
 *
 * All of it is offscreen canvas compositing at boot. Per frame nothing changes:
 * still one rotated `drawImage`.
 *
 * ORIENTATION, AND THE BUG THAT LIVED HERE.
 *
 * A top-down plan is a view from ABOVE. That is a constraint, not a convention:
 * looking down -Y, the screen basis must satisfy `right x up = +Y`, or you have
 * drawn the view from underneath the level. This map used `+X` to the right and
 * `+Z` up, and `(+X) x (+Z) = -Y` — so every plan it ever drew was MIRRORED.
 *
 * That failure hides, because the obvious test passes. The rotation angle was
 * right, so the player's forward vector really did point at screen-up at every
 * yaw; what was wrong is that everything to their right was drawn on their left,
 * and turning right spun the plan the same way as the turn instead of against
 * it. Measured before the fix (tools/map-orient-probe.mjs): forward drawn UP at
 * 4/4 yaws, right drawn LEFT at 4/4 yaws, and a landmark dead ahead swinging
 * +6.4 across the disc on a right turn when it must swing negative.
 *
 * So: screen-right is `-X`, screen-up is `+Z`, and `(-X) x (+Z) = +Y`. The
 * camera's forward vector is `(-sin yaw, -cos yaw)`, which lands on screen-up
 * when the canvas is rotated by `yaw - PI`. Blips, the north pip and the view
 * cone all derive from those two facts rather than from a fudge factor.
 *
 * NAMING, so nobody "fixes" this back. The level's side codes — n/s/e/w in
 * `parapetSides: 'nse'` and friends — are GEOMETRY labels for +Z/-Z/+X/-X, and
 * they are internally left-handed, so they cannot all be compass bearings at
 * once. Navigation is defined here and in Compass.js: north is +Z (which is the
 * level's NORTH spawn, so dev notes about the north end still read true) and
 * compass east is -X. If you find yourself wanting +X on the right, re-read the
 * cross product above first.
 *
 * Per frame this is one rotated `drawImage` plus a handful of arcs, redrawn at
 * a tier-gated rate. No DOM is touched and nothing is allocated.
 */

const MAP_PX = 512;           // floorplan raster resolution
/* 34 m, not 46. The map disc is 168 CSS px across; at 46 m a three-metre stall
   was under six pixels wide and a street was indistinguishable from a gap
   between two marks. Pulling the radius in trades peripheral awareness — which
   the compass and the contact pings already carry — for a plan that can
   actually be read at a glance. */
const VIEW_RADIUS = 34;

/* Closing radius in plan pixels. At 512 px across a ~120 m level this is about
   1.4 m: wide enough to seal the seams between wall quads and the gap between a
   building and its own doorframe, narrow enough to leave real streets open. */
const CLOSE_R = 6;

/* Nominal wall thickness in metres, used as the stroke width when the projected
   triangles are drawn. See the long note in build(): a vertical wall has zero
   projected area, so the stroke is what actually puts it on the plan. */
const WALL_M = 0.42;

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
        <div class="foot"><span class="nm bl-t3">SUQ AL-HADID</span><span class="uav bl-t3">UAV</span></div>
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
    // Each pass rasterises to its own binary mask; colour is applied later, once
    // the mask has been closed into footprints.
    const passes = [
      { lo: 0.18, hi: 0.62, capped: true },    // low cover
      { lo: 0.62, hi: 3.40, capped: false },   // walls
    ];

    for (const pass of passes) {
      const mask = blankPlan();
      const g = mask.getContext('2d');
      pass.mask = mask;
      g.fillStyle = '#fff';
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

        const dy = maxY - minY;
        const cross = (ax[1] - ax[0]) * (az[2] - az[0]) - (ax[2] - ax[0]) * (az[1] - az[0]);
        const areaM2 = Math.abs(cross) * 0.5;
        // Near-horizontal triangles are floor and roof slabs; they would flood
        // the plan solid. Reject on vertical extent vs projected area.
        if (dy < 0.12 && areaM2 > 0.6) continue;
        // And anything with a large footprint in the walk band is a ramp, a
        // mezzanine or a slab however steep it is. A wall cannot have one: see
        // the note below — a wall's projected area is zero by construction.
        if (areaM2 > 14) continue;

        // Winding matters. Every triangle goes into one path filled with the
        // nonzero rule, and the collider is front-face-only, so projected
        // triangles arrive with both handednesses — two overlapping sub-paths
        // that wind opposite ways cancel and punch a hole in the plan. Forcing
        // a consistent orientation turns the fill into a union, which is what a
        // floorplan actually is, and costs one comparison per triangle.
        const flip = cross < 0;
        for (let i = 0; i < 3; i++) {
          const k = flip ? 2 - i : i;
          // Mirror X and flip Z: screen-right is -X, screen-up is +Z, which is
          // the only pairing that is a view from above. See the header note.
          const px = (span - (ax[k] - this.origin.x)) * scale;
          const py = (span - (az[k] - this.origin.z)) * scale;
          if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.closePath();
      }
      /*
       * FILLING A PROJECTED WALL DRAWS NOTHING. This is the bug underneath the
       * "scattered confetti" review, and it is geometric, not cosmetic: a
       * vertical wall quad projected onto the XZ plane is a *line segment*. Its
       * two triangles have exactly zero area, and a zero-area path fills zero
       * pixels. Everything that ever appeared on this plan came from the
       * incidental non-vertical geometry — chamfers, awnings, the odd sloped
       * crate lid — which is precisely a scatter of disconnected marks with no
       * building in it. The walls, the only thing a floorplan is actually made
       * of, were being drawn and discarded every single boot.
       *
       * So the plan is STROKED as well as filled. A stroke of one wall
       * thickness turns each projected segment into the mark it should always
       * have been, and the fill still catches the genuinely planar geometry.
       * Round joins and caps stop the corners of a building from opening up.
       */
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.lineWidth = Math.max(1, WALL_M * scale);
      g.fill();
      g.stroke();
    }

    /* --- masks -> footprints ---------------------------------------------- */
    // Close, then guarantee a minimum thickness. See the header note: this is
    // the step that turns projected wall quads into buildings.
    const cover = dilate(closeMask(passes[0].mask, Math.round(CLOSE_R * 0.6)), 1);
    const walls = dilate(closeMask(passes[1].mask, CLOSE_R), 1);
    // The boundary band is the footprint minus its own interior.
    const edge = subtract(walls, erode(walls, 2));

    const plan = blankPlan();
    const p = plan.getContext('2d');
    // Low cover sits under the buildings and stays a tone, not a shape.
    p.drawImage(tint(cover, 'rgba(104,134,164,0.40)'), 0, 0);
    // Building body: opaque enough to read as mass against the map ground.
    p.drawImage(tint(walls, 'rgba(126,158,188,0.78)'), 0, 0);
    // Boundary: the only bright value on the plan, so the eye reads outlines.
    p.drawImage(tint(edge, 'rgba(206,228,248,0.92)'), 0, 0);

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
    // `yaw - PI`, not `PI - yaw`. Both put forward on screen-up, which is why
    // the sign error survived; only this one also rotates the world AGAINST the
    // player's turn, on a plan whose X axis is mirrored to face upward.
    const rot = this._yaw - Math.PI;

    const c = this.ctx;
    const S = this.canvas.width;
    const R = S * 0.5;
    const ppm = R / VIEW_RADIUS;                 // canvas pixels per metre

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, S, S);
    c.save();
    // Circular clip: the frame is square but the readable region is a disc.
    c.beginPath(); c.arc(R, R, R - 1, 0, Math.PI * 2); c.clip();
    // Not black. A black disc makes every mark on the map a maximum-contrast
    // speck — which is precisely how a floorplan turns into confetti. The ground
    // is a dark blue-grey with a slight centre lift, so footprints sit on a
    // value rather than punching out of a hole.
    if (!this._ground || this._groundS !== S) {
      const gr = c.createRadialGradient(R, R, 0, R, R, R);
      gr.addColorStop(0, 'rgba(19,27,36,0.86)');
      gr.addColorStop(1, 'rgba(9,13,18,0.90)');
      this._ground = gr; this._groundS = S;
    }
    c.fillStyle = this._ground;
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
        -(this.origin.span - (px - this.origin.x)) * this.origin.scale,
        -(this.origin.span - (pz - this.origin.z)) * this.origin.scale,
      );
      c.drawImage(this.plan, 0, 0);
      c.restore();
    }

    /* --- range ring -------------------------------------------------------- */
    // One ring, not two. The second added a mark without adding a fact.
    c.strokeStyle = 'rgba(196,214,232,0.08)';
    c.lineWidth = Math.max(1, S / 260);
    c.beginPath(); c.arc(0, 0, 17 * ppm, 0, Math.PI * 2); c.stroke();

    /* --- blips ------------------------------------------------------------- */
    // Blips are culled to the disc. Off-map contacts used to be drawn anyway and
    // then clipped, which cost nothing but also meant the count of marks on the
    // map bore no relation to what was near the player.
    const reach = VIEW_RADIUS * 0.97;
    if (state.allies) {
      for (const a of state.allies) {
        const dx = a.x - px, dz = a.z - pz;
        if (dx * dx + dz * dz > reach * reach) continue;
        this._blip(c, -dx * ppm, -dz * ppm, S, 'rgba(120,206,255,0.95)', 1);
      }
    }

    // Live enemies only while a UAV is up; otherwise the player reads decaying
    // contact marks left by whatever made noise.
    if (state.uavActive && state.actors) {
      for (const a of state.actors) {
        if (!a.alive) continue;
        const dx = a.position.x - px, dz = a.position.z - pz;
        if (dx * dx + dz * dz > reach * reach) continue;
        this._blip(c, -dx * ppm, -dz * ppm, S, 'rgba(255,104,80,0.95)', 1.05);
      }
    }

    for (let i = this._blips.length - 1; i >= 0; i--) {
      const b = this._blips[i];
      b.t -= step;
      if (b.t <= 0) { this._blips.splice(i, 1); continue; }
      const k = b.t / b.dur;
      const rgb = b.kind === 'explosion' ? '255,181,69,' : '255,90,65,';
      const bx = -(b.x - px) * ppm, by = -(b.z - pz) * ppm;
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

    /* --- player marker + view cone (screen space, always pointing up) -------
     * The cone is the second-most important mark on the map after the plan
     * itself: it is the only thing that says which way the player is facing, and
     * at 28% alpha with no edge it was invisible against anything. It is now the
     * real horizontal FOV (±33°, close enough to the 80° base), reaches a third
     * of the disc, and carries a defined edge on both flanks so the wedge has a
     * shape rather than a haze. The marker inside it is outlined for the same
     * reason the crosshair blades are: it has to survive on top of a footprint.
     */
    c.save();
    c.translate(R, R);
    const cone = S * 0.33;
    const halfFov = 0.58;
    const grad = c.createLinearGradient(0, 0, 0, -cone);
    grad.addColorStop(0, 'rgba(150,206,246,0.30)');
    grad.addColorStop(0.55, 'rgba(150,206,246,0.11)');
    grad.addColorStop(1, 'rgba(150,206,246,0)');
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, cone, -Math.PI / 2 - halfFov, -Math.PI / 2 + halfFov);
    c.closePath();
    c.fillStyle = grad;
    c.fill();
    // The two flanks, drawn as lines so the wedge has a boundary. The arc at the
    // far end is deliberately left open — a closed wedge reads as a fixed range,
    // which is not what a facing indicator means.
    c.strokeStyle = 'rgba(168,216,252,0.34)';
    c.lineWidth = Math.max(1, S / 300);
    for (const sgn of [-1, 1]) {
      const a = -Math.PI / 2 + sgn * halfFov;
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(Math.cos(a) * cone, Math.sin(a) * cone);
      c.stroke();
    }

    c.beginPath();
    c.moveTo(0, -S * 0.052);
    c.lineTo(S * 0.036, S * 0.038);
    c.lineTo(0, S * 0.016);
    c.lineTo(-S * 0.036, S * 0.038);
    c.closePath();
    c.fillStyle = state.alive ? 'rgba(236,244,252,0.96)' : '#ff5a41';
    c.strokeStyle = 'rgba(4,7,11,0.85)';
    c.lineWidth = Math.max(1, S / 150);
    c.stroke();
    c.fill();
    c.restore();

    // North pip orbits the frame edge. North is +Z, which is (0,-1) in map
    // space, so after `rotate(yaw - PI)` it lands at (-sin yaw, cos yaw).
    const rr = (this._cssRadius || 84) * 0.82;
    this.rose.style.transform =
      `translate(-50%,-50%) translate(${(-Math.sin(this._yaw) * rr).toFixed(1)}px,` +
      ` ${(Math.cos(this._yaw) * rr).toFixed(1)}px)`;
  }

  /** A contact mark: a filled dot inside a dark ring, so it reads on the plan. */
  _blip(c, x, y, S, colour, scale) {
    const r = Math.max(1.5, S * 0.018 * scale);
    c.strokeStyle = 'rgba(4,7,11,0.8)';
    c.lineWidth = Math.max(1, S / 190);
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = colour;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }

  dispose() { this.plan = null; }
}

/* ---------------------------------------------------------------- morphology
 *
 * Binary morphology on an alpha channel, done with canvas compositing rather
 * than pixel loops — `drawImage` at an integer offset is a straight blit with no
 * resampling, so translating a mask is exact.
 *
 *   dilate  = union of translated copies       (source-over)
 *   erode   = intersection of translated copies (destination-in)
 *   close   = dilate then erode, which fills gaps without growing the outline
 *
 * The structuring element is a SQUARE, and squares are separable: dilating by a
 * (2r+1) square is a horizontal pass followed by a vertical one, 4r+2 blits
 * instead of the (2r+1)^2 a two-dimensional kernel needs. At r=6 that is 26
 * blits per operation rather than 169 — the difference between a boot cost
 * worth thinking about and one that is not. A disc would be marginally rounder
 * at the corners of a building; at four plan pixels per metre nobody can see it.
 */

function blankPlan() {
  const c = document.createElement('canvas');
  c.width = c.height = MAP_PX;
  return c;
}

/** One separable half-pass. `axis` is 0 for horizontal, 1 for vertical. */
function sweep(src, r, axis, intersect) {
  const out = blankPlan();
  const g = out.getContext('2d');
  g.drawImage(src, 0, 0);
  if (intersect) g.globalCompositeOperation = 'destination-in';
  for (let d = -r; d <= r; d++) {
    if (d === 0) continue;
    g.drawImage(src, axis ? 0 : d, axis ? d : 0);
  }
  return out;
}

function dilate(src, r) {
  if (r <= 0) return src;
  return sweep(sweep(src, r, 0, false), r, 1, false);
}

function erode(src, r) {
  if (r <= 0) return src;
  return sweep(sweep(src, r, 0, true), r, 1, true);
}

function closeMask(src, r) { return erode(dilate(src, r), r); }

/** a AND NOT b. */
function subtract(a, b) {
  const out = blankPlan();
  const g = out.getContext('2d');
  g.drawImage(a, 0, 0);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(b, 0, 0);
  return out;
}

/** Flood a mask with one colour, keeping its alpha. */
function tint(mask, colour) {
  const out = blankPlan();
  const g = out.getContext('2d');
  g.drawImage(mask, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = colour;
  g.fillRect(0, 0, MAP_PX, MAP_PX);
  return out;
}

/** Shortest-arc damping so the map never spins the long way round zero. */
function dampAngle(cur, target, rate, dt) {
  let d = ((target - cur + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return cur + d * (1 - Math.exp(-rate * dt));
}
