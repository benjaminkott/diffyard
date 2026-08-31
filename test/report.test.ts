import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { loadConfig } from '../dist/config.js';
import { renderReport } from '../dist/report/index.js';
import { readCase } from '../dist/report/pool.js';
import type { Comparison, RunResult } from '../dist/types.js';
import { solidPng } from './helpers/server.ts';

/**
 * The report is a page, and the things that go wrong with it are things a
 * type checker cannot see: a rule that paints a label onto its own background,
 * a link that no longer routes, a view that renders every card at once. These
 * open it in a browser and look.
 */

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-report-'));

/**
 * Screenshots the report can actually lay out.
 *
 * A view that scrolls, a split that follows a pointer and a minimap that maps
 * onto something are all properties of a picture with a size; against a
 * missing image they all pass by doing nothing.
 */
function writeShots(): void {
  mkdirSync(join(workDir, 'shots'), { recursive: true });
  for (const id of ['home--desktop', 'about--desktop', 'top--desktop']) {
    for (const [side, colour] of [['a', [40, 90, 200]], ['b', [200, 90, 40]], ['diff', [220, 40, 40]]] as const) {
      // Tall enough that a frame six hundred pixels high has somewhere to go.
      writeFileSync(
        join(workDir, 'shots', `${id}.${side}.png`),
        solidPng(400, 2400, colour as [number, number, number])
      );
    }
  }
}

let browser: Browser;

before(async () => {
  writeShots();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  rmSync(workDir, { recursive: true, force: true });
});

function comparison(overrides: Partial<Comparison> = {}): Comparison {
  return {
    id: 'home--desktop',
    group: null,
    scenario: 'home',
    viewport: { name: 'desktop', width: 800, height: 600, deviceScaleFactor: 1 },
    urlA: 'https://a.test/',
    urlB: 'https://b.test/',
    status: 'fail',
    threshold: 0.001,
    diff: {
      diffPixels: 1000,
      totalPixels: 100_000,
      ratio: 0.01,
      width: 800,
      height: 2000,
      sizeMismatch: false,
      sizeA: { width: 800, height: 2000 },
      sizeB: { width: 800, height: 2000 },
      // The change sits two thirds down, which is what the view should find.
      profile: Array.from({ length: 64 }, (_, index) => (index === 42 ? 0.8 : 0)),
      regions: [{ from: 1300, to: 1360, height: 60, ratio: 0.8 }],
      aligned: null,
      unaligned: null,
    },
    markup: { identical: false, added: 3, removed: 2, linesA: 100, linesB: 101, hunks: 1 },
    markupHunks: [
      { startA: 10, startB: 10, lines: [{ type: 'remove', text: '<p>a</p>' }, { type: 'add', text: '<p>b</p>' }] },
    ],
    files: {
      a: 'shots/home--desktop.a.png',
      b: 'shots/home--desktop.b.png',
      diff: 'shots/home--desktop.diff.png',
      htmlA: 'shots/home--desktop.a.html',
      htmlB: 'shots/home--desktop.b.html',
      patch: 'shots/home--desktop.patch',
      result: 'shots/home--desktop.json',
      detail: 'data/home--desktop.js',
    },
    logs: {
      a: [{ kind: 'warning', text: 'Deprecated API', source: null, count: 2 }],
      b: [
        { kind: 'warning', text: 'Deprecated API', source: null, count: 2 },
        { kind: 'httperror', text: 'HTTP 404 https://b.test/hero.jpg', source: null, count: 1 },
      ],
      onlyA: 0,
      onlyB: 1,
      errorsA: 0,
      errorsB: 1,
      differs: true,
      seriousOnOneSide: 1,
    },
    capture: {
      a: { fingerprint: 'aaaa1111', reusedFrom: null, recapturedBecause: null },
      b: { fingerprint: 'bbbb2222', reusedFrom: null, recapturedBecause: null },
    },
    kinds: ['image', 'text', 'moved'],
    command: 'diffyard run diffyard.yaml --case home--desktop --into test-run',
    ranAt: '2026-08-27T10:00:30.000Z',
    error: null,
    durationMs: 4200,
    ...overrides,
  };
}

const RESULT: RunResult = {
  startedAt: '2026-08-27T10:00:00.000Z',
  finishedAt: '2026-08-27T10:01:00.000Z',
  durationMs: 60_000,
  total: 3,
  passed: 1,
  failed: 1,
  errored: 1,
  skipped: 0,
  outDir: '',
  runId: 'test-run',
  commands: {
    all: 'diffyard run diffyard.yaml',
    a: 'diffyard run diffyard.yaml --reuse b --reuse-from test-run',
    b: 'diffyard run diffyard.yaml --reuse a --reuse-from test-run',
  },
  reuse: null,
  comparisons: [
    comparison(),
    comparison({
      id: 'about--desktop',
      scenario: 'about',
      status: 'pass',
      diff: {
        diffPixels: 0,
        totalPixels: 100_000,
        ratio: 0,
        width: 800,
        height: 600,
        sizeMismatch: false,
        sizeA: { width: 800, height: 600 },
        sizeB: { width: 800, height: 600 },
        profile: new Array(64).fill(0),
        regions: [],
        aligned: null,
        unaligned: null,
      },
      markup: { identical: true, added: 0, removed: 0, linesA: 10, linesB: 10, hunks: 0 },
      markupHunks: [],
      // Nothing differed, so there is no kind of difference to file it under,
      // and no difference picture was written.
      kinds: [],
      files: {
        a: 'shots/about--desktop.a.png',
        b: 'shots/about--desktop.b.png',
        diff: null,
        htmlA: null,
        htmlB: null,
        patch: null,
        result: 'shots/about--desktop.json',
        detail: 'data/about--desktop.js',
      },
      ranAt: '2026-08-27T10:00:44.000Z',
      capture: {
        a: { fingerprint: 'aaaa1111', reusedFrom: null, recapturedBecause: null },
        b: {
          fingerprint: 'bbbb2222',
          reusedFrom: { runId: 'earlier', capturedAt: '2026-08-27T10:00:12.000Z' },
          recapturedBecause: null,
        },
      },
    }),
    comparison({
      id: 'top--desktop',
      scenario: 'top',
      diff: {
        diffPixels: 900,
        totalPixels: 100_000,
        ratio: 0.009,
        width: 800,
        height: 2000,
        sizeMismatch: false,
        sizeA: { width: 800, height: 2000 },
        sizeB: { width: 800, height: 2000 },
        // Right at the head of the page, where centring the band would push
        // the picture off its own frame.
        profile: Array.from({ length: 64 }, (_, index) => (index === 0 ? 0.9 : 0)),
        regions: [{ from: 0, to: 30, height: 30, ratio: 0.9 }],
        aligned: null,
        unaligned: null,
      },
      files: {
        a: 'shots/top--desktop.a.png',
        b: 'shots/top--desktop.b.png',
        diff: 'shots/top--desktop.diff.png',
        htmlA: 'shots/top--desktop.a.html',
        htmlB: 'shots/top--desktop.b.html',
        patch: 'shots/top--desktop.patch',
        result: 'shots/top--desktop.json',
        detail: 'data/top--desktop.js',
      },
    }),
    comparison({
      id: 'broken--desktop',
      scenario: 'broken',
      status: 'error',
      diff: null,
      markup: null,
      markupHunks: null,
      files: { a: null, b: null, diff: null, htmlA: null, htmlB: null, patch: null, result: null, detail: null },
      error: 'page.goto: Timeout 30000ms exceeded.',
    }),
  ],
  refreshedAt: null,
  commonMarkup: [],
  settings: {
    a: {
      label: 'A',
      baseUrl: 'https://a.test/',
      headers: ['x-preview-token'],
      cookies: ['session'],
      basicAuth: true,
      storageState: null,
    },
    b: { label: 'B', baseUrl: 'https://b.test/', headers: [], cookies: [], basicAuth: false, storageState: null },
    viewports: [{ name: 'desktop', width: 800, height: 600, deviceScaleFactor: 1 }],
    scenarios: 4,
    beforeEach: [{ name: 'accept consent', when: '#accept', once: true, required: false, side: null, steps: 1 }],
    browser: 'chromium',
    headless: true,
    colorScheme: 'light',
    reducedMotion: true,
    locale: null,
    timezone: null,
    userAgent: null,
    ignoreHTTPSErrors: false,
    threshold: 0.001,
    pixelThreshold: 0.1,
    ignoreAntialiasing: true,
    alignRows: true,
    mask: ['.carousel'],
    hide: [],
    remove: [],
    timeout: 30_000,
    comparisonTimeout: 180_000,
    runTimeout: 0,
    retries: 0,
    freeze: true,
    triggerLazyLoad: true,
    sequential: false,
    workers: 1,
    markup: {
      enabled: true,
      failOnDifference: false,
      ignoreAttributes: ['nonce'],
      ignoreSelectors: ['script'],
      ignoreComments: true,
      normalizeWhitespace: true,
      sortAttributes: false,
      maxHunksInReport: 40,
    },
    logs: {
      enabled: true,
      failOnDifference: false,
      levels: ['error'],
      ignore: [],
      max: 50,
    },
    reuse: { sides: [], from: 'latest', maxAge: 86_400_000 },
  },
  config: {
    file: 'diffyard.yaml',
    a: 'https://a.test/',
    b: 'https://b.test/',
    labelA: 'A',
    labelB: 'B',
    browser: 'chromium',
    outDir: '',
  },
};

/**
 * A string as it reads once it is inside a script tag.
 *
 * The payload has its angle brackets escaped so it cannot close the tag it
 * sits in, so looking for markup in a rendered report means looking for it in
 * that form.
 */
function inScript(text: string): string {
  return JSON.stringify(text).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').slice(1, -1);
}

/** Renders the report once and opens it, so each test starts from a page. */
async function open(scheme: 'light' | 'dark'): Promise<{ page: Page; errors: string[] }> {
  const configFile = join(workDir, 'diffyard.yaml');
  writeFileSync(
    configFile,
    'compare:\n  a: https://a.test/\n  b: https://b.test/\nscenarios:\n  - /\n'
  );

  const file = join(workDir, `report-${scheme}.html`);
  const report = await renderReport({ ...RESULT, outDir: workDir }, loadConfig(configFile), { selfContained: false });
  writeFileSync(file, report.html);

  // The report is a shell; without what goes beside it there is nothing on the
  // page to test.
  for (const [name, body] of report.files) {
    mkdirSync(join(workDir, dirname(name)), { recursive: true });
    writeFileSync(join(workDir, name), body);
  }

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`file://${file}`);
  await page.waitForTimeout(200);
  return { page, errors };
}

// The report is dark whatever the system asks for, so it is opened under both
// settings: a light-mode override creeping back in shows up here as a label
// painted onto its own background.
for (const scheme of ['light', 'dark'] as const) {
  describe(`report with the system set to ${scheme}`, () => {
    it('renders without a script error', async () => {
      const { page, errors } = await open(scheme);
      assert.deepEqual(errors, []);
      assert.equal(await page.locator('#tiles > .tile').count(), 4, 'one tile per scenario');
      await page.close();
    });

    it('says what the run was told to do', async () => {
      const { page } = await open(scheme);

      // A number nobody can trace back to its settings is not a measurement.
      const panel = page.locator('#settings');
      await panel.locator('summary').click();
      await page.waitForTimeout(100);

      const text = (await panel.textContent()) ?? '';
      assert.match(text, /Threshold/, 'the threshold a comparison passed or failed on');
      assert.match(text, /desktop 800×600/, 'the viewport it was captured at');
      assert.match(text, /accept consent/, 'what ran before every page');
      assert.match(text, /x-preview-token/, 'that a header was set, by name');
      await page.close();
    });

    it('keeps the bar the same height when a comparison is opened', async () => {
      const { page } = await open(scheme);

      // The two bars are one bar to a reader: same edge, one replacing the
      // other. Different contents used to make them differ by three pixels,
      // and the page nudged each way through.
      const height = (selector: string) =>
        page.locator(selector).first().evaluate((node) => Math.round(node.getBoundingClientRect().height));

      const overview = await height('.controls');
      await page.locator('.tile').first().click();
      await page.waitForTimeout(150);
      const detail = await height('.detail__bar');

      assert.equal(detail, overview, 'the bar does not move when the view behind it changes');
      await page.close();
    });

    it('says how to run the whole thing again, not just one finding', async () => {
      const { page } = await open(scheme);

      // The move from the overview is "fix the deployment, look at all of it
      // again". A report that only says how to redo one case leaves that one
      // to be worked out by hand.
      const line = page.locator('#run-command code');
      assert.equal(await line.count(), 1, 'the run has its own line, once');
      assert.equal(await line.textContent(), 'diffyard run diffyard.yaml',
        'no --into: repeating a run is running it, and the config says where it lands');
      await page.close();
    });

    it('offers to capture one side and keep the other', async () => {
      const { page } = await open(scheme);

      // Usually only one side moved. Photographing the other again is half a
      // run spent proving it did not change.
      const choices = page.locator('#run-command .rerun__pick button');
      assert.deepEqual(await choices.allTextContents(), ['both sides', 'A', 'B']);

      const line = page.locator('#run-command code');
      await choices.nth(1).click();
      assert.match((await line.textContent()) ?? '', /--reuse b --reuse-from test-run/,
        'capturing A again means keeping B');

      await choices.nth(2).click();
      assert.match((await line.textContent()) ?? '', /--reuse a --reuse-from test-run/);

      await choices.nth(0).click();
      assert.equal(await line.textContent(), 'diffyard run diffyard.yaml');
      await page.close();
    });

    it('shows a picture for a comparison that has no difference picture', async () => {
      const { page } = await open(scheme);

      // A run writes no difference picture where nothing differed — it would
      // cost as much as the screenshot and show the same thing. The tile falls
      // back to side A, turned down.
      const tile = page.locator('#tiles > .tile', { hasText: 'about' }).first();
      const picture = tile.locator('.tile__shot img');

      assert.equal(await picture.count(), 1, 'the tile still shows the page');
      assert.match(await picture.getAttribute('src') ?? '', /about--desktop\.a\.png$/);
      assert.ok(
        (await picture.getAttribute('class'))?.includes('is-flat'),
        'and shows it as the difference picture would have'
      );
      await page.close();
    });

    it('parses its stylesheet to the last rule', async () => {
      const { page } = await open(scheme);

      // One unbalanced brace swallows every rule after it, and nothing else
      // notices: the page still renders, just without half its styling.
      const sheet = await page.evaluate(() => {
        const style = document.querySelector('style') as HTMLStyleElement;
        const text = style.textContent ?? '';

        let blocks = 0;
        let depth = 0;
        for (let index = 0; index < text.length; index += 1) {
          if (text.startsWith('/*', index)) {
            index = text.indexOf('*/', index) + 1;
            continue;
          }
          if (text[index] === '{') depth += 1;
          else if (text[index] === '}') {
            depth -= 1;
            if (depth === 0) blocks += 1;
          }
        }

        return { blocks, depth, parsed: style.sheet ? style.sheet.cssRules.length : 0 };
      });

      assert.equal(sheet.depth, 0, 'every rule in the stylesheet is closed');
      assert.equal(sheet.parsed, sheet.blocks, 'the browser parsed every rule in the stylesheet');
      await page.close();
    });

    it('never lets a tile picture come away from its frame', async () => {
      const { page } = await open(scheme);

      // Centring the differing band on a change near the head of the page
      // used to push the picture down and leave the ground showing above it.
      const gaps = await page.$$eval('#tiles > .tile .tile__shot', (frames) =>
        frames
          .filter((frame) => frame.querySelector('img'))
          .map((frame) => {
            const window = frame.getBoundingClientRect();
            const picture = (frame.querySelector('img') as HTMLImageElement).getBoundingClientRect();
            if (picture.height <= window.height) return 0;
            return Math.round(Math.max(window.top - picture.top, picture.bottom - window.bottom) * -1);
          })
      );

      for (const gap of gaps) assert.ok(gap <= 0, `a tile shows ${gap}px of ground beside its picture`);
      await page.close();
    });

    it('never paints a label onto its own background', async () => {
      const { page } = await open(scheme);

      // Selected buttons have been made invisible twice, by a later rule
      // repainting the label in the colour it already sat on.
      await page.locator('#tiles > .tile').first().click();
      await page.waitForTimeout(150);

      for (const mode of ['diff', 'side', 'slider', 'onion', 'markup']) {
        const button = page.locator(`#modes button[data-mode="${mode}"]`);
        await button.click();
        await button.hover();
        await page.waitForTimeout(80);

        const colours = await button.evaluate((element) => {
          const style = getComputedStyle(element);
          return { text: style.color, background: style.backgroundColor };
        });

        assert.notEqual(colours.text, colours.background, `${mode} button is invisible in ${scheme}`);
      }

      await page.close();
    });

    it('holds no cards until a scenario is opened', async () => {
      const { page } = await open(scheme);
      assert.equal(await page.locator('.card').count(), 0);

      await page.locator('#tiles > .tile').first().click();
      await page.waitForTimeout(150);
      assert.equal(await page.locator('.card').count(), 1);

      await page.locator('#back').click();
      await page.waitForTimeout(150);
      assert.equal(await page.locator('.card').count(), 0);
      await page.close();
    });
  });
}

/**
 * The report is a shell, and the run is a pool of files beside it.
 *
 * What is being pinned here is a size: a run of nine hundred pages carries a
 * hundred and forty megabytes of markup diff, and the report used to open by
 * parsing all of it to draw an overview that shows none of it.
 */
describe('the report and the run beside it', () => {
  it('keeps the markup diff out of the page and beside it instead', async () => {
    const report = await renderReport(
      { ...RESULT, outDir: workDir },
      loadConfig(join(workDir, 'diffyard.yaml')),
      { selfContained: false }
    );

    assert.ok(!report.html.includes(inScript('<p>a</p>')), 'the hunks are not in the document');
    assert.match(report.html, /<script src="data\/run\.js">/, 'the document says where the run is');

    const written = new Map(report.files);
    assert.ok(written.has('data/run.js'), 'the index, for what the overview draws');
    assert.equal(written.size, RESULT.comparisons.length + 1, 'and a chunk per comparison');
    assert.ok(!(written.get('data/run.js') ?? '').includes(inScript('<p>a</p>')), 'not in the index either');

    // Read back the way a merge into this report would read it, which is the
    // only reason the chunk is one call around one JSON value.
    for (const [name, body] of report.files) writeFileSync(join(workDir, name), body);
    const held = await readCase(workDir, 'home--desktop');
    assert.deepEqual(held?.markupHunks, RESULT.comparisons[0]?.markupHunks, 'the hunks are in the chunk');
  });

  it('asks for a comparison only when its markup is looked at', async () => {
    const { page, errors } = await open('light');

    const asked: string[] = [];
    page.on('request', (request) => {
      const name = request.url().split('/').pop() ?? '';
      if (request.url().includes('/data/') && name !== 'run.js') asked.push(name);
    });

    // Opening the case is not asking for its markup: the diff view draws from
    // the index alone, which is the whole point of splitting them.
    await page.locator('.tile').first().click();
    await page.waitForTimeout(200);
    assert.deepEqual(asked, [], 'opening a comparison loads no chunk');

    await page.locator('#modes button[data-mode="markup"]').click();
    await page.waitForTimeout(400);
    assert.deepEqual(asked, ['home--desktop.js'], 'asking for the markup loads exactly its chunk');

    assert.equal(await page.getByText('Loading the markup diff').count(), 0, 'and it arrived');
    assert.ok((await page.locator('.patch tr').count()) > 0, 'with the diff on screen');
    assert.deepEqual(errors, []);
    await page.close();
  });

  it('says what it has when the chunk cannot be had', async () => {
    // A report rendered from a results.json written before there were chunks:
    // the markup view has to say so rather than wait for one for ever.
    const report = await renderReport(
      { ...RESULT, outDir: workDir },
      loadConfig(join(workDir, 'diffyard.yaml')),
      { selfContained: false }
    );
    const file = join(workDir, 'orphaned.html');
    writeFileSync(file, report.html);
    writeFileSync(join(workDir, 'data', 'run.js'), report.files[0]?.[1] ?? '');
    rmSync(join(workDir, 'data', 'home--desktop.js'), { force: true });

    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(`file://${file}`);
    await page.waitForTimeout(200);
    await page.locator('.tile').first().click();
    await page.locator('#modes button[data-mode="markup"]').click();
    await page.waitForTimeout(500);

    assert.equal(await page.getByText('Loading the markup diff').count(), 0, 'not left waiting');
    assert.match(
      (await page.locator('.warn').textContent()) ?? '',
      /\.patch file/,
      'and pointed at the file that does have it'
    );
    await page.close();
  });

  it('carries the whole run when it has to travel alone', async () => {
    const report = await renderReport(
      { ...RESULT, outDir: workDir },
      loadConfig(join(workDir, 'diffyard.yaml')),
      { selfContained: true }
    );

    assert.deepEqual(report.files, [], 'nothing goes beside a single file');
    assert.ok(report.html.includes(inScript('<p>a</p>')), 'so the hunks travel in it');
  });
});

describe('the console comparison', () => {
  it('puts each side in its own column and marks what only one said', async () => {
    const { page, errors } = await open('light');

    await page.locator('.tile').first().click();
    await page.locator('#modes button[data-mode="console"]').click();
    await page.waitForTimeout(300);

    assert.equal(await page.locator('.logs__side').count(), 2, 'one column per side');
    assert.equal(await page.locator('.logline').count(), 3, 'every line the run kept');

    // The 404 is on B alone, and that is the whole reason to look at this view.
    const only = page.locator('.logline--only');
    assert.equal(await only.count(), 1);
    assert.match((await only.textContent()) ?? '', /HTTP 404/);
    assert.match((await only.locator('.logline__kind').textContent()) ?? '', /httperror/);

    // A line said twice says so; a line said once does not carry an empty chip.
    assert.equal(await page.locator('.logline__count').count(), 2, 'only the repeated ones');
    assert.match((await page.locator('.logline__count').first().textContent()) ?? '', /×2/);

    assert.deepEqual(errors, []);
    await page.close();
  });
});

describe('report navigation', () => {
  it('opens the scenario named in the hash', async () => {
    const { page } = await open('light');
    await page.evaluate(() => {
      location.hash = 'about';
    });
    await page.waitForTimeout(200);

    assert.equal(await page.locator('#detail-name').textContent(), 'about');
    await page.close();
  });

  it('goes back to the overview with the browser button', async () => {
    const { page } = await open('light');
    await page.locator('#tiles > .tile').first().click();
    await page.waitForTimeout(150);

    await page.goBack();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#overview').isHidden(), false);
    await page.close();
  });

  it('filters the overview down to the failures', async () => {
    const { page } = await open('light');
    await page.locator('.filters button[data-filter="fail"]').click();
    await page.waitForTimeout(150);

    assert.equal(await page.locator('#tiles > .tile').count(), 2);
    await page.close();
  });

  it('shows an error instead of an image when a capture failed', async () => {
    const { page } = await open('light');
    await page.evaluate(() => {
      location.hash = 'broken';
    });
    await page.waitForTimeout(200);

    assert.match((await page.locator('.errorbox').textContent()) ?? '', /Timeout/);
    assert.equal(await page.locator('.frame').count(), 0);
    await page.close();
  });
});

describe('when a comparison was captured', () => {
  async function firstStat(scenario: string): Promise<{ text: string; title: string | null }> {
    const { page } = await open('light');
    await page.evaluate((name) => {
      location.hash = name;
    }, scenario);
    await page.waitForTimeout(250);

    // On the card, beside the verdict: in the row of measurements it was one
    // of eight items of one weight, and it read as none of them.
    const span = page.locator('.card .card__head .stamp').first();
    const text = ((await span.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    const title = await span.getAttribute('title');
    await page.close();
    return { text, title };
  }

  it('says so on every comparison, on the card itself', async () => {
    const { text, title } = await firstStat('home');

    assert.match(text, /^Captured /);
    // A report is read days after the run that made it, and on a page eight
    // thousand pixels tall the hour alone does not say which run this was.
    assert.match(text, /Aug/);
    assert.ok(title && title.includes('2026'), 'the exact moment is a hover away');
  });

  it('gives each side its own moment when they came from different runs', async () => {
    // Reuse makes "captured" two moments, and a difference measured across
    // two moments is a different claim from one measured across none.
    const { text } = await firstStat('about');

    assert.match(text, /A .*·.* B /);
  });

  it('shows the seconds when the two would otherwise read alike', async () => {
    // Thirty-two seconds apart round to the same minute, and two stamps that
    // read the same look like a mistake rather than like a difference.
    const { text } = await firstStat('about');
    const stamps = text.match(/\d{1,2}:\d{2}:\d{2}/g) ?? [];

    assert.equal(stamps.length, 2, `two stamps with seconds, got: ${text}`);
    assert.notEqual(stamps[0], stamps[1]);
  });
});

describe('the controls bar', () => {
  it('asks its questions on one row', async () => {
    // Status, kind, sort and search are four questions about the same list.
    // A row of chips per question pushed the first finding a screen down.
    const { page } = await open('light');

    const rows = await page.evaluate(() => {
      const tops = [...document.querySelectorAll('.controls > *')].map((element) =>
        Math.round(element.getBoundingClientRect().top / 10)
      );
      return new Set(tops).size;
    });

    assert.equal(rows, 1, 'every control sits on the same row');
    await page.close();
  });

  it('filters by kind through the control, not a row of buttons', async () => {
    const { page } = await open('light');

    const before = await page.locator('#tiles > .tile').count();
    const kind = await page.$eval('#kind', (select) =>
      [...(select as HTMLSelectElement).options].map((option) => option.value).find((value) => value !== 'any')
    );

    assert.ok(kind, 'the run found a kind to filter by');
    await page.selectOption('#kind', kind);
    await page.waitForTimeout(150);
    const after = await page.locator('#tiles > .tile').count();

    assert.ok(after < before, 'picking a kind narrows the overview');
    await page.close();
  });
});

describe('the slider', () => {
  /** Opens the first scenario with the slider showing. */
  async function slider(): Promise<Awaited<ReturnType<typeof open>>['page']> {
    const { page } = await open('light');
    await page.locator('#tiles > .tile').first().click();
    await page.waitForTimeout(150);
    await page.locator('#modes button[data-mode="slider"]').click();
    await page.waitForTimeout(200);
    return page;
  }

  it('scrolls, like every other view of a page taller than the frame', async () => {
    // It used to be overflow:hidden with an invisible range stretched over it,
    // so a page eight thousand pixels tall showed its first six hundred and
    // nothing would move it.
    const page = await slider();
    const frame = page.locator('.slider').first();

    assert.equal(await frame.evaluate((el) => getComputedStyle(el).overflowY), 'auto');

    const moved = await frame.evaluate((el) => {
      const before = el.scrollTop;
      el.scrollTop = before + 120;
      return el.scrollTop > before;
    });
    assert.ok(moved, 'the frame scrolls');
    await page.close();
  });

  it('keeps the two halves on the same row', async () => {
    // Both sides are one stage, so scrolling moves them together; aligning
    // them once and letting them drift is the failure this view exists to
    // avoid.
    const page = await slider();
    const aligned = await page.locator('.slider').first().evaluate((el) => {
      el.scrollTop = 200;
      const base = el.querySelector('.slider__stage > img')!;
      const overlay = el.querySelector('.slider__top img')!;
      const a = base.getBoundingClientRect();
      const b = overlay.getBoundingClientRect();
      return { sameTop: Math.abs(a.top - b.top) < 1, sameWidth: Math.abs(a.width - b.width) < 1 };
    });

    assert.deepEqual(aligned, { sameTop: true, sameWidth: true });
    await page.close();
  });

  it('moves the split when dragged across the picture', async () => {
    const page = await slider();
    const frame = page.locator('.slider').first();
    const box = (await frame.boundingBox())!;
    const width = () =>
      frame.evaluate((el) => el.querySelector('.slider__top')!.getBoundingClientRect().width);

    const before = await width();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
    await page.mouse.down();
    // Several steps: a native image drag used to cancel the pointer stream
    // after the first move and leave the split stuck.
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.4, { steps: 8 });
    await page.mouse.up();

    const after = await width();
    assert.ok(after > before * 1.4, `the split followed the pointer (${before} -> ${after})`);
    await page.close();
  });

  it('moves the split from the control below it', async () => {
    const page = await slider();
    const frame = page.locator('.slider').first();
    const width = () =>
      frame.evaluate((el) => el.querySelector('.slider__top')!.getBoundingClientRect().width);

    const before = await width();
    await page.locator('.slider__control input').first().fill('10');
    await page.waitForTimeout(150);

    assert.ok((await width()) < before, 'the range moves it too');
    await page.close();
  });
});

describe('report layout', () => {
  it('gives every card of a scenario the same width', async () => {
    const { page } = await open('light');
    await page.locator('#tiles > .tile').first().click();
    await page.waitForTimeout(150);

    const widths = await page.evaluate(() =>
      [...document.querySelectorAll('.card')].map((card) => Math.round(card.getBoundingClientRect().width))
    );
    assert.equal(new Set(widths).size, 1, `cards differ in width: ${widths.join(', ')}`);
    await page.close();
  });

  it('does not scroll sideways', async () => {
    const { page } = await open('light');
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    assert.equal(overflows, false);
    await page.close();
  });

  it('marks where the page differs on the minimap', async () => {
    const { page } = await open('light');
    await page.locator('#tiles > .tile').first().click();
    await page.waitForTimeout(150);

    // The fixture puts all of its change in one band, so exactly one shows.
    assert.equal(await page.locator('.map__band').count(), 1);
    await page.close();
  });
});
