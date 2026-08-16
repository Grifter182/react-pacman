import * as THREE from 'three';
import { makeMaterial } from '../materials/TextureFactory.js';
import { Config, QualityTier } from '../core/Config.js';

import { ProxySet, rng } from './kit/Geo.js';
import { Batcher, InstancePool } from './kit/Batcher.js';
import { applyWeathering, disposeWeathering } from './kit/Weathering.js';
import { Foliage } from './kit/Foliage.js';
import {
  SCALE, wall, building, roof, stairs, railing, pillar, column, archway, awning,
  windowFill, wallFrame,
} from './kit/Arch.js';
import {
  protoCrate, protoBarrel, protoSandbagWall, protoJersey, protoPallet, protoTyre,
  protoAcUnit, protoPipeBundle, protoRubble, protoBollard, protoWaterTank, protoDish,
  placeStall, placeVehicle, placeHangingRug, placeCable, placeSign, placeLamp, placeDebris,
} from './kit/Props.js';

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

    this._buildGround();
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
    this._dressStreets();
    this._dressRoofs();
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
  _buildMaterials() {
    const M = this.materials;
    const S = 512;

    M.sand = makeMaterial('sand', { seed: 11, size: S, worldScale: 3.2, macro: 0.55 });
    M.gravel = makeMaterial('gravel', { seed: 29, size: S, worldScale: 2.6 });
    M.asphalt = makeMaterial('asphalt', { seed: 47, size: S, worldScale: 3.0 });
    M.tile = makeMaterial('tile', { seed: 53, size: S, worldScale: 1.6, detailFade: [5, 20] });

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
  }

  _defineBuckets() {
    const M = this.materials;
    const b = this.batch;
    // uvScale must match the preset's worldScale, or the LOW tier — which
    // drops the triplanar path and falls back to these UVs — rescales.
    b.define('sand', M.sand, { uvScale: 3.2, castShadow: false });
    b.define('gravel', M.gravel, { uvScale: 2.6, castShadow: false });
    b.define('asphalt', M.asphalt, { uvScale: 3.0, castShadow: false });
    b.define('tile', M.tile, { uvScale: 1.6, castShadow: false });

    b.define('plaster', M.plaster, { uvScale: 2.0 });
    b.define('plasterWarm', M.plasterWarm, { uvScale: 2.0 });
    b.define('plasterPale', M.plasterPale, { uvScale: 2.0 });
    b.define('concrete', M.concrete, { uvScale: 2.4 });
    b.define('brick', M.brick, { uvScale: 2.0 });

    b.define('timber', M.timber, { uvScale: 2.2, weather: false });
    b.define('shutter', M.shutter, { uvScale: 2.2, weather: false, cells: false });
    b.define('metal', M.metal, { uvScale: 1.4, weather: false });
    b.define('ironwork', M.ironwork, { uvScale: 1.4, weather: false });
    b.define('corrugated', M.corrugated, { uvScale: 1.8, weather: false });
    b.define('sandbagM', M.sandbag, { uvScale: 1.2, weather: false, cells: false });
    b.define('glass', M.glass, { uvScale: 1.5, weather: false, cells: false, castShadow: false });
    b.define('tyre', M.rubber, { uvScale: 0.5, weather: false, cells: false });
    b.define('awning', M.awning, { uvScale: 0.6, weather: false });
    b.define('awningRed', M.awningRed, { uvScale: 0.6, weather: false });
    b.define('rug', M.rug, { uvScale: 0.6, weather: false, cells: false });
    b.define('sack', M.sack, { uvScale: 0.6, weather: false, cells: false });
    b.define('carpaint', M.carPaintA, { uvScale: 1.4, weather: false, cells: false });
    b.define('carpaintB', M.carPaintB, { uvScale: 1.4, weather: false, cells: false });
    b.define('chrome', M.chrome, { uvScale: 0.35, weather: false, cells: false });
    b.define('signage', M.signage, { uvScale: 1.4, weather: false, cells: false });
    b.define('emissive', M.emissive, { uvScale: 1.4, weather: false, cells: false, castShadow: false });
    b.define('rubblebits', M.concrete, { uvScale: 2.4 });
  }

  _defineProps() {
    const M = this.materials;
    const i = this.inst;
    i.define('crateWood', protoCrate(0.62), M.timber);
    i.define('crateWoodBig', protoCrate(0.86), M.timber);
    i.define('crateMetal', protoCrate(0.70), M.metal);
    i.define('barrel', protoBarrel(), M.metal);
    i.define('barrelBlue', protoBarrel(), M.polymer);
    // 7 courses ≈ 1.03 m (crouch cover), 10 ≈ 1.47 m (standing cover).
    i.define('sandbagLow', protoSandbagWall(7, 2.0, 3), M.sandbag);
    i.define('sandbagHigh', protoSandbagWall(10, 2.0, 8), M.sandbag);
    i.define('jersey', protoJersey(), M.concreteProp);
    i.define('pallet', protoPallet(), M.timber);
    i.define('tyre', protoTyre(), M.rubber);
    i.define('ac', protoAcUnit(), M.metal);
    i.define('pipes', protoPipeBundle(), M.metal);
    i.define('rubble', protoRubble(11), M.concreteProp);
    i.define('bollard', protoBollard(), M.concreteProp);
    i.define('tank', protoWaterTank(), M.polymer);
    i.define('dish', protoDish(), M.metal);
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
   * Flat inlay of a surface material, 20 mm proud of the base sand. Tessellated
   * so the ground carries a weathering field too — dirt pools where a paved
   * area meets a wall.
   */
  _pad(bucket, x0, z0, x1, z1, y = 0.02) {
    const g = this.batch.at(bucket, (x0 + x1) / 2, (z0 + z1) / 2);
    g.identity();
    g.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], 6);
    return g;
  }

  _buildGround() {
    // Base plane runs well past the play space so the horizon is not a void.
    const g = this.batch.at('sand', 0, 0);
    g.identity();
    g.quad([-140, 0, -140], [140, 0, -140], [140, 0, 140], [-140, 0, 140], 14);

    // Surface zoning. This is navigation feedback as much as art: the player
    // learns "asphalt = the open lane, tile = the plaza, gravel = the alley".
    this._pad('gravel', -34, -45, -25, 45);                   // alley
    this._pad('asphalt', 26.5, -45, 40, 45);                  // motor yard
    this._pad('asphalt', -34, -30.5, 40, -21.5);              // cross-street
    this._pad('tile', -17, -15, 17, 15);                      // plaza
    this._pad('gravel', -5.6, 14, 5.6, 45);                   // market street
    this._pad('gravel', -5.6, -45, 5.6, -15);                 // south street
    this._pad('asphalt', 16.2, -8.2, 28.2, 8.2, 0.03);        // garage slab

    // Kerbs around the plaza give the pad a real edge and a 0.14 m step.
    const kerb = this.batch.at('concrete', 0, 0);
    kerb.identity();
    for (const [x0, z0, x1, z1] of [
      [-17.2, -15.2, 17.2, -14.85], [-17.2, 14.85, 17.2, 15.2],
      [-17.2, -15.2, -16.85, 15.2], [16.85, -15.2, 17.2, 15.2],
    ]) {
      kerb.at((x0 + x1) / 2, 0.07, (z0 + z1) / 2).box(Math.abs(x1 - x0), 0.16, Math.abs(z1 - z0), 0.03, 2.5);
    }

    // One box under everything: the floor the capsule stands on.
    this.proxy.extent(-140, -1.0, -140, 140, 0, 140);
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
      interior: false,
    });
    this._roofSlots = this._roofSlots || [];
    this._roofSlots.push({ x0: o.x0, z0: o.z0, x1: o.x1, z1: o.z1, y: o.H });
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
    railing(this.kit, { x0: -32.8, z0: 12.9, x1: -32.8, z1: 17.1, y: 6.4, height: 1.05 });
    railing(this.kit, { x0: -40, z0: 17.1, x1: -32.8, z1: 17.1, y: 6.4, height: 1.05 });

    // Plank bridge, roof of W4 across the alley to the V row. Roof-to-roof
    // movement is what makes the alley worth holding from above.
    const bridge = this.batch.at('timber', -29.5, 30);
    for (let i = 0; i < 5; i++) {
      bridge.at(-29.5, 6.30, 28.4 + i * 0.42).box(7.6, 0.09, 0.36, 0.02, 0);
    }
    bridge.at(-29.5, 6.18, 28.4).box(7.6, 0.16, 0.16, 0.03, 0);
    bridge.at(-29.5, 6.18, 30.1).box(7.6, 0.16, 0.16, 0.03, 0);
    this.proxy.extent(-33.2, 6.05, 28.2, -25.8, 6.35, 30.3);
    railing(this.kit, { x0: -33.2, z0: 28.2, x1: -25.8, z1: 28.2, y: 6.35, height: 1.0, collide: false });
    railing(this.kit, { x0: -33.2, z0: 30.3, x1: -25.8, z1: 30.3, y: 6.35, height: 1.0, collide: false });
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
      y: H, bucket: 'concrete', trim: 'plasterPale', parapet: SCALE.parapet,
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
      y: roofY, bucket: 'concrete', trim: 'plasterPale', parapet: 0.95,
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
    railing(this.kit, { x0: 11.6, z0: 6.4, x1: 8.2, z1: 6.4, y: roofY, height: 1.05 });
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
      const n = Math.max(2, Math.round((w * d) / 42));
      for (let i = 0; i < n; i++) {
        const x = cx + (r() - 0.5) * (w - 2.6);
        const z = cz + (r() - 0.5) * (d - 2.6);
        const pick = r();
        if (pick < 0.34) this._prop('tank', x, s.y, z, r() * 3.14);
        else if (pick < 0.62) this._prop('ac', x, s.y, z, r() * 3.14);
        else if (pick < 0.82) this._prop('dish', x, s.y, z, r() * 3.14);
        else this._prop('crateMetal', x, s.y, z, r() * 3.14);
      }
      // A stair bulkhead on the larger roofs.
      if (w * d > 140 && r() < 0.7) {
        const bx = cx + (r() - 0.5) * (w - 4), bz = cz + (r() - 0.5) * (d - 4);
        const bl = this.batch.at('plasterPale', bx, bz);
        bl.at(bx, s.y + 1.15, bz).box(2.2, 2.3, 2.6, 0.05, 1.2);
        bl.at(bx, s.y + 2.36, bz).box(2.5, 0.16, 2.9, 0.04, 0);
        this.proxy.box(bx, s.y + 1.15, bz, 2.2, 2.3, 2.6);
      }
      // Aerial masts: cheap, tall, and they break the parapet line.
      if (r() < 0.6) {
        const mx = cx + (r() - 0.5) * (w - 2), mz = cz + (r() - 0.5) * (d - 2);
        const m = this.batch.at('ironwork', mx, mz);
        const hh = 2.2 + r() * 2.4;
        m.at(mx, s.y + hh / 2, mz).cyl(0.045, 0.025, hh, 6, 0.01);
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2;
          m.at(mx, s.y + hh * 0.62, mz, a).box(0.7, 0.03, 0.03, 0.008, 0);
        }
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
    ];
    for (const [x, z, hgt] of palms) {
      this.foliage.addPalm(x, z, hgt, r() * Math.PI * 2, (r() - 0.5) * 0.2);
      this.proxy.box(x, hgt * 0.5, z, 0.44, hgt, 0.44);
    }
    const scrubCount = d >= 2 ? 46 : 22;
    for (let i = 0; i < scrubCount; i++) {
      // Scrub grows where nobody walks: against walls and in corners.
      const edge = r();
      let x, z;
      if (edge < 0.3) { x = -39.0 + r() * 1.6; z = -44 + r() * 88; }
      else if (edge < 0.6) { x = 38.0 + r() * 1.6; z = -44 + r() * 88; }
      else if (edge < 0.8) { x = -38 + r() * 76; z = -45.0 + r() * 1.6; }
      else { x = -38 + r() * 76; z = 43.4 + r() * 1.6; }
      this.foliage.addScrub(x, z, 0.8 + r() * 0.7, r() * 3.14);
    }
    // Raised bed in the garden pocket — 0.56 m, so it is a step, not an
    // obstacle, and it gives the palms somewhere to be planted.
    const pl = this.batch.at('brick', 21, 41);
    pl.at(21.0, 0.20, 41.0).box(7.6, 0.40, 5.6, 0.05, 1.6);
    this.proxy.extent(17.2, 0, 38.2, 24.8, 0.40, 43.8);
    this.root.add(this.foliage.flush());
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
    const stats = this.batch.stats();
    const meshes = this.batch.flush(this.root);
    const instMeshes = this.inst.flush(this.root);

    const collider = this.proxy.toMesh();
    engine.get('collision').build(collider);
    this.collider = collider;

    let instTris = 0;
    for (const m of instMeshes) instTris += (m.geometry.getAttribute('position').count / 3) * m.count;

    this.stats = {
      staticMeshes: meshes.length,
      staticTris: stats.tris,
      instancedMeshes: instMeshes.length,
      instancedTris: Math.round(instTris),
      collisionTris: this.proxy.triangleCount,
      fixtures: this._lights.length,
    };
    console.info('[Level] Suq al-Hadid —',
      `${this.stats.staticMeshes} static meshes / ${(this.stats.staticTris / 1000).toFixed(0)}k tris,`,
      `${this.stats.instancedMeshes} instanced kinds / ${(this.stats.instancedTris / 1000).toFixed(0)}k tris,`,
      `collision ${this.stats.collisionTris} tris,`,
      `${this.stats.fixtures} fixtures`);
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
