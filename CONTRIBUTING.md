# Contributing to diffyard

diffyard compares two URLs against each other — an old and a new
environment, production against staging — and reports what changed, as a pixel
diff and as a structural diff of the DOM. There is no stored baseline; both
sides are captured fresh on every run.

It is used **from the project being checked**, not from this checkout: the
config lives in that project and the results are written there. Keep that in
mind when writing examples or defaults.

Getting a checkout going, the files in the repository the tool writes rather
than a person, and how a release is cut: [MAINTAINERS.md](MAINTAINERS.md).

## Commands

Knowing it is right:

```bash
npm test            # builds, bundles, then node --test over test/
npm run typecheck   # src and test
```

Building it:

```bash
npm run build       # tsc -> dist/
npm run bundle      # esbuild -> bin/diffyard.mjs and bin/diffyard-mcp.mjs
npm run dev         # tsc --watch
```

Writing the files the repository carries, both covered in
[MAINTAINERS.md](MAINTAINERS.md):

```bash
npm run screenshots # the pictures in the README
npm run notes       # what the next release page would say
```

And `npm run diffyard -- run diffyard.yaml` runs the bundle where it lies,
which is how to try a change before `install.sh` has put it on the PATH.

`prepare` and `prepublishOnly` are npm's to call, not yours: both build and
bundle, so a fresh clone is usable after `npm install` and a published package
carries a current bundle.

## Layout

| Path | Holds |
| --- | --- |
| `src/config.ts` | Parses the YAML into one flat, fully resolved `Config` |
| `src/schema.ts` | JSON schema for editors — must stay in step with the parser |
| `src/capture.ts` | Browser, contexts, `beforeEach`, screenshots |
| `src/steps.ts` | The declarative step vocabulary |
| `src/diff.ts` | Pixel comparison, difference regions, row alignment |
| `src/align.ts` | Matching two sequences of rows up before comparing them |
| `src/classify.ts` | What kind of difference a comparison found |
| `src/progress.ts` | The live block: what each worker is on, and how long is left |
| `install.sh` | Installs, builds and symlinks the two commands onto the PATH |
| `src/logs.ts` | What each side said while photographed, and what differs |
| `src/reuse.ts` | Taking one side of a comparison from an earlier run |
| `src/markup.ts` | HTML normaliser and line diff |
| `src/runner.ts` | Runs the pairs, owns run folders and timeouts |
| `src/report/index.ts` | Renders the report; decides what travels with it |
| `src/report/shell.ts` | The document: chrome, controls, templates |
| `src/report/styles.ts` | The report's stylesheet |
| `src/report/client.ts` | What the report does once it is open |
| `src/cli.ts` | `run`, `explore`, `init`, `schema` |
| `src/explore.ts` | Inspects a page and drafts a config from what it finds |
| `src/mcp.ts` | MCP server: hands out the CLI path and how to use it |
| `src/update.ts` | Whether a newer diffyard has been published |
| `test/` | `node:test`, TypeScript runs natively on Node 24 |
| `docs/` | The long explanations the README links out to |
| `docs/demo/` | Two copies of a small site that differ on purpose |
| `scripts/screenshots.mjs` | Runs the demo and photographs it for the README |
| `assets/` | The mark, in an ink for light grounds and one for dark |

The config file is grouped (`compare`, `output`, `browser`, `timeouts`, `diff`,
`stability`, `markup`, `beforeEach`, `scenarios`); that grouping stops at the
parser. Everything downstream sees a flat object with no optionals left.
`compare` is optional — a scenario may name both addresses in full instead, and
a group may bring its own. Groups are expanded at load time into ordinary
scenarios carrying a `group` and their own sides, so nothing downstream needs
to know groups exist; only the report and the CLI read the field, to section
and to label.

The MCP server is a signpost, not a second implementation. Everything diffyard
does is a command line, so the server hands out the path and the usage and
stops there. Resist adding tools that run comparisons or read results: an
agent with a shell does both better, with progress it can see and files it can
open.

The update check is a footnote and never an event. It asks the registry once a
day, times out in well under two seconds, and answers "nothing to say" to every
failure — offline, blocked, a registry that is down. A run must never be
slower, noisier or less likely to finish because the version behind it moved,
and `CI` silences the notice outright: a pipeline pins its versions and nobody
reads its scrollback for advice.

Alignment may only ever improve a number. Where matching rows up does not
reduce the difference, the positional comparison stands — otherwise two
identical pages come back as different because a handful of rows fell on the
wrong side of a threshold. A measurement tool that overstates is annoying; one
that invents a difference is useless.

A reused screenshot must expire when it stops applying, and it must never be
unclear which kind of reference a number was measured against. Hence the
fingerprint over everything that decided the picture, the abort when a named run
is not there, and the line in the head of both the run and the report. A reuse
that silently does nothing is a reuse nobody can rely on.

Anything recorded from two different hosts has to be compared with the host
taken out, or the same finding on both sides reads as two one-sided ones. A
report that is reproducibly wrong is worse than one that is occasionally noisy:
noise gets checked, and a confident wrong answer gets believed.

A capture that quietly falls short is worse than one that fails: two sides cut
short the same way compare clean, and the page goes unchecked. Anything that
gives up on a budget should be able to say it did.

A kind is only worth having if it is read off something already established.
Filtering by a guessed kind is worse than not filtering: a missing kind leaves a
finding in the list, a wrong one files it under a heading nobody opens again.

The report keeps its grounds neutral and spends colour on meaning: amber is
active or picked, mint is fine, red is broken, rust is a capture that never
came back. Amber is the mark's own colour, which is why the accent has it and
nothing else may. How much differs is a magnitude, not a meaning, so it spends
no hue on one — it is ink, thin to heavy.

The report has one theme and it is dark, whatever the system asks for. The
pages under review are almost always light, so a dark surround leaves the
screenshots the brightest thing on the page rather than competing with them —
and following the system would judge the same two shots against two different
grounds. The report tests open it under both settings to catch a light-mode
override creeping back in.

Every colour is a token in `:root`; nothing outside that block names a colour,
except the white behind a screenshot, which is the picture's ground rather than
the page's. Text on a filled chip stays above 4.5:1 — the report tests click
and hover every one of them.

## Conventions

- Target the current Node LTS. Today that is Node 24.
- TypeScript, `strict`, no `any`. Prefer narrow types over casts.
- Comments explain **why**, not what. Skip the ones that restate the code.
- Errors name the option and say what to do about it.
- No new runtime dependencies without a reason; the tool ships as one bundled
  file with only Playwright external.

## Tests

`node:test` with `node:assert/strict`. Test names read as sentences about
behaviour (`counts the padded area as a difference`), not as method names.

Two things are worth testing beyond the obvious: the schema against the
parser — they are two descriptions of the same format and drift silently — and
the edge cases of the diff, where an off-by-one quietly swallows content.

## Commits

- Subject: `[TYPE] Imperative summary`, no trailing period and no issue
  number. Types in use: `[FEATURE]`, `[BUGFIX]`, `[TASK]`.
- Body: what changed and **why**. If a fix, say what was broken and how it
  showed. Wrap at 72 characters.
- Split work into logical blocks: one commit per coherent change, not one per
  file and not one for everything.
- Every commit carries a `Signed-off-by:` trailer with the name and mail from
  `git config` — commit with `git commit -s`.
- Do not commit `dist/`, `bin/`, or `.diffyard-report/`.

Example:

```
[BUGFIX] End an ignored subtree at the right depth

Skipping a selector never cleared its state, because the closing tag was
compared against a depth that had already been incremented. Everything
after the first <script> was dropped from the diff, which is why body
changes never showed up when ignoreSelectors was set.

Signed-off-by: Benjamin Kott <benjamin.kott@outlook.com>
```

## Branches

- Work happens on a topic branch, never directly on `main`.
- Branches are named after what they do, prefixed by type: `task/…`,
  `bugfix/…`, `feature/…` — e.g. `bugfix/ignored-subtree-depth`.
- Every change reaches `main` as a pull request, never as a direct push.
- A pull request is rebased onto `main`, never merged into — rebase again
  whenever `main` moved under it.
- A branch whose commits are clean and separated — one concern each, each
  green on its own — is rebase-merged and keeps them. Every other one is
  squash-merged into `[TYPE] Subject (#<PR number>)`; the squash appends that
  number, a rebase does not, so a subject that has to carry it says so itself.
- Don't squash a pull request branch yourself — the merge does it.
