# How it works

The parts of diffyard that are worth understanding before you trust a
number, and the failure modes each of them was built around.

- [A page that only moved](#a-page-that-only-moved)
- [Pages that load their images on scroll](#pages-that-load-their-images-on-scroll)
- [What is held still](#what-is-held-still)
- [What the page said](#what-the-page-said)

## A page that only moved

Compared position against position, a page that shifted down by fourteen pixels
differs in every row below the shift — 46 % for a change a reader would call
none. The number then says nothing about how bad it is, and findings cannot be
ranked.

So rows are matched up before being compared, the way the markup diff matches
lines. What is left is the difference in content rather than in position:

```
speakers  mobile   13.92%  →  2.98%  (+39px)
index     mobile    8.14%  →  0.93%  (+12px)
```

Rows are matched on similarity, not equality — two rows of a photograph that
look the same are never byte-identical. Alignment is only ever allowed to
improve the number: where it finds no shift worth taking out, the positional
comparison stands, so it can never talk a real difference away. The positional
number stays in `results.json` as `diff.unaligned`, and `diff.aligned.shift`
says how far the page moved. Switch it off with `diff.alignRows: false`.

`results.json` also carries `diff.regions`: the stretches that differ, in
pixels — `{ from: 1616, to: 1827, height: 211, ratio: 0.97 }` — which is
something you can go and look at, where one percentage for a page eight
thousand pixels tall is not.

## Pages that load their images on scroll

Before the screenshot, the whole page is walked in viewport steps so anything
using `loading="lazy"` or an IntersectionObserver starts fetching, and then
every image that has a source is waited for until it is painted rather than
merely fetched. Switch it off with `stability.triggerLazyLoad: false`.

Two things make this harder than it looks, and both leave holes in the
screenshot without saying anything:

An image that has not begun loading reports `complete === true` — there is
nothing in flight — so deciding a page has settled by counting incomplete
images reads a page full of untriggered lazy images as a page with nothing left
to do. Whether an image has arrived is asked as `naturalWidth > 0` instead.

And a page with `scroll-behavior: smooth` animates every scroll, so a walk that
asks for the next screen every twenty-five milliseconds keeps restarting the
animation and never leaves the top: asked for y 8120, arrived at y 148. The
walk scrolls instantly whatever the page would prefer.

Worth knowing which way this fails. If only one side is cut short you get a
difference that is not there; if both are cut short the same way — the usual
case, since the two sides are the same site — you get a clean comparison of two
blank areas, and the page was never checked at all.

## The same picture, delivered twice

An asset pipeline that re-encodes a photograph, or scales it with a different
filter, changes every pixel of it a little and every edge in it a lot: a hard
edge that moved by half a pixel is a difference of two hundred levels. Measured
across two builds of one site, sixty per cent of a page's pixels differed by
something, two thirds of those by eight levels or fewer, and it was enough to
fail every page with a photograph on it.

Neither obvious remedy works. A colour tolerance wide enough to forgive that
half-pixel edge forgives a real change of the same size. A smallest-area rule
fails from the other end: the noise of one photograph came in areas of up to
nine hundred pixels, while a changed word is thirty.

What separates them is whether the difference survives not looking closely.
Averaged over eight-by-eight blocks, a photograph delivered twice differs by a
couple of levels; a line of text that changed differs by eighty, and a picture
swapped for another by two hundred and thirty.

Two details decide whether that works in practice, and both were measured on a
gallery of fifty-seven photographs. The single worst block is too brittle to
judge on: several of those came to 12.4, 12.1 and 13.5 with a tenth of a per
cent of their blocks over the line — three blocks in seven hundred, at the hard
edges the scaler moved — and the whole picture was reported as changed. So a
hundredth of a picture is allowed over the line, while a planted line of text
puts every block of its area over and a swapped picture puts all of them over.
And a block that fails is measured again against the eight positions around it:
two pipelines scaling one picture put it a fraction of a pixel apart, and a
hard edge half a pixel over is a block average thirty levels out while being
the same edge. With both, those photographs came in between 3 and 7 rather
than at 12 and 13.

So while a page is photographed, every rectangle holding a picture is recorded
— `img`, `video`, `canvas`, `svg`, and anything with a background image, since
half the photographs on a page are not `img` at all. Where both sides say there
is a picture in the same place, and the two versions come out the same under
that averaging, the pixels inside it are set aside: drawn in blue rather than
red, counted in `redelivered` rather than in the difference, and filed under
*Picture delivered differently* so the report can say what happened. Everywhere
else on the page, and for any picture only one side has, nothing changes.

A picture is offered two placements, and either will do. The first is where
the row matching says the two pages meet; the second is where each side's own
layout puts that picture. A page that gives up a pixel or two per section has
them disagree, and measured over a run's failing comparisons each was right
where the other was wrong: 94 pictures excused one way, 118 the other, 142 by
one or the other.

The same question is then asked of everything still marked, block by block.
Measured on that run once the pictures were handled: ninety-nine per cent of
what was still counted sat outside every rectangle — logos and icons the two
systems rasterised differently, text they hinted differently — and nine tenths
of it was equally invisible. One page came to 0.455%, of which 0.045% could be
seen at all.

Outside a picture the rule is stricter, in two ways, because no picture vouches
for it: every block has to be quiet on its own rather than all but a hundredth
of them, and none is measured against the positions around it. That slack is
for two pipelines scaling one photograph; applied to the whole page it would
also excuse an area that grew a shade darker, which is a change somebody made.
A block that cannot be compared in full — where one page is longer than the
other — is never set aside.

A row one side does not have, standing on its own, is treated the same way, and
for the same reason: measured over a real run, every one of the eighty-nine
such runs left in it was a single row — a height difference of one pixel, drawn
as a tinted line clean across the page. A band of them is another matter
entirely, and is still reported at any size.

The taller side then has a row inside that picture the other has not, and that
row is drawn as the page around it and counted nowhere: it is the same picture
at another size, which is already reported, and a red line across the page for
a row nobody can see is worse than saying nothing. Only inside such a
rectangle, with a row of slack at either end — a row anywhere else is content
one side does not have, and stays a difference of any size.

A picture both sides place in the same column at the same width and draw at a
different height is reported as exactly that, whatever the pixels inside it
say — kind *Picture drawn at another size*, and one line at the end of the run
counting them. Measured across a real upgrade: 1,329 of 19,229 pictures came
out exactly one pixel shorter on the new system, a rounding difference in
working a height out from an aspect ratio. Every page carrying such a picture
then ends a few rows short of the other, which the comparison reports as rows
one side does not have — nine tenths of everything still counted on those
pages, a hundred and eighty findings all saying the same thing. Named once it
is one line and a place to start.

`pixelThreshold: 0` turns both off. Asking for zero tolerance is asking for
every difference to be counted, and setting one aside for being hard to see is
the opposite of that.

The rectangles are written beside the screenshots, so a later run that reuses a
side can still tell the two apart. A run made before they were recorded, or a
scenario that photographs one element rather than the page, counts every pixel
the way it always did.

## What is held still

Two live systems are never pixel-identical by accident. The following run by
default: animations, transitions and the caret are frozen,
`prefers-reduced-motion` is set, lazy loading is triggered by scrolling once,
and fonts and images are awaited before capturing.

They are switched under `stability`, which also holds `retries`.

## What the page said

A page that looks different often looks different for a reason it already
announced: a script that threw before it could lay anything out, an image that
came back 404, a font that never arrived. Both sides' console output is
recorded while they are photographed, and compared the way the markup is.

The list on its own would be noise — every real site logs something. The
finding is the asymmetry:

```
  Errors on one side only
        1  checkout desktop
```

Beyond the console levels, three failures that never reach the console are
recorded too: `pageerror` for an uncaught exception, `requestfailed` for a
request that never completed, `httperror` for a response that came back 400 or
worse. `log` and `info` are left out by default — a chatty site writes
thousands of those and none of them ever explained a screenshot.

Two things that would otherwise make it useless are handled. The same missing
image on two different hosts is one finding, not two, because each side's own
origin is taken out before the two lists are compared. And a failed request
that the browser also reports as a contentless console error ("Failed to load
resource…", naming no URL) is kept once, in the form that names the URL.

The report gets a **Console** view per scenario, with the one-sided lines
marked, and a *Console differs* filter over the run.
