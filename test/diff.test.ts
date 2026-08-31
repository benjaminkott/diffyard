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
    const { image, result } = diffImages(a, b, OPTIONS);

    assert.equal(image.width, result.width);
    assert.equal(image.height, result.height);
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
