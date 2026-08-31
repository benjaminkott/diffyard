/**
 * The report's stylesheet.
 *
 * One file because it is one design: the tokens at the top are the whole
 * vocabulary, and a rule that reaches past them is the thing to notice.
 */
export const STYLES = `
/* ------------------------------------------------------------------ tokens
   Two scales and nothing outside them: type in five steps, space in a 4px
   rhythm. Values picked once here are the difference between a page that
   looks designed and one that looks assembled. */
:root {
  /*
   * One theme, and it is dark. The pages being reviewed are almost always
   * light, so a dark surround leaves the screenshots the brightest thing on
   * the page instead of competing with them — and a report that followed the
   * system would judge the same two shots against two different grounds.
   */
  color-scheme: dark;

  /* Neutral ground, so the only colour on the page means something. */
  --bg: #131516;
  --surface: #191c1d;
  --raised: #202425;
  --border: #292e30;
  --border-strong: #3c4245;
  --text: #e8eaea;
  --muted: #99a1a3;
  --subtle: #6e7679;

  /*
   * Three meanings, three hues: amber is active or picked, mint is fine, red
   * is broken. Amber is the mark's own colour, used as the mark has it —
   * against this ground it carries text at 9.5:1, and takes the mark's ink
   * back as the label on a filled chip.
   *
   * An errored capture takes a rust of its own rather than the amber it used
   * to have: "this is the one you picked" and "this one broke" cannot be the
   * same hue.
   */
  --accent: #f5b700;
  --pass: #4fd3a2;
  --fail: #ff6b6b;
  --error: #f0916a;
  --skip: #6e7679;
  --on-accent: #15191c;

  /*
   * Sequential ramp for "how much differs". A magnitude is not a meaning, so
   * it spends no hue on one: it is ink, thin to heavy. That also keeps it out
   * of the way of the three that do mean something.
   */
  --level-1: #23282a;
  --level-2: #333a3c;
  --level-3: #4a5255;
  --level-4: #6d7679;
  --level-5: #9aa2a5;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, .3);
  --shadow: 0 1px 2px rgba(0, 0, 0, .35), 0 4px 14px rgba(0, 0, 0, .28);
  --shadow-lifted: 0 2px 6px rgba(0, 0, 0, .4), 0 14px 32px rgba(0, 0, 0, .38);

  --r-sm: 6px;
  --r-md: 10px;
  --r-full: 999px;

  --s-1: 4px;
  --s-2: 8px;
  --s-3: 12px;
  --s-4: 16px;
  --s-5: 24px;
  --s-6: 32px;
  --s-7: 48px;

  --t-xl: 19px;
  --t-lg: 15px;
  --t-md: 13px;
  --t-sm: 12px;
  --t-xs: 11px;

  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  --page: 1600px;
  --gutter: var(--s-5);
  --shot-height: calc(100vh - 320px);

  --ease: 140ms cubic-bezier(.2, .6, .3, 1);
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: var(--t-md)/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* A column of percentages is read down, not across, so the digits have to sit
   under each other. */
.tile__pct, .stats, .count__value, .badge, .stamp { font-variant-numeric: tabular-nums; }

/* The run's own name is an identifier, and identifiers are read character by
   character — which is what a monospace face is for. */
.topbar .meta, #detail-where { font-family: var(--mono); font-size: var(--t-xs); }

code { font-family: var(--mono); font-size: var(--t-sm); }

.topbar, .controls, .overview, .detail__bar, main {
  padding-inline: max(var(--gutter), (100% - var(--page)) / 2);
}

/* ----------------------------------------------------------------- topbar */
.topbar {
  display: flex; flex-wrap: wrap; gap: var(--s-3) var(--s-5);
  align-items: flex-start; justify-content: space-between;
  padding-block: var(--s-4);
  background: var(--surface); border-bottom: 1px solid var(--border);
}
.topbar__title { min-width: 0; flex: 1 1 320px; }
.topbar__name { display: flex; align-items: center; gap: var(--s-3); min-width: 0; }
.topbar__mark { width: 26px; height: 19.5px; flex: none; color: var(--text); }
.topbar h1 {
  margin: 0; font-size: var(--t-xl); font-weight: 650; letter-spacing: -.015em; line-height: 1.25;
}
.urls {
  margin: var(--s-2) 0 0; display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-2);
  align-items: center; color: var(--muted); font-size: var(--t-sm);
}
.urls code { color: var(--muted); }
.arrow { color: var(--subtle); }
.chip {
  display: inline-flex; align-items: center; justify-content: center;
  box-sizing: border-box; width: 17px; height: 17px; border-radius: var(--r-sm);
  /*
   * Flex centres the line box, not the letter: the room a descender would
   * need sits under a capital and lifts it off centre. The padding puts it
   * back, and the line-height stops the body's leading from moving it again.
   */
  line-height: 1; padding-top: 1px;
  font-size: 10px; font-weight: 700; color: var(--surface); background: var(--muted);
}
.chip--b { background: var(--accent); color: var(--on-accent); }
.topbar .meta { margin: var(--s-2) 0 0; color: var(--subtle); font-size: var(--t-xs); }
/* Its own row. Inside the title column it was a sentence of provenance being
   wrapped to half the width while the space beside it stood empty. */
.topbar .reused {
  flex-basis: 100%;
  margin: var(--s-1) 0 0;
  padding: var(--s-1) var(--s-3);
  align-self: flex-start;
  display: inline-block;
  border-radius: var(--r-sm);
  background: var(--level-1);
  color: var(--error);
  font-size: var(--t-xs);
}

.totals { display: flex; flex-wrap: wrap; gap: var(--s-2); flex: 0 0 auto; }
.count {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  min-width: 82px; padding: var(--s-2) var(--s-3);
  border-radius: var(--r-md); border: 1px solid var(--border); background: var(--raised);
}
.count__value {
  font-size: var(--t-xl); font-weight: 660; line-height: 1.15; font-variant-numeric: tabular-nums;
}
.count__label {
  margin-top: 1px; font-size: 10px; font-weight: 500;
  text-transform: uppercase; letter-spacing: .07em; color: var(--subtle);
}
.count--failed .count__value { color: var(--fail); }
.count--passed .count__value { color: var(--pass); }
.count--errored .count__value { color: var(--error); }
/* The count that matters is the one that is not zero. */
.count--failed { border-color: color-mix(in srgb, var(--fail) 35%, var(--border)); }

/* --------------------------------------------------------------- controls */
/* The overview's bar and the detail's are one bar to a reader: they sit on the
   same edge and replace each other. Their contents differ -- a row of pills
   against a title over its two URLs -- so the swap nudged the page three
   pixels each way. Both reserve the taller one.

   This is the row's height, not the bar's: the report has no border-box
   reset, so the padding and the rule under it come on top. */
.controls, .detail__bar { min-height: 39px; }

.controls {
  position: sticky; top: 0; z-index: 5;
  display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-3); align-items: center;
  padding-block: var(--s-2);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}
:root[data-view="detail"] .controls { display: none; }

.filters, .modes, .rerun__pick {
  display: inline-flex; padding: 2px; gap: 2px;
  border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--raised);
}
.filters button, .modes button, .rerun__pick button {
  appearance: none; border: 0; border-radius: 4px; background: transparent; color: var(--muted);
  padding: 5px 10px; font: inherit; font-size: var(--t-sm); font-weight: 500;
  cursor: pointer; white-space: nowrap; transition: background var(--ease), color var(--ease);
}
.filters button:not(.is-active):hover, .modes button:not(.is-active):hover {
  color: var(--text); background: color-mix(in srgb, var(--muted) 14%, transparent);
}
.filters button.is-active, .modes button.is-active,
.detail__bar .modes button.is-active {
  background: var(--accent); color: var(--on-accent); font-weight: 600; border: 0;
}

.sort { display: inline-flex; align-items: center; gap: var(--s-2); color: var(--muted); font-size: var(--t-sm); }
.check {
  display: inline-flex; align-items: center; gap: var(--s-2);
  color: var(--muted); font-size: var(--t-sm); cursor: pointer; user-select: none;
}
.check input { accent-color: var(--accent); cursor: pointer; margin: 0; }
.search { flex: 1 1 220px; min-width: 160px; }
.search input { width: 100%; }

select, input[type=search] {
  font: inherit; font-size: var(--t-sm); padding: 6px 9px;
  border-radius: var(--r-sm); border: 1px solid var(--border);
  background: var(--surface); color: var(--text);
  transition: border-color var(--ease);
}
select:hover, input[type=search]:hover { border-color: var(--border-strong); }

:where(button, select, input, .tile):focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}

/* --------------------------------------------------------------- overview */
.overview { padding-block: var(--s-5) var(--s-7); }
.overview__head {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-2) var(--s-3);
  margin-bottom: var(--s-3);
}
/* Its own row. Beside the hint it was a box being baseline-aligned against a
   paragraph -- sitting high, growing the head by half at some widths and not
   others. Below it, the head is the same height whatever the window does. */
#run-command { flex-basis: 100%; }
.rerun__pick { flex: none; }
.rerun__pick button.is-active { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
#run-command .rerun { margin-top: var(--s-1); }
.overview__head h2 { margin: 0; font-size: var(--t-lg); font-weight: 620; letter-spacing: -.01em; }
.overview__hint { margin: 0; color: var(--muted); font-size: var(--t-sm); }

.tile__site { color: var(--subtle); font-weight: 500; }
.tiles { display: grid; gap: var(--s-3); grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }

/* A group is a site, and a suite is usually several of them checked the same
   way; without a heading per group its pages read as one long list. */
.group { margin-bottom: var(--s-5); }
.group summary {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-2) var(--s-3);
  padding: var(--s-2) 0; margin-bottom: var(--s-3);
  border-bottom: 1px solid var(--border); cursor: pointer; list-style: none;
}
.group summary::-webkit-details-marker { display: none; }
.group summary::before {
  content: '▸'; color: var(--subtle); font-size: var(--t-sm);
  transition: transform var(--ease); display: inline-block;
}
.group[open] summary::before { transform: rotate(90deg); }
.group summary:hover { border-color: var(--border-strong); }
.group__name { font-size: var(--t-md); font-weight: 620; letter-spacing: -.005em; }
.group__tally { color: var(--muted); font-size: var(--t-sm); font-variant-numeric: tabular-nums; }
.group__tally b { color: var(--fail); font-weight: 600; }
.group__tally .clean { color: var(--pass); font-weight: 600; }
.group__where { margin-left: auto; color: var(--subtle); font-size: var(--t-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tile {
  display: flex; flex-direction: column; text-align: left; padding: 0;
  font: inherit; color: var(--text); background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--r-md);
  overflow: hidden; cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition: box-shadow var(--ease), border-color var(--ease), transform var(--ease);
}
.tile:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-lifted);
  transform: translateY(-1px);
}
.tile__head { display: flex; align-items: baseline; gap: var(--s-2); padding: var(--s-3) var(--s-3) var(--s-1); }
.tile__name {
  font-size: var(--t-md); font-weight: 600; letter-spacing: -.005em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tile__where {
  display: block; padding: 0 var(--s-3) var(--s-2); color: var(--subtle); font-size: var(--t-xs);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tile__shot {
  --tile-shot: 190px;
  position: relative; height: var(--tile-shot); background: var(--bg);
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); overflow: hidden;
}
.tile__shot img { display: block; position: absolute; top: 0; left: 0; width: 100%; }
.tile__shot::after {
  content: attr(data-note); position: absolute; left: 0; right: 0; bottom: 0;
  padding: 3px var(--s-2); font-size: 10px; letter-spacing: .03em;
  color: var(--subtle); background: color-mix(in srgb, var(--surface) 86%, transparent);
  backdrop-filter: blur(4px);
}
.tile__shot--none {
  display: flex; align-items: center; justify-content: center;
  color: var(--subtle); font-size: var(--t-sm);
}
.tile__rows { display: grid; gap: var(--s-1); padding: var(--s-2) var(--s-3) var(--s-3); }
.tile__row {
  display: grid; grid-template-columns: minmax(52px, auto) 54px 1fr; align-items: center; gap: var(--s-2);
  font-size: var(--t-sm); font-variant-numeric: tabular-nums;
}
.tile__vp { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile__pct { text-align: right; font-weight: 550; }
.tile__bar {
  position: relative; height: 6px; border-radius: var(--r-full);
  background: color-mix(in srgb, var(--muted) 15%, transparent); overflow: hidden;
}
.tile__fill { position: absolute; inset: 0 auto 0 0; border-radius: var(--r-full); background: var(--level-4); }
.tile__row--pass .tile__fill { background: var(--pass); }
.tile__row--pass .tile__pct { color: var(--muted); }
.tile__row--heavy .tile__fill { background: var(--level-5); }
.tile__row--state { grid-column: 2 / -1; text-align: left; color: var(--error); font-size: var(--t-xs); }
.tile__row--skipped .tile__row--state { color: var(--subtle); }

/* ----------------------------------------------------------------- detail */
.detail__bar {
  position: sticky; top: 0; z-index: 4;
  display: flex; flex-wrap: wrap; gap: var(--s-3); align-items: center;
  padding-block: var(--s-2);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}
.detail__title { margin-right: auto; min-width: 0; }
.detail__title h2 { margin: 0; font-size: var(--t-md); font-weight: 620; letter-spacing: -.005em; }
.detail__group { color: var(--subtle); font-weight: 500; }
.detail__title p {
  margin: 1px 0 0; color: var(--subtle); font-size: var(--t-xs);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.detail__bar button {
  font: inherit; font-size: var(--t-sm); font-weight: 500; padding: 6px 11px; cursor: pointer;
  border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--surface); color: var(--text);
  transition: border-color var(--ease), color var(--ease), background var(--ease);
}
.detail__bar button:not(.is-active):not([disabled]):hover {
  border-color: var(--accent); color: var(--accent);
}
.detail__bar button[disabled] { opacity: .4; cursor: default; color: var(--subtle); }
.detail__back::before { content: '←'; margin-right: 6px; }
.detail__nav { display: inline-flex; gap: var(--s-1); }
.detail__bar .modes { border-color: var(--border); }
.detail__bar .modes button:not(.is-active) { border: 0; background: transparent; }

main { padding-block: var(--s-5) var(--s-7); display: grid; gap: var(--s-4); }

.card {
  width: 100%;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-md); box-shadow: var(--shadow); overflow: hidden;
}
.card__head {
  display: flex; flex-wrap: wrap; gap: var(--s-3); align-items: center; justify-content: space-between;
  padding: var(--s-3); border-bottom: 1px solid var(--border);
}
.card__title { margin: 0; font-size: var(--t-md); font-weight: 620; overflow-wrap: anywhere; }
.card__sub { margin: 1px 0 0; color: var(--subtle); font-size: var(--t-xs); }
.card__right { display: flex; align-items: center; gap: var(--s-2); }
.card__body { padding: var(--s-3); }
/*
 * A picture view sits on the recessed ground; markup and console do not.
 * Flat on purpose: :has() may not contain another :has(), and a selector
 * the browser drops takes its whole rule with it, silently.
 */
.card__body:has(> figure, > .pair, > .slider, > .onion-view) {
  background: var(--bg);
  border-radius: 0 0 var(--r-md) var(--r-md);
  padding-block: var(--s-4);
}

.badge {
  font-size: var(--t-xs); font-weight: 650; text-transform: uppercase; letter-spacing: .05em;
  padding: 3px var(--s-2); border-radius: var(--r-full);
}
.badge--pass { color: var(--pass); background: color-mix(in srgb, var(--pass) 13%, transparent); }
.badge--fail { color: var(--fail); background: color-mix(in srgb, var(--fail) 13%, transparent); }
.badge--error { color: var(--error); background: color-mix(in srgb, var(--error) 15%, transparent); }
.badge--skipped { color: var(--skip); background: color-mix(in srgb, var(--skip) 13%, transparent); }
.pill {
  font-size: var(--t-xs); padding: 2px var(--s-2); border-radius: var(--r-full);
  border: 1px solid var(--border); color: var(--muted);
}
.pill--changed { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }

/* When this one was taken. On the card rather than in the run's header,
   because that is what it describes, and beside the verdict rather than in the
   row of measurements, where eight items of one weight hide each other. */
.stamp {
  font-size: var(--t-xs); padding: 2px var(--s-2); border-radius: var(--r-full);
  border: 1px solid var(--border); background: var(--raised); color: var(--muted);
  white-space: nowrap;
}
.stamp b { color: var(--text); font-weight: 600; }
.stamp--fresh { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); color: var(--accent); }
.stamp--fresh b { color: var(--accent); }

/* ---------------------------------------------------------------- viewers */
.pair {
  display: grid; gap: var(--s-3); align-items: start; justify-content: center;
  grid-template-columns: repeat(2, minmax(0, var(--shot-width, 1fr)));
}
@media (max-width: 860px) { .pair { grid-template-columns: minmax(0, var(--shot-width, 1fr)); } }

figure { margin: 0; display: flex; flex-direction: column; }
figure, .slider, .onion { max-width: var(--shot-width, 100%); }
.card__body > figure, .card__body > .slider__box, .card__body > .onion-view { margin-inline: auto; }
/* The control belongs to the picture, so it is as wide as the picture. */
.card__body > .slider__box { max-width: var(--shot-width, 100%); }
.card__body > .onion-view { max-width: var(--shot-width, 100%); }
.pair figure { min-width: 0; }

figcaption {
  display: flex; gap: var(--s-2); align-items: center;
  margin-bottom: var(--s-2); color: var(--subtle); font-size: var(--t-xs);
}
figcaption a { color: var(--accent); text-decoration: none; overflow-wrap: anywhere; }
figcaption a:hover { text-decoration: underline; }

.viewer { display: grid; grid-template-columns: 1fr 12px; gap: var(--s-1); align-items: stretch; }
.viewer--nomap { grid-template-columns: 1fr; }
/*
 * Side by side, the two pictures have to be the same width, or the frame
 * itself reads as a difference between the pages. Only B carries the
 * minimap, so A keeps the column it does not fill.
 */
.pair .viewer--nomap { grid-template-columns: 1fr 12px; }
.frame {
  border: 1px solid var(--border); border-radius: var(--r-sm); background: #fff;
  overflow: auto; height: var(--shot-height); min-height: 320px;
}
.shot { display: block; width: 100%; height: auto; }
/*
 * A comparison that found nothing has no difference picture — writing one
 * costs as much as the screenshot and says the same thing. This is side A
 * turned down to what the difference picture would have looked like with
 * nothing marked on it.
 */
.shot.is-flat, .tile__shot img.is-flat { filter: grayscale(1); opacity: .38; }

.map {
  position: relative; border: 1px solid var(--border); border-radius: 4px;
  background: color-mix(in srgb, var(--muted) 12%, transparent);
  overflow: hidden; cursor: pointer;
}
.map__band { position: absolute; left: 0; right: 0; background: var(--fail); }
.map__window {
  position: absolute; left: -1px; right: -1px;
  border: 1px solid var(--accent); border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  pointer-events: none;
}
.map--flat { cursor: default; }

/* The same window every other view of a tall page uses. */
.slider {
  border: 1px solid var(--border); border-radius: var(--r-sm); background: #fff;
  overflow: auto; height: var(--shot-height); min-height: 320px;
}
.slider__stage {
  position: relative; width: 100%; touch-action: pan-y; cursor: ew-resize;
  user-select: none; -webkit-user-select: none;
}
.slider__stage img { display: block; width: 100%; height: auto; }
/* Absolute against the stage, not the frame, so it scrolls with the picture. */
.slider__top { position: absolute; top: 0; left: 0; bottom: 0; overflow: hidden; }
.slider__top img { position: absolute; top: 0; left: 0; }
.slider__handle { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--accent); pointer-events: none; }
.slider__grip {
  position: sticky; top: calc(50% - 13px); display: block;
  width: 26px; height: 26px; margin-left: -12px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent), var(--shadow-sm);
}
.slider__control {
  display: flex; align-items: center; gap: var(--s-3);
  margin-top: var(--s-3); color: var(--muted); font-size: var(--t-xs);
}
.slider__control input[type=range] { flex: 1; accent-color: var(--accent); }

.onion {
  position: relative; overflow: auto; background: #fff;
  border: 1px solid var(--border); border-radius: var(--r-sm); max-height: var(--shot-height);
}
.onion img { display: block; width: 100%; height: auto; }
.onion img + img { position: absolute; inset: 0; }
.onion__control {
  display: flex; align-items: center; gap: var(--s-2);
  margin-top: var(--s-2); color: var(--muted); font-size: var(--t-sm);
}
.onion__control input { flex: 1; }

/* ------------------------------------------------------------------ stats */
.stats {
  display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-4);
  margin-top: var(--s-2); padding-top: var(--s-2);
  border-top: 1px solid var(--border);
  color: var(--muted); font-size: var(--t-sm); font-variant-numeric: tabular-nums;
}
.stats b { color: var(--text); font-weight: 600; }
.stats .aside { color: var(--subtle); }
.warn {
  margin: var(--s-2) 0 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-sm);
  color: var(--error); background: color-mix(in srgb, var(--error) 11%, transparent);
  font-size: var(--t-sm);
}
/* Said, not warned about: a redirect both sides made is the two agreeing. */
.note {
  margin: var(--s-2) 0 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-sm);
  color: var(--muted); background: var(--raised); border: 1px solid var(--border);
  font-size: var(--t-sm);
}
.errorbox {
  margin: 0; padding: var(--s-3); border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--fail) 9%, transparent); color: var(--fail);
  font-size: var(--t-sm); white-space: pre-wrap; overflow-wrap: anywhere;
}
.empty { padding: var(--s-7); text-align: center; color: var(--subtle); }

/* ----------------------------------------------------------------- markup */
.patch {
  border: 1px solid var(--border); border-radius: var(--r-sm);
  overflow: auto; max-height: var(--shot-height);
  background: var(--raised);
  font-family: var(--mono); font-size: var(--t-sm); line-height: 1.6;
}
.patch table { border-collapse: collapse; width: 100%; }
.patch td { padding: 0 var(--s-2); white-space: pre; vertical-align: top; }
.patch td.num {
  width: 1%; text-align: right; color: var(--subtle); user-select: none;
  border-right: 1px solid var(--border); font-variant-numeric: tabular-nums;
  position: sticky; left: 0; background: inherit;
}
.patch td.code { width: 100%; }
.patch tr.add { background: color-mix(in srgb, var(--pass) 14%, transparent); }
.patch tr.add td.code { color: color-mix(in srgb, var(--pass) 75%, var(--text)); }
.patch tr.remove { background: color-mix(in srgb, var(--fail) 12%, transparent); }
.patch tr.remove td.code { color: color-mix(in srgb, var(--fail) 75%, var(--text)); }
.patch tr.hunk td {
  background: color-mix(in srgb, var(--accent) 11%, transparent);
  color: var(--accent); font-size: var(--t-xs);
}
.topbar .reused--fresh { background: transparent; border: 1px solid var(--border-strong); color: var(--muted); }

/* Its own row, because eleven chips on one line push everything else off the
   bar. The wrapper takes the width so the group still hugs its buttons. */

/* The tags a tile carries, so the kind is readable without opening it. */
.meta__link {
  appearance: none; border: 0; padding: 0; margin-left: var(--s-2);
  background: none; font: inherit; color: var(--accent); cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
}
.meta__link:hover { color: var(--text); }

.settings {
  margin-top: var(--s-6); border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--surface);
}
.settings > summary {
  padding: var(--s-3) var(--s-4); cursor: pointer; font-size: var(--t-lg); font-weight: 600;
  color: var(--muted); list-style-position: inside;
}
.settings[open] > summary { color: var(--text); border-bottom: 1px solid var(--border); }
.settings__body {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--s-5) var(--s-6); padding: var(--s-4);
}
.settings__group h3 {
  margin: 0 0 var(--s-2); font-size: var(--t-xs); font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase; color: var(--accent);
}
.settings__group dl {
  display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  gap: var(--s-1) var(--s-3); margin: 0; font-size: var(--t-md);
}
.settings__group dt { color: var(--subtle); }
.settings__yaml { border-top: 1px solid var(--border); padding: var(--s-4); }
.settings__yaml-head { display: flex; align-items: flex-start; gap: var(--s-4); margin-bottom: var(--s-3); }
.settings__yaml-head p { margin: 0; color: var(--subtle); font-size: var(--t-sm); max-width: 70ch; }
.settings__yaml-head button {
  flex: none; padding: var(--s-1) var(--s-3);
  border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  background: var(--surface); color: var(--text); font: inherit; font-size: var(--t-sm);
  cursor: pointer;
}
.settings__yaml-head button:hover { border-color: var(--accent); color: var(--accent); }
.settings__yaml pre {
  margin: 0; padding: var(--s-3); max-height: 420px; overflow: auto;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm);
  font-size: var(--t-sm); line-height: 1.55;
}
.settings__group dd { margin: 0; color: var(--text); overflow-wrap: anywhere; }

.tags { display: flex; flex-wrap: wrap; gap: var(--s-1); margin-top: var(--s-2); }
/* On a tile there is no padding to inherit, so the row brings its own. */
.tile > .tags { margin-top: 0; padding: 0 var(--s-3) var(--s-3); }
.tag {
  padding: 1px var(--s-2);
  border: 1px solid var(--border);
  border-radius: var(--r-full);
  background: var(--raised);
  color: var(--muted);
  font-size: 10px;
  letter-spacing: .02em;
  white-space: nowrap;
}
.tag--image { border-color: var(--level-3); color: var(--error); }

/* The line to paste into a terminal to run this one comparison again. */
.rerun {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  margin-top: var(--s-4);
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--raised);
}
.rerun__label {
  flex: none; color: var(--subtle); font-size: var(--t-xs);
  text-transform: uppercase; letter-spacing: .04em;
}
.rerun code {
  flex: 1;
  overflow-x: auto;
  white-space: nowrap;
  color: var(--muted);
  font-size: var(--t-xs);
}
.rerun button {
  flex: none;
  padding: var(--s-1) var(--s-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: var(--t-xs);
  cursor: pointer;
}
.rerun button:hover { border-color: var(--accent); color: var(--accent); }

.logs { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-4); }
.logs__side h3 {
  margin: 0 0 var(--s-2);
  font-size: var(--t-xs);
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--subtle);
}
.logline {
  display: flex;
  gap: var(--s-2);
  align-items: baseline;
  padding: var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--border);
  font-size: var(--t-sm);
  line-height: 1.5;
}
.logline:last-child { border-bottom: 0; }
/* Only what one side alone said is lifted out: the rest is how the site is. */
.logline--only { background: var(--raised); box-shadow: inset 2px 0 0 var(--error); }
.logline__kind {
  flex: none;
  font-size: var(--t-xs);
  text-transform: uppercase;
  letter-spacing: .03em;
  color: var(--subtle);
  min-width: 6.5em;
}
.logline__kind--error, .logline__kind--pageerror { color: var(--fail); }
.logline__kind--requestfailed, .logline__kind--httperror { color: var(--error); }
.logline__text {
  font-family: var(--mono);
  word-break: break-word;
  color: var(--text);
}
.logline__count { flex: none; color: var(--subtle); font-size: var(--t-xs); }
.logs__side .empty { text-align: left; padding: var(--s-2) var(--s-3); }
@media (max-width: 900px) { .logs { grid-template-columns: 1fr; } }

.markup-meta {
  display: flex; flex-wrap: wrap; gap: var(--s-3); align-items: center;
  margin-bottom: var(--s-2); color: var(--muted); font-size: var(--t-sm);
}
.markup-meta .added { color: var(--pass); font-weight: 600; }
.markup-meta .removed { color: var(--fail); font-weight: 600; }
.markup-meta a { color: var(--accent); text-decoration: none; }
.markup-meta a:hover { text-decoration: underline; }

/* A report is a file people mail on, so it has to say what made it: read
   months later, by someone who never ran the command, it is otherwise a
   picture of two websites with no way back to the tool. */
.colophon {
  padding: var(--s-6) var(--s-5); border-top: 1px solid var(--border);
  color: var(--subtle); font-size: var(--t-xs); text-align: center;
}
.colophon p { margin: 0; }
.colophon a { color: var(--muted); text-decoration: none; }
.colophon a:hover { color: var(--accent); text-decoration: underline; }
.colophon__version { font-family: var(--mono); }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;
