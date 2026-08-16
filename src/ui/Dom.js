/**
 * OWNER: UI/UX agent.
 *
 * Tiny DOM helpers plus the icon set. Every icon is inline SVG built from
 * path data in this file — the project ships no image assets and fetches
 * nothing, so a weapon glyph in the killfeed has to be drawn, not loaded.
 *
 * The icons are authored on a 64x24 viewBox with the muzzle pointing left,
 * which is the orientation a killfeed reads in (attacker -> victim).
 */

/** `el('div.bl-panel', { text: 'HI' }, child, child)` */
export function el(spec, attrs = null, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style') node.setAttribute('style', v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
  }
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

/** Parse an HTML fragment once and return the first element. */
export function frag(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }

/** Exponential smoothing that is stable across variable frame times. */
export function damp(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** `mm:ss`, for the round clock. */
export function clock(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ icons */

const ICON_BODY = {
  // Carbine: handguard, magazine well, stock, carry handle.
  rifle: `<path d="M2 12h13l2-3h4l1 3h9v-3h4v3h11l3-4h5v4h6v3h-6l-2 4h-8l-1 5h-5l1-5h-9l-3-2H21l-1 2h-5l1-2H2z"/>
          <rect x="30" y="15" width="5" height="7" rx="1"/>`,
  // SMG: short barrel, deep vertical magazine, folding stock.
  smg: `<path d="M6 12h9l2-3h5v3h20l2-4h6v4h8v3h-8l-2 3H30l-2 4h-6l2-4h-9l-2 2H6z"/>
        <rect x="26" y="15" width="6" height="9" rx="1"/>`,
  // DMR: long barrel, scope block, skeleton stock.
  dmr: `<path d="M1 12h16l2-2h6v2h13l2-3h7v3h10v3h-10l-2 3H36l-2 5h-6l2-5h-9l-2 2H1z"/>
        <rect x="30" y="4" width="20" height="5" rx="1"/><rect x="33" y="9" width="3" height="3"/>`,
  // Frag: body, spoon, ring.
  grenade: `<path d="M30 6h6v3h4a10 10 0 1 1-14 0h4V6z"/><path d="M36 5h8v2h-8z"/><circle cx="46" cy="6" r="3" fill="none" stroke-width="2"/>`,
  // Airstrike: swept delta with two released bombs.
  airstrike: `<path d="M4 12h22l10-8h5l-4 8h14l6-4h4l-4 6 4 6h-4l-6-4H37l4 8h-5l-10-8H4z"/>
              <circle cx="22" cy="21" r="2"/><circle cx="31" cy="22" r="2"/>`,
  // UAV: fuselage, wings, sensor ball.
  uav: `<path d="M8 11h44v3H8z"/><path d="M22 3h6v8h-6zM22 14h6v8h-6z"/><circle cx="52" cy="12" r="4"/>`,
  // Fall / world damage.
  world: `<path d="M8 20h48l-12-14-8 9-6-6-10 11z"/>`,
  // Melee.
  melee: `<path d="M6 16l26-8 22-4-18 10-24 6z"/><path d="M4 17h10v4H4z"/>`,
};

/**
 * Inline SVG for a weapon or death cause.
 * @param {string} id  weapon id or cause label
 * @param {string} cls extra class on the <svg>
 */
export function weaponIcon(id, cls = '') {
  const body = ICON_BODY[id] || ICON_BODY.rifle;
  return `<svg class="bl-ico ${cls}" viewBox="0 0 64 26" aria-hidden="true">${body}</svg>`;
}

/** Small square-bracket glyphs used as list bullets and rank chips. */
export function bracket(text) {
  return `<span class="bl-brk">${text}</span>`;
}
