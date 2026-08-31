import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { KIND_LABELS, tally } from './classify.js';
import { HOMEPAGE, VERSION } from './manifest.js';
import type { Comparison, Config, DiffKind, RunResult } from './types.js';

export interface ReportOptions {
  /** Inline every screenshot as a data URI so the HTML travels on its own. */
  selfContained: boolean;
}

/**
 * Renders the run into a single HTML document.
 *
 * With `selfContained: false` the images are referenced relatively, which keeps
 * the file small and makes the whole output directory the artifact. With
 * `selfContained: true` everything is inlined into one file that can be opened
 * straight from a CI artifact list.
 */
export async function renderReport(
  result: RunResult,
  config: Config,
  options: ReportOptions
): Promise<string> {
  const sources = options.selfContained ? await inlineImages(result, result.outDir) : referenceImages(result);
  const payload = { result, sources, settingsYaml: settingsYaml(result) };

  return `<!doctype html>
<html lang="en" data-theme="auto" data-view="overview">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.reportTitle)}</title>
<style>${STYLES}</style>
</head>
<body>
<header class="topbar">
  <div class="topbar__title">
    <div class="topbar__name">${MARK}<h1>${escapeHtml(config.reportTitle)}</h1></div>
    ${result.config.a && result.config.b ? sides(result) : ""}
    <p class="meta">${escapeHtml(formatMeta(result))}
      <button type="button" class="meta__link" id="open-settings">Settings</button>
    </p>
    ${reuseBanner(result)}
  </div>
  <div class="totals">
    ${totalTile('failed', result.failed)}
    ${totalTile('passed', result.passed)}
    ${totalTile('errored', result.errored)}
    ${totalTile('skipped', result.skipped)}
  </div>
</header>

<div class="controls">
  <div class="filters" role="group" aria-label="Filter comparisons">
    <button type="button" data-filter="all" class="is-active">All (${result.total})</button>
    <button type="button" data-filter="fail">Differences (${result.failed})</button>
    <button type="button" data-filter="error">Errors (${result.errored})</button>
    <button type="button" data-filter="markup">Markup changed (${markupChanged(result)})</button>
    ${consoleDiffers(result) > 0 ? '<button type="button" data-filter="console">Console differs (' + consoleDiffers(result) + ')</button>' : ''}
  </div>
  ${kindFilters(result)}
  <label class="sort sort--overview">
    <span>Sort</span>
    <select id="sort">
      <option value="diff">Largest difference</option>
      <option value="order">Config order</option>
      <option value="name">Name</option>
    </select>
  </label>
  <label class="search">
    <input type="search" id="search" placeholder="Filter by name or URL…" autocomplete="off">
  </label>
</div>

<section class="overview" id="overview">
  <div class="overview__head">
    <h2>Overview</h2>
    <p class="overview__hint">
      One tile per scenario. The picture is the pixel diff — red is what
      changed — and the bars are how much, per viewport. Select one to open it.
    </p>
    <div id="run-command"></div>
  </div>
  <div class="tiles" id="tiles"></div>

  <details class="settings" id="settings">
    <summary>Settings this run used</summary>
    <div class="settings__body" id="settings-body"></div>
    <div class="settings__yaml" id="settings-yaml" hidden>
      <div class="settings__yaml-head">
        <p>The same settings as YAML, in the groups a config file uses. The
          scenarios are the report itself, and credentials never leave the
          machine that has them, so neither is in here.</p>
        <button type="button" id="copy-settings">Copy</button>
      </div>
      <pre><code id="settings-yaml-text"></code></pre>
    </div>
  </details>
</section>

<section class="detail" id="detail" hidden>
  <div class="detail__bar">
    <button type="button" class="detail__back" id="back">Overview</button>
    <div class="detail__title">
      <h2 id="detail-name"></h2>
      <p id="detail-where"></p>
    </div>
    <div class="modes" id="modes" role="group" aria-label="View mode">
      <button type="button" data-mode="diff" class="is-active">Diff</button>
      <button type="button" data-mode="side">Side by side</button>
      <button type="button" data-mode="slider">Slider</button>
      <button type="button" data-mode="onion">Onion</button>
      <button type="button" data-mode="markup">Markup</button>
      <button type="button" data-mode="console">Console</button>
    </div>
    <div class="detail__nav">
      <button type="button" id="prev" title="Previous scenario (left arrow)">Previous</button>
      <button type="button" id="next" title="Next scenario (right arrow)">Next</button>
    </div>
  </div>
  <main id="list"></main>
</section>

<template id="card-template">
  <article class="card">
    <header class="card__head">
      <div>
        <h2 class="card__title"></h2>
        <p class="card__sub"></p>
      </div>
      <div class="card__right">
        <span class="badge"></span>
      </div>
    </header>
    <div class="card__body"></div>
  </article>
</template>

<footer class="colophon">
  <p>Generated by <a href="${escapeHtml(HOMEPAGE)}" target="_blank" rel="noreferrer noopener">diffyard</a>
    <span class="colophon__version">${escapeHtml(VERSION)}</span> — visual regression by comparing two URLs.</p>
</footer>

<script id="data" type="application/json">${jsonForScript(payload)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

function markupChanged(result: RunResult): number {
  return result.comparisons.filter((entry) => entry.markup && !entry.markup.identical).length;
}

/** Only shown when both sides have a base URL; scenarios may carry their own. */
function sides(result: RunResult): string {
  return `<p class="urls">
      <span class="chip chip--a">A</span> <code>${escapeHtml(result.config.a)}</code>
      <span class="arrow">vs</span>
      <span class="chip chip--b">B</span> <code>${escapeHtml(result.config.b)}</code>
    </p>`;
}

function totalTile(kind: string, value: number): string {
  return `<div class="count count--${kind}"><span class="count__value">${value}</span><span class="count__label">${kind}</span></div>`;
}

/**
 * Says when a side was not photographed for this run.
 *
 * Without it a reader has no way to tell whether these numbers were measured
 * against production as it is now or as it was this morning — which changes
 * what every one of them means.
 */
function reuseBanner(result: RunResult): string {
  const reuse = result.reuse;
  if (!reuse || reuse.reused === 0) return '';

  const sides = reuse.sides.map((side) => side.toUpperCase()).join(' and ');
  const when = new Date(reuse.capturedAt).toLocaleString();
  const again = reuse.recaptured > 0 ? `, ${reuse.recaptured} captured again` : '';

  return (
    '<p class="reused">' +
    escapeHtml(
      `Side ${sides} reused from run ${reuse.runId}, captured ${when} — ` +
        `${reuse.reused} of ${result.total} comparisons${again}`
    ) +
    '</p>'
  );
}

function formatMeta(result: RunResult): string {
  const seconds = Math.round(result.durationMs / 1000);
  const started = new Date(result.startedAt).toLocaleString();
  return `run ${result.runId} · ${result.total} comparisons · ${result.config.browser} · ${seconds}s · ${started}`;
}

/**
 * A row of chips, one per kind of difference actually present.
 *
 * Nine hundred findings ordered by percentage is a list you read from the top
 * until you get bored. Split by kind it is several short lists, and "the twelve
 * where an image changed" becomes a question with an answer. Kinds with nothing
 * in them are left out rather than shown greyed: an empty filter is a question
 * nobody asked.
 */
/**
 * The run's settings written back out as YAML, in the groups the config file
 * uses, so what the report shows can be read — and pasted — as configuration.
 *
 * Not a copy of the file that ran: the scenarios are the report itself, and
 * the credentials never left the machine that has them. What it is, is every
 * setting that decided a number, in the shape it was written in.
 */
function settingsYaml(result: RunResult): string {
  const settings = result.settings;
  if (!settings) return '';

  const viewports: Record<string, { width: number; height: number }> = {};
  for (const view of settings.viewports) viewports[view.name] = { width: view.width, height: view.height };

  const side = (from: RunResult['settings']['a']) => ({
    url: from.baseUrl || null,
    label: from.label,
    ...(from.headers.length > 0 ? { headers: from.headers.reduce<Record<string, string>>(
      (all, name) => ({ ...all, [name]: '…' }), {}) } : {}),
    ...(from.basicAuth ? { basicAuth: { username: '…', password: '…' } } : {}),
    ...(from.storageState ? { storageState: from.storageState } : {}),
  });

  const document = {
    compare: { a: side(settings.a), b: side(settings.b) },
    browser: {
      engine: settings.browser,
      headless: settings.headless,
      viewports,
      colorScheme: settings.colorScheme,
      reducedMotion: settings.reducedMotion,
      ...(settings.locale ? { locale: settings.locale } : {}),
      ...(settings.timezone ? { timezone: settings.timezone } : {}),
      ...(settings.userAgent ? { userAgent: settings.userAgent } : {}),
      ignoreHTTPSErrors: settings.ignoreHTTPSErrors,
    },
    timeouts: {
      action: settings.timeout,
      comparison: settings.comparisonTimeout,
      run: settings.runTimeout,
    },
    diff: {
      threshold: settings.threshold,
      pixelThreshold: settings.pixelThreshold,
      ignoreAntialiasing: settings.ignoreAntialiasing,
      alignRows: settings.alignRows,
      mask: settings.mask,
      hide: settings.hide,
      remove: settings.remove,
    },
    stability: {
      freeze: settings.freeze,
      triggerLazyLoad: settings.triggerLazyLoad,
      sequential: settings.sequential,
      retries: settings.retries,
      workers: settings.workers,
    },
    markup: settings.markup,
    logs: settings.logs,
    ...(settings.beforeEach.length > 0
      ? {
          beforeEach: settings.beforeEach.map((entry) => ({
            name: entry.name,
            ...(entry.when ? { when: entry.when } : {}),
            ...(entry.once ? { once: true } : {}),
            ...(entry.required ? { required: true } : {}),
            ...(entry.side ? { side: entry.side } : {}),
            steps: entry.steps,
          })),
        }
      : {}),
    ...(settings.reuse.sides.length > 0 ? { reuse: settings.reuse } : {}),
  };

  return stringify(document, { lineWidth: 0 });
}

function kindFilters(result: RunResult): string {
  const counts = tally(result.comparisons);
  const present = (Object.keys(KIND_LABELS) as DiffKind[]).filter((kind) => counts[kind] > 0);
  if (present.length === 0) return '';

  const options = present
    .map(
      (kind) =>
        '<option value="' + kind + '">' +
        escapeHtml(KIND_LABELS[kind]) + ' (' + counts[kind] + ')</option>'
    )
    .join('');

  // A control rather than a second row of chips. The kinds are one question
  // about the list, like the sort is, and a row of its own made the head of
  // the report two rows of filters before a single finding was in sight.
  return (
    '<label class="sort"><span>Kind</span>' +
    '<select id="kind" aria-label="Filter by kind of difference">' +
    '<option value="any">Any kind</option>' +
    options +
    '</select></label>'
  );
}

/** How many comparisons had one side say something the other did not. */
function consoleDiffers(result: RunResult): number {
  return result.comparisons.filter((comparison) => comparison.logs?.differs).length;
}

function referenceImages(result: RunResult): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const comparison of result.comparisons) {
    for (const [side, file] of Object.entries(comparison.files)) {
      if (file) sources[`${comparison.id}:${side}`] = file;
    }
  }
  return sources;
}

async function inlineImages(result: RunResult, outDir: string): Promise<Record<string, string>> {
  const sources: Record<string, string> = {};
  for (const comparison of result.comparisons) {
    for (const [side, file] of Object.entries(comparison.files)) {
      if (!file) continue;
      const bytes = await readFile(join(outDir, file));
      sources[`${comparison.id}:${side}`] = `data:image/png;base64,${bytes.toString('base64')}`;
    }
  }
  return sources;
}

/** Escapes the payload so it cannot break out of the <script> element. */
function jsonForScript(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

export function comparisonLabel(comparison: Comparison): string {
  return `${comparison.scenario} @ ${comparison.viewport.name}`;
}

/**
 * The mark, inlined — the report is one file that has to survive being mailed
 * around, so nothing it shows may live beside it. Both panels take their
 * colour from the palette rather than naming one, which is why the amber here
 * is the accent and stays in step with it.
 */
const MARK = `<svg class="topbar__mark" viewBox="0 0 288 216" role="img" aria-label="diffyard">
  <path fill="currentColor" d="M16 0h69l75 80-30 30v90c0 8.84-7.16 16-16 16H16c-8.84 0-16-7.16-16-16V16C0 7.16 7.16 0 16 0Z"/>
  <path fill="var(--accent)" d="M177 0h95c8.84 0 16 7.16 16 16v184c0 8.84-7.16 16-16 16h-92c-8.84 0-16-7.16-16-16v-73l47-55-51-55 17-17Z"/>
</svg>`;

const STYLES = `
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
.topbar .reused {
  margin: var(--s-2) 0 0;
  padding: var(--s-1) var(--s-3);
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
.controls {
  position: sticky; top: 0; z-index: 5;
  display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-3); align-items: center;
  padding-block: var(--s-2);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}
:root[data-view="detail"] .controls { display: none; }

.filters, .modes {
  display: inline-flex; padding: 2px; gap: 2px;
  border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--raised);
}
.filters button, .modes button {
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
.overview__head h2 { margin: 0; font-size: var(--t-lg); font-weight: 620; letter-spacing: -.01em; }
.overview__hint { margin: 0; color: var(--muted); font-size: var(--t-sm); }

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

const SCRIPT = `
(() => {
  const NEWLINE = String.fromCharCode(10);
  const payload = JSON.parse(document.getElementById('data').textContent);
  const { result, sources } = payload;
  const list = document.getElementById('list');
  const template = document.getElementById('card-template');
  const KIND_LABELS = ${JSON.stringify(KIND_LABELS)};
  const state = { filter: 'all', kind: 'any', sort: 'diff', query: '', scenario: null, mode: 'diff' };

  const src = (id, side) => sources[id + ':' + side] || '';
  const pct = (ratio) => (ratio * 100).toFixed(2) + '%';

  /** Comparisons left after the filter row; the overview groups these. */
  function visible() {
    const query = state.query.trim().toLowerCase();
    return result.comparisons
      .map((comparison, index) => ({ comparison, index }))
      .filter(({ comparison }) => {
        if (state.filter === 'fail' && comparison.status !== 'fail') return false;
        if (state.filter === 'error' && comparison.status !== 'error') return false;
        if (state.filter === 'markup' && (!comparison.markup || comparison.markup.identical)) return false;
        if (state.filter === 'console' && !(comparison.logs && comparison.logs.differs)) return false;
        if (state.kind !== 'any' && !(comparison.kinds || []).includes(state.kind)) return false;
        if (!query) return true;
        return (
          (comparison.group ?? '') + ' ' + comparison.scenario + ' ' +
          comparison.viewport.name + ' ' + comparison.urlA + ' ' + comparison.urlB
        ).toLowerCase().includes(query);
      })
      .sort((left, right) => {
        if (state.sort === 'order') return left.index - right.index;
        if (state.sort === 'name') return left.comparison.scenario.localeCompare(right.comparison.scenario);
        const a = left.comparison.diff ? left.comparison.diff.ratio : -1;
        const b = right.comparison.diff ? right.comparison.diff.ratio : -1;
        return b - a;
      })
      .map((entry) => entry.comparison);
  }

  function render() {
    if (!state.scenario) {
      list.replaceChildren();
      return;
    }

    const items = result.comparisons.filter((entry) => qualify(entry) === state.scenario);
    list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No comparisons match the current filter.';
      list.append(empty);
      return;
    }
    for (const comparison of items) list.append(card(comparison));
  }

  function card(comparison) {
    const node = template.content.cloneNode(true);
    const article = node.querySelector('.card');
    article.id = 'c-' + comparison.id;
    // Scale is 1 CSS pixel per captured pixel, which is how the page looked.
    article.style.setProperty('--shot-width', comparison.viewport.width + 'px');
    article.querySelector('.card__title').textContent = comparison.scenario;
    article.querySelector('.card__sub').textContent =
      comparison.viewport.name + ' · ' + comparison.viewport.width + '×' + comparison.viewport.height +
      (comparison.viewport.deviceScaleFactor !== 1 ? ' @' + comparison.viewport.deviceScaleFactor + 'x' : '');

    article.querySelector('.card__right').prepend(captured(comparison));

    const badge = article.querySelector('.badge');
    badge.classList.add('badge--' + comparison.status);
    badge.textContent = comparison.diff
      ? comparison.status + ' · ' + pct(comparison.diff.ratio)
      : comparison.status;

    if (comparison.markup && !comparison.markup.identical) {
      const pill = document.createElement('span');
      pill.className = 'pill pill--changed';
      pill.textContent = 'markup +' + comparison.markup.added + ' / -' + comparison.markup.removed;
      badge.after(pill);
    }

    const body = article.querySelector('.card__body');

    if (comparison.status === 'error' || comparison.status === 'timeout' || !comparison.diff) {
      const box = document.createElement('pre');
      box.className = comparison.error ? 'errorbox' : 'empty';
      box.textContent = comparison.error || 'Skipped by config.';
      body.append(box);
      return article;
    }

    body.append(view(comparison, state.mode));
    body.append(stats(comparison));
    if (comparison.command) body.append(rerun(comparison.command));
    return article;
  }

  /**
   * The line that runs this one comparison again, into this same report.
   *
   * Working through a list means fixing one thing and looking at one view
   * again; without this that is either a full run or working the flags out by
   * hand, once per finding.
   */
  function rerun(command, label) {
    const container = document.createElement('div');
    container.className = 'rerun';

    if (label) {
      const what = document.createElement('span');
      what.className = 'rerun__label';
      what.textContent = label;
      container.append(what);
    }

    const line = document.createElement('code');
    line.textContent = command;

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(command);
        copy.textContent = 'Copied';
      } catch {
        // A report opened from a file:// URL has no clipboard permission, so
        // selecting the text is the fallback that always works.
        const range = document.createRange();
        range.selectNodeContents(line);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        copy.textContent = 'Select and copy';
      }
      setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
    });

    container.append(line, copy);
    return container;
  }

  function view(comparison, mode) {
    if (mode === 'markup') return markupView(comparison);
    if (mode === 'console') return consoleView(comparison);
    const profile = comparison.diff ? comparison.diff.profile : null;

    if (mode === 'diff') {
      // Nothing differed, so no difference picture was written. Side A greyed
      // is what one would have shown.
      const difference = src(comparison.id, 'diff');
      return difference
        ? figure('Diff — red marks what changed', difference, null, profile)
        : figure('Diff — nothing differs', src(comparison.id, 'a'), null, profile, { flat: true });
    }
    if (mode === 'slider') return slider(comparison);
    if (mode === 'onion') return onion(comparison);

    const pair = document.createElement('div');
    pair.className = 'pair';
    pair.append(
      figure('A', src(comparison.id, 'a'), comparison.urlA, profile, { map: false }),
      figure('B', src(comparison.id, 'b'), comparison.urlB, profile)
    );

    linkScrolling([...pair.querySelectorAll('.frame')]);
    return pair;
  }

  /**
   * A miniature of the page marking where it differs, with the visible part
   * outlined. A full-page screenshot is thousands of pixels tall; without this
   * there is no way to tell whether the interesting part is just below the
   * fold or three screens down.
   */
  function minimap(frame, profile) {
    const map = document.createElement('div');
    map.className = 'map';

    const bands = profile && profile.length ? profile : [];
    const peak = Math.max(0, ...bands);

    if (peak === 0) {
      map.classList.add('map--flat');
      map.title = 'Nothing differs on this page';
      return map;
    }

    bands.forEach((value, index) => {
      if (value <= 0) return;
      const band = document.createElement('span');
      band.className = 'map__band';
      band.style.top = (index / bands.length) * 100 + '%';
      band.style.height = 100 / bands.length + '%';
      // Relative to the strongest band, so a page whose worst row is 4%
      // still shows where that 4% is.
      band.style.opacity = String(0.25 + 0.75 * (value / peak));
      map.append(band);
    });

    const window_ = document.createElement('span');
    window_.className = 'map__window';
    map.append(window_);

    const sync = () => {
      const range = frame.scrollHeight - frame.clientHeight;
      const top = range > 0 ? frame.scrollTop / frame.scrollHeight : 0;
      const height = frame.scrollHeight > 0 ? frame.clientHeight / frame.scrollHeight : 1;
      window_.style.top = top * 100 + '%';
      window_.style.height = Math.min(100, height * 100) + '%';
    };

    frame.addEventListener('scroll', sync);
    new ResizeObserver(sync).observe(frame);
    queueMicrotask(sync);

    map.addEventListener('click', (event) => {
      const box = map.getBoundingClientRect();
      const fraction = (event.clientY - box.top) / box.height;
      frame.scrollTop = fraction * frame.scrollHeight - frame.clientHeight / 2;
    });

    map.title = 'Where the two pages differ — select a spot to jump there';
    return map;
  }

  /** Index of the band with the most change, or null when nothing differs. */
  function peakBand(profile) {
    if (!profile || !profile.length) return null;
    let best = 0;
    for (let index = 1; index < profile.length; index += 1) {
      if (profile[index] > profile[best]) best = index;
    }
    return profile[best] > 0 ? best / profile.length : null;
  }

  function linkScrolling(frames) {
    let leading = null;

    for (const frame of frames) {
      frame.addEventListener('scroll', () => {
        if (leading && leading !== frame) return;
        leading = frame;

        const range = frame.scrollHeight - frame.clientHeight;
        const fraction = range > 0 ? frame.scrollTop / range : 0;

        for (const other of frames) {
          if (other === frame) continue;
          const otherRange = other.scrollHeight - other.clientHeight;
          other.scrollTop = otherRange * fraction;
        }

        // Released on the next frame, so the scroll events this just caused
        // do not each try to lead in turn.
        requestAnimationFrame(() => {
          leading = null;
        });
      });
    }
  }

  function figure(label, source, url, profile, options) {
    const wrapper = document.createElement('figure');
    const caption = document.createElement('figcaption');
    caption.textContent = label;
    wrapper.title = 'The two frames scroll together';
    if (url) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = url;
      caption.append(' — ', link);
    }
    const image = document.createElement('img');
    image.className = 'shot';
    if (options && options.flat) image.classList.add('is-flat');
    image.src = source;
    image.alt = label;

    const frame = document.createElement('div');
    frame.className = 'frame';
    frame.append(image);

    const viewer = document.createElement('div');
    viewer.className = 'viewer';
    viewer.append(frame);
    if (!options || options.map !== false) viewer.append(minimap(frame, profile));
    else viewer.classList.add('viewer--nomap');

    // Land on the first thing that differs: the top of a long page is usually
    // an unchanged header, and opening there says nothing.
    const at = peakBand(profile);
    if (at !== null) {
      const jump = () => {
        frame.scrollTop = Math.max(0, at * frame.scrollHeight - frame.clientHeight / 3);
      };
      if (image.complete) queueMicrotask(jump);
      else image.addEventListener('load', jump, { once: true });
    }

    wrapper.append(caption, viewer);
    return wrapper;
  }

  /**
   * A and B in one frame, with a draggable split between them.
   *
   * The frame scrolls, like every other view of a page eight thousand pixels
   * tall, and it opens where the two differ most rather than at a header they
   * share. Both halves sit in one stage so they scroll as one thing: aligning
   * them once at the top and letting them drift apart is the whole failure
   * this view exists to avoid.
   */
  function slider(comparison) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slider';

    // Everything visual lives in the stage, which is as tall as the pages
    // are. The frame around it is the window onto it.
    const stage = document.createElement('div');
    stage.className = 'slider__stage';

    const base = document.createElement('img');
    base.className = 'shot';
    // Dragging an image starts a native drag, which cancels the pointer stream
    // one move in and leaves the split stuck where it was first pressed.
    base.draggable = false;
    base.src = src(comparison.id, 'b');
    base.alt = result.config.labelB || 'B';

    const top = document.createElement('div');
    top.className = 'slider__top';
    const overlay = document.createElement('img');
    overlay.draggable = false;
    overlay.src = src(comparison.id, 'a');
    overlay.alt = result.config.labelA || 'A';
    top.append(overlay);

    const handle = document.createElement('div');
    handle.className = 'slider__handle';
    // Sticky, so the grip stays in view on a page far taller than the frame.
    const grip = document.createElement('span');
    grip.className = 'slider__grip';
    handle.append(grip);

    stage.append(base, top, handle);

    const control = document.createElement('label');
    control.className = 'slider__control';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.value = '50';
    range.setAttribute('aria-label', 'Reveal ' + (result.config.labelA || 'A') + ' over ' + (result.config.labelB || 'B'));
    control.append(result.config.labelA || 'A', range, result.config.labelB || 'B');

    const apply = () => {
      const value = Number(range.value);
      top.style.width = value + '%';
      handle.style.left = value + '%';
      // The clipped half would otherwise scale its image down with it, so the
      // overlay is pinned to the width of the stage it is being clipped out of.
      overlay.style.width = stage.clientWidth + 'px';
    };

    range.addEventListener('input', apply);
    base.addEventListener('load', apply);
    new ResizeObserver(apply).observe(stage);

    // Dragging on the picture itself, which is what a split like this invites.
    // A pointer listener rather than an invisible input stretched over the
    // frame: that one swallowed the wheel and left the view unscrollable.
    const dragTo = (event) => {
      const box = stage.getBoundingClientRect();
      const share = ((event.clientX - box.left) / box.width) * 100;
      range.value = String(Math.max(0, Math.min(100, share)));
      apply();
    };

    stage.addEventListener('pointerdown', (event) => {
      // Left button only, so a scroll gesture or a context menu is left alone.
      if (event.button !== 0) return;
      event.preventDefault();
      stage.setPointerCapture(event.pointerId);
      dragTo(event);
    });
    stage.addEventListener('pointermove', (event) => {
      if (stage.hasPointerCapture(event.pointerId)) dragTo(event);
    });
    stage.addEventListener('pointerup', (event) => {
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    });

    // Land where it differs; the top of a long page is a header they share.
    const at = peakBand(comparison.diff ? comparison.diff.profile : null);
    if (at !== null) {
      const jump = () => {
        wrapper.scrollTop = Math.max(0, at * wrapper.scrollHeight - wrapper.clientHeight / 3);
      };
      if (base.complete) queueMicrotask(jump);
      else base.addEventListener('load', jump, { once: true });
    }

    wrapper.append(stage);
    queueMicrotask(apply);

    const container = document.createElement('div');
    container.className = 'slider__box';
    container.append(wrapper, control);
    return container;
  }

  function onion(comparison) {
    const container = document.createElement('div');
    container.className = 'onion-view';
    const stack = document.createElement('div');
    stack.className = 'onion';
    const under = document.createElement('img');
    under.src = src(comparison.id, 'a');
    under.alt = 'A';
    const over = document.createElement('img');
    over.src = src(comparison.id, 'b');
    over.alt = 'B';
    over.style.opacity = '0.5';
    stack.append(under, over);

    const control = document.createElement('label');
    control.className = 'onion__control';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.value = '50';
    range.addEventListener('input', () => { over.style.opacity = String(Number(range.value) / 100); });
    control.append('A', range, 'B');

    container.append(stack, control);
    return container;
  }

  /**
   * What each side said, with the one-sided lines marked.
   *
   * A line both sides log is how the site is; a line only one side logs is
   * often the reason the two pictures differ, so those are what the eye is
   * pointed at rather than the wall of output.
   */
  function consoleView(comparison) {
    const container = document.createElement('div');
    const logs = comparison.logs;

    if (!logs) {
      const note = document.createElement('p');
      note.className = 'empty';
      note.textContent = 'Console recording was disabled for this run.';
      container.append(note);
      return container;
    }

    const meta = document.createElement('div');
    meta.className = 'markup-meta';

    const pill = document.createElement('span');
    pill.className = logs.differs ? 'pill pill--changed' : 'pill';
    pill.textContent = logs.differs
      ? (logs.onlyA + logs.onlyB) + ' only on one side'
      : 'Both sides say the same';
    meta.append(pill);

    const tally = document.createElement('span');
    tally.textContent = logs.a.length + ' vs ' + logs.b.length + ' lines';
    meta.append(tally);
    container.append(meta);

    if (logs.a.length === 0 && logs.b.length === 0) {
      const note = document.createElement('p');
      note.className = 'empty';
      note.textContent = 'Neither side said anything.';
      container.append(note);
      return container;
    }

    const textsA = new Set(logs.a.map((entry) => entry.text));
    const textsB = new Set(logs.b.map((entry) => entry.text));

    const pair = document.createElement('div');
    pair.className = 'logs';

    for (const [label, entries, others] of [
      [result.config.labelA || 'A', logs.a, textsB],
      [result.config.labelB || 'B', logs.b, textsA],
    ]) {
      const column = document.createElement('section');
      column.className = 'logs__side';

      const head = document.createElement('h3');
      head.textContent = label;
      column.append(head);

      if (entries.length === 0) {
        const quiet = document.createElement('p');
        quiet.className = 'empty';
        quiet.textContent = 'Nothing.';
        column.append(quiet);
      }

      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'logline' + (others.has(entry.text) ? '' : ' logline--only');

        const kind = document.createElement('span');
        kind.className = 'logline__kind logline__kind--' + entry.kind;
        kind.textContent = entry.kind;

        const text = document.createElement('span');
        text.className = 'logline__text';
        text.textContent = entry.text;

        row.append(kind, text);

        if (entry.count > 1) {
          const times = document.createElement('span');
          times.className = 'logline__count';
          times.textContent = '×' + entry.count;
          row.append(times);
        }

        column.append(row);
      }

      pair.append(column);
    }

    container.append(pair);
    return container;
  }

  function markupView(comparison) {
    const container = document.createElement('div');
    const markup = comparison.markup;

    if (!markup) {
      const note = document.createElement('p');
      note.className = 'empty';
      note.textContent = 'Markup diffing was disabled for this run.';
      container.append(note);
      return container;
    }

    const meta = document.createElement('div');
    meta.className = 'markup-meta';

    if (markup.identical) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = 'Markup identical';
      const count = document.createElement('span');
      count.textContent = markup.linesA.toLocaleString() + ' lines compared';
      meta.append(pill, count);
      container.append(meta);
      return container;
    }

    const pill = document.createElement('span');
    pill.className = 'pill pill--changed';
    pill.textContent = markup.hunks + (markup.hunks === 1 ? ' change' : ' changes');
    const added = document.createElement('span');
    added.className = 'added';
    added.textContent = '+' + markup.added;
    const removed = document.createElement('span');
    removed.className = 'removed';
    removed.textContent = '-' + markup.removed;
    const size = document.createElement('span');
    size.textContent = markup.linesA.toLocaleString() + ' vs ' + markup.linesB.toLocaleString() + ' lines';
    meta.append(pill, added, removed, size);

    if (comparison.files.patch) {
      const link = document.createElement('a');
      link.href = comparison.files.patch;
      link.textContent = 'full patch';
      link.target = '_blank';
      link.rel = 'noreferrer';
      meta.append(link);
    }
    container.append(meta);

    const hunks = comparison.markupHunks || [];
    container.append(patchTable(hunks));

    if (markup.hunks > hunks.length) {
      const note = document.createElement('p');
      note.className = 'warn';
      note.textContent = 'Showing the first ' + hunks.length + ' of ' + markup.hunks +
        ' changes. The complete diff is in the .patch file next to this report.';
      container.append(note);
    }

    return container;
  }

  function patchTable(hunks) {
    const wrapper = document.createElement('div');
    wrapper.className = 'patch';
    const table = document.createElement('table');

    for (const hunk of hunks) {
      const header = document.createElement('tr');
      header.className = 'hunk';
      const cell = document.createElement('td');
      cell.colSpan = 3;
      cell.textContent = '@@ line ' + (hunk.startA + 1) + ' (A) / ' + (hunk.startB + 1) + ' (B)';
      header.append(cell);
      table.append(header);

      let lineA = hunk.startA + 1;
      let lineB = hunk.startB + 1;

      for (const line of hunk.lines) {
        const row = document.createElement('tr');
        row.className = line.type;

        const numberA = document.createElement('td');
        numberA.className = 'num';
        const numberB = document.createElement('td');
        numberB.className = 'num';

        if (line.type === 'add') {
          numberB.textContent = String(lineB++);
        } else if (line.type === 'remove') {
          numberA.textContent = String(lineA++);
        } else {
          numberA.textContent = String(lineA++);
          numberB.textContent = String(lineB++);
        }

        const code = document.createElement('td');
        code.className = 'code';
        const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
        code.textContent = marker + line.text;

        row.append(numberA, numberB, code);
        table.append(row);
      }
    }

    wrapper.append(table);
    return wrapper;
  }

  /**
   * When these two pictures were taken.
   *
   * One moment when both were taken for this run, two when a side came from an
   * earlier one — and then it matters, because a difference measured across
   * two moments is a different claim from one measured across none. A report
   * worked through over an afternoon has entries from several of them.
   */
  function captured(comparison) {
    const stamp = (iso, seconds) =>
      new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        ...(seconds ? { second: '2-digit' } : {}),
      });

    const sides = ['a', 'b'].map((side) => {
      const from = comparison.capture ? comparison.capture[side].reusedFrom : null;
      return {
        at: from ? from.capturedAt : comparison.ranAt,
        label: (side === 'a' ? result.config.labelA : result.config.labelB) || side.toUpperCase(),
      };
    });

    const fresh = comparison.ranAt > result.finishedAt;
    const span = document.createElement('span');
    // Newer than the report it sits in: this one was run again since.
    span.className = 'stamp' + (fresh ? ' stamp--fresh' : '');
    span.append(fresh ? 'Refreshed ' : 'Captured ');
    // The rounded time is what gets read; the exact one is a hover away.
    span.title = sides.map((side) => side.label + ': ' + new Date(side.at).toLocaleString()).join(NEWLINE);

    if (sides[0].at === sides[1].at) {
      const value = document.createElement('b');
      value.textContent = stamp(sides[0].at, false);
      span.append(value);
      return span;
    }

    // Two moments minutes apart round to the same minute, and two stamps that
    // read alike look like a mistake rather than like a difference. Where that
    // happens the seconds come along.
    const seconds = stamp(sides[0].at, false) === stamp(sides[1].at, false);

    for (const [index, side] of sides.entries()) {
      if (index > 0) span.append(' · ');
      const value = document.createElement('b');
      value.textContent = side.label + ' ' + stamp(side.at, seconds);
      span.append(value);
    }

    return span;
  }

  function stats(comparison) {
    const row = document.createElement('div');
    row.className = 'stats';
    const diff = comparison.diff;
    row.innerHTML =
      '<span>Difference <b>' + pct(diff.ratio) + '</b></span>' +
      '<span>Threshold <b>' + pct(comparison.threshold) + '</b></span>' +
      '<span>Pixels <b>' + diff.diffPixels.toLocaleString() + '</b> / ' + diff.totalPixels.toLocaleString() + '</span>' +
      '<span>Size <b>' + diff.width + '×' + diff.height + '</b></span>' +
      (diff.aligned && diff.aligned.shift !== 0
        ? '<span>Moved <b>' + (diff.aligned.shift > 0 ? '+' : '') + diff.aligned.shift + 'px</b>' +
          (diff.unaligned ? ' <span class="aside">(' + pct(diff.unaligned.ratio) + ' compared by position)</span>' : '') +
          '</span>'
        : '') +
      (diff.regions && diff.regions.length > 0
        ? '<span>Differs at <b>' +
          diff.regions
            .slice(0, 3)
            .map((region) => 'y ' + region.from + '–' + region.to)
            .join(', ') +
          (diff.regions.length > 3 ? ' and ' + (diff.regions.length - 3) + ' more' : '') +
          '</b></span>'
        : '') +
      '<span>Duration <b>' + (comparison.durationMs / 1000).toFixed(1) + 's</b></span>' +
      (comparison.markup
        ? '<span>Markup <b>' + (comparison.markup.identical
            ? 'identical'
            : '+' + comparison.markup.added + ' / -' + comparison.markup.removed) + '</b></span>'
        : '');

    // With rows matched up, a height difference is explained by the shift and
    // no longer inflates the number, so the warning would only mislead.
    if (!diff.sizeMismatch || diff.aligned) return row;

    const wrapper = document.createElement('div');
    const warn = document.createElement('p');
    warn.className = 'warn';
    warn.textContent =
      'Different dimensions: A is ' + diff.sizeA.width + '×' + diff.sizeA.height +
      ', B is ' + diff.sizeB.width + '×' + diff.sizeB.height +
      '. Both were padded to the union size, so the extra area counts as a difference.';
    wrapper.append(row, warn);
    return wrapper;
  }

  /**
   * The matrix answers "which page, at which size, and how badly" in one look.
   * A long run is dozens of cards; scrolling through them to find the worst one
   * is the thing this replaces.
   */
  /**
   * One tile per scenario, laid out as a grid.
   *
   * A run of eighteen sites is thirty-six full-size cards; finding the worst
   * one meant scrolling past all of them. A tile is small enough that the
   * whole run fits on a screen, and carries the diff image, so "what changed"
   * is answered before anything is opened.
   */
  function buildOverview() {
    const container = document.getElementById('tiles');
    const viewports = [];
    const cells = new Map();

    const shown = visible();

    for (const comparison of result.comparisons) {
      if (!viewports.includes(comparison.viewport.name)) viewports.push(comparison.viewport.name);
      cells.set(key(qualify(comparison), comparison.viewport.name), comparison);
    }

    // Bars are scaled to the worst comparison in the run: on a suite where
    // everything sits under 2%, an absolute scale would draw identical
    // slivers and say nothing.
    const scale = Math.max(0.01, ...result.comparisons.map((entry) => (entry.diff ? entry.diff.ratio : 0)));

    const worst = new Map();
    for (const comparison of result.comparisons) {
      const ratio = comparison.diff ? comparison.diff.ratio : -1;
      const name = qualify(comparison);
      worst.set(name, Math.max(worst.get(name) ?? -1, ratio));
    }

    const order = [...new Set(shown.map(qualify))];
    if (state.sort === 'diff') order.sort((left, right) => worst.get(right) - worst.get(left));
    if (state.sort === 'name') order.sort((left, right) => left.localeCompare(right));

    if (order.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No comparisons match the current filter.';
      container.replaceChildren(empty);
      return;
    }

    // Scenarios keep the chosen order inside their group, and the groups
    // themselves are ordered by their worst page.
    const groups = new Map();
    for (const scenario of order) {
      const entry = shown.find((item) => qualify(item) === scenario);
      const name = entry && entry.group ? entry.group : null;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(scenario);
    }

    if (groups.size === 1 && groups.has(null)) {
      container.className = 'tiles';
      container.replaceChildren(...order.map((scenario) => tile(scenario, viewports, cells, scale)));
      return;
    }

    container.className = '';
    container.replaceChildren(
      ...[...groups].map(([name, scenarios]) =>
        section(name, scenarios, viewports, cells, scale)
      )
    );
  }

  /** One collapsible block per group, with its own tally. */
  function section(name, scenarios, viewports, cells, scale) {
    const block = document.createElement('details');
    block.className = 'group';
    block.open = true;

    const comparisons = scenarios.flatMap((scenario) =>
      viewports.map((viewport) => cells.get(key(scenario, viewport))).filter(Boolean)
    );
    const differing = comparisons.filter((entry) => entry.status === 'fail').length;
    const broken = comparisons.filter(
      (entry) => entry.status === 'error' || entry.status === 'timeout'
    ).length;

    const summary = document.createElement('summary');

    const title = document.createElement('span');
    title.className = 'group__name';
    title.textContent = name ?? 'Ungrouped';

    const tally = document.createElement('span');
    tally.className = 'group__tally';
    const pages = scenarios.length + (scenarios.length === 1 ? ' page' : ' pages');
    if (differing === 0 && broken === 0) {
      tally.innerHTML = pages + ' · <span class="clean">all unchanged</span>';
    } else {
      const parts = [];
      if (differing > 0) parts.push('<b>' + differing + '</b> differing');
      if (broken > 0) parts.push(broken + ' errored');
      tally.innerHTML = pages + ' · ' + parts.join(' · ');
    }

    summary.append(title, tally);

    const lead = comparisons.find((entry) => entry.urlA);
    if (lead) {
      const where = document.createElement('span');
      where.className = 'group__where';
      where.textContent = short(lead.urlA) + ' → ' + short(lead.urlB);
      where.title = lead.urlA + '  →  ' + lead.urlB;
      summary.append(where);
    }

    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    tiles.append(...scenarios.map((scenario) => tile(scenario, viewports, cells, scale)));

    block.append(summary, tiles);
    return block;
  }

  function tile(scenario, viewports, cells, scale) {
    const entries = viewports.map((viewport) => cells.get(key(scenario, viewport))).filter(Boolean);
    const lead = entries.find((entry) => entry.files && entry.files.diff) ?? entries[0];

    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'tile';

    const head = document.createElement('div');
    head.className = 'tile__head';
    const name = document.createElement('span');
    name.className = 'tile__name';
    name.textContent = lead ? lead.scenario : scenario;
    head.append(name);
    element.append(head);

    if (lead && lead.urlA) {
      const where = document.createElement('span');
      where.className = 'tile__where';
      where.textContent = short(lead.urlA) + ' → ' + short(lead.urlB);
      element.title = lead.urlA + '  →  ' + lead.urlB;
      element.append(where);
    }

    const shot = document.createElement('div');
    shot.className = 'tile__shot';
    const source = lead && lead.files ? src(lead.id, 'diff') || src(lead.id, 'a') : '';
    const flat = Boolean(lead && lead.files && !src(lead.id, 'diff'));

    if (source) {
      const image = document.createElement('img');
      image.loading = 'lazy';
      image.src = source;
      image.alt = '';

      const at = peakBand(lead && lead.diff ? lead.diff.profile : null);
      if (at !== null) {
        // Percentages on a transform resolve against the element, so this
        // shifts the image by that share of its own height, then centres.
        //
        // Held between the two edges: a difference near the top of the page
        // would otherwise be centred by pushing the picture down, and the
        // ground the tile sits on would show above it.
        const centred = 'calc(' + (-at * 100) + '% + var(--tile-shot) / 2)';
        image.style.transform =
          'translateY(min(0px, max(calc(var(--tile-shot) - 100%), ' + centred + ')))';
        shot.dataset.note = 'at ' + Math.round(at * 100) + '% of the page';
      }

      if (flat) image.classList.add('is-flat');
      shot.append(image);
    } else {
      shot.classList.add('tile__shot--none');
      shot.textContent = lead && lead.error ? 'not captured' : 'no image';
    }
    element.append(shot);

    const rows = document.createElement('div');
    rows.className = 'tile__rows';
    for (const viewport of viewports) {
      rows.append(tileRow(viewport, cells.get(key(scenario, viewport)), scale));
    }
    element.append(rows);

    // What the tile's viewports found between them, so the kind is readable
    // without opening the scenario.
    const kinds = [];
    for (const entry of entries) {
      for (const kind of entry.kinds || []) if (!kinds.includes(kind)) kinds.push(kind);
    }
    if (kinds.length > 0) element.append(tags(kinds));

    element.addEventListener('click', () => openScenario(scenario));
    return element;
  }

  function tags(kinds) {
    const list = document.createElement('div');
    list.className = 'tags';

    for (const kind of kinds) {
      const tag = document.createElement('span');
      tag.className = 'tag tag--' + kind;
      tag.textContent = KIND_LABELS[kind] || kind;
      list.append(tag);
    }

    return list;
  }

  function tileRow(viewport, comparison, scale) {
    const row = document.createElement('div');
    row.className = 'tile__row';

    const label = document.createElement('span');
    label.className = 'tile__vp';
    label.textContent = viewport;
    row.append(label);

    if (!comparison || comparison.status === 'error' || comparison.status === 'timeout' || comparison.status === 'skipped') {
      const state = document.createElement('span');
      state.className = 'tile__row--state';
      state.textContent = !comparison
        ? 'not run'
        : comparison.status === 'timeout'
          ? 'timed out'
          : comparison.status;
      if (comparison && comparison.status === 'skipped') row.classList.add('tile__row--skipped');
      row.append(state);
      return row;
    }

    const ratio = comparison.diff ? comparison.diff.ratio : 0;
    if (comparison.status === 'pass') row.classList.add('tile__row--pass');
    else if (ratio >= scale * 0.5) row.classList.add('tile__row--heavy');

    const percent = document.createElement('span');
    percent.className = 'tile__pct';
    percent.textContent = pct(ratio);

    const bar = document.createElement('span');
    bar.className = 'tile__bar';
    const fill = document.createElement('span');
    fill.className = 'tile__fill';
    // A hairline for a non-zero difference, so "tiny" never reads as "none".
    fill.style.width = ratio === 0 ? '0' : Math.max(3, (ratio / scale) * 100) + '%';
    bar.append(fill);

    row.append(percent, bar);
    return row;
  }

  /** What a scenario is called once its group is taken into account. */
  function qualify(comparison) {
    return comparison.group ? comparison.group + '/' + comparison.scenario : comparison.scenario;
  }

  function key(scenario, viewport) {
    return JSON.stringify([scenario, viewport]);
  }

  function firstLine(text) {
    return String(text).split(NEWLINE)[0];
  }

  /** Six steps, so a 0.2% change and a 40% one do not look the same. */
  function level(ratio) {
    const percent = ratio * 100;
    if (percent === 0) return 0;
    if (percent < 0.1) return 1;
    if (percent < 1) return 2;
    if (percent < 5) return 3;
    if (percent < 20) return 4;
    return 5;
  }

  function short(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
    } catch {
      return url;
    }
  }

  /** Scenario names in the order the overview currently shows them. */
  function overviewOrder() {
    const worst = new Map();
    for (const comparison of result.comparisons) {
      const ratio = comparison.diff ? comparison.diff.ratio : -1;
      const name = qualify(comparison);
      worst.set(name, Math.max(worst.get(name) ?? -1, ratio));
    }

    const order = [...new Set(result.comparisons.map(qualify))];
    if (state.sort === 'diff') order.sort((left, right) => worst.get(right) - worst.get(left));
    if (state.sort === 'name') order.sort((left, right) => left.localeCompare(right));
    return order;
  }

  /**
   * Opens one scenario on its own.
   *
   * Thirty-six comparisons on one page is thirty-six full-page screenshots
   * loading at once, and scrolling past all of them to reach the one that
   * matters. The overview is the index; this is the page it points at.
   */
  function openScenario(scenario, options) {
    state.scenario = scenario;

    const entries = result.comparisons.filter((entry) => qualify(entry) === scenario);
    const lead = entries[0];

    const heading = document.getElementById('detail-name');
    heading.textContent = '';
    if (lead && lead.group) {
      const group = document.createElement('span');
      group.className = 'detail__group';
      group.textContent = lead.group + ' / ';
      heading.append(group);
    }
    heading.append(document.createTextNode(lead ? lead.scenario : scenario));
    const where = document.getElementById('detail-where');
    where.textContent = lead && lead.urlA ? lead.urlA + '  →  ' + lead.urlB : '';

    const order = overviewOrder();
    const at = order.indexOf(scenario);
    document.getElementById('prev').disabled = at <= 0;
    document.getElementById('next').disabled = at === -1 || at >= order.length - 1;

    document.getElementById('overview').hidden = true;
    document.getElementById('detail').hidden = false;
    document.documentElement.dataset.view = 'detail';

    render();

    if (!options || options.scroll !== false) window.scrollTo({ top: 0 });
    if (!options || options.hash !== false) {
      location.hash = encodeURIComponent(scenario);
    }
  }

  function showOverview(options) {
    state.scenario = null;
    document.getElementById('detail').hidden = true;
    document.getElementById('overview').hidden = false;
    document.documentElement.dataset.view = 'overview';
    render();

    if (!options || options.hash !== false) {
      history.pushState(null, '', location.pathname + location.search);
    }
  }

  function step(direction) {
    const order = overviewOrder();
    const at = order.indexOf(state.scenario);
    const next = order[at + direction];
    if (next) openScenario(next);
  }

  const kindPicker = document.getElementById('kind');
  if (kindPicker) {
    kindPicker.addEventListener('change', (event) => {
      state.kind = event.target.value;
      // The kinds are a question about the list, so answering it means going
      // back to the list rather than re-rendering the one view being read.
      if (state.scenario) showOverview();
      buildOverview();
    });
  }

  document.getElementById('modes').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    state.mode = button.dataset.mode;
    document.querySelectorAll('#modes button').forEach((other) =>
      other.classList.toggle('is-active', other === button)
    );
    render();
  });

  document.getElementById('back').addEventListener('click', showOverview);
  document.getElementById('prev').addEventListener('click', () => step(-1));
  document.getElementById('next').addEventListener('click', () => step(1));

  /** The hash is the address of a view, so the browser's buttons work too. */
  function applyHash() {
    const requested = decodeURIComponent(location.hash.replace(/^#/, ''));
    const known = requested && result.comparisons.some((entry) => qualify(entry) === requested);

    if (known && requested !== state.scenario) openScenario(requested, { hash: false });
    else if (!requested && state.scenario) showOverview({ hash: false });
  }

  window.addEventListener('hashchange', applyHash);

  document.addEventListener('keydown', (event) => {
    if (!state.scenario || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target.matches('input, select, textarea')) return;
    if (event.key === 'Escape') showOverview();
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  });

  document.querySelector('.filters').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    event.currentTarget.querySelectorAll('button').forEach((other) =>
      other.classList.toggle('is-active', other === button)
    );
    if (state.scenario) showOverview();
    buildOverview();
  });
  document.getElementById('sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    buildOverview();
  });
  document.getElementById('search').addEventListener('input', (event) => {
    state.query = event.target.value;
    if (state.scenario) showOverview();
    buildOverview();
  });

  /**
   * The settings the run was given, grouped the way the config file groups
   * them, so a finding can be traced back to what produced it. What the run
   * recorded is already free of credentials; this only lays it out.
   */
  function buildSettings() {
    const body = document.getElementById('settings-body');
    const settings = result.settings;
    if (!settings) {
      document.getElementById('settings').hidden = true;
      return;
    }

    const yes = (value) => (value ? 'yes' : 'no');
    const ms = (value) => (value === 0 ? 'none' : value + ' ms');
    const listOf = (values) => (values.length > 0 ? values.join(', ') : '—');
    const sideOf = (side) =>
      [
        side.baseUrl || 'per scenario',
        side.basicAuth ? 'basic auth' : null,
        side.headers.length > 0 ? 'headers ' + side.headers.join(', ') : null,
        side.cookies.length > 0 ? 'cookies ' + side.cookies.join(', ') : null,
        side.storageState ? 'storage state' : null,
      ]
        .filter(Boolean)
        .join(' · ');

    const groups = [
      ['Compare', [
        [settings.a.label, sideOf(settings.a)],
        [settings.b.label, sideOf(settings.b)],
        ['Scenarios', String(settings.scenarios)],
        ['Viewports', settings.viewports.map((view) => view.name + ' ' + view.width + '×' + view.height).join(', ')],
      ]],
      ['Difference', [
        ['Threshold', pct(settings.threshold)],
        ['Pixel tolerance', String(settings.pixelThreshold)],
        ['Ignore antialiasing', yes(settings.ignoreAntialiasing)],
        ['Align rows', yes(settings.alignRows)],
        ['Mask', listOf(settings.mask)],
        ['Hide', listOf(settings.hide)],
        ['Remove', listOf(settings.remove)],
      ]],
      ['Browser', [
        ['Engine', settings.browser + (settings.headless ? '' : ', headed')],
        ['Colour scheme', settings.colorScheme],
        ['Reduced motion', yes(settings.reducedMotion)],
        ['Locale', settings.locale || '—'],
        ['Time zone', settings.timezone || '—'],
        ['User agent', settings.userAgent || '—'],
        ['Ignore HTTPS errors', yes(settings.ignoreHTTPSErrors)],
      ]],
      ['Stability', [
        ['Workers', String(settings.workers)],
        ['Retries', String(settings.retries)],
        ['Capture sides', settings.sequential ? 'one after another' : 'at the same time'],
        ['Freeze animation', yes(settings.freeze)],
        ['Trigger lazy loading', yes(settings.triggerLazyLoad)],
      ]],
      ['Timeouts', [
        ['Per action', ms(settings.timeout)],
        ['Per comparison', ms(settings.comparisonTimeout)],
        ['Whole run', ms(settings.runTimeout)],
      ]],
      ['Markup', [
        ['Enabled', yes(settings.markup.enabled)],
        ['Fails a comparison', yes(settings.markup.failOnDifference)],
        ['Ignored attributes', listOf(settings.markup.ignoreAttributes)],
        ['Ignored selectors', listOf(settings.markup.ignoreSelectors)],
        ['Sort attributes', yes(settings.markup.sortAttributes)],
      ]],
      ['Console', [
        ['Enabled', yes(settings.logs.enabled)],
        ['Fails a comparison', yes(settings.logs.failOnDifference)],
        ['Levels', listOf(settings.logs.levels)],
        ['Ignored', listOf(settings.logs.ignore)],
        ['Kept per side', String(settings.logs.max)],
      ]],
    ];

    if (settings.beforeEach.length > 0) {
      groups.push(['Before each page', settings.beforeEach.map((entry) => [
        entry.name,
        [
          entry.steps + ' step' + (entry.steps === 1 ? '' : 's'),
          entry.when ? 'when ' + entry.when : 'always',
          entry.once ? 'once' : null,
          entry.required ? 'required' : null,
          entry.side ? 'side ' + entry.side.toUpperCase() : null,
        ].filter(Boolean).join(' · '),
      ])]);
    }

    if (settings.reuse.sides.length > 0) {
      groups.push(['Reuse', [
        ['Sides', settings.reuse.sides.map((side) => side.toUpperCase()).join(', ')],
        ['From', settings.reuse.from],
        ['Warn beyond', settings.reuse.maxAge === 0 ? 'never' : Math.round(settings.reuse.maxAge / 3600000) + ' h'],
      ]]);
    }

    for (const [title, rows] of groups) {
      const group = document.createElement('div');
      group.className = 'settings__group';

      const heading = document.createElement('h3');
      heading.textContent = title;
      group.append(heading);

      const table = document.createElement('dl');
      for (const [label, value] of rows) {
        const term = document.createElement('dt');
        term.textContent = label;
        const detail = document.createElement('dd');
        detail.textContent = value;
        table.append(term, detail);
      }

      group.append(table);
      body.append(group);
    }
  }

  const yaml = payload.settingsYaml;
  if (yaml) {
    document.getElementById('settings-yaml').hidden = false;
    document.getElementById('settings-yaml-text').textContent = yaml;
    const copy = document.getElementById('copy-settings');
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(yaml).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      });
    });
  }

  document.getElementById('open-settings').addEventListener('click', () => {
    const panel = document.getElementById('settings');
    if (state.scenario) showOverview();
    panel.open = true;
    panel.scrollIntoView({ block: 'start' });
  });

  /**
   * The whole run again, said where the run is described rather than inside a
   * finding: from the overview the question is "look at all of this again",
   * and a per-case line is the wrong answer to it.
   */
  if (result.command) {
    document.getElementById('run-command').append(rerun(result.command, 'Run it all again'));
  }

  buildSettings();
  buildOverview();

  applyHash();
})();
`;
