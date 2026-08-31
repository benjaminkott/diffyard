import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { forDiff, forStorage, formatOf, formatForPair, toPixels } from '../dist/images.js';
import { diffImages } from '../dist/diff.js';
import { solidPng } from './helpers/server.ts';

/**
 * Storing the screenshots smaller.
 *
 * The one property that matters here is that nothing is lost. A stored side is
 * read back and compared against when a later run reuses it, so a picture that
 * came back a shade different would be reported as a change in the page rather
 * than as what it is.
 */
describe('how screenshots are stored', () => {
  const shot = (): Buffer => solidPng(60, 40, [40, 90, 200]);

  it('reads the format off the name it was written as', () => {
    assert.equal(formatOf('shots/home--desktop.a.webp'), 'webp');
    assert.equal(formatOf('shots/home--desktop.a.png'), 'png');
    // The difference picture keeps its palette PNG whatever the shots are.
    assert.equal(formatOf('shots/home--desktop.diff.png'), 'png');
  });

  it('writes WebP unless asked otherwise', async () => {
    assert.equal(await formatForPair('webp', [shot()]), 'webp');
    assert.equal(await formatForPair('png', [shot()]), 'png');

    const stored = await forStorage(shot(), 'webp');
    assert.deepEqual(stored.subarray(0, 4), Buffer.from('RIFF', 'latin1'));
    assert.deepEqual(stored.subarray(8, 12), Buffer.from('WEBP', 'latin1'));
  });

  it('leaves a PNG alone rather than re-encoding it', async () => {
    const original = shot();
    assert.equal(await forStorage(original, 'png'), original, 'the same buffer, not a copy of it');
  });

  it('gives back the same pixels for the same picture, twice', async () => {
    // The screenshots are stored near-lossless, so this is not "byte for byte
    // what went in" -- it is the property the comparison rests on: the same
    // page stored twice comes back the same, so a page that did not change
    // still measures zero.
    const once = await toPixels(await forStorage(shot(), 'webp'), 'webp');
    const twice = await toPixels(await forStorage(shot(), 'webp'), 'webp');

    assert.ok(once && twice);
    assert.deepEqual(once.data, twice.data);
    assert.equal(once.width, PNG.sync.read(shot()).width);
  });

  it('stays close to what it was given', async () => {
    // Near-lossless, so not exact -- but a screenshot that came back visibly
    // different would be reported as a change in the page.
    const original = PNG.sync.read(shot());
    const back = await toPixels(await forStorage(shot(), 'webp'), 'webp');

    assert.ok(back);
    let worst = 0;
    for (let at = 0; at < original.data.length; at += 1) {
      worst = Math.max(worst, Math.abs((back.data[at] ?? 0) - (original.data[at] ?? 0)));
    }
    assert.ok(worst <= 8, `worst channel off by ${worst}`);
  });

  it('hands a PNG straight to the diff instead of decoding it twice', async () => {
    assert.equal(await toPixels(shot(), 'png'), null);
  });

  it('falls back to PNG for a picture WebP cannot hold', async () => {
    // WebP stops at 16383 in either direction, and a full-page screenshot of a
    // long page on a narrow viewport goes past that easily. The encoder
    // refusing it used to fail the capture, so the format cost a comparison.
    const tall = (height: number) => ({ data: Buffer.alloc(0), width: 375, height });

    assert.equal(await formatForPair('webp', [tall(16383)]), 'webp', 'the last size that fits');
    assert.equal(await formatForPair('webp', [tall(16384)]), 'png', 'one past it');
    assert.equal(await formatForPair('webp', [{ data: Buffer.alloc(0), width: 16384, height: 100 }]), 'png',
      'either direction');
  });

  it('takes both sides down together or neither', async () => {
    // The reading is taken from the stored pictures, so one side through the
    // encoder and one side not would measure the encoder as much as the page.
    const ok = { data: Buffer.alloc(0), width: 375, height: 900 };
    const tall = { data: Buffer.alloc(0), width: 375, height: 20000 };

    assert.equal(await formatForPair('webp', [ok, tall]), 'png');
    assert.equal(await formatForPair('webp', [tall, ok]), 'png');
    assert.equal(await formatForPair('webp', [ok, ok]), 'webp');
  });

  it('takes raw pixels as well as a picture', async () => {
    // The path a side stored as WebP takes when it joins a run writing PNG.
    const pixels = PNG.sync.read(shot());
    const asPng = await forStorage({ data: pixels.data, width: pixels.width, height: pixels.height }, 'png');

    assert.deepEqual(asPng.subarray(1, 4), Buffer.from('PNG', 'latin1'));
    assert.deepEqual(PNG.sync.read(asPng).data, pixels.data);
  });
});

/**
 * The difference picture is the one that may lose something.
 *
 * Nothing reads it back -- it is looked at, to see where on the page something
 * moved. So what has to hold is not that every byte survives, but that it
 * never says a thing changed where nothing did.
 */
describe('how the difference picture is stored', () => {
  const page = (band: [number, number, number]): Buffer => {
    const image = new PNG({ width: 80, height: 120 });
    for (let y = 0; y < 120; y += 1) {
      const colour = y >= 40 && y < 46 ? band : ([230, 230, 235] as const);
      for (let x = 0; x < 80; x += 1) {
        const at = (80 * y + x) << 2;
        image.data[at] = colour[0];
        image.data[at + 1] = colour[1];
        image.data[at + 2] = colour[2];
        image.data[at + 3] = 255;
      }
    }
    return PNG.sync.write(image);
  };

  const picture = () =>
    diffImages(page([230, 230, 235]), page([20, 20, 30]), {
      pixelThreshold: 0.1,
      ignoreAntialiasing: true,
      alignRows: false,
    }).image;

  it('is a palette PNG when the run writes PNG', async () => {
    const written = await forDiff(picture(), 'png');
    assert.equal(written.readUInt8(25), 3, 'colour type 3 is indexed');
    assert.ok(written.includes(Buffer.from('PLTE', 'latin1')), 'and it carries its palette');
  });

  it('is a WebP when the run writes WebP', async () => {
    const written = await forDiff(picture(), 'webp');
    assert.deepEqual(written.subarray(0, 4), Buffer.from('RIFF', 'latin1'));
    assert.deepEqual(written.subarray(8, 12), Buffer.from('WEBP', 'latin1'));
  });

  it('keeps the marks visible and invents none', async () => {
    const original = picture();
    const back = await toPixels(await forDiff(original, 'webp'), 'webp');
    assert.ok(back);

    // The background is grey, so colour is what a mark is made of.
    const colour = (data: Buffer, at: number) =>
      Math.max(data[at]!, data[at + 1]!, data[at + 2]!) - Math.min(data[at]!, data[at + 1]!, data[at + 2]!);

    let marks = 0;
    let kept = 0;
    let invented = 0;
    for (let at = 0; at < original.data.length; at += 4) {
      const row = Math.floor(at / 4 / original.width);
      if (colour(original.data, at) >= 60) {
        marks += 1;
        if (colour(back.data, at) >= 20) kept += 1;
      } else if (colour(back.data, at) >= 20 && (row < 38 || row > 47)) {
        // Ringing beside the changed band is the compression showing; colour
        // anywhere else would be this picture reporting something that is not
        // in the page.
        invented += 1;
      }
    }

    assert.ok(marks > 0, 'the two pages do differ');
    assert.ok(kept / marks > 0.99, `marks still visible: ${((kept / marks) * 100).toFixed(1)}%`);
    assert.equal(invented, 0, 'and no mark away from what actually changed');
  });
});
