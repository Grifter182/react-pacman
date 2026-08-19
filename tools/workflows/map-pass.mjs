export const meta = {
  name: 'blackout-map-pass',
  description: 'Make Suq al-Hadid playable: AI contact, motion/collision, LOS, materials, NPCs',
  phases: [
    { title: 'Fix', detail: 'four agents, disjoint files' },
    { title: 'Verify', detail: 'integrate, re-measure with the existing probes, capture' },
    { title: 'Critique', detail: 'hostile review: one on play, one on the image' },
  ],
};

const REPO = '/home/user/react-pacman';

const COMMON = `
You are working in the Three.js FPS project at ${REPO} (branch
claude/aaa-fps-threejs-uie9pm). Read ${REPO}/AGENTS.md and
${REPO}/src/core/Engine.js (the module contract) before touching anything.

The player's words, verbatim: "the market compound map needs lots of work and
the npc models and behaviour... make the map more playable... better use of
textures and colour to make the world more believable... collisions with objects
etc for ease of motion need to be redone... line of sight."

============================================================================
GROUND TRUTH — MEASURED THIS SESSION. DO NOT RE-DERIVE. DO NOT CONTRADICT
WITHOUT A NEW MEASUREMENT THAT YOU SHOW.
============================================================================

CONTACT (tools/enemy-probe.mjs, player standing still 60s at four real places):

  position              clear shot   within 25m   nearest median
  team spawn (south)        1.7%         0%           66.3 m
  plaza centre              0%           0%           27.0 m
  the alley                72.5%         1.7%         29.0 m
  motor yard              100%          38.3%         31.4 m

  - Bots are ALIVE and DRAWN: mean alive 6.08, mean mesh-visible 6.08, identical
    at every position. They are not culled, hidden or LOD'd out.
  - They are BUSY: 110 m median travel per two minutes, 7 deaths/minute among
    themselves.
  - POPULATION IS NOT THE CAUSE. Measured 7 bots vs 13: 11.5 alive instead of
    6.1, 12 deaths/min instead of 7, and contact with the PLAYER unchanged —
    still 0% within 25 m everywhere but the motor yard, nearest-ever 22.7 m vs
    23.0 m. Raising botCount does not fix this. It has been tried.
  - MECHANISM: AiModule calls perception.update(step, actor, player.state, ...)
    — the player is the only thing bots perceive, and it is gated on line of
    sight. With no clear line for most of the match they never learn the player
    exists, while bot-vs-bot combat runs down a separate path. Nothing in their
    behaviour draws them toward the player.

LEVEL (tools/level-probe.mjs, tools/climb-probe.mjs, tools/stair-profile.mjs):

  ground walkable area            5858 m2
  elevated walkable area          1922 m2  (33% of the ground area)
  of that, reachable on foot        16 m2  (0.8%)
  navmesh connected regions          211

  - A THIRD OF THE LEVEL IS UPSTAIRS AND UNREACHABLE. Roofs at 6 m: 1486 m2
    exists, 0 m2 reachable. The design notes promise a contested hall roof, two
    first-floor overlooks, a plank bridge and a mezzanine. None of it connects.
  - 4 of 6 staircases work (both mezzanines, both podium stairs). Neither ROOF
    route does:
      west row -> 6.4 m landing: headroom falls below the player's 1.74 m from
        1.05 m to 3.5 m along the flight, reaching 0.18 m. The landing slab's
        underface is at 5.95 m above a ramp still climbing to 6.4 m — the stair
        runs into its own landing. Player stalls at ramp y 4.31 (predicted) /
        4.11 (observed).
      east row -> roof (5.5 m): headroom is CLEAR the whole flight, so it fails
        for a different reason and that reason is NOT YET DIAGNOSED.
  - 79 dead cracks: 147 m2 of walkable ground at or under 1.5 m wide, narrowest
    0.52 m, worst an 8.3 m long half-metre slot at x 39.5, z -26.5..-18.2.
    src/level/SealCracks.js exists, RUNS, and DOES NOT WORK — it reports "149
    cracks, 135.2 m2, 314 boxes" while all five probe-named cracks stay
    enterable. It is not wired into LevelModule. Two theories were refuted by
    measurement: that fix and test read different maps (fixed; no change), and
    that the perimeter merged into one oversized cluster spared by the area
    guard (disproved; identical numbers before and after). THE NEXT STEP IS A
    DIRECT SET COMPARISON: dump the cell indices SealCracks selects and the ones
    level-probe calls narrow, and difference them. Do not add a third theory.

============================================================================
HOW MEASUREMENT GOES WRONG HERE — THESE ARE REAL INCIDENTS, NOT ADVICE
============================================================================

1. THIS BOX DRAWS AT ~1.5 fps under SwiftShader and the engine runs at most 8
   fixed steps per frame, so waiting on the frame loop buys ~0.1 s of simulation
   per wall second. A probe that held a key for 3.5 s reported four WORKING
   staircases as unclimbable; it had measured a player who never walked the
   three metres to the bottom step. Stub the renderer and it gets worse —
   requestAnimationFrame stops being scheduled entirely. Drive fixedUpdate (and
   update, if you need it) yourself, as tools/climb-probe.mjs and
   tools/enemy-probe.mjs do, and RUN A CONTROL FIRST so a null result cannot be
   a stalled harness.
2. MEASURE THE THING THAT SHIPS. An optic probe fanned rays at the rear glass
   radius while claiming to test the front element and reported a clear bore
   with a sixth of it dead. Another set the acceptance bar (PICTURE_MIN = 18) at
   the number that was already failing and printed PASS at 19.2. If you write an
   acceptance test, state which plane/eye/position it samples and why that is
   the one the player has. DO NOT TUNE THE THRESHOLD TO PASS.
3. ONE MAP, NOT TWO. SealCracks failed because it rasterised its own occupancy
   grid while its test read the navmesh; both were self-consistent and they
   disagreed. If your fix and your test both need to know "where can you walk",
   they must read the same structure.
4. POSITION IS PART OF THE MEASUREMENT. An early contact probe parked the player
   at (0,0) — inside the market hall — and reported the map 94.6% blank. Sample
   several real places, and say which.

HARD RULES
- Edit ONLY your owned files. Three other agents are editing this tree now.
- Do NOT edit src/core/*, src/ui/*, tools/*.mjs probes, or another agent's files.
- Dependencies frozen: three + three-mesh-bvh. No network at runtime.
- Run \`cd ${REPO} && npx vite build\` before finishing. Never leave it red.
- No git commands.
- A probe you run boots the SHARED working tree while others edit it. A number
  that makes no sense may be someone else's half-saved file: re-run once before
  believing a surprise, and say which numbers were taken under those conditions.

Report compactly: what you changed, what you PROVED vs assumed (with numbers),
build status, and anything another agent must change to match.
`;

const TASKS = [
  {
    key: 'ai',
    label: 'bot behaviour — they never come to the player',
    files: 'src/ai/Brain.js, src/ai/Perception.js, src/ai/Combat.js, src/ai/AiModule.js',
    brief: `
YOU OWN THE HEADLINE COMPLAINT. "I can never find the enemies, they are like
ghosts" is your defect, and the measurement above tells you it is not spawning,
not rendering, not population and not their movement — it is that nothing gives
them a reason to be where the player is.

1. Read src/ai/Brain.js, Perception.js and AiModule.js and establish what
   actually drives an actor's destination today. Report it plainly: what does a
   bot want, minute to minute, and what makes it move?

2. Then give the match a reason for the two teams to meet. Options worth
   weighing — pick with reasons, do not do all four:
   - CONTESTED SPACE. Objectives/anchors both teams path toward, so fights
     happen at predictable places instead of wherever two patrols collide.
     LevelModule exposes navPoints; MatchModule already reads them.
   - COMBAT AWARENESS. Bots know when their team-mates die and roughly where.
     Gunfire is loud: AiModule already emits 'ai:fire' and the HUD pings the map
     with it. A bot that investigates recent contact converges naturally.
   - SPAWN LOGIC. A median nearest-enemy of 66 m at the player's own spawn means
     every respawn starts a long walk. Spawning toward the action, or picking
     the spawn that is nearest to (but safe from) live contact, is cheap.
   - PERCEPTION OF THE PLAYER. If bots only ever perceive the player by direct
     line of sight, they cannot react to being shot at from cover. Hearing —
     of the player's fire and footsteps — is the missing sense.

3. ACCEPTANCE, and it is measured, not judged:
     cd ${REPO} && PW_CHROMIUM=/opt/pw-browsers/chromium node tools/enemy-probe.mjs
   Target: an enemy in front of the player and not behind a wall for >25% of the
   match at EVERY one of the four sample positions (currently 1.7 / 0 / 72.5 /
   100), and someone within 25 m for >15% at three of the four (currently
   0 / 0 / 1.7 / 38.3). Report the before/after table in full, including any
   position that got worse.

4. Do NOT make bots omniscient. A bot that always knows where the player is
   produces contact and ruins the game — the player must still be able to break
   line of sight and disappear. Say how your change decays.

Difficulty must not be the lever either: if they find the player more often they
will also kill them more often, so watch that the match does not become
unplayable and say what you did about it.`,
  },
  {
    key: 'level',
    label: 'the map: motion, collision, reachability, sightlines',
    files: 'src/level/LevelModule.js, src/level/kit/*.js, src/level/SealCracks.js',
    brief: `
"Collisions with objects etc for ease of motion need to be redone" and "line of
sight". Four measured defects, in priority order.

1. THE ROOFS. 1922 m2 of walkable surface upstairs, 16 m2 reachable. This is a
   third of the level that was built and cannot be entered, and it is the single
   biggest thing wrong with the map.
   - The west flight has a DIAGNOSED cause: its landing slab's underface sits at
     5.95 m over a ramp climbing to 6.4 m, so headroom collapses to 0.18 m and
     the player is stopped halfway. Fix the landing, not the stair.
   - The east roof stair has clear headroom and fails for an UNKNOWN reason.
     Diagnose it with tools/stair-profile.mjs before changing anything.
   - Acceptance: tools/climb-probe.mjs reports 6/6 staircases climbable, and
     tools/level-probe.mjs reports elevated-reachable area above 800 m2 (from
     16). Report both.

2. EASE OF MOTION. The player catches on things. Beyond the 79 dead cracks
   (below), look for: kerbs and thresholds that should be steppable but are not,
   props whose collision proxy is larger than the prop, doorways narrower than
   they look, and the 211-region navmesh fragmentation, which is itself a
   symptom of walkable space being chopped up. Config.player.stepHeight exists
   and the controller has a mantle; a threshold the eye reads as flat should not
   need either. Measure before and after: pick a dozen routes across the map,
   walk them with a hand-stepped probe, and report where the player stalls.

3. THE DEAD CRACKS. See the ground truth: SealCracks.js runs and does not work,
   and the next step is a SET COMPARISON, not a third theory. Either finish it or
   delete it and solve the cracks in the level geometry itself (buildings that
   abut instead of leaving a seam is a better fix than walling the seam). If you
   wire it up, tools/level-probe.mjs narrow area must fall well below 147 m2 AND
   ground area must NOT collapse — a cliff there means you walled the player out
   of the interiors, which is a worse bug than the one you fixed.

4. LINE OF SIGHT. The plaza — the centre of the map — gives 0% clear shot, and
   the alley 72.5%. The market hall occludes the middle of the level from itself.
   Open sightlines through the centre so a player standing in the plaza can see
   and be seen, without turning the map into a field: sightlines that CROSS are
   what make a three-lane map work. Report the change as a measurement, using
   the enemy-probe positions.

Coordinate: the AI agent is changing what bots do. If you move navPoints or add
objectives, say so loudly in your report — they are reading them.`,
  },
  {
    key: 'materials',
    label: 'textures and colour — the world does not read as believable',
    files: 'src/materials/Recipes.js, src/materials/TextureFactory.js',
    brief: `
"Better use of textures and colour to make the world more believable."

1. LOOK FIRST. Read ${REPO}/shots/forest/12-yaw.png (the new forest map, for
   contrast) and capture or read the most recent Suq al-Hadid frames under
   ${REPO}/shots/. Say what is actually wrong before changing anything: is it
   value range, hue variety, texel density, contrast, the absence of large-scale
   variation, or materials that are individually fine but identical to each
   other?

2. THE LIKELIEST FAULT, stated so you can confirm or refute it rather than
   accept it: this level is authored almost entirely in one desaturated sand/
   grey family, and every surface carries similar mid-range value. Real places
   have a few saturated accents against a neutral field — painted doors, faded
   awnings, rusted shutters, tiled thresholds, produce — and large-scale
   variation (a whole wall sun-bleached, another in shadow-damp) that noise at
   texture frequency cannot fake. Measure it: sample the rendered frame's hue
   and value histogram and report it. If the level really is monochrome, that is
   a number, not an opinion.

3. Then fix it with intent, not saturation: keep the neutral field and place a
   small number of accent materials where a player looks — doorways, market
   stalls, vehicle panels, signage. Colour is also a WAYFINDING tool: a map
   where every lane looks identical is a map players get lost in, and the three
   lanes could read as three subtly different palettes.

4. Watch texel density and keep the surface shader's contract intact —
   kit/Weathering.js supplies per-vertex aWeather and the recipes must keep
   working with it. Do not break the LOW tier, which drops the surface shader
   and falls back to UVs.

You own the recipes. Do NOT edit the level's geometry — the level agent is in
those files right now.`,
  },
  {
    key: 'npc',
    label: 'the NPC models — they do not read as soldiers',
    files: 'src/ai/Soldier.js, src/ai/Ragdoll.js, src/ai/Locomotion.js',
    brief: `
"The npc models and behaviour" — you own the MODELS and how they move their
bodies; another agent owns what they decide to do.

1. Read src/ai/Soldier.js and establish what an actor is built from today, then
   look at them in a captured frame. Report honestly what they read as at 10 m,
   25 m and 50 m — those are the ranges the contact measurements say fights
   happen at (nearest enemy median 27-66 m), so a model that only holds up at
   3 m is the wrong asset.

2. Make them read as people at the distance they are actually seen. That is
   mostly SILHOUETTE and VALUE, not polygon count: head/shoulder/weapon
   outline, limbs that separate against the background, a value that is not the
   same as the sand behind them. A soldier who is the same brightness as the
   wall is invisible at 30 m no matter how detailed.

3. TEAM READABILITY IS A GAMEPLAY REQUIREMENT, not decoration. The player must
   be able to tell friend from enemy in the time it takes to decide to shoot.
   Say how your two teams differ and at what range that difference survives.

4. Locomotion: check whether they animate at all while moving, and whether the
   pose changes with stance and speed. A soldier sliding along the ground at a
   constant pose is the strongest possible tell that these are not characters.

5. Keep the collision capsule and hit zones intact — Combat.js and the hit
   registration depend on them, and another agent owns that file. If you change
   the actor's proportions, SAY SO LOUDLY, because headshot geometry keys off it.

Budget: these are drawn up to a dozen at a time. Keep a soldier under ~4k
triangles and say what you spent.`,
  },
];

phase('Fix');
log('Map pass: 4 agents on disjoint areas — AI, level, materials, NPCs');

const fixed = await parallel(TASKS.map((t) => () =>
  agent(`${COMMON}\n\nYOUR AREA: ${t.label}\nYOU OWN: ${t.files}\n${t.brief}`,
    { label: `fix:${t.key}`, phase: 'Fix' }).then((r) => ({ key: t.key, report: r }))
));
log(`${fixed.filter(Boolean).length}/${TASKS.length} fix agents reported`);

phase('Verify');

const verify = await agent(
  `Integration and verification for the Three.js FPS at ${REPO}.

Four agents just reworked the AI, the level, the materials and the NPC models on
disjoint files. Make the integrated build correct, then MEASURE it. Measurements
outrank every claim in their reports.

1. cd ${REPO} && npx vite build — fix every error with the smallest change that
   preserves the module contract in src/core/Engine.js.

2. Re-measure with the probes that already exist. Run each and report its output
   VERBATIM, alongside the before-numbers given here:

   node tools/enemy-probe.mjs
     before: clear shot 1.7 / 0 / 72.5 / 100 %, within 25m 0 / 0 / 1.7 / 38.3 %
             at spawn / plaza / alley / motor yard
   node tools/level-probe.mjs
     before: ground 5858 m2, elevated 1922 m2, elevated-reachable 16 m2,
             211 regions, narrow 147 m2 in 79 clusters
   node tools/climb-probe.mjs
     before: 4 of 6 staircases climbable; both roof routes fail
   node tools/map-orient-probe.mjs
     must still pass — the minimap handedness fix must not regress.

   Each takes minutes under software rasterisation. Be patient, do not lower a
   timeout, do not kill one.

3. Capture:
   cd ${REPO} && PW_CHROMIUM=/opt/pw-browsers/chromium node tools/screenshot.mjs --out shots/mappass
   shots/mappass/console.log must be free of errors and pageerrors.

4. State plainly, per area, whether the measurement supports the agent's claim.
   If an agent reported a fix the numbers do not show, say so — that is the most
   valuable thing in your report. If a number got WORSE, lead with it.

Do not tune a threshold to make something pass. If an acceptance test looks like
it was written to pass, say so.`,
  { label: 'integrate+verify', phase: 'Verify' }
);

phase('Critique');

const SCHEMA = {
  type: 'object',
  required: ['verdict', 'playable', 'believable', 'tells', 'actions', 'score'],
  properties: {
    verdict: { type: 'string' },
    playable: { type: 'boolean' },
    believable: { type: 'boolean' },
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

const [play, look] = await parallel([
  () => agent(
    `You are a hostile multiplayer designer who has shipped competitive shooters.
Judge Suq al-Hadid as a MAP TO PLAY, not as a picture. Evidence is in
${REPO}/shots/mappass/ and in the probe outputs; read the images with the Read
tool and re-run tools/enemy-probe.mjs and tools/level-probe.mjs yourself if you
doubt a number.

The player said it "barely feels playable" and "I can never find the enemies".
Before this pass: an enemy was visible and unobstructed for 1.7% of the match at
their own spawn and 0% in the plaza; a third of the level was upstairs and
unreachable; 79 dead-end cracks; both roof routes broken.

Judge, specifically:
1. CONTACT. Can a player standing anywhere sensible expect a fight? Quote the
   numbers by position.
2. ROUTES. Is the vertical game real now — can you get on the roofs, and is it
   worth it?
3. MOTION. Does the player catch on geometry? Are the cracks gone without the
   interiors being walled off?
4. SIGHTLINES. Do the three lanes cross, or is each a private corridor?
5. Whether anything regressed.

Score 0-100 as a competitive map. Be stingy and name exact files under
${REPO}/src for every problem.`,
    { label: 'critique:play', phase: 'Critique', schema: SCHEMA }),
  () => agent(
    `You are a hostile art director who has shipped AAA console shooters. Judge
Suq al-Hadid and its NPCs as an IMAGE. Read every frame in ${REPO}/shots/mappass/
with the Read tool.

The player said the world needs "better use of textures and colour to make the
world more believable", and that the NPC models need work.

Judge, specifically:
1. COLOUR. Does the palette read as a place, or as one sand-coloured material
   applied to everything? Is there large-scale variation, or only
   texture-frequency noise? Do the three lanes read differently?
2. MATERIALS. Do surfaces read as the things they are — plaster, timber, rusted
   steel, painted metal — or as tinted concrete?
3. NPCs. At the range they are actually fought at (25-50 m), do they read as
   soldiers? Can you tell the two teams apart, and how fast?
4. LIGHT. Does the frame have a light direction and a shadow story, or is it
   flat?
5. Whether anything regressed against earlier shots under ${REPO}/shots/.

Score 0-100 against a shipped Call of Duty frame. Be stingy — an inflated score
is worse than a harsh one — and name exact files under ${REPO}/src.`,
    { label: 'critique:look', phase: 'Critique', schema: SCHEMA }),
]);

return {
  scope: 'market compound: playability, motion, LOS, materials, NPCs',
  critiquePlay: play,
  critiqueLook: look,
  verify: String(verify).slice(0, 4000),
  fixReports: fixed.filter(Boolean).map((f) => ({ key: f.key, report: String(f.report).slice(0, 1200) })),
};
