import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAME, REPOSITORY, VERSION } from './manifest.js';

/**
 * Whether the diffyard in hand is still the current one.
 *
 * A tool that reports what changed on a website has no business being the one
 * thing on the machine that quietly stays behind: a fix to the differ or to
 * the report is only worth shipping if the people running it hear about it.
 *
 * So the check is a footnote and never an event. It asks the registry once a
 * day, keeps the answer in a cache file, times out fast and answers `null` to
 * everything that goes wrong — offline, blocked, slow, a registry that is
 * down. A run must never be slower, noisier or less likely to finish because
 * the version behind it moved.
 */

/** Asked at most this often; the answer in between comes from the cache. */
const MAX_AGE = 24 * 60 * 60 * 1000;

/** Long enough for a registry that answers, short enough not to be felt. */
const TIMEOUT = 1500;

const REGISTRY = 'https://registry.npmjs.org';

export interface Update {
  /** The version running now. */
  current: string;
  /** The version published since. */
  latest: string;
  /** What to run to be on it, for this kind of installation. */
  command: string;
  /** Where to read what changed, when the repository has such a page. */
  notes: string | null;
}

export interface CheckOptions {
  /** Overrides the environment consulted for the opt-outs. */
  env?: NodeJS.ProcessEnv;
  /** Where the answer is remembered between runs. */
  cacheFile?: string;
  /** Overrides the clock, so a test can age the cache. */
  now?: number;
  timeoutMs?: number;
  /** Overrides the registry lookup, so a test never leaves the machine. */
  lookup?: (name: string, timeoutMs: number) => Promise<string | null>;
}

interface Cache {
  checkedAt: number;
  /** `null` records a lookup that failed, so a day offline asks once. */
  latest: string | null;
}

/**
 * The published version, when it is newer than this one.
 *
 * Never rejects and never throws: the caller prints what comes back and has
 * nothing to handle.
 */
export async function checkForUpdate(options: CheckOptions = {}): Promise<Update | null> {
  try {
    const env = options.env ?? process.env;
    if (silenced(env)) return null;

    const now = options.now ?? Date.now();
    const cacheFile = options.cacheFile ?? defaultCacheFile(env);
    const cached = await readCache(cacheFile);

    let latest: string | null;
    if (cached && now - cached.checkedAt < MAX_AGE) {
      latest = cached.latest;
    } else {
      // A failed lookup is remembered as one: a machine that is offline all
      // day should ask once, not once per run.
      try {
        latest = await (options.lookup ?? lookup)(NAME, options.timeoutMs ?? TIMEOUT);
      } catch {
        latest = null;
      }
      await writeCache(cacheFile, { checkedAt: now, latest });
    }

    if (!latest || !isNewer(latest, VERSION)) return null;
    return { current: VERSION, latest, command: updateCommand(), notes: releaseNotes(latest) };
  } catch {
    // Nothing about a version number is worth failing a comparison over.
    return null;
  }
}

/**
 * Whether `latest` is a version worth moving to from `current`.
 *
 * Only the three numbers decide it. A build suffix says nothing about age,
 * and anything this cannot read is treated as not newer — a notice that fires
 * on a version it did not understand is a notice nobody trusts twice.
 */
export function isNewer(latest: string, current: string): boolean {
  const there = parse(latest);
  const here = parse(current);
  if (!there || !here) return false;

  for (let index = 0; index < 3; index += 1) {
    if (there.release[index] !== here.release[index]) return there.release[index]! > here.release[index]!;
  }

  // Same three numbers: the published 0.2.0 is newer than the 0.2.0-rc.1 in
  // hand, and no other pairing of the two is.
  return here.pre !== '' && there.pre === '';
}

function parse(version: string): { release: [number, number, number]; pre: string } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) return null;

  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? '',
  };
}

/**
 * Anywhere the notice would be noise rather than news.
 *
 * A pipeline pins its versions and nobody reads its scrollback for advice, so
 * `CI` silences it; `NO_UPDATE_NOTIFIER` is the convention other tools already
 * honour, and the named one is for this tool alone.
 */
function silenced(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['DIFFYARD_NO_UPDATE_CHECK'] || env['NO_UPDATE_NOTIFIER'] || env['CI']);
}

async function lookup(name: string, timeoutMs: number): Promise<string | null> {
  const response = await fetch(`${REGISTRY}/${name}/latest`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) return null;

  const body: unknown = await response.json();
  const version = (body as { version?: unknown }).version;
  return typeof version === 'string' ? version : null;
}

/** Under the cache directory, because losing it costs one lookup. */
function defaultCacheFile(env: NodeJS.ProcessEnv): string {
  const base = env['XDG_CACHE_HOME'] || join(env['HOME'] || homedir(), '.cache');
  return join(base, NAME, 'update.json');
}

async function readCache(file: string): Promise<Cache | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    const { checkedAt, latest } = parsed as Partial<Cache>;
    if (typeof checkedAt !== 'number') return null;
    return { checkedAt, latest: typeof latest === 'string' ? latest : null };
  } catch {
    return null;
  }
}

async function writeCache(file: string, cache: Cache): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(cache)}\n`);
  } catch {
    // A read-only or full home means the lookup happens again next time,
    // which is the whole of the damage.
  }
}

function updateCommand(): string {
  return updateCommandFor(dirname(fileURLToPath(new URL('../package.json', import.meta.url))));
}

/**
 * How this installation is brought up to date, read off where it lies.
 *
 * There are four ways to have diffyard and only one of them is `npm install
 * -g`. Printing that one at everybody is advice that is wrong more often than
 * it is right: it does nothing for a checkout, installs a second copy beside a
 * project's dependency, and is not how anyone who typed `npx` got here.
 */
export function updateCommandFor(root: string): string {
  const path = root.split(sep).join('/');

  // A checkout is updated by pulling it: the link `install.sh` made points at
  // the bundle in the working tree, so what has to be renewed is the bundle,
  // not the link.
  if (existsSync(join(root, '.git'))) return `cd ${root} && git pull && ./install.sh`;

  // npx installed nothing — it ran a copy out of its own cache — so there is
  // nothing to upgrade; the next run only has to ask for the current version
  // by name.
  if (path.includes('/_npx/')) return `npx ${NAME}@latest`;

  // A global install sits under the npm prefix, which is `lib/node_modules` on
  // every Unix and `npm/node_modules` on Windows.
  if (/\/(?:lib|npm)\/node_modules\//.test(path)) return `npm install -g ${NAME}@latest`;

  // Anything else in a node_modules is a dependency of the project being
  // checked, and that is where the version has to move — with the manifest,
  // not on the machine.
  if (path.includes('/node_modules/')) return `npm install ${NAME}@latest`;

  return `npm install -g ${NAME}@latest`;
}

/**
 * The page that says what the new version changed.
 *
 * A version number on its own is a reason to be told and not a reason to move;
 * the release page is what makes the notice actionable. Every release is
 * tagged `v<version>`, so the address follows from the number — and where the
 * repository is not one that has such pages, the line is simply left out.
 */
function releaseNotes(version: string): string | null {
  if (!REPOSITORY.startsWith('https://github.com/')) return null;
  return `${REPOSITORY}/releases/tag/v${version}`;
}
