/**
 * OWNER: weapons agent.
 *
 * Weapon table. Every number here is a handling decision, so they are grouped
 * by what they change rather than alphabetically:
 *
 *   fire        cadence, magazine, reserve, burst behaviour
 *   ballistics  damage, falloff window, limb multipliers, penetration budget
 *   accuracy    hip/ADS cone, movement and stance penalties, first-shot model
 *   recoil      the spray pattern, the visual kick, and the recovery springs
 *   handling    ADS time, draw/holster/reload timings, sway and bob response
 *   model       proportions handed to the gunsmith
 *
 * The three weapons are deliberately far apart in feel: the carbine is the
 * neutral reference, the SMG trades range and precision for cadence and
 * handling speed, and the DMR trades everything for a single accurate shot.
 */

/** Per-limb damage multipliers, shared by every weapon unless overridden. */
export const LIMB = {
  head: 1.0,      // scaled by the weapon's own headshotMultiplier
  neck: 1.0,
  chest: 1.0,
  stomach: 0.9,
  arm: 0.78,
  leg: 0.72,
};

/**
 * How much material a bullet will go through, in metres of that surface, and
 * what fraction of its damage survives per centimetre. Keyed on the material
 * preset names TextureFactory publishes.
 */
export const PENETRATION = {
  glass:      { maxThickness: 0.10, lossPerCm: 0.02 },
  wood:       { maxThickness: 0.09, lossPerCm: 0.10 },
  canvas:     { maxThickness: 0.20, lossPerCm: 0.03 },
  sandbag:    { maxThickness: 0.05, lossPerCm: 0.55 },
  corrugated: { maxThickness: 0.04, lossPerCm: 0.09 },
  metal:      { maxThickness: 0.025, lossPerCm: 0.45 },
  plaster:    { maxThickness: 0.10, lossPerCm: 0.16 },
  brick:      { maxThickness: 0.05, lossPerCm: 0.55 },
  tile:       { maxThickness: 0.04, lossPerCm: 0.40 },
  concrete:   { maxThickness: 0.035, lossPerCm: 0.70 },
  asphalt:    { maxThickness: 0.03, lossPerCm: 0.80 },
  rubber:     { maxThickness: 0.06, lossPerCm: 0.25 },
  default:    { maxThickness: 0.04, lossPerCm: 0.50 },
};

export const WEAPONS = {
  /* ============================================================== carbine */
  rifle: {
    name: 'M4A1',
    slot: 1,
    class: 'assault',
    fireMode: 'auto',
    modes: ['auto', 'burst', 'semi'],
    rpm: 780,
    burstCount: 3,
    burstDelay: 0.19,

    damage: 33,
    headshotMultiplier: 2.1,
    magazine: 30,
    reserve: 210,
    muzzleVelocity: 880,
    falloffStart: 30,
    falloffEnd: 90,
    falloffMin: 0.55,
    penetrationPower: 1.0,       // scales every material's max thickness
    penetrationLayers: 2,

    spreadHip: 0.028,
    spreadAds: 0.0035,
    spreadMovePerMs: 0.0060,     // extra cone per m/s of horizontal speed
    spreadAirScale: 2.4,
    spreadCrouchScale: 0.72,
    spreadPerShot: 0.0026,       // bloom, decays with `spreadDecay`
    spreadMax: 0.055,
    spreadDecay: 3.6,
    /** First-shot accuracy: a settled weapon puts the first round on the pip. */
    fsa: { chargeTime: 0.42, spreadScale: 0.18, recoilScale: 0.55 },

    recoil: {
      vertical: 0.0125,          // radians of aim punch on shot 0
      horizontal: 0.0052,
      recovery: 7.5,             // aim-punch spring rate back toward rest
      recoverFraction: 0.82,     // how much of the punch the recovery reclaims
      kick: 0.028,               // visual-only model kick, decoupled from aim
      kickSpring: 210,
      kickDamp: 22,
      climbFalloff: 9,           // shot index at which vertical climb halves
      hDrift: [0.0, 0.10, 0.25, 0.55, 0.85, 0.55, -0.20, -0.85, -1.0, -0.7,
               -0.25, 0.35, 0.80, 1.0, 0.75, 0.25, -0.35, -0.80, -0.95, -0.6],
      resetTime: 0.32,
    },

    adsTime: 0.19,
    drawTime: 0.55,
    holsterTime: 0.34,
    reloadTime: 2.10,
    reloadEmptyTime: 2.75,
    swaySpring: 120, swayDamp: 17, swayScale: 1.0,
    bobScale: 1.0,
    adsSwayScale: 0.22,
    shellDelay: 0.028,
    optic: 'reddot',

    model: {
      length: 0.34, receiverW: 0.056, receiverH: 0.062,
      handguard: { len: 0.205, radius: 0.0245, slots: 4 },
      barrel: { len: 0.30, radius: 0.0098, fluted: false, gasBlock: true },
      muzzle: 'flashhider',
      stock: 'carbine',
      mag: { curve: 0.010, len: 0.135, width: 0.024, depth: 0.042 },
      grip: 'pistol',
      tint: 0x000000,
      seed: 91,
    },
  },

  /* ================================================================== SMG */
  smg: {
    name: 'MP7A2',
    slot: 2,
    class: 'smg',
    fireMode: 'auto',
    modes: ['auto', 'semi'],
    rpm: 1000,
    burstCount: 3,
    burstDelay: 0.16,

    damage: 24,
    headshotMultiplier: 1.75,
    magazine: 40,
    reserve: 240,
    muzzleVelocity: 720,
    falloffStart: 14,
    falloffEnd: 40,
    falloffMin: 0.42,
    penetrationPower: 0.6,
    penetrationLayers: 1,

    spreadHip: 0.021,
    spreadAds: 0.0052,
    spreadMovePerMs: 0.0030,     // barely punished for moving — that is its job
    spreadAirScale: 1.9,
    spreadCrouchScale: 0.80,
    spreadPerShot: 0.0021,
    spreadMax: 0.048,
    spreadDecay: 4.6,
    fsa: { chargeTime: 0.30, spreadScale: 0.30, recoilScale: 0.7 },

    recoil: {
      vertical: 0.0079,
      horizontal: 0.0061,
      recovery: 10.5,
      recoverFraction: 0.88,
      kick: 0.019,
      kickSpring: 260,
      kickDamp: 24,
      climbFalloff: 6,
      hDrift: [0.0, -0.20, -0.55, -0.90, -0.75, -0.25, 0.40, 0.85, 1.0, 0.80,
               0.30, -0.35, -0.85, -1.0, -0.70, -0.15, 0.50, 0.90, 0.85, 0.40],
      resetTime: 0.26,
    },

    adsTime: 0.14,
    drawTime: 0.42,
    holsterTime: 0.26,
    reloadTime: 1.72,
    reloadEmptyTime: 2.30,
    swaySpring: 150, swayDamp: 15, swayScale: 1.25,
    bobScale: 1.15,
    adsSwayScale: 0.30,
    shellDelay: 0.022,
    optic: 'reflex',

    model: {
      length: 0.235, receiverW: 0.050, receiverH: 0.056,
      handguard: { len: 0.088, radius: 0.0225, slots: 2 },
      barrel: { len: 0.155, radius: 0.0082, fluted: false, gasBlock: false },
      muzzle: 'compensator',
      stock: 'folding',
      mag: { curve: 0.004, len: 0.150, width: 0.022, depth: 0.030 },
      grip: 'pistol',
      foregrip: true,
      seed: 47,
    },
  },

  /* ================================================================== DMR */
  dmr: {
    name: 'SR-25 MK11',
    slot: 3,
    class: 'marksman',
    fireMode: 'semi',
    modes: ['semi'],
    rpm: 340,
    burstCount: 1,
    burstDelay: 0,

    damage: 72,
    headshotMultiplier: 2.6,
    magazine: 20,
    reserve: 120,
    muzzleVelocity: 840,
    falloffStart: 70,
    falloffEnd: 180,
    falloffMin: 0.80,
    penetrationPower: 2.2,
    penetrationLayers: 3,

    spreadHip: 0.052,            // punishing from the hip, by design
    spreadAds: 0.0004,
    spreadMovePerMs: 0.0135,
    spreadAirScale: 3.2,
    spreadCrouchScale: 0.55,
    spreadPerShot: 0.0042,
    spreadMax: 0.070,
    spreadDecay: 2.4,
    fsa: { chargeTime: 0.60, spreadScale: 0.05, recoilScale: 0.9 },

    recoil: {
      vertical: 0.0305,
      horizontal: 0.0075,
      recovery: 5.2,
      recoverFraction: 0.94,
      kick: 0.062,
      kickSpring: 150,
      kickDamp: 17,
      climbFalloff: 3,
      hDrift: [0.0, 0.55, -0.70, 0.85, -0.45, 0.30, -0.90, 0.65, -0.35, 0.80,
               -0.60, 0.25, -0.85, 0.70, -0.30, 0.55, -0.75, 0.40, -0.55, 0.85],
      resetTime: 0.55,
    },

    adsTime: 0.30,
    drawTime: 0.72,
    holsterTime: 0.44,
    reloadTime: 2.55,
    reloadEmptyTime: 3.25,
    swaySpring: 78, swayDamp: 19, swayScale: 0.72,
    bobScale: 0.85,
    adsSwayScale: 0.14,
    shellDelay: 0.035,
    optic: 'scope',
    scopeMagnification: 4.0,

    model: {
      length: 0.395, receiverW: 0.060, receiverH: 0.070,
      handguard: { len: 0.255, radius: 0.0265, slots: 6 },
      barrel: { len: 0.42, radius: 0.0125, fluted: true, gasBlock: true },
      muzzle: 'brake',
      stock: 'precision',
      mag: { curve: 0.014, len: 0.128, width: 0.026, depth: 0.052 },
      grip: 'pistol',
      seed: 23,
    },
  },
};

export const WEAPON_ORDER = ['rifle', 'smg', 'dmr'];

/**
 * Deterministic recoil pattern. Shot `i` of a spray always lands in the same
 * place — that is what makes a pattern learnable, and it is the difference
 * between a recoil system and a random-number generator.
 *
 * Vertical climb decays hyperbolically (the muzzle rises fast off the first
 * few rounds and then the rate flattens as the shooter's hold saturates);
 * horizontal follows the weapon's authored drift table, smoothly interpolated
 * and continued by a low-frequency continuation past the table's end.
 */
export function recoilAtShot(def, i) {
  const rc = def.recoil;
  const climb = rc.vertical * (rc.climbFalloff / (rc.climbFalloff + i));
  const tbl = rc.hDrift;
  let h;
  if (i < tbl.length - 1) {
    const f = i - Math.floor(i);
    h = tbl[Math.floor(i)] * (1 - f) + tbl[Math.floor(i) + 1] * f;
  } else {
    // Past the table the pattern keeps drifting on the same two frequencies
    // it was authored around, so long sprays stay deterministic and readable.
    h = Math.sin(i * 0.83) * 0.75 + Math.sin(i * 0.29 + 1.1) * 0.35;
  }
  return { v: climb, h: h * rc.horizontal };
}
