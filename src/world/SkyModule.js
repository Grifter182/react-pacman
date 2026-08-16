import * as THREE from 'three';

/**
 * OWNER: sky / atmosphere agent.
 * Physically-motivated sky dome + sun disc, and the IBL environment map that
 * every PBR material samples. Publishes `engine.sunDirection` (unit vector
 * pointing FROM the world TO the sun) which LightingModule consumes.
 */
export class SkyModule {
  constructor() {
    this.sunDirection = new THREE.Vector3(0.42, 0.52, -0.74).normalize();
    this.sunColor = new THREE.Color(1.0, 0.84, 0.66);
    this.skyMesh = null;
    this.envMap = null;
  }

  async init(engine) {
    engine.sunDirection = this.sunDirection;
    engine.sunColor = this.sunColor;

    const geo = new THREE.SphereGeometry(1, 48, 32);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uSunDir: { value: this.sunDirection },
        uHorizon: { value: new THREE.Color(0.62, 0.66, 0.72) },
        uZenith: { value: new THREE.Color(0.20, 0.34, 0.58) },
        uGround: { value: new THREE.Color(0.10, 0.10, 0.11) },
        uSunColor: { value: this.sunColor },
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main(){
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_Position.z = gl_Position.w; // force to far plane
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vDir;
        uniform vec3 uSunDir, uHorizon, uZenith, uGround, uSunColor;
        void main(){
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 sky = mix(uHorizon, uZenith, clamp(pow(max(h, 0.0), 0.42), 0.0, 1.0));
          sky = mix(uGround, sky, smoothstep(-0.12, 0.02, h));
          float sd = max(dot(d, normalize(uSunDir)), 0.0);
          sky += uSunColor * pow(sd, 900.0) * 22.0;            // disc
          sky += uSunColor * pow(sd, 8.0) * 0.35;              // near-sun glow
          sky += uSunColor * pow(sd, 2.0) * 0.06;              // wide scatter
          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    });
    this.skyMesh = new THREE.Mesh(geo, mat);
    this.skyMesh.name = 'SkyDome';
    this.skyMesh.frustumCulled = false;

    this._buildEnvironment(engine);
  }

  /**
   * Bake the sky dome into a cubemap once, then use that cubemap BOTH as the
   * scene background and (via PMREM) as the IBL environment.
   *
   * Baking rather than drawing a dome mesh every frame is what a real engine
   * does: it costs zero draw calls per frame, guarantees the background can
   * never be depth-sorted incorrectly against world geometry, and keeps the
   * visible sky and the lighting environment perfectly consistent — they are
   * literally the same pixels.
   */
  _buildEnvironment(engine) {
    const renderer = engine.get('render').renderer;

    const tmp = new THREE.Scene();
    tmp.add(this.skyMesh);

    // High enough that the sun disc stays crisp when used as a background.
    const cubeRT = new THREE.WebGLCubeRenderTarget(1024, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    const cubeCam = new THREE.CubeCamera(0.1, 10, cubeRT);

    const prevTarget = renderer.getRenderTarget();
    const prevTM = renderer.toneMapping;
    const prevCS = renderer.outputColorSpace;
    // Bake in linear light — tone mapping happens once, at composite time.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    cubeCam.update(renderer, tmp);
    renderer.toneMapping = prevTM;
    renderer.outputColorSpace = prevCS;
    renderer.setRenderTarget(prevTarget);

    this.cubeRT = cubeRT;
    engine.scene.background = cubeRT.texture;
    engine.scene.backgroundIntensity = 1.0;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromCubemap(cubeRT.texture);
    this.envMap = env.texture;
    engine.scene.environment = this.envMap;
    engine.scene.environmentIntensity = 1.0;
    engine.viewmodelScene.environment = this.envMap;
    pmrem.dispose();

    // The dome mesh has served its purpose; it is never rendered again.
    tmp.remove(this.skyMesh);
  }

  dispose() {
    this.skyMesh?.geometry.dispose();
    this.skyMesh?.material.dispose();
    this.cubeRT?.dispose();
    this.envMap?.dispose();
  }
}
