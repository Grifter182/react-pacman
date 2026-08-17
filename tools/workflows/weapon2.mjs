export const meta = {
  name: 'blackout-weapon-2',
  description: 'Second weapon pass: the seven named defects from the 26/100 review',
  phases: [
    { title: 'Fix', detail: 'Gunsmith, Arms, Recipes — disjoint files, one owner each' },
    { title: 'Verify', detail: 'integrate, re-measure the sight picture, capture' },
    { title: 'Critique', detail: 'hostile review of the hero asset' },
  ],
};

const REPO = '/home/user/react-pacman';

const COMMON = `
You are working in the Three.js FPS project at ${REPO} (branch
claude/aaa-fps-threejs-uie9pm).

READ FIRST:
  ${REPO}/AGENTS.md
  ${REPO}/src/core/Engine.js          the module contract
  ${REPO}/shots/sightline/sightline.json   MEASURED ground truth, see below

GROUND TRUTH. ${REPO}/tools/sightline-probe.mjs boots the real game, forces full
ADS through the real animator, and measures the sight picture in SCREEN SPACE —
the fraction of the pixels inside the optic's rendered rim that show gun instead
of world, broken down by radial band and by clock position, plus the reticle's
offset from the screen centre. Its output is in shots/sightline/sightline.json
and it is the only thing anyone may quote as "the sight works". Read it. Do not
re-derive these numbers by eye from a screenshot, and do not trust an earlier
in-file comment over it.

WHY THAT MATTERS TO YOU: the previous acceptance test for this exact question
was wrong. It fanned rays at radius SIGHT_CLEAR * eyeRelief — the cone's radius
at the REAR glass, next to the eye — while claiming to test the front element,
which sits further down a widening cone and has its own larger frontGlassR. It
reported 0/49 rays obstructed on every weapon at every tier while a sixth of the
bore was dead. If you write an acceptance test, state which plane it samples and
which radius belongs to that plane.

FACTS ALREADY ESTABLISHED — do not re-derive, do not "fix" again:
- ADS ALIGNMENT IS CORRECT. Measured: the optic axis lands 0.1 px from the
  screen centre on the rifle and 0.8 px on the SMG. The eye is on the optic
  axis. Anything still wrong with the sight is MODEL or MATERIAL.
- THE OPTIC ITSELF IS CLEAR. The axial ray hits nothing but the reticle and
  lens glass on every weapon. Do not go looking for a capped tube, a solid lens
  disc or a bridging mount — that theory is dead, it was measured.
- THE RETICLE IS ON THE AXIS. Measured: 1.0 px off the optic axis on the rifle,
  3.7 px on the SMG. An earlier review claimed a 23.5 px offset; that claim is
  FALSE at this build. Do not "fix" the reticle mount on the rifle — you will
  break a 1-pixel alignment. The SMG's 3.7 px is worth closing, gently.
- THE THING BLOCKING THE SIGHT IS THE SUPPORT HAND. Measured, and it is the
  same on every weapon: 19.7% of the rifle's sight picture and 15.0% of the
  SMG's is 'leftHand/fingers', concentrated at 5, 6, 7 and 8 o'clock — the
  lower-left of the sight picture — entirely in the outer two radial bands
  (centre bands 0% and 0%, outer bands 20% and 31%). The hit distances are
  0.45-0.51 m on the rifle while the front lens is at 0.31 m, so the fingers are
  IN FRONT OF the optic, standing up through the line of sight. This is the
  player's "you can't actually aim at anything" and it belongs to Arms.js.
- The front sight post and ears already fold away when an optic is fitted
  (Gunsmith.js barrelAssembly, opticFitted flag).
- The optic glass passes ~81% of light (two discs at 0.10 opacity).
- The receiver's albedo is genuinely flat (8-bit sd 6.4 on a mean of 65). The
  "digital camouflage" was never in the albedo — it is a binary gloss mask in
  the roughness channel. See the long comment above \`gunmetal\` in Recipes.js.

HARD RULES
- Edit ONLY your owned files. Other agents are editing this same tree now.
- Do NOT edit src/core/*, src/ui/*, tools/screenshot.mjs, tools/sightline-probe.mjs.
- Dependencies frozen: three + three-mesh-bvh. No network at runtime.
- Run \`cd ${REPO} && npx vite build\` before finishing. Never leave it red.
- No git commands. Do NOT run tools/screenshot.mjs — it saturates a 4-core box
  and other agents are running. Small node probes are fine and encouraged.
- This machine renders at roughly 1.5 fps under SwiftShader. If you write a
  probe that waits on simulation, give it seconds, not milliseconds, and report
  the frame count it actually got — a 700ms wait spans less than one step and
  makes correct code look dead.

Report compactly: what you changed, what you PROVED versus assumed, the build
status, and anything another agent's files must change to match.
`;

const TASKS = [
  {
    key: 'gunsmith',
    label: 'the optic bore, the reticle mount, the rail finish and the screen framing',
    files: 'src/weapons/Gunsmith.js, src/weapons/GunGeo.js',
    brief: `
NOTE WHAT IS *NOT* YOURS: the sight picture is blocked by the support hand's
fingers, not by your geometry, and the reticle is already on the axis. Both are
measured. Do not chase either one.

1. THE SIGHT PICTURE IS TOO SMALL TO AIM THROUGH. Measured: the rifle's is
   47.6 px in radius — 10.6% of the frame height — and the SMG's is 61.7 px,
   13.7%. That is a 95-pixel hole to identify a target in, at 1600x900, and it
   is the second half of "you can't actually aim at anything": even with the
   fingers gone, there is very little picture there. It is governed by
   SIGHT_CLEAR (0.060 rad, line ~996) times the eye relief, so it is a design
   constant you own, not an accident. A shipped console optic gives noticeably
   more. Widen the usable picture — via SIGHT_CLEAR, the eye relief, the optic's
   internal diameter, or the ADS FOV, whichever is actually the binding
   constraint — and say which one it was and what it cost elsewhere, because
   SIGHT_CLEAR also drives the clearance cone that positions the optic.
   Acceptance: discDiameterPct at or above 18 on every weapon, with the axial
   ray still clear.

2. THE SMG HAS NO FRONT LENS. The probe reports 'no lensFront mesh found' for
   the SMG, and its axial ray hits lensRear but never a front element — so that
   optic is a tube with glass at one end. Give it a front element like the
   rifle's, and publish \`frontGlassR\` on the sight object for every weapon that
   has one. Right now only some weapons export it, which is a measurement trap:
   anything reading \`sight.frontGlassR\` silently falls back to the rear radius
   and measures the wrong plane.

3. THE RAIL IS THE WRONG COLOUR. Gunsmith.js line ~234 sets the rail material
   to \`new THREE.Color(0.62, 0.63, 0.66)\` at roughness 1.22 — a light neutral
   grey. Hard-anodised aluminium rail is near-black, slightly warm, and it never
   develops bright-steel wear because the anodising IS the surface. It currently
   reads as bare aluminium and it is the lightest thing on the weapon, so the eye
   goes straight to it. Fix the colour and the roughness together.

4. THE WEAPON EATS THE FRAME. \`solveHipPose\` (line ~1581) uses
   BOTTOM_NDC = -1.03, RIGHT_NDC = 0.72, MUZZLE_NDC = 0.03. BOTTOM_NDC below
   -1.0 means the solver is deliberately pushing the lowest vertex past the
   bottom edge of the screen, which forces the whole weapon larger and closer
   until it occupies far more of the frame than a shipped viewmodel does. A
   console shooter puts the weapon in the lower-right quadrant with the barrel
   and muzzle device VISIBLE in frame — right now neither is, which is item 5.
   Re-solve the framing so that:
     - the receiver sits in the lower-right quadrant,
     - the barrel and muzzle are inside the frame and readable,
     - nothing clips the near plane.
   Measure it: project the weapon's bounding box to NDC and report the box,
   before and after. Do not guess by eye.

5. THE BARREL AND MUZZLE ARE NOT IN FRAME. Partly a consequence of item 4, but
   check the geometry exists and is worth seeing: a real barrel profile with a
   gas block, and a muzzle device with actual ports rather than a smooth tube.
   The muzzle is where the eye goes when the weapon fires.

Keep the exported surface stable: buildWeapon's return shape, muzzle, ejectPort,
reticle, sight, anchors, hipPose, adsPose are consumed elsewhere. If you move an
anchor, SAY SO LOUDLY — the hands agent is posing to those anchors right now.`,
  },
  {
    key: 'arms',
    label: 'the glove — it reads as camouflage, and the grip still reads as a block',
    files: 'src/weapons/Arms.js',
    brief: `
YOU OWN THE MOST IMPORTANT DEFECT IN THE GAME. Read item 1 before anything else.

1. THE SUPPORT HAND IS STANDING IN THE SIGHT PICTURE. This is the player's
   complaint — "you can't actually aim at anything, nothing renders through the
   scope" — and it is measured, not guessed:

     rifle: 19.7% of the sight picture is 'leftHand/fingers'
     SMG:   15.0%
     concentrated at 5, 6, 7 and 8 o'clock (the lower-left of the picture)
     radial bands centre->rim: 0%, 0%, 20%, 31%  — it is the rim, not the middle
     hit distances 0.45-0.51 m on the rifle, while the front lens is at 0.31 m

   So the fingers are FORWARD of the optic and standing UP into the line of
   sight, eating the lower-left third of the rim. The optic itself is clear —
   the axial ray hits nothing but glass and the reticle.

   A C-clamp support grip puts the thumb over the top of the handguard and the
   fingers WRAPPED AROUND IT, below the bore line. Fingertips above the
   handguard's top surface at the front is not a grip anyone uses, and here it
   is also blocking the sight. Drop the support hand and curl the fingers so no
   part of it rises above the bore line forward of the optic.

   PROVE IT, do not eyeball it:
     cd ${REPO} && PW_CHROMIUM=/opt/pw-browsers/chromium \\
       node tools/sightline-probe.mjs --weapon rifle,smg --out /tmp/sl-arms
   Acceptance: blockedPct under 3 on both, with no clock position above 10%.
   It takes several minutes per weapon. Do not lower its timeout, do not kill
   it, and read the \`picture\` block of the JSON it writes.

   Note the ordering risk: the geometry agent is widening the sight picture at
   the same time, which will expose MORE rim. Clear the fingers out of the bore
   line entirely rather than tuning them to just miss the current radius.

2. THE GLOVE READS AS CAMOUFLAGE. Look at
   ${REPO}/shots/weapon/02-midfield.png and 04-ads.png with the Read tool before
   changing anything, and say honestly what you see.

3. The pattern. Whatever generates the glove's surface is producing
   high-contrast blotches at a spatial frequency that reads as print. A tactical
   glove is a LOW-contrast surface: synthetic suede palm, a slightly glossier
   knuckle panel, stitching lines that follow the seams, and that is nearly all
   of it. If the contrast has to come down to fix this, bring it down.

4. The silhouette. Fingers must read as separate fingers at this screen size —
   knuckles breaking the outline, the index finger clearly on the trigger and
   separated from the others, the thumb crossing behind the grip, the palm
   visibly in contact with the backstrap rather than floating a few millimetres
   off it.

5. Check for intersection. Report whether any finger geometry passes through the
   grip or the handguard, and fix it if so — a finger inside the gun is the kind
   of tell that cannot be unseen once noticed.

You own Arms.js ONLY. The anchors you pose to (weapon.anchors.rightHand,
leftHand, rightRake) come from Gunsmith.js, which another agent is re-solving
the framing of right now. Read them at runtime as the file already does; do not
hard-code positions. If the framing moves, your posing must still work.`,
  },
  {
    key: 'materials',
    label: 'the receiver has no specular response at all',
    files: 'src/materials/Recipes.js (weapon-facing recipes only)',
    brief: `
The receiver cannot produce a specular highlight, so it reads as flat plastic
regardless of how correct its albedo is.

1. The diagnosis is already written up in the long comment above \`gunmetal\` in
   Recipes.js: measured on the bake, after the caller's x1.90 multiplier, 96.4%
   of roughness texels sit in the top decile and 2.2% at 0.30-0.40 with nothing
   between. That is a binary gloss mask — 96% of the surface clipped to dead
   matte, and a sparse population of isolated islands as the only thing in the
   frame reflecting the sky. On a 0.05-albedo surface those islands are 10-20x
   the local diffuse, which is precisely how a camouflage print is built.

2. VERIFY THAT DIAGNOSIS STILL HOLDS before acting on it — it was written a
   round ago and the recipe has been edited since. Bake the map and measure the
   roughness histogram yourself (tools/texdump.mjs exists; a small node probe is
   fine). Report the histogram. If the clipping is gone, say so plainly and move
   to the next item rather than inventing work.

3. Then give the surface a continuous roughness field: phosphate is matte but
   not clipped, so a real receiver shows a broad soft sheen across a whole
   flat, brighter along machined arrises and where a hand or a holster has
   burnished it, and it varies smoothly. Bead blast is fine grain on top of
   that, not the whole signal.

4. The x1.90 multiplier is applied by the CALLER in Gunsmith.js, which you do
   not own. If your recipe only works at a different multiplier, do not change
   it yourself — report the number you need and why, and it will be applied.

5. Distinct surfaces for distinct processes: receiver phosphate, barrel nitride
   (near-black, glossier), polymer furniture (moulded texture, sheen, mould
   seams), rubber grip panels. One steel wearing every hat is what makes an
   assembly look like a single moulded toy.

Watch texel density: the receiver is ~0.25 m long and fills much of the screen
at ADS, so a feature invisible at 2 m is wasted and a 4-pixel feature at 30 cm
is noise. You own the weapon-facing recipes in Recipes.js ONLY — do not touch
the level's surfaces, they are not the complaint and another agent depends on
them.`,
  },
];

phase('Fix');
log('Weapon pass 2: three agents, disjoint files, seven named defects');

const fixed = await parallel(TASKS.map((t) => () =>
  agent(`${COMMON}\n\nYOUR AREA: ${t.label}\nYOU OWN: ${t.files}\n${t.brief}`,
    { label: `fix:${t.key}`, phase: 'Fix' }).then((r) => ({ key: t.key, report: r }))
));
log(`${fixed.filter(Boolean).length}/${TASKS.length} fix agents reported`);

phase('Verify');

const verify = await agent(
  `Integration and verification for the Three.js FPS at ${REPO}.

Three agents just reworked the weapon's geometry and framing, its hands, and its
materials, on disjoint files. Make the integrated build correct, then MEASURE it.

1. cd ${REPO} && npx vite build — fix every error with the smallest change that
   preserves the module contract in src/core/Engine.js. If two agents disagreed
   about an anchor, the geometry owner's definition wins and the pose adapts.

2. RE-MEASURE THE SIGHT PICTURE. This is the pass/fail gate:
     cd ${REPO} && PW_CHROMIUM=/opt/pw-browsers/chromium \\
       node tools/sightline-probe.mjs --weapon rifle,smg,dmr --out shots/sightline2
   Report, per weapon and verbatim: blockedPct, byBandPct, the worst clock
   positions, the blockers map, discDiameterPct, reticleOffsetPx and
   reticleVsAxisPx. Compare against shots/sightline/sightline.json. If a number
   got worse, say so — a regression reported is worth more than a win claimed.

3. Capture. It takes 10+ minutes under software rasterisation; be patient, do
   not kill it, do not lower the timeout:
     cd ${REPO} && PW_CHROMIUM=/opt/pw-browsers/chromium \\
       node tools/screenshot.mjs --out shots/weapon2

4. shots/weapon2/console.log must be free of errors and pageerrors. Fix and
   re-capture until it is clean.

5. Read 04-ads.png and 02-midfield.png and answer honestly, per item:
   - can you see the world through the optic?
   - is the reticle where the shot goes?
   - does the receiver show a specular highlight anywhere?
   - is the rail still the lightest thing on the weapon?
   - do the hands read as gripping it, and does the glove still read as camo?
   - are the barrel and muzzle in frame, and how much of the frame does the
     weapon occupy?

Report the build status, every measured number, and the per-item verdict. Do not
claim a fix the measurements and images do not support.`,
  { label: 'integrate+verify', phase: 'Verify' }
);

phase('Critique');

const critique = await agent(
  `You are a hostile art director who has shipped AAA console shooters. Review
ONLY the first-person weapon in ${REPO}/shots/weapon2/ — read 04-ads.png,
02-midfield.png, 05-firing.png and 10-enemy-engage.png with the Read tool.

It occupies a large part of the screen at all times, so judge it as the hero
asset it is. The previous pass scored 26/100. Its named failures were: the
support hand's fingers blocking the lower-left of the sight picture, a sight
picture only a tenth of the frame height, a receiver with no possible specular
response, a rail rendered light grey instead of black anodising, a glove that
reads as camouflage, no barrel or muzzle in frame, and a framing solver pushing
every vertex on screen.

Judge, specifically:
1. THE SIGHT PICTURE. At ADS, can you see and identify a target through the
   optic? Pass/fail, and it outranks everything else. Two things were wrong
   going in, both measured: the support hand's fingers ate 19.7% of it at 5-8
   o'clock, and the whole picture was only 10.6% of the frame height. Judge both
   — a clear but tiny aperture is still not something you can fight through.
2. The reticle: is it where a shot would land? It measured 1 px off the optic
   axis before this pass, so if it now looks off, that is a REGRESSION and you
   should say so loudly.
3. Materials: does the receiver read as manufactured, phosphated steel — is
   there a specular highlight anywhere on it?
4. The rail: does it read as black anodising, or as bare aluminium?
5. The hands and the glove.
6. Silhouette: faceting, and whether the parts that sell a real rifle are there.
7. Framing: lower-right quadrant with the muzzle visible, or eating the frame?

Score 0-100 against a shipped Call of Duty viewmodel. Be stingy — the previous
score was 26 and unjustified inflation is worse than a harsh number. Name exact
files under ${REPO}/src for every problem.`,
  {
    label: 'critique:weapon2',
    phase: 'Critique',
    schema: {
      type: 'object',
      required: ['sightPictureUsable', 'reticleTrustworthy', 'verdict', 'tells', 'actions', 'score'],
      properties: {
        sightPictureUsable: { type: 'boolean' },
        reticleTrustworthy: { type: 'boolean' },
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
    },
  }
);

return {
  scope: 'weapon pass 2',
  critique,
  verify: String(verify).slice(0, 4000),
  fixReports: fixed.filter(Boolean).map((f) => ({ key: f.key, report: String(f.report).slice(0, 1500) })),
};
