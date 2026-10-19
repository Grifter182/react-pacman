/**
 * OWNER: netcode agent.
 *
 * The wire protocol, shared verbatim by the browser client (NetModule.js) and
 * the relay (server/relay.mjs). Pure JS, no DOM and no three.js, so Node can
 * import it unchanged.
 *
 * TRANSPORT
 *   One WebSocket per client, JSON text frames, keys kept short because the
 *   state message goes out twenty times a second per player.
 *
 * AUTHORITY
 *   Movement is client-authoritative and interpolated by everyone else.
 *   Hits are shooter-authoritative ("favour the shooter"): the shooter tests
 *   the round against the interpolated body it actually saw, which is the
 *   lag compensation. The relay sanity-checks the claim (rate, range, damage
 *   cap) and forwards it to the victim only. Deaths are victim-authoritative:
 *   the victim's own health hit zero, so the victim reports it, and the relay
 *   owns the kill/death tally that everyone's scoreboard shows.
 *
 * CLIENT -> RELAY
 *   hello { name, room, v }
 *   st    { p:[x,y,z] feet, v:[x,y,z], y:yaw, pi:pitch, s:stance, a:alive, w:weapon, ads }
 *   fire  { o:[x,y,z] eye, d:[x,y,z], e:[x,y,z]|null end, n:[x,y,z]|null normal, m:material, w }
 *   hit   { to, dmg, hs, limb }
 *   died  { by:id|null, hs }
 *   ping  { c:clientMs }
 *
 * RELAY -> CLIENT
 *   welcome { id, name, room, hz, players:[{ id, name, k, d }] }
 *   join    { id, name }
 *   leave   { id }
 *   snap    { s:serverMs, ps:[{ id, ...st }] }
 *   fire    { id, ...fire }
 *   hit     { by, dmg, hs, limb, o:[x,y,z] shooter eye }
 *   kill    { killer:id|null, victim, hs, score:[{ id, k, d }] }
 *   pong    { c, s }
 *   error   { reason }
 */

export const PROTOCOL_VERSION = 1;

/** Snapshot rate. 20 Hz is the usual compromise for a relay-only shooter. */
export const TICK_HZ = 20;

/** Remote bodies are drawn this far in the past so there is always a pair of
 *  snapshots to interpolate between. Two ticks plus jitter headroom. */
export const INTERP_DELAY_MS = 110;

export const DEFAULT_PORT = 8787;
export const NET_PATH = '/net';

export const MAX_NAME = 12;
export const MAX_ROOM = 24;
export const MAX_PLAYERS_PER_ROOM = 16;

/** Hard ceiling on a single hit claim: a point-blank headshot from the
 *  heaviest weapon table entry, with margin. Anything above is rejected. */
export const MAX_HIT_DAMAGE = 240;

/** Uppercase callsign, the same shape the roster and killfeed already use. */
export function sanitizeName(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, MAX_NAME);
  return s;
}

export function sanitizeRoom(raw) {
  const s = String(raw ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, MAX_ROOM);
  return s || 'public';
}

/** Round to centimetres / milliradians: halves the JSON size of a state frame. */
export function q(v, scale = 100) { return Math.round(v * scale) / scale; }

export function vec3(v, scale = 100) { return v ? [q(v.x, scale), q(v.y, scale), q(v.z, scale)] : null; }

export function isVec3(a) {
  return Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === 'number' && Number.isFinite(n));
}
