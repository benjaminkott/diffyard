import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../dist/config.js';
import { settingsOf } from '../dist/runner.js';

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-settings-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;

function load(yaml: string) {
  const file = join(workDir, `config-${counter++}.yaml`);
  writeFileSync(file, yaml);
  return loadConfig(file);
}

const SECRETS = `
compare:
  a:
    url: https://staging.example.com
    label: staging
    basicAuth: { username: preview, password: hunter2-basic }
    headers:
      x-preview-token: hunter2-header
    cookies:
      - { name: session, value: hunter2-cookie, domain: staging.example.com }
    storageState: ./secrets/session.json
  b: https://example.com
beforeEach:
  - name: log in
    steps:
      - fill: { selector: "#password", value: hunter2-typed }
scenarios:
  - /
  - /about
`;

describe('the settings a run records', () => {
  it('carries what decided the numbers', () => {
    const settings = settingsOf(load(SECRETS));

    assert.equal(settings.a.label, 'staging');
    assert.equal(settings.a.baseUrl, 'https://staging.example.com');
    assert.equal(settings.scenarios, 2);
    assert.equal(settings.beforeEach[0]?.name, 'log in');
    assert.equal(settings.beforeEach[0]?.steps, 1);
  });

  it('says a credential was set without saying what it was', () => {
    const settings = settingsOf(load(SECRETS));

    assert.equal(settings.a.basicAuth, true, 'that basic auth was used is worth knowing');
    assert.deepEqual(settings.a.headers, ['x-preview-token'], 'the name, never the value');
    assert.deepEqual(settings.a.cookies, ['session']);
  });

  it('lets nothing secret through, whatever shape it came in', () => {
    // A report is a file people zip and mail. Anything in here has left the
    // machine, so the test is over the whole recorded object, not per field.
    const written = JSON.stringify(settingsOf(load(SECRETS)));

    for (const secret of ['hunter2-basic', 'hunter2-header', 'hunter2-cookie', 'hunter2-typed']) {
      assert.ok(!written.includes(secret), `${secret} was written into the run`);
    }
  });
});
