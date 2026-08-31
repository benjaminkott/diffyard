/**
 * Taking one side of a comparison from an earlier run.
 *
 * While a regression is being tracked down only one side moves: the local one.
 * The other is production, unchanged for hours, and it is the slower of the two
 * because it goes over the network to someone else's host. Capturing it again
 * for every measurement is most of the wait — 902 comparisons in 32 minutes,
 * roughly half of it spent photographing pages that cannot have changed.
 *
 * A reused screenshot has to expire when it stops applying, and it must never
 * be unclear which kind of reference a number was measured against. Hence the
 * fingerprint below and the reusedFrom field on every comparison.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { formatOf, toPixels } from './images.js';
import type { Pixels } from './images.js';
import { join } from 'node:path';
import { resolveUrl } from './config.js';
import type {
  Answer,
  Comparison,
  Config,
  LogEntry,
  Picture,
  RunResult,
  Scenario,
  Side,
  Viewport,
} from './types.js';

/** Where the reused shots come from, and how old they are. */
export interface ReuseSource {
  runId: string;
  dir: string;
  /** When that run started, ISO-8601. */
  capturedAt: string;
  ageMs: number;
}

export type ReuseOutcome =
  | {
      reused: true;
      /** The stored file, byte for byte, in whatever format it was written as. */
      png: Buffer;
      /** Its pixels, when the format is one pngjs cannot read. */
      pixels: Pixels | null;
      format: 'png' | 'webp';
      html: string | null;
      url: string;
      logs: LogEntry[];
      /** Where this side said its pictures were, empty when it did not say. */
      pictures: Picture[];
      /**
       * How this side answered when it was photographed, from the run that
       * photographed it. Without this a re-scored run loses the one finding
       * that outranks every pixel: that the two sides were not asked the same
       * question, or one of them was redirected and the other was not.
       */
      answer: Answer | null;
    }
  | { reused: false; reason: ReuseMiss };

/** Why a side had to be captured after all. Shown in the run output. */
export type ReuseMiss = 'unknown' | 'changed' | 'missing';

export const MISS_REASON: Record<ReuseMiss, string> = {
  unknown: 'not in that run',
  changed: 'settings changed',
  missing: 'files missing',
};

export class ReuseError extends Error {}

/** What this run needs of a side, beyond the screenshot. */
export interface Needs {
  html: boolean;
  logs: boolean;
}

/**
 * Everything that decided what a screenshot shows, as one hash.
 *
 * A shot taken under other conditions must not be used silently, and listing
 * the conditions is the only way to know they still hold. What is left out is
 * as deliberate as what is in: the scenario's name and the viewport's name are
 * absent because the comparison id already carries them, and the threshold is
 * absent because it decides pass or fail, not what the picture looks like.
 */
export function fingerprint(config: Config, scenario: Scenario, viewport: Viewport, side: Side): string {
  const sideConfig = (side === 'a' ? scenario.sideA : scenario.sideB) ?? config[side];
  const path = (side === 'a' ? scenario.pathA : scenario.pathB) ?? scenario.path;

  const parts = {
    url: resolveUrl(sideConfig.baseUrl, path),
    viewport: [viewport.width, viewport.height, viewport.deviceScaleFactor],
    page: {
      fullPage: scenario.fullPage,
      clip: scenario.clip,
      waitUntil: scenario.waitUntil,
      waitForTimeout: scenario.waitForTimeout,
      steps: scenario.steps,
      mask: scenario.mask,
      hide: scenario.hide,
      remove: scenario.remove,
    },
    // Only the entries that run on this side; a notice shown by one system
    // says nothing about how the other was captured.
    beforeEach: config.beforeEach.filter((entry) => entry.side === null || entry.side === side),
    browser: {
      engine: config.browser,
      headless: config.headless,
      colorScheme: config.colorScheme,
      reducedMotion: config.reducedMotion,
      locale: config.locale,
      timezone: config.timezone,
      userAgent: config.userAgent,
      ignoreHTTPSErrors: config.ignoreHTTPSErrors,
      freeze: config.freeze,
      triggerLazyLoad: config.triggerLazyLoad,
    },
    // What the page said was filtered as it was said, so a run that asks for
    // other kinds cannot be answered from what an earlier one kept.
    logs: config.logs.enabled
      ? { levels: config.logs.levels, ignore: config.logs.ignore, max: config.logs.max }
      : null,
    // The saved document was already serialised under these, and they cannot
    // be undone from the file: a comment dropped when it was written is gone.
    // ignoreAttributes and ignoreSelectors are absent on purpose — the saved
    // document keeps everything, so this run's rules still apply to it.
    markup: {
      ignoreComments: config.markup.ignoreComments,
      normalizeWhitespace: config.markup.normalizeWhitespace,
      sortAttributes: config.markup.sortAttributes,
    },
    side: {
      headers: sideConfig.headers,
      cookies: sideConfig.cookies,
      basicAuth: sideConfig.basicAuth,
      storageState: sideConfig.storageState,
    },
  };

  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/** The shots of one earlier run, indexed by comparison id. */
export class ReuseStore {
  private constructor(
    readonly source: ReuseSource,
    private readonly previous: Map<string, Comparison>
  ) {}

  /**
   * Opens the run to take shots from, or explains why it cannot.
   *
   * A missing run stops the run here rather than quietly capturing everything:
   * a reuse that silently does nothing is a reuse you cannot rely on, and the
   * whole point is knowing what was measured against what.
   */
  static async open(outDir: string, from: string, now = new Date()): Promise<ReuseStore> {
    const runId = from === 'latest' ? await latestRun(outDir) : from;
    const dir = join(outDir, runId);

    let result: RunResult;
    try {
      result = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8')) as RunResult;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const known = await runIds(outDir);
        throw new ReuseError(
          `No run called "${runId}" in ${outDir}.` +
            (known.length > 0 ? `\nRuns there: ${known.slice(0, 8).join(', ')}` : '\nThere are no runs there yet.')
        );
      }
      throw new ReuseError(`Could not read ${join(dir, 'results.json')}: ${(error as Error).message}`);
    }

    const previous = new Map(result.comparisons.map((comparison) => [comparison.id, comparison]));

    if (!result.comparisons.some((comparison) => comparison.capture)) {
      throw new ReuseError(
        `Run "${runId}" has no capture fingerprints, so nothing in it can be reused.\n` +
          'It was made by a version of diffyard that predates --reuse. Make one full run first.'
      );
    }

    const capturedAt = result.startedAt;

    return new ReuseStore(
      {
        runId: result.runId || runId,
        dir,
        capturedAt,
        ageMs: Math.max(0, now.getTime() - new Date(capturedAt).getTime()),
      },
      previous
    );
  }

  /** The shot for this comparison and side, if it still applies. */
  async take(id: string, side: Side, want: string, needs: Needs): Promise<ReuseOutcome> {
    const previous = this.previous.get(id);
    if (!previous || !previous.capture) return { reused: false, reason: 'unknown' };
    if (previous.capture[side].fingerprint !== want) return { reused: false, reason: 'changed' };

    const pngPath = side === 'a' ? previous.files.a : previous.files.b;
    const htmlPath = side === 'a' ? previous.files.htmlA : previous.files.htmlB;
    if (!pngPath || (needs.html && !htmlPath)) return { reused: false, reason: 'missing' };
    // A run that kept no console output cannot answer for one that wants it.
    if (needs.logs && !previous.logs) return { reused: false, reason: 'missing' };

    try {
      const png = await readFile(join(this.source.dir, pngPath));
      const format = formatOf(pngPath);
      // Null for a PNG, which the diff reads itself; pixels for a WebP, which
      // it cannot. Either way the side is compared against, never just shown.
      const pixels = await toPixels(png, format);
      // The saved document keeps every attribute, so the ignore rules of this
      // run — which may differ from that one's — still apply cleanly.
      const html = needs.html && htmlPath ? await readFile(join(this.source.dir, htmlPath), 'utf8') : null;
      const url = side === 'a' ? previous.urlA : previous.urlB;
      const logs = previous.logs ? previous.logs[side] : [];
      return {
        reused: true,
        png,
        pixels,
        format,
        html,
        url,
        logs,
        pictures: await this.picturesOf(previous, side),
        answer: previous.answers ? previous.answers[side] : null,
      };
    } catch {
      return { reused: false, reason: 'missing' };
    }
  }

  /**
   * Where that side said its pictures were, from the earlier run's own file.
   *
   * Missing is not a miss: a run made before this was recorded is still a
   * perfectly good screenshot, and the comparison simply counts every pixel
   * the way it always did.
   */
  private async picturesOf(previous: Comparison, side: Side): Promise<Picture[]> {
    if (!previous.files.pictures) return [];

    try {
      const text = await readFile(join(this.source.dir, previous.files.pictures), 'utf8');
      const held = JSON.parse(text) as { a?: Picture[]; b?: Picture[] };
      return held[side] ?? [];
    } catch {
      return [];
    }
  }
}

/** Run directories, newest first. */
async function runIds(outDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(outDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs: { name: string; at: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      // Sorting by name breaks as soon as a run was given its own --run-id, so
      // the file's own timestamp decides which one is the latest.
      const info = await stat(join(outDir, entry.name, 'results.json'));
      runs.push({ name: entry.name, at: info.mtimeMs });
    } catch {
      // Not a finished run; a directory claimed by a run still going has no
      // results.json yet, which is exactly the one not to reuse.
    }
  }

  return runs.sort((left, right) => right.at - left.at).map((run) => run.name);
}

async function latestRun(outDir: string): Promise<string> {
  const [newest] = await runIds(outDir);
  if (!newest) {
    throw new ReuseError(
      `Nothing to reuse: ${outDir} holds no finished run yet.\nRun once without --reuse first.`
    );
  }
  return newest;
}
