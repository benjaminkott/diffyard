/**
 * What the page said while it was being photographed.
 *
 * A page that looks different often looks different for a reason it already
 * announced: a script that threw before it could lay anything out, an image
 * that came back 404, a font that never arrived. The pixel diff shows that
 * something is wrong and the markup diff shows where; this says why, and it
 * costs nothing to collect because the browser is open anyway.
 *
 * What makes it worth reading is the comparison, not the list. An error both
 * sides log is how the site has always been; an error only one side logs is
 * the thing to go and look at.
 */

import type { LogEntry, LogKind, LogOptions, LogSummary } from './types.js';

/** Where each side was served from, so its own address is not a difference. */
export interface Origins {
  a?: string | undefined;
  b?: string | undefined;
}

/** Replaces a side's own origin with a marker, for comparison only. */
function strip(text: string, origin: string | undefined): string {
  return origin ? text.split(origin).join('<origin>') : text;
}

/**
 * The scheme and host a page was served from, or undefined for anything that
 * is not a URL.
 */
export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Which kinds mean something is broken, rather than merely noisy. */
const SERIOUS: LogKind[] = ['error', 'pageerror', 'requestfailed', 'httperror'];

/**
 * Folds identical lines together.
 *
 * A page stuck in a render loop writes the same warning four hundred times,
 * and four hundred copies of it in the artifact say no more than one does.
 */
export function fold(entries: LogEntry[], max: number): LogEntry[] {
  const seen = new Map<string, LogEntry>();

  // A failed request is reported twice: once by us, with the URL, and once by
  // the browser as a console error that names no URL at all ("Failed to load
  // resource: the server responded with a status of 404 ()"). The second one
  // says strictly less, so it goes.
  const failed = entries
    .filter((entry) => entry.kind === 'httperror' || entry.kind === 'requestfailed')
    .map((entry) => entry.source)
    .filter((source): source is string => source !== null);

  for (const entry of entries) {
    const duplicate =
      (entry.kind === 'error' || entry.kind === 'warning') &&
      entry.source !== null &&
      failed.some((url) => entry.source === url || entry.source?.startsWith(`${url}:`));

    if (duplicate) continue;

    const key = `${entry.kind} ${entry.text}`;
    const existing = seen.get(key);

    if (existing) {
      existing.count += 1;
      continue;
    }

    // The cap counts distinct lines, so one repeating line cannot crowd the
    // rest out: dropping an error because a warning repeated is backwards.
    if (seen.size >= max) continue;
    seen.set(key, { ...entry });
  }

  return [...seen.values()];
}

/** Whether this line is one of the kinds asked for, and not one to ignore. */
export function keeps(kind: LogKind, text: string, options: LogOptions): boolean {
  if (!options.levels.includes(kind)) return false;
  return !options.ignore.some((pattern) => text.includes(pattern));
}

/**
 * Compares the two sides.
 *
 * Matched on the text alone, deliberately: the same missing image is the same
 * finding whether it was reported once or eleven times, and a count that
 * differs between the sides is not a difference worth pointing at.
 */
export function summarise(a: LogEntry[], b: LogEntry[], where: Origins = {}): LogSummary {
  // The two sides live on different hosts, so the same missing image reads as
  // two different lines. Compared with each side's own origin taken out, it is
  // one finding again — which is the whole point of comparing at all.
  const keyA = (entry: LogEntry) => strip(entry.text, where.a);
  const keyB = (entry: LogEntry) => strip(entry.text, where.b);

  const textsA = new Set(a.map(keyA));
  const textsB = new Set(b.map(keyB));

  const onlyA = a.filter((entry) => !textsB.has(keyA(entry)));
  const onlyB = b.filter((entry) => !textsA.has(keyB(entry)));
  const serious = (entries: LogEntry[]) => entries.filter((entry) => SERIOUS.includes(entry.kind)).length;

  return {
    a,
    b,
    onlyA: onlyA.length,
    onlyB: onlyB.length,
    errorsA: serious(a),
    errorsB: serious(b),
    // One side failing where the other does not is the finding. Both sides
    // failing the same way is how the site is.
    differs: onlyA.length > 0 || onlyB.length > 0,
    seriousOnOneSide: serious(onlyA) + serious(onlyB),
  };
}
