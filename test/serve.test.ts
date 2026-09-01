import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { serveReport } from '../dist/serve.js';
import { solidPng } from './helpers/server.ts';

/**
 * The report, over HTTP.
 *
 * What it has to do: hand over the files a report is made of with the types a
 * browser needs, never from a cache — the page is rewritten every few seconds
 * while a run is going, and the point of opening it then is to refresh it —
 * and hand over nothing that is not in the folder it was pointed at.
 */

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-serve-'));
let serving: Awaited<ReturnType<typeof serveReport>>;

before(async () => {
  mkdirSync(join(workDir, 'run-one', 'data'), { recursive: true });
  mkdirSync(join(workDir, 'run-one', 'shots'), { recursive: true });
  writeFileSync(join(workDir, 'run-one', 'index.html'), '<!doctype html><title>report</title>');
  writeFileSync(join(workDir, 'run-one', 'data', 'run.js'), 'diffyard.run({});\n');
  writeFileSync(join(workDir, 'run-one', 'results.json'), '{"runId":"run-one"}');
  writeFileSync(join(workDir, 'run-one', 'shots', 'home.a.png'), solidPng(4, 4, [10, 20, 30]));
  writeFileSync(join(workDir, 'secret.txt'), 'not part of any report');

  serving = await serveReport(join(workDir, 'run-one'), { port: 0 });
});

after(async () => {
  await serving?.close();
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * What gets served, from what little is said.
 *
 * `output.dir` is a project's own convention -- `var/`, `build/`, somewhere
 * under a cache -- and a tool that made the folder should not have to be told
 * where it is a second time.
 */
describe('finding what to serve', () => {
  /** The command, up to the point where it says what it is serving. */
  const say = (argument: string): Promise<string> =>
    new Promise((said, failed) => {
      const cli = spawn(
        process.execPath,
        [join(import.meta.dirname, '..', 'bin', 'diffyard.mjs'), 'serve', argument, '--port', '0'],
        { cwd: workDir }
      );

      let out = '';
      const finish = () => {
        cli.kill('SIGINT');
        said(out);
      };

      cli.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes('Ctrl+C')) finish();
      });
      cli.stderr.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      cli.on('error', failed);
      cli.on('exit', () => said(out));
      setTimeout(finish, 8000).unref();
    });

  it('reads the config rather than asking where its runs go', async () => {
    const config = join(workDir, 'from-config.yaml');
    writeFileSync(
      config,
      'compare:\n  a: https://a.test\n  b: https://b.test\n' +
        `output:\n  dir: ${join(workDir, 'run-one')}\nscenarios:\n  - /\n`
    );

    const out = await say(config);

    assert.match(out, /run-one/, 'the folder that config writes into');
    assert.match(out, /where .*from-config\.yaml puts its runs/, 'and it says why it is there');
  });

  it('serves a folder it is handed as one', async () => {
    const out = await say(join(workDir, 'run-one'));

    assert.match(out, /run-one/);
    assert.doesNotMatch(out, /puts its runs/, 'nothing was read to find it');
  });
});

describe('serving a report', () => {
  it('answers the page at the root', async () => {
    const answer = await fetch(serving.url);

    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await answer.text(), /<title>report<\/title>/);
  });

  it('hands the run over as a script, which is how the report reads it', async () => {
    const answer = await fetch(`${serving.url}data/run.js`);

    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('content-type'), 'text/javascript; charset=utf-8');
  });

  it('never lets a browser keep a page a run is still writing', async () => {
    const answer = await fetch(serving.url);

    assert.equal(answer.headers.get('cache-control'), 'no-store');
  });

  it('serves the screenshots as pictures', async () => {
    const answer = await fetch(`${serving.url}shots/home.a.png`);

    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('content-type'), 'image/png');
    assert.equal((await answer.arrayBuffer()).byteLength > 0, true);
  });

  it('refuses an address that climbs out of the folder', async () => {
    const answer = await fetch(`${serving.url}../secret.txt`, { redirect: 'manual' });

    assert.notEqual(answer.status, 200);
    assert.doesNotMatch(await answer.text(), /not part of any report/);
  });

  it('says so for something that is not there', async () => {
    const answer = await fetch(`${serving.url}shots/nothing.png`);

    assert.equal(answer.status, 404);
  });

  it('walks on to a free port when the one it wanted is taken', async () => {
    // The ordinary reason: a report already being served in another window.
    const second = await serveReport(join(workDir, 'run-one'), { port: serving.port });

    try {
      assert.notEqual(second.port, serving.port, 'somewhere else');
      assert.equal((await fetch(second.url)).status, 200, 'and serving the same report');
    } finally {
      await second.close();
    }
  });

  it('stays where it was told when a port was asked for by name', async () => {
    // A number somebody typed is a requirement: they are pointing something
    // else at it, and serving somewhere else quietly is worse than saying so.
    await assert.rejects(
      () => serveReport(join(workDir, 'run-one'), { port: serving.port, strict: true }),
      (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE'
    );
  });

  it('lists the runs when pointed at the folder that holds them', async () => {
    const listing = await serveReport(workDir, { port: 0 });

    try {
      const answer = await fetch(listing.url);
      const text = await answer.text();

      assert.equal(answer.status, 200);
      assert.match(text, /run-one/, 'the run is named');
      assert.match(text, /href="\/run-one\/"/, 'and is a link into it');
    } finally {
      await listing.close();
    }
  });
});
