import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { page, serve } from './helpers/server.ts';
import type { RunningSite } from './helpers/server.ts';

/**
 * The JUnit file, as a CI reads it: one test case per comparison, named so
 * that two of them never share a name, and failing for the reason it failed.
 */

const run = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'bin', 'diffyard.mjs');

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-junit-'));
let siteA: RunningSite;
let siteB: RunningSite;

before(async () => {
  const pages = { index: page({ title: 'Home', body: '<h1>Home</h1>' }), about: page({ title: 'About', body: '<h1>About</h1>' }) };
  siteA = await serve({ pages });
  siteB = await serve({ pages, missing: ['about'] });
});

after(async () => {
  await siteA?.close();
  await siteB?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('the JUnit file', () => {
  it('names the group and says why a comparison failed', async () => {
    writeFileSync(
      join(workDir, 'diffyard.yaml'),
      `
compare:
  a: ${siteA.url}
  b: ${siteB.url}
output:
  dir: out
browser:
  viewports:
    desktop: { width: 400, height: 300 }
groups:
  - name: one
    scenarios: [/about]
  - name: two
    scenarios: [/]
scenarios:
  - /
`
    );

    try {
      await run(process.execPath, [CLI, 'run', 'diffyard.yaml', '--junit', 'junit.xml'], { cwd: workDir });
    } catch (error) {
      // 1 is the about page differing, which is the point.
      if ((error as { code?: number }).code !== 1) throw error;
    }

    const xml = readFileSync(join(workDir, 'junit.xml'), 'utf8');
    const names = [...xml.matchAll(/<testcase classname="diffyard" name="([^"]+)"/g)].map((match) => match[1]);

    assert.equal(new Set(names).size, names.length, `every case has a name of its own: ${names.join(', ')}`);
    assert.ok(names.includes('two/index @ desktop'), 'the group is part of it');
    assert.match(xml, /<failure message="answered 200 on A and 404 on B/, 'and the failure is the answer');
  });
});
