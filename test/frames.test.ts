import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { loadConfig } from '../dist/config.js';
import { run } from '../dist/runner.js';
import { page, serve } from './helpers/server.ts';
import type { RunningSite } from './helpers/server.ts';

/**
 * A page whose content is in a frame of its own.
 *
 * What this pins is the outcome -- the frame's content is in the picture --
 * rather than one mechanism reaching it. Today the navigation already covers
 * this case on its own; the capture waits for frames as well because a frame
 * attached after the navigation, which is what a consent manager does with an
 * embed, is not covered by anything else.
 *
 * An embedded player, a map, a consent widget: none of them is an image, none
 * of them is in the document, and a cross-origin one cannot be inspected from
 * inside the page at all. A screenshot taken before the frame answers has an
 * empty box where the thing should be -- and two of those, taken at two
 * moments, differ for no reason anyone can act on.
 */

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-frames-'));
let site: RunningSite;

/**
 * The frame is in the page from the start, and answers long after the
 * navigation does: with `waitUntil: domcontentloaded` -- what a suite uses to
 * avoid waiting on third-party chatter -- nothing between the navigation and
 * the screenshot waits for it.
 */
const host = (path: string) =>
  page({
    title: 'Player',
    body: `<div style="width:300px;height:200px;background:#fff"><iframe src="${path}" width="300" height="200" style="border:0"></iframe></div>`,
  });

const inside = page({ title: 'Inside', body: '<p>playing</p>', background: '#1040c0' });

before(async () => {
  site = await serve({
    pages: { index: host('/player'), player: inside },
    // And it answers well after that again.
    slow: { player: 2500 },
  });
});

after(async () => {
  await site?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('a page with a frame in it', { concurrency: false }, () => {
  it('waits for the frame before photographing the page', async () => {
    const file = join(workDir, 'diffyard.yaml');
    writeFileSync(
      file,
      `
compare:
  a: ${site.url}
  b: ${site.url}
output:
  dir: ${join(workDir, 'out')}
browser:
  viewports:
    desktop: { width: 500, height: 400 }
markup:
  enabled: false
stability:
  triggerLazyLoad: false
waitUntil: domcontentloaded
scenarios:
  - /
`
    );

    const result = await run(loadConfig(file));
    const comparison = result.comparisons[0];
    assert.ok(comparison?.files.a);

    // The frame's own background, where the frame sits. An empty frame is
    // white, which is what this used to photograph.
    const shot = await sharp(join(result.outDir, comparison.files.a)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width } = shot.info;
    const at = (width * 120 + 60) * 4;
    const [red, green, blue] = [shot.data[at]!, shot.data[at + 1]!, shot.data[at + 2]!];

    assert.ok(
      blue > red + 40 && blue > green + 40,
      `the frame had answered by the time the picture was taken, got rgb(${red}, ${green}, ${blue})`
    );
  });
});
