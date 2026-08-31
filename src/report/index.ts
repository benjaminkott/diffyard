import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Comparison, Config, RunResult } from '../types.js';
import { INDEX_FILE, call, caseFile, forDelivery } from './pool.js';
import { carried, linked, shell } from './shell.js';

export interface ReportOptions {
  /** Inline every screenshot as a data URI so the HTML travels on its own. */
  selfContained: boolean;
}

/** The report, and whatever has to be written beside it for it to work. */
export interface Report {
  html: string;
  /** Path relative to the run folder, and what goes in it. */
  files: [string, string][];
}

/**
 * Renders the run into a single HTML document.
 *
 * With `selfContained: false` the images are referenced relatively and the run
 * is written beside the report as a pool of scripts -- an index for what the
 * overview draws, a chunk per comparison for what only its detail view draws.
 * The whole output directory is then the artifact. With `selfContained: true`
 * every picture and every chunk is inlined instead, which is one file that can
 * be opened straight from a CI artifact list.
 */
export async function renderReport(
  result: RunResult,
  config: Config,
  options: ReportOptions
): Promise<Report> {
  const sources = options.selfContained ? await inlineImages(result, result.outDir) : referenceImages(result);
  const { index, cases } = forDelivery(result);
  const payload = { result: index, sources, settingsYaml: settingsYaml(result) };

  if (options.selfContained) {
    return { html: shell(result, config, carried(payload, cases)), files: [] };
  }

  return {
    html: shell(result, config, linked()),
    files: [
      [INDEX_FILE, call('run', payload)],
      ...cases.map(([id, detail]): [string, string] => [caseFile(id), call('case', [id, detail])]),
    ],
  };
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

/**
 * The three pictures a report draws, and nothing else in `files`.
 *
 * The rest of that map -- the two documents, the patch, the JSON record, the
 * chunk -- is linked to by name where it is offered, never drawn. Inlining
 * walked the whole map, so a self-contained report carried both sides' full
 * HTML and the patch again, base64'd and labelled as PNG.
 */
const DRAWN = ['a', 'b', 'diff'] as const;

function referenceImages(result: RunResult): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const comparison of result.comparisons) {
    for (const side of DRAWN) {
      const file = comparison.files[side];
      if (file) sources[`${comparison.id}:${side}`] = file;
    }
  }
  return sources;
}

async function inlineImages(result: RunResult, outDir: string): Promise<Record<string, string>> {
  const sources: Record<string, string> = {};
  for (const comparison of result.comparisons) {
    for (const side of DRAWN) {
      const file = comparison.files[side];
      if (!file) continue;
      const bytes = await readFile(join(outDir, file));
      sources[`${comparison.id}:${side}`] = `data:image/png;base64,${bytes.toString('base64')}`;
    }
  }
  return sources;
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
