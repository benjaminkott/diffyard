import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../dist/config.js';
import { run } from '../dist/runner.js';
import type { RunResult } from '../dist/types.js';
import { page, serve } from './helpers/server.ts';
import type { RunningSite } from './helpers/server.ts';

/**
 * End-to-end over two locally served sites.
 *
 * Everything below the config — the browser, the steps, the screenshots, both
 * diffs, the run folder — only really holds together when it is exercised
 * together, and two local sites can be made to differ in exactly one known way.
 */

const BODY = `
<h1>Example</h1>
<div class="block"></div>
<div class="block"></div>
<p id="text">Original text</p>
<button id="toggle">Menu</button>
<nav id="menu" hidden><a href="/about">About</a></nav>
<script>
  document.getElementById('toggle').addEventListener('click', () => {
    document.getElementById('menu').hidden = false;
  });
</script>
`;

/** Logged by both sides, so it must not read as a finding. */
const SHARED_WARNING = '<script>console.warn("shared warning");</script>';

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-e2e-'));
let siteA: RunningSite;
let siteB: RunningSite;

before(async () => {
  siteA = await serve({
    pages: {
      index: page({ title: 'Example', body: BODY }),
      about: page({ title: 'About', body: '<h1>About</h1><div class="block"></div>' }),
      identical: page({ title: 'Identical', body: '<h1>Same</h1>' }),
      taller: page({ title: 'Taller', body: '<h1>Short</h1>' }),
      'legacy-route': page({ title: 'Contact', body: '<h1>Contact</h1>' }),
      noisy: page({
        title: 'Noisy',
        body: '<h1>Noisy</h1>' + SHARED_WARNING,
      }),
    },
  });

  siteB = await serve({
    pages: {
      // Same layout, one changed paragraph and one extra meta tag.
      index: page({
        title: 'Example',
        head: '<meta name="generator" content="new">',
        body: BODY.replace('Original text', 'Replaced text'),
      }),
      about: page({ title: 'About', body: '<h1>About</h1><div class="block"></div>' }),
      identical: page({ title: 'Identical', body: '<h1>Same</h1>' }),
      taller: page({
        title: 'Taller',
        body: '<h1>Short</h1><div class="tall"></div><div class="tall"></div>',
      }),
      'new-route': page({ title: 'Contact', body: '<h1>Contact</h1>' }),
      noisy: page({
        title: 'Noisy',
        body:
          '<h1>Noisy</h1>' +
          SHARED_WARNING +
          '<script>console.error("only on B");</script>' +
          '<script>window.missing.call();</script>',
      }),
    },
  });
});

after(async () => {
  await siteA?.close();
  await siteB?.close();
  rmSync(workDir, { recursive: true, force: true });
});

let counter = 0;

/** Runs a comparison from YAML, the way the CLI would. */
async function compare(yaml: string, signal?: AbortSignal): Promise<RunResult> {
  const dir = join(workDir, `run-${counter++}`);
  const file = join(dir, 'diffyard.yaml');
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(join(workDir, '.keep'), '');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    file,
    yaml
      .replaceAll('$A', siteA.url)
      .replaceAll('$B', siteB.url)
      .replace('$OUT', join(dir, 'out'))
  );

  return run(loadConfig(file), { signal });
}

function find(result: RunResult, scenario: string) {
  const comparison = result.comparisons.find((entry) => entry.scenario === scenario);
  assert.ok(comparison, `no comparison named ${scenario}`);
  return comparison;
}

/**
 * What a Ctrl+C leaves behind.
 *
 * A run cut short used to leave nothing: the process died where it stood, so
 * twenty minutes of captures went with it. What it leaves now is a whole
 * report -- what it got through, and a named entry for everything it did not,
 * which is what `--unfinished` reads to carry on.
 */
/**
 * The report, while the run is still filling it in.
 *
 * The page is written once and never changes; what grows is the data beside
 * it. So it can be opened as soon as the run starts, and refreshed to see
 * where it has got to.
 */
describe('a run in progress', { concurrency: false }, () => {
  it('lays the page out before it has captured anything', async () => {
    const seen: { done: number; total: number }[] = [];

    const dir = join(workDir, `run-${counter++}`);
    const file = join(dir, 'diffyard.yaml');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      `
compare:
  a: ${siteA.url}
  b: ${siteB.url}
output:
  dir: ${join(dir, 'out')}
browser:
  viewports:
    desktop: { width: 500, height: 400 }
markup:
  enabled: false
scenarios:
  - /identical
  - /changed
  - /moved
`
    );

    const result = await run(loadConfig(file), {
      onSnapshot: (snapshot) => {
        seen.push({ done: snapshot.comparisons.length, total: snapshot.total });
      },
    });

    assert.ok(seen.length > 0, 'the report is written before the run ends');
    assert.equal(seen[0]?.done, 0, 'the first one has nothing in it yet');
    assert.equal(seen[0]?.total, 3, 'but knows how many there will be');
    assert.equal(result.comparisons.length, 3, 'and the run itself still finishes');
  });
});

describe('a run that is stopped', { concurrency: false }, () => {
  it('still writes a report, with the ones it never reached named', async () => {
    const stopping = new AbortController();
    stopping.abort();

    const result = await compare(
      `
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
  - /identical
  - /changed
  - /moved
`,
      stopping.signal
    );

    assert.equal(result.comparisons.length, 3, 'every comparison has a place in the report');
    assert.equal(result.total, 3);

    for (const comparison of result.comparisons) {
      assert.equal(comparison.status, 'timeout', comparison.id);
      assert.match(comparison.error ?? '', /Stopped/, 'and says why it has nothing');
      assert.equal(comparison.diff, null);
    }

    // --unfinished reads exactly this: the ones that came back with nothing.
    const unfinished = result.comparisons.filter(
      (entry) => entry.status === 'error' || entry.status === 'timeout'
    );
    assert.equal(unfinished.length, 3, 'so all three are waiting to be picked up');
  });
});

describe('comparing two sites', { concurrency: false }, () => {
  it('reports an identical page as unchanged', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
  - /identical
`);

    const comparison = find(result, 'identical');
    assert.equal(comparison.status, 'pass');
    assert.equal(comparison.diff?.diffPixels, 0);
    assert.equal(comparison.markup?.identical, true);
  });

  it('finds the page that changed and leaves the others alone', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
  - /
  - /about
`);

    assert.equal(find(result, 'about').status, 'pass');

    const home = find(result, 'index');
    assert.equal(home.status, 'fail');
    assert.ok((home.diff?.ratio ?? 0) > 0, 'the changed paragraph should show up in pixels');
  });

  it('explains the change in the markup diff', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
  - /
`);

    const home = find(result, 'index');
    assert.equal(home.markup?.identical, false);
    assert.ok(home.files.patch, 'a patch file is written');

    const patch = readFileSync(join(result.outDir, home.files.patch!), 'utf8');
    assert.match(patch, /-\s+Original text/);
    assert.match(patch, /\+\s+Replaced text/);
    assert.match(patch, /\+.*generator/);
  });

  it('pads and flags pages of different height', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
  - /taller
`);

    const comparison = find(result, 'taller');
    assert.equal(comparison.diff?.sizeMismatch, true);
    assert.ok((comparison.diff?.sizeB.height ?? 0) > (comparison.diff?.sizeA.height ?? 0));
  });

  it('compares two addresses that differ per side', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
  - name: contact
    a: /legacy-route
    b: /new-route
`);

    const comparison = find(result, 'contact');
    assert.match(comparison.urlA, /legacy-route$/);
    assert.match(comparison.urlB, /new-route$/);
    assert.equal(comparison.status, 'pass', 'same page under two names is not a difference');
  });

  it('compares two full URLs, ignoring the base URLs', async () => {
    const result = await compare(`
compare:
  a: https://invalid.test/
  b: https://also-invalid.test/
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
  - name: absolute
    a: $Aidentical
    b: $Bidentical
`);

    const comparison = find(result, 'absolute');
    assert.equal(comparison.status, 'pass');
    assert.doesNotMatch(comparison.urlA, /invalid\.test/);
  });

  it('captures the state the steps left the page in', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
  - name: menu-open
    path: /
    fullPage: false
    steps:
      - click: "#toggle"
      - waitFor: "#menu"
`);

    const comparison = find(result, 'menu-open');
    const patch = readFileSync(join(result.outDir, comparison.files.patch!), 'utf8');

    // The nav is hidden until the step clicks; the serialised DOM proves it ran.
    assert.doesNotMatch(patch, /hidden/);
    const htmlA = readFileSync(join(result.outDir, comparison.files.htmlA!), 'utf8');
    assert.match(htmlA, /<nav id="menu">/);
  });

  it('reports a step that cannot run, naming the scenario', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
timeouts:
  action: 1500
scenarios:
  - name: broken
    path: /
    steps:
      - click: "#does-not-exist"
`);

    const comparison = find(result, 'broken');
    assert.equal(comparison.status, 'error');
    assert.match(comparison.error ?? '', /broken/);
    assert.match(comparison.error ?? '', /#does-not-exist/);
  });

  it('skips an optional step that cannot run', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
timeouts:
  action: 1500
scenarios:
  - name: tolerant
    path: /identical
    steps:
      - click: "#does-not-exist"
        optional: true
`);

    assert.equal(find(result, 'tolerant').status, 'pass');
  });

  it('runs a beforeEach group only when its trigger is there', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
timeouts:
  action: 1500
beforeEach:
  - name: absent banner
    when: "#no-such-banner"
    timeout: 400
    steps:
      - click: "#no-such-banner"
scenarios:
  - /identical
`);

    assert.equal(find(result, 'identical').status, 'pass');
  });

  it('writes the run into its own folder with the screenshots', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
  - /identical
`);

    assert.match(result.runId, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[0-9a-f]{6}$/);
    assert.ok(result.outDir.endsWith(result.runId));
    assert.ok(existsSync(join(result.outDir, '..', '.gitignore')), 'the output dir ignores itself');

    const comparison = find(result, 'identical');
    for (const file of [comparison.files.a, comparison.files.b]) {
      assert.ok(file && existsSync(join(result.outDir, file)), `${file} exists`);
    }

    // Nothing differed, so the difference picture would have been the
    // screenshot again with nothing marked on it, at the same cost.
    assert.equal(comparison.files.diff, null, 'no difference picture where there is no difference');
  });

  it('writes the difference picture where there is a difference', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
  - /
`);

    const comparison = find(result, 'index');
    assert.ok(comparison.files.diff, 'a difference has a picture');
    assert.ok(existsSync(join(result.outDir, comparison.files.diff)), 'and it is on disk');
  });

  it('records what each side said, and marks what only one of them said', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
  - /noisy
`);

    const logs = find(result, 'noisy').logs;
    assert.ok(logs, 'the console was recorded');

    // The warning both sides log is how the site is, not a finding.
    assert.equal(logs.onlyA, 0);
    assert.ok(logs.a.some((entry) => entry.text.includes('shared warning')));
    assert.ok(logs.b.some((entry) => entry.text.includes('shared warning')));

    assert.equal(logs.differs, true);
    assert.ok(logs.b.some((entry) => entry.kind === 'error' && entry.text.includes('only on B')));
    assert.ok(logs.b.some((entry) => entry.kind === 'pageerror'));
    assert.equal(logs.errorsA, 0);
    assert.ok(logs.seriousOnOneSide >= 2, 'the error and the exception both count');
  });

  it('keeps the console out of it when recording is off', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
logs:
  enabled: false
scenarios:
  - /noisy
`);

    assert.equal(find(result, 'noisy').logs, null);
  });

  it('writes each comparison beside its own screenshots', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
  - /noisy
`);

    // results.json holds the whole run, which is the wrong shape for looking
    // at one case: a scenario should be a directory listing.
    const comparison = find(result, 'noisy');
    assert.ok(comparison.files.result);

    const saved = JSON.parse(readFileSync(join(result.outDir, comparison.files.result!), 'utf8'));
    assert.equal(saved.id, comparison.id);
    assert.equal(saved.diff.ratio, comparison.diff?.ratio);
    assert.deepEqual(saved.diff.regions, comparison.diff?.regions);
    assert.equal(saved.logs.seriousOnOneSide, comparison.logs?.seriousOnOneSide);
  });

  it('runs a scenario in each viewport it names', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    mobile: { width: 400, height: 600 }
    desktop: { width: 800, height: 600 }
scenarios:
  - /identical
  - name: only-mobile
    path: /identical
    viewports: [mobile]
`);

    assert.equal(result.total, 3);
    assert.deepEqual(
      result.comparisons.filter((entry) => entry.scenario === 'only-mobile').map((entry) => entry.viewport.name),
      ['mobile']
    );
  });

  it('honours a threshold that allows the difference', async () => {
    const strict = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
diff:
  threshold: 0
scenarios:
  - /
`);
    assert.equal(find(strict, 'index').status, 'fail');

    const lenient = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
diff:
  threshold: 1
scenarios:
  - /
`);
    assert.equal(find(lenient, 'index').status, 'pass');
  });

  it('masks a region out of the comparison', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
diff:
  threshold: 0
  mask: ["#text"]
scenarios:
  - /
`);

    assert.equal(find(result, 'index').status, 'pass', 'the only visual change was masked');
  });

  it('skips a scenario marked skip', async () => {
    const result = await compare(`
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
  - name: ignored
    path: /
    skip: true
  - /identical
`);

    assert.equal(find(result, 'ignored').status, 'skipped');
    assert.equal(result.skipped, 1);
  });
});
