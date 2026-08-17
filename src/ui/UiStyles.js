/**
 * OWNER: UI/UX agent.
 *
 * The HUD's visual language, in one place.
 *
 * Rules the whole sheet obeys:
 *   - One 8px grid. Every offset, gap and size is a multiple of `--u`.
 *   - THREE TYPE TIERS AND NO MORE. Everything on screen is exactly one of:
 *       T1  the two numbers a player reads mid-firefight — health and rounds
 *           in the magazine. Large, heavy, near-white, carrying a real drop
 *           shadow so the digits survive over sunlit ground.
 *       T2  the things checked between engagements — weapon, clock, score.
 *           Two thirds the value of T1, one weight lighter, tracked open.
 *       T3  structure and provenance — map name, fire mode, objective, tick
 *           labels. A third of T1's value, small, wide-tracked, never bold.
 *     A readout that cannot justify T1 or T2 is T3. There is no fourth tier
 *     and there are no bespoke colours outside the semantic four.
 *   - Nothing is pure white. `--t1` tops out at 92% of a warm off-white; the
 *     HUD has to sit *in* the rendered image, not float in front of it as a
 *     razor-crisp vector overlay.
 *   - Rules are 1px and low-contrast; weight comes from tracking and value, not
 *     from borders. Panels are dark glass with a single accent edge.
 *   - Nothing snaps. Every state change is eased on `--ease`, and the durations
 *     are quantised to three steps so unrelated elements move in sympathy.
 *   - Colour is semantic: friendly cyan, hostile red, caution amber, and a
 *     desaturated ink for everything that is only structure.
 *   - No permanent instructional text. A control legend on the HUD is a tutorial
 *     that never ends; state is shown by a glyph that appears when the state
 *     changes and then gets out of the way.
 *
 * No web fonts: the stack is local condensed faces with a synthetic condense
 * fallback, so the layout holds on a machine that has none of them.
 */

export const UI_CSS = /* css */`
:root {
  --u: 8px;
  --safe: calc(var(--u) * 4);

  --ink-0: #05070a;
  --ink-1: rgba(7,10,14,.78);
  --ink-2: rgba(10,14,19,.58);
  --line: rgba(196,214,232,.16);
  --line-2: rgba(196,214,232,.30);

  --fg: #dde7f1;
  --fg-dim: rgba(221,231,241,.52);
  --fg-mute: rgba(221,231,241,.30);

  /* --- the three tiers. Nothing on the HUD picks a colour outside these. --- */
  --t1: rgba(232,239,246,.93);      /* health, magazine                       */
  --t2: rgba(216,228,240,.66);      /* weapon, clock, score                   */
  --t3: rgba(205,219,234,.38);      /* labels, objective, provenance          */
  /* Every tier carries a shadow, and the shadow is what buys the low tiers the
     right to be dim. Contrast against the scene comes from the dark halo, not
     from the fill value; without it a 33%-alpha off-white label over sunlit
     ground is not subtle, it is simply gone. T1's is the only one heavy enough
     to read as a cast shadow — the rest are haloes. */
  --sh1: 0 1px 2px rgba(2,4,7,.95), 0 0 5px rgba(2,4,7,.85), 0 3px 16px rgba(2,4,7,.6);
  --sh2: 0 1px 2px rgba(2,4,7,.9), 0 0 5px rgba(2,4,7,.72);
  --sh3: 0 1px 2px rgba(2,4,7,.88), 0 0 4px rgba(2,4,7,.66);

  --friend: #63c8ff;
  --friend-dk: #1b5f86;
  --hostile: #ff5a41;
  --hostile-dk: #7d2517;
  --warn: #ffb545;
  --good: #86dd8a;

  --ease: cubic-bezier(.22,.68,.28,1);
  --ease-out: cubic-bezier(.16,1,.3,1);
  --t-fast: .11s;
  --t-med: .24s;
  --t-slow: .5s;

  --font: "Bahnschrift","DIN Alternate","Roboto Condensed","Barlow Condensed",
          "Oswald","Arial Narrow","Helvetica Neue",system-ui,sans-serif;
}

.bl-root {
  position: absolute; inset: 0;
  font-family: var(--font);
  font-stretch: 87.5%;
  color: var(--fg);
  user-select: none;
  /* Master HUD fade. It rests below 1 on purpose: a HUD at full opacity is the
     sharpest, highest-contrast object in a rendered frame, which reads as an
     overlay pasted on top of a game rather than a display inside one. */
  --hud-a: .93;
}
.bl-root * { box-sizing: border-box; }
/* Menus and the scoreboard are read at rest and want the crisp grey-scale
   rasteriser; the gameplay HUD explicitly does not — see .bl-hud below. */
.bl-menu, .bl-sb, .bl-load { -webkit-font-smoothing: antialiased; }

/* Structural type roles. */
.bl-lab {
  font-size: 10px; letter-spacing: .24em; font-weight: 600;
  color: var(--fg-mute); text-transform: uppercase;
}
.bl-num { font-variant-numeric: tabular-nums; letter-spacing: .01em; font-weight: 700; }
.bl-brk { opacity: .35; padding: 0 .35em; }

/* ---- the three tiers, as classes. Apply one; never mix two. -------------- */
.bl-t1 {
  color: var(--t1); font-weight: 700; letter-spacing: .005em;
  text-shadow: var(--sh1);
}
.bl-t2 {
  color: var(--t2); font-weight: 600; letter-spacing: .13em;
  text-shadow: var(--sh2);
}
.bl-t3 {
  color: var(--t3); font-weight: 500; font-size: 9px; letter-spacing: .22em;
  text-transform: uppercase; text-shadow: var(--sh3);
}

/* A panel: dark glass, one hairline, corner ticks, accent edge on the left. */
.bl-panel {
  position: relative;
  background: linear-gradient(180deg, var(--ink-1), var(--ink-2));
  border: 1px solid var(--line);
  backdrop-filter: blur(6px) saturate(.9);
}
.bl-panel::before, .bl-panel::after {
  content: ''; position: absolute; width: calc(var(--u) * 1.5); height: calc(var(--u) * 1.5);
  border: 1px solid var(--line-2); pointer-events: none;
}
.bl-panel::before { left: -1px; top: -1px; border-right: 0; border-bottom: 0; }
.bl-panel::after { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }

/* =====================================================  gameplay layer  === */

.bl-hud { position: absolute; inset: 0; opacity: var(--hud-a); transition: opacity var(--t-med) var(--ease); }
.bl-hud.bl-off { opacity: 0; }

/* --- crosshair ------------------------------------------------------------ */
/* --gap is the only property written per frame; it is the real cone radius
   projected to pixels, so the reticle is a readout, not a decoration.
 *
 * PIXEL GRID. Every number here is an even integer and --gap is rounded to a
 * whole pixel in JS, because the reticle is the one element in the frame where
 * a half-pixel is visible: a blade laid down on a .5 boundary is rasterised as
 * two 50% rows instead of one solid row, and since the top blade's fractional
 * part is the complement of the bottom blade's, the two ends of the same
 * reticle land on different sub-pixel phases and the whole thing reads as
 * lopsided. The container origin is also snapped to an integer by
 * Crosshair.resize() rather than left on left:50%, which is a half pixel
 * whenever the viewport has an odd dimension.
 */
.bl-xh {
  --gap: 9px; --blade: 8px; --w: 2px; --a: 1;
  position: absolute; left: 50%; top: 50%; width: 0; height: 0;
  opacity: var(--a);
  will-change: opacity;
}
/* The blades are drawn as a light core inside a hard 1px dark ring. The ring is
   what makes them survive over sunlit concrete; a blur-only shadow does not,
   because it has no edge for the eye to lock onto. */
.bl-xh b {
  position: absolute; display: block;
  background: var(--t1);
  box-shadow: 0 0 0 1px rgba(3,5,8,.78), 0 0 5px rgba(3,5,8,.6);
}
.bl-xh .t { width: var(--w); height: var(--blade); left: calc(var(--w) / -2); top: calc(0px - var(--gap) - var(--blade)); }
.bl-xh .b { width: var(--w); height: var(--blade); left: calc(var(--w) / -2); top: var(--gap); }
.bl-xh .l { height: var(--w); width: var(--blade); top: calc(var(--w) / -2); left: calc(0px - var(--gap) - var(--blade)); }
.bl-xh .r { height: var(--w); width: var(--blade); top: calc(var(--w) / -2); left: var(--gap); }
/* A real centre dot: 2px of core inside the same ring, which is 4px of total
   mark. At 1px with 60% alpha it was invisible in every captured frame. */
.bl-xh .dot { width: 2px; height: 2px; left: -1px; top: -1px; border-radius: 50%; }
/* Sprint/obstructed state: blades retract and the reticle drops a tier. */
.bl-xh.bl-idle { --blade: 4px; }
.bl-xh.bl-idle b { background: var(--t2); }

/* Hitmarker: three grades, differentiated by colour, spread and blade weight. */
.bl-hm {
  position: absolute; left: 50%; top: 50%; width: 34px; height: 34px;
  transform: translate(-50%,-50%) scale(1); opacity: 0;
  will-change: transform, opacity;
}
.bl-hm i {
  position: absolute; width: 10px; height: 2px; background: var(--t1);
  box-shadow: 0 0 0 1px rgba(3,5,8,.6), 0 0 3px rgba(0,0,0,.9);
}
.bl-hm i:nth-child(1) { top: 5px; left: 4px; transform: rotate(45deg); transform-origin: 0 50%; }
.bl-hm i:nth-child(2) { top: 5px; right: 4px; transform: rotate(-45deg); transform-origin: 100% 50%; }
.bl-hm i:nth-child(3) { bottom: 5px; left: 4px; transform: rotate(-45deg); transform-origin: 0 50%; }
.bl-hm i:nth-child(4) { bottom: 5px; right: 4px; transform: rotate(45deg); transform-origin: 100% 50%; }
.bl-hm.bl-head i { background: #ffe9a8; height: 3px; width: 12px; }
.bl-hm.bl-kill i { background: var(--hostile); height: 3px; width: 13px; }
.bl-hm .bl-x { position: absolute; inset: 0; display: none; }
.bl-hm.bl-kill .bl-x { display: block; }
.bl-hm .bl-x b {
  position: absolute; left: 50%; top: 50%; width: 20px; height: 2px; margin: -1px 0 0 -10px;
  background: var(--hostile); box-shadow: 0 0 4px rgba(0,0,0,.9);
}
.bl-hm .bl-x b:nth-child(1) { transform: rotate(45deg); }
.bl-hm .bl-x b:nth-child(2) { transform: rotate(-45deg); }

/* --- directional damage --------------------------------------------------- */
.bl-dmgwrap { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.bl-dmg {
  position: absolute; left: 50%; top: 50%; width: 30vmin; height: 30vmin;
  margin: -15vmin 0 0 -15vmin; opacity: 0;
  will-change: transform, opacity;
}
.bl-dmg svg { width: 100%; height: 100%; overflow: visible; }
.bl-dmg path { fill: url(#bl-dmg-grad); }

/* Full-screen states. The flash is a radial so the centre of vision stays
   readable — a flat red wash blinds the player at exactly the wrong moment. */
.bl-flash {
  position: absolute; inset: 0; opacity: 0; mix-blend-mode: screen;
  background: radial-gradient(ellipse at 50% 52%, rgba(150,18,10,0) 34%, rgba(168,26,14,.62) 88%, rgba(190,34,18,.8) 100%);
}
.bl-suppress {
  position: absolute; inset: 0; opacity: 0; pointer-events: none;
  background: radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 30%, rgba(4,6,9,.72) 100%);
}
.bl-lowhp {
  position: absolute; inset: 0; opacity: 0; pointer-events: none;
  box-shadow: inset 0 0 22vmin rgba(120,10,6,.55), inset 0 0 6vmin rgba(190,30,18,.35);
}

/* --- bottom-left: vitals --------------------------------------------------- */
/* ONE ENCODING. The block used to carry the number, the maximum, a bar, a ghost
   bar and the word STABLE — five marks for one scalar, four of which the player
   never looked at. What survives is the numeral: T1, and the only element on the
   HUD that is allowed to change hue, because a health value going amber and then
   red is the readout the low-health vignette is already reinforcing. */
.bl-bl {
  position: absolute; left: var(--safe); bottom: var(--safe);
  display: flex; align-items: flex-end; gap: calc(var(--u) * 1.5);
}
.bl-hpval {
  font-size: 34px; line-height: .8;
  transition: color var(--t-med) var(--ease);
}
.bl-bl.bl-hurt .bl-hpval { color: var(--warn); }
.bl-bl.bl-crit .bl-hpval { color: var(--hostile); }
.bl-bl.bl-crit .bl-hpval { animation: bl-pulse 1.1s var(--ease) infinite; }
.bl-bl.bl-regen .bl-hpval { color: var(--good); }

/* Stance glyph: a 14px silhouette that fades up when the stance actually
   changes and is gone two seconds later. It replaces the permanent
   SPRINT / CROUCH / PRONE / AIM legend, which was a control reference pinned to
   the screen — something no shipped shooter does past its tutorial. */
.bl-stance {
  flex: 0 0 auto; width: 17px; height: 25px; margin-bottom: 2px;
  opacity: 0; transition: opacity var(--t-med) var(--ease);
}
.bl-stance.on { opacity: 1; }
.bl-stance svg { display: block; width: 100%; height: 100%; overflow: visible; }
.bl-stance path, .bl-stance circle {
  fill: var(--t2);
  stroke: rgba(3,5,8,.8); stroke-width: 1.4; paint-order: stroke fill;
}
.bl-stance.acc path, .bl-stance.acc circle { fill: var(--friend); }

/* --- bottom-right: ammo ---------------------------------------------------- */
.bl-br { position: absolute; right: var(--safe); bottom: var(--safe); text-align: right; }
/* T2: the weapon name is checked between engagements, not during one. */
.bl-wname { font-size: 12px; }
/* T3: fire mode and class are provenance. */
.bl-wmode { margin: 3px 0 calc(var(--u) * .75); }
.bl-ammo { display: flex; align-items: baseline; justify-content: flex-end; gap: calc(var(--u) * .75); }
/* T1: the largest, heaviest thing on the HUD, because it is the one number the
   player reads without moving their eyes off the reticle. */
.bl-mag { font-size: 46px; line-height: .82; transition: color var(--t-fast) var(--ease); }
.bl-res { font-size: 14px; letter-spacing: .04em; }
.bl-br.bl-low .bl-mag { color: var(--warn); }
.bl-br.bl-empty .bl-mag { color: var(--hostile); animation: bl-pulse 1s var(--ease) infinite; }
@keyframes bl-pulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }
/* Magazine pips: the second read on the same number, kept because it is a shape
   rather than a repeat of the digits — deliberately T3 in value. */
.bl-pips { display: flex; gap: 2px; justify-content: flex-end; margin-top: calc(var(--u) * .75); height: 3px; }
.bl-pips i { width: 4px; height: 100%; background: rgba(203,217,232,.16); transition: background var(--t-fast) var(--ease); }
.bl-pips i.on { background: var(--t2); }
.bl-pips i.warn { background: var(--warn); }
.bl-reload { margin-top: calc(var(--u) * 1.25); width: calc(var(--u) * 18); height: 2px; background: rgba(255,255,255,.14); margin-left: auto; opacity: 0; transition: opacity var(--t-fast) var(--ease); }
.bl-reload.on { opacity: 1; }
.bl-reload i { display: block; height: 100%; width: 0%; background: var(--friend); }

/* --- top-centre column: heading chip, tape, scorebar, objective -------------
 * These four are stacked on one axis and share one material so the top of the
 * screen reads as a single instrument rather than four unrelated widgets. The
 * order is fixed: heading (where I am pointing), tape, score, objective (why I
 * am here) — most volatile at the top, most static at the bottom.
 *
 *   16 .. 32   heading chip
 *   40 .. 72   compass tape
 *   80 .. 114  score panel
 *  122 ..      objective, when it is showing at all
 */

/* The chip is the same dark glass and the same hairline as the score panel; it
   was previously an unstyled black box that belonged to nothing. */
.bl-bearing {
  position: absolute; left: 50%; top: calc(var(--u) * 2); transform: translateX(-50%);
  min-width: calc(var(--u) * 6); text-align: center;
  font-size: 11px; letter-spacing: .1em; font-weight: 600;
  color: var(--t2); text-shadow: var(--sh2);
  padding: 2px calc(var(--u) * .875) 1px;
  border: 1px solid var(--line);
  background: linear-gradient(180deg, var(--ink-1), var(--ink-2));
  backdrop-filter: blur(6px) saturate(.9);
}
/* Its pointer is the tape's lead marker — one mark doing both jobs. */
.bl-bearing::after {
  content: ''; position: absolute; left: 50%; top: 100%;
  width: 0; height: 0; margin-left: -3px;
  border: 3px solid transparent; border-top: 4px solid rgba(150,172,194,.55);
}

/* TICK BASELINE. Every tick, minor and major, ends on y=20 inside the strip;
   majors grow upward from it. Previously both were top-anchored at y=0 with
   different heights, so the majors hung four pixels below the minors and the
   tape had no baseline at all. */
.bl-compass {
  position: absolute; left: 50%; top: calc(var(--u) * 5); transform: translateX(-50%);
  width: calc(var(--u) * 54); height: calc(var(--u) * 4.5);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 16%, #000 84%, transparent);
          mask-image: linear-gradient(90deg, transparent, #000 16%, #000 84%, transparent);
}
.bl-compass .strip { position: absolute; left: 50%; top: 0; height: 36px; white-space: nowrap; will-change: transform; }
/* A 1px hairline over bright sky is not a low-contrast mark, it is an absent
   one. The ticks get the same dark halo the type does. */
.bl-compass .strip u {
  position: absolute; top: 12px; height: 6px; width: 1px;
  background: rgba(203,217,232,.4);
  box-shadow: 0 0 2px rgba(2,4,7,.85);
}
.bl-compass .strip u.maj { top: 8px; height: 10px; background: rgba(224,236,248,.72); }
/* Cardinals only. The tape used to carry a numeric bearing every 15 degrees as
   well, which put a three-digit label every 54 px — a continuous band of
   numerals with no rhythm, and one that collided with the cardinals it was
   supposed to sit between. The exact heading is in the chip above, to the
   degree; the tape's job is orientation, not precision. */
.bl-compass .strip s {
  position: absolute; top: 22px; font-size: 10px; letter-spacing: .14em; font-weight: 600;
  text-decoration: none; transform: translateX(-50%);
  color: var(--t2); text-shadow: var(--sh2);
}
/* The lead line stops exactly on the tick baseline. */
.bl-compass .lead {
  position: absolute; left: 50%; top: 6px; width: 1px; height: 12px;
  background: rgba(232,240,248,.85); transform: translateX(-50%);
  box-shadow: 0 0 3px rgba(2,4,7,.9);
}

/* --- score panel ------------------------------------------------------------ */
.bl-match {
  position: absolute; left: 50%; top: calc(var(--u) * 10); transform: translateX(-50%);
  display: flex; align-items: center; gap: calc(var(--u) * 2);
  padding: calc(var(--u) * .75) calc(var(--u) * 2);
}
/* Scores and clock are T2: read between engagements, never during one. */
.bl-match .sc { font-size: 18px; line-height: 1; min-width: 38px; text-align: center; font-weight: 700; text-shadow: var(--sh2); }
.bl-match .sc.a { color: rgba(99,200,255,.82); }
.bl-match .sc.b { color: rgba(255,90,65,.82); }
.bl-match .clk { font-size: 14px; color: var(--t2); letter-spacing: .06em; font-weight: 600; text-shadow: var(--sh2); }
.bl-match .clk.warn { color: var(--warn); }
.bl-match .rule { width: 1px; height: 14px; background: var(--line); }
.bl-scorebar { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: rgba(255,255,255,.08); }
.bl-scorebar i { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(99,200,255,.72); transition: width var(--t-slow) var(--ease-out); }
.bl-scorebar b { position: absolute; right: 0; top: 0; bottom: 0; background: rgba(255,90,65,.72); transition: width var(--t-slow) var(--ease-out); }

/* --- minimap --------------------------------------------------------------- */
.bl-map { position: absolute; left: var(--safe); top: var(--safe); width: calc(var(--u) * 21); }
.bl-map .frame { position: relative; width: 100%; aspect-ratio: 1; overflow: hidden; }
.bl-map canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.bl-map .rose { position: absolute; inset: 0; pointer-events: none; }
.bl-map .rose b {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
  font-size: 9px; letter-spacing: .18em; font-weight: 600; color: var(--t2);
  text-shadow: 0 0 4px rgba(0,0,0,.95), 0 1px 2px rgba(0,0,0,.9);
}
.bl-map .foot { display: flex; align-items: center; gap: var(--u); margin-top: calc(var(--u) * .75); }
.bl-map .foot .uav { margin-left: auto; color: var(--friend); opacity: 0; transition: opacity var(--t-med) var(--ease); }
.bl-map .foot .uav.on { opacity: 1; }

/* --- killfeed -------------------------------------------------------------- */
.bl-kf { position: absolute; right: var(--safe); top: var(--safe); display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.bl-kfrow {
  display: flex; align-items: center; gap: calc(var(--u) * .75);
  padding: 3px calc(var(--u) * 1.25); font-size: 11px; letter-spacing: .06em;
  color: var(--t2); text-shadow: var(--sh2);
  background: rgba(6,9,13,.62); border-right: 2px solid transparent;
  transform: translateX(12px); opacity: 0;
  transition: opacity var(--t-med) var(--ease), transform var(--t-med) var(--ease-out);
}
.bl-kfrow.in { transform: none; opacity: 1; }
.bl-kfrow.out { opacity: 0; transform: translateX(8px); }
.bl-kfrow.me { background: rgba(16,26,36,.72); border-right-color: rgba(99,200,255,.7); }
/* Desaturated from the full semantic hues. The killfeed was the loudest thing
   in the frame — six lines of maximum-chroma cyan and red at full value,
   against a scene that has no such colours anywhere in it. Team identity
   survives at three quarters of the value; the shouting does not. */
.bl-kfrow .a { color: rgba(126,203,246,.82); }
.bl-kfrow .b { color: rgba(255,116,92,.82); }
.bl-ico { width: 30px; height: 13px; fill: rgba(203,217,232,.34); flex: 0 0 auto; }
.bl-kfrow .hs { width: 11px; height: 11px; fill: rgba(255,181,69,.74); }

/* --- callouts / toasts ------------------------------------------------------ */
.bl-toasts {
  position: absolute; left: 50%; top: 26%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: var(--u);
  text-align: center; width: 60vw; pointer-events: none;
}
.bl-toast { opacity: 0; transform: translateY(8px) scale(.98); transition: opacity var(--t-med) var(--ease), transform var(--t-med) var(--ease-out); }
.bl-toast.in { opacity: 1; transform: none; }
.bl-toast b { display: block; font-size: 22px; letter-spacing: .3em; text-indent: .3em; }
.bl-toast span { display: block; font-size: 11px; letter-spacing: .24em; color: var(--fg-dim); margin-top: 4px; }
.bl-toast.streak b { color: var(--warn); }
.bl-toast.reward b { color: var(--friend); }
.bl-toast.bad b { color: var(--hostile); }

/* OBJECTIVE. It used to be pinned to bottom centre, which is the one region of
 * a first-person frame that is guaranteed to be occupied — the weapon is drawn
 * there in every single shot. It now hangs off the bottom of the score panel,
 * under the axis it belongs to, and it is a timed card: it announces itself on
 * a state change and then leaves. A permanent restatement of the game mode is
 * not information, it is furniture. */
.bl-obj {
  position: absolute; left: 50%; top: calc(var(--u) * 15.25); transform: translateX(-50%);
  text-align: center; white-space: nowrap;
  opacity: 0; transition: opacity var(--t-slow) var(--ease);
}
.bl-obj.on { opacity: 1; }
.bl-obj b { font-size: 10px; letter-spacing: .28em; text-indent: .28em; font-weight: 600; color: var(--t2); text-shadow: var(--sh2); }
.bl-obj span { display: block; font-size: 9px; letter-spacing: .2em; text-indent: .2em; color: var(--t3); text-shadow: var(--sh3); margin-top: 3px; }

/* Respawn counter, centre screen. */
.bl-respawn {
  position: absolute; inset: 0; display: flex; flex-direction: column; gap: var(--u);
  align-items: center; justify-content: center; opacity: 0; pointer-events: none;
  transition: opacity var(--t-med) var(--ease);
}
.bl-respawn.on { opacity: 1; }
.bl-respawn b { font-size: 12px; letter-spacing: .34em; color: rgba(255,90,65,.82); text-shadow: var(--sh2); }
.bl-respawn .n { font-size: 60px; line-height: 1; }
.bl-respawn span { font-size: 10px; }

/* Under the minimap, not in the bottom-left gutter: the vitals block owns that
   corner and a telemetry readout must never be what crowds it. */
.bl-perf {
  position: absolute; left: var(--safe); top: calc(var(--u) * 30);
  font-size: 10px; letter-spacing: .1em; color: var(--fg-mute); font-variant-numeric: tabular-nums;
}

/* =====================================================  scoreboard  ======== */

.bl-sb {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(3,5,8,.62); backdrop-filter: blur(8px);
  opacity: 0; pointer-events: none; transition: opacity var(--t-fast) var(--ease);
}
.bl-sb.on { opacity: 1; }
.bl-sb .wrap { width: min(1080px, 88vw); }
.bl-sb h2 { font-size: 13px; letter-spacing: .4em; color: var(--fg-dim); font-weight: 600; margin-bottom: calc(var(--u) * 2); text-align: center; }
.bl-sb .teams { display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--u) * 3); }
.bl-sbteam { padding: calc(var(--u) * 2); }
.bl-sbteam .hd { display: flex; align-items: baseline; gap: var(--u); border-bottom: 1px solid var(--line); padding-bottom: var(--u); margin-bottom: var(--u); }
.bl-sbteam .hd b { font-size: 15px; letter-spacing: .28em; }
.bl-sbteam .hd .s { margin-left: auto; font-size: 24px; line-height: 1; }
.bl-sbteam.a { border-left: 2px solid var(--friend); }
.bl-sbteam.a .hd b, .bl-sbteam.a .hd .s { color: var(--friend); }
.bl-sbteam.b { border-left: 2px solid var(--hostile); }
.bl-sbteam.b .hd b, .bl-sbteam.b .hd .s { color: var(--hostile); }
.bl-sbrow { display: grid; grid-template-columns: 1fr 34px 34px 34px 46px; gap: var(--u); font-size: 13px; padding: 3px 0; align-items: center; }
.bl-sbrow.head { font-size: 9px; letter-spacing: .2em; color: var(--fg-mute); border-bottom: 1px solid var(--line); padding-bottom: 5px; margin-bottom: 3px; }
.bl-sbrow span:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
.bl-sbrow .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: .05em; }
.bl-sbrow.you { background: rgba(99,200,255,.09); box-shadow: inset 2px 0 0 var(--friend); padding-left: 6px; }
.bl-sbrow.dead { opacity: .42; }

/* =====================================================  front end  ========= */

.bl-menu {
  position: absolute; inset: 0; display: none;
  align-items: stretch; justify-content: center;
  /* The live map is behind this. It used to be buried under a 90-96% opaque
     wash, which threw away the only atmosphere the front end had — the game
     itself. Now the scrim is a graded wedge: near-opaque down the left where
     the type sits, opening up to the right so the souk and the sky read
     through it. Blur plus desaturation keeps text legible without hiding the
     world. */
  background:
    linear-gradient(100deg, rgba(4,6,9,.94) 0%, rgba(4,6,9,.86) 34%,
                            rgba(4,6,9,.55) 62%, rgba(4,6,9,.42) 100%),
    radial-gradient(ellipse at 26% -10%, rgba(30,58,84,.55), transparent 64%),
    radial-gradient(ellipse at 120% 110%, rgba(96,58,26,.30), transparent 58%);
  backdrop-filter: blur(5px) saturate(.72) brightness(.78);
  pointer-events: auto;
  /* ABOVE THE TOUCH LAYER. The touch controls own a full-screen, hit-testable
     drag surface at z-index 30; with no z-index of its own this menu stacked
     below it, so on a phone every tap on DEPLOY landed on the look surface
     instead and the front end was unreachable. Below the loading screen (40),
     which must stay on top while the map builds. */
  z-index: 35;
  opacity: 0; transition: opacity var(--t-med) var(--ease);
}
.bl-menu.on { display: flex; opacity: 1; }
/* Panes are taller than a short viewport; the container scrolls rather than
   letting the bottom of the settings list fall off the screen. */
.bl-menu { overflow-y: auto; overscroll-behavior: contain; }
/* Faint scanline + grain: enough to sit the panel in a device, not a browser.
   Vignette is layered in here too so the open right-hand side of the scrim
   still falls off at the frame edge. */
.bl-menu::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .35;
  background:
    repeating-linear-gradient(180deg, rgba(255,255,255,.022) 0 1px, transparent 1px 3px);
}
.bl-menu::before {
  content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 2;
  background: radial-gradient(ellipse at 50% 50%, transparent 44%, rgba(0,0,0,.62) 100%);
}

/* Atmosphere layer: dust drifting through the light, and a slow sensor sweep.
   Both are pure CSS on two elements — no per-frame JS, so the front end costs
   nothing while the map renders behind it. */
.bl-atmos { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 1; }
.bl-atmos .motes {
  position: absolute; inset: -20% -10%;
  /* Four sizes of speck at four densities reads as depth; one layer reads as
     noise. The largest are nearest, so they move most. */
  background-image:
    radial-gradient(1.6px 1.6px at 12% 22%, rgba(255,238,214,.55), transparent 60%),
    radial-gradient(1.2px 1.2px at 68% 14%, rgba(255,238,214,.40), transparent 60%),
    radial-gradient(2.2px 2.2px at 34% 76%, rgba(255,238,214,.30), transparent 60%),
    radial-gradient(1px 1px at 84% 58%, rgba(255,238,214,.45), transparent 60%),
    radial-gradient(1.4px 1.4px at 52% 40%, rgba(255,238,214,.28), transparent 60%);
  background-size: 340px 300px, 520px 460px, 700px 620px, 260px 240px, 880px 700px;
  animation: bl-drift 64s linear infinite;
  opacity: .5;
}
@keyframes bl-drift {
  from { transform: translate3d(0, 0, 0); }
  to   { transform: translate3d(-340px, -300px, 0); }
}
.bl-atmos .sweep {
  position: absolute; left: 0; right: 0; height: 42%;
  background: linear-gradient(180deg, transparent, rgba(126,196,255,.045) 45%, transparent);
  animation: bl-sweep 11s cubic-bezier(.4, 0, .5, 1) infinite;
}
@keyframes bl-sweep {
  0%   { top: -45%; opacity: 0; }
  12%  { opacity: 1; }
  88%  { opacity: 1; }
  100% { top: 105%; opacity: 0; }
}
/* Letterbox. Thin — enough to say "camera feed", not enough to eat the page. */
.bl-atmos .bar { position: absolute; left: 0; right: 0; height: 26px; background: rgba(2,3,5,.85); }
.bl-atmos .bar.t { top: 0; box-shadow: 0 1px 0 rgba(255,255,255,.05); }
.bl-atmos .bar.b { bottom: 0; box-shadow: 0 -1px 0 rgba(255,255,255,.05); }

@media (prefers-reduced-motion: reduce) {
  .bl-atmos .motes, .bl-atmos .sweep { animation: none; }
}
.bl-mwrap { position: relative; z-index: 1; width: min(1180px, 92vw); margin: auto; padding: calc(var(--u) * 4) 0; }

.bl-title { margin-bottom: calc(var(--u) * 5); }
.bl-title .eyebrow {
  display: flex; align-items: center; gap: calc(var(--u) * 1.5);
  font-size: 10px; letter-spacing: .5em; color: var(--fg-mute);
}
/* Recording tally. Slow, uneven blink — a metronome reads as a CSS animation,
   which is exactly what it must not look like. */
.bl-title .eyebrow .live {
  width: 6px; height: 6px; border-radius: 50%; background: var(--enemy, #d8452f);
  box-shadow: 0 0 8px rgba(216,69,47,.85); animation: bl-tally 3.4s ease-in-out infinite;
}
@keyframes bl-tally {
  0%, 46% { opacity: 1; }
  52%, 60% { opacity: .18; }
  66%, 100% { opacity: 1; }
}
.bl-title .eyebrow .clk {
  margin-left: auto; font-variant-numeric: tabular-nums; letter-spacing: .28em;
  color: var(--fg-dim); opacity: .8;
}
@media (prefers-reduced-motion: reduce) { .bl-title .eyebrow .live { animation: none; } }
.bl-title h1 {
  font-size: clamp(38px, 6.4vw, 76px); line-height: .94; font-weight: 700;
  letter-spacing: .12em; margin: calc(var(--u) * 1.5) 0 calc(var(--u) * 1.5);
}
.bl-title h1 em { font-style: normal; color: var(--friend); }
.bl-title .sub { font-size: 11px; letter-spacing: .3em; color: var(--fg-dim); }
.bl-title .rule { height: 1px; background: linear-gradient(90deg, var(--line-2), transparent); margin-top: calc(var(--u) * 2); }

/* Creator credit, under the menu columns. Sits in the tertiary tier of the
   type hierarchy — the name is the only part at full weight, everything around
   it is dimmed, so it reads without competing with the title. */
.bl-credit {
  display: flex; align-items: center; gap: calc(var(--u) * 1.5);
  margin-top: calc(var(--u) * 5); padding-top: calc(var(--u) * 2.5);
  border-top: 1px solid var(--line-2);
  font-size: 10px; letter-spacing: .34em; color: var(--fg-mute);
}
.bl-credit .by { opacity: .7; }
.bl-credit strong { font-weight: 700; letter-spacing: .3em; color: var(--fg); }
.bl-credit i { width: 14px; height: 1px; background: var(--line-2); opacity: .9; }
.bl-credit .studio { color: var(--friend); letter-spacing: .3em; }

.bl-cols { display: grid; grid-template-columns: 280px 1fr; gap: calc(var(--u) * 5); align-items: start; }

.bl-nav { display: flex; flex-direction: column; gap: 1px; }
.bl-btn {
  position: relative; display: flex; align-items: center; gap: var(--u);
  padding: calc(var(--u) * 1.5) calc(var(--u) * 2);
  font-family: var(--font); font-size: 14px; letter-spacing: .22em; font-weight: 600;
  color: var(--fg-dim); background: rgba(255,255,255,.025); border: 0;
  border-left: 2px solid transparent; cursor: pointer; text-align: left;
  transition: color var(--t-fast) var(--ease), background var(--t-fast) var(--ease),
              border-color var(--t-fast) var(--ease), padding-left var(--t-fast) var(--ease);
}
.bl-btn:hover, .bl-btn:focus-visible { color: var(--fg); background: rgba(99,200,255,.10); border-left-color: var(--friend); padding-left: calc(var(--u) * 2.5); outline: none; }
.bl-btn.primary { color: var(--ink-0); background: var(--friend); border-left-color: var(--friend); }
.bl-btn.primary:hover { background: #8ad9ff; color: var(--ink-0); }
.bl-btn .k { margin-left: auto; font-size: 10px; letter-spacing: .16em; opacity: .5; }
.bl-btn:disabled { opacity: .3; cursor: default; }

.bl-pane { padding: calc(var(--u) * 3); min-height: calc(var(--u) * 44); }
.bl-pane h3 { font-size: 11px; letter-spacing: .36em; color: var(--fg-mute); font-weight: 600; margin-bottom: calc(var(--u) * 2); }
.bl-pane p { font-size: 13px; line-height: 1.6; color: var(--fg-dim); max-width: 62ch; }

/* Settings rows. */
.bl-set { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--u) * 2); padding: calc(var(--u) * 1.25) 0; border-bottom: 1px solid rgba(196,214,232,.07); }
.bl-set .nm { flex: 0 0 200px; font-size: 12px; letter-spacing: .14em; color: var(--fg); }
.bl-set .hint { flex: 1 0 100%; font-size: 10px; letter-spacing: .08em; line-height: 1.5; color: var(--fg-mute); padding-left: calc(200px + var(--u) * 2); margin: -4px 0 0; }
.bl-set input[type=range] { flex: 1; -webkit-appearance: none; appearance: none; height: 2px; background: rgba(255,255,255,.16); outline: none; cursor: pointer; }
.bl-set input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; background: var(--friend); cursor: pointer; border-radius: 0; transition: transform var(--t-fast) var(--ease); }
.bl-set input[type=range]::-webkit-slider-thumb:hover { transform: scale(1.25); }
.bl-set input[type=range]::-moz-range-thumb { width: 12px; height: 12px; background: var(--friend); border: 0; border-radius: 0; }
.bl-set .val { flex: 0 0 76px; text-align: right; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--fg); }
.bl-seg { display: flex; gap: 1px; }
.bl-seg button {
  font-family: var(--font); font-size: 11px; letter-spacing: .18em; font-weight: 600;
  padding: 7px 14px; color: var(--fg-mute); background: rgba(255,255,255,.04); border: 0; cursor: pointer;
  transition: color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.bl-seg button:hover { color: var(--fg); }
.bl-seg button.on { color: var(--ink-0); background: var(--friend); }

/* Loadout cards. */
.bl-guns { display: grid; grid-template-columns: repeat(3, 1fr); gap: calc(var(--u) * 2); }
.bl-gun {
  padding: calc(var(--u) * 2); text-align: left; cursor: pointer; border: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012));
  transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease), transform var(--t-fast) var(--ease-out);
  font-family: var(--font); color: var(--fg);
}
.bl-gun:hover { transform: translateY(-2px); border-color: var(--line-2); }
.bl-gun.on { border-color: var(--friend); background: linear-gradient(180deg, rgba(99,200,255,.14), rgba(99,200,255,.03)); }
.bl-gun .cls { font-size: 9px; letter-spacing: .28em; color: var(--fg-mute); }
.bl-gun .nm { font-size: 21px; letter-spacing: .1em; margin: 4px 0 calc(var(--u) * 1.5); }
.bl-gun svg { width: 100%; height: 42px; fill: var(--fg-dim); margin-bottom: calc(var(--u) * 1.5); }
.bl-gun.on svg { fill: var(--friend); }
.bl-stat { display: flex; align-items: center; gap: var(--u); margin-bottom: 5px; }
.bl-stat .l { flex: 0 0 74px; font-size: 9px; letter-spacing: .18em; color: var(--fg-mute); }
.bl-stat .m { flex: 1; height: 3px; background: rgba(255,255,255,.10); }
.bl-stat .m i { display: block; height: 100%; background: var(--fg-dim); transition: width var(--t-med) var(--ease-out); }
.bl-gun.on .bl-stat .m i { background: var(--friend); }

/* End-of-match summary. */
.bl-sum { text-align: center; }
.bl-sum .verdict { font-size: clamp(34px, 5vw, 58px); letter-spacing: .28em; text-indent: .28em; line-height: 1; }
.bl-sum .verdict.win { color: var(--friend); }
.bl-sum .verdict.lose { color: var(--hostile); }
.bl-sum .verdict.draw { color: var(--warn); }
.bl-sum .score { font-size: 20px; letter-spacing: .2em; color: var(--fg-dim); margin-top: var(--u); }
.bl-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: calc(var(--u) * 2); margin: calc(var(--u) * 4) 0; }
.bl-card { padding: calc(var(--u) * 2); text-align: left; }
.bl-card .l { font-size: 9px; letter-spacing: .24em; color: var(--fg-mute); }
.bl-card .v { font-size: 30px; line-height: 1.05; margin-top: 6px; }
.bl-card .s { font-size: 10px; letter-spacing: .14em; color: var(--fg-dim); margin-top: 4px; }

/* =====================================================  loading  =========== */

.bl-load {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at 50% 60%, #0b1119, #04060a 70%);
  pointer-events: auto; z-index: 40;
  transition: opacity var(--t-slow) var(--ease);
}
.bl-load.gone { opacity: 0; pointer-events: none; }
.bl-load .box { width: min(620px, 82vw); }
.bl-load .eyebrow { font-size: 10px; letter-spacing: .5em; color: var(--fg-mute); }
.bl-load h1 { font-size: clamp(30px, 5vw, 52px); letter-spacing: .14em; font-weight: 700; margin: var(--u) 0 calc(var(--u) * 4); }
.bl-load h1 em { font-style: normal; color: var(--friend); }
.bl-load .bar { height: 2px; background: rgba(255,255,255,.12); position: relative; overflow: hidden; }
.bl-load .bar i { position: absolute; inset: 0 auto 0 0; width: 0%; background: var(--friend); transition: width .18s var(--ease-out); }
.bl-load .meta { display: flex; margin-top: var(--u); font-size: 10px; letter-spacing: .22em; color: var(--fg-mute); }
.bl-load .meta .pc { margin-left: auto; color: var(--fg-dim); font-variant-numeric: tabular-nums; }
.bl-load .tips { margin-top: calc(var(--u) * 5); font-size: 11px; letter-spacing: .14em; color: var(--fg-mute); line-height: 1.9; }
.bl-load .tips b { color: var(--fg-dim); font-weight: 600; }

/* Keyboard legend used on the title and pause panes. */
.bl-keys { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px calc(var(--u) * 3); margin-top: calc(var(--u) * 2); }
.bl-keys div { display: flex; align-items: center; gap: var(--u); font-size: 11px; letter-spacing: .12em; color: var(--fg-mute); }
.bl-keys kbd {
  font-family: var(--font); font-size: 10px; letter-spacing: .1em; min-width: 30px; text-align: center;
  padding: 3px 6px; color: var(--fg-dim); background: rgba(255,255,255,.06); border: 1px solid var(--line);
}

@media (max-width: 900px) {
  .bl-cols { grid-template-columns: 1fr; }
  .bl-sb .teams, .bl-cards { grid-template-columns: 1fr; }
  .bl-guns { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .bl-root * { transition-duration: .01ms !important; animation-duration: .01ms !important; }
}


/* ------------------------------------------------------------------ touch */
/* Built only on coarse-pointer devices. Everything is sized off dynamic
   viewport units and safe-area insets so a notch, a home indicator or the
   browser's collapsing address bar cannot push a control off screen. */
.bl-touch { position: fixed; inset: 0; z-index: 30; pointer-events: none; touch-action: none; }
.bl-touch > * { pointer-events: auto; }
/* The drag surface for move and look. Full-screen and explicitly hit-testable:
   the container above is pointer-events:none so the HUD never eats taps, which
   means the gestures need a real element of their own to land on. */
.tc-surface { position: absolute; inset: 0; pointer-events: auto; touch-action: none; }

/* Positioned by transform from a REAL resting place, never by bare left/top.
   With \`left\`/\`top\` unset a fixed element falls back to its static position,
   which for the first child of a full-screen fixed layer is the top-left corner
   — so any path that showed the ring without assigning offsets parked it in the
   corner, pulled further off screen by the negative margin. A player reported
   exactly that. Now the default IS a plausible thumb rest, and the script only
   displaces it. */
.tc-stick {
  position: fixed; left: 0; top: 0; width: 132px; height: 132px;
  margin: -66px 0 0 -66px;
  transform: translate(22vw, 68vh);
  opacity: 0; transition: opacity .12s; pointer-events: none;
}
.tc-stick.on { opacity: 1; }
.tc-stick .ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: 1px solid rgba(255,255,255,.22); background: rgba(6,9,14,.28);
}
.tc-stick .knob {
  position: absolute; left: 50%; top: 50%; width: 54px; height: 54px;
  margin: 0; border-radius: 50%; transform: translate(-50%, -50%);
  background: rgba(232,238,245,.30); border: 1px solid rgba(255,255,255,.45);
}

.tc-btn {
  -webkit-tap-highlight-color: transparent; user-select: none;
  font: 700 11px/1 inherit; letter-spacing: .18em; color: var(--fg);
  background: rgba(10,14,20,.46); border: 1px solid rgba(255,255,255,.20);
  border-radius: 10px; backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center;
}
.tc-btn.down { background: rgba(126,196,255,.30); border-color: rgba(126,196,255,.8); }

.tc-right {
  position: fixed; display: flex; flex-direction: column; gap: 14px; align-items: flex-end;
  right: max(18px, env(safe-area-inset-right)); bottom: max(22px, env(safe-area-inset-bottom));
}
/* The fire button is deliberately the largest target on the screen and sits
   under the natural resting arc of the right thumb. */
.tc-fire { width: 92px; height: 92px; border-radius: 50%; }
.tc-fire::after {
  content: ''; width: 26px; height: 26px; border-radius: 50%;
  background: rgba(232,238,245,.55); box-shadow: 0 0 0 6px rgba(232,238,245,.12);
}
.tc-ads { width: 68px; height: 68px; border-radius: 50%; }

.tc-left-btns {
  position: fixed; display: flex; flex-direction: column; gap: 10px;
  left: max(18px, env(safe-area-inset-left)); bottom: max(22px, env(safe-area-inset-bottom));
}
.tc-sm { width: 74px; height: 40px; }

/* The way back into the front end. A phone has no ESC and never takes pointer
   lock, so without this button a touch player who deploys can never reach the
   loadout, the settings or the mixer again for the rest of the session. Top
   centre-right, clear of both thumbs' arcs. */
.tc-top {
  position: fixed; display: flex; gap: 10px;
  top: max(12px, env(safe-area-inset-top)); right: max(18px, env(safe-area-inset-right));
}
.tc-top .tc-btn { width: 62px; height: 32px; font-size: 10px; opacity: .72; }

/* Nothing in the touch layer may show through or under a front-end screen: the
   scrim is deliberately translucent on its right-hand side, so the fire button
   would ghost through it. Removing the layer also releases a latched stick,
   because the pointerup still arrives on window. */
body:has(.bl-menu.on) .bl-touch { display: none; }

/* The browser must not treat a thumb drag as a scroll or a page gesture. The
   layer already sets \`touch-action: none\`, but a scrollable document can still
   claim the gesture on some mobile engines, so it is refused at the root too. */
body.is-touch, body.is-touch html { overscroll-behavior: none; }
body.is-touch { touch-action: none; -webkit-user-select: none; user-select: none; }

/* MOVE ZONE AFFORDANCE. The stick is invisible until a thumb lands on it, which
   is correct for a floating stick and useless for discovery: nothing said the
   left half of the screen was a movement surface, and a player asked how to walk
   forward. This is a low-contrast hint that fades once the stick has been used,
   so it teaches the control and then gets out of the way. */
.tc-hint {
  position: fixed; left: max(20px, env(safe-area-inset-left)); bottom: 96px;
  width: 118px; height: 118px; border-radius: 50%; pointer-events: none;
  border: 1px dashed rgba(198,220,242,.20);
  display: flex; align-items: flex-end; justify-content: center;
  font: 700 9px/1 inherit; letter-spacing: .22em; color: rgba(198,220,242,.42);
  padding-bottom: 10px;
  transition: opacity .5s var(--ease);
}
.tc-hint::before {
  content: ''; position: absolute; left: 50%; top: 24px; width: 0; height: 0;
  transform: translateX(-50%);
  border-left: 5px solid transparent; border-right: 5px solid transparent;
  border-bottom: 7px solid rgba(198,220,242,.34);
}
.bl-touch.used .tc-hint { opacity: 0; }

/* Input readout for diagnosing a device that cannot be reproduced locally. */
.tc-dbg {
  position: fixed; left: 50%; top: max(8px, env(safe-area-inset-top));
  transform: translateX(-50%);
  font: 600 10px/1.45 ui-monospace, monospace; white-space: pre;
  color: #cfe6ff; background: rgba(4,7,11,.82); border: 1px solid rgba(126,196,255,.4);
  border-radius: 6px; padding: 5px 8px; pointer-events: none; z-index: 60;
}

/* On a phone the HUD has to give up room: the keybind legend is meaningless
   without a keyboard, and the minimap competes with the left thumb. */
body.is-touch .bl-keyhint, body.is-touch .bl-perf { display: none !important; }
/* The ammo readout lives in the bottom-right corner, which is exactly where
   the fire and ADS buttons go. Lift it clear of them rather than letting the
   two overlap — a number you cannot read under your own thumb is worse than
   no number. */
body.is-touch .bl-ammo { bottom: 128px !important; right: 118px !important; }
body.is-touch .bl-vitals { bottom: 96px !important; }
@media (max-width: 820px) {
  body.is-touch .bl-map { transform: scale(.72); transform-origin: top left; }
  .bl-title h1 { font-size: clamp(30px, 9vw, 52px); }
  .bl-cols { grid-template-columns: 1fr; gap: calc(var(--u) * 3); }
  .bl-credit { flex-wrap: wrap; }
}
/* Landscape phones are short: the front end must scroll rather than clip. */
@media (max-height: 460px) {
  .bl-mwrap { padding: calc(var(--u) * 2) 0; }
  .bl-title { margin-bottom: calc(var(--u) * 2.5); }
}
`;

/** Inject once; safe to call from several places. */
export function installStyles() {
  if (document.getElementById('bl-ui-style')) return;
  const st = document.createElement('style');
  st.id = 'bl-ui-style';
  st.textContent = UI_CSS;
  document.head.appendChild(st);
}
