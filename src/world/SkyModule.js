import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { ATMO, atmosphereGLSL, sunDirectionArray, sunTransmittance, skyRadiance } from './Atmosphere.js';

/**
 * OWNER: sky / atmosphere agent.
 *
 * Physically-based sky, baked once into a cubemap that serves as BOTH the
 * visible background and the IBL environment — the same pixels light the world
 * and fill the horizon, so they can never disagree.
 *
 * The bake is three passes, each one cheap because the expensive one is small:
 *
 *   1. SKY LUT (128 cube)   Full single-scattering Rayleigh + Mie + ozone
 *                           raymarch, 28 view steps x 8 light steps. Only
 *                           ~98k pixels, so the expensive integrator runs where
 *                           the signal is smooth and interpolates for free.
 *   2. CLOUDS (128-512)     Volumetric raymarch of a cumulus slab plus a cirrus
 *                           sheet, lit by the same atmosphere, with aerial
 *                           perspective applied against the LUT.
 *   3. COMPOSITE (512-1024) LUT + distant ridge silhouette + clouds + the sun
 *                           disc with limb darkening. Per-pixel cost here is
 *                           two cube fetches and a few pows, so full resolution
 *                           is affordable and the sun disc stays crisp.
 *
 * Publishes for LightingModule:
 *   engine.sunDirection  unit vector, world -> sun
 *   engine.sunColor      spectral transmittance of the sun, normalised
 *   engine.sunIrradiance raw irradiance in renderer light units
 *   engine.skyBake       { cubeRT, envMap } for anyone who needs the bake
 */
export class SkyModule {
  constructor() {
    const s = sunDirectionArray();
    this.sunDirection = new THREE.Vector3(s[0], s[1], s[2]).normalize();
    this.sunColor = new THREE.Color(1, 1, 1);
    this.sunIrradiance = new THREE.Vector3(1, 1, 1);
    this.cubeRT = null;
    this.envMap = null;
    this._transient = [];
  }

  async init(engine) {
    const T = sunTransmittance();
    const peak = Math.max(T[0], T[1], T[2], 1e-4);
    this.sunColor.setRGB(T[0] / peak, T[1] / peak, T[2] / peak, THREE.LinearSRGBColorSpace);
    this.sunIrradiance.set(ATMO.E0 * T[0], ATMO.E0 * T[1], ATMO.E0 * T[2]);

    engine.sunDirection = this.sunDirection;
    engine.sunColor = this.sunColor;
    engine.sunIrradiance = this.sunIrradiance;

    const tier = Config.quality;
    const cloudSize = { low: 128, medium: 192, high: 384, ultra: 512 }[tier] ?? 192;
    const cloudSteps = { low: 8, medium: 12, high: 20, ultra: 28 }[tier] ?? 14;
    const skySize = { low: 512, medium: 768, high: 1024, ultra: 1024 }[tier] ?? 768;

    const renderer = engine.get('render').renderer;

    const lut = this._bake(renderer, 128, this._lutMaterial());
    const clouds = this._bake(renderer, cloudSize, this._cloudMaterial(lut.texture, cloudSteps), {
      format: THREE.RGBAFormat,
    });
    const sky = this._bake(renderer, skySize, this._compositeMaterial(lut.texture, clouds.texture, T, peak));

    lut.dispose();
    clouds.dispose();
    this.cubeRT = sky;

    engine.scene.background = sky.texture;
    engine.scene.backgroundIntensity = 1.0;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromCubemap(sky.texture);
    this.envMap = env.texture;
    pmrem.dispose();

    engine.scene.environment = this.envMap;
    engine.viewmodelScene.environment = this.envMap;
    engine.skyBake = { cubeRT: sky, envMap: this.envMap };

    // Horizon/zenith fit for LightingModule's fog, taken from the same model
    // that produced the pixels above.
    engine.skyFit = this._fitHorizon();

    for (const d of this._transient) d.dispose();
    this._transient.length = 0;
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Render a full-sphere shader into a cubemap. The dome is drawn from the
   * inside at unit radius by a CubeCamera parked at the origin; the shader only
   * ever uses the direction, so the radius is irrelevant.
   */
  _bake(renderer, size, material, opts = {}) {
    const geo = new THREE.SphereGeometry(1, 32, 16);
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);

    const rt = new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.HalfFloatType,
      format: opts.format || THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    const cam = new THREE.CubeCamera(0.1, 10, rt);

    const prevTarget = renderer.getRenderTarget();
    const prevTM = renderer.toneMapping;
    const prevCS = renderer.outputColorSpace;
    // RenderModule runs with autoClear off because it composes several passes
    // per frame; a cube bake needs the faces cleared between them.
    const prevAuto = renderer.autoClear;
    // Bake in linear light — tone mapping happens once, at composite time.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.autoClear = true;
    cam.update(renderer, scene);
    renderer.autoClear = prevAuto;
    renderer.toneMapping = prevTM;
    renderer.outputColorSpace = prevCS;
    renderer.setRenderTarget(prevTarget);

    this._transient.push(geo, material);
    return rt;
  }

  _domeVertex() {
    return /* glsl */`
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
  }

  /** Pass 1 — the scattering integral itself. */
  _lutMaterial() {
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: { uSunDir: { value: this.sunDirection } },
      vertexShader: this._domeVertex(),
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vDir;
        uniform vec3 uSunDir;
        ${atmosphereGLSL({ viewSteps: 28, lightSteps: 8 })}
        void main(){
          vec3 d = normalize(vDir);
          vec3 sun = normalize(uSunDir);
          vec3 ro = vec3(0.0, A_RG + 2.0, 0.0);
          vec3 tr;
          vec3 col = aSky(ro, d, sun, tr);

          // Ground hemisphere: fold in the boundary-layer haze so the bake
          // converges on the horizon colour at grazing angles instead of
          // cutting from bright sky to bare ground across one texel. The world
          // geometry in front of it is fogged with the same integral, so the
          // two meet at the same value and the horizon seam has nowhere to
          // form. Steeply downward rays stay ground-coloured, which is what
          // feeds bounce light into the IBL.
          float tG = aRayGround(ro, d);
          if (tG > 0.0){
            vec3 hazeTr;
            vec3 haze = aSky(ro, normalize(vec3(d.x, 0.006, d.z)), sun, hazeTr);
            col = mix(col, haze, aHazeFactor(2.0, d.y, tG));
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
  }

  /**
   * Mean radiance over the whole sphere. A cloud droplet is an isotropic
   * scatterer looking in every direction at once, so this — not the zenith
   * colour — is the ambient term. It includes the lit ground below, which is
   * what stops cumulus undersides from going flat blue-black.
   */
  _sphereAverageRadiance() {
    const sun = sunDirectionArray();
    const N = 48;
    const acc = [0, 0, 0];
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - ((i + 0.5) / N) * 2;
      const r = Math.sqrt(Math.max(1 - y * y, 0));
      const th = ga * i;
      const c = skyRadiance([Math.cos(th) * r, y, Math.sin(th) * r], sun, 12, 4);
      acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
    }
    return acc.map((v) => v / N);
  }

  /** Pass 2 — volumetric cumulus deck + cirrus sheet. */
  _cloudMaterial(lut, steps) {
    const amb = this._sphereAverageRadiance();
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uSunDir: { value: this.sunDirection },
        uSkyLut: { value: lut },
        uSunIrradiance: { value: this.sunIrradiance.clone() },
        uAmbient: { value: new THREE.Vector3(amb[0], amb[1], amb[2]) },
      },
      vertexShader: this._domeVertex(),
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vDir;
        uniform vec3 uSunDir, uSunIrradiance, uAmbient;
        uniform samplerCube uSkyLut;
        ${atmosphereGLSL({ viewSteps: 8, lightSteps: 4 })}

        #define C_BOT   1450.0
        #define C_TOP   3550.0
        #define C_CIRRUS 7400.0
        #define C_SIGMA 0.0040          // extinction per metre at density 1
        #define C_STEPS ${steps}
        #define C_AP_K  0.000026        // aerial-perspective falloff, 1/m

        float hash13(vec3 p){
          p = fract(p * 0.1031);
          p += dot(p, p.zyx + 31.32);
          return fract((p.x + p.y) * p.z);
        }
        float vnoise(vec3 x){
          vec3 i = floor(x), f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          float a = mix(mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
                            mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
                        mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
                            mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
          return a;
        }
        float fbm3(vec3 p){
          float s = 0.0, a = 0.5;
          for (int i = 0; i < 3; i++){ s += a * vnoise(p); p = p * 2.07 + 11.3; a *= 0.5; }
          return s / 0.875;
        }
        float fbm2(vec3 p){
          float s = 0.0, a = 0.5;
          for (int i = 0; i < 2; i++){ s += a * vnoise(p); p = p * 2.13 + 4.7; a *= 0.5; }
          return s / 0.75;
        }

        // Cumulus density. Work in a local frame (horizontal offset, altitude)
        // so the noise never sees planet-radius coordinates and loses precision.
        float cloudDensity(vec3 pos, float alt, bool detail){
          float h = (alt - C_BOT) / (C_TOP - C_BOT);
          if (h < 0.0 || h > 1.0) return 0.0;
          vec3 q = vec3(pos.x, alt, pos.z);
          // Low-frequency domain warp stands in for curl advection: it shears
          // the puffs downwind instead of leaving them radially symmetric.
          vec3 p = q * 0.00046 + (fbm3(q * 0.000085) - 0.5) * 1.3;
          // ~10km coverage cells: whole weather systems, so the sky has open
          // holes and dense banks rather than uniform stipple.
          float cov = smoothstep(0.30, 0.68, fbm3(vec3(q.x, 0.0, q.z) * 0.0001));
          // Rounded base, sheared-off top: cumulus mediocris, not spheres.
          float shape = smoothstep(0.0, 0.17, h) * smoothstep(1.0, 0.58, h);
          float d = fbm3(p) * shape - (1.0 - cov) * 0.62 - 0.10;
          if (d <= 0.0) return 0.0;
          if (detail) d -= (1.0 - fbm2(p * 6.1)) * 0.13 * (1.0 - 0.5 * h);
          return max(d, 0.0) * 1.9;
        }

        // 4-step cone march toward the sun; steps grow so the far half of the
        // cloud still contributes to self-shadowing without 4x the cost.
        float cloudLightOD(vec3 pos, vec3 sunDir){
          float od = 0.0;
          float t = 0.0;
          for (int i = 0; i < 4; i++){
            float stepLen = 120.0 * pow(2.15, float(i));
            t += stepLen;
            vec3 s = pos + sunDir * t;
            od += cloudDensity(s, length(s) - A_RG, false) * stepLen;
          }
          return od;
        }

        float hg(float mu, float g){
          float gg = g * g;
          return (1.0 - gg) / (4.0 * A_PI * pow(max(1.0 + gg - 2.0 * g * mu, 1e-4), 1.5));
        }

        void main(){
          vec3 d = normalize(vDir);
          vec3 sun = normalize(uSunDir);
          vec3 ro = vec3(0.0, A_RG + 2.0, 0.0);
          vec3 scatter = vec3(0.0);
          float trans = 1.0;

          if (d.y > -0.005){
            float tBot = 0.0, tTop = 0.0;
            {
              float b = dot(ro, d);
              float rb = A_RG + C_BOT, rt = A_RG + C_TOP;
              float cb = dot(ro, ro) - rb * rb;
              float ct = dot(ro, ro) - rt * rt;
              tBot = -b + sqrt(max(b * b - cb, 0.0));
              tTop = -b + sqrt(max(b * b - ct, 0.0));
            }
            float ds = clamp((tTop - tBot) / float(C_STEPS), 45.0, 420.0);
            float mu = dot(d, sun);
            // Three scattering octaves, each with its own phase (Wrenninge et
            // al.). Light that has bounced once keeps a strong forward lobe —
            // that is the silver lining — but by the third bounce it is
            // effectively isotropic. Applying the sharp lobe to ALL the energy
            // is the classic mistake that leaves clouds away from the sun six
            // times too dark and reads as a thunderstorm at noon.
            float p0 = mix(hg(mu, 0.78), hg(mu, -0.28), 0.32);
            float p1 = mix(hg(mu, 0.45), hg(mu, -0.15), 0.35);
            float p2 = 0.0795774;   // 1 / 4pi

            float t = tBot + ds * hash13(d * 1234.5);        // jitter kills banding
            float distSum = 0.0, distW = 0.0;

            for (int i = 0; i < C_STEPS; i++){
              vec3 p = ro + d * t;
              float alt = length(p) - A_RG;
              float dens = cloudDensity(p, alt, true);
              if (dens > 0.004){
                float sigmaS = dens * C_SIGMA;
                float od = cloudLightOD(p, sun);
                float tau = od * C_SIGMA;
                // Each octave is dimmer, less extinguished and flatter than the
                // last, so deep interiors keep a soft isotropic glow.
                float lit = exp(-tau) * p0
                          + 0.75 * exp(-tau * 0.28) * p1
                          + 0.55 * exp(-tau * 0.06) * p2;
                // Powder term — dense cores darken because light has to get in
                // before it can scatter out.
                float powder = 1.0 - exp(-dens * 2.6);
                float hn = clamp((alt - C_BOT) / (C_TOP - C_BOT), 0.0, 1.0);
                vec3 S = uSunIrradiance * (lit * mix(1.0, powder, 0.72))
                       + uAmbient * (0.35 + 0.65 * hn) * 0.9;
                S *= sigmaS;
                float segT = exp(-sigmaS * ds);
                scatter += trans * (S - S * segT) / max(sigmaS, 1e-7);
                trans *= segT;
                distSum += t * (1.0 - segT); distW += (1.0 - segT);
                if (trans < 0.015) break;
              }
              t += ds;
            }

            // Aerial perspective on the deck. Clouds along the horizon are tens
            // of kilometres away and have to dissolve into exactly the haze the
            // terrain dissolves into — same LUT, spectral extinction, so they go
            // warm and soft rather than simply fading.
            vec3 skyHere = textureCube(uSkyLut, d).rgb;
            if (distW > 0.0){
              float dist = distSum / distW;
              vec3 apT = aSegmentTransmittance(2.0, 2.0 + d.y * dist, d.y, dist);
              scatter = scatter * apT + skyHere * (1.0 - trans) * (1.0 - apT);
            }

            // Cirrus: a thin, sheared sheet far above the deck, composited
            // behind it. Optically thin, so a raymarch would buy nothing.
            {
              float b = dot(ro, d);
              float rc = A_RG + C_CIRRUS;
              float tc = -b + sqrt(max(b * b - (dot(ro, ro) - rc * rc), 0.0));
              vec3 p = ro + d * tc;
              // Stretched 3:1 along x — cirrus is sheared out by the jet stream.
              vec3 q = vec3(p.x * 0.00011, 0.0, p.z * 0.000034);
              float w = fbm3(q + vec3(fbm2(q * 3.1) * 0.6, 0.0, 0.0));
              float a = smoothstep(0.50, 0.88, w) * 0.62 * smoothstep(0.0, 0.10, d.y);
              vec3 c = uSunIrradiance * (0.34 * hg(mu, 0.62) + 0.075) + uAmbient * 0.6;
              vec3 apT = aSegmentTransmittance(2.0, 2.0 + d.y * tc, d.y, tc);
              c = c * apT + skyHere * (1.0 - apT);
              scatter += trans * c * a;
              trans *= (1.0 - a);
            }
          }

          gl_FragColor = vec4(scatter, 1.0 - trans);
        }
      `,
    });
  }

  /** Pass 3 — assemble the visible sky. */
  _compositeMaterial(lut, clouds, T, peak) {
    const disc = new THREE.Vector3(
      (ATMO.sunDiscRadiance * T[0]) / peak,
      (ATMO.sunDiscRadiance * T[1]) / peak,
      (ATMO.sunDiscRadiance * T[2]) / peak,
    );
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uSunDir: { value: this.sunDirection },
        uSkyLut: { value: lut },
        uClouds: { value: clouds },
        uDisc: { value: disc },
      },
      vertexShader: this._domeVertex(),
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vDir;
        uniform vec3 uSunDir, uDisc;
        uniform samplerCube uSkyLut, uClouds;

        #define SUN_R ${ATMO.sunAngularRadius.toExponential(6)}

        float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n21(vec2 x){
          vec2 i = floor(x), f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
                     mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        // Sampled on the unit circle rather than on the azimuth angle, so the
        // profile is inherently periodic and does not tear at due west.
        float ridge(vec2 dir2, float freq, float seed){
          float s = 0.0, a = 0.5, fq = freq;
          for (int i = 0; i < 4; i++){ s += a * n21(dir2 * fq + seed); fq *= 2.11; a *= 0.5; }
          return s / 0.9375;
        }

        void main(){
          vec3 d = normalize(vDir);
          vec3 sun = normalize(uSunDir);
          vec3 sky = textureCube(uSkyLut, d).rgb;

          // --- distant ridge line -------------------------------------------
          // Two hazed ranges sitting just above the true horizon. They exist to
          // give the frame a background layer and, more practically, to stop the
          // level's finite ground plane from ending against open sky.
          vec2 dir2 = normalize(d.xz + vec2(1e-5, 0.0));
          float el = asin(clamp(d.y, -1.0, 1.0));
          float hFar  = 0.0035 + ridge(dir2, 3.0, 0.0) * 0.0175;
          float hNear = 0.0005 + ridge(dir2, 5.5, 21.7) * 0.0105;
          float mFar  = smoothstep(hFar + 0.0016, hFar - 0.0016, el) * smoothstep(-0.030, -0.006, el);
          float mNear = smoothstep(hNear + 0.0012, hNear - 0.0012, el) * smoothstep(-0.030, -0.006, el);
          sky = mix(sky, sky * 0.920, mFar);
          sky = mix(sky, sky * 0.840, mNear);

          // --- sun disc ------------------------------------------------------
          float cosT = dot(d, sun);
          float ang = acos(clamp(cosT, -1.0, 1.0));
          float r = ang / SUN_R;
          if (r < 1.04){
            // Limb darkening: the photosphere is optically thick, so near the
            // rim we see cooler, higher layers. Bluer wavelengths darken more,
            // which is why the rim goes orange before the centre does.
            float mu = sqrt(max(1.0 - min(r * r, 1.0), 0.0));
            vec3 u = vec3(0.42, 0.56, 0.72);
            vec3 limb = 1.0 - u * (1.0 - mu);
            float edge = smoothstep(1.02, 0.96, r);
            sky += uDisc * limb * edge;
          }

          vec4 cl = textureCube(uClouds, d);
          vec3 col = cl.rgb + sky * (1.0 - cl.a);
          gl_FragColor = vec4(max(col, 0.0), 1.0);
        }
      `,
    });
  }

  /**
   * Fit the sky to the three constants the fog shader needs: a base horizon
   * colour (away from the sun), a zenith colour, and the amplitude of the
   * forward-scattering lobe around the sun. Everything is evaluated with the
   * CPU integrator, i.e. the same model the GPU baked.
   */
  _fitHorizon() {
    const sun = sunDirectionArray();
    const dirAt = (elev, az) => {
      const c = Math.cos(elev);
      return [Math.cos(az) * c, Math.sin(elev), Math.sin(az) * c];
    };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    // Sample the whole upper hemisphere, weighted hard toward the horizon —
    // that is the band distant geometry actually occupies, and the band where
    // the fog is thick enough for a colour error to show.
    const samples = [];
    for (const elev of [0.004, 0.02, 0.06, 0.14, 0.30, 0.55, 0.90, 1.30]) {
      for (let i = 0; i < 12; i++) {
        const d = dirAt(elev, (i / 12) * Math.PI * 2);
        samples.push({ d, mu: dot(d, sun), s: Math.max(d[1], 0), c: skyRadiance(d, sun, 16, 5),
          w: Math.exp(-elev / 0.30) + 0.15 });
      }
    }
    samples.push({ d: [0, 1, 0], mu: sun[1], s: 1, c: skyRadiance([0, 1, 0], sun, 20, 6), w: 0.3 });

    /**
     * Model, linear in five coefficients per channel:
     *
     *   L(d) = A + B*t + D*t*(1-t) + C*hg(mu; g) + E*(0.5 + 0.5*mu)
     *   with  t = max(d.y, 0)^p
     *
     * A is the horizon, A+B the zenith, D a mid-elevation "belt", C a narrow
     * Mie lobe on the sun and E a broad hemispherical bias toward it.
     *
     * Neither of the last two terms is optional. The belt exists because at a
     * low sun the blue channel PEAKS around 20 degrees of elevation — the
     * horizon is blue-depleted by its own path length, the zenith is thin — so
     * a straight horizon-to-zenith ramp lands ~50% low across the whole
     * midfield. The broad lobe exists because the horizon brightens gradually
     * over 180 degrees of azimuth, and a fit offered only a narrow lobe answers
     * by abandoning it and lifting the base instead, which is exactly the error
     * that puts a bright halo where the seam used to be.
     *
     * p and g come from a grid search; the coefficients from weighted least
     * squares at each candidate.
     */
    const NB = 5;
    const basis = (smp, p, g) => {
      const t = Math.pow(smp.s, p);
      const gg = g * g;
      const hg = (1 - gg) / (4 * Math.PI * Math.pow(Math.max(1 + gg - 2 * g * smp.mu, 1e-4), 1.5));
      return [1, t, t * (1 - t), hg, 0.5 + 0.5 * smp.mu];
    };

    const solve = (M, rhs) => {
      const n = rhs.length;
      const a = M.map((row, i) => row.concat([rhs[i]]));
      for (let i = 0; i < n; i++) {
        let piv = i;
        for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[piv][i])) piv = r;
        if (Math.abs(a[piv][i]) < 1e-12) return null;
        [a[i], a[piv]] = [a[piv], a[i]];
        for (let r = 0; r < n; r++) {
          if (r === i) continue;
          const fac = a[r][i] / a[i][i];
          for (let c2 = i; c2 <= n; c2++) a[r][c2] -= fac * a[i][c2];
        }
      }
      return a.map((row, i) => row[n] / row[i]);
    };

    // The elevation exponent is fitted PER CHANNEL. Red collapses within 30
    // degrees of the horizon while blue is still climbing at 50; one shared
    // curve has to split the difference and is 40% wrong in red everywhere.
    // The lobe width g is shared, because the shader evaluates one hg().
    let best = null;
    for (let gi = 0; gi < 12; gi++) {
      const g = 0.40 + gi * 0.04;
      const coef = [];
      const pows = [];
      let total = 0, wtotal = 0;
      for (let ch = 0; ch < 3; ch++) {
        let bch = null;
        for (let pi = 0; pi < 18; pi++) {
          const p = 0.15 + pi * 0.09;
          const B = samples.map((s) => basis(s, p, g));
          const M = [];
          for (let i = 0; i < NB; i++) {
            M.push([]);
            for (let j = 0; j < NB; j++) {
              let acc = 0;
              for (let k = 0; k < samples.length; k++) acc += samples[k].w * B[k][i] * B[k][j];
              // Tiny Tikhonov term: the basis is mildly collinear at some
              // (p, g) and an unregularised solve produces huge cancelling
              // weights that ring between the sample directions.
              M[i].push(acc + (i === j ? 1e-6 : 0));
            }
          }
          const rhs = new Array(NB).fill(0);
          for (let i = 0; i < NB; i++) {
            let acc = 0;
            for (let k = 0; k < samples.length; k++) acc += samples[k].w * B[k][i] * samples[k].c[ch];
            rhs[i] = acc;
          }
          const x = solve(M, rhs);
          if (!x) continue;
          let err = 0, wsum = 0;
          for (let k = 0; k < samples.length; k++) {
            let v = 0;
            for (let i = 0; i < NB; i++) v += x[i] * B[k][i];
            const rel = (v - samples[k].c[ch]) / Math.max(samples[k].c[ch], 0.05);
            err += samples[k].w * rel * rel;
            wsum += samples[k].w;
          }
          if (!bch || err / wsum < bch.err) bch = { err: err / wsum, p, x };
        }
        if (!bch) { total = Infinity; break; }
        coef.push(bch.x);
        pows.push(bch.p);
        total += bch.err;
        wtotal += 1;
      }
      if (!Number.isFinite(total)) continue;
      const rms = Math.sqrt(total / Math.max(wtotal, 1));
      if (!best || rms < best.rms) best = { rms, g, coef, pows };
    }

    const col = (i) => [best.coef[0][i], best.coef[1][i], best.coef[2][i]];
    const horizon = col(0).map((x) => Math.max(x, 0));

    // Anchor the constant term so the model reproduces the horizon ring's mean
    // exactly. A least-squares fit spreads its error evenly over the hemisphere,
    // but the error budget here is not even: a few percent at the zenith is
    // invisible, whereas the same error at the horizon is precisely the seam
    // this whole module exists to remove.
    {
      const gg = best.g * best.g;
      const res = [0, 0, 0];
      let n = 0;
      for (let i = 0; i < 24; i++) {
        const d = dirAt(0.004, (i / 24) * Math.PI * 2);
        const mu = dot(d, sun);
        const hg = (1 - gg) / (4 * Math.PI * Math.pow(Math.max(1 + gg - 2 * best.g * mu, 1e-4), 1.5));
        const truth = skyRadiance(d, sun, 16, 5);
        for (let c = 0; c < 3; c++) {
          const t = Math.pow(Math.max(d[1], 0), best.pows[c]);
          const v = horizon[c] + best.coef[c][1] * t + best.coef[c][2] * t * (1 - t)
            + best.coef[c][3] * hg + best.coef[c][4] * (0.5 + 0.5 * mu);
          res[c] += v - truth[c];
        }
        n++;
      }
      for (let c = 0; c < 3; c++) horizon[c] = Math.max(horizon[c] - res[c] / n, 0);
    }

    return {
      horizon,
      ramp: col(1),
      belt: col(2),
      tint: col(3).map((x) => Math.max(x, 0)),
      broad: col(4),
      gradientPow: best.pows,
      mieG: best.g,
      rms: best.rms,
      zenith: [0, 1, 2].map((c) => Math.max(horizon[c] + best.coef[c][1], 0)),
    };
  }

  dispose() {
    this.cubeRT?.dispose();
    this.envMap?.dispose();
    for (const d of this._transient) d.dispose();
    this._transient.length = 0;
  }
}
