import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../dist/config.js';

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-config-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;

/** Writes a config and loads it, so tests read as the YAML a user would write. */
function load(yaml: string) {
  const file = join(workDir, `config-${counter++}.yaml`);
  writeFileSync(file, yaml);
  return loadConfig(file);
}

const MINIMAL = `
compare:
  a: https://example.ddev.site
  b: https://example.com
scenarios:
  - /
`;

describe('compare', () => {
  it('accepts a bare URL per side', () => {
    const config = load(MINIMAL);
    assert.equal(config.a.baseUrl, 'https://example.ddev.site');
    assert.equal(config.b.baseUrl, 'https://example.com');
  });

  it('defaults the labels to A and B', () => {
    const config = load(MINIMAL);
    assert.equal(config.a.label, 'A');
    assert.equal(config.b.label, 'B');
  });

  it('takes url, label and credentials from the long form', () => {
    const config = load(`
compare:
  a:
    url: https://example.ddev.site
    label: ddev
  b:
    url: https://example.com
    label: live
    basicAuth: { username: u, password: p }
    headers:
      X-Token: secret
scenarios:
  - /
`);

    assert.equal(config.a.label, 'ddev');
    assert.deepEqual(config.b.basicAuth, { username: 'u', password: 'p' });
    assert.deepEqual(config.b.headers, { 'X-Token': 'secret' });
  });

  it('rejects a missing side', () => {
    assert.throws(
      () => load(`compare:\n  a: https://example.com\nscenarios:\n  - /\n`),
      (error: unknown) => error instanceof ConfigError && /compare\.b/.test((error as Error).message)
    );
  });

  it('rejects a URL that is not one', () => {
    assert.throws(
      () => load(`compare:\n  a: not-a-url\n  b: https://example.com\nscenarios:\n  - /\n`),
      ConfigError
    );
  });
});

describe('scenarios', () => {
  it('reads a bare path as a scenario named after it', () => {
    const config = load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
scenarios:
  - /
  - /products
  - /about/team
`);

    assert.deepEqual(
      config.scenarios.map((scenario) => [scenario.name, scenario.path]),
      [
        ['index', '/'],
        ['products', '/products'],
        ['about-team', '/about/team'],
      ]
    );
  });

  it('gives a shorthand scenario every declared viewport', () => {
    const config = load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
browser:
  viewports:
    mobile: { width: 375, height: 812 }
    desktop: { width: 1440, height: 900 }
scenarios:
  - /
`);

    assert.deepEqual(config.scenarios[0]?.viewports.map((viewport) => viewport.name), [
      'mobile',
      'desktop',
    ]);
  });

  it('resolves viewports referenced by name', () => {
    const config = load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
browser:
  viewports:
    mobile: { width: 375, height: 812 }
    desktop: { width: 1440, height: 900 }
scenarios:
  - name: menu
    path: /
    viewports: [mobile]
`);

    assert.deepEqual(config.scenarios[0]?.viewports, [
      { name: 'mobile', width: 375, height: 812, deviceScaleFactor: 1 },
    ]);
  });

  it('names the known viewports when one is unknown', () => {
    assert.throws(
      () =>
        load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
browser:
  viewports:
    mobile: { width: 375, height: 812 }
scenarios:
  - name: x
    path: /
    viewports: [phablet]
`),
      (error: unknown) =>
        error instanceof ConfigError && /unknown viewport "phablet".*mobile/s.test((error as Error).message)
    );
  });

  it('rejects two scenarios with the same name', () => {
    assert.throws(
      () =>
        load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
scenarios:
  - /products
  - name: products
    path: /other
`),
      (error: unknown) => error instanceof ConfigError && /Duplicate scenario/.test((error as Error).message)
    );
  });

  it('accepts differing paths per side', () => {
    const config = load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
scenarios:
  - name: contact
    a: /kontakt
    b: /contact
`);

    assert.equal(config.scenarios[0]?.pathA, '/kontakt');
    assert.equal(config.scenarios[0]?.pathB, '/contact');
  });

  it('requires a path', () => {
    assert.throws(
      () =>
        load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
scenarios:
  - name: nowhere
`),
      ConfigError
    );
  });

  it('merges the global mask into every scenario', () => {
    const config = load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
diff:
  mask: [".carousel"]
scenarios:
  - /
  - name: two
    path: /two
    mask: [".ticker"]
`);

    assert.deepEqual(config.scenarios[0]?.mask, ['.carousel']);
    assert.deepEqual(config.scenarios[1]?.mask, ['.carousel', '.ticker']);
  });
});

describe('beforeEach', () => {
  it('is optional', () => {
    assert.deepEqual(load(MINIMAL).beforeEach, []);
  });

  it('wraps a bare step into an entry that always runs', () => {
    const config = load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
beforeEach:
  - addStyle: ".chat { display: none }"
scenarios:
  - /
`);

    const entry = config.beforeEach[0];
    assert.equal(entry?.when, null);
    assert.equal(entry?.once, false);
    assert.equal(entry?.side, null);
    assert.equal(entry?.steps.length, 1);
  });

  it('reads a conditional group', () => {
    const config = load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
beforeEach:
  - name: accept consent
    when: "#accept"
    once: true
    side: b
    timeout: 2000
    steps:
      - click: "#accept"
scenarios:
  - /
`);

    assert.deepEqual(config.beforeEach[0], {
      name: 'accept consent',
      when: '#accept',
      timeout: 2000,
      required: false,
      once: true,
      side: 'b',
      steps: [{ click: '#accept' }],
    });
  });

  it('falls back to the trigger as the name', () => {
    const config = load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
beforeEach:
  - when: "#accept"
    steps:
      - click: "#accept"
scenarios:
  - /
`);

    assert.equal(config.beforeEach[0]?.name, '#accept');
  });

  it('rejects a side that is neither a nor b', () => {
    assert.throws(
      () =>
        load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
beforeEach:
  - side: c
    steps:
      - click: "#x"
scenarios:
  - /
`),
      ConfigError
    );
  });

  it('rejects a group without steps', () => {
    assert.throws(
      () =>
        load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
beforeEach:
  - when: "#accept"
    steps: []
scenarios:
  - /
`),
      ConfigError
    );
  });
});

describe('steps', () => {
  it('rejects an unknown action', () => {
    assert.throws(
      () =>
        load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
scenarios:
  - name: x
    path: /
    steps:
      - teleport: ".x"
`),
      (error: unknown) => error instanceof ConfigError && /unknown action "teleport"/.test((error as Error).message)
    );
  });

  it('rejects a step carrying two actions', () => {
    assert.throws(
      () =>
        load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
scenarios:
  - name: x
    path: /
    steps:
      - click: ".a"
        hover: ".b"
`),
      (error: unknown) => error instanceof ConfigError && /exactly one action/.test((error as Error).message)
    );
  });

  it('keeps timeout and optional alongside the action', () => {
    const config = load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
scenarios:
  - name: x
    path: /
    steps:
      - click: ".a"
        timeout: 1000
        optional: true
`);

    assert.deepEqual(config.scenarios[0]?.steps[0], { click: '.a', timeout: 1000, optional: true });
  });
});

describe('output', () => {
  it('defaults to a hidden directory in the working directory', () => {
    const config = load(MINIMAL);
    assert.equal(config.outDir, resolve(process.cwd(), '.diffyard-report'));
  });

  it('resolves a relative dir against the working directory, not the config', () => {
    const config = load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
output:
  dir: results
scenarios:
  - /
`);

    assert.equal(config.outDir, resolve(process.cwd(), 'results'));
    assert.notEqual(config.outDir, join(workDir, 'results'));
  });

  it('keeps an absolute dir as given', () => {
    const config = load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
output:
  dir: /tmp/diffyard-absolute
scenarios:
  - /
`);

    assert.equal(config.outDir, '/tmp/diffyard-absolute');
  });
});

describe('defaults', () => {
  it('fills in every group that was left out', () => {
    const config = load(MINIMAL);

    assert.equal(config.browser, 'chromium');
    assert.equal(config.headless, true);
    assert.equal(config.timeout, 30_000);
    assert.equal(config.comparisonTimeout, 180_000);
    assert.equal(config.runTimeout, 0);
    assert.equal(config.pixelThreshold, 0.1);
    assert.equal(config.ignoreAntialiasing, true);
    assert.equal(config.freeze, true);
    assert.equal(config.triggerLazyLoad, true);
    assert.equal(config.retries, 0);
    assert.equal(config.runFolder, true);
    assert.equal(config.markup.enabled, true);
    assert.deepEqual(config.viewports, [
      { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1 },
    ]);
  });

  it('reads the grouped options', () => {
    const config = load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
browser:
  engine: firefox
  headless: false
  colorScheme: dark
  locale: de-DE
timeouts:
  action: 1000
  comparison: 2000
  run: 3000
diff:
  threshold: 0.02
  pixelThreshold: 0.5
stability:
  freeze: false
  retries: 3
scenarios:
  - /
`);

    assert.equal(config.browser, 'firefox');
    assert.equal(config.headless, false);
    assert.equal(config.colorScheme, 'dark');
    assert.equal(config.locale, 'de-DE');
    assert.equal(config.timeout, 1000);
    assert.equal(config.comparisonTimeout, 2000);
    assert.equal(config.runTimeout, 3000);
    assert.equal(config.threshold, 0.02);
    assert.equal(config.pixelThreshold, 0.5);
    assert.equal(config.freeze, false);
    assert.equal(config.retries, 3);
  });

  it('applies the global threshold to every scenario', () => {
    const config = load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
diff:
  threshold: 0.02
scenarios:
  - /
  - name: strict
    path: /strict
    threshold: 0
`);

    assert.equal(config.scenarios[0]?.threshold, 0.02);
    assert.equal(config.scenarios[1]?.threshold, 0);
  });

  it('rejects a group that is not a mapping', () => {
    assert.throws(
      () =>
        load(`
compare:
  a: https://example.ddev.site
  b: https://example.com
browser: chromium
scenarios:
  - /
`),
      (error: unknown) => error instanceof ConfigError && /`browser` must be a mapping/.test((error as Error).message)
    );
  });
});

describe('loading', () => {
  it('names the file it could not find', () => {
    assert.throws(
      () => loadConfig(join(workDir, 'nope.yaml')),
      (error: unknown) => error instanceof ConfigError && /not found/.test((error as Error).message)
    );
  });

  it('reports broken YAML instead of crashing', () => {
    assert.throws(() => load('compare: [unclosed\n'), ConfigError);
  });

  it('requires at least one scenario', () => {
    assert.throws(
      () => load(`compare:\n  a: https://a.test\n  b: https://b.test\nscenarios: []\n`),
      ConfigError
    );
  });
});

describe('groups', () => {
  const SITES = `
browser:
  viewports:
    mobile: { width: 375, height: 812 }
    desktop: { width: 1440, height: 900 }
diff:
  threshold: 0.01
  mask: [".global"]
groups:
  - name: alpha
    compare:
      a: https://alpha.ddev.site/
      b: https://alpha.example.com/
    scenarios:
      - /
      - /about
  - name: beta
    compare:
      a: https://beta.ddev.site/
      b: https://beta.example.com/
    viewports: [mobile]
    diff:
      threshold: 0.5
      mask: [".countdown"]
    scenarios:
      - /
`;

  it('expands a group into one scenario per page', () => {
    const config = load(SITES);

    assert.deepEqual(
      config.scenarios.map((scenario) => `${scenario.group}/${scenario.name}`),
      ['alpha/index', 'alpha/about', 'beta/index']
    );
  });

  it('gives each group its own pair of sides', () => {
    const config = load(SITES);

    assert.equal(config.scenarios[0]?.sideA?.baseUrl, 'https://alpha.ddev.site/');
    assert.equal(config.scenarios[2]?.sideA?.baseUrl, 'https://beta.ddev.site/');
  });

  it('inherits what a group does not state and overrides what it does', () => {
    const config = load(SITES);

    assert.deepEqual(config.scenarios[0]?.viewports.map((v) => v.name), ['mobile', 'desktop']);
    assert.deepEqual(config.scenarios[2]?.viewports.map((v) => v.name), ['mobile']);

    assert.equal(config.scenarios[0]?.threshold, 0.01);
    assert.equal(config.scenarios[2]?.threshold, 0.5);

    assert.deepEqual(config.scenarios[0]?.mask, ['.global']);
    assert.deepEqual(config.scenarios[2]?.mask, ['.global', '.countdown']);
  });

  it('lets two groups have a page of the same name', () => {
    // Both groups have an index; only the pair of names has to be unique.
    assert.doesNotThrow(() => load(SITES));
  });

  it('rejects two pages with the same name inside one group', () => {
    assert.throws(
      () =>
        load(`
groups:
  - name: alpha
    compare:
      a: https://a.test/
      b: https://b.test/
    scenarios:
      - /about
      - name: about
        path: /other
`),
      (error: unknown) => error instanceof ConfigError && /Duplicate scenario: "alpha\/about"/.test((error as Error).message)
    );
  });

  it('runs without a top-level compare when every group has one', () => {
    const config = load(SITES);
    assert.equal(config.a.baseUrl, '');
    assert.equal(config.scenarios.length, 3);
  });

  it('needs a name and scenarios', () => {
    assert.throws(() => load(`groups:\n  - scenarios: [/]\n`), ConfigError);
    assert.throws(() => load(`groups:\n  - name: x\n    scenarios: []\n`), ConfigError);
  });

  it('accepts groups and loose scenarios side by side', () => {
    const config = load(`
compare:
  a: https://a.test/
  b: https://b.test/
scenarios:
  - /loose
groups:
  - name: alpha
    compare:
      a: https://alpha.test/
      b: https://alpha2.test/
    scenarios:
      - /
`);

    assert.deepEqual(
      config.scenarios.map((scenario) => [scenario.group, scenario.name]),
      [[null, 'loose'], ['alpha', 'index']]
    );
  });

  it('requires something to compare', () => {
    assert.throws(() => load(`compare:\n  a: https://a.test/\n  b: https://b.test/\n`), ConfigError);
  });
});

describe('workers', () => {
  it('runs one at a time unless asked otherwise', () => {
    assert.equal(load(MINIMAL).workers, 1);
  });

  it('reads a worker count', () => {
    const config = load(`
compare:
  a: https://a.test/
  b: https://b.test/
stability:
  workers: 4
scenarios:
  - /
`);
    assert.equal(config.workers, 4);
  });

  it('never drops below one', () => {
    const config = load(`
compare:
  a: https://a.test/
  b: https://b.test/
stability:
  workers: 0
scenarios:
  - /
`);
    assert.equal(config.workers, 1);
  });
});

describe('group defaults', () => {
  const CONFIG = `
compare:
  a: https://a.test/
  b: https://b.test/
groups:
  - name: slow
    waitUntil: domcontentloaded
    steps:
      - click: "#accept"
    fullPage: false
    scenarios:
      - /
      - name: own
        path: /own
        waitUntil: load
        steps:
          - hover: ".menu"
`;

  it('applies waitUntil to every page of the group', () => {
    // Two production sites hold a sub-resource open and never reach
    // networkidle; without this the bare-path shorthand has to be given up.
    const config = load(CONFIG);
    assert.equal(config.scenarios[0]?.waitUntil, 'domcontentloaded');
  });

  it('lets a scenario state its own', () => {
    assert.equal(load(CONFIG).scenarios[1]?.waitUntil, 'load');
  });

  it("runs the group's steps before the scenario's", () => {
    const config = load(CONFIG);
    assert.deepEqual(config.scenarios[0]?.steps, [{ click: '#accept' }]);
    assert.deepEqual(config.scenarios[1]?.steps, [{ click: '#accept' }, { hover: '.menu' }]);
  });

  it('passes fullPage down', () => {
    assert.equal(load(CONFIG).scenarios[0]?.fullPage, false);
  });
});

describe('address spelling', () => {
  it('names the replacement when an old spelling is used', () => {
    // Six ways to write one address meant reading the schema to find out which
    // one applied.
    for (const [old, use] of [['urlA', 'a'], ['pathB', 'b'], ['url', 'path']]) {
      assert.throws(
        () =>
          load(`
compare:
  a: https://a.test/
  b: https://b.test/
scenarios:
  - name: x
    ${old}: /somewhere
    ${old === 'url' ? 'a' : old === 'urlA' ? 'b' : 'a'}: /other
`),
        (error: unknown) =>
          error instanceof ConfigError && new RegExp(`${old}.*\`${use}\``).test((error as Error).message),
        `${old} should point at ${use}`
      );
    }
  });

  it('says so for a side written the old way', () => {
    assert.throws(
      () => load(`compare:\n  a:\n    baseUrl: https://a.test/\n  b: https://b.test/\nscenarios: [/]\n`),
      (error: unknown) => error instanceof ConfigError && /baseUrl.*`url`/.test((error as Error).message)
    );
  });
});
