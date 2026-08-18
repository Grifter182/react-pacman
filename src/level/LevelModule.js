import * as THREE from 'three';
import { makeMaterial } from '../materials/TextureFactory.js';
import { loadTextureSet } from '../materials/AssetLibrary.js';
import { Config, QualityTier } from '../core/Config.js';

import { ProxySet, rng, fbm2, FACE_ALL, FACE_NY } from './kit/Geo.js';
import { Batcher, InstancePool } from './kit/Batcher.js';
import { applyWeathering, disposeWeathering } from './kit/Weathering.js';
import { Foliage } from './kit/Foliage.js';
import {
  SCALE, wall, building, roof, stairs, railing, pillar, column, archway, awning,
  windowFill, wallFrame, facadeFittings,
} from './kit/Arch.js';
import {
  protoCrate, protoBarrel, protoSandbagWall, protoJersey, protoPallet, protoTyre,
  protoAcUnit, protoPipeBundle, protoRubble, protoBollard, protoWaterTank, protoDish,
  placeStall, placeVehicle, placeHangingRug, placeCable, placeSign, placeLamp, placeDebris,
  placeSpan, placeWashLine,
} from './kit/Props.js';
import {
  groundWeather, pave, baseTerrain, tyreTracks, track, blot, cracks, wallSpill,
} from './kit/Ground.js';

/**
 * OWNER: level-art agent.
 *
 * ============================================================================
 *  SUQ AL-HADID  —  a 6v6 three-lane market compound.
 * ============================================================================
 *
 * LAYOUT (world axes: +X east, +Z north; team 0 spawns south, team 1 north)
 *
 *   x -40 ......... -26 ...... -16 .... -5 .. 5 .... 16 ...... 28 ..... 40
 *        [ west row ][ ALLEY ][ V row ][W st][ CENTRE ][E st][ E row ][ YARD ]
 *
 *   LANE 1  The alley (x ≈ -29). Seven metres wide, roofed in places by
 *           awnings and cables, walled to six and nine metres. Pure close
 *           quarters: no sightline in it exceeds 30 m and every doorway off it
 *           is a two-way fight.
 *   LANE 2  The market street and plaza (x ≈ 0). Opens at the centre into a
 *           plaza dominated by a 1.6 m podium carrying a colonnaded market
 *           hall — the raised centre. Holding the hall roof (5.5 m) gives you
 *           both halves of the street; getting there costs you an exposed
 *           stair, and the balcony on the souk house looks straight down onto
 *           it. Power position, contested, not free.
 *   LANE 3  The motor yard (x ≈ 34). Asphalt, long north-south sightline,
 *           deliberately the most open lane — and deliberately interrupted at
 *           z ≈ 0 by the garage, which pushes into it and forces the duel
 *           either through the roller door or around the outside.
 *
 *   FLANKS  One cross-street at z ≈ -26 runs the full width of the map: the
 *           long, dangerous crossing. The northern connectors are staggered
 *           side passages instead, so the two halves of the map do not mirror.
 *           Interiors (souk house, garage) are the third route, and both have
 *           two entrances and a first-floor overlook.
 *
 * ASYMMETRY is intentional. The two spawns are balanced by count of cover and
 * by travel time to the hall, not by reflection.
 *
 * BUDGET. Static geometry is merged by (material, map quadrant) — see
 * Batcher.js — and every repeated prop is instanced. Collision is a separate,
 * far cruder proxy set: boxes and ramps only, about 1% of the rendered
 * triangle count, so the BVH stays cheap for bullets and capsule sweeps.
 */

const SOUTH = 0, NORTH = 1;

/**
 * Collision proxy for each instanced prop kind: [width, height, depth] of a
 * single box, sized to the *cover* the prop provides rather than to its
 * silhouette. A sandbag revetment is a solid slab to the capsule and to
 * bullets even though it renders as ninety separate lumps — cover that shoots
 * through is the worst bug a shooter map can ship.
 *
 * `null` means the prop is scenery and does not collide: roof clutter the
 * player never walks among, and litter thin enough to step over.
 */
/** Walkable rectangles [x0, z0, x1, z1] — the negative space of the layout. */
const OPEN_REGIONS = [
  [-33, -44, -26, 44],      // the alley, end to end
  [-5.2, 14, 5.2, 44],      // market street, north
  [-5.2, -44, 5.2, -15],    // market street, south
  [-16.5, -14.5, 16.5, 14.5], // plaza (the podium sits inside it and is walkable)
  [28.5, -44, 39, 44],      // motor yard
  [-33, -30, 39, -22],      // the long cross-street
  [-16, -44, -9, 13],       // west inner street
  [9, -44, 16, 13],         // east inner street
  [-25, -21, -17, -3],      // souk house interior
  [17, -7, 27, 7],          // garage interior
  [-25, -1.5, -17, 1.5],    // covered passage
  [-38, 38, 38, 44],        // north spawn frontage
  [-38, -44, 38, -38],      // south spawn frontage
];

const PROP_COLLIDERS = {
  crateWood: [0.64, 0.64, 0.64],
  crateWoodBig: [0.88, 0.88, 0.88],
  crateMetal: [0.72, 0.72, 0.72],
  crateRoof: [0.72, 0.72, 0.72],
  barrelRoof: [0.60, 0.90, 0.60],
  barrel: [0.60, 0.90, 0.60],
  barrelBlue: [0.60, 0.90, 0.60],
  sandbagLow: [2.00, 1.03, 0.60],
  sandbagHigh: [2.00, 1.47, 0.62],
  jersey: [2.02, 0.86, 0.60],
  pallet: null,
  tyre: null,
  ac: [0.94, 0.74, 0.76],
  pipes: [1.20, 0.64, 3.20],
  rubble: [2.00, 0.50, 1.80],
  bollard: [0.30, 0.92, 0.30],
  tank: [1.14, 1.48, 1.14],
  dish: [0.30, 0.60, 0.30],
};

export class LevelModule {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'Level';
    this.spawnPoints = [];
    this.navPoints = [];
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-40, -1, -46),
      new THREE.Vector3(40, 14, 46),
    );
    this.materials = {};
    this._lights = [];
    this._fixtures = [];
    this.foliage = null;
    this.stats = null;
  }

  async init(engine) {
    engine.scene.add(this.root);

    const tier = Config.quality;
    this.detail = { [QualityTier.LOW]: 0, [QualityTier.MEDIUM]: 1, [QualityTier.HIGH]: 2, [QualityTier.ULTRA]: 3 }[tier] ?? 1;

    this._buildMaterials();
    await this._applyAuthoredMaterials();

    this.batch = new Batcher(44);
    this.proxy = new ProxySet();
    this.inst = new InstancePool();
    this.kit = { batch: this.batch, proxy: this.proxy, inst: this.inst, detail: this.detail };
    this.rand = rng(0xB1A5E);

    this._defineBuckets();
    this._defineProps();

    // Spawns first: prop placement tests against them so nothing scatters on
    // top of a spawn point.
    this._placeSpawns();
    this._placeNavPoints();

    this._buildBackdrop();
    this._buildPerimeter();
    this._buildWestRow();
    this._buildVRow();
    this._buildSoukHouse();
    this._buildCentreBlocks();
    this._buildMarketHall();
    this._buildEastRow();
    this._buildGarage();
    this._buildYard();
    this._buildSpawnEnds();
    // Ground after architecture: the paving, its weathering and its spill all
    // read off the building footprints the passes above registered.
    this._buildGround();
    this._dressStreets();
    this._dressRoofs();
    this._dressForeground();
    this._buildFoliage();
    this._buildLights(engine);

    this._finalise(engine);
    engine.level = this;
  }

  /* ==================================================================== */
  /*  Surfaces                                                            */
  /* ==================================================================== */

  /**
   * Every surface on the map, requested from the materials catalogue. Tinted
   * variants deliberately reuse the *same* preset+seed so they share one baked
   * texture set and differ only by material colour — that is free variety.
   */
  /**
   * Upgrade selected surfaces from procedural bakes to authored photographic
   * texture sets.
   *
   * REPLACES the material rather than mutating it, and that is load-bearing.
   * The procedural materials carry an onBeforeCompile injection (SF_SURFACE /
   * SF_DETAIL / SF_MACRO / SF_WORLD) that computes the surface response from
   * the recipe's own packed uniforms. Assigning `roughnessMap`/`metalnessMap`
   * onto one of those does nothing — the injected code never reads them —
   * while the `roughness`/`metalness` SCALARS that must be 1.0 for a packed
   * map to survive are taken at face value. The ground became a mirror
   * reflecting the sky probe, which reads as a hole in the world.
   *
   * An authored photographic set does not want that injection anyway: the
   * detail, macro-variation and triplanar passes exist to rescue a small
   * procedural bake from looking repetitive, and a measured 1K set with real
   * grain has none of those problems.
   *
   * Replacing is safe here specifically because this runs before the Batcher
   * is constructed and before any geometry is built, so the catalogue is the
   * only thing holding these references. It would NOT be safe later.
   *
   * Failure is non-fatal: without the files the procedural bake stands, which
   * is a complete implementation in its own right.
   */
  async _applyAuthoredMaterials() {
    if (Config.assets?.useAuthored === false) return;
    if (Config.assets?.levelTextures !== true) return;   // see Config.assets.levelTextures
    const M = this.materials;

    // `sandFar` must be swapped alongside `sand`: they are the inner and outer
    // rings of the same ground, and leaving one procedural puts a visible
    // material seam across the map at 54 m.
    const swaps = [
      { set: 'rock063', targets: ['sand', 'sandFar', 'gravel'], normalScale: 1.0 },
      { set: 'metal053c', targets: ['metal', 'corrugated', 'ironwork'], normalScale: 0.85 },
    ];

    try {
      const aniso = this.engine?.maxAnisotropy ?? 8;
      await Promise.all(swaps.map(async ({ set, targets, normalScale }) => {
        const src = await loadTextureSet(set, { anisotropy: aniso });
        for (const key of targets) {
          const old = M[key];
          if (!old) continue;

          // Inherit the repeat the procedural map was using: those were chosen
          // against each surface's real size in metres, so reusing them keeps
          // texel density as authored rather than re-deriving it.
          const rep = old.map?.repeat?.clone() ?? new THREE.Vector2(1, 1);
          const map = src.map.clone();
          const normalMap = src.normalMap.clone();
          const ormMap = src.ormMap.clone();
          for (const t of [map, normalMap, ormMap]) {
            t.repeat.copy(rep);
            t.needsUpdate = true;
          }

          const next = new THREE.MeshStandardMaterial({
            name: `${key}:${set}`,
            map,
            normalMap,
            aoMap: ormMap,
            roughnessMap: ormMap,
            metalnessMap: ormMap,
            // Scalars multiply the maps, so both must be 1 for the packed
            // channels to reach the shader unmodified.
            roughness: 1.0,
            metalness: 1.0,
            normalScale: new THREE.Vector2(normalScale, normalScale),
            envMapIntensity: old.envMapIntensity ?? 1.0,
            side: old.side,
            dithering: true,
          });
          // Keep whatever tint the recipe chose; it is what separates the
          // variants of one surface from each other.
          if (old.color) next.color.copy(old.color);
          next.userData.authored = set;

          // The outgoing textures are NOT disposed: the catalogue shares one
          // baked set between tinted variants, so freeing them here pulls the
          // texture out from under variants that were not swapped.
          M[key] = next;
        }
      }));
    } catch (err) {
      console.warn('[level] authored textures unavailable, keeping procedural', err?.message || err);
    }
  }

  _buildMaterials() {
    const M = this.materials;
    const S = 512;

    // GROUND TILE SCALE. These used to be requested 1.6x to 2.6x coarser than
    // the recipe was authored for (sand 3.2 m against a native 2.0, gravel 2.6
    // against 1.0, asphalt 3.0 against 1.2), which stretched every feature the
    // recipe builds — the 90 mm ripple train, the 45 mm gravel grade, the 10 mm
    // asphalt aggregate — past the point where it survives the bake. The ground
    // is a third of most frames and it was reading as flat grey for exactly
    // that reason. They now run at, or just above, the recipe's own scale, and
    // the detail normal is held to a longer fade so it is still there at the
    // 1–3 m the player's own feet occupy.
    M.sand = makeMaterial('sand', {
      seed: 11, size: S, worldScale: 2.0, macro: 0.62,
      detailFade: [14, 46], detailStrength: 0.72,
    });
    // The far ring only ever appears past 60 m, where a 2 m tile would be a
    // visible repeating weave. Big tile, no detail layer, no weathering.
    M.sandFar = makeMaterial('sand', {
      seed: 11, size: S, worldScale: 8.0, macro: 0.7, detail: false,
    });
    M.gravel = makeMaterial('gravel', {
      seed: 29, size: S, worldScale: 1.3, macro: 0.34, detailFade: [12, 40], detailStrength: 0.7,
    });
    M.asphalt = makeMaterial('asphalt', {
      seed: 47, size: S, worldScale: 1.5, macro: 0.3, detailFade: [12, 40], detailStrength: 0.68,
    });
    M.tile = makeMaterial('tile', { seed: 53, size: S, worldScale: 0.9, detailFade: [7, 24] });

    // Ground decals. Plain geometry a few centimetres proud of the paving, with
    // a polygon offset so the lift can stay small enough never to read as a
    // floating sheet at a grazing angle.
    const decal = (preset, color, extra = {}) => makeMaterial(preset, {
      seed: 47, size: 256, worldScale: 1.5,
      detailFade: [10, 30],
      material: Object.assign({
        color: new THREE.Color(color),
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
      }, extra),
    });
    // The tint MULTIPLIES the recipe's albedo, and asphalt is already a 0.07
    // linear surface, so anything below about 0.4 linear here paints a black
    // river down the middle of the street rather than a worn line. These are
    // deliberately shallow: a decal that announces itself is worse than none.
    M.decalDark = decal('asphalt', 0xa9a396);                     // tyre ruts
    M.decalWear = decal('gravel', 0xcbc4b8);                      // foot polish
    M.decalOil = decal('asphalt', 0x6b6357, { roughness: 0.28 });
    M.decalPale = decal('sand', 0xd8cdb4);

    // Two plasters and a bare concrete. Buildings are assigned between them so
    // that no two adjacent facades share a tone — the single cheapest way to
    // stop a modular kit reading as a modular kit.
    M.plaster = makeMaterial('plaster', { seed: 23, size: S, worldScale: 2.0 });
    M.plasterWarm = makeMaterial('plaster', {
      seed: 23, size: S, worldScale: 2.0,
      material: { color: new THREE.Color(0xc9a878) },
    });
    M.plasterPale = makeMaterial('plaster', {
      seed: 23, size: S, worldScale: 2.0,
      material: { color: new THREE.Color(0xd8d2c2) },
    });
    M.concrete = makeMaterial('concrete', { seed: 71, size: S, worldScale: 2.4 });
    // Same bake, separate material: instanced props carry no aWeather attribute
    // and must not be drawn with the weathered variant of the program.
    M.concreteProp = makeMaterial('concrete', {
      seed: 71, size: S, worldScale: 2.4, detailFade: [7, 24],
    });
    M.brick = makeMaterial('brick', { seed: 83, size: S, worldScale: 2.0 });

    M.timber = makeMaterial('wood', { seed: 97, size: S, worldScale: 2.2 });
    M.shutter = makeMaterial('wood', {
      seed: 97, size: S, worldScale: 2.2,
      material: { color: new THREE.Color(0x4d6f74) },     // faded teal joinery
    });
    M.metal = makeMaterial('metal', { seed: 59, size: S, worldScale: 1.4 });
    M.ironwork = makeMaterial('metal', {
      seed: 59, size: S, worldScale: 1.4,
      material: { color: new THREE.Color(0x5a5550) },
    });
    M.corrugated = makeMaterial('corrugated', { seed: 31, size: S, worldScale: 1.8 });
    M.sandbag = makeMaterial('sandbag', { seed: 37, size: S, worldScale: 1.2 });
    M.glass = makeMaterial('glass', { seed: 13, size: 256, worldScale: 1.5 });
    M.rubber = makeMaterial('rubber', { seed: 17, size: 256, worldScale: 0.5 });
    M.polymer = makeMaterial('polymer', { seed: 19, size: 256, worldScale: 0.35 });
    M.chrome = makeMaterial('gunmetal', { seed: 41, size: S, worldScale: 0.35 });

    // Cloth. Double sided because every awning and rug is seen from below.
    const cloth = (color, seed) => makeMaterial('canvas', {
      seed, size: S, worldScale: 0.6,
      material: { side: THREE.DoubleSide, color: new THREE.Color(color) },
    });
    M.awning = cloth(0xd9c9a6, 61);
    M.awningRed = cloth(0xa8523c, 61);
    M.rug = cloth(0x8e3b34, 61);
    M.sack = makeMaterial('canvas', {
      seed: 61, size: S, worldScale: 0.6,
      material: { color: new THREE.Color(0xb8a37e) },
    });

    // TODO(materials): a `car_paint` preset (clearcoat over a flake base) and a
    // `sign_enamel` preset would both land better than these tinted steels.
    M.carPaintA = makeMaterial('metal', {
      seed: 59, size: S, worldScale: 1.4,
      material: { color: new THREE.Color(0x6f7d74), roughness: 0.85 },
    });
    M.carPaintB = makeMaterial('metal', {
      seed: 59, size: S, worldScale: 1.4,
      material: { color: new THREE.Color(0x9a8f7c), roughness: 0.9 },
    });
    M.signage = makeMaterial('metal', {
      seed: 59, size: S, worldScale: 1.4,
      material: { color: new THREE.Color(0x2f6f86) },
    });

    // Fixture emitters. Warm sodium, bright enough for the bloom mips to find.
    M.emissive = makeMaterial('metal', {
      seed: 59, size: 256, worldScale: 1.4,
      material: {
        color: new THREE.Color(0x151515),
        emissive: new THREE.Color(0xffb469),
        emissiveIntensity: 5.5,
      },
    });

    // Weathering rides on every architectural surface; props are small enough
    // that the baked wear in the recipe already carries them.
    applyWeathering(M.plaster, { grime: 1.0, stain: 1.0 });
    applyWeathering(M.plasterWarm, { grime: 1.05, stain: 0.9 });
    applyWeathering(M.plasterPale, { grime: 1.15, stain: 1.1 });
    applyWeathering(M.concrete, { grime: 0.9, stain: 0.85, dust: [0.13, 0.115, 0.09] });
    applyWeathering(M.brick, { grime: 0.85, stain: 0.8 });

    // The ground carries the same per-vertex field, driven by `groundWeather`.
    // Its dust colour is a *pale* film, so the drifts lighten the surface and
    // the worn tracks — which come through the stain channel — darken and
    // smooth it. That opposition is the whole reason 8,000 m² of pavement can
    // stop reading as one value without a single extra texture.
    applyWeathering(M.sand, { grime: 1.0, stain: 0.9, dust: [0.315, 0.278, 0.208] });
    applyWeathering(M.gravel, { grime: 0.95, stain: 1.0, dust: [0.196, 0.180, 0.145] });
    applyWeathering(M.asphalt, { grime: 0.9, stain: 1.15, dust: [0.212, 0.196, 0.158] });
    applyWeathering(M.tile, { grime: 1.0, stain: 1.0, dust: [0.228, 0.206, 0.162] });
  }

  /**
   * ==========================================================================
   *  THE SHADOW BUDGET  —  read this before adding a bucket.
   * ==========================================================================
   *
   * `renderer.info` accumulates over every pass in a frame, and at the HIGH
   * tier the sun is split into four shadow cascades whose combined range
   * (140 m) is larger than this map's longest diagonal (124 m). Nothing is
   * outside them, so a mesh that casts is submitted FIVE times a frame: once
   * for the camera and once per cascade. That is the whole story of the round-2
   * regression. Measured on the round-2 build:
   *
   *     scene geometry            607k triangles across 116 meshes
   *     of which shadow-casting   566k triangles across  73 meshes
   *     reported by the harness   2.94M triangles, 547 draw calls
   *     (607k + 566k x 4)         2.87M                408   <- the level's share
   *
   * The arithmetic is exact to 2%: culling rejects essentially nothing, because
   * the compound fits inside every cascade.
   *
   * ROUND 3 CORRECTION, AND IT IS THE WHOLE ROUND. The clause above — "a mesh
   * that casts is submitted five times" — is not the rule the renderer runs.
   * `RenderModule` selects `THREE.VSMShadowMap`, and three's shadow pass admits
   * an object when
   *
   *     object.castShadow || ( object.receiveShadow && type === VSMShadowMap )
   *
   * `receiveShadow` is true on every bucket here, because a surface that does
   * not receive cannot be shadowed by anything. So EVERY bucket was already
   * paying the 5x, and round 2's careful sorting of buckets into casters and
   * non-casters — shutters, glazing bars, cables, chrome — saved nothing at
   * all. It is the reason the budget moved the wrong way while the ledger said
   * it should not have.
   *
   * Three rules follow, and all three are applied below:
   *
   *  1. SPATIAL CELLS STAY OFF, and now for a reason with numbers behind it.
   *     They exist so a near cascade can reject a chunk of the map. Running
   *     `CascadedShadows`' own split scheme (near 0.6, max 140, lambda 0.65) at
   *     this camera's 80 degree FOV gives ortho half-sizes of 19, 42, 83 and
   *     193 m. Only cascade 0's 38 m box is smaller than the 80 x 92 m
   *     compound; cascades 1-3 contain all of it. So splitting a bucket into
   *     cells can reject at most three quarters of one pass out of five — call
   *     it 15% of the shadow cost — and it costs a draw call per cell per
   *     cascade to try. One mesh per material. (The mechanism stays in
   *     Batcher.js: it is the right answer for a larger map or a shorter
   *     shadow range, and this one may yet grow.)
   *
   *  2. THE ONLY WAY OUT OF THE SHADOW PASS IS `shadow: false` — cast AND
   *     receive both off. That is a real decision with a real cost: such a
   *     surface is lit by the sun even when it stands in shade, so it can only
   *     be used where nothing is ever between it and the sun. Which is exactly
   *     what the skyline is. Rooftop plant, aerials, dishes, cables, parapet
   *     ironwork, roof railings and the backdrop all sit above every occluder
   *     on the map, and their own shadows fall on roofs nobody stands on.
   *
   *  3. SO SILHOUETTE DETAIL IS 5x CHEAPER THAN SURFACE DETAIL. A triangle in a
   *     `SKY` bucket costs one submission; the same triangle on a wall costs
   *     five. That inverts the round-2 instinct to spend on facades: the budget
   *     freed below is spent almost entirely on the roofline, where it both
   *     costs a fifth and changes the outline — which is the only kind of
   *     detail that survives being 40 m away and 30 px tall.
   */
  _defineBuckets() {
    const M = this.materials;
    const b = this.batch;
    // uvScale must match the preset's worldScale, or the LOW tier — which
    // drops the triplanar path and falls back to these UVs — rescales.
    //
    // Three shadow classes, and only three:
    //   LIT   casts and receives.  5x.  Anything whose shadow is a shape.
    //   RECV  receives only.       5x.  Coplanar decals and ground, where
    //                                   casting is self-shadow acne, but which
    //                                   must take the shadow of everything else.
    //   SKY   neither.             1x.  Only for geometry that nothing on this
    //                                   map can stand between and the sun, and
    //                                   whose own shadow lands where no player
    //                                   is: the roofline, and the backdrop.
    const LIT = { cells: false };
    const RECV = { cells: false, castShadow: false };
    const SKY = { cells: false, castShadow: false, receiveShadow: false };

    b.define('sand', M.sand, { uvScale: 2.0, ...RECV });
    b.define('sandFar', M.sandFar, { uvScale: 8.0, ...SKY, weather: false });
    b.define('gravel', M.gravel, { uvScale: 1.3, ...RECV });
    b.define('asphalt', M.asphalt, { uvScale: 1.5, ...RECV });
    b.define('tile', M.tile, { uvScale: 0.9, ...RECV });
    // Decals are coplanar with the ground they sit on; casting from them is not
    // just wasted, it is the classic source of self-shadow acne on a road.
    const dc = { ...RECV, weather: false };
    b.define('decalDark', M.decalDark, { uvScale: 1.5, ...dc });
    b.define('decalWear', M.decalWear, { uvScale: 1.3, ...dc });
    b.define('decalOil', M.decalOil, { uvScale: 1.5, ...dc });
    b.define('decalPale', M.decalPale, { uvScale: 1.5, ...dc });

    // --- the massing. This is what the sun is actually drawing with. --------
    // Everything here is LIT: it is at or below eye level, it stands in other
    // things' shadows, and its own shadow is the map's lighting.
    b.define('plaster', M.plaster, { uvScale: 2.0, ...LIT });
    b.define('plasterWarm', M.plasterWarm, { uvScale: 2.0, ...LIT });
    b.define('plasterPale', M.plasterPale, { uvScale: 2.0, ...LIT });
    b.define('concrete', M.concrete, { uvScale: 2.4, ...LIT });
    b.define('brick', M.brick, { uvScale: 2.0, ...LIT });
    b.define('rubblebits', M.concrete, { uvScale: 2.4, ...LIT });
    b.define('concreteProp', M.concreteProp, { uvScale: 1.2, ...LIT, weather: false });

    b.define('timber', M.timber, { uvScale: 2.2, ...LIT, weather: false });
    b.define('metal', M.metal, { uvScale: 1.4, ...LIT, weather: false });
    b.define('polymer', M.polymer, { uvScale: 1.0, ...LIT, weather: false });
    b.define('corrugated', M.corrugated, { uvScale: 1.8, ...LIT, weather: false });
    b.define('sandbagM', M.sandbag, { uvScale: 1.2, ...LIT, weather: false });
    b.define('awning', M.awning, { uvScale: 0.6, ...LIT, weather: false });
    b.define('awningRed', M.awningRed, { uvScale: 0.6, ...LIT, weather: false });
    b.define('carpaint', M.carPaintA, { uvScale: 1.4, ...LIT, weather: false });
    b.define('carpaintB', M.carPaintB, { uvScale: 1.4, ...LIT, weather: false });
    b.define('rug', M.rug, { uvScale: 0.6, ...LIT, weather: false });

    // --- detail that lives inside somebody else's shadow -------------------
    // Receives, does not cast. A shutter sits 100 mm back inside a reveal whose
    // jamb, hood and sill are already casting over it; a glazing bar is 35 mm
    // across, a third of a shadow-map texel, so all it can produce is a
    // crawling dotted line. But they are all in shade half the day, so they
    // stay in the pass as receivers.
    // Ironwork below the parapet line: downpipes, hoppers, gates, condenser
    // brackets, the stair stringers in the yard. It stands on walls that shade
    // it, so it receives; it is 35-110 mm in section, so it never casts.
    b.define('ironwork', M.ironwork, { uvScale: 1.4, ...RECV, weather: false });
    b.define('shutter', M.shutter, { uvScale: 2.2, ...RECV, weather: false });
    b.define('glass', M.glass, { uvScale: 1.5, ...RECV, weather: false });
    b.define('tyre', M.rubber, { uvScale: 0.5, ...RECV, weather: false });
    b.define('sack', M.sack, { uvScale: 0.6, ...RECV, weather: false });
    b.define('chrome', M.chrome, { uvScale: 0.35, ...RECV, weather: false });
    b.define('signage', M.signage, { uvScale: 1.4, ...RECV, weather: false });
    b.define('emissive', M.emissive, { uvScale: 1.4, ...RECV, weather: false });

    // --- SKY: the roofline. Costs 1x. Spend here. --------------------------
    // The test for admission is physical, not aesthetic: is there anything on
    // this map that can come between this surface and the sun, and does its own
    // shadow land anywhere a player stands? Above the parapet line the answer
    // to both is no — the compound is uniformly 4-9 m and the sun is at
    // campaign elevation — so these surfaces are in full sun in every frame
    // they appear in, and a shadow term they can never use costs 4 extra
    // submissions of every triangle.
    //
    // This is the budget the round spends. `roofline` is the parapet-top kit
    // (vent stacks, chimney pots, aerials, water-tank stands, weather heads);
    // `ironThin` carries every cable, aerial guy and roof railing on the map.
    b.define('ironThin', M.ironwork, { uvScale: 1.4, ...SKY, weather: false });
    b.define('roofline', M.concrete, { uvScale: 2.4, ...SKY });
    b.define('rooflinePale', M.plasterPale, { uvScale: 2.0, ...SKY });
    b.define('rooflineTin', M.corrugated, { uvScale: 1.8, ...SKY, weather: false });

    // Backdrop masses: silhouette only, and outside every cascade anyway. They
    // keep the weather attribute purely so they share the exact same shader
    // program as the compound rather than compiling three more.
    b.define('bgPale', M.plasterPale, { uvScale: 2.0, ...SKY });
    b.define('bgWarm', M.plasterWarm, { uvScale: 2.0, ...SKY });
    b.define('bgGrey', M.concrete, { uvScale: 2.4, ...SKY });
  }

  /**
   * INSTANCED OR MERGED? The break-even is not "does it repeat" — everything
   * here repeats. An InstancedMesh costs one draw call in the camera pass and
   * one in every shadow cascade it lands in, which on this map is five; a
   * merged kind costs zero, because the bucket it welds into was already being
   * drawn. So instancing only pays when the duplicated vertex data it saves is
   * worth five draw calls, and at ~150 triangles a prototype that means it has
   * to appear tens of times, not five.
   *
   * `mergeTo` names an existing bucket with the same material. Everything
   * merged below is under 30 placements; everything instanced is over 40.
   */
  _defineProps() {
    const M = this.materials;
    const i = this.inst;
    // Instanced: 44–105 placements each, 10k–26k triangles of duplicate data
    // avoided per kind.
    i.define('crateWood', protoCrate(0.62), M.timber);
    i.define('crateMetal', protoCrate(0.70), M.metal);
    i.define('barrelBlue', protoBarrel(), M.polymer);

    // ROOF-ONLY KINDS, AND THEY ARE `SKY`. 105 tanks, 83 condensers and 97
    // dishes is 42k triangles that sit above every parapet on the map: nothing
    // can shade them and their own shadows fall on decks no player stands on.
    // Out of the shadow pass entirely, they cost 42k instead of 212k and 3
    // draw calls instead of 15. This is the single largest line in the round.
    // (Grep first if you ever place one of these at ground level — the flag is
    // per kind, not per placement.)
    const SKY_PROP = { castShadow: false, receiveShadow: false };
    i.define('ac', protoAcUnit(), M.metal, SKY_PROP);
    i.define('tank', protoWaterTank(), M.polymer, SKY_PROP);
    i.define('dish', protoDish(), M.metal, SKY_PROP);
    // Roof-deck crates and drums. Identical prototypes to the street kinds —
    // same asset, same material — but a separate pool, because the flag that
    // matters is per kind and these ones are on roofs. Two extra draw calls
    // buys ~80 placements out of the shadow passes.
    i.define('crateRoof', protoCrate(0.70), M.metal, SKY_PROP);
    i.define('barrelRoof', protoBarrel(), M.polymer, SKY_PROP);

    // Merged: five to thirty placements apiece, so an InstancedMesh for each
    // was 40 draw calls' worth of shadow passes to save 54k triangles of
    // vertex data across the whole map.
    i.define('crateWoodBig', protoCrate(0.86), M.timber, { mergeTo: 'timber' });
    i.define('barrel', protoBarrel(), M.metal, { mergeTo: 'metal' });
    // 7 courses ≈ 1.03 m (crouch cover), 10 ≈ 1.47 m (standing cover).
    i.define('sandbagLow', protoSandbagWall(7, 2.0, 3), M.sandbag, { mergeTo: 'sandbagM' });
    i.define('sandbagHigh', protoSandbagWall(10, 2.0, 8), M.sandbag, { mergeTo: 'sandbagM' });
    i.define('jersey', protoJersey(), M.concreteProp, { mergeTo: 'concreteProp' });
    i.define('rubble', protoRubble(11), M.concreteProp, { mergeTo: 'concreteProp' });
    i.define('bollard', protoBollard(), M.concreteProp, { mergeTo: 'concreteProp' });
    i.define('pallet', protoPallet(), M.timber, { mergeTo: 'timber' });
    i.define('pipes', protoPipeBundle(), M.metal, { mergeTo: 'metal' });
    i.define('tyre', protoTyre(), M.rubber, { mergeTo: 'tyre' });
  }

  /* ==================================================================== */
  /*  Ground                                                              */
  /* ==================================================================== */

  /**
   * Place an instanced prop *and* its collision proxy. Every prop placement on
   * the map goes through here; `inst.add` on its own would produce cover you
   * can walk and shoot straight through.
   */
  _prop(kind, x, y, z, ry = 0, scale = 1) {
    const c = PROP_COLLIDERS[kind];
    // A scattered barrel that lands on a spawn point traps whoever spawns
    // there. Cheaper to drop the barrel than to nudge the spawn.
    if (c && this._blocksSpawn(x, y, z, ry, c, scale)) return this;
    this.inst.add(kind, x, y, z, ry, scale);
    if (c) this.proxy.box(x, y + (c[1] * scale) / 2, z, c[0] * scale, c[1] * scale, c[2] * scale, ry);
    return this;
  }

  _blocksSpawn(x, y, z, ry, c, scale) {
    if (y > 1.7) return false;
    const cs = Math.cos(-ry), sn = Math.sin(-ry);
    const hx = (c[0] * scale) / 2 + 0.45, hz = (c[2] * scale) / 2 + 0.45;
    for (const s of this.spawnPoints) {
      const dx = s.position.x - x, dz = s.position.z - z;
      // Rotate into the prop's frame: local +X maps to world (cos ry, -sin ry).
      const lx = dx * cs + dz * sn, lz = -dx * sn + dz * cs;
      if (Math.abs(lx) < hx && Math.abs(lz) < hz) return true;
    }
    return false;
  }

  /**
   * The desire lines: where feet and wheels actually go. These drive the worn,
   * dark, smooth channels in the ground weathering field and the tyre decals,
   * and they are the reason the ground now has a *direction* rather than just a
   * texture. [x0, z0, x1, z1, halfWidth]
   */
  static get TRACKS() {
    return [
      [34, -45, 34, 45, 3.0],          // the motor yard, end to end
      [30.5, -45, 31.5, 45, 2.0],
      [-33, -26, 39, -26, 2.8],        // the long cross-street
      [0, -42, 0, -16, 2.2],           // market street, south half
      [0, 14, 0, 42, 2.2],             // market street, north half
      [-29.5, -44, -29.5, 44, 1.8],    // the alley
      [-16, 0, 16, 0, 2.6],            // across the plaza
      [-12.5, -42, -12.5, 12, 1.7],    // west inner street
      [12.5, -42, 12.5, 12, 1.7],      // east inner street
      [30, -2, 17, -2, 2.2],           // into the garage
      [21, -20, 34, -30, 2.4],         // the shortcut everyone takes
    ];
  }

  /**
   * Footprints the ground reacts to: splash-back, shed render and shadow dirt
   * all collect within about a metre of a wall base. Filled in by `_block()`
   * and by the hand-built interiors, which is why the ground is now built
   * *after* the architecture rather than before it.
   */
  _footprint(x0, z0, x1, z1) {
    (this._foot = this._foot || []).push([
      Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1),
    ]);
  }

  _buildGround() {
    const walls = this._foot || [];
    const tracks = LevelModule.TRACKS;
    const gw = groundWeather({ seed: 4111, dust: 1.05, tracks, walls });
    // Paving is compacted and swept, so it collects less loose dust than the
    // open sand does but takes a much harder polish where it is walked.
    const pw = groundWeather({ seed: 4111, dust: 0.72, trackGain: 1.25, tracks, walls });

    // Inner field at the sand recipe's own scale, coarse ring out to the fog.
    baseTerrain(this.kit, {
      bucket: 'sand', farBucket: 'sandFar', inner: 54, outer: 150, step: 3.0, weather: gw,
    });

    // Surface zoning. This is navigation feedback as much as art: the player
    // learns "asphalt = the open lane, tile = the plaza, gravel = the alley".
    //
    // Every region is emitted through `pave()`, which dissolves its own border
    // against a noise field. The old `_pad()` drew a rectangle, and a ruled
    // 74 m line where asphalt meets sand is the most obviously authored thing
    // that can happen to a ground plane.
    // Cell size is the ground's only real cost knob: the mask and the
    // weathering field are both continuous, so a coarser grid loses resolution
    // in the boundary and nothing else.
    const cell = { 0: 1.7, 1: 1.15, 2: 1.0, 3: 0.85 }[this.detail] ?? 1.0;
    const P = (bucket, x0, z0, x1, z1, o = {}) => pave(this.kit, Object.assign({
      bucket, x0, z0, x1, z1, y: 0.02, feather: 1.9, weather: pw,
      seed: (Math.abs(x0 * 7 + z1 * 13) | 0) + 3,
    }, o, { step: (o.step ?? 2.1) * cell }));

    P('gravel', -34, -45, -25, 45, { step: 2.0, feather: 1.5 });      // alley
    P('asphalt', 26.5, -45, 40, 45, { step: 2.4, feather: 2.4 });     // motor yard
    P('asphalt', -34, -30.5, 40, -21.5, { step: 2.2, feather: 2.0 }); // cross-street
    // The plaza is kerbed, so its edge is genuinely built and stays crisp.
    P('tile', -17, -15, 17, 15, { step: 1.8, feather: 0.7, jitter: 0.07 });
    P('gravel', -5.6, 14, 5.6, 45, { step: 2.0, feather: 1.5 });      // market street
    P('gravel', -5.6, -45, 5.6, -15, { step: 2.0, feather: 1.5 });    // south street
    P('asphalt', 16.2, -8.2, 28.2, 8.2, { y: 0.03, step: 2.0, feather: 0.9 });

    // Sand blows back over the edges of every paved area. A *second* pass of
    // the base material laid on top of the paving, masked by a heavily eroded
    // version of the same field, is what turns a boundary into a transition.
    for (const [x0, z0, x1, z1] of [
      [-34, -45, -25, 45], [26.5, -45, 40, 45], [-34, -30.5, 40, -21.5],
      [-5.6, 14, 5.6, 45], [-5.6, -45, 5.6, -15],
    ]) {
      pave(this.kit, {
        bucket: 'sand', x0, z0, x1, z1, y: 0.035, step: 2.4, feather: 3.4,
        coverage: -0.44, jitter: 0.24, weather: gw, seed: 611 + (x0 | 0),
        noiseScale: 0.16,
      });
    }

    // Kerbs around the plaza give the pad a real edge and a 0.14 m step.
    const kerb = this.batch.at('concrete', 0, 0);
    kerb.identity();
    for (const [x0, z0, x1, z1] of [
      [-17.2, -15.2, 17.2, -14.85], [-17.2, 14.85, 17.2, 15.2],
      [-17.2, -15.2, -16.85, 15.2], [16.85, -15.2, 17.2, 15.2],
    ]) {
      kerb.at((x0 + x1) / 2, 0.07, (z0 + z1) / 2).box(Math.abs(x1 - x0), 0.16, Math.abs(z1 - z0), 0.03, 2.5);
    }

    this._groundDecals(walls);

    // One box under everything: the floor the capsule stands on.
    this.proxy.extent(-140, -1.0, -140, 140, 0, 140);
  }

  /**
   * Tyre ruts, oil, cracking and spill. All of it is geometry lifted 45-60 mm
   * and polygon offset; a real deferred decal system buys nothing on a map
   * whose ground never changes, and this way the marks merge into the same
   * handful of draw calls as everything else.
   */
  _groundDecals(walls) {
    const r = this.rand;

    // Vehicle ruts down the two lanes that carry vehicles.
    tyreTracks(this.kit, {
      bucket: 'decalDark', points: [[33.2, -44], [33.8, -12], [33.0, 6], [33.6, 44]],
      width: 0.34, gauge: 1.8, y: 0.062, seed: 5, segments: 40,
    });
    tyreTracks(this.kit, {
      bucket: 'decalDark', points: [[-32, -26.4], [-4, -25.6], [18, -26.6], [38, -25.8]],
      width: 0.30, gauge: 1.7, y: 0.062, seed: 9, segments: 40,
    });
    tyreTracks(this.kit, {
      bucket: 'decalDark', points: [[30.5, -2.2], [24, -2.6], [17.5, -2.2]],
      width: 0.32, gauge: 1.75, y: 0.07, seed: 12, segments: 20,
    });
    // A vehicle turned around here once and never came back.
    tyreTracks(this.kit, {
      bucket: 'decalDark', points: [[36.5, 18], [33.5, 22], [31.5, 27.5], [33, 31]],
      width: 0.28, gauge: 1.7, y: 0.062, seed: 21, segments: 24,
    });

    // Foot polish down the market street and across the plaza: one broad, soft,
    // dark centre line, which is what a walked surface actually looks like.
    for (const [pts, w, sd] of [
      [[[0, 14], [0.6, 26], [-0.4, 38], [0, 44]], 0.85, 31],
      [[[0, -16], [-0.5, -26], [0.4, -36], [0, -43]], 0.85, 33],
      [[[-16, 0.5], [-4, -0.4], [6, 0.6], [16, -0.3]], 1.05, 35],
      [[[-29.6, -42], [-29.2, -10], [-29.8, 14], [-29.4, 42]], 0.75, 37],
    ]) {
      track(this.kit, {
        bucket: 'decalWear', points: pts, width: w, y: 0.058, wander: 0.75,
        seed: sd, segments: 34,
      });
    }

    // Oil under every parked vehicle, plus the garage floor.
    for (const [x, z, rad] of [
      [20.0, -3.4, 1.0], [33.5, -14.0, 0.9], [36.2, 20.5, 0.8], [30.6, 30.0, 0.75],
      [31.2, -30.0, 0.9], [-22.0, -44.2, 0.7], [21.0, 44.0, 0.7],
      [21.5, -1.0, 1.4], [23.0, 3.5, 0.9],
    ]) {
      blot(this.kit, { bucket: 'decalOil', x, z, radius: rad, y: 0.056, seed: (x * 13 + z * 7) | 0 });
    }
    // Damp patches and spilled fines where water is drawn or thrown out.
    for (let i = 0; i < 10; i++) {
      const p = this.randomOpenPoint(r);
      blot(this.kit, {
        bucket: 'decalPale', x: p.x, z: p.z, radius: 0.7 + r() * 1.5,
        y: 0.05, seed: 700 + i * 17,
      });
    }

    // Cracking. Pavement fails from a point outward; a straight painted line
    // never convinces, and a rectangle of "cracked" texture convinces less.
    for (const [x, z, arms, reach] of [
      [-9.5, 6.0, 5, 3.4], [11.0, -7.5, 4, 2.8], [0.5, -20.5, 4, 3.0],
      [31.0, 9.0, 5, 3.8], [-30.0, -8.0, 3, 2.4], [24.0, -27.0, 4, 3.2],
      [-2.0, 27.0, 3, 2.6], [35.5, -34.0, 4, 3.0],
    ]) {
      cracks(this.kit, {
        bucket: 'decalDark', x, z, arms, reach, y: 0.05,
        seed: (x * 31 + z) | 0, width: 0.07,
      });
    }

    // Spill at the foot of the walls. This is the join the eye spends the most
    // time on, and a clean 90-degree corner is what makes a street read as a
    // box with texture on it.
    for (const f of walls) {
      const [x0, z0, x1, z1] = f;
      const edges = [
        [x0, z0, x1, z0], [x1, z1, x0, z1], [x1, z0, x1, z1], [x0, z1, x0, z0],
      ];
      for (let e = 0; e < edges.length; e++) {
        // Only some runs get spill; an unbroken skirt around every building is
        // as uniform as no skirt at all.
        if (fbm2(edges[e][0] * 0.05, edges[e][1] * 0.05, 2, 77) < 0.36) continue;
        wallSpill(this.kit, {
          x0: edges[e][0], z0: edges[e][1], x1: edges[e][2], z1: edges[e][3],
          bucket: 'rubblebits', density: 0.7, reach: 0.85, seed: 41 + e * 13 + (x0 | 0),
        });
      }
    }
  }

  /* ==================================================================== */
  /*  Perimeter                                                           */
  /* ==================================================================== */

  _buildPerimeter() {
    const H = 5.6, T = 0.7;
    const runs = [
      [-40, -46, 40, -46], [40, 46, -40, 46],
      [-40, 46, -40, -46], [40, -46, 40, 46],
    ];
    for (const [x0, z0, x1, z1] of runs) {
      wall(this.kit, {
        x0, z0, x1, z1, height: H, thickness: T,
        bucket: 'concrete', trim: 'plasterPale',
        plinth: 0.42, cornice: 0.30, grid: 1.6,
      });
    }
    // Pilasters every 8 m, which is what stops 80 m of wall reading as a slab.
    // Only on the runs that are actually seen: the west perimeter is hidden
    // behind the west building row for its whole length.
    for (let x = -36; x <= 36; x += 8) {
      for (const z of [-46, 46]) {
        pillar(this.kit, { x, z: z + (z < 0 ? 0.55 : -0.55), height: H + 0.5, size: 0.75, bucket: 'plasterPale' });
      }
    }
    for (let z = -40; z <= 40; z += 8) {
      pillar(this.kit, { x: 39.45, z, height: H + 0.5, size: 0.75, bucket: 'plasterPale' });
    }
  }

  /**
   * The town beyond the compound.
   *
   * Every outward sightline on this map used to terminate on a 5.6 m perimeter
   * wall with sky above it, which is what makes an arena read as an arena: the
   * skyline steps twice — wall, sky — and stops. A ring of simple parapeted
   * masses from 55 m to 130 m out, at heights the compound never reaches, gives
   * the horizon four or five value steps instead and lets the fog do the work
   * it exists to do. They are pure silhouette: no collision, no shadow casting,
   * no openings, ~7k triangles for the whole ring.
   */
  _buildBackdrop() {
    const r = rng(0xBACD70);
    const buckets = ['bgPale', 'bgWarm', 'bgGrey'];
    let placed = 0;
    // The outermost ring is 120 m out and behind most of the fog; it is the
    // first thing to go when the budget is tight.
    const rings = this.detail >= 2 ? 3 : 2;
    for (let ring = 0; ring < rings; ring++) {
      // Rectangular rings, not circular: the compound is a rectangle and a
      // circle of masses around it crowds the short axis and abandons the long
      // one. Half-extents clear the 40 x 46 perimeter with room to spare.
      const hx = 52 + ring * 30, hz = 58 + ring * 30;
      const n = 24 + ring * 10;
      for (let i = 0; i < n; i++) {
        if (r() < 0.22) continue;
        const a = (i / n) * Math.PI * 2 + (r() - 0.5) * 0.14;
        const ca = Math.cos(a), sa = Math.sin(a);
        // Project the direction onto the rectangle, then push out at random.
        const k = 1 / Math.max(Math.abs(ca) / hx, Math.abs(sa) / hz);
        const push = 1 + r() * 0.26;
        const x = ca * k * push, z = sa * k * push;
        // The compound's own perimeter is 5.6 m and the eye is at 1.6 m, so a
        // mass at 55 m has to reach about 11 m before any of it clears the wall
        // at all. Anything shorter is invisible from inside and is pure cost.
        const H = 11 + ring * 3.5 + r() * (8 + ring * 5);
        const w = 9 + r() * 16, dp = 9 + r() * 16;
        const bk = buckets[(r() * 3) | 0];
        const b = this.batch.at(bk, x, z);
        // BUDGET. These masses stand 55–150 m out, behind most of the fog, and
        // they neither cast nor receive. Everything that used to be spent on
        // their *surface* was wasted: an 80 mm chamfer is a tenth of a pixel at
        // that range, and the [6, 3] weathering grid put 40 quads on each of
        // six faces — four of which face away — for a gradient no one can
        // resolve. That was 253 triangles a mass, 17.5k across the ring. They
        // are silhouette and nothing else, so they are built as silhouette:
        // 12 triangles for the mass, and the whole saving goes back into the
        // parapet, penthouse and tank stack that gives the skyline its steps.
        b.at(x, H / 2, z, a).box(w, H, dp, 0, 0);
        // Parapet band and a coping: two more value steps per mass, and they
        // are the only thing that keeps these from reading as plain slabs.
        b.at(x, H + 0.45, z, a).box(w + 0.2, 0.9, dp + 0.2, 0, 0);
        b.at(x, H + 0.95, z, a).box(w + 0.5, 0.16, dp + 0.5, 0, 0);
        // Setback: a second, smaller mass stepped in on top of the parapet on
        // about half the ring. One step in plan is worth more to a skyline than
        // any amount of surface detail on the box below it, and at 12 triangles
        // it is a third of what the deleted grid cost.
        if (r() < 0.5) {
          const sw = w * (0.42 + r() * 0.3), sd = dp * (0.42 + r() * 0.3);
          const sh = 3.5 + r() * (H * 0.45);
          const ox = (r() - 0.5) * (w - sw) * 0.8, oz = (r() - 0.5) * (dp - sd) * 0.8;
          b.at(x + ox, H + 1.03 + sh / 2, z + oz, a).box(sw, sh, sd, 0, 0);
          b.at(x + ox, H + 1.03 + sh + 0.1, z + oz, a).box(sw + 0.4, 0.2, sd + 0.4, 0, 0);
        }
        // A stair penthouse and a tank on roughly half of them.
        if (r() < 0.55) {
          const ox = (r() - 0.5) * w * 0.5, oz = (r() - 0.5) * dp * 0.5;
          b.at(x + ox, H + 2.3, z + oz, a).box(3.0, 3.0, 3.4, 0, 0);
          b.at(x + ox, H + 3.9, z + oz, a).box(3.4, 0.2, 3.8, 0, 0);
        }
        if (r() < 0.6) {
          const ox = (r() - 0.5) * w * 0.6, oz = (r() - 0.5) * dp * 0.6;
          const m = this.batch.at('bgGrey', x, z);
          m.at(x + ox, H + 1.7, z + oz).cyl(0.75, 0.7, 1.5, 6, 0, true, false);
          m.at(x + ox, H + 3.4, z + oz).cyl(0.07, 0.04, 2.0 + r() * 2.5, 4, 0, false, false);
        }
        placed++;
      }
    }
    // A minaret and two towers: the map needs at least one landmark that
    // orients the player from anywhere on it.
    for (const [x, z, h, rr] of [[-58, 92, 34, 1.7], [98, -54, 27, 2.6], [-92, -80, 30, 2.2]]) {
      const b = this.batch.at('bgPale', x, z);
      // A landmark is read entirely from its outline, so it keeps its segment
      // count where the outline is (the shaft and the gallery) and loses the
      // chamfers, which at 90–150 m are below the reconstruction filter.
      b.at(x, h / 2, z).cyl(rr * 1.15, rr * 0.92, h, 10, 0, false, false);
      b.at(x, h + 0.5, z).cyl(rr * 1.5, rr * 1.4, 1.0, 10, 0, true, true);
      b.at(x, h + 2.4, z).cyl(rr * 1.2, rr * 0.9, 2.8, 10, 0, false, false);
      b.at(x, h + 4.6, z).cyl(rr * 0.6, 0.02, 2.0, 8, 0, false, false);
    }
    this._backdropCount = placed;
  }

  /* ==================================================================== */
  /*  Buildings                                                           */
  /* ==================================================================== */

  /**
   * @param {object} o  x0,z0,x1,z1,H plus:
   *   look   which faces carry windows, e.g. 'e' or 'ns'
   *   skin   bucket key for the walls
   */
  _block(o) {
    const faces = {};
    for (const k of ['n', 's', 'e', 'w']) {
      faces[k] = o.look.includes(k)
        ? { module: o.module ?? 3.6, windowW: 0.95 }
        : { blank: true };
    }
    if (o.doors) for (const k of Object.keys(o.doors)) faces[k].doors = o.doors[k];
    building(this.kit, {
      x0: o.x0, z0: o.z0, x1: o.x1, z1: o.z1,
      height: o.H, storeys: o.storeys ?? Math.max(1, Math.round(o.H / SCALE.storey)),
      bucket: o.skin, trim: o.trim || 'plasterPale',
      roofBucket: o.roofBucket || 'concrete',
      faces, seed: o.seed ?? 3, grid: 1.2,
      shutter: 'shutter',
      parapet: o.parapet ?? SCALE.parapet,
      parapetSides: o.parapetSides,
      // Roofline breakup and bolted-on facade kit. Both are cheap and both are
      // what stop a row of extruded rectangles reading as extruded rectangles.
      parapetVary: o.parapetVary ?? 1,
      fittingDensity: o.fittings ?? 1,
      interior: false,
    });
    this._roofSlots = this._roofSlots || [];
    this._roofSlots.push({
      x0: o.x0, z0: o.z0, x1: o.x1, z1: o.z1, y: o.H,
      sides: o.parapetSides ?? 'nsew',
    });
    this._footprint(o.x0, o.z0, o.x1, o.z1);
  }

  _buildWestRow() {
    const skins = ['plasterWarm', 'plaster', 'plasterPale', 'plasterWarm', 'brick'];
    const spans = [
      [-42, -27, 6.0], [-24, -8, 6.0], [-5, 12, 9.0], [16, 32, 6.4], [35, 44, 6.0],
    ];
    spans.forEach(([z0, z1, H], i) => {
      this._block({
        x0: -40, z0, x1: -33, z1, H,
        look: 'e', skin: skins[i], seed: 100 + i * 13,
        // W4 is the roof you can reach, so its parapet opens to the south
        // (stair landing) and to the east (plank bridge).
        parapetSides: i === 3 ? 'nw' : 'nsew',
      });
    });

    // Exterior flight in the gap between W3 and W4, climbing west onto the
    // roof of W4: the alley's only route to the rooftops.
    stairs(this.kit, {
      x: -32.4, y: 0, z: 14.0, yaw: -Math.PI / 2,
      width: 2.4, height: 6.4, bucket: 'concrete',
    });
    const land = this.batch.at('concrete', -36, 15);
    land.at(-36.4, 6.25, 15.0).box(7.4, 0.30, 4.2, 0.05, 1.5);
    this.proxy.extent(-40.1, 5.95, 12.9, -32.7, 6.4, 17.1);
    railing(this.kit, { x0: -32.8, z0: 12.9, x1: -32.8, z1: 17.1, y: 6.4, height: 1.05, bucket: 'ironThin' });
    railing(this.kit, { x0: -40, z0: 17.1, x1: -32.8, z1: 17.1, y: 6.4, height: 1.05, bucket: 'ironThin' });

    // Plank bridge, roof of W4 across the alley to the V row. Roof-to-roof
    // movement is what makes the alley worth holding from above.
    const bridge = this.batch.at('timber', -29.5, 30);
    for (let i = 0; i < 5; i++) {
      bridge.at(-29.5, 6.30, 28.4 + i * 0.42).box(7.6, 0.09, 0.36, 0.02, 0);
    }
    bridge.at(-29.5, 6.18, 28.4).box(7.6, 0.16, 0.16, 0.03, 0);
    bridge.at(-29.5, 6.18, 30.1).box(7.6, 0.16, 0.16, 0.03, 0);
    this.proxy.extent(-33.2, 6.05, 28.2, -25.8, 6.35, 30.3);
    railing(this.kit, { x0: -33.2, z0: 28.2, x1: -25.8, z1: 28.2, y: 6.35, height: 1.0, collide: false, bucket: 'ironThin' });
    railing(this.kit, { x0: -33.2, z0: 30.3, x1: -25.8, z1: 30.3, y: 6.35, height: 1.0, collide: false, bucket: 'ironThin' });
  }

  _buildVRow() {
    this._block({ x0: -26, z0: -42, x1: -16, z1: -30, H: 6.0, look: 'ens', skin: 'plaster', seed: 210 });
    this._block({ x0: -26, z0: 2, x1: -16, z1: 20, H: 6.0, look: 'ew', skin: 'plasterPale', seed: 220 });
    this._block({
      x0: -26, z0: 26, x1: -16, z1: 44, H: 6.4, look: 'ews', skin: 'plasterWarm',
      seed: 230, parapetSides: 'nse',      // the plank bridge lands on its west edge
    });

    // Covered passage: the first floor bridges the gap between the souk house
    // and V2, with a segmental arch at each mouth.
    const y0 = 3.0, y1 = 6.0;
    const b = this.batch.at('plasterPale', -21, 0);
    b.at(-21, (y0 + y1) / 2, 0).box(10.0, y1 - y0, 4.0, 0.05, 1.2);
    this.proxy.extent(-26, y0, -2, -16, y1, 2);
    for (const x of [-16.1, -25.9]) {
      archway(this.kit, {
        x, y: 0, z: 0, yaw: Math.PI / 2, span: 4.0, rise: 0.85,
        springY: 2.1, thickness: 0.5, depth: 0.42, bucket: 'brick',
      });
    }
    // Soffit lamp so the passage is not a black slot from either end.
    this._fixtures.push({
      pos: placeLamp(this.kit, { x: -21, y: 2.85, z: 0, style: 'pendant' }),
      color: 0xffb469, intensity: 9, radius: 9, priority: 3,
    });
  }

  /* ------------------------------------------------------- souk house ---- */

  /**
   * The west interior. Two ways in (alley door west, shopfront east), a
   * staircase to a mezzanine, and a balcony that overlooks the plaza approach.
   * Built from explicit wall calls rather than `building()` because every
   * opening here is a gameplay decision.
   */
  _buildSoukHouse() {
    const x0 = -26, x1 = -16, z0 = -22, z1 = -2, H = 6.4, T = SCALE.wallT;
    const h = T / 2;
    const common = {
      height: H, thickness: T, bucket: 'plasterWarm', trim: 'plasterPale',
      plinth: 0.34, cornice: 0.26, grid: 1.2, collide: true,
    };

    // South wall (blank, backs onto the cross-street).
    wall(this.kit, {
      ...common, x0: x0 + h, z0: z0 + h, x1: x1 - h, z1: z0 + h,
      openings: [{ x: -2.0, w: 0.95, h: SCALE.windowH, sill: 3.95 }],
    });
    // North wall, facing the covered passage: one door.
    wall(this.kit, {
      ...common, x0: x1 - h, z0: z1 - h, x1: x0 + h, z1: z1 - h,
      openings: [{ x: 0, w: 1.3, h: SCALE.door, sill: 0 },
        { x: -3.0, w: 0.95, h: SCALE.windowH, sill: 3.95 }],
    });
    // West wall onto the alley: a door and two barred windows.
    const wf = wall(this.kit, {
      ...common, x0: x0 + h, z0: z1 - h, x1: x0 + h, z1: z0 + h,
      openings: [
        { x: 4.5, w: 1.2, h: SCALE.door, sill: 0 },
        { x: -2.0, w: 1.0, h: SCALE.windowH, sill: SCALE.sill },
        { x: -6.5, w: 1.0, h: SCALE.windowH, sill: SCALE.sill },
        { x: 0.5, w: 1.1, h: 1.6, sill: 3.85 },
      ],
    });
    for (const k of [{ x: -2.0, w: 1.0, h: SCALE.windowH, sill: SCALE.sill },
      { x: -6.5, w: 1.0, h: SCALE.windowH, sill: SCALE.sill },
      { x: 0.5, w: 1.1, h: 1.6, sill: 3.85 }]) {
      windowFill(this.kit, wf.m, k, T, { bars: this.detail >= 1 });
    }
    // East wall onto the plaza approach: shopfront, balcony door, window.
    const ef = wall(this.kit, {
      ...common, x0: x1 - h, z0: z0 + h, x1: x1 - h, z1: z1 - h,
      openings: [
        { x: -3.5, w: 3.0, h: 2.6, sill: 0 },            // shopfront, world z = -15.5
        { x: 7.0, w: 1.6, h: 2.1, sill: 3.2 },           // balcony door, world z = -5.0
        { x: 1.0, w: 1.1, h: 1.5, sill: 3.9 },
      ],
    });
    windowFill(this.kit, ef.m, { x: 1.0, w: 1.1, h: 1.5, sill: 3.9 }, T, { bars: false });

    roof(this.kit, {
      x0: x0 + 0.04, z0: z0 + 0.04, x1: x1 - 0.04, z1: z1 - 0.04,
      y: H, bucket: 'concrete', trim: 'plasterPale', capBucket: 'rooflinePale',
      parapet: SCALE.parapet,
      parapetVary: 1, seed: 517,
    });
    this._roofSlots.push({ x0, z0, x1, z1, y: H, sides: 'nsew' });
    this._footprint(x0, z0, x1, z1);
    // The east elevation faces the plaza approach and is in shot from half the
    // map, so it gets the full fitting set.
    facadeFittings(this.kit, {
      x0: x1 - h, z0: z0 + h, x1: x1 - h, z1: z1 - h, height: H, thickness: T,
      seed: 3301, density: 1.3, trimBucket: 'plasterPale',
    });
    facadeFittings(this.kit, {
      x0: x0 + h, z0: z1 - h, x1: x0 + h, z1: z0 + h, height: H, thickness: T,
      seed: 3307, density: 1.0, trimBucket: 'plasterPale',
    });

    // Interior floor: the tiled slab the fight happens on.
    const fl = this.batch.at('tile', -21, -12);
    fl.identity();
    fl.quad([x0 + 0.3, 0.03, z0 + 0.3], [x1 - 0.3, 0.03, z0 + 0.3],
      [x1 - 0.3, 0.03, z1 - 0.3], [x0 + 0.3, 0.03, z1 - 0.3], 2.0);

    // Mezzanine over the north end, reached by a flight against the west wall.
    // The mezzanine's south edge has to reach the head of the flight, which
    // tops out at z = -8.84 for a 3.2 m rise at the kit's 175/290 going.
    const mezY = 3.2;
    const mz = this.batch.at('concrete', -21, -5);
    mz.at(-21, mezY - 0.14, -5.3).box(9.4, 0.28, 7.4, 0.05, 1.4);
    this.proxy.extent(x0 + 0.3, mezY - 0.28, -9.0, x1 - 0.3, mezY, -1.6);
    // Railed except over the stair head — that gap is the way up.
    railing(this.kit, { x0: -22.9, z0: -9.0, x1: -16.4, z1: -9.0, y: mezY, height: 1.05 });
    // Beams under the mezzanine — the underside is at eye height, so it is the
    // most-looked-at surface in the building.
    const beams = this.batch.at('timber', -21, -5);
    for (let i = 0; i < 5; i++) {
      beams.at(-21, mezY - 0.36, -7.6 + i * 1.5).box(9.4, 0.18, 0.22, 0.03, 0);
    }
    stairs(this.kit, {
      x: -24.4, y: 0, z: -11.6, yaw: 0, width: 1.5, height: mezY, bucket: 'concrete',
    });
    railing(this.kit, { x0: -23.5, z0: -14.3, x1: -23.5, z1: -8.9, y: 0, height: 1.0, collide: false });

    // Balcony onto the plaza approach.
    const bal = this.batch.at('concrete', -15.4, -5);
    bal.at(-15.1, mezY - 0.11, -5.0).box(2.2, 0.22, 4.4, 0.04, 1.2);
    this.proxy.extent(-16.2, mezY - 0.22, -7.2, -14.0, mezY, -2.8);
    railing(this.kit, { x0: -14.1, z0: -7.2, x1: -14.1, z1: -2.8, y: mezY, height: 1.05 });
    railing(this.kit, { x0: -16.2, z0: -7.2, x1: -14.1, z1: -7.2, y: mezY, height: 1.05 });
    railing(this.kit, { x0: -14.1, z0: -2.8, x1: -16.2, z1: -2.8, y: mezY, height: 1.05 });
    // Corbels under it.
    const cb = this.batch.at('plasterPale', -15.6, -5);
    for (const z of [-6.8, -5.0, -3.2]) cb.at(-15.4, mezY - 0.45, z).box(1.7, 0.36, 0.3, 0.04, 0);

    // Interior fittings: shelving, sacks, a counter, a hanging bulb.
    const sh = this.batch.at('timber', -21, -16);
    for (let i = 0; i < 3; i++) {
      sh.at(-25.2, 0.4 + i * 0.75, -17.5).box(0.7, 0.06, 6.0, 0.015, 0);
    }
    sh.at(-25.55, 1.3, -17.5).box(0.09, 2.6, 6.0, 0.02, 0);
    sh.at(-18.3, 0.92, -19.5).box(2.6, 0.09, 0.9, 0.02, 0);
    sh.at(-18.3, 0.46, -19.1).box(2.4, 0.9, 0.08, 0.02, 0);
    for (let i = 0; i < 7; i++) {
      const r = this.rand;
      this._prop('crateWood', -24.6 + r() * 1.0, 0, -20.5 + i * 2.4, r() * 3.14);
    }
    this._prop('crateWoodBig', -17.6, 0, -12.2, 0.4);
    this._prop('crateWoodBig', -17.6, 0.86, -12.2, 0.9);
    this._prop('barrel', -24.8, 0, -3.6, 0.2);

    for (const [lx, lz] of [[-21, -17.5], [-21, -6.5]]) {
      this._fixtures.push({
        pos: placeLamp(this.kit, { x: lx, y: 3.6, z: lz, style: 'pendant' }),
        color: 0xffc07a, intensity: 12, radius: 11, priority: 1,
      });
    }
  }

  /* -------------------------------------------------- centre blocks ----- */

  _buildCentreBlocks() {
    // North of the plaza: the market street, nine metres wide, walled both
    // sides. Every one of the camera's forward shots looks up this street.
    this._block({ x0: -16, z0: 14, x1: -5, z1: 28, H: 6.0, look: 'es', skin: 'plasterPale', seed: 310 });
    this._block({ x0: -16, z0: 31, x1: -5, z1: 44, H: 6.4, look: 'es', skin: 'plasterWarm', seed: 320 });
    this._block({ x0: 5, z0: 14, x1: 16, z1: 26, H: 6.0, look: 'wn', skin: 'plaster', seed: 330 });
    this._block({ x0: 5, z0: 29, x1: 16, z1: 44, H: 6.0, look: 'ws', skin: 'plasterPale', seed: 340 });

    // South of the plaza.
    this._block({ x0: -16, z0: -44, x1: -5, z1: -32, H: 6.0, look: 'en', skin: 'plaster', seed: 350 });
    this._block({ x0: -16, z0: -21, x1: -5, z1: -15, H: 6.0, look: 'es', skin: 'plasterWarm', seed: 360 });
    this._block({ x0: 5, z0: -44, x1: 16, z1: -34, H: 6.4, look: 'wn', skin: 'plasterPale', seed: 370 });
    this._block({ x0: 5, z0: -21, x1: 16, z1: -15, H: 6.0, look: 'ws', skin: 'plaster', seed: 380 });

    // Gate arch across the north end of the market street: the sightline stop
    // that keeps a spawn-to-spawn snipe off the table.
    archway(this.kit, {
      x: 0, y: 0, z: 40, yaw: 0, span: 6.6, rise: 1.9, springY: 3.0,
      thickness: 0.7, depth: 0.55, bucket: 'brick',
    });
    for (const s of [-1, 1]) {
      pillar(this.kit, { x: s * 4.4, z: 40, height: 6.2, size: 1.2, bucket: 'brick' });
    }
    const cap = this.batch.at('plasterWarm', 0, 40);
    cap.at(0, 6.5, 40).box(10.4, 0.7, 1.5, 0.06, 1.2);
    cap.at(0, 7.0, 40).box(11.0, 0.3, 1.9, 0.05, 0);
    this.proxy.extent(-5.5, 5.6, 39.2, 5.5, 7.2, 40.8);
    placeSign(this.kit, { x: 0, y: 5.05, z: 39.1, width: 4.4, height: 0.8, yaw: 0 });

    // South gate: a checkpoint rather than an arch — the two ends of the map
    // are not the same building.
    for (const s of [-1, 1]) {
      pillar(this.kit, { x: s * 4.4, z: -38, height: 4.4, size: 1.0, bucket: 'concrete' });
    }
    const boom = this.batch.at('ironwork', 0, -38);
    boom.at(-1.2, 1.15, -38, 0, 0, 0.28).box(6.2, 0.14, 0.14, 0.03, 0);
    boom.at(-4.3, 0.6, -38).box(0.22, 1.2, 0.22, 0.04, 0);
    this.proxy.box(-1.2, 1.1, -38, 6.2, 0.3, 0.3, 0);
  }

  /* ------------------------------------------------- the market hall ---- */

  /**
   * The raised centre. A 1.6 m podium carrying a colonnade and a flat roof at
   * 5.5 m. Three ways up (two stairs, one ramp) and a single stair to the roof.
   */
  _buildMarketHall() {
    const X = 9, Z = 9, PY = 1.6;

    // Podium: a battered plinth with a moulded top edge.
    const p = this.batch.at('concrete', 0, 0);
    p.at(0, PY / 2, 0).box(X * 2, PY, Z * 2, 0.06, 1.6);
    const pt = this.batch.at('plasterPale', 0, 0);
    pt.at(0, PY - 0.09, 0).box(X * 2 + 0.34, 0.18, Z * 2 + 0.34, 0.05, 2.0);
    pt.at(0, PY - 0.30, 0).box(X * 2 + 0.20, 0.24, Z * 2 + 0.20, 0.04, 2.0);
    this.proxy.extent(-X, -0.4, -Z, X, PY, Z);

    // Deck.
    const deck = this.batch.at('tile', 0, 0);
    deck.identity();
    deck.quad([-X + 0.1, PY + 0.02, -Z + 0.1], [X - 0.1, PY + 0.02, -Z + 0.1],
      [X - 0.1, PY + 0.02, Z - 0.1], [-X + 0.1, PY + 0.02, Z - 0.1], 2.0);

    // Stairs south and north on the centre line, and a ramp on the west.
    stairs(this.kit, { x: 0, y: 0, z: -10.35, yaw: Math.PI, width: 4.2, height: PY, bucket: 'concrete' });
    stairs(this.kit, { x: 0, y: 0, z: 10.35, yaw: 0, width: 4.2, height: PY, bucket: 'concrete' });
    const ramp = this.batch.at('concrete', -11, 3);
    ramp.at(-10.9, 0, 3.0, -Math.PI / 2).ramp(3.0, PY, 4.0, 0.03);
    this.proxy.ramp(-10.9, 0, 3.0, 3.0, PY, 4.0, -Math.PI / 2);
    railing(this.kit, { x0: -12.9, z0: 4.6, x1: -8.9, z1: 4.6, y: 0, height: 1.0, collide: false });

    // Colonnade: twelve columns on a 3.6 m module, carrying an architrave.
    const H = 3.6;
    const cols = [];
    for (let i = 0; i < 5; i++) {
      const t = -X + 1.4 + (2 * X - 2.8) * (i / 4);
      cols.push([t, -Z + 1.4], [t, Z - 1.4]);
    }
    cols.push([-X + 1.4, 0], [X - 1.4, 0]);
    for (const [cx, cz] of cols) {
      column(this.kit, { x: cx, z: cz, y: PY, height: H, radius: 0.27, bucket: 'plasterPale' });
    }

    // Architrave and roof slab.
    const arc = this.batch.at('plasterPale', 0, 0);
    for (const cz of [-Z + 1.4, Z - 1.4]) {
      arc.at(0, PY + H + 0.16, cz).box(2 * X - 2.0, 0.34, 0.62, 0.05, 1.4);
    }
    for (const cx of [-X + 1.4, X - 1.4]) {
      arc.at(cx, PY + H + 0.16, 0).box(0.62, 0.34, 2 * Z - 2.0, 0.05, 1.4);
    }

    const roofY = PY + H + 0.34 + 0.28;
    roof(this.kit, {
      x0: -X + 0.6, z0: -Z + 0.6, x1: X - 0.6, z1: Z - 0.6,
      y: roofY, bucket: 'concrete', trim: 'plasterPale', capBucket: 'rooflinePale',
      parapet: 0.95,
      thickness: 0.30, sides: 'nsw',      // east side opens onto the roof stair
    });
    // Ceiling underside is timber joists — the player spends real time under it.
    const jo = this.batch.at('timber', 0, 0);
    for (let i = 0; i < 9; i++) {
      const z = -Z + 1.6 + (2 * Z - 3.2) * (i / 8);
      jo.at(0, roofY - 0.42, z).box(2 * X - 1.6, 0.20, 0.24, 0.03, 0);
    }

    // Roof stair. Deliberately *outside* the colonnade and on the yard side:
    // it is a nine-metre climb in the open, so the hall roof costs exposure.
    stairs(this.kit, {
      x: 10.7, y: 0, z: 0, yaw: 0, width: 1.5,
      height: roofY, bucket: 'concrete',
    });
    const land = this.batch.at('concrete', 10, 5.4);
    land.at(9.9, roofY - 0.14, 5.4).box(3.4, 0.28, 2.0, 0.05, 1.2);
    this.proxy.extent(8.2, roofY - 0.28, 4.4, 11.6, roofY, 6.4);
    railing(this.kit, { x0: 11.6, z0: 6.4, x1: 8.2, z1: 6.4, y: roofY, height: 1.05, bucket: 'ironThin' });
    pillar(this.kit, { x: 11.2, z: 6.0, height: roofY - 0.28, size: 0.4, bucket: 'concrete' });

    // Hanging lamps between the columns.
    for (const [lx, lz] of [[-4.5, 0], [4.5, 0]]) {
      this._fixtures.push({
        pos: placeLamp(this.kit, { x: lx, y: PY + H - 0.15, z: lz, style: 'pendant' }),
        color: 0xffc07a, intensity: 10, radius: 12, priority: 2,
      });
    }

    // Under-colonnade dressing: stalls, sacks, crates, a rug rail.
    for (const [sx, sz, yaw] of [[-6.2, -5.4, 0.0], [6.2, -5.4, Math.PI],
      [-6.2, 5.4, Math.PI], [6.2, 5.4, 0.0]]) {
      placeStall(this.kit, {
        x: sx, z: sz, y: PY, yaw, width: 2.4, depth: 1.6,
        clothBucket: sx < 0 ? 'awning' : 'awningRed', seed: 60 + sx * 3 + sz,
      });
    }
    // Deck cover, threaded between the columns rather than on top of them.
    for (const [cx, cz] of [[-5.0, -3.0], [5.0, 3.0], [-3.0, 5.4], [3.0, -5.4]]) {
      this._prop('crateWoodBig', cx, PY, cz, (cx + cz) * 0.3);
      this._prop('crateWood', cx + 0.9, PY, cz + 0.4, cx * 0.7);
    }
    this._prop('sandbagLow', -1.5, PY, -8.2, 0);
    this._prop('sandbagLow', 1.5, PY, 8.2, 0);
  }

  /* ------------------------------------------------------- east row ----- */

  _buildEastRow() {
    this._block({ x0: 16, z0: -44, x1: 28, z1: -31, H: 6.0, look: 'wn', skin: 'plasterPale', seed: 410 });
    this._block({ x0: 16, z0: -21, x1: 28, z1: -10, H: 5.6, look: 'wn', skin: 'brick', seed: 420 });
    this._block({ x0: 16, z0: 10, x1: 28, z1: 20, H: 6.0, look: 'ws', skin: 'plaster', seed: 430 });
    this._block({ x0: 16, z0: 23, x1: 28, z1: 36, H: 6.5, look: 'ws', skin: 'plasterWarm', seed: 440 });

    // Walled garden in the north-east corner: the only soft, quiet pocket on
    // the map, and the flank route out of the north-east spawn.
    wall(this.kit, {
      x0: 16.4, z0: 37.2, x1: 27.6, z1: 37.2, height: 1.7, thickness: 0.34,
      bucket: 'brick', trim: 'plasterPale', plinth: 0.24, cornice: 0.16,
      openings: [{ x: 2.4, w: 1.6, h: 1.7, sill: 0 }], grid: 1.0,
    });
    wall(this.kit, {
      x0: 16.4, z0: 44.4, x1: 16.4, z1: 37.2, height: 1.7, thickness: 0.34,
      bucket: 'brick', trim: 'plasterPale', plinth: 0.24, cornice: 0.16, grid: 1.0,
    });
  }

  /**
   * The garage. Interior, two openings on the west face, a mezzanine over the
   * east side, and a corrugated roof — the only building on the map you can
   * hear someone walking on.
   */
  _buildGarage() {
    const x0 = 16, x1 = 28, z0 = -8, z1 = 8, H = 5.6, T = 0.4;
    const h = T / 2;
    const common = {
      height: H, thickness: T, bucket: 'concrete', trim: 'plasterPale',
      plinth: 0.30, cornice: 0.22, grid: 1.2,
    };
    // West face: the roller opening at z = -2 (4 m) and a personnel door at
    // z = +5. Local +X on this run maps to world -Z, so local x = -world z.
    wall(this.kit, {
      ...common, x0: x0 + h, z0: z1 - h, x1: x0 + h, z1: z0 + h,
      openings: [{ x: 2.0, w: 4.0, h: 3.4, sill: 0 }, { x: -5.0, w: 1.2, h: SCALE.door, sill: 0 }],
    });
    // East face onto the yard: one wide opening, so the garage is a shooting
    // gallery both ways rather than a safe pocket.
    wall(this.kit, {
      ...common, x0: x1 - h, z0: z0 + h, x1: x1 - h, z1: z1 - h,
      openings: [{ x: 1.5, w: 3.6, h: 3.2, sill: 0 }, { x: -4.5, w: 1.1, h: 1.5, sill: 3.4 }],
    });
    const sf = wall(this.kit, {
      ...common, x0: x0 + h, z0: z0 + h, x1: x1 - h, z1: z0 + h,
      openings: [{ x: -2.0, w: 1.1, h: 1.5, sill: 3.5 }, { x: 3.0, w: 1.1, h: 1.5, sill: 3.5 }],
    });
    const nf = wall(this.kit, {
      ...common, x0: x1 - h, z0: z1 - h, x1: x0 + h, z1: z1 - h,
      openings: [{ x: 0, w: 2.4, h: 2.4, sill: 0 }, { x: -4.0, w: 1.1, h: 1.5, sill: 3.5 }],
    });
    for (const [f, k] of [[sf, { x: -2.0, w: 1.1, h: 1.5, sill: 3.5 }],
      [sf, { x: 3.0, w: 1.1, h: 1.5, sill: 3.5 }],
      [nf, { x: -4.0, w: 1.1, h: 1.5, sill: 3.5 }]]) {
      windowFill(this.kit, f.m, k, T, { bars: this.detail >= 1, glass: false });
    }

    this._footprint(x0, z0, x1, z1);
    this._roofSlots.push({ x0: x0 + 1, z0: z0 + 1, x1: x1 - 1, z1: z1 - 1, y: H + 0.2, sides: 'nsew' });
    facadeFittings(this.kit, {
      x0: x0 + h, z0: z1 - h, x1: x0 + h, z1: z0 + h, height: H, thickness: T,
      seed: 4401, density: 1.1, trimBucket: 'plasterPale',
    });

    // Corrugated deck on exposed steel purlins.
    const cr = this.batch.at('corrugated', 22, 0);
    cr.at(22, H + 0.09, 0).box(12.6, 0.18, 16.6, 0.04, 0);
    const pur = this.batch.at('ironwork', 22, 0);
    for (let i = 0; i < 7; i++) {
      pur.at(22, H - 0.16, -7.2 + i * 2.4).box(12.0, 0.26, 0.14, 0.03, 0);
    }
    pur.at(22, H - 0.42, 0).box(0.3, 0.5, 16.0, 0.04, 0);
    this.proxy.extent(x0, H - 0.1, z0, x1, H + 0.2, z1);
    // A low upstand so the roof is a usable position with a lip of cover.
    for (const [ax, az, bx, bz] of [[x0, z0, x1, z0], [x0, z1, x1, z1], [x0, z0, x0, z1], [x1, z0, x1, z1]]) {
      const f = wallFrame(ax, az, bx, bz, H + 0.18);
      const tb = this.batch.at('ironwork', (ax + bx) / 2, (az + bz) / 2);
      tb.frame(f.m);
      tb.at(0, 0.3, 0).box(f.len, 0.6, 0.14, 0.02, 0);
      tb.clearFrame();
      this.proxy.box(...[(ax + bx) / 2, H + 0.48, (az + bz) / 2], f.len, 0.6, 0.16, f.yaw);
    }

    // Mezzanine over the east third with an open steel stair.
    const mY = 2.9;
    const mz = this.batch.at('concrete', 26, 0);
    mz.at(25.6, mY - 0.12, 0).box(4.4, 0.24, 14.8, 0.04, 1.4);
    this.proxy.extent(23.4, mY - 0.24, -7.4, 27.8, mY, 7.4);
    railing(this.kit, { x0: 23.4, z0: -7.4, x1: 23.4, z1: 7.4, y: mY, height: 1.05 });
    stairs(this.kit, { x: 22.4, y: 0, z: -4.6, yaw: -Math.PI / 2, width: 1.3, height: mY, bucket: 'concrete' });

    // Contents: a vehicle on stands, drums, tyres, a bench, pipe racks.
    placeVehicle(this.kit, { x: 20.0, z: -3.4, yaw: 0.06, kind: 'sedan', flat: true, bodyBucket: 'carpaintB' });
    for (const [bx, bz] of [[18.2, 5.6], [18.9, 6.4], [19.0, 4.8], [26.4, -6.2]]) {
      this._prop('barrel', bx, 0, bz, (bx + bz) * 0.4);
    }
    for (let i = 0; i < 6; i++) this._prop('tyre', 17.6 + (i % 2) * 0.2, 0.14 * i, 1.8, i * 0.7);
    this._prop('pipes', 25.8, 0, 4.0, Math.PI / 2);
    const bench = this.batch.at('timber', 26, -3);
    bench.at(26.6, 0.9, -3.0).box(2.6, 0.09, 0.8, 0.02, 0);
    bench.at(26.6, 0.45, -3.0).box(2.4, 0.75, 0.06, 0.02, 0);
    this.proxy.box(26.6, 0.5, -3.0, 2.6, 1.0, 0.8, 0);

    for (const [lx, lz] of [[21, -3], [21, 4.5]]) {
      this._fixtures.push({
        pos: placeLamp(this.kit, { x: lx, y: H - 0.55, z: lz, style: 'pendant' }),
        color: 0xfff0d0, intensity: 14, radius: 13, priority: 0,
      });
    }
  }

  /* ---------------------------------------------------------- the yard -- */

  _buildYard() {
    const r = this.rand;

    // Checkpoint at the yard's waist: sandbags, barriers, a burnt-out van.
    for (let i = 0; i < 4; i++) {
      this._prop('jersey', 29.5 + (i % 2) * 0.15, 0, -6.0 + i * 2.1, 0.02 * i);
    }
    for (let i = 0; i < 3; i++) this._prop('jersey', 33.0 + i * 2.05, 0, 12.0, Math.PI / 2);
    this._prop('sandbagHigh', 36.5, 0, -2.0, Math.PI / 2);
    this._prop('sandbagHigh', 36.5, 0, 0.1, Math.PI / 2);
    this._prop('sandbagLow', 34.6, 0, -3.4, 0);
    this._prop('sandbagLow', 32.4, 0, 3.6, 0.1);

    placeVehicle(this.kit, { x: 33.5, z: -14.0, yaw: 0.28, kind: 'van', flat: true, bodyBucket: 'carpaint' });
    placeVehicle(this.kit, { x: 36.2, z: 20.5, yaw: -1.55, kind: 'pickup', bodyBucket: 'carpaintB' });
    placeVehicle(this.kit, { x: 30.6, z: 30.0, yaw: 1.6, kind: 'sedan', bodyBucket: 'carpaint' });
    placeVehicle(this.kit, { x: 31.2, z: -30.0, yaw: -0.1, kind: 'pickup', flat: true, bodyBucket: 'carpaintB' });

    this._prop('pipes', 38.0, 0, -24.0, 0.06);
    this._prop('pipes', 38.0, 0.34, -24.0, 0.02);
    this._prop('pipes', 38.2, 0, -20.2, -0.04);

    // Everything scattered in the yard must clear x = 28.6: west of that is
    // the east building row, and a barrel inside a wall is a bug you only find
    // by walking the whole map.
    for (let i = 0; i < 14; i++) {
      const x = 28.8 + r() * 10.2, z = -42 + r() * 84;
      if (Math.abs(z) < 9 && x < 29.6) continue;
      this._prop(r() < 0.5 ? 'barrel' : 'barrelBlue', x, 0, z, r() * 3.14);
    }
    for (let i = 0; i < 10; i++) {
      this._prop('crateMetal', 28.8 + r() * 9.4, 0, -40 + r() * 80, r() * 3.14);
    }
    for (let i = 0; i < 6; i++) this._prop('tyre', 29.4 + r() * 8.6, 0.06, -38 + r() * 76, r() * 3.14);
    for (let i = 0; i < 5; i++) this._prop('rubble', 29.4 + r() * 8.6, 0, -40 + r() * 80, r() * 3.14);
    for (let i = 0; i < 8; i++) this._prop('bollard', 28.6, 0, -34 + i * 9.5, 0);

    placeSign(this.kit, { x: 28.2, y: 3.6, z: -25.0, width: 2.4, height: 0.8, yaw: -Math.PI / 2 });
    placeSign(this.kit, { x: 34.0, y: 2.9, z: 8.0, width: 2.2, height: 0.7, yaw: Math.PI, posts: true });

    // Utility poles against the east wall, strung with cable. Vertical rhythm
    // in the most open lane, and the cables cut the sky into readable bands.
    const poles = [-38, -19, 0, 19, 38];
    const px = 38.9;
    for (const z of poles) {
      const p = this.batch.at('timber', px, z);
      p.at(px, 4.2, z).cyl(0.19, 0.14, 8.4, 8, 0.03);
      p.at(px, 7.5, z).box(1.2, 0.14, 0.14, 0.03, 0);
      this.proxy.box(px, 4.2, z, 0.4, 8.4, 0.4);
      const iso = this.batch.at('ironwork', px, z);
      for (const s of [-1, 1]) iso.at(px + s * 0.5, 7.66, z).cyl(0.07, 0.05, 0.14, 6, 0.01);
    }
    for (let i = 0; i < poles.length - 1; i++) {
      for (const s of [-1, 1]) {
        placeCable(this.kit,
          [px + s * 0.5, 7.66, poles[i]], [px + s * 0.5, 7.66, poles[i + 1]], 1.1, 0.022);
      }
    }
  }

  /* ------------------------------------------------------ spawn ends ---- */

  _buildSpawnEnds() {
    const r = this.rand;
    // South (team 0): a sandbagged staging area, tents' worth of crates.
    for (let i = 0; i < 5; i++) {
      this._prop('sandbagLow', -12 + i * 6.0, 0, -41.0, 0);
    }
    for (let i = 0; i < 9; i++) {
      this._prop(r() < 0.6 ? 'crateWoodBig' : 'crateMetal', -20 + r() * 40, 0, -43.5 + r() * 3.0, r() * 3.14);
    }
    for (let i = 0; i < 4; i++) this._prop('pallet', -22 + i * 11, 0, -44.6, r() * 0.4);
    placeVehicle(this.kit, { x: -22.0, z: -44.2, yaw: 1.52, kind: 'pickup', bodyBucket: 'carpaint' });

    // North (team 1): a produce market, so the two ends read differently.
    for (let i = 0; i < 4; i++) {
      placeStall(this.kit, {
        x: -14 + i * 9.5, z: 43.0, yaw: Math.PI, width: 2.8, depth: 1.9,
        clothBucket: i % 2 ? 'awningRed' : 'awning', seed: 200 + i * 17,
      });
    }
    for (let i = 0; i < 8; i++) {
      this._prop('crateWood', -22 + r() * 44, 0, 41.0 + r() * 2.6, r() * 3.14);
    }
    this._prop('sandbagLow', -8.0, 0, 38.0, 0);
    this._prop('sandbagLow', 8.0, 0, 38.0, 0);
    placeVehicle(this.kit, { x: 21.0, z: 44.0, yaw: -1.6, kind: 'van', bodyBucket: 'carpaintB' });
  }

  /* -------------------------------------------------------- dressing ---- */

  _dressStreets() {
    const r = this.rand;
    const d = this.detail;

    /* --- the alley: awnings, rugs, cables, clutter ----------------------
     * An awning is authored with its high rail on local -Z, so a canopy that
     * hangs off an EAST-facing wall (projecting +X) needs yaw +pi/2 and one on
     * a WEST-facing wall needs -pi/2. Getting this backwards buries the rail
     * in the street and the hem in the building.
     */
    for (const z of [-36, -18, -12, -6, 6, 14, 30, 38]) {
      awning(this.kit, {
        x: -27.1, z, width: 3.6, depth: 2.4, yaw: -Math.PI / 2,
        height: 2.95, drop: 0.5, posts: true,
        clothBucket: (z | 0) % 2 ? 'awning' : 'awningRed',
      });
    }
    for (const z of [-34, -16, 2, 20, 38]) {
      awning(this.kit, {
        x: -32.1, z, width: 3.0, depth: 2.0, yaw: Math.PI / 2,
        height: 2.8, drop: 0.45, posts: z > 0,
        clothBucket: 'awning',
      });
    }
    if (d >= 1) {
      const rugZ = [-38, -33, -20, -14, -9, 4, 10, 17, 32, 40];
      rugZ.forEach((z, i) => {
        placeHangingRug(this.kit, {
          x: -26.7, z, yaw: Math.PI / 2, width: 1.5 + r() * 0.5,
          height: 1.9 + r() * 0.6, top: 3.4, phase: i * 1.7,
        });
      });
    }
    // Cable web across the alley, anchored on both facades.
    for (let i = 0; i < 8; i++) {
      const z = -38 + i * 10.4;
      placeCable(this.kit, [-32.9, 4.6 + (i % 2) * 0.6, z], [-26.1, 4.2 + (i % 3) * 0.5, z + 1.2], 0.9, 0.016);
    }
    for (let i = 0; i < 4; i++) {
      placeCable(this.kit, [-32.9, 5.4, -34 + i * 20], [-32.9, 5.2, -24 + i * 20], 0.7, 0.014);
    }
    for (let i = 0; i < 12; i++) {
      const z = -42 + r() * 84;
      this._prop(r() < 0.55 ? 'crateWood' : 'barrel', -32 + r() * 5.6, 0, z, r() * 3.14);
    }
    for (let i = 0; i < 5; i++) this._prop('pallet', -32.6 + r() * 5, 0, -40 + r() * 80, r() * 3.14);
    for (let i = 0; i < 4; i++) this._prop('rubble', -31 + r() * 4, 0, -38 + r() * 74, r() * 3.14);
    this._prop('sandbagLow', -29.5, 0, -12.0, 0.02);
    this._prop('sandbagLow', -29.5, 0, 22.0, 0.02);
    this._prop('sandbagHigh', -32.4, 0, 6.0, Math.PI / 2);

    /* --- the market street ---------------------------------------------- */
    // Awnings project from both facades and nearly meet overhead. This is the
    // shot the camera looks straight down; it needs a ceiling.
    for (let i = 0; i < 6; i++) {
      const z = 16.5 + i * 4.6;
      awning(this.kit, {
        x: -3.6, z, width: 4.2, depth: 3.0, yaw: Math.PI / 2,
        height: 3.05, drop: 0.55, posts: true, clothBucket: i % 2 ? 'awningRed' : 'awning',
      });
      awning(this.kit, {
        x: 3.6, z: z + 2.3, width: 4.2, depth: 3.0, yaw: -Math.PI / 2,
        height: 3.05, drop: 0.55, posts: true, clothBucket: i % 2 ? 'awning' : 'awningRed',
      });
    }
    for (let i = 0; i < 7; i++) {
      const z = 15.5 + i * 4.2;
      placeCable(this.kit, [-4.8, 5.1, z], [4.8, 5.0, z + 0.8], 1.0, 0.018);
    }
    if (d >= 1) {
      for (let i = 0; i < 6; i++) {
        placeHangingRug(this.kit, {
          x: 4.7, z: 17 + i * 4.4, yaw: -Math.PI / 2, width: 1.6, height: 2.2, top: 3.5, phase: i * 2.1,
        });
      }
    }
    for (let i = 0; i < 5; i++) {
      placeStall(this.kit, {
        x: (i % 2 ? 2.6 : -2.6), z: 17.0 + i * 5.0, yaw: (i % 2 ? -Math.PI / 2 : Math.PI / 2),
        width: 2.6, depth: 1.8, clothBucket: i % 2 ? 'awning' : 'awningRed', seed: 300 + i * 11,
      });
    }
    this._prop('sandbagLow', -2.2, 0, 14.6, 0.05);
    this._prop('sandbagLow', 2.6, 0, 30.4, -0.05);
    this._prop('jersey', -3.2, 0, 36.0, Math.PI / 2);
    this._prop('jersey', 3.2, 0, 34.0, Math.PI / 2);
    for (let i = 0; i < 10; i++) {
      this._prop(r() < 0.5 ? 'crateWood' : 'crateWoodBig', -4.2 + r() * 8.4, 0, 15 + r() * 28, r() * 3.14);
    }

    /* --- south street and the long cross-street -------------------------- */
    for (let i = 0; i < 6; i++) {
      this._prop('jersey', -30 + i * 13.0, 0, -26.0 + (i % 2) * 2.4, 0);
    }
    this._prop('sandbagHigh', -8.5, 0, -24.0, 0);
    this._prop('sandbagHigh', 8.5, 0, -28.0, 0);
    for (let i = 0; i < 8; i++) {
      this._prop(r() < 0.5 ? 'barrel' : 'crateMetal', -14 + r() * 28, 0, -34 + r() * 12, r() * 3.14);
    }
    for (let i = 0; i < 6; i++) {
      this._prop('crateWoodBig', -4.4 + r() * 8.8, 0, -40 + r() * 22, r() * 3.14);
    }
    this._prop('sandbagLow', -2.6, 0, -17.0, 0);
    this._prop('sandbagLow', 2.6, 0, -19.0, 0);

    /* --- plaza ----------------------------------------------------------- */
    for (const [px, pz, yaw] of [[-13.5, -11.5, 0.4], [13.5, -11.5, -0.4],
      [-13.5, 11.5, 2.6], [13.5, 11.5, -2.6]]) {
      placeStall(this.kit, {
        x: px, z: pz, yaw, width: 3.0, depth: 2.0,
        clothBucket: px < 0 ? 'awningRed' : 'awning', seed: 500 + px * 7 + pz,
      });
    }
    for (let i = 0; i < 8; i++) {
      this._prop('bollard', -16.0 + i * 4.6, 0, -13.6, 0);
      this._prop('bollard', -16.0 + i * 4.6, 0, 13.6, 0);
    }
    this._prop('jersey', -12.0, 0, 0.0, Math.PI / 2);
    this._prop('jersey', 12.0, 0, -2.0, Math.PI / 2);
    for (let i = 0; i < 6; i++) {
      this._prop(r() < 0.5 ? 'crateWood' : 'barrel', -15 + r() * 30, 0, -13 + r() * 26, r() * 3.14);
    }

    /* --- debris scatter, gated by tier ----------------------------------- */
    if (d >= 1) {
      const spots = [[-29, -20], [-29, 18], [-20, -26], [0, -33], [11, 26],
        [21, -26], [33, -8], [33, 26], [-11, 6], [7, -8]];
      for (let i = 0; i < spots.length; i++) {
        placeDebris(this.kit, {
          x: spots[i][0], z: spots[i][1], radius: 2.4 + r() * 1.6,
          count: d >= 2 ? 22 : 12, seed: 900 + i * 31, bucket: 'rubblebits',
        });
      }
    }
  }

  /**
   * Roof clutter. Every roof gets tanks, dishes, AC units and a parapet-height
   * scatter — the skyline is a third of every outdoor frame on this map.
   */
  _dressRoofs() {
    const r = this.rand;
    const slots = this._roofSlots || [];
    for (const s of slots) {
      const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
      const w = Math.abs(s.x1 - s.x0), d = Math.abs(s.z1 - s.z0);

      // DENSITY. This was one prop per 42 m² of roof, which on a 7x15 block is
      // three objects — below the threshold where a roof reads as inhabited at
      // all. One per 8 m², clustered rather than scattered, is what a street of
      // flat roofs in this part of the world actually looks like from below.
      const perM2 = { 0: 16, 1: 10, 2: 8, 3: 7 }[this.detail] ?? 8;
      const n = Math.max(this.detail >= 1 ? 6 : 4, Math.round((w * d) / perM2));

      // Everything that has to break the skyline has to clear the parapet, and
      // the parapet is 1.05 m with piers to 1.5. A 0.74 m AC unit sitting flat
      // on the slab is invisible from the street no matter how many you place,
      // which is why the old pass bought nothing: half of these now stand on a
      // 0.55 m sleeper frame, and the tallest go closest to the edge.
      const edgeBand = 1.6;
      for (let i = 0; i < n; i++) {
        // Bias toward the parapet: a roof reads from the street through its
        // edge, and the middle of it is never in frame.
        const edgeward = r() < 0.62;
        let x, z;
        if (edgeward) {
          const side = (r() * 4) | 0;
          const t = 0.08 + r() * 0.84;
          if (side === 0) { x = s.x0 + w * t; z = s.z0 + edgeBand * (0.35 + r() * 0.9); }
          else if (side === 1) { x = s.x0 + w * t; z = s.z1 - edgeBand * (0.35 + r() * 0.9); }
          else if (side === 2) { x = s.x0 + edgeBand * (0.35 + r() * 0.9); z = s.z0 + d * t; }
          else { x = s.x1 - edgeBand * (0.35 + r() * 0.9); z = s.z0 + d * t; }
        } else {
          x = cx + (r() - 0.5) * (w - 2.6);
          z = cz + (r() - 0.5) * (d - 2.6);
        }
        const pick = r();
        const yaw = r() * 3.14;
        if (pick < 0.30) {
          // Water tank on a steel sleeper frame: 1.48 m of tank on 0.55 m of
          // stand clears any parapet on the map by half a metre.
          const stand = r() < 0.7;
          if (stand) this._roofStand(x, s.y, z, 1.3, 1.3, 0.55, yaw);
          this._prop('tank', x, s.y + (stand ? 0.55 : 0), z, yaw);
        } else if (pick < 0.56) {
          const stand = r() < 0.55;
          if (stand) this._roofStand(x, s.y, z, 1.15, 1.0, 0.62, yaw);
          this._prop('ac', x, s.y + (stand ? 0.62 : 0), z, yaw);
        } else if (pick < 0.78) {
          // Dishes go on a post so they stand at head height above the coping.
          const post = this.batch.at('ironThin', x, z);
          post.at(x, s.y + 0.55, z).box(0.11, 1.1, 0.11, 0.02, 0);
          this._prop('dish', x, s.y + 1.1, z, yaw);
        } else if (pick < 0.90) {
          this._prop('crateRoof', x, s.y, z, yaw);
          if (r() < 0.5) this._prop('crateRoof', x + 0.5, s.y, z + 0.3, yaw + 0.7);
        } else {
          this._prop('barrelRoof', x, s.y, z, yaw);
        }
      }

      // Pipe runs across the deck and over the parapet — the thing that ties a
      // roof's clutter together instead of leaving it as scattered objects.
      if (w * d > 60) {
        const py = s.y + 0.16;
        const ax = s.x0 + 1.2 + r() * (w - 2.4);
        placeCable(this.kit, [ax, py, s.z0 + 0.8], [ax, py, s.z1 - 0.8], 0.05, 0.055);
        const pz = s.z0 + 1.0 + r() * (d - 2.0);
        placeCable(this.kit, [s.x0 + 0.8, py + 0.06, pz], [s.x1 - 0.8, py + 0.06, pz], 0.05, 0.045);
      }

      // A stair bulkhead on the larger roofs, now with a door and a coping so
      // it is a building rather than a block.
      if (w * d > 90 && r() < 0.85) {
        const bx = cx + (r() - 0.5) * (w - 4), bz = cz + (r() - 0.5) * (d - 4);
        const bl = this.batch.at('rooflinePale', bx, bz);
        bl.at(bx, s.y + 1.3, bz).box(2.2, 2.6, 2.6, 0.05, [3.2, 1.2]);
        bl.at(bx, s.y + 2.68, bz).box(2.5, 0.16, 2.9, 0.04, 0);
        bl.at(bx, s.y + 2.86, bz).box(2.1, 0.20, 2.5, 0.04, 0);
        const dr = this.batch.at('rooflineTin', bx, bz);
        dr.at(bx, s.y + 1.05, bz - 1.32).box(0.95, 2.05, 0.09, 0.02, 0);
        this.proxy.box(bx, s.y + 1.3, bz, 2.2, 2.6, 2.6);
        // Vent stub off the bulkhead roof.
        const vt = this.batch.at('ironThin', bx, bz);
        vt.at(bx + 0.6, s.y + 3.25, bz).cyl(0.14, 0.14, 0.7, 8, 0.02);
        vt.at(bx + 0.6, s.y + 3.66, bz).cyl(0.22, 0.10, 0.16, 8, 0.02);
      }

      // ---- the roofline itself ------------------------------------------
      // Everything from here down is in a `SKY` bucket, so it is submitted
      // once per frame instead of five times. That is the whole reason this
      // pass can afford to exist at the same time as a triangle budget: the
      // round bought it by taking the parapet coping, the rooftop plant and
      // every cable on the map out of the shadow passes, and spends it here,
      // on the one line in the frame that is always against the sky.

      // A masonry flue: tapered shaft, corbelled-out head, clay pots. Four
      // stacked blocks that read as a chimney at 60 m and cost 100 triangles.
      const flues = 1 + ((r() * 2.6) | 0);
      for (let k = 0; k < flues; k++) {
        const fx = cx + (r() - 0.5) * (w - 1.8), fz = cz + (r() - 0.5) * (d - 1.8);
        const fh = 1.5 + r() * 1.4;
        const fl = this.batch.at('roofline', fx, fz);
        fl.at(fx, s.y + fh / 2, fz).box(0.62, fh, 0.52, 0.03, 0, FACE_ALL, FACE_NY);
        fl.at(fx, s.y + fh + 0.09, fz).box(0.80, 0.18, 0.70, 0.03, 0);
        fl.at(fx, s.y + fh + 0.24, fz).box(0.66, 0.14, 0.58, 0.025, 0);
        const pots = 1 + ((r() * 2) | 0);
        for (let q = 0; q < pots; q++) {
          const ox = (q - (pots - 1) / 2) * 0.24;
          fl.at(fx + ox, s.y + fh + 0.52, fz).cyl(0.09, 0.10, 0.42, 7, 0.015, false, false);
        }
        this.proxy.box(fx, s.y + fh / 2, fz, 0.62, fh, 0.52);
      }

      // A corrugated lean-to over one corner of the deck: the strongest single
      // silhouette break available, because its roof is the only sloped plane
      // on a compound made entirely of flat ones.
      if (w * d > 70 && r() < 0.85) {
        const sw = 2.6 + r() * 1.4, sd = 2.0 + r() * 0.8;
        const corner = (r() * 4) | 0;
        const sx = corner < 2 ? s.x0 + sw / 2 + 0.5 : s.x1 - sw / 2 - 0.5;
        const sz = (corner & 1) ? s.z0 + sd / 2 + 0.5 : s.z1 - sd / 2 - 0.5;
        const hi = 2.3 + r() * 0.5, lo = hi - 0.55 - r() * 0.35;
        const tin = this.batch.at('rooflineTin', sx, sz);
        const post = this.batch.at('ironThin', sx, sz);
        for (const ax2 of [-1, 1]) {
          for (const az2 of [-1, 1]) {
            const ph = az2 < 0 ? hi : lo;
            post.at(sx + ax2 * (sw / 2 - 0.06), s.y + ph / 2, sz + az2 * (sd / 2 - 0.06))
              .box(0.09, ph, 0.09, 0.018, 0);
          }
        }
        // The sheet, pitched across Z. One quad plus a ridge capping and a
        // fascia lip, so the edge reads as folded metal rather than paper.
        tin.identity().quad(
          [sx - sw / 2, s.y + hi, sz - sd / 2], [sx + sw / 2, s.y + hi, sz - sd / 2],
          [sx + sw / 2, s.y + lo, sz + sd / 2], [sx - sw / 2, s.y + lo, sz + sd / 2],
          [sw / 3, sd],
        );
        tin.at(sx, s.y + hi + 0.05, sz - sd / 2).box(sw + 0.22, 0.10, 0.20, 0.02, 0);
        tin.at(sx, s.y + lo - 0.04, sz + sd / 2 + 0.02).box(sw + 0.22, 0.12, 0.08, 0.02, 0);
        // Two sides sheeted, two open — an open bay is what makes it a shelter.
        tin.at(sx - sw / 2 - 0.02, s.y + (hi + lo) / 4 + 0.1, sz)
          .box(0.06, (hi + lo) / 2, sd, 0.015, 0);
        this.proxy.box(sx, s.y + hi / 2, sz, sw, hi, sd);
      }

      // Corner blocks. A parapet whose run is broken into bays still turns its
      // corners with a single mitre, and a mitre is invisible from the street —
      // it is the one place the outline reads as an extruded rectangle. A
      // taller block on each corner, stepped twice, is what makes the four
      // elevations look like they belong to a building rather than a box.
      {
        const cap = this.batch.at('rooflinePale', cx, cz);
        for (const ox of [s.x0, s.x1]) {
          for (const oz of [s.z0, s.z1]) {
            const ch = 1.62 + ((Math.abs(ox * 3 + oz * 7) | 0) % 5) * 0.11;
            // Full six faces: the block straddles the roof corner and oversails
            // the deck edge, so its underside is on the street's sightline.
            cap.at(ox, s.y + ch / 2, oz).box(0.62, ch, 0.62, 0.04, 0);
            cap.at(ox, s.y + ch + 0.07, oz).box(0.80, 0.14, 0.80, 0.03, 0);
            cap.at(ox, s.y + ch + 0.20, oz).box(0.54, 0.14, 0.54, 0.03, 0);
          }
        }
      }

      // A ladder hooked over the parapet, and a stack of spare sheeting leaning
      // on it. Both cross the parapet line, which is the point.
      if (r() < 0.5) {
        const side = (r() * 2) | 0;
        const lz = side ? s.z0 + 0.34 : s.z1 - 0.34;
        const lx = s.x0 + 1.5 + r() * Math.max(0.1, w - 3);
        const ld = this.batch.at('ironThin', lx, lz);
        const top = s.y + 1.55;
        for (const sx2 of [-0.21, 0.21]) {
          ld.at(lx + sx2, s.y + 0.72, lz, 0, 0.13).box(0.05, 2.1, 0.05, 0.012, 0);
        }
        for (let q = 0; q < 6; q++) {
          ld.at(lx, s.y + 0.06 + q * 0.31, lz + (q * 0.31 - 0.8) * 0.13).box(0.46, 0.035, 0.035, 0.01, 0);
        }
        void top;
      }

      // Aerial masts: cheap, tall, and they break the parapet line. Two or
      // three per roof, guyed, because a single stick reads as an accident.
      const masts = 1 + ((r() * 2.5) | 0);
      for (let k = 0; k < masts; k++) {
        if (r() > 0.75) continue;
        const mx = cx + (r() - 0.5) * (w - 2), mz = cz + (r() - 0.5) * (d - 2);
        const m = this.batch.at('ironThin', mx, mz);
        const hh = 2.6 + r() * 3.2;
        m.at(mx, s.y + hh / 2, mz).cyl(0.05, 0.025, hh, 6, 0.01);
        for (let j = 0; j < 3; j++) {
          const a = (j / 3) * Math.PI * 2;
          m.at(mx, s.y + hh * (0.5 + j * 0.16), mz, a).box(0.8 - j * 0.16, 0.03, 0.03, 0.008, 0);
        }
        // Guy wires down to the deck.
        for (let j = 0; j < 3; j++) {
          const a = (j / 3) * Math.PI * 2 + 0.4;
          placeCable(this.kit, [mx, s.y + hh * 0.86, mz],
            [mx + Math.cos(a) * 1.5, s.y + 0.1, mz + Math.sin(a) * 1.5], 0.06, 0.012);
        }
      }

      // Washing strung between the aerials and the parapet. Nothing else on
      // this map puts a light, moving, high-value shape against the sky.
      if (w > 5 && d > 5 && r() < 0.6) {
        const t0 = s.z0 + 1.4 + r() * (d - 2.8);
        placeWashLine(this.kit, {
          x0: s.x0 + 0.9, z0: t0, x1: s.x1 - 0.9, z1: t0 + (r() - 0.5) * 2,
          y: s.y + 2.1, clear: s.y + 0.9, count: 2 + ((r() * 3) | 0),
          width: 1.0, sag: 0.22, seed: 300 + (t0 | 0), bucket: r() < 0.5 ? 'awning' : 'rug',
          posts: true, postBase: s.y, postBucket: 'ironThin', collide: false,
        });
      }
    }
    // Cables strung between roofs across the streets.
    const spans = [
      [[-16.2, 6.2, 20], [-5.2, 6.2, 22]], [[5.2, 6.2, 18], [16.2, 6.2, 16]],
      [[-16.2, 6.6, 34], [-5.2, 6.2, 36]], [[5.2, 6.2, 32], [16.2, 6.2, 34]],
      [[-16.2, 6.2, -18], [-5.2, 6.2, -17]], [[5.2, 6.2, -17], [16.2, 6.2, -18]],
      [[-33.2, 6.2, -20], [-26.2, 6.4, -18]], [[-33.2, 9.2, 4], [-26.2, 6.2, 6]],
    ];
    for (const [a, b] of spans) placeCable(this.kit, a, b, 1.2, 0.02);
  }

  /** Steel sleeper frame that lifts roof plant clear of the parapet coping. */
  _roofStand(x, y, z, w, d, h, ry = 0) {
    const b = this.batch.at('ironThin', x, z);
    b.at(x, y + h - 0.05, z, ry).box(w, 0.10, d, 0.02, 0);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.at(x + sx * (w / 2 - 0.09) * Math.cos(ry) - sz * (d / 2 - 0.09) * Math.sin(ry),
          y + h / 2,
          z - sx * (w / 2 - 0.09) * Math.sin(ry) - sz * (d / 2 - 0.09) * Math.cos(ry), ry)
          .box(0.09, h, 0.09, 0.018, 0);
      }
    }
    b.at(x, y + h * 0.35, z, ry).box(w - 0.1, 0.06, 0.06, 0.014, 0);
  }

  /* ----------------------------------------------------- foreground ----- */

  /**
   * Deliberate near-field occluders.
   *
   * Every reference frame from a shipped campaign has something inside four
   * metres of the camera — a beam, a hanging textile, a barrel, an arch soffit
   * — that is in shadow and frames the lit street behind it. It does three
   * jobs at once: it gives the eye a true black to measure the midtones
   * against, it creates the foreground layer the composition otherwise lacks,
   * and it hides the horizon line that makes a box arena read as a box.
   *
   * Nothing here narrows a lane below its designed width or blocks a sightline
   * that gameplay depends on: the spans and the textiles all clear 2.35 m, the
   * arches spring above head height, and the ground clutter sits against the
   * kerbs rather than in the running line.
   */
  _dressForeground() {
    const r = this.rand;

    /* --- the market street: the shot the camera spends most of its time in.
     * Spans, an arch, wash lines and kerbside clutter, staggered so that from
     * any point on the street there is something within four metres and
     * something else at fifteen. */
    // Every one of these has to land where BOTH facades exist: the centre
    // blocks are 14..28 / 31..44 on the west and 14..26 / 29..44 on the east,
    // and a beam springing into the gap between them floats.
    for (const [z, joists, deck] of [[31.4, 3, 0], [22.8, 2, 0.22], [17.6, 3, 0]]) {
      placeSpan(this.kit, {
        x0: -4.86, z0: z, x1: 4.86, z1: z, y: 2.72, depth: 0.30, width: 0.22,
        joists, deck, deckOffset: 0.12,
      });
    }
    // Segmental arch over the street: it springs off both facades at 3.2 m, so
    // it costs nothing in width and puts a dark soffit across the top third of
    // every southbound frame.
    archway(this.kit, {
      x: 0, y: 0, z: 25.0, yaw: 0, span: 9.8, rise: 1.55, springY: 3.2,
      thickness: 0.46, depth: 0.5, bucket: 'brick',
    });
    // Market gate at the plaza mouth: two piers and a lintel, which frames the
    // plaza and the hall behind it instead of letting them sit in open space.
    for (const s of [-1, 1]) {
      pillar(this.kit, { x: s * 4.45, z: 15.3, height: 4.3, size: 0.85, bucket: 'brick' });
    }
    const gt = this.batch.at('plasterWarm', 0, 15.3);
    gt.at(0, 4.55, 15.3).box(10.2, 0.5, 1.1, 0.05, [3, 1]);
    gt.at(0, 4.92, 15.3).box(10.7, 0.24, 1.4, 0.04, 0);
    this.proxy.extent(-5.2, 4.3, 14.75, 5.2, 5.05, 15.85);
    placeSign(this.kit, { x: 0, y: 3.75, z: 14.72, width: 3.6, height: 0.7, yaw: Math.PI });

    for (const [z, sd] of [[32.6, 71], [20.4, 73], [35.4, 75]]) {
      placeWashLine(this.kit, {
        x0: -4.7, z0: z, x1: 4.7, z1: z + 0.6, y: 4.35, clear: 2.42,
        count: 4, width: 1.55, sag: 0.34, seed: sd,
        bucket: sd % 2 ? 'rug' : 'awning',
      });
    }
    // Kerbside clutter: dark mass low in frame, hard against the buildings so
    // the running line down the middle of the street stays clear.
    for (const [x, z, kind, yaw] of [
      [-4.05, 32.6, 'barrel', 0.3], [-3.55, 33.3, 'barrel', 1.1], [-4.15, 34.1, 'crateWoodBig', 0.6],
      [4.05, 30.2, 'jersey', Math.PI / 2], [4.10, 27.9, 'jersey', Math.PI / 2],
      [-4.20, 25.6, 'crateWoodBig', 0.2], [-4.20, 25.6, 'crateWood', 1.4],
      [4.15, 22.4, 'barrel', 0.8], [3.65, 22.9, 'barrel', 2.0],
      [-4.10, 19.4, 'jersey', Math.PI / 2], [4.20, 17.2, 'crateWoodBig', 0.9],
    ]) {
      this._prop(kind, x, kind === 'crateWood' ? 0.86 : 0, z, yaw);
    }
    this._prop('pipes', -4.3, 0, 36.6, 0.02);
    this._prop('tyre', 4.3, 0.0, 35.0, 0.4);
    this._prop('tyre', 4.3, 0.14, 35.1, 1.4);
    this._prop('pallet', -4.35, 0, 28.2, 1.55);
    this._prop('pallet', -4.35, 0.13, 28.3, 1.62);

    /* --- the plaza approach from the north, and the hall's north face. */
    placeWashLine(this.kit, {
      x0: -6.6, z0: 11.4, x1: 6.6, z1: 11.0, y: 4.1, clear: 2.5,
      count: 5, width: 1.5, sag: 0.3, seed: 81, bucket: 'awning', posts: true,
    });
    for (const [x, z, yaw] of [[-2.9, 10.6, 0.1], [3.1, 10.0, -0.2]]) {
      this._prop('jersey', x, 0, z, yaw + Math.PI / 2);
    }
    placeStall(this.kit, {
      x: -6.6, z: 11.6, yaw: -0.4, width: 2.6, depth: 1.8,
      clothBucket: 'awningRed', seed: 811,
    });

    /* --- the plaza's north-east quarter, looked at from the yard side. */
    placeStall(this.kit, {
      x: 5.2, z: 5.4, y: 1.62, yaw: -Math.PI * 0.75, width: 2.6, depth: 1.8,
      clothBucket: 'awning', seed: 823,
    });
    this._fixtures.push({
      pos: placeLamp(this.kit, { x: 8.2, y: 4.4, z: 8.2, yaw: -2.4, style: 'bracket' }),
      color: 0xffb469, intensity: 8, radius: 10, priority: 4,
    });
    const pg = this.batch.at('timber', 12.5, 12.5);
    // A pergola over the plaza corner — one more overhead plane between the
    // camera and the sky in the shot that looks up into the sun.
    for (const sx of [-1, 1]) {
      pg.at(12.6 + sx * 1.9, 1.4, 12.6 - sx * 1.9).box(0.16, 2.8, 0.16, 0.03, 0);
    }
    pg.at(12.6, 2.85, 12.6, -Math.PI / 4).box(5.4, 0.16, 0.18, 0.03, 0);
    for (let i = 0; i < 6; i++) {
      pg.at(12.6 - 2.0 + i * 0.8, 2.98, 12.6 + 2.0 - i * 0.8, -Math.PI / 4)
        .box(0.10, 0.10, 2.4, 0.02, 0);
    }
    this.proxy.box(12.6 + 1.9, 1.4, 12.6 - 1.9, 0.28, 2.8, 0.28);
    this.proxy.box(12.6 - 1.9, 1.4, 12.6 + 1.9, 0.28, 2.8, 0.28);

    /* --- the alley: it already had awnings, but nothing at the near end of
     * the northbound view. */
    // West side of the alley is the west row (16..32, -5..12, -24..-8); east
    // side is the V row (26..44, 2..20) and the souk house (-22..-2).
    for (const z of [26.0, 30.5, 8.0, -18.0]) {
      placeSpan(this.kit, {
        x0: -32.85, z0: z, x1: -26.15, z1: z, y: 2.68, depth: 0.26, width: 0.20,
        joists: 2, deck: z > 0 ? 0.3 : 0, deckOffset: -0.1,
      });
    }
    for (const [z, sd] of [[28.5, 91], [10.5, 93], [-16.0, 95]]) {
      placeWashLine(this.kit, {
        x0: -32.7, z0: z, x1: -26.3, z1: z + 0.5, y: 4.2, clear: 2.4,
        count: 3, width: 1.5, sag: 0.3, seed: sd, bucket: sd % 2 ? 'rug' : 'awning',
      });
    }
    awning(this.kit, {
      x: -32.1, z: 30.0, width: 3.0, depth: 2.0, yaw: Math.PI / 2,
      height: 2.8, drop: 0.45, posts: true, clothBucket: 'awningRed',
    });
    this._prop('barrel', -32.2, 0, 34.4, 0.5);
    this._prop('barrel', -31.7, 0, 34.9, 1.6);
    this._prop('crateWoodBig', -32.3, 0, 27.4, 0.3);

    /* --- the souk house interior: two timber posts under the mezzanine, a
     * rug on the rail, and goods stacked into the near corner. Interiors are
     * where the 0-4 m band matters most, because there is no distance to fall
     * back on. */
    const post = this.batch.at('timber', -22, -6);
    for (const [px, pz] of [[-22.7, -6.4], [-19.2, -3.4]]) {
      post.at(px, 1.55, pz).box(0.22, 3.1, 0.22, 0.03, [3, 1.4]);
      post.at(px, 3.02, pz).box(0.52, 0.16, 0.52, 0.03, 0);
      post.at(px, 2.86, pz).box(0.34, 0.20, 0.34, 0.025, 0);
      this.proxy.box(px, 1.55, pz, 0.3, 3.1, 0.3);
    }
    for (let i = 0; i < 3; i++) {
      placeHangingRug(this.kit, {
        x: -22.0 + i * 1.9, z: -9.05, yaw: 0, width: 1.5, height: 1.7,
        top: 3.15, phase: i * 2.2,
      });
    }
    this._prop('crateWoodBig', -23.6, 0, -5.4, 0.5);
    this._prop('crateWood', -23.5, 0.86, -5.3, 1.1);
    this._prop('barrel', -22.6, 0, -4.2, 0.2);
    // A shelf rack against the west wall with goods on it: the north half of
    // the interior had bare plaster from the floor to the mezzanine.
    const rack = this.batch.at('timber', -25, -6);
    for (let i = 0; i < 4; i++) {
      rack.at(-25.25, 0.42 + i * 0.66, -6.4).box(0.62, 0.055, 5.0, 0.014, 0);
    }
    for (const z of [-8.6, -6.4, -4.2]) rack.at(-25.5, 1.42, z).box(0.08, 2.6, 0.5, 0.018, 0);
    this.proxy.box(-25.3, 1.3, -6.4, 0.7, 2.6, 5.0);
    const goods = this.batch.at('sack', -25, -6);
    for (let i = 0; i < 12; i++) {
      goods.at(-25.2 + (r() - 0.5) * 0.2, 0.52 + ((i % 4) | 0) * 0.66,
        -8.6 + r() * 4.4, r() * 3.14).box(0.34, 0.22, 0.30, 0.08);
    }
    for (let i = 0; i < 4; i++) {
      goods.at(-24.4 + r() * 0.6, 0.19, -3.4 + r() * 1.6, r() * 3.14).box(0.46, 0.38, 0.42, 0.13);
    }

    /* --- the garage mouth, looked into from the plaza side. */
    placeSpan(this.kit, {
      x0: 18.3, z0: -6.4, x1: 18.3, z1: 2.4, y: 2.78, depth: 0.30, width: 0.24,
      joists: 2, bucket: 'ironwork',
    });
    for (let i = 0; i < 4; i++) this._prop('tyre', 18.5 + (i % 2) * 0.18, 0.14 * i, -4.9, i * 0.9);
    this._prop('crateMetal', 18.0, 0, 1.6, 0.4);
    this._prop('barrel', 17.4, 0, -6.2, 0.9);

    /* --- both spawn frontages, so the very first frame of a life has depth. */
    for (const [z, yaw] of [[-38.6, 0], [38.6, Math.PI]]) {
      placeSpan(this.kit, {
        x0: -4.9, z0: z, x1: 4.9, z1: z, y: 2.75, depth: 0.28, width: 0.22, joists: 2,
      });
      void yaw;
    }
    for (const [x, z] of [[-4.2, -40.2], [4.2, -39.4], [-4.2, 40.0], [4.2, 41.2]]) {
      this._prop(r() < 0.5 ? 'barrel' : 'crateWoodBig', x, 0, z, r() * 3.14);
    }

    /* --- the long cross-street: two spans between the block corners so the
     * 74 m sightline is layered rather than empty. */
    for (const [x, z0, z1] of [[-21.0, -22.1, -29.9], [22.0, -21.1, -30.9]]) {
      placeSpan(this.kit, {
        x0: x, z0, x1: x, z1, y: 3.0, depth: 0.30, width: 0.24, joists: 2,
        bucket: 'ironwork',
      });
    }
  }

  /* -------------------------------------------------------- foliage ----- */

  _buildFoliage() {
    const d = this.detail;
    if (d === 0) return;
    this.foliage = new Foliage().build(this.materials.timber, { windAmp: 0.17 });
    const r = this.rand;

    // A walled garden pocket in the north-east, and singles along the streets.
    const palms = [
      [20.0, 39.6, 7.4], [23.6, 42.2, 8.6], [18.6, 42.6, 6.6],
      [-19.5, 23.0, 7.8], [-11.8, -12.0, 6.9], [11.8, -12.0, 7.6],
      [-11.8, 12.0, 8.2], [14.4, 12.0, 7.1],
      [33.5, 40.5, 8.0], [-30.0, -34.0, 6.4],
      // Now that crowns cast a real cutout shadow, a palm is worth putting
      // where its shadow lands on something the player looks at: across the
      // market street, over the plaza kerb, and against the yard's long wall.
      [-4.6, 30.4, 7.9], [4.6, 23.2, 7.2], [-4.5, 18.6, 8.4],
      [15.4, -13.4, 7.6], [-15.2, -13.6, 7.0],
      [37.2, -8.0, 8.2], [37.4, 14.0, 7.4], [-37.0, 6.0, 7.6],
      // Two behind the north gate: from the south end of the market street the
      // gate frames 6 m of spawn frontage and then a blank 5.6 m perimeter
      // wall, and a crown at 9 m is the cheapest thing that breaks it.
      [-7.2, 43.0, 8.6], [6.8, 43.6, 9.2],
      [-7.0, -42.4, 8.4], [7.4, -42.0, 8.0],
    ];
    for (const [x, z, hgt] of palms) {
      this.foliage.addPalm(x, z, hgt, r() * Math.PI * 2, (r() - 0.5) * 0.2);
      this.proxy.box(x, hgt * 0.5, z, 0.44, hgt, 0.44);
    }
    const scrubCount = d >= 2 ? 96 : 44;
    const foot = this._foot || [];
    for (let i = 0; i < scrubCount; i++) {
      // Scrub grows where nobody walks: against walls and in corners.
      const edge = r();
      let x, z;
      if (edge < 0.22) { x = -39.0 + r() * 1.6; z = -44 + r() * 88; }
      else if (edge < 0.44) { x = 38.0 + r() * 1.6; z = -44 + r() * 88; }
      else if (edge < 0.56) { x = -38 + r() * 76; z = -45.0 + r() * 1.6; }
      else if (edge < 0.68) { x = -38 + r() * 76; z = 43.4 + r() * 1.6; }
      else if (foot.length) {
        // Against a building base, in the dead 400 mm nobody's capsule reaches.
        const f = foot[(r() * foot.length) | 0];
        const side = (r() * 4) | 0;
        const t = 0.1 + r() * 0.8;
        const off = 0.35 + r() * 0.55;
        if (side === 0) { x = f[0] + (f[2] - f[0]) * t; z = f[1] - off; }
        else if (side === 1) { x = f[0] + (f[2] - f[0]) * t; z = f[3] + off; }
        else if (side === 2) { x = f[0] - off; z = f[1] + (f[3] - f[1]) * t; }
        else { x = f[2] + off; z = f[1] + (f[3] - f[1]) * t; }
      } else { x = -38 + r() * 76; z = -44 + r() * 88; }
      this.foliage.addScrub(x, z, 0.8 + r() * 0.7, r() * 3.14);
    }
    // Raised bed in the garden pocket — 0.56 m, so it is a step, not an
    // obstacle, and it gives the palms somewhere to be planted.
    const pl = this.batch.at('brick', 21, 41);
    pl.at(21.0, 0.20, 41.0).box(7.6, 0.40, 5.6, 0.05, 1.6);
    this.proxy.extent(17.2, 0, 38.2, 24.8, 0.40, 43.8);
    const fol = this.foliage.flush();
    this.root.add(fol);
    // The palms and scrub are InstancedMeshes the Foliage kit owns, but they
    // are level geometry and they cast and receive like everything else. They
    // used to be missing from the ledger, which under-reported the level by
    // three meshes and fifteen shadow draws.
    this._foliageMeshes = fol.children.filter((c) => c.isMesh);
  }

  /* ---------------------------------------------------------- lighting -- */

  /**
   * Static interior lights. These are added once, before the first frame, so
   * they are folded into every lit program's NUM_POINT_LIGHTS at compile time
   * and never trigger a recompile — the same reason DynamicLights pre-allocates
   * its pool. The count is a per-fragment cost, so it is tiered.
   */
  _buildLights(engine) {
    // Kept small on purpose: LightingModule already holds a pool of 6 dynamic
    // point lights, and NUM_POINT_LIGHTS is one loop over every lit fragment on
    // screen. Four here plus that pool is ten, which is about where the cost
    // stops being free. Fixtures that lose the draw still render their emissive
    // housing, so the lamp reads as a lamp even when it is not casting.
    const budget = { 0: 0, 1: 2, 2: 4, 3: 6 }[this.detail] ?? 2;
    const picks = this._fixtures.slice().sort((a, b) => a.priority - b.priority).slice(0, budget);
    for (const f of picks) {
      const l = new THREE.PointLight(f.color, f.intensity, f.radius, 2);
      l.position.set(f.pos[0], f.pos[1], f.pos[2]);
      l.castShadow = false;
      l.name = 'LevelFixture';
      this.root.add(l);
      this._lights.push(l);
    }
    void engine;
  }

  /* ------------------------------------------------------------ spawns -- */

  /**
   * Tactical waypoints: lane midpoints, connector mouths, interior rooms and
   * the three elevated positions. Additive export — nothing in the level uses
   * it, it exists so AI patrol/objective logic has somewhere sane to go.
   */
  _placeNavPoints() {
    const P = [
      [-29.5, -34], [-29.5, -14], [-29.5, 4], [-29.5, 24], [-29.5, 38],
      [0, -36], [0, -24], [0, -18], [0, 12], [0, 20], [0, 30], [0, 38],
      [-12.5, -34], [-12.5, -8], [12.5, -34], [12.5, -8],
      [-13, 6], [13, 6], [-13, -8], [13, -8], [0, 0, 1.7],
      [34, -36], [34, -20], [34, -4], [34, 8], [34, 24], [34, 38],
      [-21, -17], [-21, -6], [-21, 0], [22, -3], [22, 4], [26, 0, 2.9],
      [-15, -5, 3.2], [0, 6, 5.8], [-36, 24, 6.4], [-21, 30, 6.4],
      [21, 41], [-20, 23],
    ];
    this.navPoints = P.map(([x, z, y]) => new THREE.Vector3(x, y ?? 0.1, z));
  }

  _placeSpawns() {
    // Five per team, spread across all three lanes so a spawn camp has to
    // cover 60 m of frontage.
    const south = [[-29.5, -41.5], [-20.0, -44.0], [0.0, -42.5], [11.0, -44.0], [33.0, -41.0]];
    const north = [[-29.5, 41.5], [-20.0, 43.5], [0.0, 42.5], [11.0, 43.5], [33.0, 41.0]];
    for (const [x, z] of south) {
      this.spawnPoints.push({ position: new THREE.Vector3(x, 0.1, z), yaw: Math.PI, team: SOUTH });
    }
    for (const [x, z] of north) {
      this.spawnPoints.push({ position: new THREE.Vector3(x, 0.1, z), yaw: 0, team: NORTH });
    }
  }

  /* ------------------------------------------------------------ finish -- */

  _finalise(engine) {
    // Merged prop kinds must land in their buckets while the batcher is still
    // open, so the instance pool is resolved first.
    const instMeshes = this.inst.flush(this.root, this.batch);
    const meshes = this.batch.flush(this.root);

    // NOT WIRED UP. `sealDeadCracks` (src/level/SealCracks.js) is written and
    // it runs, reporting "149 dead cracks, 135.2 m2, 314 boxes" — but it does
    // not do the job: dropping the player into each of the five cracks the
    // probe names shows all five still enterable. It is selecting a set of
    // narrow cells that does not contain the reported ones, and until that is
    // understood it would add 314 collision boxes to the bullet and capsule
    // BVH in exchange for nothing. The analysis is kept, the cost is not paid.
    // See the header of SealCracks.js for the diagnosis so far.

    const collider = this.proxy.toMesh();
    engine.get('collision').build(collider);
    this.collider = collider;

    this.stats = this._budget([...meshes, ...instMeshes, ...(this._foliageMeshes || [])]);
    this._reportBudget();
  }

  /**
   * Triangle/draw-call ledger.
   *
   * The only number that matters for the frame is not the scene's triangle
   * count — it is what the renderer actually submits, which is the camera pass
   * plus one pass per shadow cascade. That is what `renderer.info` reports and
   * what the screenshot harness writes into its manifest.
   *
   * ROUND 3 — WHAT ACTUALLY DRIVES THE MULTIPLIER. This ledger used to charge
   * the cascade multiplier to `castShadow`, and that is not the rule this
   * renderer runs under. `RenderModule` selects `THREE.VSMShadowMap`, and
   * `WebGLShadowMap.renderObject` reads:
   *
   *     if ( object.castShadow || ( object.receiveShadow && type === VSMShadowMap ) )
   *
   * so under VSM a mesh is rendered into EVERY cascade if it casts *or*
   * receives — and `receiveShadow` defaults to true on every bucket, because a
   * surface that does not receive cannot be shadowed by anything. The whole map
   * was therefore being submitted 1 + 4 times regardless of its cast flags, and
   * turning casting off on a bucket bought exactly nothing.
   *
   * The model checks out against the harness to under 1%:
   *
   *   round 1  424k unique x 5                       = 2,122k   (manifest 2,122k)
   *   round 2  (607k - 31k backdrop) x 5 + 31k       = 2,914k   (manifest 2,939k)
   *
   * Two consequences drive every decision below. First, cutting triangles is
   * worth 5x, not 1x. Second — and this is where the map gets *better* rather
   * than thinner — geometry that neither casts nor receives costs 1x, so
   * anything that lives against the sky (rooflines, aerials, cables, rooftop
   * plant, thin steel) can carry five times the detail of anything sitting on a
   * wall. See `SKY` in `_defineBuckets`.
   */
  _budget(meshes) {
    const cascades = Config.gfx.shadowCascades ?? 4;
    const rows = [];
    let tris = 0, shadowTris = 0, shadowMeshes = 0, instTris = 0;
    for (const m of meshes) {
      const g = m.geometry;
      const proto = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      const count = m.isInstancedMesh ? m.count : 1;
      const n = proto * count;
      tris += n;
      if (m.isInstancedMesh) instTris += n;
      // THE RULE — see the note above `_budget`. Under VSM a mesh enters every
      // cascade if it casts OR receives.
      const inShadowPass = !!(m.castShadow || m.receiveShadow);
      if (inShadowPass) { shadowTris += n; shadowMeshes++; }
      rows.push({
        name: m.name, tris: n, proto, count,
        cast: !!m.castShadow, recv: !!m.receiveShadow, pass: inShadowPass,
      });
    }
    rows.sort((a, b) => b.tris - a.tris);
    return {
      cascades,
      rows,
      meshes: meshes.length,
      tris: Math.round(tris),
      instancedMeshes: meshes.filter((m) => m.isInstancedMesh).length,
      instancedTris: Math.round(instTris),
      casters: shadowMeshes,
      castTris: Math.round(shadowTris),
      submittedTris: Math.round(tris + shadowTris * cascades),
      submittedDraws: meshes.length + shadowMeshes * cascades,
      collisionTris: this.proxy.triangleCount,
      fixtures: this._lights.length,
    };
  }

  /**
   * Ranked ledger, printed once at boot. This exists because round 2 shipped a
   * 40% triangle regression that nobody could locate: the harness reports one
   * aggregate number, and an aggregate number cannot tell you that 42k of it
   * is sandbags or that 63k of it is bevels on window trim. Ranked, per mesh,
   * with the cast flag and the pass multiplier spelled out, it can.
   */
  _reportBudget() {
    const s = this.stats;
    const pad = (v, n) => String(v).padStart(n);
    const lines = [
      `[Level] Suq al-Hadid budget — ${s.meshes} meshes / ${(s.tris / 1000).toFixed(0)}k tris`,
      `        ${s.casters} meshes enter the shadow passes (cast OR receive, VSM),`
        + ` carrying ${(s.castTris / 1000).toFixed(0)}k tris at ${1 + s.cascades}x`,
      `        ${s.meshes - s.casters} are SKY (neither), carrying `
        + `${((s.tris - s.castTris) / 1000).toFixed(0)}k tris at 1x`,
      `        submitted at ${s.cascades} cascades: `
        + `${(s.submittedTris / 1000).toFixed(0)}k tris / ${s.submittedDraws} draws`,
      `        NOTE: ${(s.castTris * s.cascades / 1000).toFixed(0)}k of that is the shadow`
        + ' passes. Under VSM a receiver is drawn into every cascade even when it'
        + ' never casts; switching RenderModule off VSMShadowMap, or dropping'
        + ' Config.gfx.shadowCascades, is worth more than any geometry left here.',
      `        collision proxy ${s.collisionTris} tris, ${s.fixtures} fixtures`,
      '        ---- top 20 by submitted triangles ----',
    ];
    const ranked = s.rows.slice().sort(
      (a, b) => (b.tris * (b.pass ? 1 + s.cascades : 1)) - (a.tris * (a.pass ? 1 + s.cascades : 1)),
    );
    for (const r of ranked.slice(0, 20)) {
      const mult = r.pass ? 1 + s.cascades : 1;
      const tag = r.pass ? `x${mult} ${r.cast ? 'c' : '-'}${r.recv ? 'r' : '-'}` : ' x1 sky';
      lines.push(`        ${pad(Math.round(r.tris * mult), 8)}  ${tag}  `
        + `${pad(Math.round(r.tris), 7)}${r.count > 1 ? ` x${r.count}` : ''}  ${r.name}`);
    }
    console.info(lines.join('\n'));
  }

  update(dt) {
    this.foliage?.update(dt);
  }

  /**
   * Authored open space, for anything that needs a point on the map that is
   * not inside a building. Sampling uniformly inside `bounds` no longer works:
   * roughly half the footprint of this map is solid.
   *
   * FOR THE AI AGENT: `level.navPoints` is a hand-placed graph-free waypoint
   * list covering all three lanes, both cross connectors and the interiors —
   * patrolling between those will read far better than random wandering.
   */
  randomOpenPoint(rand = Math.random) {
    const r = OPEN_REGIONS[(rand() * OPEN_REGIONS.length) | 0];
    return new THREE.Vector3(
      r[0] + rand() * (r[2] - r[0]), 0.1, r[1] + rand() * (r[3] - r[1]),
    );
  }

  /** Random spawn for a team, biased away from `avoid` positions. */
  pickSpawn(team = 0, avoid = []) {
    const pool = this.spawnPoints.filter((s) => s.team === team);
    if (!pool.length) return { position: new THREE.Vector3(0, 1, 0), yaw: 0 };
    let best = pool[0], bestScore = -Infinity;
    for (const s of pool) {
      let score = Math.random() * 4;
      for (const a of avoid) score += s.position.distanceTo(a) * 0.1;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  dispose() {
    this.foliage?.dispose();
    this.root.traverse((o) => { o.geometry?.dispose?.(); });
    this.collider?.geometry.dispose();
    disposeWeathering();
  }
}
