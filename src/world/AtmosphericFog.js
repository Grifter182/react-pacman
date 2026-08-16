import * as THREE from 'three';
import { ATMO, DUST_MAX_PATH } from './Atmosphere.js';

/**
 * OWNER: lighting / shadows agent.
 *
 * Replaces three's flat distance fog with height-density aerial perspective
 * whose inscattering colour is the sky's own colour in the view direction.
 *
 * Two bugs are being fixed here at once:
 *
 *  1. Flat grey fog. three's fog mixes toward a single constant, so geometry
 *     dissolves into a colour that exists nowhere in the sky. Here the fog
 *     evaluates a three-term fit of the baked sky — base horizon, zenith, and a
 *     Henyey-Greenstein lobe around the sun — so looking into the sun gives warm
 *     glowing haze and looking away gives cool blue haze, exactly like the
 *     background behind it.
 *
 *  2. The horizon seam. `scene.background` is a cubemap and cubemaps are not
 *     fogged, so distant geometry used to fade to grey while the sky above it
 *     stayed bright, drawing a visible line along the horizon. Because the fit
 *     is taken from the same atmosphere model that baked the cubemap, a fragment
 *     at infinity now converges on the sky pixel directly behind it, and the
 *     seam closes without ever touching the background pass.
 *
 * Density falls off exponentially with altitude and the extinction integral
 * along the view ray is solved in closed form, so the fog pools in the streets
 * and thins out above the rooftops instead of being a uniform soup.
 *
 * All constants are baked into the chunk source as literals. three clones each
 * material's uniform block, so a custom uniform cannot be shared scene-wide
 * without patching materials this module does not own; `fogColor` and
 * `fogDensity` remain real uniforms (three uploads them from `scene.fog`) and
 * stay live-tweakable.
 */

const _orig = {
  parsVertex: null,
  vertex: null,
  parsFragment: null,
  fragment: null,
};

const f = (n) => Number(n).toFixed(6);
const v3 = (a) => `vec3(${f(a[0])}, ${f(a[1])}, ${f(a[2])})`;

/**
 * @param {object}  opts
 * @param {object}  opts.fit            from SkyModule: { horizon, zenith, tint, gradientPow, mieG }
 * @param {number[]} opts.sunDir        world -> sun
 * @param {number}  opts.scaleHeight    metres; fog density e-folds over this
 * @param {number}  opts.baseHeight     world Y at which density is nominal
 * @returns {THREE.FogExp2}
 */
export function installAtmosphericFog({ fit, sunDir, density, scaleHeight = 26, baseHeight = 0 }) {
  if (_orig.parsVertex === null) {
    _orig.parsVertex = THREE.ShaderChunk.fog_pars_vertex;
    _orig.vertex = THREE.ShaderChunk.fog_vertex;
    _orig.parsFragment = THREE.ShaderChunk.fog_pars_fragment;
    _orig.fragment = THREE.ShaderChunk.fog_fragment;
  }

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorld;
#endif
`;

  // The view matrix is a rigid transform, so its inverse is its transpose plus
  // the camera position. Reconstructing the world position from mvPosition this
  // way works in every shader that includes this chunk — including sprites and
  // points, which never define `transformed` or `worldPosition` — and it picks
  // up skinning, morphing, instancing and batching for free.
  THREE.ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorld = cameraPosition + ( mvPosition.xyz * mat3( viewMatrix ) );
#endif
`;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG

	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorld;

	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif

	#define FOG_RAMP ${v3(fit.ramp)}
	#define FOG_BELT ${v3(fit.belt)}
	#define FOG_BROAD ${v3(fit.broad)}
	#define FOG_SUN_TINT ${v3(fit.tint)}
	#define FOG_SUN_DIR ${v3(sunDir)}
	#define FOG_GRADIENT_POW ${v3(fit.gradientPow)}
	#define FOG_MIE_G ${f(fit.mieG)}
	#define FOG_FALLOFF ${(1 / scaleHeight).toExponential(6)}
	#define FOG_BASE_Y ${f(baseHeight)}
	#define FOG_MIN_ELEV 0.004

	// Elevated dust band. Not part of the fit — it is a 1/sin(elevation)
	// profile, which a smooth five-term basis cannot represent without wrecking
	// the rest of the hemisphere. It is analytic and identical to the closed
	// form the sky bake uses (Atmosphere.js, ATMO.dust), so evaluating it here
	// reproduces the band exactly rather than approximating it, and geometry at
	// infinity still lands on the sky pixel behind it.
	#define FOG_DUST_DENSITY ${ATMO.dust.density.toExponential(6)}
	#define FOG_DUST_FALLOFF ${(1 / ATMO.dust.scaleHeight).toExponential(6)}
	#define FOG_DUST_G ${f(ATMO.dust.phaseG)}
	#define FOG_DUST_ISO ${f(ATMO.dust.iso)}
	#define FOG_DUST_REACH ${DUST_MAX_PATH.toExponential(6)}
	#define FOG_DUST_SUNLIT ${v3(ATMO.dust.sunlit)}
	#define FOG_DUST_AMBIENT ${v3(ATMO.dust.ambient)}

	float fogHG( const in float mu, const in float g ) {
		float gg = g * g;
		return ( 1.0 - gg ) / ( 12.566370614 * pow( max( 1.0 + gg - 2.0 * g * mu, 1e-4 ), 1.5 ) );
	}

	// Sky radiance in direction d — a five-term fit of the baked cubemap:
	// horizon + elevation ramp + mid-elevation belt + narrow Mie lobe on the sun
	// + broad hemispherical bias toward it, with the analytic dust band mixed
	// over the top. fogColor is the horizon term and stays a live uniform
	// (scene.fog.color).
	vec3 fogSkyColor( const in vec3 d ) {
		// Per-channel elevation exponent: red falls off within 30 degrees of the
		// horizon while blue is still climbing at 50. Clamped to the elevation of
		// the fit's lowest sample ring, so downward directions — the ground, which
		// is most of what a shooter's fog touches — evaluate to exactly the fitted
		// horizon instead of running off the bottom of the curve, where the ramp
		// and belt terms vanish and only the constant survives.
		float elev = clamp( d.y, FOG_MIN_ELEV, 1.0 );
		vec3 t = pow( vec3( elev ), FOG_GRADIENT_POW );
		float mu = dot( d, FOG_SUN_DIR );
		vec3 clean = max( fogColor + FOG_RAMP * t + FOG_BELT * ( t * ( 1.0 - t ) )
			+ FOG_SUN_TINT * fogHG( mu, FOG_MIE_G ) + FOG_BROAD * ( 0.5 + 0.5 * mu ), vec3( 0.0 ) );

		// Same closed-form path integral as aDustFactor(), at the same reach the
		// sky bake uses. Downward directions clamp to the horizon ring, so the
		// ground under the player fogs toward the dust band rather than toward a
		// colour that exists nowhere in the sky.
		float dy = elev * FOG_DUST_FALLOFF;
		float dustPath = ( 1.0 - exp( - dy * FOG_DUST_REACH ) ) / dy;
		float dustF = 1.0 - exp( - FOG_DUST_DENSITY * dustPath );
		vec3 dust = FOG_DUST_SUNLIT * ( fogHG( mu, FOG_DUST_G ) + FOG_DUST_ISO ) + FOG_DUST_AMBIENT;

		return mix( clean, dust, dustF );
	}

#endif
`;

  THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG

	#ifdef FOG_EXP2

		vec3 fogRay = vFogWorld - cameraPosition;
		float fogDist = length( fogRay );
		vec3 fogDir = fogRay / max( fogDist, 1e-4 );

		// Closed-form integral of rho(y) = exp( -(y - base) * k ) along the ray.
		float fogY0 = ( cameraPosition.y - FOG_BASE_Y ) * FOG_FALLOFF;
		float fogDy = fogDir.y * FOG_FALLOFF;
		float fogPath;
		if ( abs( fogDy ) > 1e-6 ) {
			fogPath = ( exp( - fogY0 ) - exp( - fogY0 - fogDy * fogDist ) ) / fogDy;
		} else {
			fogPath = exp( - fogY0 ) * fogDist;
		}

		float fogFactor = 1.0 - exp( - fogDensity * max( fogPath, 0.0 ) );
		vec3 fogInscatter = fogSkyColor( fogDir );

	#else

		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		vec3 fogInscatter = fogColor;

	#endif

	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogInscatter, fogFactor );

#endif
`;

  const fog = new THREE.FogExp2(0x000000, density);
  fog.color.setRGB(fit.horizon[0], fit.horizon[1], fit.horizon[2], THREE.LinearSRGBColorSpace);
  return fog;
}

export function uninstallAtmosphericFog() {
  if (_orig.parsVertex === null) return;
  THREE.ShaderChunk.fog_pars_vertex = _orig.parsVertex;
  THREE.ShaderChunk.fog_vertex = _orig.vertex;
  THREE.ShaderChunk.fog_pars_fragment = _orig.parsFragment;
  THREE.ShaderChunk.fog_fragment = _orig.fragment;
}
