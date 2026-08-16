export const meta = {
  name: 'blackout-round2',
  description: 'Fix every critical finding from the round-1 art-director review, then re-review',
  phases: [
    { title: 'Fix', detail: 'domain agents work their ranked critical findings' },
    { title: 'Capture', detail: 'integrate, verify no console errors, re-shoot' },
    { title: 'Critique', detail: 'same four lenses re-score, plus a blind forced-choice test' },
  ],
};

const REPO = '/home/user/react-pacman';

const COMMON = `
You are working in the Three.js FPS project at ${REPO}.

READ FIRST: ${REPO}/AGENTS.md and ${REPO}/src/core/Engine.js (module contract).

CONTEXT — this is round 2. Round 1 built the subsystems; four hostile art
directors then reviewed the captured frames and scored the result 11/100
against a shipped Call of Duty screenshot. Below are THEIR findings for your
area. They looked at real captured frames. Treat every finding as true unless
you can prove otherwise from the code, and if you disprove one, say so
explicitly in your report with the evidence.

Fix the CRITICAL items first and completely. Do not start cosmetic work while a
critical item is open.

HARD RULES
- Edit ONLY your owned files. Other agents are editing other files in this same
  working tree right now.
- Do NOT edit src/main.js, src/core/Engine.js, src/core/Config.js or
  tools/screenshot.mjs — the orchestrator owns those.
- Dependencies frozen: three + three-mesh-bvh. No network at runtime.
- Run \`cd ${REPO} && npx vite build\` before finishing. Never leave it red.
- No git commands. The orchestrator handles version control.
- Do NOT run the screenshot harness — it saturates the CPU and other agents are
  running concurrently.

ALREADY FIXED BY THE ORCHESTRATOR — do not redo, and do not undo:
- Motion blur is now frame-rate normalised (CameraEffects.renderMotionBlur).
- TAA now holds history exposure time constant rather than blend weight.
- The harness forces full-resolution material bakes before capture, so the
  "blurry camouflage" the critics saw was partly 32px preview maps being
  photographed. The underlying recipe problems they describe are still real.
- Captures now run at the 'high' tier, not 'medium'.
- Debug overlays (perf readout, click-to-deploy prompt) are hidden in capture.

Your final message is a report for an orchestrator. Be compact and concrete:
what you changed, which findings you fixed, which you rejected and why, build
status, and integration risks.
`;

const TASKS = [
  {
    key: 'materials',
    label: 'materials — kill the camouflage look',
    files: 'src/materials/ (Recipes.js, TextureFactory.js, SurfaceBake.js, SurfaceShader.js, and new files there)',
    brief: `
CRITICAL FINDINGS AGAINST YOU:
1. "Every surface in all ten frames is wearing the same camouflage blob field
   at the same wrong world scale — interior walls, exterior facades, the
   ground, and the weapon." The macro blotch term is the cause. For plaster,
   concrete, brick and stone the reviewer measured worldScale 2.0-3.2 with
   macro 0.40-0.55 and prescribed: drop worldScale to 0.6-1.0 and cut macro to
   0.12-0.18. Then ADD a mandatory human-scale detail band to every masonry
   recipe — brick courses at ~0.075m, block joints, plaster trowel texture,
   render cracks. Right now there is no feature at human scale, which is why
   surfaces read as abstract noise instead of as material.
2. Recipes must be genuinely DISTINCT. Give plaster, concrete, painted metal,
   sand and gun polymer different base-colour distributions, different spatial
   frequencies and different wear signatures. One recipe wearing ten hats is
   the core problem.
3. gunmetal: shade() writes out[4] = 1 unconditionally, making the whole
   receiver a full conductor and therefore a sky mirror — this is the blue
   checkerboard sparkle on the weapon. Phosphate parkerising is a DIELECTRIC
   conversion coating. Drive metalness from the wear mask (conductor only where
   wear has polished through) and floor roughness ~0.55 on unworn areas.
4. COARSE_DIVISOR=16 splats a 32x32 preview into full-size buffers and defers
   refinement to a frame-budget scheduler. The harness now force-flushes, but
   raise the coarse resolution anyway so the game itself never looks like that,
   and make the scheduler's budget adaptive rather than a fixed 5ms.
5. sfMacro is wired but starved by tiny recipe values — add a second octave of
   macro variation at 8-16m world scale so 30m facades do not read as one flat
   pass. This is distinct from finding 1: kill the mid-frequency blotch, ADD
   genuine large-scale variation.

Also verify every recipe's albedo sits in physically plausible reflectance
bounds and that sRGB vs linear is correct on every map.`,
  },
  {
    key: 'lighting',
    label: 'lighting + sky — build a key light and a real sky',
    files: 'src/world/ (LightingModule.js, SkyModule.js, Atmosphere.js, and new files there)',
    brief: `
CRITICAL FINDINGS AGAINST YOU:
1. "There is no key light." environmentIntensity is 0.85 on both scene and
   viewmodel against the sun, giving a roughly 1:1 key/fill ratio — a
   fill-dominated image with no directional form. Prescription: drop
   scene.environmentIntensity to 0.30-0.35 and raise the key 2.5-3x so the
   sun/sky ratio lands near 4:1. Ten frames contained ONE cast shadow.
2. contactHardening is gated on tier high/ultra; raise PCF taps and make sure
   penumbra widens with distance. Stop lerping the key 18% toward white — at a
   low sun elevation the warm/cool key-to-fill separation is the main thing
   giving the image form.
3. "Near-facing geometry crushes to unlit blue-black while distant geometry
   reads light — there is no bounce." Add a bounce/ambient term keyed to sky
   colour above and GROUND ALBEDO below, so shaded facades turn warm sand
   rather than dying to flat blue. Add a weak fill opposite the key.
4. The sky is a bare vertical gradient in every frame: no cloud structure, no
   sun disc, no horizon haze band. The cloud bake produces nothing visible —
   find out why (verify the cloud composite actually reaches
   _compositeMaterial) and fix it. Raise the medium bake resolution/steps. Add
   a warm dust/haze band on the horizon: in a desert setting that band is the
   cheapest depth cue available and its absence is why distant buildings do not
   separate from the sky.
5. Shot 06 is named 'sun-flare' and contains no sun, no flare, no shaft, no
   bloom. Make the sun disc actually visible and bright enough to bloom when
   the camera looks near it.
6. Fog is a global wash rather than a depth separator: density 0.0065 with
   scaleHeight 26 fogs foreground geometry at 10m while still not separating a
   120m background. Prescription: density ~0.0035, scaleHeight ~14, so haze
   pools in the streets and thins fast with height.

The single most important outcome: a frame must have a clear light direction
and real form. Lit faces and shadowed faces must differ strongly in both value
and colour temperature.`,
  },
  {
    key: 'post',
    label: 'post — build a real value structure',
    files: 'src/render/post/ (ColorGrade.js, LutFactory.js, Exposure.js, AmbientOcclusion.js, Bloom.js, Sharpen.js and new files there). Do NOT edit CameraEffects.js or TemporalAA.js — the orchestrator just fixed those.',
    brief: `
CRITICAL FINDINGS AGAINST YOU:
1. "There is not one true black anywhere in the scene." The black point is
   lifted THREE separate times: makeGradeLUT lifts every channel off zero
   (+0.006/+0.008/+0.013), applies desat 0.80 with a further -0.14 shadow
   floor, and runs contrast 1.13 around a pivot of 0.42 that is far too high
   for a frame that never gets bright. On top of that ColorGrade adds its own
   lift of (0.004, 0.008, 0.018). Remove the unconditional lifts, drop the
   pivot, and build a real filmic toe so shadows reach genuine dark values.
2. Build an actual grade instead of three stacked milk injections. Crush the
   toe, add highlight rolloff so sky and lit sand separate, and split-tone warm
   highlights against cool shadows so the sun direction reads. The reviewers
   measured the entire image living inside roughly the 60-200 band of 0-255.
3. AO is invisible in output — no readable contact darkening under crates,
   pallets or at wall/floor junctions. radius 1.15m with intensity 1.0 and
   power 1.5 produces nothing. Prescription: split into TWO scales — keep a
   ~1.15m bounce term and add a 0.15-0.25m CONTACT term at roughly 2x
   intensity, then composite them. Contact darkening is what makes objects sit
   on the ground rather than float.
4. Auto-exposure targets keyValue 0.16 with a centre-weighted mask, pulling a
   dark interior and an open street to the same midtone — destroying the only
   depth cue available. Widen the exposure range, lower the key value, and let
   interiors actually read darker than exteriors.
5. Grain is at 0.030 across the whole midtone range where the image is already
   muddy; it reads as compression noise, not film. Cut it to roughly a third
   and weight it by luminance so it lives in the shadows rather than riding
   highlights. Once real material detail lands, grain at this level will
   actively destroy it.
6. Bloom produces almost nothing — no lens scatter on bright surfaces. Make it
   energy-preserving and visible on genuine highlights only.

The single most important outcome: the histogram must span the full range —
real blacks, held highlights, and colour separation between lit and shade.`,
  },
  {
    key: 'level',
    label: 'level art — density, ground, foreground anchors',
    files: 'src/level/ (LevelModule.js, kit/*.js and new files there)',
    brief: `
CRITICAL FINDINGS AGAINST YOU:
1. The ground is one 280m quad at ~20m per texture tile and reads as flat
   uniform grey — it occupies a third of most frames and carries no detail.
   Split into a tiled inner region at ~2m/tile plus a distant ring, add a
   detail-normal layer that survives at 1-3m viewing distance, value variation
   across the walked area, and ground decals (tyre tracks, oil, cracks, rubble
   spill at wall bases). The _pad() calls produce hard axis-aligned rectangular
   material boundaries — feed a noise-masked blend weight instead.
2. "protoAcUnit, protoWaterTank, protoDish, protoPipeBundle, protoTyre,
   protoPallet, protoBollard, protoRubble are all defined and almost never
   placed." Multiply set dressing 8-10x. AC units, water tanks and dishes on
   every roof edge visible from the street is the single cheapest silhouette
   fix available.
3. "No frame in the set has anything in the 0-4m band except the gun." Every
   AAA screenshot has a dark near-field element that frames the lit midground
   and gives the eye a black to measure against. Add deliberate foreground
   occluders on the main sightlines: hanging rugs strung across the street at
   ~2.4m, awning fabric over stalls, barrel clusters and jersey barriers inside
   3m of the spawn-to-plaza axis, low arches and beams overhead.
4. Buildings are extruded rectangles with a plinth and cornice, so the skyline
   changes value only twice across the frame. Add roofline breakup: parapet
   returns at varying heights per bay, stair penthouses, roof clutter. Add real
   reveal DEPTH to window openings — nothing currently casts a self-shadow onto
   its own facade because nothing projects from it.
5. TRIANGLE BUDGET IS BROKEN: 2,122,469 triangles across 434 draw calls for a
   box arena. That budget is being spent subdividing flat wall runs. Audit the
   tessellation argument passed to .box()/.quad() and drop it to 0-1 on flat
   runs, then spend the recovered budget on silhouette detail.
6. Foliage renders as a flat black camera-facing card with binary alpha edges —
   "a hole punched in the sky". Give it cross-planed geometry, a translucency
   term so backlit fronds glow, a non-black albedo, and make it cast shadows.`,
  },
  {
    key: 'weapons',
    label: 'weapons — the hero asset',
    files: 'src/weapons/ (Gunsmith.js, GunGeo.js, Animator.js, Arms.js, ScopeOverlay.js, WeaponModule.js, Ballistics.js and new files there)',
    brief: `
CRITICAL FINDINGS AGAINST YOU — the weapon is a fifth of the screen and was
judged the worst single element:
1. "The silhouette is a hexagonal prism." Raise radial segment counts on the
   barrel, handguard and suppressor lofts to at least 16-24 — the faceting is
   visible at every distance. Add the parts that are entirely MISSING: front
   sight post, gas block, charging handle, ejection port with a real cut.
   Also raise the optic bell segment count; its ~20 facets read as a polygon.
2. FRAMING IS WRONG. The weapon is cropped by the right frame edge in four
   shots and by the bottom edge in all ten, and eats ~40% of the frame at a
   hard cant. Pull the hip pose inboard and forward so the full receiver
   silhouette including the magazine sits inside the frame, with the muzzle
   roughly a third of the way across. It should occupy the bottom-right
   quadrant, not a diagonal band across the whole frame.
3. THE HANDS ARE NOT ON SCREEN. Verify armMaterials() textures resolve, that
   arm meshes are actually added to the viewmodel scene, that the arm root has
   frustumCulled=false, and that _applyArms places them inside the viewmodel
   camera's frustum rather than behind the near plane.
4. THE RED-DOT RETICLE DOES NOT RENDER — the ADS shot shows clear glass with
   nothing in it. Verify the reticle plane is placed on the eye-to-optic line
   each frame, that its material is additive and unlit, and that it is not
   being depth-rejected by the lens geometry.
5. ADS alignment is off: the optic ring sits at ~61% X / ~47% Y instead of dead
   centre. Confirm the ADS pose is applied at the same pivot the optic axis was
   measured from, and that adsBlend actually reaches exactly 1.0.
6. Materials: receiver, rail, barrel, gas block and sight ring are all painted
   from a single 'steel' instance. Author at minimum receiver_phosphate,
   rail_anodised (darker, rougher), barrel_nitride (near-black, glossier), with
   polymer/rubber on furniture, so the hero asset reads as an assembly of
   manufactured parts. Coordinate with the materials agent's recipes — request
   presets by name and use the closest existing one if yours is not there yet.
7. The sight-ring and ejection-port UVs wrap incoherently, giving visible
   speckle banding. Rebuild those UVs.`,
  },
  {
    key: 'fx',
    label: 'VFX — nothing is rendering',
    files: 'src/fx/ (MuzzleFlash.js, Impacts.js, Decals.js, ParticleSystem.js, Explosions.js, Debris.js, FxModule.js and new files there)',
    brief: `
CRITICAL FINDING AGAINST YOU — your entire subsystem is invisible:
"Across two firing frames and one scored kill there is not one spark, dust
puff, bullet hole, tracer, blood spray, muzzle flash, smoke or ejected case.
The only evidence a shot happened is the ammo counter ticking 30 to 29."

This is almost certainly a wiring bug, not an art problem. Debug it properly:
1. Trace 'weapon:fire' from WeaponModule through to MuzzleFlash's trigger.
   Check: is the FX root parented to engine.viewmodelCamera, or is it falling
   back to viewmodelScene via a null camera? Are sprite opacity and scale
   non-zero at t=0, or reset in the same frame they are set? Is the material
   additive with depthTest disabled? Is frustumCulled false?
2. Same class of failure is suspected in Impacts.js and Decals.js — likely a
   shared ParticleSystem or FxModule wiring bug. Find the common cause.
3. The dynamic muzzle light lives 0.055s. That is too short to survive a
   capture AND too short to read at 60fps. Extend to 0.09-0.12s with a fast
   falloff, and make it actually throw light onto nearby geometry.
4. Decals produce no output anywhere. Wire them into the level build so bullet
   scars, scorch, staining and grime reach the screen — the reviewer called
   this "the single cheapest step from grey-box to place".

WRITE A DEBUG PATH: add a method on FxModule that spawns one of every effect at
a given world position, so this class of silent failure is provable in one call
rather than inferred from screenshots. Then reason carefully about whether each
effect would be visible, since you cannot run the capture harness yourself.

Once it renders, make it good: material-aware impacts (sparks and a bright
flash on metal, dust plume on concrete, sand puff on ground, splinters on
wood), correct impact orientation to the surface normal, tracers that travel
rather than teleport, and lingering smoke.`,
  },
  {
    key: 'ui',
    label: 'HUD — typographic hierarchy and restraint',
    files: 'src/ui/ (HudModule.js, StatusPanels.js, Crosshair.js, Minimap.js, Compass.js, UiStyles.js and new files there), src/game/MatchModule.js',
    brief: `
FINDINGS AGAINST YOU:
1. NO TYPOGRAPHIC HIERARCHY — compass, scorebar, health, objective and legend
   are all the same grey at the same weight with the same tracking. Establish
   three tiers: primary (ammo count, health number) at high weight, near-white,
   with a subtle drop shadow so it survives over bright ground; secondary
   (weapon name, timer); tertiary (everything else) much dimmer and smaller.
2. DELETE the permanent keybind legend (SPRINT / CROUCH / PRONE / AIM). No
   shipped shooter pins a control legend to the HUD. Replace with a stance
   glyph that appears on state change and fades.
3. The health block shows "100 /100" plus the word "STABLE" plus a bar — three
   redundant encodings of one value. Pick one.
4. Move the objective banner ('ELIMINATE HOSTILE FORCES') off bottom-centre: it
   is occluded by the weapon in all ten frames and unreadable where it is not.
   Objectives belong top-centre under the scorebar, or as a timed intro card
   that dismisses. (This lives in src/game/MatchModule.js, which you own.)
5. The crosshair renders as disconnected pixel slivers with an invisible centre
   dot, and the top blade sits at a different offset from the bottom in every
   shot — a CSS transform rounding bug. Give blades real thickness with a 1px
   dark outline so they survive over light ground, and fix the alignment.
6. The minimap is "scattered white and blue confetti on black with no legible
   map geometry". Draw actual building footprints as filled shapes, give the
   player a clear directional cone, drop the noise dots.
7. The compass has a stray tick descending below the baseline and the heading
   chip is an unstyled black box. Align ticks to a consistent baseline and
   style the chip to match the scorebar so the top of the HUD reads as one
   system.

The HUD was also called out for being the SHARPEST thing in the picture —
razor-crisp vector text over a mushy scene, which is "the universal signature
of a browser demo". You cannot fix the scene, but you can stop the HUD
screaming: reduce pure-white fills, soften weights, and let it sit in the image
rather than on top of it.`,
  },
];

/* -------------------------------------------------------------------- fix */

phase('Fix');
log(`Round 2: ${TASKS.length} agents working ranked critical findings`);

const fixed = await parallel(TASKS.map((t) => () =>
  agent(`${COMMON}\n\nYOUR AREA: ${t.label}\nYOU OWN: ${t.files}\n${t.brief}`,
    { label: `fix:${t.key}`, phase: 'Fix' })
    .then((r) => ({ key: t.key, report: r }))
));
log(`${fixed.filter(Boolean).length}/${TASKS.length} fix agents reported`);

/* ---------------------------------------------------------------- capture */

phase('Capture');

const capture = await agent(
  `Integration + capture pass for the Three.js FPS at ${REPO}.

Seven agents just edited different subsystems concurrently. Make the integrated
build run correctly, then capture it.

1. cd ${REPO} && npx vite build — fix every error with the SMALLEST change that
   restores the module contract in src/core/Engine.js. Do not rewrite another
   agent's work.

2. Capture (this takes 10+ minutes under software rasterisation — be patient,
   do not kill it, do not lower the timeout):
   cd ${REPO} && PW_CHROMIUM=/opt/pw-browsers/chromium node tools/screenshot.mjs --out shots/round2

3. shots/round2/console.log MUST be free of errors and pageerrors. If it is
   not, fix the cause and re-capture. Repeat until clean.

4. Read at least six PNGs from shots/round2/ with the Read tool. Verify
   specifically, because these were the round-1 failures:
     - surfaces are NOT wearing a uniform blobby camouflage pattern
     - there is a visible cast shadow with a clear light direction
     - the frame has real dark values, not an all-midtone wash
     - the muzzle flash and impact VFX are visible in the firing shots
     - the weapon is fully inside frame with hands visible
     - no debug perf readout is burned into the image
   If any of those still fail, investigate the cause and fix it — that is part
   of this task, not a note for later.

Report: build status, console errors fixed, render stats from manifest.json
(draw calls / triangles — round 1 was 2.1M triangles which is far too high),
and an honest per-item verdict on the six checks above.`,
  { label: 'integrate+capture', phase: 'Capture' }
);

/* --------------------------------------------------------------- critique */

phase('Critique');

const SCHEMA = {
  type: 'object',
  required: ['verdict', 'tells', 'actions', 'score', 'deltaFromRound1'],
  properties: {
    verdict: { type: 'string' },
    deltaFromRound1: { type: 'string' },
    tells: { type: 'array', items: { type: 'string' } },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'action', 'severity'],
        properties: {
          file: { type: 'string' },
          action: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
        },
      },
    },
    score: { type: 'integer' },
  },
};

const LENSES = [
  { key: 'lighting', prior: 11, focus: 'Lighting, exposure, value structure, atmosphere. Is there a key light with real form? Do shadows read with correct softness and contact darkening? Is there a true black and a held highlight? Does the grade look authored?' },
  { key: 'materials', prior: 8, focus: 'Surfaces. Does each surface read as a specific physical material at 2m AND at 40m? Is there human-scale detail (brick courses, trowel marks, panel lines) or just abstract noise? Any tiling, any flat-colour surface, any plastic PBR? Is the weapon metal convincing?' },
  { key: 'composition', prior: 11, focus: 'Level art, silhouettes, composition, density. Foreground/midground/background layering? Is there a dark near-field anchor? Is set-dressing density believable? Rooflines varied? Ground detailed? Correct scale against a 1.75m player?' },
  { key: 'gamefeel', prior: 12, focus: 'FPS presentation: weapon model quality and screen framing, hands, reticle, muzzle flash and impact VFX, HUD typography and restraint. Does this read as a shipped shooter screenshot?' },
];

const critiques = await parallel(LENSES.map((l) => () =>
  agent(
    `You are a hostile, extremely experienced art director reviewing screenshots
from an in-development browser FPS. You have shipped multiple AAA console
shooters. Your comparison standard is a marketing screenshot from a recent
Call of Duty campaign.

Look at EVERY PNG in ${REPO}/shots/round2/ using the Read tool. Review from the
IMAGES, not from the code. You may read source to ground a recommendation.

YOUR LENS: ${l.focus}

You reviewed this project last round and scored this lens ${l.prior}/100. For
reference, round 1's frames showed: everything wearing the same camouflage blob
pattern, no cast shadows, no true blacks, no muzzle flash, no hands, and a
debug FPS counter burned into the image.

Be brutal and specific. Name exact files under ${REPO}/src for every problem.
Do not inflate the score to reward effort — score the image in front of you. If
it genuinely improved, say by how much and why. If a round-1 problem is still
present, say so explicitly and rank it higher for having survived a fix pass.

Answer explicitly: side by side with a Call of Duty screenshot and no labels,
would a player instantly tell which is which? What gives it away, ranked?

SCORE: integer 0-100, 100 = indistinguishable from shipped CoD. Be stingy.
A competent hobby project is 25. Round 1 averaged 11.`,
    { label: `critique:${l.key}`, phase: 'Critique', schema: SCHEMA }
  ).then((r) => ({ lens: l.key, prior: l.prior, ...r }))
));

const scored = critiques.filter(Boolean);
const avg = scored.length ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length) : 0;
log(`Round 2 average: ${avg}/100 (round 1 was 11)`);

/* Blind forced-choice: shown the frames without being told which is which. */
const blind = await agent(
  `You are shown a set of screenshots from a first-person shooter, in
${REPO}/shots/round2/. Look at all of them with the Read tool.

You are NOT told what produced them. Judge them purely as images.

Answer these questions honestly and without hedging:
1. Do these look like frames from a shipped, commercially released AAA console
   shooter, or from something else? What specifically tells you?
2. If you had to guess the production — shipped AAA title, indie game, student
   project, engine tech demo, or browser experiment — which, and why?
3. If one of these were placed beside a Call of Duty: Modern Warfare marketing
   screenshot, which would look better, and by how much? Be specific about
   which visual qualities decide it.
4. What single change would most narrow the gap?

Return a JSON object.`,
  {
    label: 'blind-forced-choice',
    phase: 'Critique',
    schema: {
      type: 'object',
      required: ['looksShipped', 'guessedProduction', 'sideBySideWinner', 'reasoning', 'singleBiggestGap'],
      properties: {
        looksShipped: { type: 'boolean' },
        guessedProduction: { type: 'string' },
        sideBySideWinner: { type: 'string', enum: ['call-of-duty', 'these-images', 'too-close-to-call'] },
        reasoning: { type: 'string' },
        singleBiggestGap: { type: 'string' },
      },
    },
  }
);

return {
  round: 2,
  averageScore: avg,
  round1Average: 11,
  scores: scored.map((c) => ({ lens: c.lens, prior: c.prior, score: c.score, delta: c.score - c.prior })),
  blind,
  critiques: scored,
  capture: String(capture).slice(0, 3000),
};
