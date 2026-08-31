import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Capturer } from './capture.js';
import { classifyRun } from './classify.js';
import { slug } from './config.js';
import { diffImages } from './diff.js';
import { originOf, summarise } from './logs.js';
import { diffMarkup } from './markup.js';
import { fingerprint, MISS_REASON, ReuseStore, type ReuseSource } from './reuse.js';
import type {
  Comparison,
  Config,
  MarkupResult,
  RunResult,
  RunSettings,
  Scenario,
  Side,
  SideCapture,
  SideSettings,
  Viewport,
} from './types.js';

export type Phase = 'capture' | 'compare';

export interface RunEvents {
  onStart?: (total: number, run: { runId: string; outDir: string; reuse: ReuseSource | null }) => void;
  /** Fires whenever the runner moves to a new step of a comparison. */
  /**
   * Fires whenever a comparison moves to a new step. `id` identifies which
   * one, so a caller running several at once can tell them apart rather than
   * showing whichever reported last.
   */
  onProgress?: (state: { id: string; index: number; total: number; label: string; phase: Phase }) => void;
  onComparisonDone?: (comparison: Comparison, index: number, total: number) => void;
}

interface Job {
  scenario: Scenario;
  viewport: Viewport;
  id: string;
}

/**
 * Runs every scenario/viewport pair strictly one after another: A is captured,
 * then B, then both are diffed. Sequential execution keeps the two sides under
 * comparable machine load, which matters for animation- and timing-sensitive
 * pages.
 */
export async function run(config: Config, events: RunEvents = {}): Promise<RunResult> {
  const startedAt = new Date();
  const jobs = buildJobs(config);

  // Before the run directory is claimed: "latest" must mean the newest
  // finished run, not the empty one this call is about to create.
  const store =
    config.reuse.sides.length > 0
      ? await ReuseStore.open(config.outDir, config.reuse.from, startedAt)
      : null;

  const { runId, outDir } = await claimRunDirectory(config, startedAt);
  const shotsDir = join(outDir, 'shots');
  await mkdir(shotsDir, { recursive: true });

  events.onStart?.(jobs.length, { runId, outDir, reuse: store?.source ?? null });

  const comparisons: Comparison[] = new Array(jobs.length);
  const capturer = await Capturer.launch(config);
  let finished = 0;

  try {
    const deadline = config.runTimeout > 0 ? Date.now() + config.runTimeout : Infinity;
    let next = 0;

    /**
     * Workers take from one queue, so a slow comparison holds up nothing but
     * itself. Results are written to their own slot, which keeps the report in
     * config order however they finish.
     */
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const job = jobs[index];
        if (!job) return;

        const report = (phase: Phase) =>
          events.onProgress?.({
            id: job.id,
            index: finished,
            total: jobs.length,
            label: qualifiedLabel(job),
            phase,
          });

        let comparison: Comparison;

        if (Date.now() > deadline) {
          comparison = abandoned(job, config, `Run timeout of ${config.runTimeout}ms reached`);
        } else if (job.scenario.skip) {
          comparison = skipped(job, config);
        } else {
          const budget = Math.min(
            config.comparisonTimeout > 0 ? config.comparisonTimeout : Infinity,
            deadline - Date.now()
          );
          comparison = await withTimeout(
            compare(capturer, config, job, shotsDir, report, store, runId),
            budget,
            job,
            config,
            capturer
          );
        }

        comparisons[index] = comparison;
        finished += 1;
        events.onComparisonDone?.(comparison, finished - 1, jobs.length);
      }
    };

    const workers = Math.max(1, Math.min(config.workers, jobs.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));
  } finally {
    await capturer.close();
  }

  // The kinds are decided against the whole run: a line that differs on every
  // page of it is telling you about the build, not about this page.
  const common = classifyRun(comparisons);

  // Beside its own screenshots, so one case is a directory listing rather than
  // a search through nine hundred in results.json. Written here rather than as
  // each finishes, so what it holds is what the run finally concluded.
  await Promise.all(
    comparisons
      .filter((comparison) => comparison.files.result !== null)
      .map((comparison) =>
        writeFile(join(shotsDir, `${comparison.id}.json`), `${JSON.stringify(comparison, null, 2)}\n`)
      )
  );

  const finishedAt = new Date();

  return {
    commonMarkup: common,
    command: runCommandFor(config, runId),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    total: comparisons.length,
    passed: comparisons.filter((entry) => entry.status === 'pass').length,
    failed: comparisons.filter((entry) => entry.status === 'fail').length,
    errored: comparisons.filter((entry) => entry.status === 'error' || entry.status === 'timeout').length,
    skipped: comparisons.filter((entry) => entry.status === 'skipped').length,
    comparisons,
    outDir,
    runId,
    refreshedAt: null,
    reuse: store
      ? {
          sides: config.reuse.sides,
          runId: store.source.runId,
          capturedAt: store.source.capturedAt,
          reused: comparisons.filter((entry) => entry.capture && reusedSides(entry).length > 0).length,
          recaptured: comparisons.filter(
            (entry) =>
              entry.capture &&
              config.reuse.sides.some((side) => entry.capture?.[side].recapturedBecause !== null)
          ).length,
        }
      : null,
    config: {
      file: config.file,
      a: config.a.baseUrl,
      b: config.b.baseUrl,
      labelA: config.a.label,
      labelB: config.b.label,
      browser: config.browser,
      outDir: config.outDir,
    },
    settings: settingsOf(config),
  };
}

/**
 * The settings, as the run is willing to hand them on.
 *
 * Written out field by field rather than spread from the config, so adding an
 * option is a decision about whether it may travel: a report is a file people
 * zip and mail, and a header value, a cookie, a basic-auth password or what a
 * login step types are not things to send with it. Those are reduced to their
 * shape — the name, the count, whether it was set at all.
 */
export function settingsOf(config: Config): RunSettings {
  const side = (from: Config['a']): SideSettings => ({
    label: from.label,
    baseUrl: from.baseUrl,
    headers: Object.keys(from.headers),
    cookies: from.cookies.map((cookie) => cookie.name),
    basicAuth: from.basicAuth !== null,
    storageState: from.storageState,
  });

  return {
    a: side(config.a),
    b: side(config.b),
    viewports: config.viewports,
    scenarios: config.scenarios.length,
    beforeEach: config.beforeEach.map((entry) => ({
      name: entry.name,
      when: entry.when,
      once: entry.once,
      required: entry.required,
      side: entry.side,
      steps: entry.steps.length,
    })),
    browser: config.browser,
    headless: config.headless,
    colorScheme: config.colorScheme,
    reducedMotion: config.reducedMotion,
    locale: config.locale,
    timezone: config.timezone,
    userAgent: config.userAgent,
    ignoreHTTPSErrors: config.ignoreHTTPSErrors,
    threshold: config.threshold,
    pixelThreshold: config.pixelThreshold,
    ignoreAntialiasing: config.ignoreAntialiasing,
    alignRows: config.alignRows,
    mask: config.mask,
    hide: config.hide,
    remove: config.remove,
    timeout: config.timeout,
    comparisonTimeout: config.comparisonTimeout,
    runTimeout: config.runTimeout,
    retries: config.retries,
    freeze: config.freeze,
    triggerLazyLoad: config.triggerLazyLoad,
    sequential: config.sequential,
    workers: config.workers,
    markup: config.markup,
    logs: config.logs,
    reuse: config.reuse,
  };
}

/**
 * Caps a comparison at `budget` milliseconds.
 *
 * Playwright operations carry their own timeouts, so this is a backstop for the
 * case where a page keeps the run busy in a way no single operation notices. On
 * expiry the browser contexts are recycled, since a page stuck mid-interaction
 * cannot be trusted for the next scenario.
 */
async function withTimeout(
  work: Promise<Comparison>,
  budget: number,
  job: Job,
  config: Config,
  capturer: Capturer
): Promise<Comparison> {
  if (!Number.isFinite(budget) || budget <= 0) return work;

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budget);
  });

  try {
    const outcome = await Promise.race([work, expiry]);
    if (outcome !== 'timeout') return outcome;
  } finally {
    clearTimeout(timer);
  }

  // Let the abandoned capture fail quietly instead of surfacing as unhandled.
  void work.catch(() => undefined);
  await capturer.recycle();

  return abandoned(job, config, `Timed out after ${Math.round(budget / 1000)}s`);
}

/** A comparison that never produced a result: timed out or cut off by the run. */
function abandoned(job: Job, config: Config, reason: string): Comparison {
  return {
    command: '',
    ranAt: new Date().toISOString(),
    id: job.id,
    scenario: job.scenario.name,
    group: job.scenario.group,
    viewport: job.viewport,
    urlA: config.a.baseUrl,
    urlB: config.b.baseUrl,
    status: 'timeout',
    threshold: job.scenario.threshold,
    diff: null,
    markup: null,
    markupHunks: null,
    logs: null,
    kinds: [],
    files: { a: null, b: null, diff: null, htmlA: null, htmlB: null, patch: null, result: null },
    capture: null,
    error: reason,
    durationMs: 0,
  };
}

/**
 * Picks the run name and creates its directory.
 *
 * The timestamp keeps runs sortable, the hash suffix keeps two runs started in
 * the same second apart. Creating the directory non-recursively makes the claim
 * atomic: whoever wins the mkdir owns the name, and a loser simply tries again.
 */
async function claimRunDirectory(
  config: Config,
  startedAt: Date
): Promise<{ runId: string; outDir: string }> {
  if (!config.runFolder) {
    await prepareOutDir(config.outDir);
    return { runId: config.runId ?? runName(config, startedAt), outDir: config.outDir };
  }

  await prepareOutDir(config.outDir);

  // A fixed runId is the caller's choice, so reuse its directory as-is.
  if (config.runId) {
    const outDir = join(config.outDir, config.runId);
    await mkdir(outDir, { recursive: true });
    return { runId: config.runId, outDir };
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const runId = runName(config, startedAt);
    const outDir = join(config.outDir, runId);
    try {
      await mkdir(outDir);
      return { runId, outDir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  throw new Error(`Could not claim a run directory in ${config.outDir} after 10 attempts`);
}

/**
 * Creates the output directory and marks it as ignored by git.
 *
 * Screenshots and reports are artifacts of a run, not sources; without this
 * every run would offer a few hundred PNGs to the next commit. An existing
 * .gitignore is left alone.
 */
async function prepareOutDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });

  const marker = join(dir, '.gitignore');
  try {
    await writeFile(
      marker,
      '# Created by diffyard. Comparison results are artifacts, not sources.\n*\n',
      { flag: 'wx' }
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Sortable and unique: 2026-08-27_14-32-10-3f9c1a. */
function runName(config: Config, date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;

  const hash = createHash('sha256')
    .update(
      [
        date.toISOString(),
        config.a.baseUrl,
        config.b.baseUrl,
        config.browser,
        config.scenarios.map((scenario) => scenario.name).join(','),
        String(process.pid),
        randomUUID(),
      ].join('|')
    )
    .digest('hex')
    .slice(0, 6);

  return `${stamp}-${hash}`;
}

/**
 * What to run to do one comparison again, into this same report.
 *
 * Working through a list of findings means fixing one thing and looking at one
 * view again. Without a line to copy, that is either re-running everything or
 * working the flags out by hand, once per finding.
 *
 * It mirrors the run it came from rather than improving on it: a run that
 * reused a side says so, pointing at this run's own copy of that side, and a
 * run that captured both keeps capturing both.
 */
function commandFor(config: Config, runId: string, id: string): string {
  return runCommandFor(config, runId, `--case ${id}`);
}

/**
 * The same line for the whole run rather than one finding.
 *
 * A report that says how to redo one case but not all of them makes the common
 * move -- fix the deployment, look again at everything -- the one you have to
 * work out by hand. It carries no `--case`, so it is the run this report is,
 * repeated into this report.
 */
export function runCommandFor(config: Config, runId: string, only?: string): string {
  const parts = ['diffyard run', quote(config.file)];
  if (only) parts.push(only);
  parts.push(`--into ${runId}`);

  if (config.reuse.sides.length > 0) {
    parts.push(`--reuse ${config.reuse.sides.join(',')}`, `--reuse-from ${runId}`);
  }

  return parts.join(' ');
}

/** Shell-safe, for the one thing here a user did not type: their own path. */
function quote(value: string): string {
  return /^[\w./@-]+$/.test(value) ? value : `'${value.split("'").join(`'\\''`)}'`;
}

/** The sides of a comparison that came from an earlier run. */
export function reusedSides(comparison: Comparison): Side[] {
  if (!comparison.capture) return [];
  return (['a', 'b'] as const).filter((side) => comparison.capture?.[side].reusedFrom);
}

/** How a job is named in progress and log lines. */
function qualifiedLabel(job: Job): string {
  const name = job.scenario.group ? `${job.scenario.group}/${job.scenario.name}` : job.scenario.name;
  return `${name} @ ${job.viewport.name}`;
}

/** Expands scenarios across viewports, honouring `only` and stable ordering. */
function buildJobs(config: Config): Job[] {
  const focused = config.scenarios.filter((scenario) => scenario.only);
  const scenarios = focused.length > 0 ? focused : config.scenarios;

  return scenarios.flatMap((scenario) =>
    scenario.viewports.map((viewport) => ({
      scenario,
      viewport,
      id: `${scenario.group ? `${slug(scenario.group)}--` : ''}${slug(scenario.name)}--${slug(viewport.name)}`,
    }))
  );
}

async function compare(
  capturer: Capturer,
  config: Config,
  job: Job,
  shotsDir: string,
  report: (phase: Phase) => void,
  store: ReuseStore | null,
  runId: string
): Promise<Comparison> {
  const started = Date.now();
  const command = commandFor(config, runId, job.id);
  const attempts = config.retries + 1;
  let lastError: Error | null = null;
  const capture: { a: SideCapture; b: SideCapture } = {
    a: { fingerprint: fingerprint(config, job.scenario, job.viewport, 'a'), reusedFrom: null, recapturedBecause: null },
    b: { fingerprint: fingerprint(config, job.scenario, job.viewport, 'b'), reusedFrom: null, recapturedBecause: null },
  };

  /**
   * One side, from the earlier run when it still applies and from the browser
   * otherwise. A shot that no longer matches the config is taken again and
   * says so, rather than being used because it happens to be there.
   */
  const obtain = async (side: Side) => {
    const request = { scenario: job.scenario, viewport: job.viewport, side };
    if (!store || !config.reuse.sides.includes(side)) return capturer.capture(request);

    const outcome = await store.take(job.id, side, capture[side].fingerprint, {
      html: config.markup.enabled,
      logs: config.logs.enabled,
    });

    if (outcome.reused) {
      capture[side].reusedFrom = { runId: store.source.runId, capturedAt: store.source.capturedAt };
      capture[side].recapturedBecause = null;
      return { url: outcome.url, png: outcome.png, html: outcome.html, logs: outcome.logs };
    }

    capture[side].reusedFrom = null;
    capture[side].recapturedBecause = MISS_REASON[outcome.reason];
    return capturer.capture(request);
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Both sides at once. It halves the wall clock, and it is the fairer
      // comparison: the two pages meet the same machine load instead of one
      // being captured on an idle box and the other behind it.
      report('capture');
      const [shotA, shotB] = config.sequential
        ? [await obtain('a'), await obtain('b')]
        : await Promise.all([obtain('a'), obtain('b')]);

      report('compare');
      const { result, png } = diffImages(shotA.png, shotB.png, {
        pixelThreshold: config.pixelThreshold,
        ignoreAntialiasing: config.ignoreAntialiasing,
        alignRows: config.alignRows,
      });

      // A comparison that found nothing has a difference picture with nothing
      // in it, and it costs as much as the screenshot it was made from. On a
      // suite where most pages are fine that is most of the folder, so it is
      // not written; the report greys side A instead, which is what the
      // picture would have shown.
      const differs = result.diffPixels > 0;

      const files: Comparison['files'] = {
        a: `shots/${job.id}.a.png`,
        b: `shots/${job.id}.b.png`,
        diff: differs ? `shots/${job.id}.diff.png` : null,
        htmlA: null,
        htmlB: null,
        patch: null,
        result: `shots/${job.id}.json`,
      };

      const writes: Promise<unknown>[] = [
        writeFile(join(shotsDir, `${job.id}.a.png`), shotA.png),
        writeFile(join(shotsDir, `${job.id}.b.png`), shotB.png),
      ];
      if (differs) writes.push(writeFile(join(shotsDir, `${job.id}.diff.png`), png));

      const logs = config.logs.enabled
        ? summarise(shotA.logs, shotB.logs, { a: originOf(shotA.url), b: originOf(shotB.url) })
        : null;

      let markup: MarkupResult | null = null;
      let hunks: Comparison['markupHunks'] = null;

      if (config.markup.enabled && shotA.html !== null && shotB.html !== null) {
        const markupDiff = diffMarkup(shotA.html, shotB.html, config.markup);
        markup = markupDiff.result;
        hunks = markupDiff.hunks.slice(0, config.markup.maxHunksInReport);

        files.htmlA = `shots/${job.id}.a.html`;
        files.htmlB = `shots/${job.id}.b.html`;
        writes.push(
          writeFile(join(shotsDir, `${job.id}.a.html`), markupDiff.normalisedA),
          writeFile(join(shotsDir, `${job.id}.b.html`), markupDiff.normalisedB)
        );

        if (markupDiff.patch) {
          files.patch = `shots/${job.id}.patch`;
          writes.push(writeFile(join(shotsDir, `${job.id}.patch`), markupDiff.patch));
        }
      }

      await Promise.all(writes);

      // With rows matched up, result.ratio is already the comparison of
      // corresponding rows: a page that only moved does not fail on the move.
      const pixelsExceeded = result.ratio > job.scenario.threshold;
      const markupExceeded = config.markup.failOnDifference && markup !== null && !markup.identical;
      const logsExceeded = config.logs.failOnDifference && logs !== null && logs.seriousOnOneSide > 0;

      const comparison: Comparison = {
        id: job.id,
        scenario: job.scenario.name,
        group: job.scenario.group,
        viewport: job.viewport,
        urlA: shotA.url,
        urlB: shotB.url,
        status: pixelsExceeded || markupExceeded || logsExceeded ? 'fail' : 'pass',
        threshold: job.scenario.threshold,
        diff: result,
        markup,
        markupHunks: hunks,
        logs,
        kinds: [],
        files,
        capture,
        command,
        ranAt: new Date().toISOString(),
        error: null,
        durationMs: Date.now() - started,
      };

      return comparison;
    } catch (error) {
      lastError = error as Error;
    }
  }

  return {
    id: job.id,
    scenario: job.scenario.name,
    group: job.scenario.group,
    viewport: job.viewport,
    urlA: '',
    urlB: '',
    status: 'error',
    threshold: job.scenario.threshold,
    diff: null,
    markup: null,
    markupHunks: null,
    logs: null,
    kinds: [],
    files: { a: null, b: null, diff: null, htmlA: null, htmlB: null, patch: null, result: null },
    capture,
    command,
    ranAt: new Date().toISOString(),
    error: lastError?.message ?? 'Unknown error',
    durationMs: Date.now() - started,
  };
}

function skipped(job: Job, config: Config): Comparison {
  return {
    command: '',
    ranAt: new Date().toISOString(),
    id: job.id,
    scenario: job.scenario.name,
    group: job.scenario.group,
    viewport: job.viewport,
    urlA: config.a.baseUrl,
    urlB: config.b.baseUrl,
    status: 'skipped',
    threshold: job.scenario.threshold,
    diff: null,
    markup: null,
    markupHunks: null,
    logs: null,
    kinds: [],
    files: { a: null, b: null, diff: null, htmlA: null, htmlB: null, patch: null, result: null },
    capture: null,
    error: null,
    durationMs: 0,
  };
}
