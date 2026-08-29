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
