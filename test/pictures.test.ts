import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { loadConfig } from '../dist/config.js';
import { diffImages } from '../dist/diff.js';
import { ASIDE } from '../dist/marks.js';
import { run } from '../dist/runner.js';
import type { Picture } from '../dist/types.js';
import { page, serve } from './helpers/server.ts';
import type { RunningSite } from './helpers/server.ts';

/**
 * The same picture, delivered differently.
 *
 * Two systems almost never serve a photograph as the same file, and the
 * difference between two encodings of one picture is not a difference in the
 * page. What has to hold: it is set aside only where the page says there is a
 * picture, only where both sides agree there is one, and only while the two
 * versions are the same picture once they are no longer read at full size.
 */

const WIDTH = 240;
const HEIGHT = 240;
const BOX = { x: 40, y: 40, width: 160, height: 160, src: '/photo.jpg' };

/** A page with something photograph-like in the middle of it. */
function scene(fill: (x: number, y: number) => [number, number, number]): Buffer {
  const image = new PNG({ width: WIDTH, height: HEIGHT });
  image.data.fill(255);

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = (WIDTH * y + x) << 2;
      const [red, green, blue] = fill(x, y);
      image.data[at] = red;
      image.data[at + 1] = green;
      image.data[at + 2] = blue;
      image.data[at + 3] = 255;
    }
  }

  return PNG.sync.write(image);
}

const inBox = (x: number, y: number): boolean =>
  x >= BOX.x && x < BOX.x + BOX.width && y >= BOX.y && y < BOX.y + BOX.height;

/** A gradient with hard edges in it, which is what a photograph is to a diff. */
const photograph = (x: number, y: number): [number, number, number] => {
  if (!inBox(x, y)) return [255, 255, 255];
  const value = ((x * 7 + y * 3) % 200) + 20;
  return [value, 255 - value, (value * 2) % 255];
};

/**
 * The same picture, encoded again.
 *
 * Every pixel moved, by enough that a per-pixel comparison reports it -- which
 * is what re-encoding does, and why a colour tolerance is no way out of it --
 * while the block it sits in still averages to the same thing.
 */
const reencoded = (x: number, y: number): [number, number, number] => {
  const [red, green, blue] = photograph(x, y);
  if (!inBox(x, y)) return [red, green, blue];
  const jitter = (x + y) % 2 === 0 ? 40 : -40;
  return [clamp(red + jitter), clamp(green - jitter), clamp(blue + jitter)];
};

/** The same picture, drawn a pixel over, as two scalers would place it. */
const slid = (x: number, y: number): [number, number, number] =>
  inBox(x, y) ? photograph(x - 1, y) : photograph(x, y);

function clamp(value: number): number {
  return Math.max(0, Math.min(255, value));
}

const OPTIONS = { pixelThreshold: 0.1, ignoreAntialiasing: true, alignRows: false };
const SIDES = { a: [BOX] as Picture[], b: [BOX] as Picture[] };

describe('a picture the two systems delivered differently', () => {
  it('needs the rectangle for the edges a scaler moved', () => {
    // Content a pixel over: quiet almost everywhere, and thirty levels out at
    // every hard edge in it. Only a picture gets that forgiven, because only a
    // picture has something vouching for the whole of it.
    const { result } = diffImages(scene(photograph), scene(slid), OPTIONS);

    assert.ok(result.diffPixels > 0, 'without one, the edges are a difference');
    assert.equal(result.redelivered, 0, 'and no picture was set aside');
  });

  it('sets aside what averages out even where no picture is', () => {
    // Every pixel moved and every block unchanged: a logo the two systems
    // rasterised differently looks like this, and it is in no <img> at all.
    const { result } = diffImages(scene(photograph), scene(reencoded), OPTIONS);

    assert.equal(result.diffPixels, 0, 'nothing counted');
    assert.ok(result.unseen > 1000, 'all of it too small to see');
    assert.equal(result.redelivered, 0, 'and none of it on a picture');
  });

  it('sets it aside where both sides say there is one', () => {
    const { result, image } = diffImages(scene(photograph), scene(reencoded), {
      ...OPTIONS,
      pictures: SIDES,
    });

    assert.equal(result.diffPixels, 0, 'nothing left to report');
    assert.ok(result.redelivered > 1000, 'all of it accounted for');
    assert.equal(result.ratio, 0);

    const at = (WIDTH * (BOX.y + 5) + BOX.x + 5) << 2;
    assert.deepEqual(
      [image.data[at], image.data[at + 1], image.data[at + 2]],
      [...ASIDE],
      'drawn, in its own colour, rather than erased'
    );
  });

  it('keeps a real change inside the same rectangle', () => {
    // Half the picture replaced by another one. Same rectangle, same address,
    // and the two are not the same picture.
    const replaced = (x: number, y: number): [number, number, number] =>
      inBox(x, y) && x < BOX.x + BOX.width / 2 ? [10, 20, 30] : photograph(x, y);

    const { result } = diffImages(scene(photograph), scene(replaced), { ...OPTIONS, pictures: SIDES });

    assert.ok(result.diffPixels > 1000, 'a picture swapped for another is a difference');
    assert.equal(result.redelivered, 0);
  });

  it('keeps a change too small to swap the picture but large enough to see', () => {
    // A quarter of the width, in the middle of it. Judging on the worst block
    // alone was too brittle to be useful, so a share of the picture is allowed
    // over the line -- and this has to stay well outside that share.
    const patched = (x: number, y: number): [number, number, number] =>
      x >= BOX.x + 60 && x < BOX.x + 100 && y >= BOX.y + 60 && y < BOX.y + 100
        ? [15, 15, 15]
        : photograph(x, y);

    const { result } = diffImages(scene(photograph), scene(patched), { ...OPTIONS, pictures: SIDES });

    assert.ok(result.diffPixels > 1000, 'still a difference');
    assert.equal(result.redelivered, 0, 'and not excused as delivery');
  });

  it('forgives the fraction of a pixel two scalers disagree by', () => {
    // The same picture, drawn a pixel over: which is what two pipelines that
    // scale it with different filters produce, and a hard edge half a pixel
    // out is a block average thirty levels apart while being the same edge.
    const { result } = diffImages(scene(photograph), scene(slid), { ...OPTIONS, pictures: SIDES });

    assert.equal(result.diffPixels, 0, 'nothing counted');
    assert.ok(result.redelivered > 0, 'all of it set aside');
  });

  it('leaves the rest of the page alone', () => {
    // The same shade of noise, in a corner nobody called a picture.
    const elsewhere = (x: number, y: number): [number, number, number] =>
      x < 20 && y < 20 ? [200, 100, 50] : photograph(x, y);

    const { result } = diffImages(scene(photograph), scene(elsewhere), { ...OPTIONS, pictures: SIDES });

    assert.ok(result.diffPixels > 0, 'outside the rectangle it counts');
  });

  it('needs both sides to agree there is a picture', () => {
    const { result } = diffImages(scene(photograph), scene(slid), {
      ...OPTIONS,
      pictures: { a: [BOX], b: [] },
    });

    assert.ok(result.diffPixels > 0, 'one side saying so is not agreement');
    assert.equal(result.redelivered, 0);
  });

  it('leaves anti-aliased pixels alone, which were never counted either', () => {
    // They are drawn and not counted, so anything reading the picture back has
    // to leave them out or it subtracts from a number they were never in.
    const edge = (shift: number): Buffer =>
      scene((x, y) => {
        const across = x - (y * 0.6 + shift);
        const value = across < 0 ? 0 : across < 1 ? Math.round(255 * across) : 255;
        return [value, value, value];
      });

    const { result } = diffImages(edge(20), edge(20.4), { ...OPTIONS, pictures: SIDES });

    assert.equal(result.diffPixels, 0, 'the same edge, softened');
    assert.equal(result.redelivered, 0, 'and nothing to set aside');
  });
});

/**
 * The same thing through a run: two servers that hand out the same picture as
 * two different files, which is what a re-processed asset pipeline is.
 */
describe('through a run', { concurrency: false }, () => {
  const workDir = mkdtempSync(join(tmpdir(), 'diffyard-pictures-'));
  let siteA: RunningSite;
  let siteB: RunningSite;

  const body =
    '<h1>Gallery</h1><img src="/photo.png" width="300" height="200" alt="">';

  /** A picture, and the same picture out of another encoder. */
  const photo = (shift: number): Buffer => {
    const image = new PNG({ width: 300, height: 200 });
    for (let y = 0; y < 200; y += 1) {
      for (let x = 0; x < 300; x += 1) {
        const at = (300 * y + x) << 2;
        const value = ((x * 5 + y * 3) % 180) + 30;
        const jitter = (x + y) % 2 === 0 ? shift : -shift;
        image.data[at] = clamp(value + jitter);
        image.data[at + 1] = clamp(220 - value - jitter);
        image.data[at + 2] = clamp(value * 2 - jitter);
        image.data[at + 3] = 255;
      }
    }
    return PNG.sync.write(image);
  };

  // The same picture, one pixel shorter: what two systems working a height out
  // from an aspect ratio disagree by, and the reason the page under it ends
  // short of the other one.
  const rounded = (height: number) =>
    page({ title: 'Gallery', body: `<h1>Gallery</h1><img src="/photo.png" width="300" height="${height}" alt="">` });

  before(async () => {
    siteA = await serve({
      pages: { index: page({ title: 'Gallery', body }), rounded: rounded(200) },
      assets: { 'photo.png': { type: 'image/png', body: photo(0) } },
    });
    siteB = await serve({
      pages: { index: page({ title: 'Gallery', body }), rounded: rounded(199) },
      assets: { 'photo.png': { type: 'image/png', body: photo(40) } },
    });
  });

  after(async () => {
    await siteA?.close();
    await siteB?.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('says when the two sides draw a picture at different heights', async () => {
    const file = join(workDir, 'rounded.yaml');
    writeFileSync(
      file,
      `
compare:
  a: ${siteA.url}
  b: ${siteB.url}
output:
  dir: ${join(workDir, 'out-rounded')}
browser:
  viewports:
    desktop: { width: 600, height: 400 }
markup:
  enabled: false
scenarios:
  - /rounded
`
    );

    const comparison = (await run(loadConfig(file))).comparisons[0];

    assert.ok(comparison);
    assert.equal(comparison.diff?.resized, 1, 'the one picture, counted');
    assert.ok(comparison.kinds.includes('resized'), 'and filed as its own finding');
  });

  it('does not draw a line across the page for the row that costs', async () => {
    // The taller side has one row inside that picture the other has not. It is
    // the same picture at another size -- said as that -- and a red line
    // across the page for a row nobody can see is worse than saying nothing.
    const file = join(workDir, 'rounded-2.yaml');
    writeFileSync(
      file,
      `
compare:
  a: ${siteA.url}
  b: ${siteB.url}
output:
  dir: ${join(workDir, 'out-rounded-2')}
browser:
  viewports:
    desktop: { width: 600, height: 400 }
markup:
  enabled: false
scenarios:
  - /rounded
`
    );

    const comparison = (await run(loadConfig(file))).comparisons[0];

    assert.ok(comparison);
    assert.equal(comparison.diff?.aligned?.removedRows ?? 0, 0, 'the row is not counted');
    assert.equal(comparison.diff?.diffPixels, 0, 'and nothing is left to report');
    assert.equal(comparison.status, 'pass');
    assert.ok(comparison.kinds.includes('resized'), 'the picture still says it is another size');
  });

  it('passes, says why, and keeps the rectangles for the next run', async () => {
    const file = join(workDir, 'diffyard.yaml');
    writeFileSync(
      file,
      `
compare:
  a: ${siteA.url}
  b: ${siteB.url}
output:
  dir: ${join(workDir, 'out')}
browser:
  viewports:
    desktop: { width: 600, height: 400 }
markup:
  enabled: false
scenarios:
  - /
`
    );

    const result = await run(loadConfig(file));
    const comparison = result.comparisons[0];

    assert.ok(comparison);
    assert.ok((comparison.diff?.redelivered ?? 0) > 0, 'the picture was set aside');
    assert.equal(comparison.diff?.diffPixels, 0, 'and nothing else differed');
    assert.equal(comparison.status, 'pass');
    assert.ok(comparison.kinds.includes('redelivered'), 'and the report can say so');

    assert.ok(comparison.files.pictures, 'the rectangles are kept beside the shots');
    const held = JSON.parse(
      await readFile(join(result.outDir, comparison.files.pictures), 'utf8')
    ) as { a: Picture[]; b: Picture[] };
    assert.ok(held.a.length > 0 && held.b.length > 0, 'both sides said where the picture is');
    assert.ok(existsSync(join(result.outDir, comparison.files.a ?? '')), 'and the shots are there');
  });
});
