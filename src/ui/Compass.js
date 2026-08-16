import { frag } from './Dom.js';

/**
 * OWNER: UI/UX agent.
 *
 * Heading tape. The tape is built once, three full turns wide, and the middle
 * turn is the one that is ever on screen — so the transform can be a plain
 * translate with no wrap seam and no rebuild.
 *
 * Bearing derivation: the camera's forward vector is `(-sin yaw, -cos yaw)` and
 * +Z is north, so the compass bearing measured clockwise from north is
 * `atan2(-sin yaw, -cos yaw)` = `yaw + PI`.
 */

const PX_PER_DEG = 3.6;      // 120 degrees across a 432 px tape
const CARDINALS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

export class Compass {
  constructor(parent) {
    this.node = frag(`
      <div class="bl-compass"><div class="strip"></div><i class="lead"></i></div>`);
    parent.appendChild(this.node);
    this.strip = this.node.querySelector('.strip');

    this.readout = frag('<div class="bl-bearing bl-num">000</div>');
    parent.appendChild(this.readout);

    let html = '';
    for (let d = 0; d < 1080; d += 5) {
      const x = d * PX_PER_DEG;
      const m = d % 360;
      const major = m % 45 === 0;
      html += `<u class="${major ? 'maj' : ''}" style="left:${x}px"></u>`;
      if (major) {
        html += `<s class="card" style="left:${x}px">${CARDINALS[m]}</s>`;
      } else if (m % 15 === 0) {
        html += `<s style="left:${x}px">${String(m).padStart(3, '0')}</s>`;
      }
    }
    this.strip.innerHTML = html;

    this._last = -1;
    this._lastDeg = -1;
  }

  update(yaw) {
    let deg = ((yaw + Math.PI) * 180) / Math.PI;
    deg = ((deg % 360) + 360) % 360;
    // Offset by a full turn so the tape is always sampled from its middle copy.
    const x = -(deg + 360) * PX_PER_DEG;
    const rx = Math.round(x * 2) / 2;
    if (rx !== this._last) {
      this.strip.style.transform = `translateX(${rx}px)`;
      this._last = rx;
    }
    const d = Math.round(deg) % 360;
    if (d !== this._lastDeg) {
      this.readout.textContent = String(d).padStart(3, '0');
      this._lastDeg = d;
    }
  }

  setVisible(v) {
    this.node.style.display = v ? '' : 'none';
    this.readout.style.display = v ? '' : 'none';
  }
}
