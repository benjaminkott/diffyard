import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { page, serve } from './helpers/server.ts';
import type { RunningSite } from './helpers/server.ts';
import type { RunResult } from '../dist/types.js';
import { readCase } from '../dist/report/pool.js';

/**
 * Re-running one comparison into the report it came from.
 *
 * This goes through the built command line rather than the library, because
 * the thing being tested is the line the report hands you to paste: if it does
 * not run as written, it is worse than not being there.
 */

const run = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'bin', 'diffyard.mjs');

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-refresh-'));
let siteA: RunningSite;
let siteB: RunningSite;

before(async () => {
  siteA = await serve({
    pages: {
      index: page({ title: 'Home', body: '<h1>Home</h1>' }),
      about: page({ title: 'About', body: '<h1>About</h1><p>Original</p>' }),
    },
  });
  siteB = await serve({
    pages: {
      index: page({ title: 'Home', body: '<h1>Home</h1>' }),
      about: page({ title: 'About', body: '<h1>About</h1><p>Replaced</p>' }),
    },
  });
});

after(async () => {
  await siteA?.close();
  await siteB?.close();
  rmSync(workDir, { recursive: true, force: true });
});

let counter = 0;

function project(): { dir: string; config: string; out: string } {
  const dir = join(workDir, `p-${counter++}`);
  mkdirSync(dir, { recursive: true });

  const config = join(dir, 'diffyard.yaml');
  writeFileSync(
    config,
    `
compare:
  a: ${siteA.url}
  b: ${siteB.url}
output:
  dir: out
browser:
  viewports:
    desktop: { width: 400, height: 300 }
scenarios:
  - /
  - /about
`
  );

  return { dir, config: 'diffyard.yaml', out: join(dir, 'out') };
}

async function diffyard(dir: string, args: string[]): Promise<string> {
  // Exit code 1 only means something differs, which every run here does.
  try {
    const { stdout } = await run(process.execPath, [CLI, 'run', ...args], { cwd: dir });
    return stdout;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (failure.code === 1 && failure.stdout) return failure.stdout;
    throw new Error(`diffyard ${args.join(' ')} failed: ${failure.stderr ?? String(error)}`);
  }
}

function results(out: string, runId: string): RunResult {
  return JSON.parse(readFileSync(join(out, runId, 'results.json'), 'utf8')) as RunResult;
}

function latest(out: string): string {
  return readdirSync(out).filter((name) => name.startsWith('20')).sort().at(-1)!;
}

describe('the command a result carries', () => {
  it('runs that one comparison again, into the same report', async () => {
    const { dir, config, out } = project();
    await diffyard(dir, [config]);

    const runId = latest(out);
    const before = results(out, runId);
    const target = before.comparisons.find((entry) => entry.scenario === 'about');

    assert.ok(target?.command, 'every comparison carries the line to re-run it');
    assert.match(target.command, /--case about--desktop/);
    assert.match(target.command, new RegExp(`--into ${runId}`));

    // Paste it, as written.
    const [, ...args] = target.command.split(' ');
    const output = await diffyard(dir, args.slice(1));
    assert.match(output, /1\/1/, 'it runs exactly one comparison');

    const after = results(out, runId);
    assert.equal(after.total, 2, 'the other finding is still in the report');
    assert.equal(readdirSync(out).filter((name) => name.startsWith('20')).length, 1, 'no second run folder');

    const refreshed = after.comparisons.find((entry) => entry.scenario === 'about');
    const untouched = after.comparisons.find((entry) => entry.scenario === 'index');
    assert.ok(refreshed && untouched);
    assert.ok(refreshed.ranAt > target.ranAt, 'the one asked for ran again');
    assert.equal(untouched.ranAt, before.comparisons.find((e) => e.scenario === 'index')?.ranAt);
  });

  it('leaves the markup diff of what it did not run standing', async () => {
    const { dir, config, out } = project();
    await diffyard(dir, [config]);
    const runId = latest(out);

    // 'about' is the one that differs, so it is the one whose chunk is worth
    // losing. Refreshing the other page is what puts a merge in the way of it.
    const before = await readCase(join(out, runId), 'about--desktop');
    assert.ok((before?.markupHunks?.length ?? 0) > 0, 'it had a markup diff to begin with');

    const kinds = results(out, runId).comparisons.find((entry) => entry.scenario === 'about')?.kinds;

    await diffyard(dir, [config, '--case', 'index--desktop', '--into', runId]);

    // results.json does not carry the hunks, so a merge that did not read the
    // chunk back would classify this as having no markup change and then write
    // the chunk out again empty -- losing exactly what the report is for.
    const after = await readCase(join(out, runId), 'about--desktop');
    assert.deepEqual(after?.markupHunks, before?.markupHunks, 'and still has it, unchanged');
    assert.deepEqual(
      results(out, runId).comparisons.find((entry) => entry.scenario === 'about')?.kinds,
      kinds,
      'so it is still filed under the same kinds'
    );
  });

  it('clears what the report no longer refers to', async () => {
    const { dir, config, out } = project();
    await diffyard(dir, [config]);
    const runId = latest(out);
    const shots = join(out, runId, 'shots');

    // What a picture stored under a name the run no longer writes looks like:
    // a run folder is written into again, and until every file kept the same
    // name each write landed on its predecessor.
    const orphan = join(shots, 'about--desktop.a.png');
    writeFileSync(orphan, 'a picture from a run that stored them differently');
    assert.ok(existsSync(orphan));

    await diffyard(dir, [config, '--case', 'about--desktop', '--into', runId]);

    assert.ok(!existsSync(orphan), 'the file no comparison names is gone');
    const kept = results(out, runId).comparisons.find((entry) => entry.scenario === 'index');
    assert.ok(kept?.files.a && existsSync(join(out, runId, kept.files.a)),
      'and a comparison this run did not touch keeps its own');
  });

  it('says in the report that part of it is newer than the run', async () => {
    const { dir, config, out } = project();
    await diffyard(dir, [config]);
    const runId = latest(out);

    assert.equal(results(out, runId).refreshedAt, null);

    await diffyard(dir, [config, '--case', 'about--desktop', '--into', runId]);

    const after = results(out, runId);
    assert.ok(after.refreshedAt, 'the report records when it was last added to');
    assert.equal(
      after.comparisons.filter((entry) => entry.ranAt > after.finishedAt).length,
      1,
      'and which of its entries that was'
    );
    // The original run keeps describing itself.
    assert.equal(after.startedAt, results(out, runId).startedAt);
  });

  it('picks one view exactly, not everything with that name in it', async () => {
    const { dir, config, out } = project();
    await diffyard(dir, [config]);

    // --filter is a substring; --case is the id, viewport included.
    const output = await diffyard(dir, [config, '--case', 'index--desktop']);
    assert.match(output, /1 comparison/);

    const fresh = results(out, latest(out));
    assert.equal(fresh.comparisons.length, 1);
    assert.equal(fresh.comparisons[0]?.scenario, 'index');
  });

  it('says so when the id is not one of them', async () => {
    const { dir, config } = project();

    await assert.rejects(
      () => diffyard(dir, [config, '--case', 'nope--desktop']),
      /No comparison called "nope--desktop"/
    );
  });
});
