import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../dist/config.js';
import { fingerprint, ReuseError, ReuseStore } from '../dist/reuse.js';
import { run } from '../dist/runner.js';
import type { Config, RunResult, Side } from '../dist/types.js';
import { page, serve } from './helpers/server.ts';
import type { RunningSite } from './helpers/server.ts';

/**
 * Reusing one side of a comparison from an earlier run.
 *
 * The two things that have to hold: the numbers must come out the same as a
 * full run, and a shot taken under different settings must never be used
 * quietly.
 */

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-reuse-'));
let siteA: RunningSite;
let siteB: RunningSite;

before(async () => {
  siteA = await serve({
    pages: {
      index: page({ title: 'Home', body: '<h1>Home</h1><p id="text">Original</p>' }),
      about: page({ title: 'About', body: '<h1>About</h1>' }),
    },
  });
  siteB = await serve({
    pages: {
      index: page({ title: 'Home', body: '<h1>Home</h1><p id="text">Replaced</p>' }),
      about: page({ title: 'About', body: '<h1>About</h1>' }),
    },
  });
});

after(async () => {
  await siteA?.close();
  await siteB?.close();
  rmSync(workDir, { recursive: true, force: true });
});

let counter = 0;

function config(yaml: string, outDir: string): Config {
  const dir = mkdtempSync(join(workDir, `cfg-${counter++}-`));
  const file = join(dir, 'diffyard.yaml');
  writeFileSync(
    file,
    yaml.replaceAll('$A', siteA.url).replaceAll('$B', siteB.url).replaceAll('$OUT', outDir)
  );
  return loadConfig(file);
}

/**
 * A run plus the results.json the CLI writes afterwards, which is the file a
 * later run reads to find out what it may reuse.
 */
async function runAndRecord(yaml: string, outDir: string): Promise<RunResult> {
  const result = await run(config(yaml, outDir));
  await writeFile(join(result.outDir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const BASE = `
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
`;

describe('reusing a side', { concurrency: false }, () => {
  it('takes side A from the earlier run and reports where it came from', async () => {
    const out = join(workDir, 'out-basic');
    const first = await runAndRecord(BASE, out);
    const second = await runAndRecord(`${BASE}reuse:\n  side: a\n`, out);

    const before = first.comparisons.find((entry) => entry.scenario === 'index');
    const after = second.comparisons.find((entry) => entry.scenario === 'index');

    assert.equal(after?.capture?.a.reusedFrom?.runId, first.runId);
    assert.equal(after?.capture?.b.reusedFrom, null, 'side B is still captured');
    assert.equal(second.reuse?.reused, 2);
    assert.equal(second.reuse?.recaptured, 0);

    // The whole point: the same reference produces the same measurement.
    assert.equal(after?.diff?.diffPixels, before?.diff?.diffPixels);
    assert.equal(after?.markup?.added, before?.markup?.added);
    assert.equal(after?.markup?.removed, before?.markup?.removed);
    assert.equal(after?.status, before?.status);
  });

  it('writes the reused screenshot into the new run, so it stands alone', async () => {
    const out = join(workDir, 'out-standalone');
    await runAndRecord(BASE, out);
    const second = await runAndRecord(`${BASE}reuse:\n  side: a\n`, out);

    const comparison = second.comparisons[0];
    assert.ok(comparison?.files.a);
    const png = await readFile(join(second.outDir, comparison.files.a));
    assert.ok(png.length > 0);
  });

  it('captures again when a setting no longer matches, and says so', async () => {
    const out = join(workDir, 'out-changed');
    await runAndRecord(BASE, out);

    // A different viewport height is a different photograph, whatever the id.
    const second = await runAndRecord(
      `
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 900 }
scenarios:
  - /
  - /about
reuse:
  side: a
`,
      out
    );

    assert.equal(second.reuse?.reused, 0);
    assert.equal(second.comparisons[0]?.capture?.a.reusedFrom, null);
    assert.equal(second.comparisons[0]?.capture?.a.recapturedBecause, 'settings changed');
  });

  it('runs a newly added scenario along, rather than failing on it', async () => {
    const out = join(workDir, 'out-grown');
    await runAndRecord(`${BASE.replace('  - /about\n', '')}`, out);

    const second = await runAndRecord(`${BASE}reuse:\n  side: a\n`, out);
    const added = second.comparisons.find((entry) => entry.scenario === 'about');

    assert.equal(added?.status, 'pass');
    assert.equal(added?.capture?.a.reusedFrom, null);
    assert.equal(added?.capture?.a.recapturedBecause, 'not in that run');
    assert.equal(second.reuse?.reused, 1, 'the page that was there is still reused');
  });
});

describe('the fingerprint', () => {
  const load = (yaml: string) => config(yaml, join(workDir, 'unused'));

  const of = (yaml: string, side: Side = 'a'): string => {
    const parsed = load(yaml);
    const scenario = parsed.scenarios[0]!;
    return fingerprint(parsed, scenario, scenario.viewports[0]!, side);
  };

  it('is the same for the same settings', () => {
    assert.equal(of(BASE), of(BASE));
  });

  it('differs between the two sides', () => {
    assert.notEqual(of(BASE, 'a'), of(BASE, 'b'));
  });

  it('changes when the page is asked for differently', () => {
    const withScenario = (body: string) => `
compare:
  a: $A
  b: $B
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 800, height: 600 }
scenarios:
${body}`;

    const cases: [string, string][] = [
      ['viewport', BASE.replace('height: 600', 'height: 900')],
      ['steps', withScenario('  - path: /\n    steps:\n      - click: "#toggle"\n')],
      ['waitUntil', withScenario('  - path: /\n    waitUntil: load\n')],
      ['clip', withScenario('  - path: /\n    clip: "h1"\n')],
      ['mask', `${BASE}diff:\n  mask: [".ad"]\n`],
      ['address', BASE.replace('  - /\n', '  - /elsewhere\n')],
      // Comments and whitespace are applied when the document is saved, so a
      // saved one cannot answer for settings it was not written under.
      ['markup normalisation', `${BASE}markup:\n  ignoreComments: true\n`],
    ];

    for (const [what, yaml] of cases) {
      assert.notEqual(of(yaml), of(BASE), `${what} should change the fingerprint`);
    }
  });

  it('does not change when only the ignore rules change', () => {
    // Those are applied to the saved document at diff time, which keeps
    // everything — so an earlier shot still answers for them.
    assert.equal(of(`${BASE}markup:\n  ignoreAttributes: [nonce]\n`), of(BASE));
  });

  it('does not change when only the threshold changes', () => {
    // It decides pass or fail, not what the picture looks like.
    assert.equal(of(`${BASE}diff:\n  threshold: 0.5\n`), of(BASE));
  });
});

describe('choosing the run to reuse from', () => {
  it('refuses a name that is not there, and lists what is', async () => {
    const out = join(workDir, 'out-missing');
    await runAndRecord(BASE, out);

    await assert.rejects(
      () => ReuseStore.open(out, 'nightly'),
      (error: unknown) =>
        error instanceof ReuseError &&
        /No run called "nightly"/.test((error as Error).message) &&
        /Runs there:/.test((error as Error).message)
    );
  });

  it('says so when there is no run at all', async () => {
    await assert.rejects(
      () => ReuseStore.open(join(workDir, 'out-empty'), 'latest'),
      (error: unknown) => error instanceof ReuseError && /no finished run yet/.test((error as Error).message)
    );
  });

  it('ignores a directory that has no results.json yet', async () => {
    // The directory a run in flight has already claimed is exactly the one not
    // to reuse: it holds half a run.
    const out = join(workDir, 'out-inflight');
    const first = await runAndRecord(BASE, out);
    mkdirSync(join(out, 'zzz-still-running'), { recursive: true });

    const store = await ReuseStore.open(out, 'latest');
    assert.equal(store.source.runId, first.runId);
  });

  it('refuses a run made before fingerprints existed', async () => {
    const out = join(workDir, 'out-old');
    const first = await runAndRecord(BASE, out);

    const stripped = {
      ...first,
      comparisons: first.comparisons.map((entry) => ({ ...entry, capture: null })),
    };
    await writeFile(join(first.outDir, 'results.json'), JSON.stringify(stripped));

    await assert.rejects(
      () => ReuseStore.open(out, 'latest'),
      (error: unknown) => error instanceof ReuseError && /no capture fingerprints/.test((error as Error).message)
    );
  });
});
