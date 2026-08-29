# Maintaining diffyard

What someone with commit rights has to know: how to get a checkout going,
which files in the repository are written by the tool rather than by hand, and
how a release is cut.

## A checkout

```bash
git clone https://github.com/benjaminkott/diffyard.git ~/tools/diffyard
cd ~/tools/diffyard
./install.sh
```

`install.sh` fetches the dependencies if they are not there, builds the bundle,
and symlinks `diffyard` and `diffyard-mcp` into `~/.local/bin`. A link rather
than a copy, so the command is always what is in the checkout — switch branch,
and it is the branch you are on. It writes nothing outside that one directory
and edits no shell file: if the directory is not on your PATH it prints the line
to add and leaves the choice.

```bash
./install.sh --prefix /usr/local/bin   # somewhere else
./install.sh --uninstall               # remove the links again
```

Uninstalling only removes links that point into this checkout, so a published
install of the same name is left alone.

The browser is fetched by the first run that needs one, as it is for anybody
else. `npx playwright install chromium` gets it out of the way beforehand.

## Files the tool writes

Two things in the repository are generated. Both are committed, because both
are read by people who never run the build — and both go stale silently.

**`diffyard.schema.json`** is what an editor validates a config against, and it
is generated from the parser. A schema that has fallen behind marks a valid
config as wrong and completes options that no longer exist, which is worse than
having no schema at all. `npm test` fails when it has drifted; write it again
with:

```bash
diffyard schema diffyard.schema.json
```

**`docs/screenshots/`** are the pictures in the README, taken from a real run
against the demo site in `docs/demo`. They go stale whenever the report changes:

```bash
npm run screenshots
```

Nothing checks these, so look at them. `KEEP=1 npm run screenshots` leaves the
run behind and prints where, which is how to open the report the pictures came
from.

## Cutting a release

Publishing runs on npm's trusted publishing: the workflow proves who it is with
an OIDC token GitHub mints for that run, and npm trades it for publish rights.
There is no `NPM_TOKEN` on the repository, nothing to rotate, and nothing that
can leak — and the tarball records where it was built without being asked.

### Once, before the first release

A trusted publisher is configured on a package, and npm has no package until
something is published — so the first publish cannot itself be a trusted one.
That version goes up by hand:

```bash
npm login    # the web login, with 2FA
npm publish
```

A token would do for the publish and not for the step after it: `npm trust`
requires two-factor authentication on the account and refuses both a granular
access token that bypasses 2FA and basic auth. One login covers both, and
leaves nothing behind to revoke.

**Do not tag that version.** Pushing `v0.1.0` starts the release workflow,
which would publish the same version a second time and fail — and creating the
tag through `gh release create` fires the same event. The bootstrap version
therefore has no release page, and the first tagged release is the one after
it. That is the whole cost of npm having no way to reserve a name.

Then, from npm CLI 11.10.0 or later, as a maintainer of the package:

```bash
npm trust github diffyard \
  --file release.yml \
  --repo benjaminkott/diffyard \
  --allow-publish
```

`--file` takes the workflow's name and refuses a path: npm resolves it under
`.github/workflows/` itself. npm trusts that one file by name, so moving the
publish step into another workflow means changing this configuration in the
same breath.

Then set the package to require two-factor authentication and disallow tokens.
That is npm's own recommendation and it costs this workflow nothing, because an
OIDC exchange is not a token.

### Every release after that

The version in `package.json` and the tag are the same thing said twice, and
the workflow refuses to publish when they disagree. The bump is a change like
any other, so it goes through a branch and a pull request rather than straight
onto `main`:

```bash
git switch -c task/release-0.2.0
npm version 0.2.0 --no-git-tag-version   # package.json and the lockfile
git commit -s -am "[TASK] Release 0.2.0"
```

Once that is merged, tag the commit on `main` and push the tag:

```bash
git switch main && git pull
git tag v0.2.0
git push origin v0.2.0
```

Pushing a `v*` tag runs the
[release workflow](.github/workflows/release.yml): it installs, fetches
Chromium, runs `npm run typecheck` and `npm test`, checks the tag against the
version, and publishes.

### What the release page says

The page is written from the commits the tag was cut from — every subject under
the type it carries, each linked to its commit — over the command that installs
this version. Read it before the tag is pushed, which is while a subject can
still be rewritten:

```bash
npm run notes -- v0.2.0
```

That writes `.out/notes.md`, and the release job runs the same command and hands
its file to `gh release create`. So a document on a desk and a step in a
workflow cannot say different things.

Everyone still on the previous version hears about the new one from their next
run, within a day: the registry is what the check reads, so the notice starts
the moment the publish lands, not the moment the tag is pushed.

GitHub's own `--generate-notes` is what this replaced. It lists pull requests;
the work arrives as commits, and their subjects are written to be read.

### When it goes wrong

If it fails after the tag is pushed, fix it and move the tag rather than
cutting a version nobody can install:

```bash
git tag -d v0.2.0 && git push origin :refs/tags/v0.2.0
```

Only while the version is unpublished. Once npm has it, a version is spent —
cut the next one.
