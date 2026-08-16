import * as THREE from 'three';
import { Config, QualityTier } from '../core/Config.js';
import { whiteNoise, pinkNoise } from './Synth.js';
import { Mixer } from './Mixer.js';
import { WeaponAudio } from './WeaponAudio.js';
import { Foley } from './Foley.js';
import { Ambience } from './Ambience.js';
import { Music } from './Music.js';

/**
 * OWNER: audio agent.
 *
 * Fully procedural WebAudio engine — no sample assets, no network.
 *
 *   Mixer.js        buses, sends, dual-IR reverb, ear state, voice budget
 *   WeaponAudio.js  layered gunfire, mechanism, distance model, reload foley
 *   Foley.js        footsteps by surface and gait, impacts, explosions, UI
 *   Ambience.js     wind and town beds plus a Poisson event generator
 *   Music.js        three-layer adaptive score driven by combat intensity
 *
 * THREE THINGS THIS MODULE OWNS ITSELF
 *
 *  1. THE LISTENER. The WebAudio listener is slaved to the world camera every
 *     frame, orientation included, so a PannerNode placed at a world position is
 *     actually where the player hears it.
 *  2. THE SPACE PROBE. Nine rays from the head — eight around the horizon and
 *     one straight up — are cast at 3 Hz against the collision BVH. The mean
 *     free distance becomes an `openness` value that crossfades the reverb
 *     between a tight enclosed IR and a long street IR, and rolls the wind bed
 *     down when there is a roof overhead. It is the cheapest honest way to make
 *     a tail change when the player steps into an alley.
 *  3. COMBAT INTENSITY. Every shot, hit and near-miss pushes an accumulator the
 *     music layer reads, and the same number ducks the beds.
 *
 * The context is created suspended and resumed on the first user gesture, per
 * browser autoplay policy; until then every entry point is a cheap no-op.
 *
 * PUBLIC SURFACE (the HUD's settings pane uses these):
 *   `setVolume(bus, 0..1)` `volumes()` `setMusicEnabled(bool)`
 */

const PROBE_DIRS = [];
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  PROBE_DIRS.push([Math.sin(a), 0, Math.cos(a)]);
}
PROBE_DIRS.push([0, 1, 0]);

const TIERS = {
  [QualityTier.LOW]: { panning: 'equalpower', voices: 24, probeHz: 2 },
  [QualityTier.MEDIUM]: { panning: 'equalpower', voices: 36, probeHz: 3 },
  [QualityTier.HIGH]: { panning: 'HRTF', voices: 48, probeHz: 3 },
  [QualityTier.ULTRA]: { panning: 'HRTF', voices: 64, probeHz: 4 },
};

export class AudioModule {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.openness = 0.7;
    this._probeAcc = 0;
    this._intensity = 0;
    this._lastPos = { x: 0, y: 0, z: 0 };
  }

  async init(engine) {
    this.engine = engine;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; engine.audio = this; return; }

    const tier = TIERS[Config.quality] || TIERS[QualityTier.HIGH];
    this.tier = tier;

    this.ctx = new AC({ latencyHint: 'interactive' });
    this.mixer = new Mixer(this.ctx);
    this.mixer.voiceCap = tier.voices;

    // Two shared buffers for the whole game. Three seconds of white for
    // transients and tails, four of pink for the beds.
    this.white = whiteNoise(this.ctx, 3);
    this.pink = pinkNoise(this.ctx, 4);

    const opts = { panningModel: tier.panning };
    this.weaponAudio = new WeaponAudio(this.ctx, this.mixer, this.white, opts);
    this.foley = new Foley(this.ctx, this.mixer, this.white, opts);
    this.ambience = new Ambience(this.ctx, this.mixer, this.pink, this.white);
    this.music = new Music(this.ctx, this.mixer, this.white);

    this.collision = engine.get('collision');

    this._installGestureUnlock();
    this._bind(engine);

    engine.audio = this;
  }

  /* ------------------------------------------------------------- unlocking */

  _installGestureUnlock() {
    const resume = () => {
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      if (this.ctx.state === 'running' && !this.ready) {
        this.ready = true;
        this.ambience.start();
        this.music.start();
      }
    };
    this._resume = resume;
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    // Some browsers only flip to `running` a tick after resume() resolves.
    this.ctx.onstatechange = resume;
  }

  /* ----------------------------------------------------------------- events */

  _bind(engine) {
    const bus = engine.bus;

    /* --- the player's own weapon ------------------------------------------- */
    bus.on('weapon:fire', ({ weapon }) => {
      if (!this.ready) return;
      this.weaponAudio.fire({ weapon, position: null, distance: 0, volume: 1 });
      this._intensity = Math.min(1, this._intensity + 0.09);
    });
    bus.on('weapon:eject', ({ position }) => {
      if (this.ready) this.weaponAudio.shell(position);
    });
    bus.on('weapon:reload', ({ phase, weapon }) => {
      if (!this.ready) return;
      // 'start' has no sound of its own — the magazine release fires from the
      // animation a beat later, which is when a hand actually reaches it.
      if (phase === 'start' || phase === 'end') return;
      this.weaponAudio.reload(phase, weapon);
    });
    bus.on('weapon:switch', () => { if (this.ready) this.weaponAudio.reload('charge'); });

    /* --- generic sound requests -------------------------------------------- */
    bus.on('audio:play', (e) => this._play(e));

    /* --- hits --------------------------------------------------------------- */
    bus.on('hit:surface', ({ point, material, impulse }) => {
      if (!this.ready) return;
      this.foley.impact({ position: point, material, impulse, volume: 0.65 });
    });
    bus.on('hit:actor', ({ point, headshot }) => {
      if (!this.ready) return;
      this.foley.hitmarker(headshot ? 'head' : 'body');
      this.foley.impact({ position: point, material: 'flesh', impulse: 0.6, volume: 0.5 });
      this._intensity = Math.min(1, this._intensity + 0.05);
    });
    bus.on('actor:killed', ({ by }) => {
      if (!this.ready) return;
      if (by === 'player') this.foley.hitmarker('kill');
    });

    /* --- explosions --------------------------------------------------------- */
    bus.on('fx:explosion', ({ position, radius }) => {
      if (!this.ready) return;
      this.foley.explosion({ position, volume: 1 });
      // Concussion scales with how much of the blast radius the player is in.
      const d = position ? distance(position, this.engine.camera.position) : 999;
      const r = Math.max(4, radius || 7);
      const close = Math.max(0, 1 - d / (r * 2.6));
      if (close > 0.02) this.mixer.deafen(Math.min(0.9, close * close * 1.1));
      this._intensity = 1;
    });

    /* --- player body -------------------------------------------------------- */
    bus.on('player:footstep', ({ position, speed, stance }) => {
      if (!this.ready) return;
      this.foley.footstep({
        surface: this._surfaceUnder(position),
        gait: stance || 'walk',
        speed,
        position: null,
      });
    });
    bus.on('player:land', ({ impact, position }) => {
      if (this.ready) this.foley.land(impact, this._surfaceUnder(position));
    });
    bus.on('player:slide', ({ phase }) => { if (this.ready) this.foley.slide(phase === 'start'); });
    bus.on('player:mantle', ({ phase }) => { if (this.ready && phase === 'start') this.foley.mantle(); });
    bus.on('player:damaged', ({ amount }) => {
      this._intensity = Math.min(1, this._intensity + Math.min(0.4, amount / 60));
    });
    bus.on('player:died', () => { if (this.ready) this.foley.ui('bad'); });

    /* --- world contacts ----------------------------------------------------- */
    bus.on('ai:fire', ({ origin, hitPlayer }) => {
      if (!this.ready) return;
      this._intensity = Math.min(1, this._intensity + (hitPlayer ? 0.10 : 0.05));
      void origin;    // the shot itself arrives through audio:play 'enemy_fire'
    });

    /* --- ui ------------------------------------------------------------------ */
    bus.on('match:callout', ({ kind }) => {
      if (this.ready) this.foley.ui(kind === 'bad' ? 'bad' : kind === 'reward' ? 'reward' : 'streak');
    });
    bus.on('ui:vitals', ({ suppression }) => this.mixer?.suppress(suppression || 0));
  }

  /**
   * The `audio:play` catch-all. Ids that already have a dedicated path (the
   * player's own shot, explosions, footsteps) are ignored here so nothing is
   * ever triggered twice from two different events.
   */
  _play(e) {
    if (!this.ready || !this.enabled) return;
    const id = e?.id;
    if (!id) return;
    const pos = e.position || null;
    const vol = e.volume ?? 1;

    switch (id) {
      case 'enemy_fire': {
        const d = pos ? distance(pos, this.engine.camera.position) : 30;
        this.weaponAudio.fire({ weapon: 'rifle', position: pos, distance: d, volume: vol * 1.15 });
        break;
      }
      case 'bullet_crack':
        this.weaponAudio.whizz(vol, e.pitch || 1);
        // A round cracking past is the strongest single push on the score.
        this._intensity = Math.min(1, this._intensity + 0.12);
        break;
      case 'dry_fire': this.weaponAudio.dryFire(); break;
      case 'mag_release': this.weaponAudio.reload('magRelease'); break;
      case 'bolt_release': this.weaponAudio.reload('bolt'); break;
      case 'charge': this.weaponAudio.reload('charge'); break;
      case 'selector': this.weaponAudio.reload('selector'); break;
      case 'shell_bounce': this.weaponAudio.shell(pos); break;
      case 'grenade_throw': this.foley.throwGrenade(pos); break;
      case 'heartbeat': this.foley.heartbeat(vol, e.pitch || 1); break;
      case 'impact_flesh':
        this.foley.impact({ position: pos, material: 'flesh', impulse: 0.6, volume: vol });
        break;
      case 'mantle': this.foley.mantle(); break;
      case 'slide': this.foley.slide(true); break;
      case 'ui_click': this.foley.ui('click'); break;
      // Handled by a dedicated event; ignoring them here prevents double hits.
      case 'footstep': case 'explosion': break;
      default:
        if (id.endsWith('_fire')) break;                 // own weapon: 'weapon:fire'
        this.foley.impact({ position: pos, material: id, impulse: 0.5, volume: vol });
        break;
    }
  }

  /* ------------------------------------------------------------------- loop */

  update(dt, engine) {
    if (!this.ctx || !this.enabled) return;
    if (!this.ready) return;

    this._syncListener(engine);
    this.mixer.update(dt);

    /* --- environment probe --------------------------------------------------- */
    this._probeAcc += dt;
    const probeStep = 1 / (this.tier?.probeHz || 3);
    if (this._probeAcc >= probeStep) {
      this._probeAcc = 0;
      this._probeSpace(engine);
    }

    /* --- intensity ----------------------------------------------------------- */
    // Decays on its own; the music layer smooths it further, so this only needs
    // to be a rough energy estimate.
    this._intensity = Math.max(0, this._intensity - dt * 0.22);
    this.music.setIntensity(this._intensity);
    this.music.update(dt);
    this.ambience.intensity = this._intensity;
    this.ambience.update(dt);
    this.mixer.duck(this._intensity * 0.8);
  }

  /** Slave the WebAudio listener to the world camera, orientation included. */
  _syncListener(engine) {
    const l = this.ctx.listener;
    const cam = engine.camera;
    const p = cam.position;
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);

    if (l.positionX) {
      const t = this.ctx.currentTime;
      // A short ramp instead of a jump: teleporting the listener (respawn, or a
      // capture harness moving the camera) otherwise clicks in the panners.
      l.positionX.setTargetAtTime(p.x, t, 0.01);
      l.positionY.setTargetAtTime(p.y, t, 0.01);
      l.positionZ.setTargetAtTime(p.z, t, 0.01);
      l.forwardX.setTargetAtTime(_fwd.x, t, 0.01);
      l.forwardY.setTargetAtTime(_fwd.y, t, 0.01);
      l.forwardZ.setTargetAtTime(_fwd.z, t, 0.01);
      l.upX.setTargetAtTime(_up.x, t, 0.02);
      l.upY.setTargetAtTime(_up.y, t, 0.02);
      l.upZ.setTargetAtTime(_up.z, t, 0.02);
    } else if (l.setPosition) {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    }
  }

  /**
   * Nine rays from the head. The mean free path becomes `openness`; the upward
   * ray is weighted heavily because a roof is what actually changes a tail.
   */
  _probeSpace(engine) {
    if (!this.collision?.raycast) return;
    const origin = engine.camera.position;
    let sum = 0, weight = 0;
    for (let i = 0; i < PROBE_DIRS.length; i++) {
      const d = PROBE_DIRS[i];
      _dir.set(d[0], d[1], d[2]);
      const hit = this.collision.raycast(origin, _dir, 34);
      const dist = hit ? hit.distance : 34;
      const w = i === PROBE_DIRS.length - 1 ? 3 : 1;      // the up-ray counts triple
      sum += Math.min(1, dist / 26) * w;
      weight += w;
    }
    const openness = sum / weight;
    this.openness += (openness - this.openness) * 0.35;
    this.mixer.setSpace(this.openness);
    this.weaponAudio.setSpace(this.openness);
    this.ambience.setSpace(this.openness);
  }

  /**
   * What is under a point. One short downward ray against the collision BVH —
   * roughly twice a second while walking, so the cost is irrelevant and the
   * footstep is right.
   */
  _surfaceUnder(position) {
    if (!position || !this.collision?.raycast) return 'default';
    _from.set(position.x, position.y + 0.4, position.z);
    const hit = this.collision.raycast(_from, _down, 3.0);
    const m = hit?.object?.material;
    if (!m) return 'default';
    if (Array.isArray(m)) return m[0]?.userData?.preset || 'default';
    return m.userData?.preset || 'default';
  }

  /* ----------------------------------------------------------------- public */

  setVolume(bus, value) { return this.mixer ? this.mixer.setLevel(bus, value) : value; }
  volumes() { return this.mixer ? this.mixer.volumes() : {}; }
  setMusicEnabled(on) { if (this.music) this.music.enabled = on; }

  /** Legacy entry points kept so older call sites keep working. */
  gunshot(volume = 1) { if (this.ready) this.weaponAudio.fire({ weapon: 'rifle', volume }); }
  impact(volume = 0.5) { if (this.ready) this.foley.impact({ volume }); }
  hitmarker(kill) { if (this.ready) this.foley.hitmarker(kill ? 'kill' : 'body'); }
  explosion() { if (this.ready) this.foley.explosion({ volume: 1 }); }

  dispose() {
    window.removeEventListener('pointerdown', this._resume);
    window.removeEventListener('keydown', this._resume);
    this.ambience?.dispose();
    this.music?.dispose();
    this.mixer?.dispose();
    this.ctx?.close().catch(() => {});
  }
}

/* Scratch vectors — this module runs every frame and must not allocate. */
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _from = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

function distance(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
