import { KIND_LABELS, tally } from '../classify.js';
import { HOMEPAGE, VERSION } from '../manifest.js';
import type { Config, DiffKind, RunResult } from '../types.js';
import { SCRIPT } from './client.js';
import { INDEX_FILE, call } from './pool.js';
import { STYLES } from './styles.js';

/**
 * The run, linked rather than carried: one file, loaded before anything is
 * drawn, with the per-case chunks beside it.
 */
export function linked(): string {
  return `<script src="${INDEX_FILE}"></script>`;
}

/**
 * The run, carried: every chunk inlined ahead of the index, so the report is
 * one file that still works with nothing beside it.
 */
export function carried(payload: unknown, cases: [string, unknown][]): string {
  const chunks = cases.map(([id, detail]) => `<script>${call('case', [id, detail])}</script>`);
  return [...chunks, `<script>${call('run', payload)}</script>`].join('\n');
}

/**
 * The document the report is: its head, its chrome, and the templates the
 * client fills in. Everything here is decided before the page is open;
 * anything that depends on what the reader does is in client.ts.
 */
export function shell(result: RunResult, config: Config, data: string): string {
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

<!--
  The structures the report repeats, written as markup rather than assembled a
  node at a time. The line is between structure and behaviour: what a thing is
  made of belongs here, what it does when it is touched stays in the client.
-->
<template id="patch-template">
  <div class="patch"><table></table></div>
</template>

<template id="patch-hunk-template">
  <tr class="hunk"><td colspan="3"></td></tr>
</template>

<template id="patch-line-template">
  <tr><td class="num"></td><td class="num"></td><td class="code"></td></tr>
</template>

<template id="tile-template">
  <button type="button" class="tile">
    <div class="tile__head"><span class="tile__name"></span></div>
    <span class="tile__where"></span>
    <div class="tile__shot"></div>
    <div class="tile__rows"></div>
  </button>
</template>

<template id="tile-row-template">
  <div class="tile__row">
    <span class="tile__vp"></span>
    <span class="tile__row--state"></span>
    <span class="tile__pct"></span>
    <span class="tile__bar"><span class="tile__fill"></span></span>
  </div>
</template>

<template id="logs-side-template">
  <section class="logs__side"><h3></h3></section>
</template>

<template id="logline-template">
  <div class="logline">
    <span class="logline__kind"></span>
    <span class="logline__text"></span>
    <span class="logline__count"></span>
  </div>
</template>

<template id="rerun-template">
  <div class="rerun">
    <span class="rerun__label"></span>
    <code></code>
    <button type="button">Copy</button>
  </div>
</template>

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

<script>${SCRIPT}</script>
${data}
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

const MARK = `<svg class="topbar__mark" viewBox="0 0 288 216" role="img" aria-label="diffyard">
  <path fill="currentColor" d="M16 0h69l75 80-30 30v90c0 8.84-7.16 16-16 16H16c-8.84 0-16-7.16-16-16V16C0 7.16 7.16 0 16 0Z"/>
  <path fill="var(--accent)" d="M177 0h95c8.84 0 16 7.16 16 16v184c0 8.84-7.16 16-16 16h-92c-8.84 0-16-7.16-16-16v-73l47-55-51-55 17-17Z"/>
</svg>`;

