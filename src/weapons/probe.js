import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { flushMaterialBakes, materialsReady } from '../materials/TextureFactory.js';
import { buildWeapon, weaponMaterials, collimate } from './Gunsmith.js';
import { buildArms, armMaterials } from './Arms.js';
import { WEAPONS } from './WeaponDefs.js';

/**
 * OWNER: weapons agent.
 *
 * Weapon-only render probe. Boots a WebGL2 context with nothing in it but the
 * viewmodel scene — the same camera FOV, the same three lights, the same
 * environment intensity and the same tone mapping the game uses — and exposes a
 * scripting surface so a two-second Playwright run can photograph the hero
 * asset at any pose.
 *
 * This exists because the full capture harness renders a three-million-triangle
 * city ten times to answer questions that are entirely about one mesh: is the
 * receiver reading as steel, is the reticle on the screen, is the bell round.
 * Those questions now cost one frame each. Drive it with:
 *
 *     node src/weapons/probe.mjs --out shots/weapon-probe
 *
 * The window behind the weapon is a mid-grey gradient card rather than the real
 * level: silhouette and material read are judged against a neutral field, and
 * anything that only looks right in front of a sunlit wall is not fixed.
 */

const canvas = document.getElementById('view');
const errEl = document.getElementById('err');

function fail(e) {
  errEl.style.display = 'block';
  errEl.textContent = `probe failure\n\n${e?.stack || e}`;
  console.error('[probe]', e);
}

async function boot() {
  const forced = new URLSearchParams(location.search).get('quality');
  if (forced && Config.quality !== forced) Config.quality = forced;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, stencil: false });
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.autoClear = false;
  renderer.debug.checkShaderErrors = true;

  /* --- backdrop: neutral gradient card, its own scene and ortho camera ---- */
  const bgScene = new THREE.Scene();
  const bgCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  bgScene.add(new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vU; void main(){ vU = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `varying vec2 vU;
        void main(){
          vec3 c = mix(vec3(0.055,0.062,0.075), vec3(0.32,0.34,0.37), pow(vU.y, 0.8));
          // A coarse checker so texel-scale defects on the weapon can be sized
          // against a known 32-pixel grid instead of guessed at.
          float g = step(0.5, fract(gl_FragCoord.x/64.0)) == step(0.5, fract(gl_FragCoord.y/64.0)) ? 1.0 : 0.94;
          gl_FragColor = vec4(c * g, 1.0);
        }`,
    }),
  ));

  /* --- environment: a cheap sky/ground PMREM, not the real SkyModule ------ */
  const N = 64;
  const data = new Float32Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    const t = 1 - y / (N - 1);
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const sky = Math.pow(t, 0.6);
      data[i] = 0.55 + sky * 0.55; data[i + 1] = 0.68 + sky * 0.78; data[i + 2] = 0.95 + sky * 1.05;
      if (t < 0.5) { data[i] = 0.30; data[i + 1] = 0.26; data[i + 2] = 0.21; }
      data[i + 3] = 1;
    }
  }
  const equi = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType);
  equi.mapping = THREE.EquirectangularReflectionMapping;
  equi.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromEquirectangular(equi).texture;
  pmrem.dispose();
  equi.dispose();

  /* --- viewmodel scene: identical construction to WeaponModule ------------ */
  const scene = new THREE.Scene();
  scene.environment = envMap;
  scene.environmentIntensity = 0.50;

  const cam = new THREE.PerspectiveCamera(Config.camera.viewmodelFov, 1, 0.005, 12);
  cam.rotation.order = 'YXZ';
  scene.add(cam);

  const sunDir = new THREE.Vector3(0.478, 0.250, -0.842).normalize();
  const key = new THREE.DirectionalLight(0xfff0dc, 3.0);
  key.position.copy(sunDir).multiplyScalar(10);
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0x8fb4d8, 0.55);
  fill.position.set(-sunDir.x * 8, -3, -sunDir.z * 8);
  scene.add(fill, fill.target);
  const rim = new THREE.DirectionalLight(0xffe6c8, 0.7);
  rim.position.set(-2, 4, 8);
  scene.add(rim, rim.target);

  const gunMats = weaponMaterials();
  const armMats = armMaterials();
  const builds = new Map();
  for (const id of Object.keys(WEAPONS)) {
    const b = buildWeapon(WEAPONS[id], gunMats);
    b.arms = buildArms(b, armMats);
    b.root.add(b.arms.root);
    b.root.visible = false;
    b.reticle.visible = false;
    cam.add(b.root);
    cam.add(b.reticle);
    builds.set(id, b);
  }

  let current = 'rifle';
  let ads = 0;

  function layout() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }
  window.addEventListener('resize', layout);
  layout();

  function frame() {
    const b = builds.get(current);
    for (const [id, o] of builds) o.root.visible = (id === current);
    b.root.position.copy(b.hipPose.pos).lerp(b.adsPose.pos, ads);
    b.root.rotation.set(
      THREE.MathUtils.lerp(b.hipPose.rot.x, b.adsPose.rot.x, ads),
      THREE.MathUtils.lerp(b.hipPose.rot.y, b.adsPose.rot.y, ads),
      THREE.MathUtils.lerp(b.hipPose.rot.z, b.adsPose.rot.z, ads),
      'YXZ',
    );
    cam.updateMatrixWorld(true);
    for (const [id, o] of builds) o.reticle.visible = false;
    const info = collimate(b, cam, ads);
    renderer.clear(true, true, true);
    renderer.render(bgScene, bgCam);
    renderer.clearDepth();
    renderer.render(scene, cam);
    return info;
  }

  let lastInfo = null;
  function loop() { lastInfo = frame(); requestAnimationFrame(loop); }
  loop();

  window.__probe = {
    THREE, renderer, scene, cam, builds,
    weapons: [...builds.keys()],
    setWeapon(id) { if (builds.has(id)) current = id; },
    setAds(t) { ads = THREE.MathUtils.clamp(t, 0, 1); },
    async flush() { flushMaterialBakes(); await materialsReady(); },
    /** Bake resolution actually reached, per material slot. */
    bakeState() {
      return gunMats.map((m, i) => ({
        slot: i,
        preset: m.userData?.preset ?? null,
        size: m.map?.image?.width ?? null,
        resolution: m.userData?.surface?.resolution ?? null,
        ready: m.userData?.surface?.ready ?? null,
      }));
    },
    /** One frame, plus everything worth asserting about it. */
    step() {
      const info = frame();
      const b = builds.get(current);
      return {
        weapon: current, ads,
        triangles: b.triangles,
        hip: b.hipPose.pos.toArray(), adsPose: b.adsPose.pos.toArray(),
        reticle: info,
      };
    },
    /**
     * Screen-space bounding box of the visible weapon silhouette, in NDC.
     * This is the number the "still too large" complaint is actually about, so
     * it is measured rather than eyeballed off a screenshot.
     */
    silhouetteNDC() {
      const b = builds.get(current);
      frame();
      const v = new THREE.Vector3();
      const box = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, clipped: 0, n: 0 };
      b.root.updateMatrixWorld(true);
      b.root.traverse((o) => {
        if (!o.isMesh || o === b.reticle) return;
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          if (-v.z < cam.near) { box.clipped++; continue; }
          v.applyMatrix4(cam.projectionMatrix);
          box.x0 = Math.min(box.x0, v.x); box.x1 = Math.max(box.x1, v.x);
          box.y0 = Math.min(box.y0, v.y); box.y1 = Math.max(box.y1, v.y);
          box.n++;
        }
      });
      box.areaFrac = ((Math.min(1, box.x1) - Math.max(-1, box.x0))
                    * (Math.min(1, box.y1) - Math.max(-1, box.y0))) / 4;
      return box;
    },
    /** Mean linear luminance of a centred NDC window — proves the dot is lit. */
    centrePatch(px = 24) {
      frame();
      const w = renderer.domElement.width, h = renderer.domElement.height;
      const x0 = Math.max(0, (w >> 1) - px), y0 = Math.max(0, (h >> 1) - px);
      const buf = new Uint8Array(px * 2 * px * 2 * 4);
      const gl = renderer.getContext();
      gl.readPixels(x0, y0, px * 2, px * 2, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let peak = 0, warm = 0;
      for (let i = 0; i < buf.length; i += 4) {
        const l = buf[i] * 0.3 + buf[i + 1] * 0.6 + buf[i + 2] * 0.1;
        peak = Math.max(peak, l);
        warm = Math.max(warm, buf[i] - (buf[i + 1] + buf[i + 2]) * 0.5);
      }
      return { peak, warm };
    },
  };
  document.body.dataset.ready = '1';
}

boot().catch(fail);
