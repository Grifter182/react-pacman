import * as THREE from 'three';
import { Config } from '../core/Config.js';

/**
 * OWNER: lighting / shadows agent.
 * Sun (directional) + hemisphere fill + the cascaded shadow map rig.
 * Baseline uses a single tight directional shadow; the CSM implementation
 * belongs in `src/world/CascadedShadows.js` and should replace `_makeSun`.
 */
export class LightingModule {
  constructor() {
    this.sun = null;
    this.hemi = null;
  }

  async init(engine) {
    const gfx = Config.gfx;

    const sun = new THREE.DirectionalLight(0xfff0dd, 3.4);
    const d = engine.sunDirection || new THREE.Vector3(0.4, 0.6, -0.7);
    sun.position.copy(d).multiplyScalar(120);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(gfx.shadowMapSize, gfx.shadowMapSize);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 320;
    const ext = 70;
    sun.shadow.camera.left = -ext;
    sun.shadow.camera.right = ext;
    sun.shadow.camera.top = ext;
    sun.shadow.camera.bottom = -ext;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 2.4;
    sun.shadow.blurSamples = 12;
    engine.scene.add(sun);
    engine.scene.add(sun.target);
    this.sun = sun;
    engine.sun = sun;

    const hemi = new THREE.HemisphereLight(0x9dbbe0, 0x2a2823, 0.55);
    engine.scene.add(hemi);
    this.hemi = hemi;

    // Distance fog tuned to the sky horizon so the world dissolves cleanly.
    engine.scene.fog = new THREE.FogExp2(0x8b97a6, 0.0038);
  }

  update(dt, engine) {
    // Keep the shadow frustum following the player.
    if (!this.sun) return;
    const p = engine.camera.position;
    const d = engine.sunDirection;
    this.sun.target.position.set(p.x, 0, p.z);
    this.sun.position.set(p.x + d.x * 120, d.y * 120, p.z + d.z * 120);
    this.sun.target.updateMatrixWorld();
  }

  dispose() {}
}
