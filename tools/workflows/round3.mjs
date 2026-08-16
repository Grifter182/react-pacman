export const meta = {
  name: 'blackout-round3',
  description: 'Fix the hero asset, reclaim the triangle budget, then run the review that round 2 never got',
  phases: [
    { title: 'Fix', detail: 'weapon UVs, perf budget, material craft, image contrast' },
    { title: 'Capture', detail: 'integrate and shoot' },
    { title: 'Critique', detail: 'four lenses re-score with deltas, plus the blind forced-choice test' },
  ],
};

const REPO = '/home/user/react-pacman';

const COMMON = `
You are working in the Three.js FPS project at ${REPO}.
READ FIRST: ${REPO}/AGENTS.md and ${REPO}/src/core/Engine.js (module contract).

This is round 3. Rounds 1-2 built the subsystems and fixed the first wave of
art-director findings. The findings below come from DIRECT INSPECTION of the
round-2 captures in ${REPO}/shots/round2/ and ${REPO}/shots/round2b/ — look at
those PNGs yourself with the Read tool before you change anything.

WHAT IS ALREADY WORKING (do not regress it): warm directional sun with real
cast shadows, full tonal range, visible muzzle flash, minimap with real
building footprints, clean HUD hierarchy, correct ADS centring, sane motion
blur and TAA.

IMPORTANT — A PREVIOUS ATTEMPT AT THIS ROUND WAS INTERRUPTED PART-WAY.
Some of the work below may ALREADY BE DONE, committed as "WIP: round-3 weapon
and level work in progress". Before you change anything, read the current state
of your owned files and establish what is already fixed. Do not redo completed
work, and do not assume a finding is still open just because it is listed here.
Report explicitly which items you found already addressed.

HARD RULES
- Edit ONLY your owned files. Other agents are editing this same tree now.
- Do NOT edit src/main.js, src/core/Engine.js, src/core/Config.js or
  tools/screenshot.mjs — the orchestrator owns those.
- Dependencies frozen: three + three-mesh-bvh. No network at runtime.
- Run \`cd ${REPO} && npx vite build\` before finishing. Never leave it red.
- No git commands. Do NOT run the screenshot harness (it saturates the CPU).

Report compactly: what you changed, what you proved vs assumed, build status,
integration risks.
`;

const TASKS = [
  {
    key: 'weapon',
    label: 'the hero asset — it currently reads as a toy',
    files: 'src/weapons/ (all files)',
    brief: `
THE WEAPON IS NOW THE WORST THING IN THE FRAME. Look at
shots/round2b/02-midfield.png and shots/round2/04-ads.png.

1. CRITICAL — THE RECEIVER LOOKS LIKE BLUE-BLACK DIGITAL CAMOUFLAGE.
   This is NOT the material recipe: src/materials/Recipes.js 'gunmetal' is
   physically sound (dark dielectric phosphate, conductor only through wear).
   And it is NOT the bake resolution: the harness force-flushes all bakes to
   full resolution before capture, and the LEVEL's surfaces in the same frames
   are clean. The defect is weapon-specific, so suspect the UVs on the lofted
   geometry in GunGeo.js — a previous reviewer flagged that the sight-ring and
   ejection-port UVs "wrap incoherently".
   PROVE the cause before fixing it. Audit UV generation for every lofted and
   revolved part: check for wrapping seams where u jumps 1->0 across a face,
   for UVs outside 0..1 being sampled with RepeatWrapping, for zero-area UV
   triangles, and for wildly inconsistent texel density between parts. A tiny
   node script that loads the geometry and prints per-part UV bounds and texel
   density would settle it in one run — write one if it helps.
   Then fix it so the receiver reads as dark matte parkerised steel.

2. The weapon is STILL too large at hip fire even after reframing. The
   orchestrator retuned solveHipPose (BUTT_CLEAR 0.30, RIGHT_NDC 0.78,
   BOTTOM_NDC -0.98, MUZZLE_NDC 0.02) which helped, but it still occupies
   roughly a third of the frame and the buttstock still reads as a large
   untextured block on the right. Push further: more butt clearance, and
   consider that the rearmost stock geometry may simply not belong in the
   viewmodel silhouette at all.

3. The ADS optic bell fills roughly a third of the frame height. Bring the
   apparent size down to something closer to a real red-dot presentation.

4. THE RETICLE STILL DOES NOT RENDER. The previous agent correctly diagnosed
   that a physically exact 2 MOA dot is sub-pixel and rewrote it as a sized
   glow — but shots/round2/04-ads.png still shows clear glass. Find out why the
   replacement is not reaching the screen. Check that the reticle is added to
   the viewmodel scene, that it is re-placed on the eye-to-optic line each
   frame as intended, that its material is additive/unlit with depthTest off,
   that it is not behind the lens geometry or the near plane, and that it is
   not being drawn before the pass that would show it.
   Add a way to prove it renders that does not require the screenshot harness.

5. Silhouette: barrel, handguard and optic bell are still visibly faceted.
   Raise radial segments where it shows.`,
  },
  {
    key: 'perf',
    label: 'triangle budget — it went the wrong way',
    files: 'src/level/ (all files)',
    brief: `
THE TRIANGLE BUDGET REGRESSED. Round 1 was 2,122,469 triangles at 434 draw
calls; round 2 is 2,938,362 at 547. The round-2 brief asked for a tessellation
audit AND 8-10x more set dressing; the dressing happened, the audit did not.
Three million triangles for a small arena is roughly an order of magnitude too
many and it is why the software-rendered capture runs at 6 FPS.

1. Audit the tessellation argument passed to .box()/.quad()/loft helpers across
   LevelModule.js and kit/*.js. Flat, unlit wall runs do not need subdivision —
   drop them to 0-1 segments. Find where the millions are actually going first
   (instrument the builder to report triangles per prototype and per call site,
   and print a ranked table) rather than guessing.
2. Then SPEND the reclaimed budget on silhouette: roofline breakup, window
   reveal depth, chamfers, and props that break straight lines. Detail that
   changes the outline is worth 100x detail that does not.
3. Draw calls at 547 are also high. Push harder on InstancedMesh for repeated
   props and merge static geometry that shares a material.
4. Keep the collision proxy simple and separate from render geometry.

Target: under 900k triangles and under 250 draw calls, with the map looking
BETTER than it does now, not worse. Report the before/after table.`,
  },
  {
    key: 'surfaces',
    label: 'material craft and image contrast',
    files: 'src/materials/ (all files), src/render/post/ColorGrade.js, src/render/post/LutFactory.js, src/render/post/Exposure.js',
    brief: `
Look at shots/round2b/01-spawn-vista.png, 02-midfield.png, 03-cover-detail.png,
07-shadow-read.png and 08-ground-material.png.

1. Distant geometry is washed out into a flat haze and loses all contrast, so
   the midground and background merge. The atmosphere should separate depth
   planes, not erase them. Retune so distant surfaces keep local contrast and
   material identity while still reading as further away.
2. The ground still reads soft and undifferentiated across large areas. It
   occupies a third of most frames. It needs close-range detail that survives
   at 1-3m and value variation across the walked area.
3. Masonry surfaces read as a repeating blocky pattern at mid distance — the
   tiling is visible. Break it with macro variation at a scale LARGER than the
   tile, and make sure the human-scale detail band (brick courses, block
   joints) is actually landing at the right world size.
4. The overall image is warm-dominant to the point of monochrome. Introduce
   real colour separation between the sunlit surfaces and the sky-lit shade,
   so the frame is not one hue at two brightnesses.
5. Keep the tonal range that round 2 won — do NOT reintroduce a black lift.`,
  },
];

phase('Fix');
log('Round 3: 3 focused agents on the highest-impact remaining defects');

const fixed = await parallel(TASKS.map((t) => () =>
  agent(`${COMMON}\n\nYOUR AREA: ${t.label}\nYOU OWN: ${t.files}\n${t.brief}`,
    { label: `fix:${t.key}`, phase: 'Fix' }).then((r) => ({ key: t.key, report: r }))
));
log(`${fixed.filter(Boolean).length}/${TASKS.length} fix agents reported`);

phase('Capture');

const capture = await agent(
  `Integration + capture for the Three.js FPS at ${REPO}.

1. cd ${REPO} && npx vite build — fix every error with the smallest change that
   restores the module contract in src/core/Engine.js.
2. cd ${REPO} && PW_CHROMIUM=/opt/pw-browsers/chromium node tools/screenshot.mjs --out shots/round3
   This takes 15+ minutes under software rasterisation. Be patient. Do not kill
   it, do not reduce the timeout.
3. shots/round3/console.log must be free of errors and pageerrors. Fix and
   re-capture until clean.
4. Read at least six PNGs and verify, honestly:
   - the weapon receiver reads as dark matte steel, NOT blue digital camo
   - the weapon occupies roughly the lower-right quadrant, not a third of frame
   - the ADS reticle is visible against the target
   - triangles are well under 1.5M (round 2 was 2.94M) — read manifest.json
   - distant geometry keeps contrast rather than washing to flat haze
   Report a per-item pass/fail with what you actually see.`,
  { label: 'integrate+capture', phase: 'Capture' }
);

phase('Critique');

const SCHEMA = {
  type: 'object',
  required: ['verdict', 'tells', 'actions', 'score'],
  properties: {
    verdict: { type: 'string' },
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
  { key: 'lighting', prior: 11, focus: 'Lighting, exposure, value structure, atmosphere. Key light and form? Shadow softness and contact darkening? True black and held highlight? Does the grade look authored? Does atmosphere separate depth planes or erase them?' },
  { key: 'materials', prior: 8, focus: 'Surfaces. Does each read as a specific physical material at 2m AND 40m? Human-scale detail or abstract noise? Visible tiling? Is the weapon metal convincing?' },
  { key: 'composition', prior: 11, focus: 'Level art, silhouettes, composition, density. Foreground/midground/background layering? Dark near-field anchor? Believable dressing density? Varied rooflines? Correct scale against a 1.75m player?' },
  { key: 'gamefeel', prior: 12, focus: 'FPS presentation: weapon model quality and screen framing, hands, reticle, muzzle flash and impact VFX, HUD typography and restraint. Does this read as a shipped shooter screenshot?' },
];

const critiques = await parallel(LENSES.map((l) => () =>
  agent(
    `You are a hostile, extremely experienced art director who has shipped
multiple AAA console shooters. Your comparison standard is a marketing
screenshot from a recent Call of Duty campaign.

Look at EVERY PNG in ${REPO}/shots/round3/ with the Read tool. Review from the
IMAGES. You may read source only to ground a recommendation.

YOUR LENS: ${l.focus}

You scored this lens ${l.prior}/100 in round 1, when the frames showed
everything wearing a camouflage blob pattern, no cast shadows, no true blacks,
no muzzle flash and a debug FPS counter burned in. Those specific defects have
since been worked on.

Score the image in front of you, not the effort behind it. Do not inflate for
improvement. If a defect survived two fix passes, rank it HIGHER for having
survived. Name exact files under ${REPO}/src for every problem.

Answer explicitly: side by side with a Call of Duty screenshot, no labels,
would a player instantly tell which is which? What gives it away, ranked?

SCORE 0-100, 100 = indistinguishable from shipped CoD. Be stingy. A competent
hobby project is 25.`,
    { label: `critique:${l.key}`, phase: 'Critique', schema: SCHEMA }
  ).then((r) => ({ lens: l.key, prior: l.prior, ...r }))
));

const scored = critiques.filter(Boolean);
const avg = scored.length ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length) : 0;
log(`Round 3 average: ${avg}/100 (round 1 was 11)`);

const blind = await agent(
  `You are shown screenshots from a first-person shooter in ${REPO}/shots/round3/.
Look at all of them with the Read tool. You are NOT told what produced them.
Judge them purely as images.

1. Do these look like frames from a shipped AAA console shooter, or something
   else? What specifically tells you?
2. Guess the production: shipped AAA title, indie game, student project, engine
   tech demo, or browser experiment. Why?
3. Placed beside a Call of Duty: Modern Warfare marketing screenshot, which
   looks better, and by how much? Which visual qualities decide it?
4. What single change would most narrow the gap?`,
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
  round: 3,
  averageScore: avg,
  round1Average: 11,
  scores: scored.map((c) => ({ lens: c.lens, prior: c.prior, score: c.score, delta: c.score - c.prior })),
  blind,
  critiques: scored,
  capture: String(capture).slice(0, 3000),
};
