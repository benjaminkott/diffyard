import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { align, BUDGET } from '../dist/align.js';
import type { Edit, RowSignatures } from '../dist/align.js';

/** One bucket per row, so a plain list of numbers reads as a page of rows. */
function rows(...values: number[]): RowSignatures {
  return { values: Float32Array.from(values), buckets: 1, count: values.length };
}

/** The alignment of two short sequences, which always fit the budget. */
function aligned(a: RowSignatures, b: RowSignatures): Edit[] {
  const edits = align(a, b);
  assert.ok(edits, 'aligned within the budget');
  return edits;
}
import { diffImages } from '../dist/diff.js';

const OPTIONS = { pixelThreshold: 0.1, ignoreAntialiasing: true, alignRows: true };

/**
 * A page with text-like rows: bands of blocks that differ from row to row, so
 * two rows only match when they are genuinely the same content.
 */
function page(height: number, options: { insertAt?: number; insert?: number; invert?: [number, number] } = {}): Buffer {
  const width = 320;
  const image = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    let source = y;
    if (options.insertAt !== undefined && options.insert && y >= options.insertAt) {
      source = y - options.insert;
    }

    const inverted =
      options.invert !== undefined && y >= options.invert[0] && y < options.invert[1];

    for (let x = 0; x < width; x += 1) {
      const at = (width * y + x) << 2;
      let value = 255;

      if (source >= 0) {
        const band = Math.floor(source / 20);
        if (source % 20 < 12 && (x + band * 7) % 23 < 11) value = 40 + ((band * 37) % 160);
      }
      if (inverted) value = 255 - value;

      image.data[at] = value;
      image.data[at + 1] = value;
      image.data[at + 2] = value;
      image.data[at + 3] = 255;
    }
  }

  return PNG.sync.write(image);
}

describe('align', () => {
  it('matches identical sequences', () => {
    const edits = aligned(rows(10, 60, 110), rows(10, 60, 110));
    assert.deepEqual(edits.map((edit) => edit.type), ['match', 'match', 'match']);
  });

  it('reports an insertion as an addition, not as a wall of changes', () => {
    const edits = aligned(rows(10, 60, 110), rows(10, 200, 60, 110));
    assert.deepEqual(edits.map((edit) => edit.type), ['match', 'add', 'match', 'match']);
  });

  it('pairs a removal and an addition into a change', () => {
    // Myers alone would call this "one gone, one arrived", which counts the
    // same row twice.
    const edits = aligned(rows(10, 60, 110), rows(10, 200, 110));
    assert.deepEqual(edits.map((edit) => edit.type), ['match', 'change', 'match']);
  });

  it('keeps the surplus when the blocks differ in length', () => {
    const types = aligned(rows(10, 60, 110, 160), rows(10, 200, 230, 250, 160)).map((edit) => edit.type);
    assert.equal(types.filter((type) => type === 'change').length, 2);
    assert.equal(types.filter((type) => type === 'add').length, 1);
  });
});

describe('a page that only moved', () => {
  it('is not reported as a page that changed', () => {
    // The case that started this: fourteen pixels of extra height turned into
    // a 46% difference, because everything below was compared to its
    // neighbour instead of to itself.
    const a = page(2000);
    const b = page(2014, { insertAt: 300, insert: 14 });

    const positional = diffImages(a, b, { ...OPTIONS, alignRows: false }).result;
    const aligned = diffImages(a, b, OPTIONS).result;

    assert.ok(positional.ratio > 0.3, `expected a large positional difference, got ${positional.ratio}`);
    assert.ok(aligned.ratio < 0.02, `expected the aligned difference to be small, got ${aligned.ratio}`);
  });

  it('says how far it moved', () => {
    const result = diffImages(page(2000), page(2014, { insertAt: 300, insert: 14 }), OPTIONS).result;

    assert.equal(result.aligned?.shift, 14);
    assert.equal(result.aligned?.addedRows, 14);
    assert.equal(result.aligned?.removedRows, 0);
  });

  it('keeps the positional number for reference', () => {
    const result = diffImages(page(2000), page(2014, { insertAt: 300, insert: 14 }), OPTIONS).result;

    assert.ok(result.unaligned);
    assert.ok(result.unaligned.ratio > result.ratio);
  });
});

describe('a page that actually changed', () => {
  it('reports the same amount with or without alignment', () => {
    const a = page(2000);
    const b = page(2000, { invert: [1616, 1827] });

    const positional = diffImages(a, b, { ...OPTIONS, alignRows: false }).result;
    const aligned = diffImages(a, b, OPTIONS).result;

    // Alignment must not talk a real difference away.
    assert.ok(Math.abs(aligned.ratio - positional.ratio) < 0.01);
  });

  it('names the stretch that differs', () => {
    const result = diffImages(page(2000), page(2000, { invert: [1616, 1827] }), OPTIONS).result;
    const [region] = result.regions;

    assert.ok(region, 'expected a region');
    assert.ok(Math.abs(region.from - 1616) <= 2, `region starts at ${region.from}`);
    assert.ok(Math.abs(region.to - 1827) <= 2, `region ends at ${region.to}`);
    assert.equal(region.height, region.to - region.from);
  });

  it('finds a change under a shift', () => {
    const moved = diffImages(page(2000), page(2014, { insertAt: 300, insert: 14 }), OPTIONS).result;
    const both = diffImages(
      page(2000),
      page(2014, { insertAt: 300, insert: 14, invert: [1500, 1560] }),
      OPTIONS
    ).result;

    assert.ok(both.ratio > moved.ratio, 'a change under a shift has to show');
  });
});

describe('rows that only resemble each other', () => {
  it('still align, so a photograph is not a wall of changes', () => {
    // Matching on a hash finds a few hundred anchors in eight thousand rows of
    // photographs and pairs the rest in order, which is worse than not
    // aligning: two rows that look the same are never byte-identical.
    const a = rows(10, 20, 30, 40);
    const b = rows(11, 21, 31, 41);

    assert.deepEqual(aligned(a, b).map((edit) => edit.type), ['match', 'match', 'match', 'match']);
  });

  it('finds a shift through rows that merely resemble each other', () => {
    const a = rows(10, 20, 30, 40, 50);
    const b = rows(11, 200, 21, 31, 41, 51);

    const edits = aligned(a, b);
    assert.equal(edits.filter((edit) => edit.type === 'add').length, 1);
    assert.equal(edits.filter((edit) => edit.type === 'match').length, 5);
  });

  it('does not pair rows with nothing in common', () => {
    const edits = aligned(rows(10, 20), rows(200, 250));
    assert.equal(edits.filter((edit) => edit.type === 'match').length, 0);
  });
});

/**
 * Two pages too far apart in length to be one page shifted.
 *
 * The band has to cover the difference in length, so its size grows with one
 * height times the difference: a twenty-thousand-row page against a short
 * error page asked for three gigabytes, once per worker, and the whole run
 * was killed with it.
 */
describe('two pages too far apart in length', () => {
  const blank = (count: number): RowSignatures => ({ values: new Float32Array(count), buckets: 1, count });

  /** A white page of the given height, as pixels rather than a file. */
  const white = (height: number) => ({ data: Buffer.alloc(16 * height * 4, 255), width: 16, height });

  it('are not aligned at all, rather than at any cost', () => {
    assert.equal(align(blank(20_000), blank(900)), null);
  });

  it('are still aligned up to the budget', () => {
    // As many rows as fit with the narrowest band, and one more that does not.
    const most = Math.floor(BUDGET / (2 * 96 + 1)) - 1;
    assert.ok(align(blank(most), blank(most - 1)));
    assert.equal(align(blank(most + 1), blank(most)), null);
    assert.ok(align(blank(10_000), blank(9_000)), 'a thousand rows more is still a page that moved');
  });

  it('are compared by position instead', () => {
    const a = white(20_000);
    const b = white(900);

    const { result } = diffImages(a, b, OPTIONS);
    const positional = diffImages(a, b, { ...OPTIONS, alignRows: false }).result;

    assert.equal(result.aligned, null);
    assert.equal(result.unaligned, null);
    assert.equal(result.diffPixels, positional.diffPixels);
    assert.equal(result.height, 20_000);
  });
});
