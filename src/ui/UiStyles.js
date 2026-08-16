/**
 * OWNER: UI/UX agent.
 *
 * The HUD's visual language, in one place.
 *
 * Rules the whole sheet obeys:
 *   - One 8px grid. Every offset, gap and size is a multiple of `--u`.
 *   - Condensed type only, tracked wide for labels and tight for numerals,
 *     tabular figures everywhere a number changes at runtime so nothing jitters.
 *   - Rules are 1px and low-contrast; weight comes from tracking and value, not
 *     from borders. Panels are dark glass with a single accent edge.
 *   - Nothing snaps. Every state change is eased on `--ease`, and the durations
 *     are quantised to three steps so unrelated elements move in sympathy.
 *   - Colour is semantic: friendly cyan, hostile red, caution amber, and a
 *     desaturated ink for everything that is only structure.
 *   - A hairline chromatic edge (one red and one cyan sub-pixel offset) sits on
 *     the primary readouts. It reads as an optical artefact of the display the
 *     numbers are supposedly rendered on, not as a drop shadow.
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
  -webkit-font-smoothing: antialiased;
  user-select: none;
  --hud-a: 1;                      /* master HUD fade, driven from JS */
}
.bl-root * { box-sizing: border-box; }

/* Structural type roles. */
.bl-lab {
  font-size: 10px; letter-spacing: .24em; font-weight: 600;
  color: var(--fg-mute); text-transform: uppercase;
}
.bl-num { font-variant-numeric: tabular-nums; letter-spacing: .01em; font-weight: 700; }
.bl-brk { opacity: .35; padding: 0 .35em; }
.bl-chroma { text-shadow: .7px 0 0 rgba(255,64,40,.30), -.7px 0 0 rgba(64,190,255,.28), 0 2px 12px rgba(0,0,0,.85); }

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
   projected to pixels, so the reticle is a readout, not a decoration. */
.bl-xh {
  --gap: 9px; --blade: 7px; --w: 2px; --a: 1;
  position: absolute; left: 50%; top: 50%; width: 0; height: 0;
  opacity: var(--a);
  will-change: opacity;
}
.bl-xh b {
  position: absolute; background: #eef5ff; display: block;
  box-shadow: 0 0 2px rgba(0,0,0,.95), 0 0 6px rgba(0,0,0,.55);
}
.bl-xh .t { width: var(--w); height: var(--blade); left: calc(var(--w) / -2); top: calc(0px - var(--gap) - var(--blade)); }
.bl-xh .b { width: var(--w); height: var(--blade); left: calc(var(--w) / -2); top: var(--gap); }
.bl-xh .l { height: var(--w); width: var(--blade); top: calc(var(--w) / -2); left: calc(0px - var(--gap) - var(--blade)); }
.bl-xh .r { height: var(--w); width: var(--blade); top: calc(var(--w) / -2); left: var(--gap); }
.bl-xh .dot { width: 2px; height: 2px; left: -1px; top: -1px; opacity: .6; border-radius: 50%; }
/* Sprint/obstructed state: blades retract and the dot dims. */
.bl-xh.bl-idle { --blade: 4px; }

/* Hitmarker: three grades, differentiated by colour, spread and blade weight. */
.bl-hm {
  position: absolute; left: 50%; top: 50%; width: 34px; height: 34px;
  transform: translate(-50%,-50%) scale(1); opacity: 0;
  will-change: transform, opacity;
}
.bl-hm i {
  position: absolute; width: 10px; height: 2px; background: #fff;
  box-shadow: 0 0 3px rgba(0,0,0,.9);
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
.bl-bl { position: absolute; left: var(--safe); bottom: var(--safe); width: calc(var(--u) * 34); }
.bl-hprow { display: flex; align-items: flex-end; gap: var(--u); margin-bottom: calc(var(--u) * .75); }
.bl-hpval { font-size: 30px; line-height: .84; }
.bl-hpmax { font-size: 12px; color: var(--fg-mute); padding-bottom: 3px; }
.bl-hpstate { margin-left: auto; font-size: 10px; letter-spacing: .2em; color: var(--fg-mute); padding-bottom: 4px; }
.bl-hpbar { position: relative; height: 5px; background: rgba(255,255,255,.10); overflow: hidden; }
/* Ghost bar lags the real one, so the size of a hit is visible after it lands. */
.bl-hpbar .ghost { position: absolute; inset: 0; width: 100%; background: rgba(255,90,65,.45); transition: width .55s .18s var(--ease-out); }
.bl-hpbar .fill { position: absolute; inset: 0; width: 100%; background: var(--fg); transition: width var(--t-fast) linear, background var(--t-med) var(--ease); }
.bl-hpbar .seg { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(5,7,10,.85); }
.bl-bl.bl-hurt .fill { background: var(--warn); }
.bl-bl.bl-crit .fill { background: var(--hostile); }
.bl-bl.bl-crit .bl-hpval { color: var(--hostile); }
.bl-bl.bl-regen .bl-hpstate { color: var(--good); }
.bl-stance { display: flex; gap: calc(var(--u) * 2); margin-top: calc(var(--u) * 1.25); }
.bl-stance span { font-size: 10px; letter-spacing: .2em; color: var(--fg-mute); transition: color var(--t-fast) var(--ease); }
.bl-stance span.on { color: var(--friend); }

/* --- bottom-right: ammo ---------------------------------------------------- */
.bl-br { position: absolute; right: var(--safe); bottom: var(--safe); text-align: right; }
.bl-wname { font-size: 13px; letter-spacing: .22em; color: var(--fg-dim); }
.bl-wmode { font-size: 10px; letter-spacing: .2em; color: var(--fg-mute); margin: 2px 0 calc(var(--u) * .75); }
.bl-ammo { display: flex; align-items: baseline; justify-content: flex-end; gap: calc(var(--u) * .75); }
.bl-mag { font-size: 46px; line-height: .82; transition: color var(--t-fast) var(--ease); }
.bl-res { font-size: 16px; color: var(--fg-mute); }
.bl-br.bl-low .bl-mag { color: var(--warn); }
.bl-br.bl-empty .bl-mag { color: var(--hostile); animation: bl-pulse 1s var(--ease) infinite; }
@keyframes bl-pulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }
/* Magazine pips: a glanceable second read on the same number. */
.bl-pips { display: flex; gap: 2px; justify-content: flex-end; margin-top: calc(var(--u) * .75); height: 4px; }
.bl-pips i { width: 4px; height: 100%; background: var(--fg-mute); transition: background var(--t-fast) var(--ease); }
.bl-pips i.on { background: var(--fg); }
.bl-pips i.warn { background: var(--warn); }
.bl-reload { margin-top: calc(var(--u) * 1.25); width: calc(var(--u) * 18); height: 2px; background: rgba(255,255,255,.14); margin-left: auto; opacity: 0; transition: opacity var(--t-fast) var(--ease); }
.bl-reload.on { opacity: 1; }
.bl-reload i { display: block; height: 100%; width: 0%; background: var(--friend); }

/* --- compass --------------------------------------------------------------- */
.bl-compass {
  position: absolute; left: 50%; top: calc(var(--u) * 3); transform: translateX(-50%);
  width: calc(var(--u) * 54); height: calc(var(--u) * 4);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent);
          mask-image: linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent);
}
.bl-compass .strip { position: absolute; left: 50%; top: 10px; height: 18px; white-space: nowrap; will-change: transform; }
.bl-compass .strip u { position: absolute; top: 0; width: 1px; height: 5px; background: rgba(255,255,255,.3); }
.bl-compass .strip u.maj { height: 9px; background: rgba(255,255,255,.55); }
.bl-compass .strip s {
  position: absolute; top: 10px; font-size: 11px; letter-spacing: .12em; font-weight: 700;
  text-decoration: none; transform: translateX(-50%); color: var(--fg-dim);
}
.bl-compass .strip s.card { color: var(--fg); }
.bl-compass .lead { position: absolute; left: 50%; top: 2px; width: 1px; height: 8px; background: var(--fg); transform: translateX(-50%); }
.bl-bearing {
  position: absolute; left: 50%; top: calc(var(--u) * 7); transform: translateX(-50%);
  font-size: 11px; letter-spacing: .1em; color: var(--fg-dim); padding: 1px 6px;
  border: 1px solid var(--line); background: var(--ink-1);
}

/* --- match bar (top centre, above compass) ---------------------------------- */
.bl-match {
  position: absolute; left: 50%; top: calc(var(--u) * 12); transform: translateX(-50%);
  display: flex; align-items: center; gap: calc(var(--u) * 2);
  padding: calc(var(--u) * .75) calc(var(--u) * 2);
}
.bl-match .sc { font-size: 20px; line-height: 1; min-width: 42px; text-align: center; }
.bl-match .sc.a { color: var(--friend); }
.bl-match .sc.b { color: var(--hostile); }
.bl-match .clk { font-size: 15px; color: var(--fg); letter-spacing: .06em; }
.bl-match .clk.warn { color: var(--warn); }
.bl-match .rule { width: 1px; height: 16px; background: var(--line); }
.bl-match .mode { font-size: 9px; letter-spacing: .24em; color: var(--fg-mute); }
.bl-scorebar { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: rgba(255,255,255,.10); }
.bl-scorebar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--friend); transition: width var(--t-slow) var(--ease-out); }
.bl-scorebar b { position: absolute; right: 0; top: 0; bottom: 0; background: var(--hostile); transition: width var(--t-slow) var(--ease-out); }

/* --- minimap --------------------------------------------------------------- */
.bl-map { position: absolute; left: var(--safe); top: var(--safe); width: calc(var(--u) * 21); }
.bl-map .frame { position: relative; width: 100%; aspect-ratio: 1; overflow: hidden; }
.bl-map canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.bl-map .rose { position: absolute; inset: 0; pointer-events: none; }
.bl-map .rose b {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
  font-size: 9px; letter-spacing: .18em; color: var(--fg-dim);
  text-shadow: 0 0 4px rgba(0,0,0,.9);
}
.bl-map .foot { display: flex; align-items: center; gap: var(--u); margin-top: calc(var(--u) * .75); }
.bl-map .foot .nm { font-size: 10px; letter-spacing: .2em; color: var(--fg-mute); }
.bl-map .foot .uav { margin-left: auto; font-size: 10px; letter-spacing: .18em; color: var(--friend); opacity: 0; transition: opacity var(--t-med) var(--ease); }
.bl-map .foot .uav.on { opacity: 1; }

/* --- killfeed -------------------------------------------------------------- */
.bl-kf { position: absolute; right: var(--safe); top: var(--safe); display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.bl-kfrow {
  display: flex; align-items: center; gap: calc(var(--u) * .75);
  padding: 3px calc(var(--u) * 1.25); font-size: 12px; letter-spacing: .06em;
  background: rgba(6,9,13,.62); border-right: 2px solid transparent;
  transform: translateX(12px); opacity: 0;
  transition: opacity var(--t-med) var(--ease), transform var(--t-med) var(--ease-out);
}
.bl-kfrow.in { transform: none; opacity: 1; }
.bl-kfrow.out { opacity: 0; transform: translateX(8px); }
.bl-kfrow.me { background: rgba(16,26,36,.78); border-right-color: var(--friend); }
.bl-kfrow .a { color: var(--friend); }
.bl-kfrow .b { color: var(--hostile); }
.bl-ico { width: 34px; height: 14px; fill: var(--fg-dim); flex: 0 0 auto; }
.bl-kfrow .hs { width: 11px; height: 11px; fill: var(--warn); }

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

/* Objective strip, bottom centre — persistent, low weight. */
.bl-obj {
  position: absolute; left: 50%; bottom: calc(var(--u) * 3); transform: translateX(-50%);
  text-align: center; opacity: .0; transition: opacity var(--t-med) var(--ease);
}
.bl-obj.on { opacity: 1; }
.bl-obj b { font-size: 12px; letter-spacing: .26em; color: var(--fg-dim); }
.bl-obj span { display: block; font-size: 10px; letter-spacing: .16em; color: var(--fg-mute); margin-top: 3px; }

/* Respawn counter, centre screen. */
.bl-respawn {
  position: absolute; inset: 0; display: flex; flex-direction: column; gap: var(--u);
  align-items: center; justify-content: center; opacity: 0; pointer-events: none;
  transition: opacity var(--t-med) var(--ease);
}
.bl-respawn.on { opacity: 1; }
.bl-respawn b { font-size: 13px; letter-spacing: .34em; color: var(--hostile); }
.bl-respawn .n { font-size: 64px; line-height: 1; }
.bl-respawn span { font-size: 11px; letter-spacing: .2em; color: var(--fg-mute); }

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
  background:
    radial-gradient(ellipse at 30% 0%, rgba(24,44,64,.55), transparent 62%),
    linear-gradient(180deg, rgba(4,6,9,.90), rgba(4,6,9,.96));
  backdrop-filter: blur(10px) saturate(.8);
  pointer-events: auto;
  opacity: 0; transition: opacity var(--t-med) var(--ease);
}
.bl-menu.on { display: flex; opacity: 1; }
/* Panes are taller than a short viewport; the container scrolls rather than
   letting the bottom of the settings list fall off the screen. */
.bl-menu { overflow-y: auto; overscroll-behavior: contain; }
/* Faint scanline + grain: enough to sit the panel in a device, not a browser. */
.bl-menu::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .35;
  background: repeating-linear-gradient(180deg, rgba(255,255,255,.022) 0 1px, transparent 1px 3px);
}
.bl-mwrap { position: relative; z-index: 1; width: min(1180px, 92vw); margin: auto; padding: calc(var(--u) * 4) 0; }

.bl-title { margin-bottom: calc(var(--u) * 5); }
.bl-title .eyebrow { font-size: 10px; letter-spacing: .5em; color: var(--fg-mute); }
.bl-title h1 {
  font-size: clamp(38px, 6.4vw, 76px); line-height: .94; font-weight: 700;
  letter-spacing: .12em; margin: calc(var(--u) * 1.5) 0 calc(var(--u) * 1.5);
}
.bl-title h1 em { font-style: normal; color: var(--friend); }
.bl-title .sub { font-size: 11px; letter-spacing: .3em; color: var(--fg-dim); }
.bl-title .rule { height: 1px; background: linear-gradient(90deg, var(--line-2), transparent); margin-top: calc(var(--u) * 2); }

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
`;

/** Inject once; safe to call from several places. */
export function installStyles() {
  if (document.getElementById('bl-ui-style')) return;
  const st = document.createElement('style');
  st.id = 'bl-ui-style';
  st.textContent = UI_CSS;
  document.head.appendChild(st);
}
