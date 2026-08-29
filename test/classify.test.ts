import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, classifyRun } from '../dist/classify.js';
import type { Comparison, DiffResult, Hunk, HunkLine, LogSummary } from '../dist/types.js';

/**
 * What kind of difference this is.
 *
 * The point of the kinds is filtering a long list, so a wrong one is worse
 * than a missing one: it puts a finding in a drawer nobody will open again.
 */

function hunk(lines: [HunkLine['type'], string][]): Hunk {
  return { startA: 1, startB: 1, lines: lines.map(([type, text]) => ({ type, text })) };
}

function diff(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    diffPixels: 100,
    totalPixels: 10_000,
    ratio: 0.01,
    width: 800,
    height: 600,
    sizeMismatch: false,
    sizeA: { width: 800, height: 600 },
    sizeB: { width: 800, height: 600 },
    profile: [],
    regions: [],
    aligned: null,
    unaligned: null,
    ...overrides,
  };
}

const CHANGED = { identical: false, added: 1, removed: 1, linesA: 10, linesB: 10, hunks: 1 };
const SAME = { identical: true, added: 0, removed: 0, linesA: 10, linesB: 10, hunks: 0 };

const of = (hunks: Hunk[], overrides: Partial<Parameters<typeof classify>[0]> = {}) =>
  classify({ diff: diff(), markup: CHANGED, hunks, logs: null, ...overrides });

describe('reading the kind off the markup', () => {
  it('calls a changed text node text', () => {
    const kinds = of([hunk([['remove', 'Original heading'], ['add', 'Replaced heading']])]);
    assert.deepEqual(kinds, ['text']);
  });

  it('calls a changed image source an image', () => {
    const kinds = of([
      hunk([
        ['remove', '<img src="/hero-old.jpg">'],
        ['add', '<img src="/hero-new.jpg">'],
      ]),
    ]);

    assert.deepEqual(kinds, ['image']);
  });

  it('does not call an image whose address stayed put an image change', () => {
    // The same picture with another class is a structural change, not a
    // different picture — and putting it under "image" would send someone
    // looking for a swapped asset that is not there.
    const kinds = of([
      hunk([
        ['remove', '<img class="a" src="/hero.jpg">'],
        ['add', '<img class="b" src="/hero.jpg">'],
      ]),
    ]);

    assert.deepEqual(kinds, ['markup']);
  });

  it('calls a changed element structure', () => {
    const kinds = of([
      hunk([['remove', '<div class="card">'], ['add', '<section class="card">']]),
    ]);

    assert.deepEqual(kinds, ['markup']);
  });

  it('carries several kinds when several things changed', () => {
    const kinds = of([
      hunk([
        ['remove', '<img src="/a.jpg">'],
        ['add', '<img src="/b.jpg">'],
        ['remove', 'Old words'],
        ['add', 'New words'],
      ]),
    ]);

    assert.deepEqual(kinds, ['image', 'text']);
  });

  it('reads every hunk, not the first few', () => {
    // The report embeds an excerpt; classifying from that would sort a page
    // with two hundred changes by its first fifty.
    const many = Array.from({ length: 60 }, () => hunk([['remove', 'a'], ['add', 'b']]));
    many.push(hunk([['remove', '<img src="/a.jpg">'], ['add', '<img src="/b.jpg">']]));

    assert.ok(of(many).includes('image'));
  });
});

describe('reading the kind off the picture', () => {
  it('calls a page that only moved moved', () => {
    const kinds = classify({
      diff: diff({ aligned: { removedRows: 0, addedRows: 12, shift: 12 } }),
      markup: SAME,
      hunks: [],
      logs: null,
    });

    assert.ok(kinds.includes('moved'));
  });

  it('ignores a shift of one pixel', () => {
    const kinds = classify({
      diff: diff({ aligned: { removedRows: 0, addedRows: 1, shift: 1 } }),
      markup: SAME,
      hunks: [],
      logs: null,
    });

    assert.ok(!kinds.includes('moved'));
  });

  it('calls a difference with identical markup a rendering difference', () => {
    // A font, a picture whose address stayed put while its content changed,
    // something timing-dependent: the one kind the DOM will not explain.
    const kinds = classify({ diff: diff(), markup: SAME, hunks: [], logs: null });
    assert.deepEqual(kinds, ['rendering']);
  });

  it('does not call a markup difference a rendering one', () => {
    assert.ok(!of([hunk([['remove', 'a'], ['add', 'b']])]).includes('rendering'));
  });

  it('notes a differing page height', () => {
    const kinds = classify({
      diff: diff({ sizeMismatch: true, sizeB: { width: 800, height: 900 } }),
      markup: SAME,
      hunks: [],
      logs: null,
    });

    assert.ok(kinds.includes('size'));
  });
});

describe('reading the kind off what the page said', () => {
  const failure = (side: 'a' | 'b'): LogSummary => ({
    a: side === 'a' ? [{ kind: 'httperror', text: 'HTTP 404 /hero.jpg', source: null, count: 1 }] : [],
    b: side === 'b' ? [{ kind: 'httperror', text: 'HTTP 404 /hero.jpg', source: null, count: 1 }] : [],
    onlyA: side === 'a' ? 1 : 0,
    onlyB: side === 'b' ? 1 : 0,
    errorsA: side === 'a' ? 1 : 0,
    errorsB: side === 'b' ? 1 : 0,
    differs: true,
    seriousOnOneSide: 1,
  });

  it('calls a one-sided failed request an image change', () => {
    // The address is the same on both sides and the markup says nothing; the
    // picture is simply not there on one of them.
    const kinds = classify({ diff: diff(), markup: SAME, hunks: [], logs: failure('b') });
    assert.ok(kinds.includes('image'));
  });

  it('says nothing about a failure both sides had', () => {
    const both: LogSummary = {
      a: [{ kind: 'httperror', text: 'HTTP 404 /hero.jpg', source: null, count: 1 }],
      b: [{ kind: 'httperror', text: 'HTTP 404 /hero.jpg', source: null, count: 1 }],
      onlyA: 0,
      onlyB: 0,
      errorsA: 1,
      errorsB: 1,
      differs: false,
      seriousOnOneSide: 0,
    };

    const kinds = classify({ diff: diff(), markup: SAME, hunks: [], logs: both });
    assert.ok(!kinds.includes('image'));
  });
});

describe('a comparison with nothing to say', () => {
  it('carries no kinds when it never ran', () => {
    assert.deepEqual(classify({ diff: null, markup: null, hunks: [], logs: null }), []);
  });

  it('carries no kinds when the two sides match', () => {
    const kinds = classify({
      diff: diff({ ratio: 0, diffPixels: 0 }),
      markup: SAME,
      hunks: [],
      logs: null,
    });

    assert.deepEqual(kinds, []);
  });
});

describe('kinds decided against the whole run', () => {
  const comparison = (id: string, lines: [HunkLine['type'], string][]): Comparison =>
    ({
      id,
      scenario: id,
      group: null,
      viewport: { name: 'desktop', width: 800, height: 600, deviceScaleFactor: 1 },
      urlA: '',
      urlB: '',
      status: 'fail',
      threshold: 0,
      diff: diff(),
      markup: CHANGED,
      markupHunks: [hunk(lines)],
      logs: null,
      kinds: [],
      files: { a: null, b: null, diff: null, htmlA: null, htmlB: null, patch: null, result: null },
      capture: null,
      command: '',
      ranAt: '',
      error: null,
      durationMs: 0,
    }) as Comparison;

  /** The same build difference on every page, plus one real change on one. */
  function run(pages: number): Comparison[] {
    const noise: [HunkLine['type'], string][] = [
      ['remove', '<link rel="stylesheet" href="/a.css">'],
      ['add', '<link rel="stylesheet" href="/b.css">'],
    ];

    return Array.from({ length: pages }, (_, index) =>
      comparison(
        `page-${index}`,
        index === 0 ? [...noise, ['remove', 'Old words'], ['add', 'New words']] : noise
      )
    );
  }

  it('leaves out what differs on nearly every page', () => {
    // Two builds of one site differ in their asset pipeline on all nine
    // hundred pages. Counting that makes "structure changed" true of
    // everything, and a kind that is true of everything sorts nothing.
    const comparisons = run(20);
    const common = classifyRun(comparisons);

    // Both sides of the swap read as the same line, so it is named once.
    assert.deepEqual(common, ['20x <link rel="*" href="*">'], 'and says what it left out');

    // A page whose only markup difference was the build one is left with the
    // kind that says so: nothing in the DOM explains this picture.
    assert.deepEqual(comparisons[5]?.kinds, ['rendering']);
    assert.deepEqual(comparisons[0]?.kinds, ['text'], 'a page with something of its own');
  });

  it('names the discounted line, so it can be acted on', () => {
    const [first] = classifyRun(run(20));
    assert.match(first ?? '', /^\d+x .*<link/);
  });

  it('judges nothing on a run too small to have a population', () => {
    // With four comparisons, "on most pages" says nothing about the build.
    const comparisons = run(4);
    assert.deepEqual(classifyRun(comparisons), []);
    assert.ok(comparisons[3]?.kinds.includes('markup'));
  });
});
