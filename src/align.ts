/**
 * Matching two sequences of rows up before comparing them.
 *
 * A page that moved down by fourteen pixels is not fourteen pixels different —
 * it is the same page, shifted. Compared position against position, every row
 * below the shift counts as changed, and a difference of 46% is reported for a
 * change a reader would call none. The number stops meaning anything, and
 * findings can no longer be ranked by how bad they are.
 *
 * Rows are matched on similarity, not on equality. Two rows of a photograph
 * that look the same almost never come out byte-identical, so matching on a
 * hash finds a few hundred anchors in eight thousand rows and pairs everything
 * between them in order — which is worse than not aligning at all.
 */

export type Edit =
  | { type: 'match'; a: number; b: number }
  /** Rows that correspond but differ — a paragraph rewritten, not replaced. */
  | { type: 'change'; a: number; b: number }
  | { type: 'remove'; a: number }
  | { type: 'add'; b: number };

/** Signatures for every row of an image: `buckets` averages per row. */
export interface RowSignatures {
  values: Float32Array;
  buckets: number;
  count: number;
}

/** How far a row may have moved before we stop looking for it. */
const BAND = 96;

/** Mean per-bucket distance under which two rows count as the same row. */
const SAME = 6;

/** What a gap costs, against a matched pair's 1. */
const GAP = 0.6;

/**
 * Aligns two sequences of row signatures.
 *
 * The search runs in a band around the diagonal: a row that moved by more than
 * a screenful is not the same row any more, and a full quadratic search over a
 * page eight thousand rows tall is not worth its time.
 */
export function align(a: RowSignatures, b: RowSignatures): Edit[] {
  const rowsA = a.count;
  const rowsB = b.count;

  if (rowsA === 0 || rowsB === 0) {
    return [
      ...Array.from({ length: rowsA }, (_, index): Edit => ({ type: 'remove', a: index })),
      ...Array.from({ length: rowsB }, (_, index): Edit => ({ type: 'add', b: index })),
    ];
  }

  // Wide enough to cover the difference in length, or the end of the longer
  // page falls outside the band.
  const band = Math.min(Math.max(BAND, Math.abs(rowsA - rowsB) + 8), Math.max(rowsA, rowsB));
  const width = 2 * band + 1;

  // The best score reachable from (i, j), stored as a band around the
  // diagonal: index (i * width) + (j - i + band).
  const score = new Float32Array((rowsA + 1) * width).fill(-Infinity);

  const read = (i: number, j: number): number => {
    if (i < 0 || j < 0 || i > rowsA || j > rowsB) return -Infinity;
    const offset = j - i + band;
    if (offset < 0 || offset >= width) return -Infinity;
    return score[i * width + offset]!;
  };

  // Filled from the end, so the traceback can walk forwards.
  for (let i = rowsA; i >= 0; i -= 1) {
    for (let offset = width - 1; offset >= 0; offset -= 1) {
      const j = i + offset - band;
      if (j < 0 || j > rowsB) continue;

      if (i === rowsA && j === rowsB) {
        score[i * width + offset] = 0;
        continue;
      }

      const diagonal = i < rowsA && j < rowsB ? read(i + 1, j + 1) + pairScore(a, i, b, j) : -Infinity;
      const down = i < rowsA ? read(i + 1, j) - GAP : -Infinity;
      const right = j < rowsB ? read(i, j + 1) - GAP : -Infinity;

      score[i * width + offset] = Math.max(diagonal, down, right);
    }
  }

  const edits: Edit[] = [];
  let i = 0;
  let j = 0;

  while (i < rowsA || j < rowsB) {
    if (i >= rowsA) {
      edits.push({ type: 'add', b: j });
      j += 1;
      continue;
    }
    if (j >= rowsB) {
      edits.push({ type: 'remove', a: i });
      i += 1;
      continue;
    }

    const diagonal = read(i + 1, j + 1) + pairScore(a, i, b, j);
    const down = read(i + 1, j) - GAP;
    const right = read(i, j + 1) - GAP;
    const best = Math.max(diagonal, down, right);

    if (best === -Infinity) {
      // Outside the band on both sides: nothing left to align, so the rest is
      // taken as it comes.
      edits.push({ type: 'change', a: i, b: j });
      i += 1;
      j += 1;
      continue;
    }

    if (best === diagonal) {
      edits.push({ type: similar(a, i, b, j) ? 'match' : 'change', a: i, b: j });
      i += 1;
      j += 1;
    } else if (best === down) {
      edits.push({ type: 'remove', a: i });
      i += 1;
    } else {
      edits.push({ type: 'add', b: j });
      j += 1;
    }
  }

  return edits;
}

/** Mean absolute distance between two rows, across their buckets. */
function distance(a: RowSignatures, i: number, b: RowSignatures, j: number): number {
  const buckets = a.buckets;
  const offsetA = i * buckets;
  const offsetB = j * buckets;
  let total = 0;

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    total += Math.abs(a.values[offsetA + bucket]! - b.values[offsetB + bucket]!);
  }

  return total / buckets;
}

function similar(a: RowSignatures, i: number, b: RowSignatures, j: number): boolean {
  return distance(a, i, b, j) <= SAME;
}

/**
 * What putting two rows together is worth.
 *
 * Rows that look the same score highest, rows that merely resemble each other
 * still beat a gap, and rows with nothing in common score below one — so the
 * alignment would rather admit an insertion than pair two unrelated rows.
 */
function pairScore(a: RowSignatures, i: number, b: RowSignatures, j: number): number {
  const apart = distance(a, i, b, j);
  if (apart <= SAME) return 1;
  if (apart <= SAME * 4) return 0.2;
  return -0.8;
}
