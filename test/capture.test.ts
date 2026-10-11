import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../dist/config.js';
import { run } from '../dist/runner.js';
import type { RunResult } from '../dist/types.js';
import { page } from './helpers/server.ts';

/**
 * What the browser is handed before a page is photographed: the context it is
 * opened in, and what the page is put through on the way to the screenshot.
 *
 * The sites here answer from a function rather than a table, because what is
 * being checked is how the request arrived -- which headers it carried, how
 * often it came -- and not only what the page looks like.
 */

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-capture-'));
const closers: (() => Promise<void>)[] = [];
let counter = 0;

after(async () => {
  await Promise.all(closers.map((close) => close()));
  rmSync(workDir, { recursive: true, force: true });
});

/** A site whose every answer is up to the test. Closed when the file is done. */
async function site(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

function html(response: ServerResponse, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
  response.end(body);
}

/** Runs a config from YAML the way the CLI would, into a folder of its own. */
async function runYaml(yaml: string): Promise<RunResult> {
  const dir = join(workDir, `run-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'diffyard.yaml');
  writeFileSync(file, yaml.replaceAll('$OUT', join(dir, 'out')));
  return run(loadConfig(file));
}

describe('a site that sends a content security policy', { concurrency: false }, () => {
  it('is still held still and photographed', async () => {
    // A policy that allows only the site's own stylesheets is ordinary, and it
    // forbids exactly the inline style the run adds to hold the page still.
    const url = await site((_request, response) =>
      html(response, page({ title: 'Strict', body: '<h1>Strict</h1><p class="ad">Advert</p>' }), {
        'content-security-policy': "style-src 'self'",
      })
    );

    const result = await runYaml(`
compare:
  a: ${url}
  b: ${url}
output:
  dir: $OUT
browser:
  viewports:
    desktop: { width: 500, height: 400 }
markup:
  enabled: false
diff:
  hide: [".ad"]
scenarios:
  - /
`);

    const comparison = result.comparisons[0];
    assert.ok(comparison);
    assert.equal(comparison.error, null);
    assert.equal(comparison.status, 'pass');
  });
});
