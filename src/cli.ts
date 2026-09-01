import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BrowserError } from './capture.js';
import { formatBytes, zipDirectory } from './artifact.js';
import { classifyRun } from './classify.js';
import { ConfigError, DEFAULT_OUT_DIR, loadConfig, parseSides, slug } from './config.js';
import { explorePage, renderExploration } from './explore.js';
import { EXAMPLE_CONFIG } from './example.js';
import { Progress } from './progress.js';
import { renderReport } from './report/index.js';
import { INDEX_FILE, POOL_DIR, caseFile, forDelivery, readCase, withDetail } from './report/pool.js';
import type { CaseDetail } from './report/pool.js';
import { SCHEMA_FILENAME, SCHEMA_URL, schemaJson } from './schema.js';
import { run } from './runner.js';
import { PREFERRED_PORT, serveReport } from './serve.js';
import { ReuseError } from './reuse.js';
import {
  MARK,
  bar,
  columns,
  formatAge,
  formatDuration,
  pad,
  padLeft,
  paint,
  percent,
  rule,
  shortPath,
  truncate,
} from './ui.js';
import { VERSION } from './manifest.js';
import { checkForUpdate } from './update.js';
import type { Update } from './update.js';
import type { Comparison, Config, RunResult } from './types.js';

const OPTIONS = {
  out: { type: 'string' as const, short: 'o' },
  filter: { type: 'string' as const, short: 'f' },
  browser: { type: 'string' as const, short: 'b' },
  threshold: { type: 'string' as const, short: 't' },
  retries: { type: 'string' as const },
  workers: { type: 'string' as const, short: 'w' },
  group: { type: 'string' as const, short: 'g' },
  reuse: { type: 'string' as const },
  'reuse-from': { type: 'string' as const },
  refresh: { type: 'string' as const },
  case: { type: 'string' as const },
  unfinished: { type: 'boolean' as const },
  into: { type: 'string' as const },
  'run-id': { type: 'string' as const },
  viewport: { type: 'string' as const },
  'compare-with': { type: 'string' as const },
  insecure: { type: 'boolean' as const },
  'no-run-folder': { type: 'boolean' as const },
  'comparison-timeout': { type: 'string' as const },
  'run-timeout': { type: 'string' as const },
  headed: { type: 'boolean' as const },
  'self-contained': { type: 'boolean' as const },
  zip: { type: 'string' as const },
  junit: { type: 'string' as const },
  'no-fail': { type: 'boolean' as const },
  port: { type: 'string' as const },
  host: { type: 'string' as const },
  quiet: { type: 'boolean' as const, short: 'q' },
  'no-progress': { type: 'boolean' as const },
  help: { type: 'boolean' as const, short: 'h' },
  version: { type: 'boolean' as const, short: 'v' },
};

/**
 * Grouped by what someone is trying to do, not by flag name: the options for
 * running a comparison and the options for looking at a page are different
 * jobs, and an alphabetical list hides that.
 */
function help(): string {
  const title = (text: string) => paint('grey', text);
  const flag = (name: string, text: string) => `  ${pad(name, 30)}${paint('grey', text)}\n`;

  return (
    `\n  ${paint('bold', 'diffyard')} ${paint('grey', VERSION)}  ${paint('grey', 'compare two URLs and report what changed')}\n\n` +
    `${title('  Usage')}\n` +
    `  diffyard run <config.yaml> ${paint('grey', '[options]')}\n` +
    `  diffyard explore <url> ${paint('grey', '[options]')}\n` +
    `  diffyard init ${paint('grey', '[config.yaml]')}\n` +
    `  diffyard schema ${paint('grey', '[file.json]')}\n` +
    `  diffyard serve ${paint('grey', '[run, output dir or config.yaml]')}\n\n` +
    `${title('  Running a comparison')}\n` +
    flag('  -o, --out <dir>', 'where the run folder goes') +
    flag('  -f, --filter <text>', 'only scenarios whose group/name contains this') +
    flag('  -g, --group <name>', 'only this group, matched exactly') +
    flag('      --case <id>', 'one comparison exactly, by its id; comma-separated for several') +
    flag('      --unfinished', 'only the comparisons that came back with nothing, from the report named by --into') +
    flag('      --into <run>', 'write the result back into that run, replacing its entries') +
    flag('  -b, --browser <name>', 'chromium | firefox | webkit') +
    flag('      --reuse <side>', "take a side from an earlier run: a, b or a,b") +
    flag('      --reuse-from <run>', 'which run to take it from, default the latest') +
    flag('      --refresh <side>', 'capture this side even though the config reuses it') +
    flag('  -t, --threshold <n>', 'share of differing pixels allowed, 0..1') +
    flag('      --run-id <name>', "this run's folder name, default a timestamp") +
    flag('      --no-run-folder', 'write straight into --out') +
    flag('  -w, --workers <n>', 'comparisons at once, default 1') +
    flag('      --retries <n>', 'retry a failed capture') +
    flag('      --headed', 'show the browser window') +
    `\n${title('  Limits')}\n` +
    flag('      --comparison-timeout <ms>', 'per comparison, default 180000') +
    flag('      --run-timeout <ms>', 'for the whole run') +
    `\n${title('  Looking at a page')}\n` +
    flag('      --viewport <WxH>', 'size to inspect at, default 1440x900') +
    flag('      --compare-with <url>', 'the other side, for the config draft') +
    flag('      --insecure', 'accept self-signed certificates') +
    `\n${title('  Serving a report')}\n` +
    flag('      --port <n>', 'default 4173, or the next one free; a port you name is used as given') +
    flag('      --host <address>', 'default 127.0.0.1; 0.0.0.0 to reach it from another device') +
    `\n${title('  Output')}\n` +
    flag('      --self-contained', 'also write report.html with images inlined') +
    flag('      --zip <file>', 'also pack the run folder into an archive') +
    flag('      --junit <file>', 'also write JUnit XML') +
    flag('      --no-fail', 'always exit 0') +
    flag('  -q, --quiet', 'only the summary') +
    flag('      --no-progress', 'no live progress line') +
    `\n${title('  Exit codes')}\n` +
    `  ${paint('green', '0')}  ${paint('grey', 'nothing differs beyond its threshold')}\n` +
    `  ${paint('red', '1')}  ${paint('grey', 'at least one comparison differs')}\n` +
    `  ${paint('yellow', '2')}  ${paint('grey', 'a capture errored, or the config is invalid')}\n`
  );
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${help()}`);
    return 2;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(help());
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const [first, second] = positionals;

  if (first === 'init') {
    return await initConfig(second ?? 'diffyard.config.yaml');
  }

  if (first === 'schema') {
    return await writeSchema(second ?? SCHEMA_FILENAME);
  }

  if (first === 'serve') {
    return await serveCommand(second, values);
  }

  if (first === 'explore') {
    if (!second) {
      process.stderr.write(`Missing URL.\n\n${help()}`);
      return 2;
    }
    return await exploreCommand(second, values);
  }

  const configFile = first === 'run' ? second : first;
  if (!configFile) {
    process.stderr.write(`Missing config file.\n\n${help()}`);
    return 2;
  }

  return await runCommand(configFile, values);
}

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

async function runCommand(configFile: string, values: Values): Promise<number> {
  let config: Config;
  try {
    config = await applyOverrides(loadConfig(configFile), values);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n  ${MARK.error()} ${paint('bold', 'Configuration')}\n  ${error.message.split('\n').join('\n  ')}\n\n`);
      return 2;
    }
    throw error;
  }

  if (config.scenarios.length === 0) {
    process.stderr.write(`\n  ${MARK.error()} No scenario matches that filter.\n\n`);
    return 2;
  }

  const quiet = values.quiet === true;
  const write = (text: string) => {
    if (!quiet) process.stdout.write(text);
  };

  // Started here and read at the end: a lookup that overlaps the run is one
  // nobody waits for.
  const update = checkForUpdate();

  write(header(config));

  const progress = new Progress({
    stream: process.stdout,
    interactive: process.stdout.isTTY === true && values['no-progress'] !== true && !quiet,
    labelA: config.a.label,
    labelB: config.b.label,
    workers: config.workers,
  });

  // Bars are drawn against the worst comparison seen so far, which is the
  // only scale available while the run is still going.
  let scale = 0.01;
  const size = layout(config, config.scenarios.reduce((sum, s) => sum + s.viewports.length, 0));
  const width = tableWidth(size);

  /**
   * Ctrl+C, twice over.
   *
   * Once: stop taking new comparisons, let the ones under way finish, and
   * write the report with what there is. Twenty minutes of captures should
   * not be thrown away because the answer arrived early, and the ones never
   * reached are named in the report so `--unfinished` carries on from there.
   *
   * Twice: go now. The cursor is put back by hand, because the progress block
   * hid it and nothing else will run to say otherwise.
   */
  const stopping = new AbortController();
  let asked = false;
  /** Chunks already on disk, so a snapshot writes only what is new. */
  const laid = new Set<string>();

  const interrupt = () => {
    if (asked) {
      // stop() puts the cursor back, which the progress block hid and nothing
      // else would run to undo.
      progress.stop();
      process.stdout.write('\n');
      process.exit(130);
    }

    asked = true;
    stopping.abort();
    progress.note(
      paint('grey', 'Stopping — finishing what is under way. Ctrl+C again to go now.')
    );
  };

  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);

  let result;
  try {
    result = await run(config, {
      signal: stopping.signal,
      /**
       * The report, while the run is still filling it in.
       *
       * The page is written once and never changes; what grows is the data
       * beside it. So a snapshot is the shell plus whatever the pool holds so
       * far, and pressing refresh is all it takes to see where the run has
       * got to.
       */
      onSnapshot: async (snapshot) => {
        const report = await renderReport(snapshot, config, { selfContained: false });
        await mkdir(snapshot.outDir, { recursive: true });
        await writeFile(join(snapshot.outDir, 'index.html'), report.html);

        // The index every time, because that is what grew. A comparison's own
        // chunk only once: it is written when the comparison lands and does
        // not change after, and there are nine hundred of them.
        for (const [name, body] of report.files) {
          if (name !== INDEX_FILE && laid.has(name)) continue;
          const path = join(snapshot.outDir, name);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, body);
          laid.add(name);
        }
      },
      onStart: (total, info) => {
        const facts = [
          `${total} comparison${total === 1 ? '' : 's'}`,
          config.browser + (config.headless ? '' : ' headed'),
          config.workers > 1 ? `${config.workers} workers` : null,
          `run ${info.runId}`,
        ]
          .filter(Boolean)
          .join(paint('grey', ' · '));

        write(`  ${rule(width)}\n  ${paint('grey', facts)}\n`);
        write(reuseNotice(config, info.reuse));
        write('\n');
        if (!quiet) progress.start(total);
      },
      onProgress: (state) => {
        if (!quiet) progress.update(state);
      },
      onComparisonDone: (comparison, index, total) => {
        if (quiet) return;
        scale = Math.max(scale, comparison.diff ? comparison.diff.ratio : 0);
        progress.complete(line(comparison, index, total, scale, size), comparison);
      },
    });
  } catch (error) {
    if (error instanceof ReuseError) {
      progress.stop();
      process.stderr.write(
        `\n  ${MARK.error()} ${paint('bold', 'Nothing to reuse')}\n  ${error.message.split('\n').join('\n  ')}\n\n`
      );
      return 2;
    }
    if (error instanceof BrowserError) {
      progress.stop();
      process.stderr.write(
        `\n  ${MARK.error()} ${paint('bold', 'No browser')}\n  ${error.message.split('\n').join('\n  ')}\n\n`
      );
      return 2;
    }
    throw error;
  } finally {
    progress.stop();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }

  // A partial run joins the report it was read from rather than replacing it.
  // --into says so by naming the folder; --unfinished says so by having taken its
  // list out of what is already there.
  const partial = typeof values.into === 'string' || values.unfinished === true;
  const merged = partial ? await mergeInto(result) : result;
  const artifact = await writeArtifact(merged, config, values);

  write(summary(result, artifact, width, merged));
  write(updateNotice(await update));

  // A run that was stopped has an answer for the part it got through, and the
  // report says which part that was. What it does not have is a verdict on the
  // suite, so it does not give one -- 130 is what a shell expects of a Ctrl+C.
  if (asked) {
    write(
      `  ${paint('grey', 'Stopped. What was not reached is in the report; ' +
        'carry on with')} ${paint('bold', '--unfinished')}\n\n`
    );
    return 130;
  }

  if (values['no-fail'] === true) return 0;
  if (result.errored > 0) return 2;
  return result.failed > 0 ? 1 : 0;
}

/**
 * Folds a run of a few comparisons back into the report it came from.
 *
 * Working through a list of findings means fixing one thing and looking at one
 * view again, and a fresh report holding that single view would lose the list
 * being worked through.
 *
 * The original run keeps describing itself -- startedAt, finishedAt and
 * durationMs are left alone -- so a comparison that ran later can be told
 * apart by its own `ranAt`, and the report says which ones those are.
 */
async function mergeInto(result: RunResult): Promise<RunResult> {
  let previous: RunResult;
  try {
    previous = JSON.parse(await readFile(join(result.outDir, 'results.json'), 'utf8')) as RunResult;
  } catch {
    // Nothing there yet: --into named a run that does not exist, which is
    // simply this run creating it.
    return result;
  }

  // results.json no longer carries the hunks, so a comparison this run did not
  // touch arrives without them. Both what happens next need them: the kinds are
  // decided from them, and the chunks are written again from them -- a merge
  // that skipped this would classify old findings as having no markup change
  // and then overwrite their chunks with nothing.
  const held = new Map<string, CaseDetail>();
  await Promise.all(
    previous.comparisons.map(async (entry) => {
      const detail = await readCase(result.outDir, entry.id);
      if (detail) held.set(entry.id, detail);
    })
  );
  const restored = withDetail(previous, held);

  const fresh = new Map(result.comparisons.map((entry) => [entry.id, entry]));
  const comparisons = restored.comparisons.map((entry) => fresh.get(entry.id) ?? entry);

  for (const [id, entry] of fresh) {
    if (!restored.comparisons.some((old) => old.id === id)) comparisons.push(entry);
  }

  // The kinds are decided against the whole population, and one comparison on
  // its own is not one. Judged again against the report it is joining.
  const common = classifyRun(comparisons);

  const count = (status: Comparison['status']) =>
    comparisons.filter((entry) => entry.status === status).length;

  return {
    ...previous,
    refreshedAt: result.finishedAt,
    commonMarkup: common,
    comparisons,
    total: comparisons.length,
    passed: count('pass'),
    failed: count('fail'),
    errored: comparisons.filter((entry) => entry.status === 'error' || entry.status === 'timeout').length,
    skipped: count('skipped'),
    reuse: result.reuse ?? previous.reuse,
  };
}

/**
 * Clears what the report no longer refers to.
 *
 * A run folder is written into again -- a fixed `output.runId`, or `--into` --
 * and until every file kept the same name that took care of itself: each write
 * landed on its predecessor. It stopped being true when a comparison could be
 * stored as `.a.webp` where it used to be `.a.png`, and the old picture simply
 * stayed, a stale copy of a page nothing points at.
 *
 * The rule is the report's own: every comparison names its files, so a file
 * under shots/ or data/ that no comparison names is not part of this report.
 * That covers a picture whose format changed, a scenario dropped from the
 * config, and a comparison that errored where it used to succeed -- all of
 * which would otherwise sit there looking current.
 *
 * A merge keeps the entries it did not re-run, so their files are named and
 * stay; nothing here needs to know whether the run was a full one.
 */
async function pruneStale(runDir: string, result: RunResult): Promise<void> {
  const named = new Set<string>([INDEX_FILE]);
  for (const comparison of result.comparisons) {
    for (const file of Object.values(comparison.files)) if (file) named.add(file);
    // The pool writes one of these per comparison whatever the comparison's
    // own record says; one read back from an older report says nothing.
    named.add(caseFile(comparison.id));
  }

  for (const dir of ['shots', POOL_DIR]) {
    let entries: string[];
    try {
      entries = await readdir(join(runDir, dir));
    } catch {
      continue;
    }

    await Promise.all(
      entries
        .map((name) => `${dir}/${name}`)
        .filter((name) => !named.has(name))
        .map((name) => rm(join(runDir, name), { force: true, recursive: true }))
    );
  }
}

/**
 * Writes the artifact: a self-contained directory plus, unless disabled, a
 * single archive the caller can store.
 */
async function writeArtifact(result: RunResult, config: Config, values: Values): Promise<[string, string][]> {
  const written: [string, string][] = [];
  const runDir = result.outDir;
  await mkdir(runDir, { recursive: true });

  const report = await renderReport(result, config, { selfContained: false });

  const indexPath = join(runDir, 'index.html');
  await writeFile(indexPath, report.html);
  written.push(['HTML report', shortPath(indexPath)]);

  // The run itself, in the shape the report reads it: an index for the
  // overview, a chunk per comparison for what only its detail view draws.
  for (const [name, body] of report.files) {
    const path = join(runDir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  if (report.files.length > 0) written.push(['Report data', shortPath(join(runDir, POOL_DIR))]);

  // Without the hunks: they are in the pool for the report and in the .patch
  // for anyone reading, and a third copy of a hundred and forty megabytes is
  // no more machine readable than the first one.
  const resultsPath = join(runDir, 'results.json');
  await writeFile(resultsPath, `${JSON.stringify(forDelivery(result).index, null, 2)}\n`);
  written.push(['JSON results', shortPath(resultsPath)]);

  if (values['self-contained'] === true) {
    const bundlePath = join(runDir, 'report.html');
    await writeFile(bundlePath, (await renderReport(result, config, { selfContained: true })).html);
    written.push(['Single file', bundlePath]);
  }

  // Last, so a run that fails halfway has not cleared what it cannot replace.
  await pruneStale(runDir, result);

  if (typeof values.junit === 'string') {
    const junitPath = resolve(values.junit);
    await mkdir(dirname(junitPath), { recursive: true });
    await writeFile(junitPath, junitXml(result));
    written.push(['JUnit XML', junitPath]);
  }

  written.push(['Screenshots', shortPath(join(runDir, 'shots'))]);

  if (typeof values.zip === 'string') {
    const zipPath = resolve(values.zip);
    await mkdir(dirname(zipPath), { recursive: true });
    const size = await zipDirectory(runDir, zipPath, basename(runDir));
    written.push(['Archive', `${zipPath} (${formatBytes(size)})`]);
  }

  return written;
}

/**
 * The scenarios behind a list of comparison ids.
 *
 * `only` elsewhere in the config would otherwise silence the very case that
 * was asked for by name.
 */
function pickByIds(scenarios: Config['scenarios'], wanted: string[]): Config['scenarios'] {
  const picked: Config['scenarios'] = [];

  for (const scenario of scenarios) {
    const base = `${scenario.group ? `${slug(scenario.group)}--` : ''}${slug(scenario.name)}`;
    const viewports = scenario.viewports.filter((viewport) =>
      wanted.includes(`${base}--${slug(viewport.name)}`)
    );
    if (viewports.length > 0) picked.push({ ...scenario, viewports, only: false });
  }

  return picked;
}

async function applyOverrides(config: Config, values: Values): Promise<Config> {
  const next: Config = { ...config };

  if (typeof values.out === 'string') next.outDir = resolve(values.out);
  if (values.headed === true) next.headless = false;

  if (typeof values.browser === 'string') {
    if (!['chromium', 'firefox', 'webkit'].includes(values.browser)) {
      throw new ConfigError('--browser must be chromium, firefox or webkit');
    }
    next.browser = values.browser as Config['browser'];
  }

  if (typeof values.threshold === 'string') {
    const threshold = Number(values.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new ConfigError('--threshold must be a number between 0 and 1');
    }
    next.threshold = threshold;
    next.scenarios = next.scenarios.map((scenario) => ({ ...scenario, threshold }));
  }

  if (typeof values['run-id'] === 'string') next.runId = values['run-id'];
  if (values['no-run-folder'] === true) next.runFolder = false;

  for (const [flag, field] of [
    ['comparison-timeout', 'comparisonTimeout'],
    ['run-timeout', 'runTimeout'],
  ] as const) {
    const raw = values[flag];
    if (typeof raw !== 'string') continue;
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms < 0) {
      throw new ConfigError(`--${flag} must be a non-negative number of milliseconds`);
    }
    next[field] = ms;
  }

  if (typeof values.workers === 'string') {
    const workers = Number(values.workers);
    if (!Number.isInteger(workers) || workers < 1) {
      throw new ConfigError('--workers must be a whole number of 1 or more');
    }
    next.workers = workers;
  }

  if (typeof values.retries === 'string') {
    const retries = Number(values.retries);
    if (!Number.isInteger(retries) || retries < 0) {
      throw new ConfigError('--retries must be a non-negative integer');
    }
    next.retries = retries;
  }

  if (typeof values.reuse === 'string') {
    next.reuse = { ...next.reuse, sides: parseSides(values.reuse, '--reuse') };
  }

  if (typeof values['reuse-from'] === 'string') {
    next.reuse = { ...next.reuse, from: values['reuse-from'] };
  }

  if (typeof values.refresh === 'string') {
    // Fetching one side once, against a config that otherwise reuses it: the
    // way back to a fresh reference has to be a flag, not an edit.
    const fresh = parseSides(values.refresh, '--refresh');
    next.reuse = { ...next.reuse, sides: next.reuse.sides.filter((side) => !fresh.includes(side)) };
  }

  if (typeof values.case === 'string') {
    // Exact and including the viewport, because this is what the report hands
    // you to paste: it has to mean this one view and nothing near it.
    const wanted = values.case
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);

    const picked = pickByIds(next.scenarios, wanted);

    if (picked.length === 0) {
      throw new ConfigError(
        `No comparison called "${values.case}".\n` +
          'The id is the one in the report and in the screenshot filenames, ' +
          'e.g. shop--checkout--desktop.'
      );
    }

    next.scenarios = picked;
  }

  if (typeof values.into === 'string') {
    // The run writes into that folder, and the artifact is merged rather than
    // replaced, so refreshing one view leaves the other findings standing.
    next.runId = values.into;
    next.runFolder = true;
  }

  if (values.unfinished === true) {
    // The comparisons that came back with nothing, read out of the report
    // rather than typed. Twenty ids is six hundred characters of command
    // line, and the set is different every time it is worked through -- so
    // the line that does it has to name the report, not the cases.
    //
    // After --into, because that is one of the two ways the report is named;
    // the other is a config that fixes output.runId, which a suite usually
    // does.
    if (!next.runId) {
      throw new ConfigError(
        '--unfinished has to be told which report to read.\n' +
          'Name it with --into, or set output.runId so the suite has a folder of its own.'
      );
    }

    const dir = join(next.outDir, next.runId);
    let previous: RunResult;
    try {
      previous = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8')) as RunResult;
    } catch {
      throw new ConfigError(`--unfinished found no report to read in ${shortPath(dir)}.`);
    }

    const broken = previous.comparisons.filter(
      (entry) => entry.status === 'error' || entry.status === 'timeout'
    );

    if (broken.length === 0) {
      throw new ConfigError(
        `Nothing to retry: every comparison in ${shortPath(dir)} came back with a result.`
      );
    }

    next.scenarios = pickByIds(next.scenarios, broken.map((entry) => entry.id.toLowerCase()));
    next.runFolder = true;

    if (next.scenarios.length === 0) {
      throw new ConfigError(
        `The ${broken.length} comparison${broken.length === 1 ? '' : 's'} that came back with nothing ` +
          'are not in this config any more.'
      );
    }
  }

  if (typeof values.group === 'string') {
    // Exact, because "only this site" is the common ask and a substring of a
    // group name pulls in the sub-pages of another one.
    const wanted = values.group.toLowerCase();
    next.scenarios = next.scenarios.filter((scenario) => (scenario.group ?? '').toLowerCase() === wanted);

    if (next.scenarios.length === 0) {
      const known = [...new Set(config.scenarios.map((scenario) => scenario.group).filter(Boolean))];
      throw new ConfigError(
        `No group called "${values.group}". Known: ${known.length > 0 ? known.join(', ') : '(none)'}`
      );
    }
  }

  if (typeof values.filter === 'string') {
    // Matched against the qualified name, so --filter t3init19 finds the group
    // as well as a scenario that happens to be called that.
    const needle = values.filter.toLowerCase();
    next.scenarios = next.scenarios.filter((scenario) =>
      `${scenario.group ? `${scenario.group}/` : ''}${scenario.name}`.toLowerCase().includes(needle)
    );
  }

  return next;
}

async function initConfig(file: string): Promise<number> {
  const path = resolve(file);
  try {
    await writeFile(path, EXAMPLE_CONFIG, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      process.stderr.write(`\n  ${MARK.error()} ${shortPath(path)} already exists.\n\n`);
      return 2;
    }
    throw error;
  }

  // The config's first line points at the schema, so write it alongside.
  const schemaPath = join(dirname(path), SCHEMA_FILENAME);
  await writeFile(schemaPath, schemaJson());

  process.stdout.write(
    `\n  ${MARK.pass()} ${shortPath(path)}\n` +
      `  ${MARK.pass()} ${shortPath(schemaPath)} ${paint('grey', '— your editor validates against this')}\n\n` +
      `  ${paint('grey', 'Put in the two URLs and the pages to compare, then run')}\n` +
      `  diffyard run ${file}\n\n`
  );
  return 0;
}

/**
 * Inspects a page and prints what a config would need to know about it.
 *
 * Writing a config for an unfamiliar site means finding the same handful of
 * things every time — the consent button, the menu toggle, the pages worth
 * comparing, whatever moves on its own. This does that pass and drafts a
 * config from it.
 */
async function exploreCommand(url: string, values: Values): Promise<number> {
  const update = checkForUpdate();
  let viewport = { width: 1440, height: 900 };

  if (typeof values.viewport === 'string') {
    const match = /^(\d+)x(\d+)$/.exec(values.viewport);
    if (!match) {
      process.stderr.write('--viewport must look like 375x812\n');
      return 2;
    }
    viewport = { width: Number(match[1]), height: Number(match[2]) };
  }

  try {
    const report = await explorePage(url, {
      browser: 'chromium',
      viewport,
      ignoreHTTPSErrors: values.insecure === true,
      timeout: 30_000,
      acceptConsent: [],
    });

    const compareWith = typeof values['compare-with'] === 'string' ? values['compare-with'] : undefined;
    process.stdout.write(`${renderExploration(report, url, compareWith, values.insecure === true)}\n`);
    process.stdout.write(updateNotice(await update));
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
}

/** Writes the JSON schema, so an editor can validate and complete the config. */
/**
 * Serves a report, and stays there until it is stopped.
 *
 * The report opens from a file:// URL perfectly well; what that cannot do is
 * be opened from the phone on the desk or from a machine that did not do the
 * run. Localhost unless asked otherwise: the pages in it are from systems that
 * are not public, taken with credentials that are not public.
 */
/**
 * What to serve, from what little was said.
 *
 * A run folder, the folder that holds the runs, or the config that says where
 * they go -- because `output.dir` is a project's own convention (`var/`,
 * `build/`, somewhere under a cache) and typing it again is the kind of thing
 * a tool should read rather than ask for. With nothing said at all, the config
 * lying in the working directory answers, and failing that the default.
 */
function whatToServe(given: string | undefined): { path: string; from: string | null } {
  if (given !== undefined) {
    return /\.ya?ml$/i.test(given)
      ? { path: loadConfig(given).outDir, from: given }
      : { path: resolve(given), from: null };
  }

  for (const name of ['diffyard.yaml', 'diffyard.config.yaml']) {
    if (!existsSync(resolve(name))) continue;
    try {
      return { path: loadConfig(name).outDir, from: name };
    } catch {
      // A config that does not load says nothing about where runs go; the
      // default below is a better answer than an error about YAML.
    }
  }

  return { path: resolve(DEFAULT_OUT_DIR), from: null };
}

async function serveCommand(given: string | undefined, values: Values): Promise<number> {
  // A port somebody typed is a requirement; the default is a preference, and
  // the next free one will do.
  const asked = typeof values.port === 'string';
  const port = asked ? Number(values.port) : PREFERRED_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`\n  ${MARK.error()} --port takes a number from 0 to 65535\n\n`);
    return 2;
  }

  let where;
  try {
    where = whatToServe(given);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n  ${MARK.error()} ${paint('bold', 'Configuration')}\n  ${error.message}\n\n`);
      return 2;
    }
    throw error;
  }

  const path = where.path;
  try {
    await readdir(path);
  } catch {
    const because = where.from ? ` ${paint('grey', `(from ${where.from})`)}` : '';
    process.stderr.write(
      `\n  ${MARK.error()} ${paint('bold', 'Nothing to serve')}\n` +
        `  ${shortPath(path)}${because} is not a directory. Has anything run yet?\n\n`
    );
    return 2;
  }

  let serving;
  try {
    serving = await serveReport(path, {
      port,
      strict: asked,
      ...(typeof values.host === 'string' ? { host: values.host } : {}),
    });
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? `Port ${port} is taken. Try --port 0 for whichever is free.`
      : (error as Error).message;
    process.stderr.write(`\n  ${MARK.error()} ${paint('bold', 'Cannot serve')}\n  ${message}\n\n`);
    return 2;
  }

  const moved = serving.port !== port ? ` ${paint('grey', `(${port} was taken)`)}` : '';
  process.stdout.write(
    `\n  ${MARK.pass()} ${paint('bold', serving.url)}${moved}\n` +
      `  ${paint('grey', `serving ${shortPath(path)}${where.from ? ` — where ${where.from} puts its runs` : ''}`)}\n` +
      `  ${paint('grey', 'Ctrl+C to stop')}\n\n`
  );

  await new Promise<void>((stopped) => {
    const done = () => {
      void serving.close().then(() => stopped());
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });

  process.stdout.write(`  ${paint('grey', 'Stopped.')}\n`);
  return 0;
}

async function writeSchema(file: string): Promise<number> {
  const path = resolve(file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, schemaJson());

  process.stdout.write(
    `\n  ${MARK.pass()} ${shortPath(path)}\n\n` +
      `  ${paint('grey', 'Reference it from the first line of your config:')}\n` +
      `  # yaml-language-server: $schema=./${basename(path)}\n\n` +
      `  ${paint('grey', 'Or point at it without keeping a copy, which never goes stale:')}\n` +
      `  ${paint('grey', `# yaml-language-server: $schema=${SCHEMA_URL}`)}\n\n`
  );
  return 0;
}

/** Which side is which, and where each one points. */
/**
 * Which side was not photographed for this run.
 *
 * It must never be unclear whether a number was measured against a fresh
 * reference or a kept one, so this sits in the head of the run, next to the
 * facts that decide how the numbers should be read.
 */
function reuseNotice(config: Config, source: { runId: string; capturedAt: string; ageMs: number } | null): string {
  if (!source) return '';

  const sides = config.reuse.sides.map((side) => side.toUpperCase()).join(' and ');
  const line =
    `  ${paint('grey', `reusing ${sides} from run ${source.runId} · captured ${formatAge(source.ageMs)}`)}\n`;

  if (config.reuse.maxAge > 0 && source.ageMs > config.reuse.maxAge) {
    return (
      line +
      `  ${MARK.error()} ${paint('yellow', `those shots are ${formatAge(source.ageMs).replace(' ago', ' old')}`)}` +
      ` ${paint('grey', '— run with --refresh ' + config.reuse.sides.join(',') + ' to take them again')}\n`
    );
  }

  return line;
}

function header(config: Config): string {
  const labelA = config.a.label === 'A' ? '' : config.a.label;
  const labelB = config.b.label === 'B' ? '' : config.b.label;
  const width = Math.max(labelA.length, labelB.length);

  const side = (letter: string, label: string, url: string) =>
    `  ${paint('bold', letter)}  ${width > 0 ? pad(label, width + 2) : ''}${paint('grey', url || '(per scenario)')}\n`;

  return (
    `\n  ${paint('bold', 'diffyard')} ${paint('grey', VERSION)}\n\n` +
    side('A', labelA, config.a.baseUrl) +
    side('B', labelB, config.b.baseUrl)
  );
}

interface Layout {
  counter: number;
  group: number;
  name: number;
  viewport: number;
}

/**
 * Widths the result lines share, so they read as a table.
 *
 * Taken from the names that will be printed and then capped to the terminal,
 * rather than spread across whatever width is available.
 */
function layout(config: Config, total: number): Layout {
  const counter = String(total).length * 2 + 3;
  const longestName = Math.max(...config.scenarios.map((scenario) => scenario.name.length), 8);
  const longestViewport = Math.max(...config.viewports.map((viewport) => viewport.name.length), 6);

  // Two sites can both have a page called index; without the group they read
  // as the same row twice.
  const groups = config.scenarios.map((scenario) => scenario.group).filter(Boolean) as string[];
  const longestGroup = groups.length > 0 ? Math.max(...groups.map((name) => name.length)) : 0;

  // 26 columns cover the mark, the value, the bar and the gaps between them.
  const room = columns() - counter - 26 - longestViewport - (longestGroup ? longestGroup + 1 : 0);

  return {
    counter,
    group: longestGroup > 0 ? Math.min(longestGroup, 18) : 0,
    name: Math.max(12, Math.min(longestName, Math.max(12, room))),
    viewport: longestViewport,
  };
}

/**
 * What is worth adding beside the number.
 *
 * A page that moved is the common case and used to swamp the percentage; now
 * that it does not, saying by how much is the useful part.
 */
function describeShift(comparison: Comparison): string {
  const shift = comparison.diff?.aligned?.shift ?? 0;
  if (shift !== 0) {
    return paint('grey', `  ${shift > 0 ? '+' : ''}${shift}px`);
  }
  return comparison.diff?.sizeMismatch ? paint('grey', '  size differs') : '';
}

/** Visible width of a result line, so rules line up with the table. */
function tableWidth(size: Layout): number {
  const mark = 2;
  const value = 7;
  const bar = 10;
  const group = size.group > 0 ? size.group + 1 : 0;
  return mark + size.counter + group + size.name + 1 + size.viewport + 1 + value + 2 + bar;
}

function line(comparison: Comparison, index: number, total: number, scale: number, size: Layout): string {
  const counter = paint('grey', pad(`${index + 1}/${total}`, size.counter));
  const group =
    size.group > 0
      ? `${paint('grey', pad(truncate(comparison.group ?? '', size.group), size.group))} `
      : '';
  const name = pad(truncate(comparison.scenario, size.name), size.name);
  const viewport = paint('grey', pad(truncate(comparison.viewport.name, size.viewport), size.viewport));

  if (comparison.status === 'skipped') {
    return `  ${MARK.skip()} ${counter}${group}${name} ${viewport} ${paint('grey', 'skipped')}`;
  }

  if (comparison.status === 'error' || comparison.status === 'timeout') {
    const what = comparison.status === 'timeout' ? 'timed out' : 'failed to capture';
    return `  ${MARK.error()} ${counter}${group}${name} ${viewport} ${paint('yellow', what)}`;
  }

  const ratio = comparison.diff ? comparison.diff.ratio : 0;
  const mark = comparison.status === 'pass' ? MARK.pass() : MARK.fail();
  const value = padLeft(percent(ratio), 7);
  const note = describeShift(comparison);

  return `  ${mark} ${counter}${group}${name} ${viewport} ${value}  ${bar(ratio, scale, 10)}${note}`;
}

/**
 * What the run came to, then where to look.
 *
 * The worst few comparisons are named outright: on a suite of twenty, the
 * question after a run is which one to open, and scrolling back through the
 * lines to find the largest number is work the tool can do.
 */
function summary(
  result: RunResult,
  artifact: [string, string][],
  width: number,
  written: RunResult = result
): string {
  const parts: string[] = [
    result.failed > 0
      ? `${MARK.fail()} ${result.failed} differ`
      : `${MARK.pass()} nothing differs`,
  ];

  if (result.passed > 0) parts.push(`${MARK.pass()} ${result.passed} unchanged`);
  if (result.errored > 0) parts.push(`${MARK.error()} ${result.errored} errored`);
  if (result.skipped > 0) parts.push(`${MARK.skip()} ${result.skipped} skipped`);

  const verdict = parts.join(paint('grey', '   '));
  const timing = paint('grey', formatDuration(result.durationMs));
  const spacing = Math.max(1, width - visibleLength(verdict) - visibleLength(timing));

  const lines = [`\n  ${rule(width)}\n  ${verdict}${' '.repeat(spacing)}${timing}\n`];

  const worst = result.comparisons
    .filter((entry) => entry.status === 'fail' && entry.diff)
    .sort((left, right) => (right.diff?.ratio ?? 0) - (left.diff?.ratio ?? 0))
    .slice(0, 3);

  if (worst.length > 1) {
    lines.push(`\n  ${paint('grey', 'Largest differences')}\n`);
    for (const entry of worst) {
      const where = entry.group ? `${paint('grey', `${entry.group}/`)}${entry.scenario}` : entry.scenario;
      lines.push(
        `    ${padLeft(percent(entry.diff?.ratio ?? 0), 7)}  ${where} ${paint('grey', entry.viewport.name)}\n`
      );
    }
  }

  if (result.reuse && result.reuse.reused > 0) {
    const sides = result.reuse.sides.map((side) => side.toUpperCase()).join(' and ');
    const again =
      result.reuse.recaptured > 0 ? `, ${result.reuse.recaptured} captured again` : '';
    lines.push(
      `\n  ${paint('grey', `${sides} reused for ${result.reuse.reused} of ${result.total} comparisons${again}`)}\n`
    );
  }

  // Above everything read off the pixels, because it says the pixels were not
  // an answer to the same question. Two sides with different statuses were not
  // asked the same thing, and the percentage between their pictures is
  // arithmetic on that mistake.
  const mismatched = result.comparisons.filter(
    (entry) => entry.answers && entry.answers.a.status !== entry.answers.b.status
  );

  if (mismatched.length > 0) {
    const a = result.config.labelA || 'A';
    const b = result.config.labelB || 'B';
    lines.push(`\n  ${paint('red', 'The two sides answered differently')}\n`);
    for (const entry of mismatched.slice(0, 3)) {
      const where = entry.group ? `${paint('grey', `${entry.group}/`)}${entry.scenario}` : entry.scenario;
      const said = `${a} ${entry.answers?.a.status ?? '—'} · ${b} ${entry.answers?.b.status ?? '—'}`;
      lines.push(`    ${padLeft(said, 16)}  ${where} ${paint('grey', entry.viewport.name)}\n`);
    }
    if (mismatched.length > 3) {
      lines.push(`    ${paint('grey', `and ${mismatched.length - 3} more — filter the report by "Answered differently"`)}\n`);
    }
  }

  // A page that broke on one side and not the other is worth a look whether
  // or not its pixels moved enough to fail.
  const noisy = result.comparisons
    .filter((entry) => entry.logs && entry.logs.seriousOnOneSide > 0)
    .sort((left, right) => (right.logs?.seriousOnOneSide ?? 0) - (left.logs?.seriousOnOneSide ?? 0));

  if (noisy.length > 0) {
    lines.push(`\n  ${paint('grey', 'Errors on one side only')}\n`);
    for (const entry of noisy.slice(0, 3)) {
      const where = entry.group ? `${paint('grey', `${entry.group}/`)}${entry.scenario}` : entry.scenario;
      const count = entry.logs?.seriousOnOneSide ?? 0;
      lines.push(
        `    ${padLeft(String(count), 7)}  ${where} ${paint('grey', entry.viewport.name)}\n`
      );
    }
    if (noisy.length > 3) {
      lines.push(`    ${paint('grey', `and ${noisy.length - 3} more — see the report's console view`)}\n`);
    }
  }

  if (written !== result) {
    const kept = written.total - result.total;
    lines.push(
      `\n  ${paint('grey', `merged into run ${written.runId}` + (kept > 0 ? ` beside ${kept} other comparison${kept === 1 ? '' : 's'}` : ''))}\n`
    );
  }

  /*
   * One rounding difference, said once.
   *
   * Two systems that work a picture's height out from an aspect ratio can
   * disagree by a pixel, and then every page carrying such a picture ends a
   * few rows short of the other -- which the comparison reports as rows one
   * side does not have, once per page, nine hundred times. Measured on a real
   * upgrade: 1,329 pictures of 19,229, and it accounted for nine tenths of
   * everything still being counted. Named here it is one line and a place to
   * start; left unnamed it is a hundred and eighty findings that all say the
   * same thing.
   */
  const resized = result.comparisons.reduce((sum, entry) => sum + (entry.diff?.resized ?? 0), 0);
  if (resized > 0) {
    const pages = result.comparisons.filter((entry) => (entry.diff?.resized ?? 0) > 0).length;
    const b = result.config.labelB || 'B';
    lines.push(
      `\n  ${paint('grey', `${resized} picture${resized === 1 ? '' : 's'} drawn at another height by ${b}, on ${pages} page${pages === 1 ? '' : 's'}`)}\n` +
        `    ${paint('grey', 'the page below such a picture no longer lines up, which is most of what is reported under it')}\n`
    );
  }

  if (result.commonMarkup.length > 0) {
    // Worth an ignore rule: these are the build showing through, and they sit
    // on top of every markup diff in the run.
    lines.push(
      `\n  ${paint('grey', `${result.commonMarkup.length} markup difference${result.commonMarkup.length === 1 ? '' : 's'} on nearly every page`)}\n`
    );
    for (const line of result.commonMarkup.slice(0, 3)) {
      lines.push(`    ${paint('grey', truncate(line, width - 6))}\n`);
    }
    lines.push(`    ${paint('grey', 'consider markup.ignoreAttributes or markup.ignoreSelectors')}\n`);
  }

  const report = artifact.find(([label]) => label === 'HTML report');
  if (report) lines.push(`\n  ${paint('bold', 'Report')}  ${report[1]}\n`);

  return lines.join('');
}

/**
 * That a newer diffyard exists, said as quietly as it deserves.
 *
 * Last of everything, in grey, two lines: the result of the run is what was
 * asked for, and this is a footnote under it. `DIFFYARD_NO_UPDATE_CHECK`
 * removes it, and it never appears in CI.
 */
function updateNotice(update: Update | null): string {
  if (!update) return '';

  return (
    `\n  ${paint('grey', `diffyard ${update.current} → ${update.latest} is out`)}\n` +
    `  ${paint('grey', update.command)}\n` +
    (update.notes ? `  ${paint('grey', update.notes)}\n` : '')
  );
}

function visibleLength(text: string): number {
  return [...text.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')].length;
}

function junitXml(result: RunResult): string {
  const cases = result.comparisons
    .map((comparison) => {
      const name = escapeXml(`${comparison.scenario} @ ${comparison.viewport.name}`);
      const time = (comparison.durationMs / 1000).toFixed(3);
      const open = `    <testcase classname="diffyard" name="${name}" time="${time}">`;

      if (comparison.status === 'skipped') return `${open}\n      <skipped/>\n    </testcase>`;
      if (comparison.status === 'error' || comparison.status === 'timeout') {
        return `${open}\n      <error message="${escapeXml(truncate(comparison.error ?? '', 300))}"/>\n    </testcase>`;
      }
      if (comparison.status === 'fail' && comparison.diff) {
        const message = `${(comparison.diff.ratio * 100).toFixed(2)}% of pixels differ (threshold ${(comparison.threshold * 100).toFixed(2)}%)`;
        return `${open}\n      <failure message="${escapeXml(message)}"/>\n    </testcase>`;
      }
      return `${open}</testcase>`;
    })
    .join('\n');

  const time = (result.durationMs / 1000).toFixed(3);
  const counts = `tests="${result.total}" failures="${result.failed}" errors="${result.errored}" skipped="${result.skipped}" time="${time}"`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="diffyard" ${counts}>
  <testsuite name="diffyard" ${counts}>
${cases}
  </testsuite>
</testsuites>
`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&apos;';
    }
  });
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 2;
  });
