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

/* --- flat stand-in maps for `__probe.isolate` --------------------------- */
function solid(r, g, b, srgb = false) {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1, THREE.RGBAFormat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
const FLAT_GREY = solid(128, 128, 128, true);
const FLAT_NORMAL = solid(128, 128, 255);
const FLAT_ARM = solid(255, 160, 0);          // AO 1, roughness 0.63, metal 0

/**
 * UV reference grid: 8 checks per tile with the origin quadrant tinted, so a
 * frame shows tile size, tile orientation, seams and any shear directly on the
 * part. A texel-scale complaint that survives this image is not a UV problem.
 */
const CHECKER = (() => {
  const N = 256, d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const c = ((x >> 5) + (y >> 5)) & 1 ? 210 : 40;
      const edge = (x & 31) === 0 || (y & 31) === 0;
      d[i] = edge ? 255 : c;
      d[i + 1] = edge ? 40 : c;
      d[i + 2] = edge ? 40 : (x < N / 2 && y < N / 2 ? Math.min(255, c + 90) : c);
      d[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
})();

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
    /** Hide the hands, so a complaint about the weapon is about the weapon. */
    setArms(on) { for (const b of builds.values()) b.arms.root.visible = !!on; },
    async flush() { flushMaterialBakes(); await materialsReady(); },
    /**
     * Replace one PBR layer on every viewmodel material and re-render.
     *
     * "The receiver looks like digital camouflage" is a claim about *which map*
     * is misbehaving, and there are only four candidates. Turning them off one
     * at a time answers it in four frames; reasoning about it from a screenshot
     * of a city does not answer it at all.
     *
     * A layer may not simply be set to `null`. `applySurfaceShader` injects
     * chunks that sample `map` and `roughnessMap` unconditionally, so dropping
     * either one fails to compile and the mesh silently renders nothing — which
     * is a diagnostic that answers a different question than the one asked.
     * Each layer is therefore *replaced* with a flat stand-in of the same type,
     * and 'checker' swaps the albedo for a UV reference grid so the projection
     * itself can be read off the surface.
     */
    isolate(layer) {
      for (const m of [...gunMats, ...armMats]) {
        if (!m.isMeshStandardMaterial) continue;
        const u = m.userData;
        if (!u.__orig) u.__orig = { map: m.map, normalMap: m.normalMap, aoMap: m.aoMap };
        const o = u.__orig;
        // Clone the STAND-IN and copy the original's tiling onto it. Cloning
        // the original and reassigning `.image` would look equivalent and is
        // not: `Texture#image` proxies `source.data`, and `clone()` shares the
        // source, so that writes the stand-in into the real baked texture and
        // every later 'full' render is quietly still showing the stand-in.
        const sub = (t, flat) => {
          if (!t) return t;
          const c = flat.clone();
          c.repeat.copy(t.repeat);
          c.wrapS = t.wrapS; c.wrapT = t.wrapT;
          c.needsUpdate = true;
          return c;
        };
        m.map = layer === 'flatalbedo' ? sub(o.map, FLAT_GREY)
          : layer === 'checker' ? sub(o.map, CHECKER) : o.map;
        m.normalMap = layer === 'flatnormal' ? sub(o.normalMap, FLAT_NORMAL) : o.normalMap;
        m.aoMap = m.roughnessMap = m.metalnessMap =
          layer === 'flatarm' ? sub(o.aoMap, FLAT_ARM) : o.aoMap;
        // The ARM map packs three unrelated fields into one texture, so
        // "it is the ARM map" is not yet an answer. AO is separable without a
        // second texture, because its strength is a plain material scalar.
        m.aoMapIntensity = layer === 'noao' ? 0 : 1;
        m.needsUpdate = true;
      }
      // The optic's lenses are alpha-blended with depth writes off, so anything
      // odd on the bell rim has to be shown to be the housing before the
      // housing is modified.
      for (const m of [gunMats[5], gunMats[6]]) {
        if (m) m.visible = layer !== 'noglass';
      }
      return layer;
    },

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
    /**
     * Screen coverage broken down by the part that produced it.
     *
     * The merged body is one buffer, so "the buttstock is too big" is not
     * checkable against the scene graph — there is no buttstock node. `Kit`
     * stamps a provenance range per part into `geometry.userData.parts`, and
     * this walks those ranges, which turns a framing argument into a table.
     */
    silhouetteByPart() {
      const b = builds.get(current);
      frame();
      b.root.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      const acc = new Map();
      b.root.traverse((o) => {
        if (!o.isMesh || o === b.reticle) return;
        const parts = o.geometry.userData.parts
          || [{ label: o.name || 'mesh', start: 0, count: o.geometry.attributes.position.count }];
        const pos = o.geometry.attributes.position;
        for (const p of parts) {
          let a = acc.get(p.label);
          if (!a) { a = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, n: 0 }; acc.set(p.label, a); }
          for (let i = p.start; i < p.start + p.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
            if (-v.z < cam.near) continue;
            v.applyMatrix4(cam.projectionMatrix);
            a.x0 = Math.min(a.x0, v.x); a.x1 = Math.max(a.x1, v.x);
            a.y0 = Math.min(a.y0, v.y); a.y1 = Math.max(a.y1, v.y);
            a.n++;
          }
        }
      });
      const out = {};
      for (const [k, a] of acc) {
        if (!a.n) continue;
        const w = Math.min(1, a.x1) - Math.max(-1, a.x0);
        const h = Math.min(1, a.y1) - Math.max(-1, a.y0);
        out[k] = {
          areaFrac: +Math.max(0, w * h / 4).toFixed(4),
          ndc: [+a.x0.toFixed(2), +a.y0.toFixed(2), +a.x1.toFixed(2), +a.y1.toFixed(2)],
        };
      }
      return out;
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
