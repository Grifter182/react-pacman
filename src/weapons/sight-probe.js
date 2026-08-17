/**
 * OWNER: weapons agent.  Companion to `sight-probe.html`.
 *
 * The question this answers is the one a raycast cannot: does the sight LOOK
 * see-through. `aperture-probe.mjs` proves that no triangle stands in the cone;
 * this proves that the world behind the weapon actually arrives at the eye,
 * through the glass, with the reticle over it — and it does it without touching
 * `Arms.js`, so it keeps working while the hands are being rebuilt.
 *
 * A target board of known angular size sits 12 m downrange. Anything wrong with
 * the aperture shows up as the board being eaten by a grey annulus.
 */
import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { WEAPONS } from './WeaponDefs.js';
import { buildWeapon, weaponMaterials, collimate } from './Gunsmith.js';
import { flushMaterialBakes } from '../materials/TextureFactory.js';

const canvas = document.getElementById('c');
const errEl = document.getElementById('err');

async function boot() {
  const q = new URLSearchParams(location.search);
  if (q.get('quality')) Config.quality = q.get('quality');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.debug.checkShaderErrors = true;

  // Sky/ground PMREM, same construction as the weapon probe.
  const N = 64, data = new Float32Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    const t = 1 - y / (N - 1);
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const s = Math.pow(t, 0.6);
      data[i] = 0.55 + s * 0.55; data[i + 1] = 0.68 + s * 0.78; data[i + 2] = 0.95 + s * 1.05;
      if (t < 0.5) { data[i] = 0.30; data[i + 1] = 0.26; data[i + 2] = 0.21; }
      data[i + 3] = 1;
    }
  }
  const equi = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType);
  equi.mapping = THREE.EquirectangularReflectionMapping;
  equi.needsUpdate = true;
  const pm = new THREE.PMREMGenerator(renderer);
  const envMap = pm.fromEquirectangular(equi).texture;
  pm.dispose(); equi.dispose();

  const scene = new THREE.Scene();
  scene.environment = envMap;
  scene.environmentIntensity = 0.85;
  scene.background = new THREE.Color(0x1a2028);

  const cam = new THREE.PerspectiveCamera(Config.camera.viewmodelFov, 1, 0.005, 40);
  cam.rotation.order = 'YXZ';
  scene.add(cam);

  const sun = new THREE.Vector3(0.478, 0.250, -0.842).normalize();
  const key = new THREE.DirectionalLight(0xfff0dc, 3.0);
  key.position.copy(sun).multiplyScalar(10);
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0x8fb4d8, 0.55);
  fill.position.set(-sun.x * 8, -3, -sun.z * 8);
  scene.add(fill, fill.target);
  const rim = new THREE.DirectionalLight(0xffe6c8, 0.7);
  rim.position.set(-2, 4, 8);
  scene.add(rim, rim.target);

  /* Target board: a 4 m red/white ring pattern at 12 m. Its centre is on the
   * camera's -Z axis, which at full ADS is also the optical axis, so anything
   * the sight occludes is missing from a pattern whose geometry is known. */
  const S = 256, td = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
      const r = Math.hypot(dx, dy);
      const band = Math.floor(r * 10) % 2 === 0;
      const cross = Math.abs(dx) < 0.012 || Math.abs(dy) < 0.012;
      const i = (y * S + x) * 4;
      const v = cross ? [10, 240, 60] : band ? [235, 235, 228] : [188, 42, 34];
      td[i] = v[0]; td[i + 1] = v[1]; td[i + 2] = v[2]; td[i + 3] = 255;
    }
  }
  const tt = new THREE.DataTexture(td, S, S, THREE.RGBAFormat);
  tt.colorSpace = THREE.SRGBColorSpace; tt.needsUpdate = true;
  const board = new THREE.Mesh(new THREE.PlaneGeometry(4, 4),
    new THREE.MeshBasicMaterial({ map: tt }));
  board.position.set(0, 0, -12);
  cam.add(board);

  const mats = weaponMaterials();
  const builds = new Map();
  for (const id of Object.keys(WEAPONS)) {
    const b = buildWeapon(WEAPONS[id], mats);
    b.root.visible = false;
    cam.add(b.root);
    cam.add(b.reticle);
    builds.set(id, b);
  }

  let cur = builds.get('rifle');
  let ads = 1;

  function step() {
    const w = cur;
    w.root.visible = true;
    w.root.position.copy(w.hipPose.pos).lerp(w.adsPose.pos, ads);
    w.root.rotation.set(
      THREE.MathUtils.lerp(w.hipPose.rot.x, w.adsPose.rot.x, ads),
      THREE.MathUtils.lerp(w.hipPose.rot.y, w.adsPose.rot.y, ads),
      THREE.MathUtils.lerp(w.hipPose.rot.z, w.adsPose.rot.z, ads), 'YXZ');
    w.root.updateMatrixWorld(true);
    const info = collimate(w, cam, ads, null);
    renderer.render(scene, cam);
    return { reticle: info, triangles: renderer.info.render.triangles, calls: renderer.info.render.calls };
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    cam.aspect = w / h; cam.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  window.__sight = {
    setWeapon(id) { for (const b of builds.values()) b.root.visible = false; cur = builds.get(id) || cur; },
    setAds(v) { ads = v; },
    step,
    async flush() { flushMaterialBakes(); await new Promise((r) => setTimeout(r, 50)); step(); },
    /** Fraction of a centred disc that is NOT the weapon — i.e. see-through. */
    aperture(radiusFrac = 0.06) {
      const w = renderer.domElement.width, h = renderer.domElement.height;
      const R = Math.round(h * radiusFrac);
      const buf = new Uint8Array(R * 2 * R * 2 * 4);
      renderer.readRenderTargetPixels(null, 0, 0, 0, 0, null);
      const gl = renderer.getContext();
      gl.readPixels(Math.round(w / 2) - R, Math.round(h / 2) - R, R * 2, R * 2, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let inside = 0, board = 0;
      for (let y = 0; y < R * 2; y++) {
        for (let x = 0; x < R * 2; x++) {
          const dx = x - R, dy = y - R;
          if (dx * dx + dy * dy > R * R) continue;
          const i = (y * R * 2 + x) * 4;
          inside++;
          // The board is the only saturated red/green/white thing in the frame;
          // the weapon is desaturated metal. Chroma is therefore a clean test.
          const r = buf[i], g = buf[i + 1], b = buf[i + 2];
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (mx > 60 && mx - mn > 45) board++;
        }
      }
      return { inside, board, frac: inside ? board / inside : 0 };
    },
  };

  step();
  document.body.dataset.ready = '1';
}

boot().catch((e) => {
  errEl.style.display = 'block';
  errEl.textContent = `sight probe failure\n\n${e?.stack || e}`;
  console.error(e);
});
