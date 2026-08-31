import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Comparison, Config, RunResult } from '../types.js';
import { shell } from './shell.js';

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

  return shell(result, config, payload);
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

export function comparisonLabel(comparison: Comparison): string {
  return `${comparison.scenario} @ ${comparison.viewport.name}`;
}

/**
 * The mark, inlined — the report is one file that has to survive being mailed
 * around, so nothing it shows may live beside it. Both panels take their
 * colour from the palette rather than naming one, which is why the amber here
 * is the accent and stays in step with it.
 */
