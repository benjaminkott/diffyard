import { PNG } from 'pngjs';
import sharp from 'sharp';
import { indexedPng } from './indexed.js';
import type { ImageFormat } from './types.js';

/**
 * Storing the screenshots smaller.
 *
 * A run of nine hundred pages keeps 1.9 GB of screenshots, and they are the
 * one part of a run PNG cannot shrink further: Chromium already writes them
 * near the floor -- repacking them with any filter or strategy comes out the
 * same size or larger. Lossless WebP takes another two fifths off.
 *
 * Near-lossless, not lossless: libwebp's near-lossless mode preprocesses the
 * pixels so that lossless compression has less to work on, which takes another
 * quarter off. Measured over the borderline comparisons of a 902-page run --
 * the ones sitting either side of the pass threshold, where a shift would show
 * -- it moves the difference by 0.0014 of a percentage point and changes no
 * verdict at all. Plain lossy at quality 90 is far smaller again, and changed
 * two verdicts in seven; that is a different trade and not this one.
 *
 * What makes any of it safe is that the comparison is made on these pictures,
 * not on the ones that came out of the browser. A side taken from an earlier
 * run comes back through the same encoder as the side captured now, so both
 * carry the same treatment. Comparing a fresh capture against a stored one
 * inflated the difference in every pair measured -- 0.028% became 0.365% --
 * which on a `--reuse` run is a failure the page did not earn.
 *
 * The difference picture is the other case, and the opposite one: nothing
 * reads it back, it is only looked at, so it is the one picture here that may
 * lose something. See forDiff.
 */

/** Raw pixels, in the shape pngjs and pixelmatch pass around: RGBA, row by row. */
export interface Pixels {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * WebP holds nothing longer than this in either direction.
 *
 * A full-page screenshot of a long page on a narrow viewport goes past it
 * easily: on a 902-page run, twenty pages did, all of them mobile, the tallest
 * that fitted being 16,122 pixels.
 */
const WEBP_LIMIT = 16383;

/**
 * What a comparison's pictures can actually be stored as.
 *
 * Both sides or neither. The reading is taken from the stored pictures, so a
 * comparison with one side through the encoder and one side not would be
 * measuring the encoder as much as the page -- and this is exactly the case
 * where that would happen, since a page over the limit is being compared
 * against one near it.
 *
 * A format is a decision about the file. It must not cost a comparison, which
 * is what it did: the encoder refused the picture, the capture failed, and the
 * scenario was reported as one that could not be photographed.
 */
export async function formatForPair(setting: ImageFormat, sides: (Buffer | Pixels)[]): Promise<'png' | 'webp'> {
  if (setting === 'png') return 'png';

  for (const side of sides) {
    const { width, height } = Buffer.isBuffer(side) ? await sharp(side).metadata() : side;
    if ((width ?? 0) > WEBP_LIMIT || (height ?? 0) > WEBP_LIMIT) return 'png';
  }

  return 'webp';
}

/**
 * How much the screenshots may lose.
 *
 * They are the measurement, so this is a quality setting for the numbers as
 * much as for the file. 60 is where the size stops falling and the readings
 * have not started moving.
 */
const SHOT_QUALITY = 60;

/**
 * A screenshot in the storage format.
 *
 * Effort 1 rather than 6: the last five levels buy under three percent and
 * cost seven times the work, on pictures nobody reads with a magnifier.
 */
export async function forStorage(source: Buffer | Pixels, format: 'png' | 'webp'): Promise<Buffer> {
  if (format === 'png') {
    return Buffer.isBuffer(source) ? source : encodePng(source);
  }

  const image = Buffer.isBuffer(source)
    ? sharp(source)
    : sharp(source.data, { raw: { width: source.width, height: source.height, channels: 4 } });

  return image.webp({ nearLossless: true, quality: SHOT_QUALITY, effort: 1 }).toBuffer();
}

/**
 * A stored screenshot as pixels again.
 *
 * Null for a PNG, which the caller reads with pngjs as it always did -- this
 * is only the way in for the format pngjs does not know.
 */
export async function toPixels(stored: Buffer, format: 'png' | 'webp'): Promise<Pixels | null> {
  if (format === 'png') return null;

  const { data, info } = await sharp(stored).raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 4) return { data, width: info.width, height: info.height };

  // libwebp drops an alpha channel nothing uses; pixelmatch wants four.
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let from = 0, to = 0; to < rgba.length; from += info.channels, to += 4) {
    rgba[to] = data[from]!;
    rgba[to + 1] = data[from + 1]!;
    rgba[to + 2] = data[from + 2]!;
    rgba[to + 3] = 255;
  }
  return { data: rgba, width: info.width, height: info.height };
}

/**
 * Quality for the difference picture.
 *
 * Nothing reads this picture back -- it is looked at, to see where on the page
 * something moved -- so it is the one that may lose a little. At 80 the marks
 * stay visible on 99.9% of the pixels that carry them, and every pixel that
 * gains colour is within two rows of a real mark: ringing around what changed,
 * never a mark where nothing did. Measured over a run of nine hundred pages;
 * the page behind the marks comes back within half a level of grey.
 */
const DIFF_QUALITY = 80;

/**
 * The difference picture, ready to be written.
 *
 * As WebP it is about a third of the palette PNG. As PNG it is that palette:
 * the picture holds under two hundred colours by construction, so a byte a
 * pixel says everything three did. See indexed.ts.
 */
export async function forDiff(image: PNG, format: 'png' | 'webp'): Promise<Buffer> {
  if (format === 'png') {
    return indexedPng(image) ?? PNG.sync.write(image, DIFF_PNG);
  }

  return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
    .webp({ quality: DIFF_QUALITY, effort: 1 })
    .toBuffer();
}

/** What the palette cannot hold falls back to what it was written as before. */
const DIFF_PNG = { deflateLevel: 9, deflateStrategy: 1, colorType: 2, inputHasAlpha: true } as const;

/** The format a stored screenshot is in, read off the name it was written as. */
export function formatOf(file: string): 'png' | 'webp' {
  return file.endsWith('.webp') ? 'webp' : 'png';
}

/** Pixels back into a PNG, for a side stored as WebP joining a run writing PNG. */
function encodePng(pixels: Pixels): Buffer {
  const image = new PNG({ width: pixels.width, height: pixels.height });
  pixels.data.copy(image.data);
  return PNG.sync.write(image, { deflateLevel: 9, colorType: 2, inputHasAlpha: true });
}
