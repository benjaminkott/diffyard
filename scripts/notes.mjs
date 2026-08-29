#!/usr/bin/env node
/**
 * What the release page says, written from the commits it was cut from.
 *
 *   npm run notes             what the next release would say
 *   npm run notes -- v0.1.1   what a tag said
 *
 * The release workflow runs the same command and hands the file to
 * `gh release create`, so what a maintainer reads before pushing a tag is what
 * the page will carry. Read it while a subject can still be rewritten: a tag
 * is the one thing here that is never taken back.
 *
 * GitHub's own --generate-notes is what this replaces. It lists pull requests;
 * the work arrives as commits, and their subjects are written to be read.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');
const NOTES = join(root, '.out', 'notes.md');

/** A tag this repository releases under, told apart from any other tag. */
const RELEASED = /^v\d/;
/** `[TYPE] Subject`, which is how every commit here is written. */
const SUBJECT = /^\[([A-Z]+)\] (.+)$/;
/** The version bump itself: what the tag points at, not something that changed. */
const BUMP = /^\[TASK\] Release \d/;

/** The types, in the order a reader cares about them. */
const HEADINGS = [
  ['FEATURE', 'New'],
  ['BUGFIX', 'Fixed'],
  ['TASK', 'Changed'],
];

/**
 * One commit per line, three fields, unit-separated so no subject can be
 * mistaken for a field boundary.
 */
const FIELD = '\x1f';
const FORMAT = `%h${FIELD}%D${FIELD}%s`;

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const asked = process.argv.slice(2).find((argument) => !argument.startsWith('-'));
const version = (asked ?? manifest.version).replace(/^v/, '');
const tag = `v${version}`;

const log = git('log', '--no-merges', `--pretty=format:${FORMAT}`)
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [sha, refs, subject] = line.split(FIELD);
    const [, type = '', text = subject] = SUBJECT.exec(subject) ?? [];
    return {
      sha,
      type,
      text,
      subject,
      tags: refs.split(', ').filter((ref) => ref.startsWith('tag: ')).map((ref) => ref.slice(5)),
    };
  });

// Where the range starts. A tag that is not in the log yet is the normal case
// on a desk — the notes are read before the release is cut — and the tip is
// then whatever the branch is at.
const at = log.findIndex((commit) => commit.tags.includes(tag));
const pending = at < 0;

let previous = '';
const range = [];
for (const commit of log.slice(Math.max(at, 0))) {
  previous = commit.tags.find((other) => RELEASED.test(other) && other !== tag) ?? '';
  if (previous) break;
  range.push(commit);
}

const changes = range.filter((commit) => !BUMP.test(commit.subject));
const slug = /github\.com[/:]([^/]+\/[^/.]+)/.exec(manifest.repository?.url ?? '')?.[1] ?? '';
const repo = `https://github.com/${slug}`;

const body = [
  `diffyard at **${version}** — ${manifest.description}.`,
  '',
  '## Install',
  '',
  '```sh',
  `npm install -g ${manifest.name}@${version}`,
  '```',
  '',
  'Or run it without installing anything: `npx diffyard run diffyard.yaml`.',
  '',
];

for (const [type, heading] of HEADINGS) {
  const commits = changes.filter((commit) => commit.type === type);
  if (commits.length === 0) continue;
  body.push(`## ${heading}`, '');
  for (const commit of commits) {
    body.push(`- ${commit.text} ([\`${commit.sha}\`](${repo}/commit/${commit.sha}))`);
  }
  body.push('');
}

const rest = changes.filter((commit) => !HEADINGS.some(([type]) => type === commit.type));
if (rest.length > 0) {
  body.push('## Also', '');
  for (const commit of rest) {
    body.push(`- ${commit.subject} ([\`${commit.sha}\`](${repo}/commit/${commit.sha}))`);
  }
  body.push('');
}

body.push(
  '## Where it is',
  '',
  `- [\`${manifest.name}\`](https://www.npmjs.com/package/${manifest.name}) on npm`,
  `- [The README](${repo}/blob/${tag}/README.md) as it stood at this tag`,
  '',
  previous
    ? `**Every commit in this release**: [${previous}…${tag}](${repo}/compare/${previous}...${tag})`
    : `**Every commit in this release**: [the whole history](${repo}/commits/${tag})`,
  ''
);

mkdirSync(dirname(NOTES), { recursive: true });
writeFileSync(NOTES, `${body.join('\n')}\n`);

const counted = HEADINGS.map(([type, heading]) => {
  const n = changes.filter((commit) => commit.type === type).length;
  return n > 0 ? `${n} ${heading.toLowerCase()}` : '';
}).filter(Boolean);

process.stdout.write(`\n  ${NOTES.replace(`${root}/`, '')} — ${tag}${previous ? `, from ${previous}` : ''}\n`);
process.stdout.write(`  ${counted.join(' · ') || 'nothing changed'}\n`);
if (pending) process.stdout.write(`  ${tag} is not a tag here yet; this is what it would say\n`);
process.stdout.write('\n');
