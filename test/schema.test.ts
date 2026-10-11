import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { loadConfig, parseDuration } from '../dist/config.js';
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
    assert.equal(config.b?.baseUrl, '');
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

/**
 * Every bounded number and every closed block, taken from the schema itself,
 * so that a bound or a key added to one side and not the other fails here
 * instead of in somebody's editor — or worse, in a run that takes a value the
 * editor would have refused.
 */
describe('schema and parser agree on every value', () => {
  type Node = { type?: string; minimum?: number; maximum?: number; exclusiveMinimum?: number };
  type Block = { properties: Record<string, Node>; additionalProperties?: unknown };

  const top = CONFIG_SCHEMA.properties;
  const pair = { a: 'https://a.test/', b: 'https://b.test/' };
  const base = { compare: pair, scenarios: ['/'] };

  /** Where each closed block of the schema sits in a config, and how to fill it in. */
  const places: { where: string; block: Block; place: (props: Record<string, unknown>) => unknown }[] = [
    ...(['output', 'browser', 'timeouts', 'diff', 'stability', 'reuse', 'logs', 'markup'] as const).map(
      (name) => ({
        where: name,
        block: top[name] as unknown as Block,
        place: (props: Record<string, unknown>) => ({ ...base, [name]: props }),
      })
    ),
    {
      where: 'compare',
      block: top.compare as unknown as Block,
      place: (props) => ({ scenarios: ['/'], compare: { ...pair, ...props } }),
    },
    {
      where: 'a side',
      block: top.compare.properties.a.oneOf[1] as unknown as Block,
      place: (props) => ({ ...base, compare: { ...pair, a: { url: pair.a, ...props } } }),
    },
    {
      where: 'a viewport',
      block: top.browser.properties.viewports.additionalProperties as unknown as Block,
      place: (props) => {
        // The long and the short spelling of one size: the parser reads the
        // long one first, so the short one is only tried on its own.
        const size: Record<string, unknown> = { width: 1440, height: 900 };
        if ('w' in props) delete size['width'];
        if ('h' in props) delete size['height'];
        return { ...base, browser: { viewports: { desktop: { ...size, ...props } } } };
      },
    },
    {
      where: 'a scenario',
      block: CONFIG_SCHEMA.$defs.scenario as unknown as Block,
      place: (props) => ({ compare: pair, scenarios: [{ path: '/', ...props }] }),
    },
    {
      where: 'a group',
      block: top.groups.items as unknown as Block,
      place: (props) => ({ groups: [{ name: 'g', compare: pair, scenarios: ['/'], ...props }] }),
    },
    {
      where: "a group's diff",
      block: top.groups.items.properties.diff as unknown as Block,
      place: (props) => ({ groups: [{ name: 'g', compare: pair, scenarios: ['/'], diff: props }] }),
    },
    {
      where: 'a beforeEach group',
      block: CONFIG_SCHEMA.$defs.beforeEachGroup as unknown as Block,
      place: (props) => ({ ...base, beforeEach: [{ steps: [{ click: '#x' }], ...props }] }),
    },
  ];

  /**
   * Stated on purpose and nowhere else: the parser rounds a worker count
   * down and never below one, so a stray 0 runs one at a time rather than
   * stopping the run, while an editor still steers towards a whole number.
   */
  const lenient = new Set(['stability.workers']);

  function parserAccepts(config: unknown): boolean {
    const file = join(workDir, `bounds-${counter++}.yaml`);
    writeFileSync(file, JSON.stringify(config));
    try {
      loadConfig(file);
      return true;
    } catch {
      return false;
    }
  }

  function candidates(node: Node): number[] {
    const values = new Set([-1, 0, 0.5, 2, 1000]);
    if (node.minimum !== undefined) values.add(node.minimum).add(node.minimum - 1);
    if (node.maximum !== undefined) values.add(node.maximum).add(node.maximum + 1);
    if (node.exclusiveMinimum !== undefined) values.add(node.exclusiveMinimum).add(node.exclusiveMinimum + 0.5);
    return [...values];
  }

  for (const { where, block, place } of places) {
    it(`on the numbers in ${where}`, () => {
      for (const [key, node] of Object.entries(block.properties)) {
        if (node.type !== 'number' && node.type !== 'integer') continue;
        if (lenient.has(`${where}.${key}`)) continue;

        for (const value of candidates(node)) {
          const config = place({ [key]: value });
          assert.equal(
            parserAccepts(config),
            validate(config) === true,
            `${where}.${key}: ${value} — the schema ${validate(config) ? 'accepts' : 'refuses'} it, the parser does not agree`
          );
        }
      }
    });

    if (block.additionalProperties === false) {
      it(`on a key ${where} does not have`, () => {
        const config = place({ notAnOption: true });
        assert.equal(validate(config), false, `the schema takes an unknown key in ${where}`);
        assert.equal(parserAccepts(config), false, `the parser takes an unknown key in ${where}`);
      });
    }
  }
});

/**
 * A default in the schema is what an editor shows for a key left out; the
 * parser's is what the run then uses. They disagreed once on the threshold —
 * 0.001 on the hover, 0 in the run — and a page with one differing pixel in a
 * thousand failed where the editor said it would pass.
 */
describe('schema and parser agree on every default', () => {
  type Node = Record<string, unknown>;

  /** Every path in the schema that states a default. */
  function defaults(node: unknown, path: string, out: Map<string, unknown>): Map<string, unknown> {
    if (typeof node !== 'object' || node === null) return out;
    const at = node as Node;
    if ('default' in at) out.set(path, at['default']);
    for (const [key, child] of Object.entries((at['properties'] ?? {}) as Node)) {
      defaults(child, path ? `${path}.${key}` : key, out);
    }
    for (const [key, child] of Object.entries((at['$defs'] ?? {}) as Node)) defaults(child, `$${key}`, out);
    if (typeof at['additionalProperties'] === 'object') defaults(at['additionalProperties'], `${path}.*`, out);
    if (at['items']) defaults(at['items'], `${path}[]`, out);
    for (const member of (at['oneOf'] ?? []) as unknown[]) defaults(member, path, out);
    return out;
  }

  const file = join(workDir, `defaults-${counter++}.yaml`);
  writeFileSync(
    file,
    `compare:\n  a: https://a.test/\n  b: https://b.test/\n` +
      `browser:\n  viewports:\n    desktop: { width: 1440, height: 900 }\n` +
      `beforeEach:\n  - steps:\n      - click: "#x"\nscenarios:\n  - path: /\n`
  );
  const config = loadConfig(file);
  const scenario = config.scenarios[0]!;
  const entry = config.beforeEach[0]!;

  /** Where the parser keeps what each of those paths resolves to. */
  const resolved: Record<string, unknown> = {
    'output.dir': config.outDir.split('/').at(-1),
    'output.runFolder': config.runFolder,
    'output.title': config.reportTitle,
    'output.images': config.images,
    'browser.engine': config.browser,
    'browser.headless': config.headless,
    'browser.viewports.*.deviceScaleFactor': config.viewports[0]?.deviceScaleFactor,
    'browser.colorScheme': config.colorScheme,
    'browser.reducedMotion': config.reducedMotion,
    'browser.ignoreHTTPSErrors': config.ignoreHTTPSErrors,
    'timeouts.action': config.timeout,
    'timeouts.comparison': config.comparisonTimeout,
    'timeouts.run': config.runTimeout,
    'diff.threshold': config.threshold,
    'diff.pixelThreshold': config.pixelThreshold,
    'diff.ignoreAntialiasing': config.ignoreAntialiasing,
    'diff.alignRows': config.alignRows,
    'stability.freeze': config.freeze,
    'stability.triggerLazyLoad': config.triggerLazyLoad,
    'stability.retries': config.retries,
    'stability.workers': config.workers,
    'stability.sequential': config.sequential,
    'reuse.from': config.reuse.from,
    'reuse.maxAge': config.reuse.maxAge,
    'logs.enabled': config.logs.enabled,
    'logs.levels': config.logs.levels,
    'logs.max': config.logs.max,
    'logs.failOnDifference': config.logs.failOnDifference,
    'markup.enabled': config.markup.enabled,
    'markup.failOnDifference': config.markup.failOnDifference,
    'markup.ignoreComments': config.markup.ignoreComments,
    'markup.normalizeWhitespace': config.markup.normalizeWhitespace,
    'markup.sortAttributes': config.markup.sortAttributes,
    'markup.ignoreBaseUrl': config.markup.ignoreBaseUrl,
    'markup.maxHunksInReport': config.markup.maxHunksInReport,
    '$beforeEachGroup.timeout': entry.timeout,
    '$beforeEachGroup.required': entry.required,
    '$beforeEachGroup.once': entry.once,
    '$scenario.fullPage': scenario.fullPage,
    '$scenario.waitUntil': scenario.waitUntil,
    '$scenario.skip': scenario.skip,
    '$scenario.only': scenario.only,
  };

  /** Written the way a person would in the schema; the parser keeps milliseconds. */
  const readable: Record<string, (value: unknown) => unknown> = {
    'reuse.maxAge': (value) => parseDuration(value, Number.NaN, 'reuse.maxAge'),
  };

  for (const [path, stated] of defaults(CONFIG_SCHEMA, '', new Map())) {
    it(`for ${path}`, () => {
      assert.ok(path in resolved, `${path} has a default in the schema; say here where the parser keeps it`);
      const expected = readable[path] ? readable[path](stated) : stated;
      assert.deepEqual(resolved[path], expected);
    });
  }
});
