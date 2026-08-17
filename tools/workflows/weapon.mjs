export const meta = {
  name: 'blackout-weapon',
  description: 'Rework the weapon: clear the optic aperture, fix the grip, upgrade model and textures',
  phases: [
    { title: 'Fix', detail: 'aperture + geometry, hands, materials — disjoint files' },
    { title: 'Capture', detail: 'integrate, prove the aperture is clear, shoot' },
    { title: 'Critique', detail: 'harsh review of the hero asset' },
  ],
};

const REPO = '/home/user/react-pacman';

const COMMON = `
You are working in the Three.js FPS project at ${REPO} (branch
claude/aaa-fps-threejs-uie9pm).

READ FIRST: ${REPO}/AGENTS.md and ${REPO}/src/core/Engine.js (module contract).

LOOK AT THE PROBLEM before changing anything:
  ${REPO}/shots/scope-fix/04-ads.png   aiming down the sight
  ${REPO}/shots/scope-fix/02-midfield.png  hip fire
Read them with the Read tool. The weapon is the single worst element in the
frame and it occupies a fifth of the screen at all times.

FACTS ALREADY ESTABLISHED BY MEASUREMENT — do not re-derive these, and do not
"fix" them again:
- ADS ALIGNMENT IS CORRECT. At full ADS the optic centre projects to
  50.0/50.0 per cent of the frame, its front element to 50.0/50.1, its rear to
  50.0/49.9, and the weapon root sits at 0.09 degrees. The eye is exactly on
  the optic axis. The complaint "aiming down the sights doesn't work" is NOT a
  pose or alignment bug.
- The front sight post and ears are already folded away when an optic is
  fitted (Gunsmith.js barrelAssembly, opticFitted flag).
- The optic glass already passes ~81% of light (two discs at 0.10 opacity,
  envMapIntensity 0.9). It is no longer a dark filter.
- DESPITE ALL THAT, the player still cannot see through the sight. Geometry
  inside or across the optic aperture is occupying the view. That is the
  remaining cause and it is a MODEL problem.

HARD RULES
- Edit ONLY your owned files. Other agents are editing this same tree now.
- Do NOT edit src/core/*, src/ui/*, tools/screenshot.mjs.
- Dependencies frozen: three + three-mesh-bvh. No network at runtime.
- Run \`cd ${REPO} && npx vite build\` before finishing. Never leave it red.
- No git commands. Do NOT run the screenshot harness — it saturates the CPU
  and other agents are running. You may write and run small node probes.

Report compactly: what you changed, what you PROVED versus assumed, build
status, integration risks.
`;

const TASKS = [
  {
    key: 'optic',
    label: 'the optic aperture and weapon geometry',
    files: 'src/weapons/Gunsmith.js, src/weapons/GunGeo.js',
    brief: `
PRIMARY, AND IT IS A CORRECTNESS BUG, NOT A TASTE ONE: the player cannot see
the world through the sight. A sight you cannot see through is not a sight.

1. Find what is actually in the aperture. Candidates: the optic tube is a
   capped/solid loft rather than a real hollow tube; the rear or front lens
   disc is a full disc rather than an annulus plus glass; the reticle housing,
   emitter shroud or mount bridges the bore; the rail or charging handle
   crosses the line behind the optic.

   PROVE IT. Write a small node probe (Playwright is available; do not use the
   screenshot harness) that boots the game, forces full ADS, then casts a ray
   from the viewmodel camera along its -Z axis and reports EVERY viewmodel mesh
   it intersects within 0.6 m, by name and distance. Anything returned is
   something the player is looking at instead of the target. Report that list
   before and after your fix. The acceptance condition is that the ray hits
   nothing but lens glass.

2. Then make the sight picture correct: a real through-hole down the optic,
   the aperture wide enough that the tube walls do not vignette the view at
   the eye relief actually in use, and the reticle drawn over the top of it.

3. WEAPON GEOMETRY QUALITY. The silhouette is faceted and blocky — reviewers
   called it "a hexagonal prism" and "a boxy prop". Raise radial segment
   counts on the barrel, handguard, suppressor and optic bell until the
   faceting stops reading at arm's length. Add the parts that sell a real
   rifle at this distance: charging handle, ejection port with a real cut,
   bolt catch, safety selector, sling points, magazine floorplate, castle nut.
   Chamfer every hard edge — nothing on a manufactured part is a perfect
   90 degrees, and the eye reads chamfers as precision.

4. Keep the exported surface stable: buildWeapon's return shape, muzzle,
   ejectPort, reticle, sight, anchors, hipPose, adsPose are all consumed
   elsewhere. If you change an anchor, say so loudly in your report — the
   hands agent is posing to those anchors right now.

Budget: this is the hero asset, so spend triangles here. Keep the whole
viewmodel under ~40k triangles, which is generous at this screen size.`,
  },
  {
    key: 'hands',
    label: 'the hands — they do not read as holding the gun',
    files: 'src/weapons/Arms.js',
    brief: `
The user's words: "the hand does not look like it's holding the gun." The
hands do render — two meshes, visible, positioned near the anchors — so this
is a POSE and FORM problem, not a wiring one.

1. Look at shots/scope-fix/02-midfield.png. Judge honestly what is wrong:
   the fingers do not wrap the grip, the palm does not contact it, the wrist
   angle is not one a human arm can reach, the forearm is missing so the hand
   floats, the silhouette reads as a block rather than a hand.

2. Fix the grip itself. A convincing firing hand needs: fingers that curl
   around the front strap with the index finger clearly separated onto the
   trigger, a thumb that crosses behind the grip, a palm that visibly meets
   the backstrap, and knuckles that break the silhouette. The support hand
   needs to wrap the handguard with the thumb over the top (the modern
   C-clamp already described in the file's comments) and the fingers visibly
   in front of the handguard, not intersecting it.

3. Add forearms. A hand with no arm behind it reads as a prop floating in
   frame; the forearm running back toward the shoulder is most of what sells
   the grip. Keep them inside the viewmodel camera's frustum.

4. Geometry quality: enough segments that fingers read as fingers, and a
   sleeve/glove cuff so the arm terminates deliberately rather than being
   clipped by the near plane.

You own Arms.js ONLY. The anchors you pose to (weapon.anchors.rightHand,
leftHand, rightRake) come from Gunsmith.js, which another agent is editing
right now — read them at runtime as the file already does, do not hard-code
positions, and if the anchors move your posing must still work.`,
  },
  {
    key: 'materials',
    label: 'weapon materials — the receiver reads as patterned plastic',
    files: 'src/materials/Recipes.js (the gunmetal and weapon-facing recipes only)',
    brief: `
The receiver has been called "blue-black digital camouflage" and "a boxy prop"
by successive reviews, and it still does not read as steel.

1. Look at shots/scope-fix/02-midfield.png and 04-ads.png and judge what the
   surface is actually doing wrong: the pattern's spatial frequency, its
   contrast, whether it reads as a material or as noise, whether the wear sits
   where a hand and a holster would actually put it.

2. The gunmetal recipe is already physically reasoned — phosphate is a matte
   DIELECTRIC conversion coating, conductor only where wear polishes through,
   and its packed metal channel measures a mean of 1.5/255, so metalness is
   NOT the problem. The problem is the visible pattern.

3. Author distinct weapon surfaces rather than one steel wearing every hat:
   receiver phosphate (matte, fine bead-blast, machining witness marks),
   rail anodising (darker, rougher, no bright-steel wear), barrel nitride
   (near-black, glossier), polymer furniture (moulded texture, sheen, mould
   seams), rubber grip panels. A rifle reads as an assembly of parts made by
   different processes; one uniform material is what makes it look like a toy.

4. Watch the texel density. The receiver is ~0.25 m long and fills a large
   part of the screen at ADS, so a feature that is invisible at 2 m is wasted
   and a feature that is 4 px at 30 cm is noise.

You own the weapon-facing recipes in src/materials/Recipes.js ONLY. Do not
touch the level's surfaces — another agent's work depends on them and they are
not the complaint.`,
  },
];

phase('Fix');
log('Weapon rework: 3 agents on disjoint files');

const fixed = await parallel(TASKS.map((t) => () =>
  agent(`${COMMON}\n\nYOUR AREA: ${t.label}\nYOU OWN: ${t.files}\n${t.brief}`,
    { label: `fix:${t.key}`, phase: 'Fix' }).then((r) => ({ key: t.key, report: r }))
));
log(`${fixed.filter(Boolean).length}/${TASKS.length} fix agents reported`);

phase('Capture');

const capture = await agent(
  `Integration + capture for the Three.js FPS at ${REPO}.

Three agents just reworked the weapon: its geometry and optic, its hands, and
its materials. Make the integrated build correct, then prove it.

1. cd ${REPO} && npx vite build — fix every error with the smallest change that
   restores the module contract in src/core/Engine.js.

2. PROVE THE SIGHT IS CLEAR. Write a node probe (Playwright; NOT the
   screenshot harness) that boots the game, forces full ADS, casts a ray from
   the viewmodel camera along -Z, and lists every viewmodel mesh hit within
   0.6 m with name and distance. Report the list verbatim. If anything other
   than lens glass is hit, the sight is still blocked — say so plainly rather
   than reporting success.

3. Capture (10+ minutes under software rasterisation; be patient, do not kill
   it, do not lower the timeout):
   cd ${REPO} && PW_CHROMIUM=/opt/pw-browsers/chromium node tools/screenshot.mjs --out shots/weapon

4. shots/weapon/console.log must be free of errors and pageerrors. Fix and
   re-capture until clean.

5. Read 04-ads.png and 02-midfield.png and answer honestly, per item:
   - can you see the world through the optic, or is the aperture still blocked?
   - do the hands read as gripping the weapon?
   - does the receiver read as steel rather than as a pattern?
   - is the silhouette still visibly faceted?

Report: build status, the ray-cast list before/after, render stats from
manifest.json, and the per-item verdict. Do not claim a fix the images do not
support.`,
  { label: 'integrate+capture', phase: 'Capture' }
);

phase('Critique');

const critique = await agent(
  `You are a hostile art director who has shipped AAA console shooters. Review
ONLY the first-person weapon in ${REPO}/shots/weapon/ — read 04-ads.png,
02-midfield.png, 05-firing.png and 10-enemy-engage.png with the Read tool.

The weapon occupies a fifth of the screen at all times, so judge it as the
hero asset it is. Previous reviews called it "a hexagonal prism", "a boxy
prop" and "blue-black digital camouflage", and the player reported that they
could not see anything through the sight.

Judge, specifically:
1. THE SIGHT PICTURE. At ADS, can you see the target through the optic? This
   is pass/fail and it outranks everything else — a sight you cannot see
   through is a broken game, not an ugly one.
2. The hands: do they read as gripping the weapon, or as floating near it?
3. Materials: does the receiver read as manufactured steel?
4. Silhouette: is faceting still visible? Are the parts that sell a real rifle
   present?
5. Screen framing: does it occupy the lower-right quadrant, or eat the frame?

Score 0-100 against a shipped Call of Duty viewmodel. Be stingy. Name exact
files under ${REPO}/src for every problem.`,
  {
    label: 'critique:weapon',
    phase: 'Critique',
    schema: {
      type: 'object',
      required: ['sightPictureUsable', 'verdict', 'tells', 'actions', 'score'],
      properties: {
        sightPictureUsable: { type: 'boolean' },
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
  scope: 'weapon rework',
  critique,
  capture: String(capture).slice(0, 3000),
  fixReports: fixed.filter(Boolean).map((f) => ({ key: f.key, report: String(f.report).slice(0, 1200) })),
};
