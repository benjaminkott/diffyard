import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkForUpdate, isNewer, updateCommandFor } from '../dist/update.js';
import { VERSION } from '../dist/manifest.js';

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-update-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;
const cacheFile = () => join(workDir, `cache-${counter++}.json`);

/** A registry that answers with this, and says how often it was asked. */
function registry(version: string | null) {
  const calls: string[] = [];
  return {
    calls,
    lookup: async (name: string) => {
      calls.push(name);
      return version;
    },
  };
}

/** Nothing of the real environment: no CI, no opt-out, no home directory. */
const env = {} as NodeJS.ProcessEnv;

describe('comparing two versions', () => {
  it('sees a newer release', () => {
    assert.equal(isNewer('0.2.0', '0.1.3'), true);
    assert.equal(isNewer('0.1.4', '0.1.3'), true);
    assert.equal(isNewer('1.0.0', '0.9.9'), true);
  });

  it('sees the same one and an older one', () => {
    assert.equal(isNewer('0.1.3', '0.1.3'), false);
    assert.equal(isNewer('0.1.2', '0.1.3'), false);
    assert.equal(isNewer('0.9.9', '1.0.0'), false);
  });

  it('compares the numbers, not the text they are written in', () => {
    // 0.10.0 sorts before 0.9.0 as a string and is the newer release.
    assert.equal(isNewer('0.10.0', '0.9.0'), true);
    assert.equal(isNewer('0.9.0', '0.10.0'), false);
  });

  it('treats the published release as newer than the prerelease of it', () => {
    assert.equal(isNewer('0.2.0', '0.2.0-rc.1'), true);
    assert.equal(isNewer('0.2.0-rc.1', '0.2.0'), false);
  });

  it('says nothing about a version it cannot read', () => {
    // A notice that fires on an answer nobody parsed is worse than none.
    assert.equal(isNewer('latest', '0.1.3'), false);
    assert.equal(isNewer('', '0.1.3'), false);
    assert.equal(isNewer('99', '0.1.3'), false);
  });
});

describe('checking for an update', () => {
  it('reports the published version and how to get it', async () => {
    const npm = registry('99.0.0');
    const update = await checkForUpdate({ env, cacheFile: cacheFile(), lookup: npm.lookup });

    assert.equal(update?.latest, '99.0.0');
    assert.equal(update?.current, VERSION);
    assert.match(update?.command ?? '', /install|git pull/);
    assert.equal(update?.notes, 'https://github.com/benjaminkott/diffyard/releases/tag/v99.0.0');
  });

  it('says nothing when this is the current version', async () => {
    const npm = registry(VERSION);
    assert.equal(await checkForUpdate({ env, cacheFile: cacheFile(), lookup: npm.lookup }), null);
  });

  it('asks the registry once a day and answers from the cache in between', async () => {
    const file = cacheFile();
    const npm = registry('99.0.0');

    const first = await checkForUpdate({ env, cacheFile: file, lookup: npm.lookup, now: 1_000_000 });
    const second = await checkForUpdate({ env, cacheFile: file, lookup: npm.lookup, now: 1_000_000 + 60_000 });

    assert.equal(npm.calls.length, 1, 'the second run must not go out again');
    assert.equal(first?.latest, '99.0.0');
    assert.equal(second?.latest, '99.0.0', 'and still reports what it learned');
  });

  it('asks again once the answer is a day old', async () => {
    const file = cacheFile();
    const npm = registry('99.0.0');

    await checkForUpdate({ env, cacheFile: file, lookup: npm.lookup, now: 1_000_000 });
    await checkForUpdate({ env, cacheFile: file, lookup: npm.lookup, now: 1_000_000 + 25 * 60 * 60 * 1000 });

    assert.equal(npm.calls.length, 2);
  });

  it('stays quiet when the lookup fails, and does not retry all day', async () => {
    const file = cacheFile();
    const offline = {
      calls: [] as string[],
      lookup: async (name: string) => {
        offline.calls.push(name);
        throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
      },
    };

    assert.equal(await checkForUpdate({ env, cacheFile: file, lookup: offline.lookup, now: 1 }), null);
    assert.equal(await checkForUpdate({ env, cacheFile: file, lookup: offline.lookup, now: 2 }), null);
    assert.equal(offline.calls.length, 1, 'a day offline asks once');
  });

  it('survives a cache file that is not what it expects', async () => {
    const file = cacheFile();
    writeFileSync(file, 'not json at all');

    const npm = registry('99.0.0');
    const update = await checkForUpdate({ env, cacheFile: file, lookup: npm.lookup });

    assert.equal(update?.latest, '99.0.0');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).latest, '99.0.0', 'and writes a good one over it');
  });

  it('is silent in CI and wherever it was turned off', async () => {
    for (const variable of ['CI', 'NO_UPDATE_NOTIFIER', 'DIFFYARD_NO_UPDATE_CHECK']) {
      const npm = registry('99.0.0');
      const update = await checkForUpdate({
        env: { [variable]: '1' } as NodeJS.ProcessEnv,
        cacheFile: cacheFile(),
        lookup: npm.lookup,
      });

      assert.equal(update, null, `${variable} must silence it`);
      assert.equal(npm.calls.length, 0, `${variable} must also stop the lookup`);
    }
  });
});

describe('what to run to be on the new version', () => {
  /** A directory that looks like the installation it is named after. */
  function installation(path: string, git = false): string {
    const root = join(workDir, `install-${counter++}`, path);
    mkdirSync(root, { recursive: true });
    if (git) mkdirSync(join(root, '.git'));
    return root;
  }

  it('pulls a checkout rather than installing over it', () => {
    // The link install.sh made points into the working tree, so the bundle is
    // what has to be renewed — installing from the registry beside it would
    // leave the command still answering from the checkout.
    const root = installation('tools/diffyard', true);
    assert.equal(updateCommandFor(root), `cd ${root} && git pull && ./install.sh`);
  });

  it('installs globally again when that is where it lives', () => {
    for (const path of [
      'usr/lib/node_modules/diffyard',
      'home/someone/.nvm/versions/node/v24.0.0/lib/node_modules/diffyard',
      'Users/someone/AppData/Roaming/npm/node_modules/diffyard',
    ]) {
      assert.equal(updateCommandFor(installation(path)), 'npm install -g diffyard@latest', path);
    }
  });

  it('asks npx for the current version, having installed nothing', () => {
    // npx ran a copy out of its cache; there is no install to upgrade.
    const root = installation('home/someone/.npm/_npx/a1b2c3d4/node_modules/diffyard');
    assert.equal(updateCommandFor(root), 'npx diffyard@latest');
  });

  it('moves the dependency, not the machine, when the project owns it', () => {
    const root = installation('home/someone/projects/my-site/node_modules/diffyard');
    assert.equal(updateCommandFor(root), 'npm install diffyard@latest');
  });

  it('falls back to the global install for a place it does not recognise', () => {
    assert.equal(updateCommandFor(installation('opt/diffyard')), 'npm install -g diffyard@latest');
  });
});
