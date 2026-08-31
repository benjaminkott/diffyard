import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { forStorage, formatOf, storageFormat, toPixels } from '../dist/images.js';
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
    assert.equal(storageFormat('webp'), 'webp');
    assert.equal(storageFormat('png'), 'png');

    const stored = await forStorage(shot(), 'webp');
    assert.deepEqual(stored.subarray(0, 4), Buffer.from('RIFF', 'latin1'));
    assert.deepEqual(stored.subarray(8, 12), Buffer.from('WEBP', 'latin1'));
  });

  it('leaves a PNG alone rather than re-encoding it', async () => {
    const original = shot();
    assert.equal(await forStorage(original, 'png'), original, 'the same buffer, not a copy of it');
  });

  it('gives back the pixels it was given, to the channel', async () => {
    const original = PNG.sync.read(shot());
    const back = await toPixels(await forStorage(shot(), 'webp'), 'webp');

    assert.ok(back);
    assert.equal(back.width, original.width);
    assert.equal(back.height, original.height);
    for (let at = 0; at < original.data.length; at += 1) {
      assert.equal(back.data[at], original.data[at], `channel ${at}`);
    }
  });

  it('hands a PNG straight to the diff instead of decoding it twice', async () => {
    assert.equal(await toPixels(shot(), 'png'), null);
  });

  it('takes raw pixels as well as a picture', async () => {
    // The path a side stored as WebP takes when it joins a run writing PNG.
    const pixels = PNG.sync.read(shot());
    const asPng = await forStorage({ data: pixels.data, width: pixels.width, height: pixels.height }, 'png');

    assert.deepEqual(asPng.subarray(1, 4), Buffer.from('PNG', 'latin1'));
    assert.deepEqual(PNG.sync.read(asPng).data, pixels.data);
  });
});
