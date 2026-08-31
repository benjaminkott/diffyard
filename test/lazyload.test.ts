import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../dist/config.js';
import { run } from '../dist/runner.js';
import { page, serve, solidPng } from './helpers/server.ts';
import type { RunningSite } from './helpers/server.ts';

/**
 * Getting a lazily loaded page fully photographed.
 *
 * Both of these were found on a production site, and both leave holes in the
 * screenshot where the images should be. They are worth pinning because
 * neither announces itself: the run passes, the page just was not there.
 */

const IMAGE = solidPng(8, 8, [200, 30, 30]);

/** Far enough down that nothing loads it without being scrolled to. */
const FAR_DOWN = 6000;

/** A page whose picture is not there: the server answers, with the wrong thing. */
function withBrokenImage(): string {
  return page({
    title: 'Broken',
    body:
      `<div style="height:${FAR_DOWN}px"></div>` +
      '<img loading="lazy" src="/gone.png" width="300" height="300" alt="">' +
      '<img loading="lazy" src="/dot.png" width="300" height="300" alt="">',
  });
}

function withImage(loading: 'lazy' | 'eager', smooth: boolean): string {
  return page({
    title: 'Lazy',
    head: smooth ? '<style>html { scroll-behavior: smooth }</style>' : '',
    body:
      `<div style="height:${FAR_DOWN}px"></div>` +
      `<img loading="${loading}" src="/dot.png" width="300" height="300" alt="">`,
  });
}

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-lazy-'));
let lazySite: RunningSite;
let eagerSite: RunningSite;
let counter = 0;

before(async () => {
  const assets = { 'dot.png': { type: 'image/png', body: IMAGE } };

  // The two sides show the same picture in the same place. The only
  // difference is whether it has to be scrolled to before it loads, so any
  // difference the run reports is the capture failing to reach it.
  lazySite = await serve({
    assets,
    pages: { index: withImage('lazy', false), smooth: withImage('lazy', true), broken: withBrokenImage() },
  });
  eagerSite = await serve({
    assets,
    pages: { index: withImage('eager', false), smooth: withImage('eager', false), broken: withBrokenImage() },
  });
});

after(async () => {
  await lazySite?.close();
  await eagerSite?.close();
  rmSync(workDir, { recursive: true, force: true });
});

/** How long the run took, beside what it found. */
async function timed(path: string, extra = ''): Promise<{ ratio: number; ms: number }> {
  const started = Date.now();
  const ratio = await compare(path, extra);
  return { ratio, ms: Date.now() - started };
}

async function compare(path: string, extra = ''): Promise<number> {
  const dir = join(workDir, `run-${counter++}`);
  const file = join(dir, 'diffyard.yaml');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    file,
    `
compare:
  a: ${lazySite.url}
  b: ${eagerSite.url}
output:
  dir: ${join(dir, 'out')}
browser:
  viewports:
    mobile: { width: 400, height: 700 }
markup:
  enabled: false
${extra}scenarios:
  - ${path}
`
  );

  const result = await run(loadConfig(file));
  const comparison = result.comparisons[0];
  assert.equal(comparison?.status !== 'error', true, comparison?.error ?? '');
  return comparison?.diff?.ratio ?? 1;
}

describe('a page that only loads its images when scrolled to', () => {
  it('is photographed with them', async () => {
    // The image sits six thousand pixels down. If the walk stops early, this
    // side is a white box where the other has a picture.
    assert.equal(await compare('/'), 0);
  });

  it('is photographed with them even when the page scrolls smoothly', async () => {
    // scroll-behavior: smooth animates every scrollTo, so a walk that asks for
    // the next screen every twenty-five milliseconds keeps restarting the
    // animation and never leaves the top of the page.
    assert.equal(await compare('/smooth'), 0);
  });

  it('does not wait out its budget for a picture that is not coming', async () => {
    // A missing image is complete and has no width -- which is also what an
    // image still on the wire looks like if you go by width alone. Counting it
    // as outstanding held every capture until the settle budget ran out: eight
    // seconds, on both sides, at every viewport, for a screenshot identical to
    // the one taken at once.
    const { ms } = await timed('/broken');

    // The budget is 8s a side. Anything near it means the wait is back.
    assert.ok(ms < 8000, `a page with a broken image took ${(ms / 1000).toFixed(1)}s`);
  });

  it('leaves the page alone when the walk is switched off', async () => {
    // The counterpart: without triggerLazyLoad the image is genuinely missing,
    // which is what makes the two tests above mean something.
    const ratio = await compare('/', 'stability:\n  triggerLazyLoad: false\n');
    assert.ok(ratio > 0, 'the lazy side should be missing its image');
  });
});
