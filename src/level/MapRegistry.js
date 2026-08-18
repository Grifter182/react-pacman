/**
 * The list of playable maps, and the one place that decides which one boots.
 *
 * The engine registers exactly one module under the name `level`, and every
 * consumer — the player's spawn, the AI's navmesh, the minimap's floorplan, the
 * match's objectives — looks it up by that name. So a "map" here is simply a
 * choice of which implementation gets registered, and every entry must satisfy
 * the same contract:
 *
 *     .collider    a Mesh whose geometry carries a three-mesh-bvh boundsTree
 *     .bounds      a Box3 enclosing the playable area
 *     .pickSpawn(team, avoid)  -> { position, yaw }
 *     .navPoints   array of objective/patrol anchors (may be empty)
 *     .root        the scene graph node holding the visuals
 *     .stats       whatever the budget logger wants to print
 *
 * SWITCHING MAPS RELOADS THE PAGE, deliberately. Modules are registered before
 * `engine.init()`, so the choice has to be made at boot; swapping mid-session
 * would mean tearing down and rebuilding collision, the navmesh, the cover map,
 * the minimap raster, the match state and every actor, which is a great deal of
 * failure surface for a transition that every other shooter also spends a
 * loading screen on.
 */

/**
 * ATTRIBUTION IS NOT OPTIONAL. `forest` is CC-BY-4.0: commercial use is allowed
 * *provided the author is credited*. The `credit` string below is copied
 * verbatim from the licence file shipped in the download and is rendered on the
 * title screen. Do not remove it, and do not paraphrase it — the licence asks
 * for that specific sentence.
 */
export const MAPS = [
  {
    id: 'suq',
    name: 'SUQ AL-HADID',
    subtitle: 'MARKET COMPOUND · THREE LANES · 06:40 LOCAL',
    kind: 'procedural',
    brief: 'A dense six-by-six market compound. Close alleys west, an open motor '
      + 'yard east, and a raised market hall holding the centre.',
  },
  {
    id: 'forest',
    name: 'BLACKPINE ROAD',
    subtitle: 'FOREST · ONE ROAD · FIRST LIGHT',
    kind: 'gltf',
    path: 'maps/forest/scene.gltf',
    brief: 'A logging road through dense pine at night. Long sightlines down the '
      + 'road, almost none off it.',

    /**
     * SCALE, AND WHY IT IS THIS NUMBER.
     *
     * The source measures 19.2 x 2.9 x 9.8 units once node transforms are
     * applied — the raw accessor bounds read 200 x 200 x 392, which is the
     * untransformed local extent and is what you get if you trust the file's
     * bounding box instead of walking its node hierarchy.
     *
     * Nothing in the file states a unit, so the scale is anchored to the only
     * thing in it with a known real size: the trees, whose primitives stand
     * about 2.9 units. At x6 they are roughly 17 m, which is an ordinary pine,
     * and the terrain becomes about 58 x 57 m — a little tighter than Suq
     * al-Hadid's 80 x 90 m, which is the right direction given how thin
     * contact already is.
     *
     * Override with `?mapscale=N` to re-anchor without editing this file.
     */
    scale: 6.0,

    /** The single-primitive terrain. Everything else is canopy. */
    groundMaterial: 'Material.003',
    /**
     * Trees collide as trunk proxies rather than as their own geometry: the
     * canopy is 139,612 triangles of leaf card, and colliding against it would
     * both cost a fortune in the BVH and let the player bump into leaves. The
     * 1,394 canopy primitives cluster onto 511 distinct positions, which are
     * the trunks.
     */
    trunkRadius: 0.055,
    trunkHeight: 2.6,

    credit: 'This work is based on "a forest (3) with a road at night for game" '
      + '(https://sketchfab.com/3d-models/a-forest-3-with-a-road-at-night-for-game-'
      + '61f8c7817fe6457fb26e4814cfc48a3f) by dasy444 '
      + '(https://sketchfab.com/dasy444) licensed under CC-BY-4.0 '
      + '(http://creativecommons.org/licenses/by/4.0/)',
    creditShort: 'MAP BY DASY444 · CC-BY-4.0',

    /**
     * DAYLIGHT, DESPITE THE SOURCE BEING TITLED "at night".
     *
     * The night preset drops the sun below the horizon, and measured against a
     * captured frame that renders the map as unlit silhouettes: the sky stays
     * bright, the direct light goes to zero, and every surface falls back to
     * ambient. The map's own albedo turns out to be lit for daytime anyway, so
     * daylight is both the better frame and the honest one.
     *
     * `?night=1` still forces the preset for anyone tuning it. Making it
     * shippable needs a moonlight rig — a low cold key, lifted ambient and an
     * exposure change — not a smaller sun elevation, and that is its own task.
     */
    // lighting: { preset: 'night' },
  },
];

const STORE_KEY = 'blackout.map.v1';

export function mapById(id) {
  return MAPS.find((m) => m.id === id) || MAPS[0];
}

/**
 * Which map should boot. `?map=` wins so a capture or a probe can pin one
 * without touching the player's saved choice.
 */
export function selectedMap() {
  let id = null;
  try {
    id = new URLSearchParams(location.search).get('map') || localStorage.getItem(STORE_KEY);
  } catch { /* no storage in a worker/test context */ }
  const m = mapById(id);
  try {
    const s = parseFloat(new URLSearchParams(location.search).get('mapscale') ?? '');
    if (Number.isFinite(s) && s > 0.01 && s < 1000) return { ...m, scale: s };
  } catch { /* ignore */ }
  return m;
}

/** Persist a choice and reload into it. */
export function chooseMap(id) {
  try { localStorage.setItem(STORE_KEY, id); } catch { /* ignore */ }
  const q = new URLSearchParams(location.search);
  q.set('map', id);
  location.search = q.toString();
}
