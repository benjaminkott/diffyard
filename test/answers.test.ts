import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../dist/config.js';
import { run } from '../dist/runner.js';
import type { RunResult } from '../dist/types.js';
import { page, serve } from './helpers/server.ts';
import type { RunningSite } from './helpers/server.ts';

/**
 * Whether the two sides answered the same question.
 *
 * A page that is 200 here and 404 there has not changed; it is a different
 * page. Its pixels can be compared -- both sides came back with something --
 * and the percentage between them is arithmetic on a mistake. The same goes
 * for an address one side moves and the other does not.
 */

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-answers-'));
let siteA: RunningSite;
let siteB: RunningSite;
let counter = 0;

const body = (title: string) => page({ title, body: `<h1>${title}</h1><p>A paragraph.</p>` });

before(async () => {
  siteA = await serve({
    pages: { index: body('Home'), gone: body('Still here'), moved: body('Where it was') },
  });
  siteB = await serve({
    pages: {
      index: body('Home'),
      elsewhere: body('Where it went'),
      // The same page as side A's index, under the name this side gives it.
      startseite: body('Home'),
    },
    // The same two addresses, answered differently by this side.
    missing: ['gone'],
    redirects: { moved: '/elsewhere' },
  });
});

after(async () => {
  await siteA?.close();
  await siteB?.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function compare(path: string): Promise<RunResult> {
  const dir = join(workDir, `run-${counter++}`);
  const file = join(dir, 'diffyard.yaml');
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
  - ${path}
`
  );
  return run(loadConfig(file));
}

describe('when the two sides answer differently', () => {
  it('fails on the answer, not on how much a 404 looks like a page', async () => {
    const result = await compare('/gone');
    const comparison = result.comparisons[0];

    assert.ok(comparison);
    assert.equal(comparison.status, 'fail');
    assert.ok(comparison.answers, 'what each side said is recorded');
    assert.equal(comparison.answers.a.status, 200);
    assert.equal(comparison.answers.b.status, 404);
    assert.deepEqual(comparison.kinds, ['answer'], 'and nothing read off the pixels');
  });

  it('says when one side moved the address and the other did not', async () => {
    const result = await compare('/moved');
    const comparison = result.comparisons[0];

    assert.ok(comparison?.answers);
    assert.equal(comparison.answers.a.redirected, false);
    assert.equal(comparison.answers.b.redirected, true);
    assert.equal(comparison.answers.b.path, '/elsewhere', 'and where it went, for the report to name');
    assert.equal(comparison.status, 'fail', 'two different pages are not a passing comparison');
  });

  it('leaves a scenario that names an address per side alone', async () => {
    // The two sides are meant to be asked different things here -- the same
    // page under two names is what this tool exists to compare -- so their
    // landings are not comparable and only the behaviour is.
    const dir = join(workDir, `run-${counter++}`);
    const file = join(dir, 'diffyard.yaml');
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
  - name: paired
    a: /
    b: /startseite
`
    );

    const comparison = (await run(loadConfig(file))).comparisons[0];
    assert.ok(comparison);
    assert.equal(comparison.answers, null, 'neither side moved, so there is nothing to say');
    assert.notEqual(comparison.status, 'fail', 'and it is judged on its pixels, not its address');
  });

  it('says nothing where both sides answered the same way', async () => {
    const result = await compare('/');
    const comparison = result.comparisons[0];

    assert.ok(comparison);
    assert.equal(comparison.answers, null, 'no note where there is nothing to note');
    assert.equal(comparison.status, 'pass');
  });
});
