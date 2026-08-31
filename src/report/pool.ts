import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Comparison, Hunk, RunResult } from '../types.js';

/**
 * Where the run's data lives, and how it reaches the report.
 *
 * The report used to carry the whole run inside its own <script> tag. On a run
 * of nine hundred pages that is a hundred and forty megabytes of markup diff
 * in a file that opens showing none of it: the overview draws a status, a
 * ratio and a kind per comparison, and nothing else.
 *
 * So the run is written out in the shape it is read in. The index is what the
 * overview draws; a case chunk is what one comparison's detail view draws, and
 * is loaded when that comparison is opened. Both are scripts rather than JSON
 * because a report is opened from a file:// URL, where fetch is blocked and a
 * script tag is not -- which is the whole reason the data was inlined before.
 */

/** The directory, relative to the run folder, that the pool is written into. */
export const POOL_DIR = 'data';

/** The index: one file, loaded before anything is drawn. */
export const INDEX_FILE = `${POOL_DIR}/run.js`;

/** What a comparison carries that only its own detail view draws. */
export interface CaseDetail {
  markupHunks: Hunk[] | null;
}

export interface Delivery {
  /** The run with the per-case detail taken out of it. */
  index: RunResult;
  /** That detail, per comparison id, in the order the comparisons are in. */
  cases: [string, CaseDetail][];
}

/**
 * Takes the run apart along the line the report reads it along.
 *
 * Only `markupHunks` moves. It is the one field that is both unbounded -- a
 * page whose asset pipeline differs produces thousands of lines of it -- and
 * drawn by nothing but the markup view. The console logs look similar but are
 * capped per side by `logs.max`, so they cost the index a known amount and
 * stay in it; splitting them would buy nothing and make the overview wait.
 */
export function forDelivery(result: RunResult): Delivery {
  const cases: [string, CaseDetail][] = [];

  const comparisons = result.comparisons.map((comparison): Comparison => {
    cases.push([comparison.id, detailOf(comparison)]);
    // The path is set here rather than trusted from the comparison: this is
    // what writes the chunk, so it is what knows where the chunk went. A run
    // read back from an older results.json has no path on it at all.
    return { ...withoutDetail(comparison), files: { ...comparison.files, detail: caseFile(comparison.id) } };
  });

  return { index: { ...result, comparisons }, cases };
}

/** What moves out of the index and into the case's own chunk. */
export function detailOf(comparison: Comparison): CaseDetail {
  return { markupHunks: comparison.markupHunks };
}

/**
 * The comparison as everything but its own chunk holds it.
 *
 * Used by the index and by the record written beside the screenshots, so a
 * field that joins the pool leaves both of them at once rather than being
 * dropped in one place and quietly kept in the other.
 */
export function withoutDetail(comparison: Comparison): Comparison {
  return { ...comparison, markupHunks: null };
}

/** Puts back what forDelivery took out, for a run being read rather than written. */
export function withDetail(result: RunResult, cases: Map<string, CaseDetail>): RunResult {
  return {
    ...result,
    comparisons: result.comparisons.map((comparison) => {
      const held = cases.get(comparison.id);
      return held ? { ...comparison, markupHunks: held.markupHunks } : comparison;
    }),
  };
}

/** The path a comparison's chunk is written to, relative to the run folder. */
export function caseFile(id: string): string {
  return `${POOL_DIR}/${id}.js`;
}

/**
 * The pool as files.
 *
 * Written every time the report is, including on a `--into` run: a chunk that
 * is not rewritten is one whose comparison did not run again, and it has to
 * keep saying what it said before rather than becoming an empty file.
 */
export async function writePool(outDir: string, delivery: Delivery, payload: unknown): Promise<void> {
  await mkdir(join(outDir, POOL_DIR), { recursive: true });

  await writeFile(join(outDir, INDEX_FILE), call('run', payload));

  await Promise.all(
    delivery.cases.map(async ([id, detail]) => {
      const path = join(outDir, caseFile(id));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, call('case', [id, detail]));
    })
  );
}

/** One comparison's chunk, read back the way the report would read it. */
export async function readCase(outDir: string, id: string): Promise<CaseDetail | null> {
  let text: string;
  try {
    text = await readFile(join(outDir, caseFile(id)), 'utf8');
  } catch {
    return null;
  }

  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open === -1 || close < open) return null;

  try {
    const entry = JSON.parse(text.slice(open + 1, close)) as [string, CaseDetail];
    return entry[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * One call, one file.
 *
 * The argument is a single JSON value with nothing around it, so the file can
 * be read back by finding its outermost brackets -- which is what a merge into
 * an existing report does, and it should not need a JavaScript parser to do it.
 */
export function call(method: 'run' | 'case', argument: unknown): string {
  return `diffyard.${method}(${jsonForScript(argument)});\n`;
}

/** Escapes the payload so it cannot break out of the <script> element. */
export function jsonForScript(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}
