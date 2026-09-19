import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../dist/config.js';
import { run } from '../dist/runner.js';
import type { RunResult } from '../dist/types.js';
import { page, serve } from './helpers/server.ts';
import type { RunningSite } from './helpers/server.ts';

/**
 * One site on its own.
 *
 * A config with no side B walks the pages of the one site and judges each on
 * what it said rather than on how much it changed: a 404, a script that threw,
 * a request that failed. The screenshot is the record, the verdict is the
 * answer.
 */

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-smoke-'));
let site: RunningSite;
let counter = 0;

const body = (title: string, extra = '') =>
  page({ title, body: `<h1>${title}</h1><p>A paragraph.</p>${extra}` });

before(async () => {
  site = await serve({
    pages: {
      index: body('Home'),
      // A warning is noise, not a finding.
      chatty: body('Chatty', '<script>console.warn("just saying");</script>'),
      // An error and an exception are two things gone wrong.
      broken: body('Broken', '<script>console.error("boom");</script><script>window.missing.call();</script>'),
      // A picture that is not there.
      thin: body('Thin', '<img src="/nowhere.png" width="100" height="100">'),
      gone: body('Not reached'),
      moved: body('Where it was'),
      elsewhere: body('Where it went'),
    },
    missing: ['gone', 'nowhere.png'],
    redirects: { moved: '/elsewhere' },
  });
});

after(async () => {
  await site?.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function smoke(yaml: string): Promise<RunResult> {
  const dir = join(workDir, `run-${counter++}`);
  const file = join(dir, 'diffyard.yaml');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, yaml.replaceAll('$SITE', site.url).replace('$OUT', join(dir, 'out')));
  return run(loadConfig(file));
}

function find(result: RunResult, scenario: string) {
  const comparison = result.comparisons.find((entry) => entry.scenario === scenario);
  assert.ok(comparison, `no entry named ${scenario}`);
  return comparison;
}

describe('checking one site', { concurrency: false }, () => {
  let result: RunResult;

  before(async () => {
    result = await smoke(`
compare:
  a: $SITE
output:
  dir: $OUT
  images: png
browser:
  viewports:
    desktop: { width: 600, height: 400 }
scenarios:
  - /
  - /chatty
  - /broken
  - /thin
  - /gone
  - /moved
`);
  });

  it('is a smoke run, and says so', () => {
    assert.equal(result.mode, 'smoke');
    assert.equal(result.config.b, '');
    assert.equal(result.settings.b, null);
    assert.equal(result.total, 6);
  });

  it('passes a page that answered and said nothing serious', () => {
    for (const name of ['index', 'chatty']) {
      const entry = find(result, name);
      assert.equal(entry.status, 'pass', name);
      assert.equal(entry.smoke?.answer.status, 200);
      assert.equal(entry.smoke?.errors, 0);
      assert.equal(entry.diff, null, 'there is nothing to diff against');
      assert.equal(entry.urlB, '');
    }
    // The warning is kept, and did not count.
    assert.equal(find(result, 'chatty').logs?.a.length, 1);
  });

  it('fails a page that threw', () => {
    const entry = find(result, 'broken');
    assert.equal(entry.status, 'fail');
    assert.equal(entry.smoke?.answer.status, 200, 'the page itself was fine');
    assert.equal(entry.smoke?.errors, 2, 'the console error and the exception');
    assert.equal(entry.logs?.errorsA, 2);
    assert.equal(entry.logs?.differs, false, 'nothing is "on one side" with one side');
  });

  it('fails a page whose picture never came', () => {
    const entry = find(result, 'thin');
    assert.equal(entry.status, 'fail');
    assert.equal(entry.smoke?.errors, 1);
    assert.match(entry.logs?.a[0]?.text ?? '', /404/);
  });

  it('fails a page that is not there', () => {
    const entry = find(result, 'gone');
    assert.equal(entry.status, 'fail');
    assert.equal(entry.smoke?.answer.status, 404);
    assert.ok(entry.files.a, 'and still keeps the picture of what came back');
  });

  it('notes a redirect without failing on it', () => {
    const entry = find(result, 'moved');
    assert.equal(entry.status, 'pass');
    assert.equal(entry.smoke?.answer.redirected, true);
    assert.equal(entry.smoke?.answer.path, '/elsewhere');
  });

  it('writes one picture and one document per page, and nothing of a side B', () => {
    const entry = find(result, 'index');
    assert.equal(entry.files.a, 'shots/index--desktop.a.png');
    assert.equal(entry.files.b, null);
    assert.equal(entry.files.diff, null);
    assert.equal(entry.files.htmlA, 'shots/index--desktop.a.html');
    assert.equal(entry.files.htmlB, null);
    assert.ok(existsSync(join(result.outDir, entry.files.a)));
    assert.ok(existsSync(join(result.outDir, entry.files.htmlA)));
    assert.match(readFileSync(join(result.outDir, entry.files.htmlA), 'utf8'), /<h1>/);
    assert.equal(entry.capture?.b, null);
  });

  it('tallies the run the way a comparison is tallied', () => {
    assert.equal(result.passed, 3);
    assert.equal(result.failed, 3);
    assert.equal(result.errored, 0);
  });

  it('offers no side to keep while the other is taken again', () => {
    assert.equal(result.commands.a, null);
    assert.equal(result.commands.b, null);
    assert.match(result.commands.all, /^diffyard run /);
  });
});

describe('a smoke run without console recording', { concurrency: false }, () => {
  it('judges on the answer alone', async () => {
    const result = await smoke(`
compare:
  a: $SITE
output:
  dir: $OUT
logs:
  enabled: false
browser:
  viewports:
    desktop: { width: 600, height: 400 }
scenarios:
  - /broken
  - /gone
`);

    assert.equal(find(result, 'broken').status, 'pass', 'nothing was listened for');
    assert.equal(find(result, 'broken').logs, null);
    assert.equal(find(result, 'gone').status, 'fail', 'but a 404 is still a 404');
  });
});

describe('a smoke run as the reference of a comparison', { concurrency: false }, () => {
  it('lends its side A to a later comparison', async () => {
    const first = await smoke(`
compare:
  a: $SITE
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 600, height: 400 }
scenarios:
  - /
`);
    assert.equal(first.mode, 'smoke');
    // The CLI writes this after a run; it is what a later run reads.
    writeFileSync(join(first.outDir, 'results.json'), `${JSON.stringify(first, null, 2)}\n`);

    // The same site on both sides, so the comparison has something to take
    // side A from and something to hold it against.
    const dir = join(workDir, `run-${counter++}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'diffyard.yaml');
    writeFileSync(
      file,
      `
compare:
  a: ${site.url}
  b: ${site.url}
output:
  dir: ${first.outDir.slice(0, first.outDir.lastIndexOf('/'))}
reuse:
  side: a
  from: ${first.runId}
browser:
  viewports:
    desktop: { width: 600, height: 400 }
scenarios:
  - /
`
    );
    const second = await run(loadConfig(file));

    const entry = find(second, 'index');
    assert.equal(second.mode, 'compare');
    assert.equal(entry.capture?.a.reusedFrom?.runId, first.runId, 'side A came from the smoke run');
    assert.equal(entry.status, 'pass');
    assert.equal(entry.diff?.diffPixels, 0);
    assert.equal(entry.markup?.identical, true, 'the document it kept reads the same');
  });
});
