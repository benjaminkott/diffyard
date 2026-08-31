import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { align } from './align.js';
import type { Edit, RowSignatures } from './align.js';
import type { DiffRegion, DiffResult } from './types.js';

export interface DiffOptions {
  /** Colour distance tolerance handed to pixelmatch, 0..1. */
  pixelThreshold: number;
  ignoreAntialiasing: boolean;
  /** Match rows up before comparing, so a shifted page is not a changed one. */
  alignRows: boolean;
}

export interface DiffOutput {
  result: DiffResult;
  /**
   * The difference picture, as pixels: unchanged ones dimmed, changes in red.
   *
   * Not encoded here. Comparing and storing are two decisions -- what differs,
   * and how small the record of it has to be -- and only the second one cares
   * which format the run was asked for. See images.ts.
   */
  image: PNG;
}

/** Number of bands the height is split into for the difference profile. */
const PROFILE_BANDS = 64;

/** Rows with fewer differing pixels than this are not worth calling a region. */
const REGION_FLOOR = 0.002;

/** Tint laid over rows that exist on one side only. */
const ADDED_TINT: [number, number, number] = [30, 160, 90];
const REMOVED_TINT: [number, number, number] = [190, 60, 60];

/**
 * Compares two screenshots.
 *
 * With row alignment — the default — the two pages are matched up before being
 * compared, so a page that moved down by fourteen pixels is reported as a page
 * that moved, not as one that changed everywhere below the shift. Without it,
 * pixels are compared where they sit.
 */
/**
 * How the difference picture is written.
 *
 * It is looked at and nothing else — the numbers come from the comparison,
 * and no later run reads it back — so it is written for size rather than for
 * being decoded again. Both settings are lossless: the picture carries no
 * transparency, and Z_FILTERED suits the long flat runs a greyed-out page is
 * made of. Together they take a third off, which on a suite of nine hundred is
 * the difference between a folder somebody keeps and one they delete.
 *
 * The screenshots themselves are left exactly as the browser encoded them:
 * they are the measurement, they are read back when a side is reused, and
 * pngjs writes them larger than Chromium did anyway.
 */

/**
 * Either the encoded picture or the pixels already out of it.
 *
 * A side taken from an earlier run may have been stored as WebP, and pngjs
 * cannot read that. Decoding it back to a PNG only to decode that again would
 * be two encodes to avoid one branch.
 */
export type Source = Buffer | { data: Buffer; width: number; height: number };

function read(source: Source): PNG {
  if (Buffer.isBuffer(source)) return PNG.sync.read(source);
  const image = new PNG({ width: source.width, height: source.height });
  source.data.copy(image.data);
  return image;
}

export function diffImages(bufferA: Source, bufferB: Source, options: DiffOptions): DiffOutput {
  const a = read(bufferA);
  const b = read(bufferB);

  const sizes = {
    sizeMismatch: a.width !== b.width || a.height !== b.height,
    sizeA: { width: a.width, height: a.height },
    sizeB: { width: b.width, height: b.height },
  };

  const positional = comparePositionally(a, b, options);

  if (!options.alignRows || a.width !== b.width) {
    // Alignment works row by row; two pages of different width have nothing to
    // line up, and the positional comparison is the honest answer.
    return {
      result: {
        ...positional.stats,
        ...sizes,
        aligned: null,
        unaligned: null,
      },
      image: positional.image,
    };
  }

  const aligned = compareAligned(a, b, options);

  if (aligned.stats.ratio >= positional.stats.ratio) {
    // No shift worth taking out. Reporting the alignment anyway would make two
    // identical pages look different, because a row whose colour sits on a
    // quantisation edge hashes differently on the two sides and is then
    // counted as one row removed and another added.
    return {
      result: {
        ...positional.stats,
        ...sizes,
        aligned: aligned.shift.shift === 0 ? null : aligned.shift,
        unaligned: null,
      },
      image: positional.image,
    };
  }

  return {
    result: {
      ...aligned.stats,
      ...sizes,
      aligned: aligned.shift,
      // Kept so the raw number is still there when someone wants to know how
      // much of the page moved rather than changed.
      unaligned: { ratio: positional.stats.ratio, diffPixels: positional.stats.diffPixels },
    },
    image: aligned.image,
  };
}

interface Stats {
  diffPixels: number;
  totalPixels: number;
  ratio: number;
  width: number;
  height: number;
  profile: number[];
  regions: DiffRegion[];
}

/** Pixels compared where they sit, both pages padded to the union size. */
function comparePositionally(a: PNG, b: PNG, options: DiffOptions): { image: PNG; stats: Stats } {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);

  const image = new PNG({ width, height });
  const diffPixels = pixelmatch(
    pad(a, width, height).data,
    pad(b, width, height).data,
    image.data,
    width,
    height,
    {
      threshold: options.pixelThreshold,
      includeAA: !options.ignoreAntialiasing,
      alpha: 0.25,
      diffColor: [255, 0, 0],
      diffColorAlt: [255, 128, 0],
    }
  );

  return { image, stats: summarise(image, width, height, diffPixels) };
}

/**
 * Rows matched up first, then compared.
 *
 * The result is drawn as the union of both pages: rows they share show their
 * pixel differences, rows only one side has are tinted, so an insertion reads
 * as an insertion instead of turning everything under it red.
 */
function compareAligned(
  a: PNG,
  b: PNG,
  options: DiffOptions
): { image: PNG; stats: Stats; shift: NonNullable<DiffResult['aligned']> } {
  const width = a.width;
  const edits = align(signatures(a), signatures(b));

  const image = new PNG({ width, height: Math.max(1, edits.length) });
  const rowA = new PNG({ width, height: 1 });
  const rowB = new PNG({ width, height: 1 });
  const rowOut = new PNG({ width, height: 1 });

  let diffPixels = 0;
  let addedRows = 0;
  let removedRows = 0;

  for (const [index, edit] of edits.entries()) {
    if (edit.type === 'match' || edit.type === 'change') {
      copyRow(a, edit.a, rowA);
      copyRow(b, edit.b, rowB);

      diffPixels += pixelmatch(rowA.data, rowB.data, rowOut.data, width, 1, {
        threshold: options.pixelThreshold,
        includeAA: !options.ignoreAntialiasing,
        alpha: 0.25,
        diffColor: [255, 0, 0],
        diffColorAlt: [255, 128, 0],
      });

      rowOut.data.copy(image.data, (width * index) << 2);
      continue;
    }

    // A row one side does not have at all: every pixel of it is a difference.
    const source = edit.type === 'add' ? b : a;
    const at = edit.type === 'add' ? edit.b : edit.a;
    tintRow(source, at, image, index, width, edit.type === 'add' ? ADDED_TINT : REMOVED_TINT);

    diffPixels += width;
    if (edit.type === 'add') addedRows += 1;
    else removedRows += 1;
  }

  return {
    image,
    stats: summarise(image, width, image.height, diffPixels),
    shift: { addedRows, removedRows, shift: addedRows - removedRows },
  };
}

function summarise(image: PNG, width: number, height: number, diffPixels: number): Stats {
  const perRow = countPerRow(image, width, height);
  const totalPixels = width * height;

  return {
    diffPixels,
    totalPixels,
    ratio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    width,
    height,
    profile: bandProfile(perRow, width, height),
    regions: regionsOf(perRow, width),
  };
}

/**
 * A short vector per row: average brightness across sixteen columns.
 *
 * Kept as numbers rather than hashed, because the alignment needs to ask how
 * close two rows are. Two rows of a photograph that look the same differ by a
 * shade or two, and any hash of them differs completely.
 */
function signatures(image: PNG): RowSignatures {
  const buckets = 16;
  const perBucket = Math.max(1, Math.floor(image.width / buckets));
  const values = new Float32Array(image.height * buckets);

  for (let y = 0; y < image.height; y += 1) {
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = bucket * perBucket;
      const end = Math.min(image.width, start + perBucket);
      let sum = 0;

      for (let x = start; x < end; x += 1) {
        const at = (image.width * y + x) << 2;
        sum += image.data[at]! * 0.3 + image.data[at + 1]! * 0.59 + image.data[at + 2]! * 0.11;
      }

      values[y * buckets + bucket] = end > start ? sum / (end - start) : 0;
    }
  }

  return { values, buckets, count: image.height };
}

function copyRow(source: PNG, y: number, target: PNG): void {
  const from = (source.width * y) << 2;
  source.data.copy(target.data, 0, from, from + (source.width << 2));
}

/** Draws a row dimmed and washed with a colour, the way pixelmatch dims. */
function tintRow(
  source: PNG,
  y: number,
  target: PNG,
  targetY: number,
  width: number,
  tint: [number, number, number]
): void {
  for (let x = 0; x < width; x += 1) {
    const from = (source.width * y + x) << 2;
    const to = (width * targetY + x) << 2;

    const grey =
      source.data[from]! * 0.3 + source.data[from + 1]! * 0.59 + source.data[from + 2]! * 0.11;
    const faded = 255 - (255 - grey) * 0.25;

    target.data[to] = Math.round(faded * 0.45 + tint[0] * 0.55);
    target.data[to + 1] = Math.round(faded * 0.45 + tint[1] * 0.55);
    target.data[to + 2] = Math.round(faded * 0.45 + tint[2] * 0.55);
    target.data[to + 3] = 255;
  }
}

/** Differing pixels per row of the diff image. */
function countPerRow(diff: PNG, width: number, height: number): number[] {
  const counts = new Array<number>(height).fill(0);

  for (let y = 0; y < height; y += 1) {
    let changed = 0;

    for (let x = 0; x < width; x += 1) {
      const at = (width * y + x) << 2;
      const red = diff.data[at]!;
      const green = diff.data[at + 1]!;
      const blue = diff.data[at + 2]!;
      // Changed pixels are drawn red, orange or tinted; unchanged ones are grey.
      if (Math.abs(red - green) > 25 || Math.abs(green - blue) > 25) changed += 1;
    }

    counts[y] = changed;
  }

  return counts;
}

/** Coarse shape of the differences down the page, for the report's minimap. */
function bandProfile(perRow: number[], width: number, height: number): number[] {
  const bands = Math.min(PROFILE_BANDS, Math.max(1, height));
  const counts = new Array<number>(bands).fill(0);
  const perBand = height / bands;

  for (let y = 0; y < height; y += 1) {
    const band = Math.min(bands - 1, Math.floor(y / perBand));
    counts[band] = (counts[band] ?? 0) + (perRow[y] ?? 0);
  }

  const pixelsPerBand = Math.max(1, width * perBand);
  return counts.map((count) => Math.min(1, count / pixelsPerBand));
}

/**
 * Runs of differing rows, merged across short quiet stretches.
 *
 * "y 1616 to 1827, 211px tall" is something you can go and look at; one
 * percentage for a page eight thousand pixels tall is not.
 */
function regionsOf(perRow: number[], width: number): DiffRegion[] {
  const floor = Math.max(1, Math.round(width * REGION_FLOOR));
  // A heading and the paragraph under it are one finding, not two, so a few
  // untouched rows between them do not split the region.
  const bridge = 8;

  const regions: DiffRegion[] = [];
  let start = -1;
  let quiet = 0;
  let changed = 0;

  const close = (end: number) => {
    if (start === -1) return;
    const height = end - start;
    regions.push({
      from: start,
      to: end,
      height,
      ratio: height > 0 ? Math.min(1, changed / (height * width)) : 0,
    });
    start = -1;
    changed = 0;
  };

  for (let y = 0; y < perRow.length; y += 1) {
    const count = perRow[y] ?? 0;

    if (count >= floor) {
      if (start === -1) start = y;
      quiet = 0;
      changed += count;
      continue;
    }

    if (start === -1) continue;

    quiet += 1;
    changed += count;
    if (quiet > bridge) close(y - quiet + 1);
  }

  close(perRow.length);

  // Largest first: the biggest stretch is the one worth opening.
  return regions.sort((left, right) => right.height - left.height).slice(0, 50);
}

/** Copies an image into a transparent canvas of the given size, top-left aligned. */
function pad(image: PNG, width: number, height: number): PNG {
  if (image.width === width && image.height === height) return image;

  const canvas = new PNG({ width, height, fill: true });
  canvas.data.fill(0);
  PNG.bitblt(image, canvas, 0, 0, image.width, image.height, 0, 0);
  return canvas;
}

export type { Edit };
