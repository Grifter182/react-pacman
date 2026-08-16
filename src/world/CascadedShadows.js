import * as THREE from 'three';

/**
 * OWNER: lighting / shadows agent.
 *
 * Stabilised cascaded shadow maps for a single directional light.
 *
 * HOW IT WORKS
 * ------------
 * three.js gives a directional light exactly one shadow map, so a cascade rig
 * has to be N lights. The trap is that three multiplies every shadow-casting
 * light's occlusion into the same fragment: four cascade lights would each
 * shadow independently and a fragment covered by only one of them would come
 * out 3/4 lit. The fix — the same one three's own CSM addon uses — is to patch
 * the lighting chunk so the cascade lights are treated as one light:
 *
 *   - slots [0, N) of `directionalLights` are the cascades. They share a
 *     direction and a colour; only slot 0 shades, and it shades with the
 *     depth-weighted blend of every cascade's shadow term.
 *   - slots [N, ...) are ordinary directional lights and keep three's stock
 *     path, so another module adding a light still behaves.
 *
 * The split distances, blend bands and per-cascade depth probes are compile-time
 * constants baked straight into the generated GLSL. That is deliberate: three
 * clones a material's uniform block per material, so a custom uniform cannot be
 * shared across the scene without either a per-material patch or smuggling data
 * through a texture. The splits only depend on the camera's near/far and the
 * quality tier, none of which change per frame, so literals are both simpler and
 * faster. `rebuild()` regenerates them and invalidates programs if a tier change
 * ever makes that necessary.
 *
 * STABILISATION
 * -------------
 * Each cascade is fitted with the bounding SPHERE of its view-frustum slice, not
 * the AABB. A sphere is rotation invariant, so its radius never changes as the
 * player looks around — only its centre translates. The centre is then snapped
 * to whole shadow-map texels in light space, which quantises the projection to
 * the same grid the depth texture is sampled on. Together these are what stop
 * shadow edges from crawling and shimmering while the camera moves.
 */

const _up = /*@__PURE__*/ new THREE.Vector3(0, 1, 0);
const _alt = /*@__PURE__*/ new THREE.Vector3(0, 0, 1);

let _originalLightsChunk = null;
let _originalShadowChunk = null;

export class CascadedShadows {
  /**
   * @param {object} opts
   * @param {THREE.Scene}  opts.scene
   * @param {THREE.Vector3} opts.direction  world -> light (i.e. toward the sun)
   * @param {number} opts.count             cascade count
   * @param {number} opts.mapSize           per-cascade shadow map resolution
   * @param {number} opts.maxDistance       furthest shadowed distance, metres
   */
  constructor({
    scene,
    direction,
    count = 4,
    mapSize = 2048,
    maxDistance = 140,
    near = 0.6,
    lambda = 0.65,
    blendRatio = 0.11,
    worldBlur = 0.26,
    pcfTaps = 12,
    contactHardening = true,
  }) {
    this.scene = scene;
    this.direction = direction.clone().normalize();
    this.count = Math.max(1, Math.min(count, 4));
    this.mapSize = mapSize;
    this.maxDistance = maxDistance;
    this.near = near;
    this.lambda = lambda;
    this.blendRatio = blendRatio;
    this.worldBlur = worldBlur;
    this.pcfTaps = pcfTaps;
    this.contactHardening = contactHardening;

    this.lights = [];
    this.splits = [];
    this._radii = [];
    this._fov = -1;
    this._aspect = -1;
    this._patched = false;

    this._basisX = new THREE.Vector3();
    this._basisY = new THREE.Vector3();
    this._basisZ = new THREE.Vector3();
    this._centre = new THREE.Vector3();
    this._snapped = new THREE.Vector3();

    this._computeSplits();
    this._computeBasis();
  }

  /* ------------------------------------------------------------------ */
  /* setup                                                               */
  /* ------------------------------------------------------------------ */

  _computeSplits() {
    const n = this.near;
    const f = this.maxDistance;
    const c = this.count;
    this.splits.length = 0;
    for (let i = 0; i <= c; i++) {
      const p = i / c;
      // Practical split scheme (Zhang et al.): a logarithmic distribution keeps
      // texel density constant in screen space, a uniform one keeps the far
      // cascades from being uselessly thin. lambda blends the two.
      const log = n * Math.pow(f / n, p);
      const uni = n + (f - n) * p;
      this.splits.push(this.lambda * log + (1 - this.lambda) * uni);
    }
    this.splits[0] = n;
    this.splits[c] = f;
  }

  /**
   * Light-space basis, built exactly the way THREE.Matrix4.lookAt builds it so
   * that texel snapping happens in the same frame the shadow camera projects in.
   */
  _computeBasis() {
    const z = this._basisZ.copy(this.direction).normalize();
    const up = Math.abs(z.y) > 0.999 ? _alt : _up;
    this._basisX.copy(up).cross(z).normalize();
    this._basisY.copy(z).cross(this._basisX).normalize();
  }

  /** Bounding-sphere radius of the view frustum slice [n, f]. */
  _sliceRadius(n, f, fovDeg, aspect) {
    const tV = Math.tan((fovDeg * Math.PI) / 360);
    const tH = tV * aspect;
    const a2 = tV * tV + tH * tH;
    let zc = ((n + f) * (a2 + 1)) / 2;
    if (zc >= f) return f * Math.sqrt(a2);
    const dn = zc - n;
    return Math.sqrt(n * n * a2 + dn * dn);
  }

  /** Distance along the view axis of the slice's bounding-sphere centre. */
  _sliceCentreDistance(n, f, fovDeg, aspect) {
    const tV = Math.tan((fovDeg * Math.PI) / 360);
    const tH = tV * aspect;
    const a2 = tV * tV + tH * tH;
    const zc = ((n + f) * (a2 + 1)) / 2;
    return Math.min(zc, f);
  }

  build() {
    for (let i = 0; i < this.count; i++) {
      const light = new THREE.DirectionalLight(0xffffff, i === 0 ? 1 : 0);
      light.name = `SunCascade${i}`;
      light.castShadow = true;
      light.shadow.mapSize.set(this.mapSize, this.mapSize);
      light.shadow.autoUpdate = true;
      // Everything below is overwritten by update(); set sane values so the
      // first shadow render before the first update() is not degenerate.
      light.shadow.camera.left = -50;
      light.shadow.camera.right = 50;
      light.shadow.camera.top = 50;
      light.shadow.camera.bottom = -50;
      light.shadow.camera.near = 0.1;
      light.shadow.camera.far = 400;
      light.shadow.bias = -0.0005;
      light.shadow.normalBias = 0.02;
      light.shadow.radius = 2;
      light.shadow.intensity = 1;
      light.matrixAutoUpdate = true;
      this.scene.add(light);
      this.scene.add(light.target);
      this.lights.push(light);
    }
    this._patched = this.installShaderPatch();
    if (!this._patched && this.count > 1) {
      // Without the chunk patch every cascade would shadow independently and
      // the sun would be quartered. Degrade to one cascade rather than lie.
      console.warn('[CascadedShadows] shader patch failed; falling back to a single cascade');
      for (let i = 1; i < this.lights.length; i++) this.lights[i].castShadow = false;
    }
    return this;
  }

  /** The key light — the only cascade that actually shades. */
  get keyLight() { return this.lights[0]; }

  setSunColor(color, intensity) {
    for (let i = 0; i < this.lights.length; i++) {
      this.lights[i].color.copy(color);
      this.lights[i].intensity = i === 0 ? intensity : 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /* per-frame fit                                                       */
  /* ------------------------------------------------------------------ */

  update(camera) {
    if (camera.fov !== this._fov || camera.aspect !== this._aspect) {
      this._fov = camera.fov;
      this._aspect = camera.aspect;
      this._radii.length = 0;
      for (let i = 0; i < this.count; i++) {
        this._radii.push(this._sliceRadius(this.splits[i], this.splits[i + 1], camera.fov, camera.aspect));
      }
    }

    camera.updateMatrixWorld();

    for (let i = 0; i < this.count; i++) {
      const light = this.lights[i];
      const r = this._radii[i];
      const zc = this._sliceCentreDistance(this.splits[i], this.splits[i + 1], camera.fov, camera.aspect);

      // Slice centre in world space.
      this._centre.set(0, 0, -zc).applyMatrix4(camera.matrixWorld);

      // Snap to the shadow texel grid, in light space. Both the grid spacing
      // (2r / mapSize) and the basis are frame-invariant, so the quantisation
      // is stable and the shadow stops swimming under camera translation.
      const texelsPerUnit = this.mapSize / (2 * r);
      let px = this._centre.dot(this._basisX);
      let py = this._centre.dot(this._basisY);
      const pz = this._centre.dot(this._basisZ);
      px = Math.floor(px * texelsPerUnit) / texelsPerUnit;
      py = Math.floor(py * texelsPerUnit) / texelsPerUnit;
      this._snapped.set(0, 0, 0)
        .addScaledVector(this._basisX, px)
        .addScaledVector(this._basisY, py)
        .addScaledVector(this._basisZ, pz);

      // Pull the light far enough back that casters above the slice — towers,
      // gantries, anything between the slice and the sun — still render.
      const back = r + 160;
      light.position.copy(this._snapped).addScaledVector(this.direction, back);
      light.target.position.copy(this._snapped);
      light.target.updateMatrixWorld();

      const cam = light.shadow.camera;
      const depthRange = back + r + 8;
      if (cam.left !== -r || cam.far !== depthRange) {
        cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
        cam.near = 0.1;
        cam.far = depthRange;
        cam.updateProjectionMatrix();
      }

      // Per-cascade bias. Acne is a function of how much world space a texel
      // covers, so both biases scale with the texel footprint instead of being
      // one hand-tuned number that is wrong for three of the four cascades.
      const texelWorld = (2 * r) / this.mapSize;
      light.shadow.bias = -(1.4 * texelWorld + 0.015) / depthRange;
      light.shadow.normalBias = 1.35 * texelWorld + 0.008;
      // Constant world-space penumbra where the resolution can afford it.
      light.shadow.radius = Math.min(Math.max(this.worldBlur / texelWorld, 1.0), 3.0);
    }
  }

  /* ------------------------------------------------------------------ */
  /* shader patch                                                        */
  /* ------------------------------------------------------------------ */

  _glslCascadeSupport() {
    const c = this.count;
    let src = `
#ifndef CSM_CASCADES
#define CSM_CASCADES ${c}
#endif
#define CSM_PCF_TAPS ${this.pcfTaps}
#define CSM_SEARCH_SCALE 3.2
${this.contactHardening ? '#define CSM_CONTACT_HARDENING' : ''}
`;

    for (let i = 0; i < c; i++) {
      const n = this.splits[i];
      const f = this.splits[i + 1];
      const bandIn = (this.splits[i] - this.splits[Math.max(i - 1, 0)]) * this.blendRatio;
      const bandOut = (f - n) * this.blendRatio;
      const body = [];
      if (i > 0) body.push(`smoothstep( ${(n - bandIn).toFixed(4)}, ${n.toFixed(4)}, d )`);
      // The last cascade fades out at its far edge instead of ending on a hard
      // ring; by then the geometry is deep in fog anyway.
      body.push(`( 1.0 - smoothstep( ${(f - bandOut).toFixed(4)}, ${f.toFixed(4)}, d ) )`);
      src += `float csmCascadeWeight_${i}( float d ){ return ${body.join(' * ')}; }\n`;

      // Depth-probe offset for the contact-hardening search: 1.2m of world
      // separation expressed in this cascade's normalised depth range. The
      // range is 2r + 168 (see update()); a nominal 16:9 / 80-degree frustum is
      // close enough, since the probe only has to be the right order of
      // magnitude to separate "touching" from "far above".
      const depthRange = 2 * this._sliceRadius(n, f, 80, 16 / 9) + 168;
      src += `#define CSM_PROBE_${i} ${(1.2 / depthRange).toExponential(4)}\n`;
    }
    return src;
  }

  _glslDirectionalBlock() {
    return /* glsl */`
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	#ifndef CSM_CASCADES
	#define CSM_CASCADES ${this.count}
	#endif

	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif

	// Cascade resolve: sample every cascade whose blend weight is non-zero and
	// normalise, so the transition between two cascades is a cross-fade over a
	// band rather than a visible seam where the filter radius jumps.
	float csmShadow = 1.0;

	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0

		float csmViewDepth = - geometryPosition.z;
		float csmAccum = 0.0;
		float csmWeightSum = 0.0;

		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {

			#if ( UNROLLED_LOOP_INDEX < CSM_CASCADES )

			float csmW_UNROLLED_LOOP_INDEX = csmCascadeWeight_UNROLLED_LOOP_INDEX( csmViewDepth );

			if ( csmW_UNROLLED_LOOP_INDEX > 0.0 ) {

				directionalLightShadow = directionalLightShadows[ i ];
				csmAccum += csmW_UNROLLED_LOOP_INDEX * csmSampleShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ], CSM_PROBE_UNROLLED_LOOP_INDEX );
				csmWeightSum += csmW_UNROLLED_LOOP_INDEX;

			}

			#endif

		}
		#pragma unroll_loop_end

		// Past the last split the weights taper to zero; blending toward 1.0
		// there dissolves the shadow instead of cutting it off on a hard ring.
		csmShadow = csmWeightSum > 0.0 ? mix( 1.0, csmAccum / csmWeightSum, min( csmWeightSum, 1.0 ) ) : 1.0;

	#endif

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

		directionalLight = directionalLights[ i ];

		getDirectionalLightInfo( directionalLight, directLight );

		#if ( UNROLLED_LOOP_INDEX < CSM_CASCADES )

			// Cascade slots 1..N-1 exist only to own a shadow map; slot 0 carries
			// the sun's whole radiance and the resolved cascade shadow.
			#if ( UNROLLED_LOOP_INDEX == 0 )

			directLight.color *= ( directLight.visible && receiveShadow ) ? csmShadow : 1.0;

			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

			#endif

		#else

			#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
			directionalLightShadow = directionalLightShadows[ i ];
			directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
			#endif

			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

		#endif

	}
	#pragma unroll_loop_end

#endif

`;
  }

  _glslShadowSampler() {
    return /* glsl */`
#ifdef USE_SHADOWMAP

${this._glslCascadeSupport()}

	#if defined( SHADOWMAP_TYPE_PCF )

		float csmSampleShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float probeDelta ) {

			shadowCoord.xyz /= shadowCoord.w;

			#ifdef USE_REVERSED_DEPTH_BUFFER
				shadowCoord.z -= shadowBias;
			#else
				shadowCoord.z += shadowBias;
			#endif

			if ( shadowCoord.x < 0.0 || shadowCoord.x > 1.0 ||
			     shadowCoord.y < 0.0 || shadowCoord.y > 1.0 ||
			     shadowCoord.z < 0.0 || shadowCoord.z > 1.0 ) return 1.0;

			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
			float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
			float radius = shadowRadius;

			#ifdef CSM_CONTACT_HARDENING

				// Blocker-distance estimate without a raw-depth fetch (three's PCF
				// path binds the map as sampler2DShadow, so only comparisons are
				// available). o0 is the occlusion at the receiver depth; o1 the
				// occlusion once the reference depth is pushed probeDelta toward
				// the light. Blockers resting on the receiver vanish from o1 and
				// the filter tightens; blockers high above it survive and the
				// penumbra opens up. That is the contact-hardening behaviour PCSS
				// buys with an explicit blocker search.
				float o0 = 0.0;
				float o1 = 0.0;
				#ifdef USE_REVERSED_DEPTH_BUFFER
					float zProbe = shadowCoord.z + probeDelta;
				#else
					float zProbe = shadowCoord.z - probeDelta;
				#endif
				for ( int s = 0; s < 4; s ++ ) {
					vec2 o = vogelDiskSample( s, 4, phi ) * ( radius * CSM_SEARCH_SCALE ) * texelSize;
					o0 += 1.0 - texture( shadowMap, vec3( shadowCoord.xy + o, shadowCoord.z ) );
					o1 += 1.0 - texture( shadowMap, vec3( shadowCoord.xy + o, zProbe ) );
				}
				float hard = ( o0 > 0.02 ) ? clamp( o1 / o0, 0.0, 1.0 ) : 0.0;
				radius = mix( radius * 0.5, radius * CSM_SEARCH_SCALE, hard );

			#endif

			float sum = 0.0;
			for ( int s = 0; s < CSM_PCF_TAPS; s ++ ) {
				vec2 o = vogelDiskSample( s, CSM_PCF_TAPS, phi ) * radius * texelSize;
				sum += texture( shadowMap, vec3( shadowCoord.xy + o, shadowCoord.z ) );
			}

			return mix( 1.0, sum / float( CSM_PCF_TAPS ), shadowIntensity );

		}

	#else

		// BASIC / VSM maps carry no comparison sampler; fall back to three's own
		// filter so the cascade blend still works whatever the renderer picked.
		float csmSampleShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float probeDelta ) {
			return getShadow( shadowMap, shadowMapSize, shadowIntensity, shadowBias, shadowRadius, shadowCoord );
		}

	#endif

#endif
`;
  }

  /**
   * Patch the two shader chunks every lit material shares. Global by design:
   * patching per material would mean reaching into materials other modules own.
   */
  installShaderPatch() {
    if (_originalLightsChunk === null) _originalLightsChunk = THREE.ShaderChunk.lights_fragment_begin;
    if (_originalShadowChunk === null) _originalShadowChunk = THREE.ShaderChunk.shadowmap_pars_fragment;

    const src = _originalLightsChunk;
    const startTok = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
    const endTok = '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )';
    const a = src.indexOf(startTok);
    const b = src.indexOf(endTok);
    if (a < 0 || b < 0 || b < a) return false;

    THREE.ShaderChunk.lights_fragment_begin =
      src.slice(0, a) + this._glslDirectionalBlock() + src.slice(b);
    THREE.ShaderChunk.shadowmap_pars_fragment =
      _originalShadowChunk + this._glslShadowSampler();
    return true;
  }

  /** Re-emit the generated GLSL (after a quality-tier change) and recompile. */
  rebuild(scene) {
    if (!this._patched) return;
    this._computeSplits();
    this.installShaderPatch();
    scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) m.forEach((x) => { x.needsUpdate = true; });
      else m.needsUpdate = true;
    });
  }

  dispose() {
    for (const l of this.lights) {
      l.shadow.map?.dispose();
      this.scene.remove(l.target);
      this.scene.remove(l);
    }
    this.lights.length = 0;
    if (_originalLightsChunk !== null) THREE.ShaderChunk.lights_fragment_begin = _originalLightsChunk;
    if (_originalShadowChunk !== null) THREE.ShaderChunk.shadowmap_pars_fragment = _originalShadowChunk;
  }
}
