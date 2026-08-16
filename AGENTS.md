# Operation Blackout — working agreement for contributing agents

A Three.js / WebGL2 first-person shooter. The goal is the highest visual and
mechanical fidelity achievable in a browser, with no external art assets —
every texture, mesh, sound and effect is generated in code.

## Hard rules

1. **Stay inside your owned files.** Each work item lists the files it owns.
   Do not edit files owned by another item. If you need something new, create
   it inside your own directory and import it from your own entry point.
2. **The build must never break.** Run `npx vite build` before you finish. A
   red build blocks every other agent.
3. **No new runtime dependencies.** `three` and `three-mesh-bvh` only. No CDN
   fetches, no external images, no fonts from the network — the game must run
   fully offline.
4. **Read `src/core/Engine.js` first.** The module contract at the top of that
   file defines every lifecycle hook, the shared scene/camera objects, and the
   canonical event names. Cross-module communication goes through
   `engine.bus`, never through direct imports of another domain's module.
5. **Budget matters.** Target 60 FPS at 1080p on a mid-range discrete GPU.
   Prefer instancing, merged geometry, and texture atlases over draw calls.
   Anything that costs more than ~1ms of frame time needs a quality-tier gate
   in `src/core/Config.js`.

## Verifying your work visually

The headless harness boots the game in Chromium, drives the camera through a
fixed set of shots, and writes PNGs plus a console log:

```bash
PW_CHROMIUM=/opt/pw-browsers/chromium node tools/screenshot.mjs --out shots/<your-name>
```

Then **look at the PNGs** with the Read tool. `shots/<name>/console.log` must
be free of errors and `manifest.json` reports draw calls, triangle count and
FPS. A shot that renders black, blown-out, or untextured is a bug you own.

Software rasterisation (SwiftShader) is used headlessly, so absolute FPS from
the harness is not meaningful — draw calls and triangle counts are.

## Quality bar

The reference is a modern military shooter's campaign lighting. Concretely:

- **Value structure**: real blacks and real speculars in the same frame; no
  uniform mid-grey wash. Shadowed areas keep colour (sky bounce), they do not
  go flat black.
- **Materials**: every surface reads as a specific material at 2m and at 40m.
  Normal detail, roughness variation, edge wear and dirt breakup are all
  visible. No untextured or single-colour surfaces anywhere in frame.
- **Silhouettes**: no bare primitives. Boxes get chamfers, trim, panel lines,
  fixtures. Anything a player can walk up to needs detail at arm's length.
- **Composition**: the frame has foreground, midground and background layers.
  Depth cues come from fog density, not just distance.
- **Motion**: nothing snaps. Weapon, camera and character motion is damped and
  layered, with secondary motion that lags the primary.
