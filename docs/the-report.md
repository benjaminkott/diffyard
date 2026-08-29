# The report

What a finished run leaves behind, and how to read it.

- [The views](#the-views)
- [What the run was told to do](#what-the-run-was-told-to-do)
- [What a card says](#what-a-card-says)
- [What kind of difference it is](#what-kind-of-difference-it-is)
- [One file per comparison](#one-file-per-comparison)

## The views

**Side by side** is the plainest of them: the two screenshots next to each
other, each above the address it came from. It answers "what does the other one
look like" without any interpretation in between.

![The side-by-side view: both screenshots next to each other, each labelled
with its address](screenshots/report-detail-side-by-side.webp)

**Onion** lays one over the other at an opacity you set, which is how a change
of a few pixels in position or weight shows itself — the two simply stop
lining up.

![The onion view: one side laid over the other, with an opacity
control](screenshots/report-detail-onion.webp)

Beside these sit **Diff**, **Slider**, **Markup** and **Console**, shown in the
[README](../README.md#six-ways-to-look-at-one-comparison).

## What the run was told to do

A number nobody can trace back to the settings that produced it is not a
measurement. So the foot of the overview carries them, grouped the way the
config file groups them: the two addresses, the viewports, the threshold a
comparison passed or failed on, what was masked, what was held still, how long
anything was given, and what ran before every page.

![The settings panel: the run's own configuration, grouped as the config file
groups it](screenshots/report-settings.webp)

What is deliberately not there is anything secret. A report is a file people
zip and mail, so a header value, a cookie, a basic-auth password and whatever a
step types into a field never reach it — only that they were set, and under
what name.

## What a card says

The report stays honest about having been assembled over time. The original run
keeps describing itself — `startedAt`, `finishedAt` and `durationMs` are left
alone — and every card says when its own picture was taken, beside the verdict:

```
  index                            [ Captured Aug 28, 02:41 PM ]  [ FAIL · 0.93% ]
  mobile · 375×812
```

Anything newer than the run reads *Refreshed* instead, in the accent colour. A
side taken from an earlier run gets its own moment, because then "captured"
means two of them, and a difference measured across two moments is a different
claim from one measured across none:

```
  [ Refreshed A Aug 28, 02:42 PM · B Aug 28, 02:41 PM ]
```

The seconds appear only where the two would otherwise round to the same minute
and read as one. The exact moments are in the tooltip.

If the run reused a side, the re-run line does too, pointing at that report's
own copy of it, so re-running one view does not go back out to production.

## What kind of difference it is

Each comparison is classified, and the overview filters by it:

| Kind | What it means |
| --- | --- |
| Image changed | An image address differs, or one side failed to fetch one |
| Text changed | A text node differs |
| Structure changed | Elements or attributes differ |
| Moved | Content sits at a different height |
| Height differs | The two pages are not the same length |
| Rendering only | The pixels differ while the markup is identical |

A comparison usually carries several: a rewritten heading that made the page
taller is text, structure and height at once. In `results.json` they are
`kinds` on each comparison.

Every one is read off something already established — which lines of markup
changed, what the alignment found, what the page said — rather than guessed at
from the pixels. A kind that had to be inferred from the picture would be wrong
often enough to make the filter worse than no filter: a wrong kind is worse
than a missing one, because it puts a finding in a drawer nobody opens again.

The kinds are decided against the whole run, not one comparison at a time. Two
builds of the same site differ in their asset pipeline on every page, and
counting that makes *Structure changed* true of all nine hundred — a kind that
is true of everything sorts nothing. So a markup difference that turns up on
most of the run's pages is left out of the kinds, named in `commonMarkup` and
reported at the end of the run, because it is worth an ignore rule rather than
worth hiding. The markup diff itself still shows every line.

`Rendering only` is the one worth knowing about. It is what is left when
nothing in the markup accounts for the picture — identical documents, or
documents whose only differences were the build ones discounted above. A font,
a picture whose address stayed put while its content changed, something
timing-dependent: the kind nothing else in the report will explain.

## One file per comparison

Beside its screenshots, each comparison is written on its own:

```
shots/shop--checkout--desktop.a.png
shots/shop--checkout--desktop.b.png
shots/shop--checkout--desktop.diff.png
shots/shop--checkout--desktop.a.html
shots/shop--checkout--desktop.b.html
shots/shop--checkout--desktop.patch
shots/shop--checkout--desktop.json     <- the whole evaluation of this case
```

The difference picture is missing where nothing differed: it would have been
the screenshot again with nothing marked on it, at the same cost, and on a
suite where most pages are fine that is most of the folder. The report shows
side A turned down instead, which is what the picture would have looked like.

It holds exactly what `results.json` holds for that entry — the ratio, the
bands, the shift, the markup tally, the console comparison, the fingerprints.
`results.json` still carries the whole run, but that is the wrong shape for
looking at one case: a scenario should be a directory listing, not a search
through nine hundred.
