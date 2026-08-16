/**
 * OWNER: sky / atmosphere agent.
 *
 * One physical atmosphere model, two evaluators.
 *
 * The model is single-scattering Rayleigh + Mie with an ozone absorption layer
 * (Bruneton/Nishita formulation, Bruneton 2017 coefficients). It is evaluated
 *   - on the GPU, by the GLSL emitted from `atmosphereGLSL()`, to bake the sky
 *     LUT / cloud / composite cubemaps, and
 *   - on the CPU, by `skyRadiance()` / `sunTransmittance()`, to derive the sun
 *     colour, the fog inscattering constants and the horizon gradient fit.
 *
 * Both evaluators share the constants in `ATMO`, and the GLSL is generated from
 * those same numbers, so the fog can never drift away from the sky it is
 * supposed to dissolve into. That is the whole point of this file: the horizon
 * seam is a data-consistency bug, so the data has exactly one source.
 *
 * Units are SI (metres). Radiometric units are arbitrary but consistent: `E0`
 * is the top-of-atmosphere solar irradiance expressed in the same units the
 * renderer uses for `DirectionalLight.intensity`, which is what keeps the sky,
 * the sun and the IBL on one exposure scale.
 */

export const ATMO = {
  /** Planet + atmosphere shell radii. */
  Rg: 6360e3,
  Rt: 6420e3,

  /** Rayleigh scattering coefficient at sea level (1/m), sRGB primaries. */
  betaR: [5.802e-6, 13.558e-6, 33.100e-6],
  Hr: 8000,

  /** Mie: scattering < extinction, i.e. aerosols absorb a little. */
  betaMs: 3.996e-6,
  betaMe: 4.440e-6,
  Hm: 1200,
  mieG: 0.76,

  /**
   * Ozone absorbs in the Chappuis band (peak ~600nm): it eats red and green
   * out of the multiply-scattered light and is the reason a clear zenith is
   * deep blue instead of the pale cyan a pure Rayleigh sky produces.
   * Profile approximated by a tent centred at 25km, half-width 15km.
   */
  betaO: [0.650e-6, 1.881e-6, 0.085e-6],
  ozoneCenter: 25000,
  ozoneWidth: 15000,

  /** Solar irradiance, in renderer light units (see file header). */
  E0: 8.5,

  /**
   * Isotropic multiple-scattering gain, per channel.
   *
   * Single scattering alone leaves the zenith about five times too dark: at low
   * sun elevations most of the light reaching the zenith has bounced two or
   * more times, and blue bounces far more often than red because it scatters
   * far more often. Rather than build Hillaire's multi-scatter LUT, each sample
   * gets a second, phase-free source term weighted by these gains, which are the
   * geometric series 1/(1-a) of the per-channel single-scatter albedo evaluated
   * over a zenith path. Cheap, energy-plausible, and it is what actually makes
   * the zenith read as deep saturated blue rather than near-black.
   */
  msGain: [1.55, 2.25, 3.35],

  /**
   * Planet-scale ground used to close the lower hemisphere of the bake. Matched
   * to the level's sand, because this hemisphere IS the bounce light every
   * downward-facing surface in the map receives through the IBL.
   */
  groundAlbedo: [0.300, 0.258, 0.196],
  /** Sky irradiance landing on that ground (not a radiance — divided by PI). */
  groundAmbient: [0.35, 0.50, 0.85],

  /** Angular radius of the solar disc: 0.2665 deg. */
  sunAngularRadius: 0.004654,

  /**
   * Boundary-layer haze — the shared truth behind both the fog and the horizon.
   *
   * Rayleigh and Mie extinction are ~1e-5 per metre, so over the few hundred
   * metres a map spans they do literally nothing: the physical atmosphere alone
   * would put the sky at radiance ~1.0 immediately above the horizon and bare
   * ground at ~0.2 immediately below it, drawing a hard dark band. Real ground
   * haze is dust and water vapour trapped in the first few tens of metres, three
   * orders of magnitude denser than clean air and far too thin to resolve in a
   * kilometre-stepped raymarch, so it is applied analytically instead — by the
   * sky bake to its ground hemisphere, and by the fog shader to world geometry.
   * Same numbers, same closed-form integral, therefore no seam.
   */
  haze: {
    density: 0.0065,
    scaleHeight: 26,
    baseHeight: 0,
  },

  /**
   * TIME OF DAY — deliberate art call.
   *
   * 14.5 degrees of elevation. Low enough that the sun rakes across the map:
   * shadows run ~4x an object's height, so every wall, crate and character
   * throws a long directional shape that describes the ground plane and gives
   * the frame its value structure. It is also low enough that ~4 air masses of
   * Rayleigh extinction turn the key light golden (see `sunTransmittance`)
   * while the sky fill stays blue — a warm key against a cool fill is the
   * cheapest, most reliable way to read "cinematic" rather than "tech demo".
   * Higher than golden-hour proper (~5 deg), because at 5 deg the sun is so
   * red and so weak that vertical surfaces facing away from it go colourless,
   * and a shooter needs readable targets in every direction.
   */
  sunElevationDeg: 14.5,
  /** Horizontal bearing, kept from the original blockout lighting direction. */
  sunBearing: [0.4936, -0.8697],

  /**
   * Radiance of the sun disc as baked into the sky cubemap.
   *
   * Physically this should be E0 / solidAngle ~= 1.25e5. It is clamped to a few
   * dozen instead, deliberately: the same cubemap is the IBL environment, and a
   * physically-bright disc would inject the sun's entire irradiance a second
   * time through the diffuse convolution, on top of the directional light.
   * At 70 the disc still blows through ACES to pure white (anything over ~16
   * clips) so it reads correctly, while contributing ~0.005 of irradiance to
   * the environment — under half a percent of the sun's real contribution.
   */
  sunDiscRadiance: 70.0,
};

/* -------------------------------------------------------------------------- */
/* CPU evaluator                                                              */
/* -------------------------------------------------------------------------- */

/** Densities (rayleigh, mie, ozone) at altitude h. */
function density(h) {
  const t = 1 - Math.abs(h - ATMO.ozoneCenter) / ATMO.ozoneWidth;
  return [
    Math.exp(-h / ATMO.Hr),
    Math.exp(-h / ATMO.Hm),
    t > 0 ? t : 0,
  ];
}

/** Far intersection with a sphere of radius R centred on the origin. */
function raySphereFar(ro, rd, R) {
  const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2];
  const c = ro[0] * ro[0] + ro[1] * ro[1] + ro[2] * ro[2] - R * R;
  const d = b * b - c;
  if (d < 0) return -1;
  return -b + Math.sqrt(d);
}

/** Nearest positive intersection, or -1. */
function raySphereNear(ro, rd, R) {
  const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2];
  const c = ro[0] * ro[0] + ro[1] * ro[1] + ro[2] * ro[2] - R * R;
  const d = b * b - c;
  if (d < 0) return -1;
  const t = -b - Math.sqrt(d);
  return t > 0 ? t : -1;
}

function opticalDepthToSpace(p, dir, steps) {
  if (raySphereNear(p, dir, ATMO.Rg) > 0) return null; // occluded by the planet
  const t = raySphereFar(p, dir, ATMO.Rt);
  const ds = t / steps;
  let odR = 0, odM = 0, odO = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * ds;
    const x = p[0] + dir[0] * s, y = p[1] + dir[1] * s, z = p[2] + dir[2] * s;
    const h = Math.hypot(x, y, z) - ATMO.Rg;
    const d = density(h);
    odR += d[0] * ds; odM += d[1] * ds; odO += d[2] * ds;
  }
  return [odR, odM, odO];
}

function transmittance(p, dir, steps = 8) {
  const od = opticalDepthToSpace(p, dir, steps);
  if (od === null) return [0, 0, 0];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] = Math.exp(-(ATMO.betaR[c] * od[0] + ATMO.betaMe * od[1] + ATMO.betaO[c] * od[2]));
  }
  return out;
}

/** Unit vector pointing from the world toward the sun. */
export function sunDirectionArray() {
  const e = (ATMO.sunElevationDeg * Math.PI) / 180;
  const c = Math.cos(e);
  return [ATMO.sunBearing[0] * c, Math.sin(e), ATMO.sunBearing[1] * c];
}

/**
 * Spectral transmittance of the whole atmosphere toward the sun, from the
 * ground. This IS the sun's colour: at 14.5 degrees the path is ~4 air masses,
 * which removes roughly 65% of the blue and 35% of the green.
 */
export function sunTransmittance(sunDir = sunDirectionArray()) {
  return transmittance([0, ATMO.Rg + 2, 0], sunDir, 24);
}

/**
 * Single-scattered sky radiance along `rd`, including the planet ground for
 * downward directions so the lower hemisphere of the IBL bake carries a real
 * bounce colour instead of black.
 */
export function skyRadiance(rd, sunDir = sunDirectionArray(), viewSteps = 20, lightSteps = 6) {
  const ro = [0, ATMO.Rg + 2, 0];
  const tG = raySphereNear(ro, rd, ATMO.Rg);
  const tMax = tG > 0 ? tG : raySphereFar(ro, rd, ATMO.Rt);
  const ds = tMax / viewSteps;

  const mu = rd[0] * sunDir[0] + rd[1] * sunDir[1] + rd[2] * sunDir[2];
  const phaseR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = ATMO.mieG;
  const phaseM =
    ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu))) /
    ((2 + g * g) * Math.pow(1 + g * g - 2 * g * mu, 1.5));

  let odR = 0, odM = 0, odO = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i < viewSteps; i++) {
    const s = (i + 0.5) * ds;
    const p = [ro[0] + rd[0] * s, ro[1] + rd[1] * s, ro[2] + rd[2] * s];
    const h = Math.hypot(p[0], p[1], p[2]) - ATMO.Rg;
    const d = density(h);
    odR += d[0] * ds; odM += d[1] * ds; odO += d[2] * ds;
    const tSun = transmittance(p, sunDir, lightSteps);
    for (let c = 0; c < 3; c++) {
      const tView = Math.exp(-(ATMO.betaR[c] * odR + ATMO.betaMe * odM + ATMO.betaO[c] * odO));
      const ms = ATMO.msGain[c] / (4 * Math.PI);
      const single = ATMO.betaR[c] * d[0] * ds * phaseR + ATMO.betaMs * d[1] * ds * phaseM;
      const multi = (ATMO.betaR[c] * d[0] * ds + ATMO.betaMs * d[1] * ds) * ms;
      sum[c] += (single + multi) * tView * tSun[c];
    }
  }

  const out = [sum[0] * ATMO.E0, sum[1] * ATMO.E0, sum[2] * ATMO.E0];

  if (tG > 0) {
    const p = [ro[0] + rd[0] * tG, ro[1] + rd[1] * tG, ro[2] + rd[2] * tG];
    const inv = 1 / Math.hypot(p[0], p[1], p[2]);
    const n = [p[0] * inv, p[1] * inv, p[2] * inv];
    const nl = Math.max(n[0] * sunDir[0] + n[1] * sunDir[1] + n[2] * sunDir[2], 0);
    const ts = transmittance([p[0] + n[0], p[1] + n[1], p[2] + n[2]], sunDir, lightSteps);
    for (let c = 0; c < 3; c++) {
      const tView = Math.exp(-(ATMO.betaR[c] * odR + ATMO.betaMe * odM + ATMO.betaO[c] * odO));
      const e = ATMO.E0 * ts[c] * nl + ATMO.groundAmbient[c];
      out[c] += (ATMO.groundAlbedo[c] * e) / Math.PI * tView;
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* GLSL emitter                                                               */
/* -------------------------------------------------------------------------- */

const f = (n) => (Number.isFinite(n) ? n.toExponential(6) : '0.0');
const v3 = (a) => `vec3(${f(a[0])}, ${f(a[1])}, ${f(a[2])})`;

/**
 * Emit the shared atmosphere GLSL. Provides:
 *   float aRayTop(vec3 ro, vec3 rd)           distance to the atmosphere shell
 *   float aRayGround(vec3 ro, vec3 rd)        nearest ground hit, or -1
 *   vec3  aTransmittance(vec3 p, vec3 dir)    p -> space, spectral
 *   vec3  aSky(vec3 ro, vec3 rd, vec3 sunDir, out vec3 tr)
 */
export function atmosphereGLSL({ viewSteps = 24, lightSteps = 6 } = {}) {
  return /* glsl */`
#ifndef A_PI
#define A_PI 3.141592653589793
#endif
#define A_RG   ${f(ATMO.Rg)}
#define A_RT   ${f(ATMO.Rt)}
#define A_HR   ${f(ATMO.Hr)}
#define A_HM   ${f(ATMO.Hm)}
#define A_MIE_G ${f(ATMO.mieG)}
#define A_E0   ${f(ATMO.E0)}
const vec3  A_BETA_R  = ${v3(ATMO.betaR)};
const float A_BETA_MS = ${f(ATMO.betaMs)};
const float A_BETA_ME = ${f(ATMO.betaMe)};
const vec3  A_BETA_O  = ${v3(ATMO.betaO)};
const vec3  A_GROUND_ALBEDO = ${v3(ATMO.groundAlbedo)};
const vec3  A_GROUND_AMBIENT = ${v3(ATMO.groundAmbient)};
const vec3  A_MS_GAIN = ${v3(ATMO.msGain)};

#define A_HAZE_DENSITY ${f(ATMO.haze.density)}
#define A_HAZE_FALLOFF ${f(1 / ATMO.haze.scaleHeight)}
#define A_HAZE_BASE ${f(ATMO.haze.baseHeight)}

// Closed-form optical depth through the exponential boundary layer. Shared,
// verbatim, with the fog chunk in AtmosphericFog.js.
float aHazeFactor(float camY, float dirY, float dist){
  float y0 = (camY - A_HAZE_BASE) * A_HAZE_FALLOFF;
  float dy = dirY * A_HAZE_FALLOFF;
  float path = abs(dy) > 1e-6
    ? (exp(-y0) - exp(-y0 - dy * dist)) / dy
    : exp(-y0) * dist;
  return 1.0 - exp(-A_HAZE_DENSITY * max(path, 0.0));
}

// Spectral transmittance of a finite segment running from altitude y0 to y1,
// flat-earth closed form of the exponential density. This is what makes aerial
// perspective on distant objects warm instead of merely faint: blue is
// scattered out ~6x faster than red, so a cloud bank 60km away goes amber.
vec3 aSegmentTransmittance(float y0, float y1, float dirY, float dist){
  float ay = max(abs(dirY), 1e-4);
  float pr = (abs(dirY) > 1e-4)
    ? (A_HR / ay) * abs(exp(-y0 / A_HR) - exp(-y1 / A_HR))
    : dist * exp(-y0 / A_HR);
  float pm = (abs(dirY) > 1e-4)
    ? (A_HM / ay) * abs(exp(-y0 / A_HM) - exp(-y1 / A_HM))
    : dist * exp(-y0 / A_HM);
  return exp(-(A_BETA_R * min(pr, dist) + A_BETA_ME * min(pm, dist)));
}

float aRayTop(vec3 ro, vec3 rd){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - A_RT * A_RT;
  float d = b * b - c;
  return d < 0.0 ? 0.0 : (-b + sqrt(d));
}

float aRayGround(vec3 ro, vec3 rd){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - A_RG * A_RG;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  float t = -b - sqrt(d);
  return t > 0.0 ? t : -1.0;
}

// (rayleigh, mie, ozone) density at altitude h
vec3 aDensity(float h){
  return vec3(
    exp(-h / A_HR),
    exp(-h / A_HM),
    max(0.0, 1.0 - abs(h - ${f(ATMO.ozoneCenter)}) / ${f(ATMO.ozoneWidth)})
  );
}

vec3 aExtinction(vec3 od){
  return exp(-(A_BETA_R * od.x + A_BETA_ME * od.y + A_BETA_O * od.z));
}

vec3 aTransmittance(vec3 p, vec3 dir){
  if (aRayGround(p, dir) > 0.0) return vec3(0.0);
  float t = aRayTop(p, dir);
  float ds = t / float(${lightSteps});
  vec3 od = vec3(0.0);
  for (int i = 0; i < ${lightSteps}; i++){
    vec3 s = p + dir * (float(i) + 0.5) * ds;
    od += aDensity(length(s) - A_RG) * ds;
  }
  return aExtinction(od);
}

vec3 aSky(vec3 ro, vec3 rd, vec3 sunDir, out vec3 tr){
  float tG = aRayGround(ro, rd);
  float tMax = tG > 0.0 ? tG : aRayTop(ro, rd);
  float ds = tMax / float(${viewSteps});

  float mu = dot(rd, sunDir);
  float phaseR = 3.0 / (16.0 * A_PI) * (1.0 + mu * mu);
  float g = A_MIE_G;
  float phaseM = 3.0 / (8.0 * A_PI) * ((1.0 - g * g) * (1.0 + mu * mu)) /
                 ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));

  vec3 od = vec3(0.0);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${viewSteps}; i++){
    vec3 p = ro + rd * ((float(i) + 0.5) * ds);
    vec3 d = aDensity(length(p) - A_RG) * ds;
    od += d;
    vec3 tView = aExtinction(od);
    vec3 tSun = aTransmittance(p, sunDir);
    vec3 single = A_BETA_R * (d.x * phaseR) + A_BETA_MS * (d.y * phaseM);
    // Phase-free second term: see ATMO.msGain.
    vec3 multi = (A_BETA_R * d.x + A_BETA_MS * d.y) * (A_MS_GAIN / (4.0 * A_PI));
    sum += (single + multi) * tView * tSun;
  }
  tr = aExtinction(od);
  vec3 col = sum * A_E0;

  if (tG > 0.0){
    vec3 p = ro + rd * tG;
    vec3 n = normalize(p);
    vec3 ts = aTransmittance(p + n, sunDir);
    vec3 e = A_E0 * ts * max(dot(n, sunDir), 0.0) + A_GROUND_AMBIENT;
    col += A_GROUND_ALBEDO * e / A_PI * tr;
  }
  return col;
}
`;
}
