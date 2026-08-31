import type { PNG } from 'pngjs';
import { ASIDE, isMarked } from './marks.js';
import type { Picture } from './types.js';

/**
 * The same picture, delivered differently.
 *
 * Two systems rarely serve a photograph as the same file. An asset pipeline
 * that re-encodes it, or scales it with a different filter, moves every edge
 * in the picture by a shade: measured across two builds of one site, sixty per
 * cent of a page's pixels differed by something, and the difference sat in the
 * photographs. Nobody can see any of it, and it fails every page that has a
 * picture on it.
 *
 * The obvious ways out are both wrong. A colour tolerance forgives a real
 * change as readily as it forgives noise -- an edge shifted by half a pixel is
 * a difference of two hundred levels, so no tolerance that hides the noise
 * keeps the change. A smallest-area rule fails for the same reason from the
 * other side: measured, the noise of one photograph came in areas of up to
 * nine hundred pixels, while a changed word is thirty.
 *
 * What separates them is whether it is still there when you stop looking
 * closely. Averaged over eight-by-eight blocks, a photograph delivered twice
 * differs by a couple of levels; a line of text that changed differs by eighty,
 * and a picture swapped for another one by two hundred and thirty. That is the
 * question this asks, and it asks it only where the page says there is a
 * picture -- so a difference of the same shape anywhere else still counts.
 */

/** A rectangle in screenshot pixels, as side A has it. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** How many rows further down side B puts the same picture. */
  offset: number;
  /**
   * How much shorter or taller B draws it. Measured across a real upgrade:
   * 1,329 of 19,229 pictures came out exactly one pixel shorter on the new
   * system, which is a rounding difference in how a height is worked out from
   * an aspect ratio -- and the reason those pages ended a few rows short.
   */
  shorter: number;
  /** What the page said is in it, for the report to name. */
  src: string;
}

/** How far two rectangles may sit apart and still be the same one. */
const NUDGE = 2;

/** Side of the blocks the two sides are averaged over before comparing. */
const BLOCK = 8;

/**
 * How far two blocks may differ, averaged, and still be the same picture.
 *
 * Measured on real pairs: a page's photographs, delivered by two systems, came
 * to a peak of 27 across the page and under 2 inside most pictures. Planted
 * changes of the smallest kind worth catching -- a line of text, a button --
 * came to 80 and 235. Twelve sits in the gap with room on both sides.
 */
const SAME_PICTURE = 12;

/**
 * How much of a picture may be over that line and still be the same picture.
 *
 * Judging on the single worst block was too brittle to be useful: measured
 * over a gallery of fifty-seven photographs, several came to 12.4, 12.1 and
 * 13.5 with a tenth of a per cent of their blocks over the line -- three
 * blocks out of seven hundred, at the hard edges the scaler moved -- and the
 * whole picture was then reported as changed. A real change is not three
 * blocks in a thousand: a planted line of text put every block of its area
 * over, and a swapped picture put all of them over.
 */
const OVER = 0.01;

/**
 * Where no share of blocks is small enough to excuse it.
 *
 * A picture that differs this much somewhere differs visibly somewhere, and no
 * counting of how little of it that was should set it aside. The planted line
 * of text came to eighty.
 */
const NEVER = SAME_PICTURE * 3;

/**
 * Where both sides agree there is a picture.
 *
 * Matched by shape and column rather than by what it points at: the address is
 * exactly what differs when a pipeline re-processes a file, so requiring it to
 * match would leave out every case this exists for.
 *
 * And not by row. A page a few pixels shorter than the other puts every
 * picture below the difference a few rows over, and asking for two rows lost
 * 600 of 1,411 pictures on the failing comparisons of a real run -- every one
 * of them present on both sides, in the same column, at the same size. Where
 * the two pages meet is what the row matching already worked out; this only
 * says the area is a picture on both sides, and what is in it is still decided
 * by looking.
 */
export function shared(a: Picture[], b: Picture[]): Rect[] {
  const rects: Rect[] = [];

  for (const picture of a) {
    const other = b.find(
      (candidate) =>
        Math.abs(candidate.x - picture.x) <= NUDGE &&
        Math.abs(candidate.width - picture.width) <= NUDGE &&
        Math.abs(candidate.height - picture.height) <= NUDGE
    );

    if (!other) continue;
    rects.push({
      x: picture.x,
      y: picture.y,
      width: picture.width,
      height: picture.height,
      offset: other.y - picture.y,
      shorter: picture.height - other.height,
      src: picture.src,
    });
  }

  return rects;
}

/**
 * How the rows of the difference picture line up with the two sides.
 *
 * Without alignment this is the identity: output row n is row n of both. With
 * it, rows were matched up before being compared, so the output row a picture
 * lands on is not the row it sits on in either page.
 */
export interface Rows {
  /** Row of the difference picture holding this row of A, or -1. */
  fromA: Int32Array;
  /** Row of A drawn at this row of the difference picture, or -1. */
  toA: Int32Array;
  /** Row of B compared against this row of the difference picture, or -1. */
  toB: Int32Array;
}

export function rowsInOrder(height: number): Rows {
  const fromA = new Int32Array(height);
  const toA = new Int32Array(height);
  const toB = new Int32Array(height);
  for (let y = 0; y < height; y += 1) {
    fromA[y] = y;
    toA[y] = y;
    toB[y] = y;
  }
  return { fromA, toA, toB };
}

/**
 * The same question, asked of every block of the page that still holds a mark.
 *
 * Measured on the run this was built for: once the pictures were set aside, 99
 * per cent of what was still counted sat outside every rectangle -- logos,
 * icons, text the two systems hinted differently -- and nine tenths of that
 * was equally invisible. A page came to 0.455%, of which 0.045% could be seen
 * at all.
 *
 * Stricter than a picture, in two ways, because there is no picture here to
 * vouch for it: every block has to be quiet on its own, and none of them is
 * measured against the positions around it. That slack is for two pipelines
 * scaling one photograph; applied to the whole page it also excuses an area
 * that grew a shade darker, which is a change somebody made.
 */
export function setAsideQuiet(a: PNG, b: PNG, diff: PNG, rows: Rows): number {
  let aside = 0;

  for (let y = 0; y < diff.height; y += BLOCK) {
    for (let x = 0; x < diff.width; x += BLOCK) {
      const marks = marksIn(diff, x, y);
      if (marks === 0) continue;

      // Only where the block can be compared in full. A page longer than the
      // other has rows nothing was compared against, and judging those on the
      // rows above them would set aside the very difference they are.
      const across = Math.min(BLOCK, diff.width - x);
      const down = Math.min(BLOCK, diff.height - y);
      const delta = blockDelta(a, b, x, y, 0, 0, rows, diff, x + across, y + down, across * down);
      if (delta === null || delta > SAME_PICTURE) continue;

      aside += repaintBlock(diff, x, y);
    }
  }

  return aside;
}

/** How many pixels of this block are drawn as a counted difference. */
function marksIn(diff: PNG, x0: number, y0: number): number {
  let marks = 0;

  for (let y = y0; y < Math.min(y0 + BLOCK, diff.height); y += 1) {
    for (let x = x0; x < Math.min(x0 + BLOCK, diff.width); x += 1) {
      const at = (diff.width * y + x) << 2;
      if (isMarked(diff.data[at]!, diff.data[at + 1]!, diff.data[at + 2]!)) marks += 1;
    }
  }

  return marks;
}

function repaintBlock(diff: PNG, x0: number, y0: number): number {
  let repainted = 0;

  for (let y = y0; y < Math.min(y0 + BLOCK, diff.height); y += 1) {
    for (let x = x0; x < Math.min(x0 + BLOCK, diff.width); x += 1) {
      const at = (diff.width * y + x) << 2;
      if (!isMarked(diff.data[at]!, diff.data[at + 1]!, diff.data[at + 2]!)) continue;
      diff.data[at] = ASIDE[0];
      diff.data[at + 1] = ASIDE[1];
      diff.data[at + 2] = ASIDE[2];
      diff.data[at + 3] = 255;
      repainted += 1;
    }
  }

  return repainted;
}

/** A picture set aside, and why, for the report to say. */
export interface SetAside {
  rect: Rect;
  pixels: number;
  /** Biggest block-level difference found inside it. */
  delta: number;
}

export interface Verdict {
  /** Marked pixels repainted because the picture is the same picture. */
  pixels: number;
  pictures: SetAside[];
  /** Pictures both sides have that they do not draw at the same size. */
  resized: number;
}

/**
 * Sets aside the pictures the two sides agree on, and says how much that was.
 *
 * Only the marked pixels inside such a rectangle are repainted: a picture that
 * is the same picture may still sit next to a heading that changed, and that
 * heading is not in the rectangle.
 */
export function setAsidePictures(a: PNG, b: PNG, diff: PNG, rects: Rect[], rows: Rows): Verdict {
  const pictures: SetAside[] = [];
  let pixels = 0;
  let resized = 0;

  for (const rect of rects) {
    // Counted whatever the pixels then say: a picture the two systems draw at
    // different sizes is a finding on its own, and the one that explains why
    // the page below it no longer lines up.
    if (rect.shorter !== 0) resized += 1;

    const delta = same(a, b, rect, rows);
    if (delta === null) continue;

    const repainted = repaint(diff, rect, rows);
    if (repainted === 0) continue;

    pixels += repainted;
    pictures.push({ rect, pixels: repainted, delta });
  }

  return { pixels, pictures, resized };
}

/**
 * Whether the two versions are the same picture, and by how much they differ
 * where they differ most.
 *
 * Null when they are not. What is asked is what a reader would ask: is it
 * still different when you stop looking closely -- averaged over blocks -- and
 * is it different in more than the odd corner of itself.
 */
function same(a: PNG, b: PNG, rect: Rect, rows: Rows): number | null {
  // Two placements, both of them evidence, and either will do. The first is
  // where the row matching says these two pages meet; the second is where each
  // side's own layout puts this picture. A page that gives up a pixel or two
  // per section has them disagree, and measured over a run's failing
  // comparisons each was right where the other was wrong: 94 pictures excused
  // one way, 118 the other, 142 by one or the other.
  const matched = verdict(blockDeltas(a, b, rect, rows, null));
  if (matched !== null) return matched;
  if (rect.offset === 0) return null;

  return verdict(blockDeltas(a, b, rect, rows, rect.offset));
}

/** Whether a rectangle's blocks say the two sides hold the same picture. */
function verdict(deltas: number[] | null): number | null {
  if (deltas === null || deltas.length === 0) return null;

  const sorted = [...deltas].sort((left, right) => left - right);
  const peak = sorted[sorted.length - 1]!;
  if (peak > NEVER) return null;

  const over = sorted.filter((delta) => delta > SAME_PICTURE).length;
  if (over > Math.max(1, Math.floor(sorted.length * OVER))) return null;

  return peak;
}

/**
 * The difference between the two sides inside the rectangle, one number per
 * block, or null where the rectangle is not comparable at all.
 *
 * A block that differs is measured again against the eight positions around
 * it, and the smallest of those counts: two pipelines scaling one picture put
 * it a fraction of a pixel apart, and a hard edge half a pixel over is a block
 * average thirty levels out while being the same edge.
 */
function blockDeltas(a: PNG, b: PNG, rect: Rect, rows: Rows, offset: number | null): number[] | null {
  const deltas: number[] = [];

  const bottom = Math.min(rect.y + rect.height, a.height);
  const right = Math.min(rect.x + rect.width, a.width, b.width);

  for (let y = Math.max(0, rect.y); y < bottom; y += BLOCK) {
    for (let x = Math.max(0, rect.x); x < right; x += BLOCK) {
      const straight = blockDelta(a, b, x, y, 0, 0, rows, null, right, bottom, 0, offset);
      if (straight === null) return null;

      // The neighbours are only worth asking about where the block already
      // fails, which on a page that did not change is almost nowhere.
      let best = straight;
      if (straight > SAME_PICTURE) {
        for (const [dx, dy] of AROUND) {
          const shifted = blockDelta(a, b, x, y, dx, dy, rows, null, right, bottom, 0, offset);
          if (shifted !== null && shifted < best) best = shifted;
          if (best <= SAME_PICTURE) break;
        }
      }

      deltas.push(best);
    }
  }

  return deltas;
}

/**
 * One block of A against the same block of B, shifted by (dx, dy).
 *
 * Averaged over the block and taken as brightness: two pictures that differ in
 * colour and not in brightness differ in brightness somewhere along an edge.
 */
function blockDelta(
  a: PNG,
  b: PNG,
  x: number,
  y: number,
  dx: number,
  dy: number,
  rows: Rows,
  diff: PNG | null,
  right = Math.min(a.width, b.width),
  bottom = diff ? Math.min(a.height, diff.height) : a.height,
  /** Pixels the block must reach for its answer to count. */
  needs = 0,
  /**
   * Rows to look further down on B, instead of asking the row matching. Used
   * for the second placement of a picture: where B's own layout puts it.
   */
  offset: number | null = null
): number | null {
  let leftSum = 0;
  let rightSum = 0;
  let seen = 0;

  for (let downTo = 0; downTo < BLOCK && y + downTo < bottom; downTo += 1) {
    const row = y + downTo;
    // Walked in the difference picture's rows where that is what is being
    // read, and in A's rows where a rectangle of the page is.
    const source = diff ? (rows.toA[row] ?? -1) : row;
    if (source < 0) continue;
    const outRow = diff ? row : (rows.fromA[row] ?? -1);
    if (outRow < 0 && offset === null) continue;
    const bRow = (offset === null ? (rows.toB[outRow] ?? -1) : source + offset) + dy;
    // A row one side does not have at all is not two versions of one thing; it
    // is something that moved, which is a real difference.
    if (bRow < 0 || bRow >= b.height || source >= a.height) return null;

    for (let across = 0; across < BLOCK && x + across < right; across += 1) {
      const bx = x + across + dx;
      if (bx < 0 || bx >= b.width) return null;

      const from = (a.width * source + x + across) << 2;
      const to = (b.width * bRow + bx) << 2;

      leftSum += a.data[from]! * 0.3 + a.data[from + 1]! * 0.59 + a.data[from + 2]! * 0.11;
      rightSum += b.data[to]! * 0.3 + b.data[to + 1]! * 0.59 + b.data[to + 2]! * 0.11;
      seen += 1;
    }
  }

  if (seen === 0 || seen < needs) return null;
  return Math.abs(leftSum - rightSum) / seen;
}


/**
 * Whether a row one side does not have is explained by a picture it draws at
 * another height.
 *
 * Two systems working a picture's height out from an aspect ratio can disagree
 * by a pixel, and then the taller side has one row inside that picture the
 * other has not. It is the same picture at another size -- already reported as
 * that -- and drawing the row as a difference puts a red line across the page
 * for something nobody can see.
 *
 * Only inside such a rectangle, with a row of slack at either end, because
 * that is where the row matching puts the seam. A row anywhere else is a row
 * of content one side does not have, and stays a difference of any size.
 */
export function explainedByAPicture(row: number, rects: Rect[], side: 'a' | 'b'): boolean {
  for (const rect of rects) {
    // A's rectangle is the taller one where `shorter` is positive, so a row A
    // has and B has not sits in it; the other way round for B.
    if (side === 'a' ? rect.shorter <= 0 : rect.shorter >= 0) continue;
    if (row < rect.y - 1) continue;
    if (row > rect.y + rect.height + 1) continue;
    return true;
  }

  return false;
}

/** The eight positions a picture may have slid to, none of them far. */
const AROUND: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
];

/** Repaints the marked pixels inside the rectangle and counts them. */
function repaint(diff: PNG, rect: Rect, rows: Rows): number {
  let repainted = 0;

  const bottom = Math.min(rect.y + rect.height, rows.fromA.length);

  for (let y = Math.max(0, rect.y); y < bottom; y += 1) {
    const outRow = rows.fromA[y] ?? -1;
    if (outRow < 0 || outRow >= diff.height) continue;

    const right = Math.min(rect.x + rect.width, diff.width);
    for (let x = Math.max(0, rect.x); x < right; x += 1) {
      const at = (diff.width * outRow + x) << 2;
      if (!isMarked(diff.data[at]!, diff.data[at + 1]!, diff.data[at + 2]!)) continue;

      diff.data[at] = ASIDE[0];
      diff.data[at + 1] = ASIDE[1];
      diff.data[at + 2] = ASIDE[2];
      diff.data[at + 3] = 255;
      repainted += 1;
    }
  }

  return repainted;
}
