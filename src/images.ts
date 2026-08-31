import { PNG } from 'pngjs';
import sharp from 'sharp';
import type { ImageFormat } from './types.js';

/**
 * Storing the screenshots smaller.
 *
 * A run of nine hundred pages keeps 1.9 GB of screenshots, and they are the
 * one part of a run PNG cannot shrink further: Chromium already writes them
 * near the floor -- repacking them with any filter or strategy comes out the
 * same size or larger. Lossless WebP takes another two fifths off.
 *
 * Lossless is not a preference here. `--reuse` reads a stored side back and
 * compares against it, so a picture that came back even slightly different
 * would be reported as a difference in the page.
 *
 * The difference picture is not part of this: a palette already holds it in
 * fewer bytes than WebP would, and it stays a PNG anyone can open. See
 * indexed.ts.
 */

/** Raw pixels, in the shape pngjs and pixelmatch pass around: RGBA, row by row. */
export interface Pixels {
  data: Buffer;
  width: number;
  height: number;
}

/** The format screenshots are stored in for this run. */
export function storageFormat(setting: ImageFormat): 'png' | 'webp' {
  return setting;
}

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

  return image.webp({ lossless: true, effort: 1 }).toBuffer();
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
