import { readFileSync } from 'node:fs';

/**
 * What the package says it is, read rather than written down a second time.
 *
 * `npm version` moves package.json and the lockfile and nothing else, so a
 * constant here would be wrong from the moment it matters — the release that
 * just changed the number. Reading it cannot drift.
 *
 * The bundle in `bin/` and the compiled file in `dist/` both sit one directory
 * below the package root, so the same relative path finds the manifest either
 * way, installed or in a checkout.
 */
export const VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
