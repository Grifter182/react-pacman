export const meta = {
  name: 'blackout-round1',
  description: 'Deepen each FPS subsystem to AAA fidelity, then critique the result harshly',
  phases: [
    { title: 'Build', detail: 'domain agents deepen their owned subsystem' },
    { title: 'Capture', detail: 'headless screenshot pass over the integrated build' },
    { title: 'Critique', detail: 'adversarial art-director review against shipped-FPS reference' },
  ],
};

const REPO = '/home/user/react-pacman';

const COMMON = `
You are working in the Three.js FPS project at ${REPO}.

MANDATORY READING before you write any code:
  1. ${REPO}/AGENTS.md          — the working agreement, quality bar, hard rules
  2. ${REPO}/src/core/Engine.js — the module contract (hooks, shared state, events)
  3. ${REPO}/src/core/Config.js — quality tiers; gate anything expensive here

HARD RULES
- Edit ONLY the files listed as yours. Other agents are editing other files in
  the same working tree AT THE SAME TIME. Touching their files loses work.
- New files must live inside your own directory and be imported from your own
  entry point. Do NOT edit src/main.js — every module is already registered.
- Dependencies are frozen: three + three-mesh-bvh. No network fetches at
  runtime, no external images/fonts/audio. Everything procedural.
- Run \`cd ${REPO} && npx vite build\` before you finish. A broken build blocks
  everyone. If it fails, fix it — do not leave it red.
- Do NOT run git commit, git checkout, git stash, or git reset. The orchestrator
  handles version control. You would clobber concurrent agents.
- Do NOT run the screenshot harness unless your task says to — it saturates the
  CPU and other agents are running. Reason from the code and from the build.

Write production-quality code: real algorithms, not placeholders. Comment the
non-obvious physical/graphical reasoning, not the syntax. Match the existing
code style (ES modules, JSDoc-style block comments on classes, terse inline
comments only where intent is not obvious).

Your final message is a report consumed by an orchestrator, not a human. Return
a compact summary: what you implemented, files touched, build status, and any
integration risk another agent should know about.
`;

const TASKS = [
  {
    key: 'postfx',
    label: 'render/post-processing',
    files: 'src/render/PostStack.js and any new files under src/render/',
    brief: `
Build the full HDR post-processing chain. Currently PostStack.js only does an
HDR target + ACES + grain + vignette. Implement, in a correct order, with each
effect gated on Config.gfx:

- Depth + view-normal prepass (you may render the scene with an override
  material into an RG/RGBA target) — needed by AO, SSR and DOF.
- GTAO or a high-quality horizon-based AO with a bilateral/edge-aware blur.
  Half-res with a depth-aware upsample. This is the single biggest contributor
  to "grounded" AAA look — get it right.
- Screen-space reflections for the metal/wet surfaces (Config.gfx.ssr), with
  roughness-aware ray march, edge fade and a fallback to the IBL probe.
- Bloom: physically-motivated, energy-preserving, progressive dual-filter
  downsample/upsample mip chain (Config.gfx.bloomMips), threshold in the
  karis-average style to avoid fireflies. Subtle — it should read as lens
  scatter, not a glow filter.
- TAA: jitter the projection matrix with a Halton sequence, reproject with
  velocity, neighbourhood colour clamping, and a disocclusion fallback. You
  will need a velocity buffer. Expose engine-level jitter so the camera module
  is unaffected. If full TAA proves unstable, ship a high-quality SMAA instead
  and say so — do not ship something that ghosts.
- Camera motion blur from the velocity buffer.
- Depth of field: only a subtle near/far bokeh, tuned so ADS focuses the target.
- Colour grading: filmic tonemap (keep ACES), then a 3D LUT applied from a
  procedurally generated neutral-plus-teal/orange grade, lift/gamma/gain, and
  saturation control. Modern military shooters are desaturated with a cool
  shadow bias and warm highlights — match that.
- Lens artefacts LAST and SUBTLE: chromatic aberration at the edges only,
  anamorphic-ish streak on very bright pixels, dirt-mask bloom on the sun,
  film grain that scales with luminance, vignette.
- Sharpening (CAS-style) as the final step before present.

Also implement automatic exposure (eye adaptation) from a downsampled luminance
mip with a slow adaptation curve, clamped so the image never pumps.

PostStack must keep exposing composite(engine, renderer) as the single entry
point called by RenderModule. Do not rename it and do not add a method named
\`render\` — the engine calls render() on every module and would double-drive
you. Keep resize(w,h) correct for every target you allocate.`,
  },
  {
    key: 'skylight',
    label: 'sky/atmosphere/lighting',
    files: 'src/world/SkyModule.js, src/world/LightingModule.js, and any new files under src/world/',
    brief: `
Own the atmosphere and the light rig — the two things that most determine
whether a frame reads as AAA.

SKY (SkyModule.js): replace the hand-tuned gradient with a real
Preetham/Hosek-Wilkie style analytic sky, or a single-scattering Rayleigh +
Mie integration. It must produce: correct horizon brightening, Mie forward
scattering around the sun, ozone absorption giving the deep blue zenith, a
physically-sized sun disc with limb darkening, and a believable sunset/dusk if
the sun elevation is lowered. Add layered volumetric-looking clouds (procedural
FBM/curl noise, cheap raymarch or a good parallax-mapped dome) — an empty sky
looks like a tech demo.

Keep the current bake-to-cubemap approach: the visible sky and the IBL
environment must be the same pixels. Keep scene.background and scene.environment
both driven from that bake, and keep engine.sunDirection / engine.sunColor
published for LightingModule.

Pick a time of day that flatters the art: low-ish golden sun gives long shadows
and strong form. Make the choice deliberately and say why in a comment.

LIGHTING (LightingModule.js): implement proper cascaded shadow maps —
Config.gfx.shadowCascades splits with practical/logarithmic distribution,
stabilised (texel-snapped) cascades so shadows do not swim when the camera
moves, per-cascade bias, PCF or PCSS filtering with a contact-hardening
penumbra, and a smooth cascade blend band. The current single tight
directional shadow is placeholder.

Add: a fill/bounce approximation consistent with the sky (hemisphere or SH
irradiance from the same cubemap, not an arbitrary HemisphereLight colour),
correct fog that matches the sky at the horizon so geometry dissolves into the
background rather than into a flat grey, and height fog. Fog must also be
applied to (or matched by) the background so there is no hard seam at the
horizon — that seam is currently visible and is a bug you own.

Expose a small API other modules can use to add pooled dynamic lights
(muzzle flash, explosions) without exceeding a light budget.`,
  },
  {
    key: 'materials',
    label: 'procedural materials',
    files: 'src/materials/ (TextureFactory.js and any new files)',
    brief: `
Own every surface's look. Current TextureFactory generates 512px value-noise
FBM and derives a normal/AO — it is far below bar and reads as blurry mush at
close range.

Deliver a real procedural material library:
- Better noise: gradient (Perlin/simplex) noise, Worley/cellular for cracks and
  pebbles, domain warping, ridged multifractal. All tileable.
- Detail/macro variation: a low-frequency macro breakup so surfaces do not tile
  visibly at distance, plus a high-frequency detail normal blended in the
  shader (detail maps) so surfaces hold up at 30cm. Use onBeforeCompile to
  inject a detail-normal and triplanar path into MeshStandardMaterial rather
  than baking everything into one resolution.
- Real material recipes, each convincing at 30cm and at 40m: cracked concrete,
  weathered plaster with exposed brick, rusted/painted steel, corrugated metal,
  sand/gravel ground, asphalt with painted lines, wood planking, sandbags,
  ceramic tile, glass, rubber, canvas/fabric, and a gun-metal for weapons.
- Physically sane values: correct sRGB vs linear on every map, albedo inside
  real-world reflectance bounds (no pure black, no pure white), metalness
  strictly 0 or 1 with rust masks blending to dielectric, roughness driven by
  the same masks so wear reads correctly.
- Edge wear and cavity dirt derived from curvature, not random noise.
- Generate on a worker-free but chunked path so boot does not block for
  seconds; cache aggressively (the cache is already keyed).

Keep makeMaterial(preset, opts) as the single entry point — LevelModule,
WeaponModule and AiModule all call it. Adding presets is fine; removing or
renaming existing ones ('concrete', 'metal', 'sand', 'plaster') is not.
Add a getMaterialCatalog() export listing available presets so other agents
can discover what exists.`,
  },
  {
    key: 'level',
    label: 'level art',
    files: 'src/level/ (LevelModule.js and any new files)',
    brief: `
Own the map. It is currently untextured grey boxes on a plane — the single most
obviously non-AAA thing in the build.

Design and build one small, dense, readable multiplayer map in the spirit of a
modern military shooter's 6v6 arena: a Middle-Eastern market/compound with
three lanes, hard cover, two flanks, a raised centre, and clear sightline
control. Real level design: no symmetric box farm.

Requirements:
- A modular kit built in code: wall segments with chamfered edges, doorways,
  window openings, arches, stairs, railings, roof trim, pillars, awnings.
  Nothing is an untrimmed cube — every silhouette gets a chamfer or a moulding.
- Set dressing at density: crates, barrels, sandbag walls, jersey barriers,
  pallets, market stalls with cloth, hanging rugs and cables, pipes, AC units,
  rubble piles, sign boards, tyres, parked civilian vehicles (blocked out but
  chamfered and detailed), scattered debris. Use InstancedMesh and merge static
  geometry aggressively — target well under 400 draw calls.
- Vertex-colour or mask-driven blending between materials (dirt accumulating in
  corners, water staining below windows) rather than uniform tiling.
- Foliage: a few palms/scrub with instanced, alpha-tested cards and gentle wind
  in the vertex shader.
- Correct scale everywhere: doors 2.1m, walls 3m per storey, cover at 1.1m
  (crouch) and 1.5m (stand). Player is 1.75m — measure against that.
- Light the interiors: place emissive fixtures and register pooled point lights
  so interiors are not black holes.
- Keep this.spawnPoints (with team 0/1) and this.bounds populated, and keep
  handing a single merged collision mesh to CollisionModule.build(). Collision
  geometry should be a simplified proxy, not the render geometry — build a
  separate simplified collision set so the BVH stays fast.

Ask the materials agent's catalogue for surfaces via makeMaterial(); if a
preset you want does not exist yet, use the closest one that does and leave a
TODO naming the preset you want.`,
  },
  {
    key: 'weapons',
    label: 'weapons + viewmodel',
    files: 'src/weapons/ (WeaponModule.js and any new files)',
    brief: `
Own the gun — in an FPS it occupies a fifth of the screen at all times, so it
carries a disproportionate share of the perceived quality.

Model: replace the six-box blockout with a properly detailed procedural
carbine built from lathed/extruded profiles — receiver with panel lines and
chamfers, free-float rail with slots, barrel with a flash hider, adjustable
stock, pistol grip, magazine with floorplate, charging handle, ejection port
with a working cover, bolt catch, safety selector, sling loops, and a red-dot
optic with a housing, glass and a real emissive reticle that stays screen-fixed
under parallax. Add first-person arms/gloves (blocked out but properly shaped,
with correct hand placement on grip and handguard).

Animation — all procedural, all layered, nothing snapping:
- Idle breathing and micro-drift.
- Weapon sway with spring damping and inertia that lags the camera.
- Walk/sprint bob as an additive layer with foot-plant timing.
- ADS blend along a curve, not a lerp, with the optic aligning exactly to
  screen centre. Sensitivity and FOV changes are already handled elsewhere.
- Recoil: a real per-weapon recoil pattern (vertical climb with a horizontal
  drift that is deterministic per shot index, like a real spray pattern),
  visual kick decoupled from aim punch, and smooth recovery.
- Reload: a full tactical and empty-reload sequence — mag out, mag in, bolt
  release on empty — driven by a keyframed procedural clip system you write.
- Inspect, draw, holster, sprint-lower and mantle-lower poses.
- Shell casing ejection with correct timing (emit an event; the VFX agent owns
  the particles).

Ballistics: damage falloff by range, per-limb multipliers, penetration through
thin surfaces with damage reduction, and a first-shot-accuracy model.

Add at least three weapons (assault rifle, SMG, sniper/DMR with a scope
overlay) with genuinely different handling, and weapon switching on 1/2/3.
Keep the WEAPONS export and the muzzle Object3D — VFX and audio depend on them.
Keep firing driven by the existing 'input:fire' bus event and keep emitting
'weapon:fire' with { weapon, origin, direction, hit }.`,
  },
  {
    key: 'vfx',
    label: 'VFX + particles',
    files: 'src/fx/ (FxModule.js and any new files)',
    brief: `
Own everything transient. Current FX are a single additive tracer, one flat
quad decal and a sprite flash — placeholder.

Build a real GPU-driven effects system:
- A pooled, instanced particle engine with per-particle lifetime, velocity,
  drag, gravity, turbulence (curl noise), size/colour/alpha over life curves,
  soft-particle depth fade against the depth buffer, and optional lit
  particles. Budget from Config.gfx.particleBudget. Zero per-frame allocation.
- Muzzle flash: a real multi-element flash (star, core bloom, barrel smoke
  puff) that varies per shot, plus a pooled dynamic light with a fast falloff,
  and heat-haze distortion if you can do it cheaply.
- Impacts by surface type: concrete puff + spall + dust, metal sparks with
  ballistic arcs and light emission, sand plumes, wood splinters, glass shards,
  water splash, and blood mist for actor hits. Drive the variant from the
  'hit:surface' material field.
- Bullet holes as real projected decals (not camera-facing quads) with correct
  orientation to the surface normal, per-material appearance, normal-mapped
  craters, fading with age, and a proper ring buffer at Config.gfx.decalBudget.
- Tracers that are stretched, fade over distance, only appear on some rounds,
  and travel at a believable speed rather than appearing instantly.
- Smoke: volumetric-looking billboards with depth fade, curl-noise advection
  and self-shadowing approximation, for grenades and lingering explosion smoke.
- Explosions: a full sequence — flash, fireball with expanding shell, shockwave
  distortion ring, debris chunks with physics, dust wave, lingering smoke —
  plus the screen shake and light already wired to 'fx:explosion'.
- Shell casings: physics-driven ejection with bounce and a metallic ping
  (emit an audio event; the audio agent owns the sound).
- Environmental ambience: floating dust motes in sun shafts, wind-blown sand.

Keep listening to the existing bus events and keep engine.fx exposed.`,
  },
  {
    key: 'feel',
    label: 'player feel + AI',
    files: 'src/player/ (PlayerModule.js and new files), src/ai/ (AiModule.js and new files)',
    brief: `
Own how the game FEELS to play and who the player fights. You own two
directories; treat them as one job because the AI must be readable through the
same camera the player feels.

PLAYER (src/player/):
- Refine the controller: proper acceleration/deceleration curves, air control,
  surfing prevention, step-up over small ledges without a camera pop,
  slope handling with slide-off above the max angle, crouch/prone transitions,
  and a real slide with momentum preservation and a cooldown.
- Mantling/vaulting over waist-high cover with an IK-ish camera arc.
- Camera: separate the camera from the capsule with a spring so landings,
  slides and recoil read as weight. Layered head bob with foot-plant timing,
  landing dip proportional to impact, subtle roll on strafe, breathing sway
  while aiming that increases when the player is hurt or has been sprinting.
- Camera shake as a proper trauma model (trauma value decaying, shake =
  trauma^2 driven by Perlin noise on 3 axes) rather than random jitter.
- Damage feedback: directional indicators (emit events for the UI agent),
  desaturation and heartbeat at low health, a slow recovery curve.
- Add gamepad support and configurable sensitivity/FOV.

AI (src/ai/):
- Generate a navmesh from the level's collision geometry at boot (voxelise +
  region growing is fine; do not hand-author it — the level changes).
  A* over it with funnel-algorithm string pulling and local avoidance.
- A behaviour tree or HFSM: idle/patrol → suspicious → search last-known
  position → engage → take cover → suppress → flank → reposition → retreat.
  Bots must use the map's cover, peek and re-peek, and not run at the player
  in a straight line.
- Perception: a real FOV cone plus hearing (gunshots, footsteps), with a
  visibility accumulator so spotting is not instantaneous, and memory of the
  player's last known position.
- Combat: burst fire with reaction time, aim error that converges over time,
  suppression that pins the player, grenades to flush cover, and difficulty
  scaling that adjusts reaction time and accuracy rather than health.
- Characters: replace the capsule+sphere with a proper blocked-out soldier —
  helmet, plate carrier, limbs — built from procedural geometry with a real
  skeleton, plus procedural locomotion (walk/run/crouch blends, foot IK to the
  ground, torso aiming toward the target, hit reactions, and a ragdoll or
  procedural death fall). Add per-limb hitboxes and keep publishing
  'hit:actor' and 'actor:killed' exactly as now.

Keep engine.player, player.state and engine.ai / ai.actors shapes intact —
the HUD, weapons and match modules all read them.`,
  },
  {
    key: 'ui',
    label: 'HUD + menus + audio',
    files: 'src/ui/ (HudModule.js and new files), src/audio/ (AudioModule.js and new files), src/game/ (MatchModule.js and new files)',
    brief: `
Own the presentation layer and the moment-to-moment game feel around combat.

HUD (src/ui/): the current HUD is a reasonable skeleton but reads as a web page,
not a game. Rebuild it to modern-military-shooter standards:
- A proper visual language: condensed type, tight tracking, thin rules, subtle
  chromatic edges, everything on a consistent grid, all animation eased.
- Dynamic crosshair that reflects the real weapon spread value (read it from
  the weapons module rather than approximating), hit markers that differentiate
  body/headshot/kill, and directional damage indicators.
- Ammo/health with damage-state transitions, a low-ammo state, and reload
  progress. A minimap with rotating heading, level geometry drawn from the
  level bounds, and enemy blips on fire events. A compass. A killfeed with
  weapon icons drawn as inline SVG. Objective and streak callouts.
- Full front-end: a title screen, loadout/weapon select, settings (sensitivity,
  FOV, quality tier — wire these to Config), pause menu, scoreboard on TAB, and
  an end-of-match summary. A proper loading screen that shows real progress
  while procedural generation runs, instead of the current blank canvas.
- Keep it all DOM+CSS in #ui, driven by bus events. Never allocate DOM per frame.

AUDIO (src/audio/): the procedural synth engine is a decent start. Take it
further: layered weapon sounds per weapon with a mechanical layer, a tail that
varies with the environment, distance-based low-pass and delay for far shots,
true 3D positional audio via PannerNode for actors and impacts, footsteps that
vary with surface material and gait, reload foley synced to the weapon
animation events, bullet whizz-by, suppression ringing, a low-health heartbeat
and tinnitus after explosions, ambient wind/market beds, and a dynamic music
layer that responds to combat intensity. Add a mixer with per-bus volume.

MATCH (src/game/): flesh out the match loop — team deathmatch with bots on both
sides, score, streaks with actual rewards (UAV revealing blips, airstrike),
spawn logic that avoids spawning players in front of enemies, round timer,
overtime, and the end-of-match flow feeding the UI summary.`,
  },
];

/* ------------------------------------------------------------------ build */

phase('Build');
log(`Deepening ${TASKS.length} subsystems in parallel (2 concurrent slots on this host)`);

const built = await parallel(TASKS.map((t) => () =>
  agent(
    `${COMMON}\n\nYOUR TASK: ${t.label}\nYOU OWN: ${t.files}\n${t.brief}`,
    { label: `build:${t.key}`, phase: 'Build' }
  ).then((r) => ({ key: t.key, label: t.label, report: r }))
));

const ok = built.filter(Boolean);
log(`${ok.length}/${TASKS.length} subsystem agents reported back`);

/* ---------------------------------------------------------------- capture */

phase('Capture');

const capture = await agent(
  `Integration + capture pass for the Three.js FPS at ${REPO}.

Seven agents just edited different subsystems of this repo concurrently. Your
job is to make the integrated build actually run, then capture it.

1. cd ${REPO} && npx vite build
   Fix every error. Typical breakage after a concurrent edit round: a module
   renamed an export another module imports, two modules both defined a helper
   with the same name in a shared file, or a module now calls an engine hook
   that does not exist. Read ${REPO}/src/core/Engine.js for the contract.
   You MAY edit any file to fix build/runtime breakage, but make the SMALLEST
   change that restores the contract — do not rewrite another agent's work.

2. Capture:
   cd ${REPO} && PW_CHROMIUM=/opt/pw-browsers/chromium node tools/screenshot.mjs --out shots/round1
   This takes several minutes under software rasterisation. Be patient; do not
   kill it. If the harness reports a BOOT-FAILURE or the console log contains
   pageerrors, FIX THEM and re-capture. Repeat until shots/round1/console.log
   is free of errors and pageerrors.

3. Read several of the PNGs in shots/round1/ with the Read tool and confirm they
   are actually rendering the game (not black, not a single flat colour, not
   the boot-failure page).

Report: build status, the exact console errors you fixed and how, the render
stats from shots/round1/manifest.json (draw calls / triangles), and an honest
one-paragraph description of what the frames actually look like.`,
  { label: 'integrate+capture', phase: 'Capture' }
);

/* --------------------------------------------------------------- critique */

phase('Critique');

const LENSES = [
  {
    key: 'lighting',
    focus: `Lighting, exposure, value structure and atmosphere. Is there a real
tonal range — true blacks, held highlights, colour in the shadows? Do shadows
have correct softness and contact darkening? Does the frame have atmospheric
depth, or is it flat? Is the grade deliberate or accidental?`,
  },
  {
    key: 'materials',
    focus: `Surfaces and materials. Does every surface read as a specific
physical material? Is there normal detail, roughness breakup, edge wear, dirt?
Any visible tiling, any untextured or flat-colour surface, any plastic-looking
PBR? Do materials hold up both close and far?`,
  },
  {
    key: 'composition',
    focus: `Level art, silhouettes and composition. Is there foreground /
midground / background layering? Are silhouettes interesting or are things
still boxes? Is set-dressing density believable? Is scale correct against a
1.75m player? Does it look like a designed place or a programmer's test arena?`,
  },
  {
    key: 'gamefeel',
    focus: `The FPS presentation specifically: the weapon viewmodel's model
quality and screen placement, muzzle flash and impact VFX, HUD typography and
layout, crosshair, and general "does this look like a shipped shooter's
screenshot". Judge the viewmodel harshly — it is a fifth of the screen.`,
  },
];

const critiques = await parallel(LENSES.map((l) => () =>
  agent(
    `You are a hostile, extremely experienced art director reviewing screenshots
from an in-development browser FPS. You have shipped multiple AAA console
shooters. Your standard of comparison is a marketing screenshot from a recent
Call of Duty campaign.

Look at EVERY PNG in ${REPO}/shots/round1/ using the Read tool. Actually look at
them — do not review from the code.

YOUR LENS: ${l.focus}

Be brutal and be specific. Vague praise is worthless and vague criticism is
unactionable. For every problem, name the exact file(s) in ${REPO}/src that
must change and what specifically must be done. You may read source files to
ground your recommendations, but your verdict must come from the images.

You must answer this question explicitly and honestly: if this screenshot were
placed side by side with a Call of Duty screenshot with no labels, would a
player be able to tell which is which instantly? If yes — and it almost
certainly is yes — say exactly what gives it away, ranked by how badly it
gives it away.

Return:
  VERDICT: one paragraph, unsparing.
  TELLS: ranked list of what instantly betrays this as not-AAA.
  ACTIONS: numbered, specific, file-scoped work items, hardest-hitting first.
  SCORE: an integer 0-100 where 100 is indistinguishable from shipped CoD.
         Be stingy. A competent hobby project is 25.`,
    { label: `critique:${l.key}`, phase: 'Critique', schema: {
      type: 'object',
      required: ['verdict', 'tells', 'actions', 'score'],
      properties: {
        verdict: { type: 'string' },
        tells: { type: 'array', items: { type: 'string' } },
        actions: { type: 'array', items: {
          type: 'object',
          required: ['file', 'action', 'severity'],
          properties: {
            file: { type: 'string' },
            action: { type: 'string' },
            severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          },
        } },
        score: { type: 'integer' },
      },
    } }
  ).then((r) => ({ lens: l.key, ...r }))
));

const scored = critiques.filter(Boolean);
const avg = scored.length
  ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length)
  : 0;
log(`Round 1 average AAA score: ${avg}/100`);

return {
  round: 1,
  averageScore: avg,
  scores: scored.map((c) => ({ lens: c.lens, score: c.score })),
  critiques: scored,
  capture,
  buildReports: ok.map((b) => ({ key: b.key, report: String(b.report).slice(0, 1500) })),
};
