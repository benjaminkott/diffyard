import { readFileSync } from 'node:fs';

/**
 * What the package says about itself, read rather than written down a second
 * time.
 *
 * `npm version` moves package.json and the lockfile and nothing else, so a
 * constant here would be wrong from the moment it matters — the release that
 * just changed the number. The same goes for the address: it is already in the
 * manifest, and a report that names a stale one sends its reader nowhere.
 *
 * The bundle in `bin/` and the compiled file in `dist/` both sit one directory
 * below the package root, so the same relative path finds the manifest either
 * way, installed or in a checkout.
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION: string = manifest.version;
export const HOMEPAGE: string = manifest.homepage;
