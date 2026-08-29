import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { loadConfig } from '../dist/config.js';
import { EXAMPLE_CONFIG } from '../dist/example.js';
import { CONFIG_SCHEMA, schemaJson } from '../dist/schema.js';

// strict:false so the unused `format` annotations do not need ajv-formats;
// these tests are about the shape of a config, not about URI syntax.
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(CONFIG_SCHEMA);

describe('the schema file in the repository', () => {
  it('is what the parser would write today', () => {
    // Editors validate against the committed file, not against the code. One
    // that has fallen behind marks a valid config as wrong and completes
    // options that no longer exist — worse than having no schema at all.
    const committed = readFileSync(join(import.meta.dirname, '..', 'diffyard.schema.json'), 'utf8');

    assert.equal(
      committed,
      schemaJson(),
      'diffyard.schema.json has drifted; write it again with: diffyard schema diffyard.schema.json'
    );
  });
});

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-schema-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;

function accepts(yaml: string): boolean {
  return validate(parse(yaml)) === true;
}

function errors(yaml: string): string {
  validate(parse(yaml));
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`)
    .join('; ');
}

const MINIMAL = `
compare:
  a: https://example.ddev.site
  b: https://example.com
scenarios:
  - /
`;

/**
 * The schema is what an editor checks a config against while it is written, so
 * it drifting from the parser is a silent failure: valid files would be flagged
 * and broken ones accepted. These tests run both over the same documents.
 */
describe('schema and parser agree', () => {
  it('both accept the annotated template', () => {
    assert.ok(accepts(EXAMPLE_CONFIG), errors(EXAMPLE_CONFIG));

    const file = join(workDir, 'template.yaml');
    writeFileSync(file, EXAMPLE_CONFIG);
    assert.doesNotThrow(() => loadConfig(file));
  });

  it('both accept the shipped examples', () => {
    const dir = new URL('../examples/', import.meta.url).pathname;

    for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.yaml'))) {
      const yaml = readFileSync(join(dir, name), 'utf8');
      assert.ok(accepts(yaml), `${name}: ${errors(yaml)}`);
      assert.doesNotThrow(() => loadConfig(join(dir, name)), `${name} does not load`);
    }
  });

  it('both accept a config with nothing but the required parts', () => {
    assert.ok(accepts(MINIMAL), errors(MINIMAL));

    const file = join(workDir, `minimal-${counter++}.yaml`);
    writeFileSync(file, MINIMAL);
    assert.doesNotThrow(() => loadConfig(file));
  });
});

describe('schema rejects', () => {
  it('a typo in a group name', () => {
    assert.equal(accepts(`compare:\n  a: https://a.test\n  b: https://b.test\nbrowsr: {}\nscenarios: [/]\n`), false);
  });

  it('an option left at the top level instead of its group', () => {
    assert.equal(accepts(`compare:\n  a: https://a.test\n  b: https://b.test\nthreshold: 0.1\nscenarios: [/]\n`), false);
  });

  it('a config without scenarios', () => {
    assert.equal(accepts(`compare:\n  a: https://a.test\n  b: https://b.test\n`), false);
  });

  it('an empty scenario list', () => {
    assert.equal(accepts(`compare:\n  a: https://a.test\n  b: https://b.test\nscenarios: []\n`), false);
  });

  it('an unknown step action', () => {
    assert.equal(
      accepts(`compare:\n  a: https://a.test\n  b: https://b.test\nscenarios:\n  - name: x\n    path: /\n    steps:\n      - teleport: ".x"\n`),
      false
    );
  });

  it('a beforeEach group without steps', () => {
    assert.equal(
      accepts(`compare:\n  a: https://a.test\n  b: https://b.test\nbeforeEach:\n  - name: x\n    when: ".y"\nscenarios: [/]\n`),
      false
    );
  });

  it('a threshold outside 0..1', () => {
    assert.equal(accepts(`compare:\n  a: https://a.test\n  b: https://b.test\ndiff:\n  threshold: 5\nscenarios: [/]\n`), false);
  });

  it('a scenario without any path', () => {
    assert.equal(accepts(`compare:\n  a: https://a.test\n  b: https://b.test\nscenarios:\n  - name: nowhere\n`), false);
  });

  it('an unknown browser engine', () => {
    assert.equal(
      accepts(`compare:\n  a: https://a.test\n  b: https://b.test\nbrowser:\n  engine: netscape\nscenarios: [/]\n`),
      false
    );
  });
});

describe('a config without compare', () => {
  it('is accepted when the scenarios carry full URLs', () => {
    const yaml = `scenarios:\n  - name: x\n    a: https://one.test/page\n    b: https://two.test/page\n`;
    assert.ok(accepts(yaml), errors(yaml));

    const file = join(workDir, `no-compare-${counter++}.yaml`);
    writeFileSync(file, yaml);
    assert.doesNotThrow(() => loadConfig(file));
  });

  it('is rejected by the parser when a scenario gives only a path', () => {
    const file = join(workDir, `no-compare-${counter++}.yaml`);
    writeFileSync(file, `scenarios:\n  - /about\n`);

    assert.throws(
      () => loadConfig(file),
      (error: unknown) => /no URL to resolve it against/.test((error as Error).message)
    );
  });

  it('still resolves paths for the side that does have a URL', () => {
    const file = join(workDir, `half-compare-${counter++}.yaml`);
    writeFileSync(
      file,
      `compare:\n  a: https://one.test/\nscenarios:\n  - name: x\n    a: /page\n    b: https://two.test/page\n`
    );

    const config = loadConfig(file);
    assert.equal(config.a.baseUrl, 'https://one.test/');
    assert.equal(config.b.baseUrl, '');
  });
});

describe('schema accepts', () => {
  it('bare paths as scenarios', () => {
    assert.ok(accepts(`compare:\n  a: https://a.test\n  b: https://b.test\nscenarios:\n  - /\n  - /about\n`));
  });

  it('a beforeEach entry that is just a step', () => {
    assert.ok(
      accepts(`compare:\n  a: https://a.test\n  b: https://b.test\nbeforeEach:\n  - click: "#x"\nscenarios: [/]\n`)
    );
  });

  it('a beforeEach group with a trigger', () => {
    assert.ok(
      accepts(
        `compare:\n  a: https://a.test\n  b: https://b.test\nbeforeEach:\n  - name: consent\n    when: "#x"\n    once: true\n    side: b\n    steps:\n      - click: "#x"\nscenarios: [/]\n`
      )
    );
  });

  it('per-side paths', () => {
    assert.ok(
      accepts(`compare:\n  a: https://a.test\n  b: https://b.test\nscenarios:\n  - name: contact\n    a: /kontakt\n    b: /contact\n`)
    );
  });

  it('a step with timeout and optional', () => {
    assert.ok(
      accepts(
        `compare:\n  a: https://a.test\n  b: https://b.test\nscenarios:\n  - name: x\n    path: /\n    steps:\n      - click: ".a"\n        timeout: 100\n        optional: true\n`
      )
    );
  });
});
