import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fold, keeps, summarise } from '../dist/logs.js';
import type { LogEntry, LogKind, LogOptions } from '../dist/types.js';

/**
 * What the page said, and which half of it is a finding.
 *
 * The list on its own is noise: every real site logs something. The finding is
 * what one side said and the other did not.
 */

function entry(kind: LogKind, text: string): LogEntry {
  return { kind, text, source: null, count: 1 };
}

const OPTIONS: LogOptions = {
  enabled: true,
  levels: ['error', 'warning', 'pageerror', 'requestfailed', 'httperror'],
  ignore: [],
  max: 50,
  failOnDifference: false,
};

describe('folding repeats', () => {
  it('counts an identical line instead of keeping every copy', () => {
    // A page stuck in a render loop writes the same warning four hundred times.
    const folded = fold(
      [entry('warning', 'Deprecated'), entry('warning', 'Deprecated'), entry('warning', 'Deprecated')],
      50
    );

    assert.equal(folded.length, 1);
    assert.equal(folded[0]?.count, 3);
  });

  it('tells the same text apart by kind', () => {
    const folded = fold([entry('warning', 'Failed'), entry('error', 'Failed')], 50);
    assert.equal(folded.length, 2);
  });

  it('caps distinct lines, so one repeat cannot crowd out the rest', () => {
    const many = [
      entry('warning', 'a'),
      entry('warning', 'a'),
      entry('warning', 'b'),
      entry('error', 'the one that matters'),
    ];

    // Room for two distinct lines: the repeat must not eat both slots.
    const folded = fold(many, 2);
    assert.deepEqual(folded.map((line) => line.text), ['a', 'b']);
    assert.equal(folded[0]?.count, 2);
  });
});

describe('what is kept', () => {
  it('drops a kind that was not asked for', () => {
    assert.equal(keeps('log', 'chatter', OPTIONS), false);
    assert.equal(keeps('error', 'boom', OPTIONS), true);
  });

  it('drops a line matching an ignore pattern', () => {
    const options = { ...OPTIONS, ignore: ['Tracking Prevention'] };
    assert.equal(keeps('warning', 'Tracking Prevention blocked storage', options), false);
    assert.equal(keeps('warning', 'Something else', options), true);
  });
});

describe('comparing the two sides', () => {
  it('finds nothing when both sides say the same', () => {
    const both = [entry('warning', 'Deprecated API')];
    const summary = summarise(both, [...both]);

    assert.equal(summary.differs, false);
    assert.equal(summary.seriousOnOneSide, 0);
  });

  it('reports a line only one side logged', () => {
    const summary = summarise(
      [entry('warning', 'Deprecated API')],
      [entry('warning', 'Deprecated API'), entry('httperror', 'HTTP 404 /hero.jpg')]
    );

    assert.equal(summary.onlyA, 0);
    assert.equal(summary.onlyB, 1);
    assert.equal(summary.differs, true);
    // A 404 image is a difference you can see, so it counts as serious.
    assert.equal(summary.seriousOnOneSide, 1);
  });

  it('does not call a differing count a difference', () => {
    // The same missing image is the same finding whether it was reported once
    // or eleven times.
    const a = [{ ...entry('httperror', 'HTTP 404 /hero.jpg'), count: 1 }];
    const b = [{ ...entry('httperror', 'HTTP 404 /hero.jpg'), count: 11 }];

    assert.equal(summarise(a, b).differs, false);
  });

  it('counts errors per side, both-sided ones included', () => {
    const summary = summarise(
      [entry('pageerror', 'x is not a function')],
      [entry('pageerror', 'x is not a function'), entry('error', 'other')]
    );

    assert.equal(summary.errorsA, 1);
    assert.equal(summary.errorsB, 2);
    // Only what one side alone said is the finding.
    assert.equal(summary.seriousOnOneSide, 1);
  });

  it('does not treat a warning on one side as something being broken', () => {
    const summary = summarise([], [entry('warning', 'Deprecated API')]);

    assert.equal(summary.differs, true, 'it is still a difference');
    assert.equal(summary.seriousOnOneSide, 0, 'but not a broken page');
  });
});

describe('the same finding on two different hosts', () => {
  it('is one finding, not two', () => {
    // The two sides live on different hosts, so the same missing image reads
    // as two different lines. Left alone, every request-related line on a real
    // pair of sites comes back as "only on one side" — reproducibly wrong,
    // which is worse than flaky.
    const summary = summarise(
      [entry('httperror', 'HTTP 404 https://old.example.com/hero.jpg')],
      [entry('httperror', 'HTTP 404 https://new.example.com/hero.jpg')],
      { a: 'https://old.example.com', b: 'https://new.example.com' }
    );

    assert.equal(summary.differs, false);
    assert.equal(summary.seriousOnOneSide, 0);
  });

  it('still sees a genuinely one-sided failure', () => {
    const summary = summarise(
      [],
      [entry('httperror', 'HTTP 404 https://new.example.com/hero.jpg')],
      { a: 'https://old.example.com', b: 'https://new.example.com' }
    );

    assert.equal(summary.onlyB, 1);
    assert.equal(summary.seriousOnOneSide, 1);
  });

  it('leaves a third-party address alone, because it is the same on both', () => {
    const summary = summarise(
      [entry('httperror', 'HTTP 500 https://cdn.example.net/a.js')],
      [],
      { a: 'https://old.example.com', b: 'https://new.example.com' }
    );

    assert.equal(summary.onlyA, 1);
  });
});

describe('the browser reporting a failure twice', () => {
  it('keeps the line that names the URL and drops the one that does not', () => {
    const folded = fold(
      [
        { kind: 'httperror', text: 'HTTP 404 https://a.test/hero.jpg', source: 'https://a.test/hero.jpg', count: 1 },
        {
          kind: 'error',
          text: 'Failed to load resource: the server responded with a status of 404 ()',
          source: 'https://a.test/hero.jpg',
          count: 1,
        },
      ],
      50
    );

    assert.deepEqual(folded.map((line) => line.kind), ['httperror']);
  });

  it('keeps a console error that stands on its own', () => {
    const folded = fold(
      [
        { kind: 'httperror', text: 'HTTP 404 https://a.test/hero.jpg', source: 'https://a.test/hero.jpg', count: 1 },
        { kind: 'error', text: 'x is not a function', source: 'https://a.test/app.js:12', count: 1 },
      ],
      50
    );

    assert.equal(folded.length, 2);
  });
});
