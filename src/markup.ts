import type { Hunk, HunkLine, MarkupOptions, MarkupResult } from './types.js';

export type { Hunk, HunkLine };

export interface MarkupDiff {
  result: MarkupResult;
  hunks: Hunk[];
  /** Unified diff text, suitable for `patch` or a CI log. */
  patch: string;
  /**
   * The two documents as they are written to disk: indented, but with nothing
   * dropped. Ignoring an attribute is about what counts as a difference, not
   * about what gets recorded — a src ignored because of build hashes is still
   * the thing you need when you go and check which image was used.
   */
  normalisedA: string;
  normalisedB: string;
}

const CONTEXT_LINES = 3;

/**
 * Compares the two serialised DOMs line by line.
 *
 * Raw `outerHTML` is a single enormous line for minified markup, so both sides
 * are re-indented first: every tag and every run of text becomes its own line.
 * That turns the comparison into a readable, structural diff instead of one
 * giant changed line.
 */
export function diffMarkup(htmlA: string, htmlB: string, options: MarkupOptions): MarkupDiff {
  const comparedA = normalise(htmlA, options);
  const comparedB = normalise(htmlB, options);

  // What gets written to disk keeps everything; only the comparison applies
  // the ignore rules. An attribute ignored because build hashes churn is still
  // the thing you need when you go and check which image was actually used.
  const keepAll: MarkupOptions = { ...options, ignoreAttributes: [], ignoreSelectors: [] };
  const sameRules = options.ignoreAttributes.length === 0 && options.ignoreSelectors.length === 0;
  const normalisedA = sameRules ? comparedA : normalise(htmlA, keepAll);
  const normalisedB = sameRules ? comparedB : normalise(htmlB, keepAll);

  // Splitting an empty string yields one empty line, which would count as a
  // removed line against a page that simply has no markup.
  const linesA = toLines(comparedA);
  const linesB = toLines(comparedB);
  const hunks = buildHunks(linesA, linesB);

  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') added += 1;
      if (line.type === 'remove') removed += 1;
    }
  }

  return {
    result: {
      identical: added === 0 && removed === 0,
      added,
      removed,
      linesA: linesA.length,
      linesB: linesB.length,
      hunks: hunks.length,
    },
    hunks,
    patch: toUnifiedPatch(hunks),
    normalisedA,
    normalisedB,
  };
}

function toLines(normalised: string): string[] {
  return normalised === '' ? [] : normalised.split('\n');
}

/** Re-indents HTML and applies the configured ignore rules. */
export function normalise(html: string, options: MarkupOptions): string {
  const tokens = tokenise(html);
  const out: string[] = [];
  let depth = 0;
  /** Nesting depth of the element currently being skipped, or null. */
  let skipping: { tag: string; depth: number } | null = null;

  for (const token of tokens) {
    if (skipping) {
      // Only the matching close at the depth the skip started ends it; a
      // nested element of the same name must not close it early.
      if (token.kind === 'open' && token.tag === skipping.tag) {
        depth += 1;
      } else if (token.kind === 'close' && token.tag === skipping.tag) {
        depth -= 1;
        if (depth === skipping.depth) skipping = null;
      }
      continue;
    }

    if (token.kind === 'comment') {
      if (!options.ignoreComments) out.push(indent(depth) + token.raw.trim());
      continue;
    }

    if (token.kind === 'text') {
      const text = options.normalizeWhitespace ? token.raw.replace(/\s+/g, ' ').trim() : token.raw.trim();
      if (text) out.push(indent(depth) + text);
      continue;
    }

    if (token.kind === 'close') {
      depth = Math.max(0, depth - 1);
      out.push(`${indent(depth)}</${token.tag}>`);
      continue;
    }

    // open or self-closing
    const element: ElementToken = token;
    if (options.ignoreSelectors.includes(element.tag)) {
      if (element.kind === 'open') {
        skipping = { tag: element.tag, depth };
        depth += 1;
      }
      continue;
    }

    const attributes = renderAttributes(element.attributes, options);
    out.push(`${indent(depth)}<${element.tag}${attributes}${element.kind === 'self' ? ' /' : ''}>`);
    if (element.kind === 'open') depth += 1;
  }

  return out.join('\n');
}

function indent(depth: number): string {
  return '  '.repeat(Math.min(depth, 40));
}

function renderAttributes(attributes: [string, string | null][], options: MarkupOptions): string {
  const kept = attributes.filter(([name]) => !isIgnoredAttribute(name, options.ignoreAttributes));
  const ordered = options.sortAttributes
    ? [...kept].sort((left, right) => left[0].localeCompare(right[0]))
    : kept;

  return ordered
    .map(([name, value]) => (value === null ? ` ${name}` : ` ${name}="${collapse(value, options)}"`))
    .join('');
}

function collapse(value: string, options: MarkupOptions): string {
  return options.normalizeWhitespace ? value.replace(/\s+/g, ' ').trim() : value;
}

/** Supports exact names and `prefix-*` wildcards, both case-insensitively. */
function isIgnoredAttribute(name: string, patterns: string[]): boolean {
  const lower = name.toLowerCase();
  return patterns.some((pattern) => {
    const target = pattern.toLowerCase();
    if (target.endsWith('*')) return lower.startsWith(target.slice(0, -1));
    return lower === target;
  });
}

type ElementToken = { kind: 'open' | 'self'; tag: string; attributes: [string, string | null][] };

type Token =
  | ElementToken
  | { kind: 'close'; tag: string }
  | { kind: 'text'; raw: string }
  | { kind: 'comment'; raw: string };

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements whose content is raw text, not markup. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

/**
 * A deliberately small HTML tokeniser. It only needs to be good enough to put
 * structure on separate lines; it is never used to reconstruct a document.
 */
function tokenise(html: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < html.length) {
    const next = html.indexOf('<', index);

    if (next === -1) {
      pushText(tokens, html.slice(index));
      break;
    }
    if (next > index) pushText(tokens, html.slice(index, next));

    if (html.startsWith('<!--', next)) {
      const end = html.indexOf('-->', next);
      const stop = end === -1 ? html.length : end + 3;
      tokens.push({ kind: 'comment', raw: html.slice(next, stop) });
      index = stop;
      continue;
    }

    if (html.startsWith('<!', next)) {
      const end = html.indexOf('>', next);
      const stop = end === -1 ? html.length : end + 1;
      tokens.push({ kind: 'comment', raw: html.slice(next, stop) });
      index = stop;
      continue;
    }

    const end = findTagEnd(html, next);
    if (end === -1) {
      pushText(tokens, html.slice(next));
      break;
    }

    const inner = html.slice(next + 1, end);
    index = end + 1;

    if (inner.startsWith('/')) {
      tokens.push({ kind: 'close', tag: inner.slice(1).trim().toLowerCase() });
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const match = /^([a-zA-Z][^\s/>]*)/.exec(body);
    if (!match) {
      pushText(tokens, html.slice(next, index));
      continue;
    }

    const tag = match[1]!.toLowerCase();
    const attributes = parseAttributes(body.slice(match[1]!.length));
    const isVoid = VOID_ELEMENTS.has(tag);
    tokens.push({ kind: selfClosing || isVoid ? 'self' : 'open', tag, attributes });

    // Raw-text elements must not have their contents parsed as markup.
    if (!selfClosing && !isVoid && RAW_TEXT_ELEMENTS.has(tag)) {
      const closing = html.toLowerCase().indexOf(`</${tag}`, index);
      const stop = closing === -1 ? html.length : closing;
      pushText(tokens, html.slice(index, stop));
      index = stop;
    }
  }

  return tokens;
}

function pushText(tokens: Token[], raw: string): void {
  if (raw.trim()) tokens.push({ kind: 'text', raw });
}

/** Finds the `>` that closes a tag, skipping any inside quoted attributes. */
function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let index = start + 1; index < html.length; index += 1) {
    const char = html[index]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index;
  }
  return -1;
}

function parseAttributes(source: string): [string, string | null][] {
  const attributes: [string, string | null][] = [];
  const pattern = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

  for (const match of source.matchAll(pattern)) {
    const name = match[1]!;
    if (!name || name === '/') continue;
    const value = match[3] ?? match[4] ?? match[5] ?? null;
    attributes.push([name, match[2] === undefined ? null : (value ?? '')]);
  }

  return attributes;
}

/**
 * Myers' greedy diff, reduced to the changed middle by trimming the shared
 * prefix and suffix first. Falls back to "everything changed" for pathological
 * inputs so a single comparison can never stall the run.
 */
function diffLines(a: string[], b: string[]): HunkLine[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);

  const head: HunkLine[] = a.slice(0, prefix).map((text) => ({ type: 'context', text }));
  const tail: HunkLine[] = a.slice(a.length - suffix).map((text) => ({ type: 'context', text }));

  const budget = 4_000_000;
  const middle =
    middleA.length * middleB.length > budget
      ? [
          ...middleA.map((text): HunkLine => ({ type: 'remove', text })),
          ...middleB.map((text): HunkLine => ({ type: 'add', text })),
        ]
      : myers(middleA, middleB);

  return [...head, ...middle, ...tail];
}

function myers(a: string[], b: string[]): HunkLine[] {
  const max = a.length + b.length;
  if (max === 0) return [];

  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());

    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;

      while (x < a.length && y < b.length && a[x] === b[y]) {
        x += 1;
        y += 1;
      }

      v[offset + k] = x;

      if (x >= a.length && y >= b.length) return backtrack(trace, a, b, d, offset);
    }
  }

  return [
    ...a.map((text): HunkLine => ({ type: 'remove', text })),
    ...b.map((text): HunkLine => ({ type: 'add', text })),
  ];
}

function backtrack(trace: Int32Array[], a: string[], b: string[], d: number, offset: number): HunkLine[] {
  const lines: HunkLine[] = [];
  let x = a.length;
  let y = b.length;

  for (let step = d; step > 0; step -= 1) {
    const v = trace[step]!;
    const k = x - y;
    const previousK =
      k === -step || (k !== step && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const previousX = v[offset + previousK]!;
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      lines.push({ type: 'context', text: a[x]! });
    }

    if (x > previousX) {
      x -= 1;
      lines.push({ type: 'remove', text: a[x]! });
    } else if (y > previousY) {
      y -= 1;
      lines.push({ type: 'add', text: b[y]! });
    }
  }

  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    lines.push({ type: 'context', text: a[x]! });
  }

  return lines.reverse();
}

/** Groups the line diff into hunks, keeping a few lines of context around changes. */
function buildHunks(a: string[], b: string[]): Hunk[] {
  const lines = diffLines(a, b);
  const hunks: Hunk[] = [];

  let indexA = 0;
  let indexB = 0;
  let current: Hunk | null = null;
  /** Context lines seen since the last change, still eligible to be trailing context. */
  let trailing = 0;
  const pending: { line: HunkLine; indexA: number; indexB: number }[] = [];

  for (const line of lines) {
    if (line.type === 'context') {
      if (current) {
        if (trailing < CONTEXT_LINES) {
          current.lines.push(line);
          trailing += 1;
        } else {
          hunks.push(current);
          current = null;
          pending.length = 0;
        }
      }
      if (!current) {
        pending.push({ line, indexA, indexB });
        if (pending.length > CONTEXT_LINES) pending.shift();
      }
      indexA += 1;
      indexB += 1;
      continue;
    }

    if (!current) {
      const first = pending[0];
      current = {
        startA: first ? first.indexA : indexA,
        startB: first ? first.indexB : indexB,
        lines: pending.map((entry) => entry.line),
      };
      pending.length = 0;
    }

    current.lines.push(line);
    trailing = 0;
    if (line.type === 'remove') indexA += 1;
    else indexB += 1;
  }

  if (current) hunks.push(current);
  return hunks;
}

function toUnifiedPatch(hunks: Hunk[]): string {
  if (hunks.length === 0) return '';

  const parts = ['--- a (side A)', '+++ b (side B)'];

  for (const hunk of hunks) {
    const countA = hunk.lines.filter((line) => line.type !== 'add').length;
    const countB = hunk.lines.filter((line) => line.type !== 'remove').length;
    parts.push(`@@ -${hunk.startA + 1},${countA} +${hunk.startB + 1},${countB} @@`);
    for (const line of hunk.lines) {
      const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      parts.push(marker + line.text);
    }
  }

  return `${parts.join('\n')}\n`;
}
