import { crc32, deflateSync } from 'node:zlib';
import type { PNG } from 'pngjs';

/**
 * Writes a difference picture as an indexed PNG.
 *
 * The picture is a page in greys with a few marks on it, and the greys are not
 * a whole range: pixelmatch blends towards white at a quarter, so they run
 * from 191 to 255, and the tinted rows run along one line each. That is under
 * two hundred colours on a real page -- so three bytes a pixel are two more
 * than the picture needs, and deflate is being asked to find that out again on
 * every scanline.
 *
 * A palette says it once. The picture is identical, the file is around two
 * fifths smaller, and it is faster to write for the same reason it is smaller.
 * pngjs cannot write colour type 3, which is why the chunks are here.
 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Beyond this the picture is not a palette picture and has to stay truecolor. */
const PALETTE_LIMIT = 256;

/**
 * The picture as an indexed PNG, or null when it holds too many colours.
 *
 * Null is not a failure: it is the answer for a picture that a palette cannot
 * describe, and the caller writes it the way it always did.
 */
export function indexedPng(image: PNG): Buffer | null {
  const { width, height } = image;
  const palette: number[] = [];
  const seen = new Map<number, number>();
  const indices = Buffer.alloc(width * height);

  for (let at = 0, pixel = 0; pixel < indices.length; at += 4, pixel += 1) {
    const colour = (image.data[at]! << 16) | (image.data[at + 1]! << 8) | image.data[at + 2]!;
    let index = seen.get(colour);
    if (index === undefined) {
      if (seen.size === PALETTE_LIMIT) return null;
      index = seen.size;
      seen.set(colour, index);
      palette.push(colour);
    }
    indices[pixel] = index;
  }

  // No filter. On indexed data a filter subtracts one palette position from
  // another, which is arithmetic on numbers that mean nothing next to each
  // other -- it makes the bytes less repetitive, not more.
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y += 1) {
    indices.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 3; // colour type: indexed
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const table = Buffer.alloc(palette.length * 3);
  for (const [at, colour] of palette.entries()) {
    table[at * 3] = (colour >> 16) & 0xff;
    table[at * 3 + 1] = (colour >> 8) & 0xff;
    table[at * 3 + 2] = colour & 0xff;
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('PLTE', table),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(body) >>> 0, 0);

  return Buffer.concat([length, body, check]);
}
