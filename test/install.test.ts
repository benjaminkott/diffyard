import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';

/**
 * Putting diffyard on the PATH.
 *
 * An installer that half works is worse than none: it leaves a command that
 * answers from one directory and not another, or a link nobody can find again
 * to remove. These run the real script against a throwaway directory.
 */

const run = promisify(execFile);
const PROJECT = join(import.meta.dirname, '..');
const SCRIPT = join(PROJECT, 'install.sh');

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-install-'));
let counter = 0;

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A bin directory of its own, so nothing here can touch a real one. */
function binDir(): string {
  return join(workDir, `bin-${counter++}`);
}

async function install(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(SCRIPT, ['--prefix', dir, ...args], {
    env: { ...process.env, NO_COLOR: '1' },
  });
  return stdout;
}

describe('installing', () => {
  it('links both commands and leaves them runnable from anywhere', async () => {
    const dir = binDir();
    const output = await install(dir);

    for (const command of ['diffyard', 'diffyard-mcp']) {
      const link = join(dir, command);
      assert.ok(lstatSync(link).isSymbolicLink(), `${command} is a link`);
      assert.equal(readlinkSync(link), join(PROJECT, 'bin', `${command}.mjs`));
    }

    assert.match(output, /diffyard → /);

    // The point of the exercise: it answers with the working directory
    // somewhere else entirely.
    const { stdout } = await run(join(dir, 'diffyard'), ['--version'], { cwd: tmpdir() });
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('says how to fix a directory that is not on the PATH', async () => {
    const dir = binDir();
    const output = await install(dir);

    // Nothing outside the bin directory is written, so the one thing the user
    // may still have to do has to be said rather than done.
    assert.match(output, /is not on your PATH yet/);
    assert.match(output, new RegExp(`export PATH="${dir}`));
  });

  it('can be run twice', async () => {
    const dir = binDir();
    await install(dir);
    await install(dir);

    assert.equal(readlinkSync(join(dir, 'diffyard')), join(PROJECT, 'bin', 'diffyard.mjs'));
  });

  it('refuses to replace a real file of that name', async () => {
    const dir = binDir();
    await install(dir);
    rmSync(join(dir, 'diffyard'));
    writeFileSync(join(dir, 'diffyard'), 'someone else was here');

    await assert.rejects(
      () => install(dir),
      (error: unknown) => /exists and is not a link/.test((error as { stderr?: string }).stderr ?? '')
    );

    assert.equal(existsSync(join(dir, 'diffyard')), true, 'and leaves it alone');
  });
});

describe('uninstalling', () => {
  it('removes what it linked', async () => {
    const dir = binDir();
    await install(dir);
    await install(dir, '--uninstall');

    assert.equal(existsSync(join(dir, 'diffyard')), false);
    assert.equal(existsSync(join(dir, 'diffyard-mcp')), false);
  });

  it('says so when there was nothing of ours there', async () => {
    const output = await install(binDir(), '--uninstall');
    assert.match(output, /nothing of this checkout was linked/);
  });

  it('leaves a link that points somewhere else alone', async () => {
    // Another checkout's install, or somebody's own script: removing it
    // because it shares a name would be taking something that is not ours.
    const dir = binDir();
    await install(dir);
    rmSync(join(dir, 'diffyard'));
    symlinkSync('/bin/true', join(dir, 'diffyard'));

    await install(dir, '--uninstall');

    assert.equal(readlinkSync(join(dir, 'diffyard')), '/bin/true');
    assert.equal(existsSync(join(dir, 'diffyard-mcp')), false, 'while still removing ours');
  });
});

/**
 * Whether the bundle is current.
 *
 * The link points at the bundle, so a stale one is a command that quietly
 * runs yesterday's code. These run the script in a stand-in checkout with an
 * npm that only writes down what it was asked, rather than rebuilding this
 * checkout's bundle under the other tests that are running it.
 */
describe('deciding whether to build', () => {
  const HOUR = 3600;

  /** A checkout with every input an hour older than its bundles. */
  function checkout(): { project: string; log: string; npm: string } {
    const project = join(workDir, `checkout-${counter++}`);
    const npm = join(project, '.fake-npm');
    const log = join(project, 'npm.log');

    const files: Record<string, string> = {
      'src/cli.ts': '',
      'src/report/shell.ts': '',
      'build.mjs': '',
      'package.json': '{}',
      'package-lock.json': '{}',
      'bin/diffyard.mjs': "#!/usr/bin/env node\nconsole.log('0.0.0');\n",
      'bin/diffyard-mcp.mjs': '#!/usr/bin/env node\n',
    };
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(project, name)), { recursive: true });
      writeFileSync(join(project, name), body);
    }
    chmodSync(join(project, 'bin', 'diffyard.mjs'), 0o755);
    chmodSync(join(project, 'bin', 'diffyard-mcp.mjs'), 0o755);
    mkdirSync(join(project, 'node_modules'));
    copyFileSync(SCRIPT, join(project, 'install.sh'));

    mkdirSync(npm);
    writeFileSync(join(npm, 'npm'), `#!/bin/sh\necho "$*" >> '${log}'\n`);
    chmodSync(join(npm, 'npm'), 0o755);

    const now = Date.now() / 1000;
    for (const name of Object.keys(files)) {
      const at = name.startsWith('bin/') ? now : now - HOUR;
      utimesSync(join(project, name), at, at);
    }

    return { project, log, npm };
  }

  async function installIn(project: string, npm: string): Promise<void> {
    await run(join(project, 'install.sh'), ['--prefix', binDir()], {
      env: { ...process.env, NO_COLOR: '1', PATH: `${npm}${delimiter}${process.env.PATH}` },
    });
  }

  const built = (log: string): boolean =>
    existsSync(log) && readFileSync(log, 'utf8').includes('run build');

  it('leaves a bundle alone that is newer than everything it was built from', async () => {
    const { project, log, npm } = checkout();
    await installIn(project, npm);

    assert.equal(built(log), false);
  });

  for (const input of ['src/cli.ts', 'src/report/shell.ts', 'build.mjs', 'package-lock.json']) {
    it(`builds again after ${input} changed`, async () => {
      const { project, log, npm } = checkout();
      const later = Date.now() / 1000 + HOUR;
      utimesSync(join(project, input), later, later);

      await installIn(project, npm);

      assert.equal(built(log), true);
    });
  }

  it('builds when one of the two bundles is missing', async () => {
    const { project, log, npm } = checkout();
    rmSync(join(project, 'bin', 'diffyard-mcp.mjs'));

    // The stand-in npm writes no bundle, so the link step finds it missing.
    await assert.rejects(() => installIn(project, npm));

    assert.equal(built(log), true);
  });
});
