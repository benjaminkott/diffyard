/**
 * What the difference picture is drawn in, and what counts as a difference in
 * it.
 *
 * Everything that reads the picture back -- the profile, the regions, the
 * pictures set aside -- has to agree with the number the comparison was scored
 * on, so the test for "this pixel counted" lives here and nowhere else.
 */

/**
 * What a set-aside pixel is drawn in.
 *
 * Distinct from the red and orange of a counted difference and from the greys
 * of an unchanged page, so the picture and the number agree with each other:
 * everything red is in the percentage, everything blue was found and set
 * aside. No blend of the row tints lands on it, which is what lets everything
 * downstream tell them apart by value.
 */
export const ASIDE: readonly [number, number, number] = [120, 150, 220];

/**
 * What pixelmatch draws an anti-aliased pixel in, with antialiasing ignored.
 *
 * It is drawn but not counted -- that is what ignoring it means -- so anything
 * working from the picture has to leave it out too, or it works with a larger
 * number than the comparison was scored on. Taking these for changes made the
 * areas below them look real, and subtracting them from a count they were
 * never in produced a negative percentage.
 */
const ANTIALIASED: readonly [number, number, number] = [255, 255, 0];

/** Whether a pixel of the difference picture is drawn as a counted change. */
export function isMarked(red: number, green: number, blue: number): boolean {
  if (red === ASIDE[0] && green === ASIDE[1] && blue === ASIDE[2]) return false;
  if (red === ANTIALIASED[0] && green === ANTIALIASED[1] && blue === ANTIALIASED[2]) return false;
  return Math.abs(red - green) > 25 || Math.abs(green - blue) > 25;
}
