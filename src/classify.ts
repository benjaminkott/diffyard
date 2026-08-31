/**
 * What kind of difference this is.
 *
 * A list of nine hundred findings sorted by percentage is a list you read from
 * the top until you get bored. Sorted by kind it is several short lists, and
 * "show me the twelve where an image changed" is a question with an answer.
 *
 * Every kind below is read off something already established rather than
 * guessed at from the pixels: which lines of markup changed, whether the
 * markup changed at all, what the alignment found, what the page said. A kind
 * that had to be inferred from the picture would be wrong often enough to make
 * the filter worse than no filter.
 */

import type { Comparison, DiffKind, DiffResult, Hunk, HunkLine, LogSummary, MarkupResult } from './types.js';

/** How far a page has to move before it is worth calling moved. */
const SHIFT = 2;

export interface Classifiable {
  diff: DiffResult | null;
  /** Kept for callers; the kinds are decided from the hunks and the picture. */
  markup?: MarkupResult | null | undefined;
  hunks: Hunk[];
  logs: LogSummary | null;
  /**
   * Shapes of changed line to leave out, because they turned up nearly
   * everywhere in the run. See classifyRun.
   */
  ignore?: Set<string> | undefined;
}

export function classify(input: Classifiable): DiffKind[] {
  const { diff, hunks, logs } = input;
  const kinds = new Set<DiffKind>();

  if (diff === null) return [];

  for (const [removed, added] of changedLines(hunks, input.ignore)) {
    // A text node is its own line in the normalised markup, so a line that
    // does not open a tag is text and nothing else.
    if (removed.some(isText) || added.some(isText)) kinds.add('text');

    const before = sources(removed);
    const after = sources(added);
    const changedSource = !sameSet(before, after);
    if (changedSource) kinds.add('image');

    const lines = [...removed, ...added];

    // Everything structural that is not an image tag.
    if (lines.some((line) => isElement(line) && !isImage(line))) kinds.add('markup');

    // An image tag that changed while pointing at the same picture changed in
    // some other way -- a class, a size, an alt.
    if (!changedSource && lines.some(isImage)) kinds.add('markup');
  }

  // An image that failed on one side is an image difference whether or not the
  // markup mentions it: the src is the same, the picture is not there.
  if (logs?.differs && oneSidedResourceFailure(logs)) kinds.add('image');

  // A picture the two systems produced two files of. Not a difference in the
  // page, and worth saying rather than silently leaving out of the number.
  if (diff.redelivered > 0) kinds.add('redelivered');

  // And what differed where no picture is, in blocks that average to the same
  // thing on both sides -- a logo rasterised differently, text hinted
  // differently. Said rather than silently dropped from the number.
  if (diff.unseen > 0) kinds.add('unseen');

  // A picture both sides have and draw at different heights. Its own finding
  // whatever the pixels inside it say: it is what makes the page below it end
  // a few rows short of the other one.
  if (diff.resized > 0) kinds.add('resized');

  if (diff.sizeMismatch) kinds.add('size');
  if (Math.abs(diff.aligned?.shift ?? 0) >= SHIFT) kinds.add('moved');

  // Nothing in the markup accounts for the picture: identical documents, or
  // documents whose only differences were the build ones discounted above. A
  // font, an image whose address stayed put while its content changed, a
  // gradient, something timing-dependent -- the kind nothing else explains.
  const explained =
    kinds.has('image') || kinds.has('text') || kinds.has('markup') ||
    kinds.has('redelivered') || kinds.has('unseen');
  if (diff.ratio > 0 && !explained) kinds.add('rendering');

  return ORDER.filter((kind) => kinds.has(kind));
}

/**
 * Most specific first, so the tag shown when space is short is the useful one.
 *
 * `answer` is first and is never produced by classify() -- it is set for the
 * whole comparison below, in place of everything else. It belongs in this list
 * anyway, because this is also what the run is tallied against, and a kind
 * missing from it was counted as NaN and so never offered as a filter.
 */
const ORDER: DiffKind[] = ['answer', 'resized', 'redelivered', 'unseen', 'image', 'text', 'markup', 'moved', 'size', 'rendering'];

/**
 * Whether the two sides answered the same question.
 *
 * Either half of it is enough: a status only one side gave, or a redirect only
 * one side made. In both cases the two pictures are of two different pages, so
 * the percentage between them is arithmetic rather than a measurement, and
 * whatever the pixels say is not about the page that was asked for.
 */
export function answersDiffer(answers: Comparison['answers']): boolean {
  if (!answers) return false;
  return answers.a.status !== answers.b.status || answers.a.redirected !== answers.b.redirected;
}

export const KIND_LABELS: Record<DiffKind, string> = {
  answer: 'Answered differently',
  redelivered: 'Picture delivered differently',
  unseen: 'Too small to see',
  resized: 'Picture drawn at another size',
  image: 'Image changed',
  text: 'Text changed',
  markup: 'Structure changed',
  moved: 'Moved',
  size: 'Height differs',
  rendering: 'Rendering only',
};

/** The removed and added lines of each hunk, as two lists. */
function changedLines(hunks: Hunk[], ignore?: Set<string>): [string[], string[]][] {
  const take = (hunk: Hunk, type: HunkLine['type']) =>
    hunk.lines
      .filter((line) => line.type === type && !(ignore && ignore.has(shape(line))))
      .map((line) => line.text.trim());

  return hunks.map((hunk) => [take(hunk, 'remove'), take(hunk, 'add')]);
}

/**
 * A changed line with its attribute values blanked, so the same line on two
 * different pages counts as the same thing.
 */
function shape(line: HunkLine): string {
  return `${line.type} ${line.text.trim().replace(/"[^"]*"/g, '"*"').slice(0, 140)}`;
}

/** Below this many comparisons there is no population to judge against. */
const ENOUGH = 8;

/** A line on this share of the run's pages is telling you about the build. */
const EVERYWHERE = 0.6;

/**
 * Classifies a whole run, discounting what differs on every page.
 *
 * On two builds of the same site the markup diff is dominated by the build
 * rather than the content: an asset pipeline that concatenates on one side and
 * not the other puts the same handful of link and style lines into all nine
 * hundred comparisons. Counting those makes "structure changed" true of
 * everything, and a kind that is true of everything sorts nothing.
 *
 * So a line that turns up on most of the run's pages is left out of the
 * classification — the markup diff still shows it, and the returned list names
 * it, because it is worth an ignore rule rather than being worth hiding.
 */
export function classifyRun(comparisons: Comparison[]): string[] {
  const withMarkup = comparisons.filter((entry) => (entry.markupHunks?.length ?? 0) > 0);
  const ignore = new Set<string>();
  const common: string[] = [];

  if (withMarkup.length >= ENOUGH) {
    const seen = new Map<string, number>();

    for (const comparison of withMarkup) {
      // Counted once per comparison, so a line repeated down one page does not
      // look like a line that is on every page.
      const own = new Set<string>();
      for (const hunk of comparison.markupHunks ?? []) {
        for (const line of hunk.lines) if (line.type !== 'context') own.add(shape(line));
      }
      for (const key of own) seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    for (const [key, count] of [...seen].sort((left, right) => right[1] - left[1])) {
      if (count < withMarkup.length * EVERYWHERE) continue;
      ignore.add(key);
      common.push(`${count}x ${key.slice(key.indexOf(' ') + 1)}`);
    }
  }

  for (const comparison of comparisons) {
    // Before anything read off the pixels: two sides that answered differently
    // were not asked the same question, and what the pictures differ by is not
    // the answer to it.
    if (answersDiffer(comparison.answers)) {
      comparison.kinds = ['answer'];
      continue;
    }

    comparison.kinds = classify({
      diff: comparison.diff,
      markup: comparison.markup,
      hunks: comparison.markupHunks ?? [],
      logs: comparison.logs,
      ignore,
    });
  }

  return [...new Set(common)];
}

function isText(line: string): boolean {
  return line !== '' && !line.startsWith('<');
}

function isElement(line: string): boolean {
  return line.startsWith('<');
}

function isImage(line: string): boolean {
  return /^<(img|source|picture)\b/i.test(line);
}

/** Every address an image tag on these lines points at. */
function sources(lines: string[]): Set<string> {
  const found = new Set<string>();

  for (const line of lines) {
    if (!isImage(line)) continue;
    for (const match of line.matchAll(/\b(?:src|srcset|data-src)="([^"]*)"/gi)) {
      if (match[1]) found.add(match[1]);
    }
  }

  return found;
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

/** Whether one side alone failed to fetch something. */
function oneSidedResourceFailure(logs: LogSummary): boolean {
  const texts = (side: 'a' | 'b') => new Set(logs[side].map((entry) => entry.text));
  const other = { a: texts('b'), b: texts('a') };

  return (['a', 'b'] as const).some((side) =>
    logs[side].some(
      (entry) =>
        (entry.kind === 'httperror' || entry.kind === 'requestfailed') && !other[side].has(entry.text)
    )
  );
}

/** How many comparisons in a run carry each kind. */
export function tally(comparisons: Comparison[]): Record<DiffKind, number> {
  const counts = Object.fromEntries(ORDER.map((kind) => [kind, 0])) as Record<DiffKind, number>;

  for (const comparison of comparisons) {
    for (const kind of comparison.kinds) counts[kind] += 1;
  }

  return counts;
}
