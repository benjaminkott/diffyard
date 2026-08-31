import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { diffImages } from '../dist/diff.js';

const OPTIONS = { pixelThreshold: 0.1, ignoreAntialiasing: true, alignRows: false };

/** Builds a solid PNG, optionally with one differently coloured band. */
function png(
  width: number,
  height: number,
  colour: [number, number, number],
  band?: { from: number; to: number; colour: [number, number, number] }
): Buffer {
  const image = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    const inBand = band && y >= band.from && y < band.to;
    const [r, g, b] = inBand ? band.colour : colour;

    for (let x = 0; x < width; x += 1) {
      const at = (width * y + x) << 2;
      image.data[at] = r;
      image.data[at + 1] = g;
      image.data[at + 2] = b;
      image.data[at + 3] = 255;
    }
  }

  return PNG.sync.write(image);
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

/**
 * How the difference picture is written.
 *
 * It is a page in greys with a few marks on it -- under two hundred colours --
 * and it used to be written as truecolor, three bytes a pixel to say so. What
 * is pinned here is that the palette costs nothing: same picture, fewer bytes,
 * and a picture a palette cannot hold still gets written.
 */
describe('the difference picture', () => {
  const pixels = (buffer: Buffer): PNG => PNG.sync.read(buffer);

  it('is written with a palette', () => {
    const { png: written } = diffImages(
      png(40, 40, WHITE, { from: 10, to: 20, colour: BLACK }),
      png(40, 40, WHITE, { from: 12, to: 22, colour: BLACK }),
      OPTIONS
    );

    assert.equal(written.readUInt8(25), 3, 'colour type 3 is indexed');
    assert.ok(written.includes(Buffer.from('PLTE', 'latin1')), 'and it carries its palette');
  });

  it('shows exactly what it showed before', () => {
    const a = png(40, 40, WHITE, { from: 10, to: 20, colour: BLACK });
    const b = png(40, 40, WHITE, { from: 12, to: 22, colour: BLACK });

    const written = pixels(diffImages(a, b, OPTIONS).png);
    // Rewritten as truecolor and read back: the bytes differ, the picture does not.
    const again = pixels(PNG.sync.write(written, { colorType: 2, inputHasAlpha: true }));

    assert.equal(written.width, again.width);
    assert.equal(written.height, again.height);
    for (let at = 0; at < written.data.length; at += 4) {
      for (const channel of [0, 1, 2]) {
        assert.equal(written.data[at + channel], again.data[at + channel], `pixel ${at / 4}`);
      }
    }
  });

  it('never needs more colours than a palette holds', () => {
    // Why the palette is always enough, and not a gamble: pixelmatch blends
    // the unchanged page towards white at a quarter, so its greys are 191..255
    // and no more -- 65 of them. Each tinted row runs along one line from those
    // same 65, and the marks are three colours. 198 at the very worst.
    const noisy = (seed: number): Buffer => {
      const image = new PNG({ width: 64, height: 90 });
      let state = seed;
      for (let at = 0; at < image.data.length; at += 4) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        image.data[at] = state & 0xff;
        image.data[at + 1] = (state >> 8) & 0xff;
        image.data[at + 2] = (state >> 16) & 0xff;
        image.data[at + 3] = 255;
      }
      return PNG.sync.write(image);
    };

    const cases: [string, Buffer, Buffer, typeof OPTIONS][] = [
      ['noise against noise', noisy(1), noisy(2), OPTIONS],
      ['noise against itself', noisy(3), noisy(3), OPTIONS],
      ['pages of different heights', png(30, 40, WHITE), png(30, 70, BLACK), OPTIONS],
      ['rows inserted', png(30, 40, WHITE, { from: 5, to: 9, colour: BLACK }),
        png(30, 40, WHITE, { from: 20, to: 24, colour: BLACK }), { ...OPTIONS, alignRows: true }],
      ['nothing tolerated', noisy(4), noisy(5), { ...OPTIONS, pixelThreshold: 0 }],
    ];

    for (const [what, a, b, options] of cases) {
      assert.equal(diffImages(a, b, options).png.readUInt8(25), 3, what);
    }
  });
});

describe('diffImages', () => {
  it('reports no difference for identical images', () => {
    const image = png(20, 10, WHITE);
    const { result } = diffImages(image, image, OPTIONS);

    assert.equal(result.diffPixels, 0);
    assert.equal(result.ratio, 0);
    assert.equal(result.sizeMismatch, false);
  });

  it('counts the pixels that differ', () => {
    const a = png(10, 10, WHITE);
    const b = png(10, 10, WHITE, { from: 0, to: 2, colour: BLACK });

    const { result } = diffImages(a, b, OPTIONS);

    assert.equal(result.diffPixels, 20);
    assert.equal(result.totalPixels, 100);
    assert.equal(result.ratio, 0.2);
  });

  it('returns a diff image of the compared size', () => {
    const a = png(10, 10, WHITE);
    const b = png(10, 10, BLACK);
    const { png: diff, result } = diffImages(a, b, OPTIONS);

    const decoded = PNG.sync.read(diff);
    assert.equal(decoded.width, result.width);
    assert.equal(decoded.height, result.height);
  });

  it('pads to the union size when the pages differ in height', () => {
    const a = png(10, 10, WHITE);
    const b = png(10, 14, WHITE);

    const { result } = diffImages(a, b, OPTIONS);

    assert.equal(result.sizeMismatch, true);
    assert.equal(result.width, 10);
    assert.equal(result.height, 14);
    assert.deepEqual(result.sizeA, { width: 10, height: 10 });
    assert.deepEqual(result.sizeB, { width: 10, height: 14 });
  });

  it('counts the padded area as a difference', () => {
    const a = png(10, 10, WHITE);
    const b = png(10, 12, WHITE);

    const { result } = diffImages(a, b, OPTIONS);

    // The two rows A does not have differ from B's white ones.
    assert.equal(result.diffPixels, 20);
  });

  it('pads a width difference as well', () => {
    const { result } = diffImages(png(8, 10, WHITE), png(12, 10, WHITE), OPTIONS);

    assert.equal(result.width, 12);
    assert.equal(result.sizeMismatch, true);
  });

  it('ignores a colour difference below the pixel threshold', () => {
    const a = png(10, 10, [255, 255, 255]);
    const b = png(10, 10, [252, 252, 252]);

    assert.equal(diffImages(a, b, { pixelThreshold: 0.1, ignoreAntialiasing: true, alignRows: false }).result.diffPixels, 0);
    assert.ok(diffImages(a, b, { pixelThreshold: 0, ignoreAntialiasing: true, alignRows: false }).result.diffPixels > 0);
  });
});
