# Reusing a side from an earlier run

While a regression is being tracked down only one side moves: the local one.
The reference is production, unchanged for hours, and it is the slower of the
two because it goes over the network to someone else's host. Photographing it
again for every measurement is most of the wait.

```bash
diffyard run diffyard.yaml --reuse b    # B from the last run
diffyard run diffyard.yaml --reuse b --reuse-from nightly
diffyard run diffyard.yaml --refresh b  # take B fresh again, once
```

or a `reuse` block in the config. `--reuse-from` defaults to the newest
finished run.

## When a shot stops applying

A shot is only kept while the settings that produced it still hold. Every side
of every comparison carries a fingerprint of what decided its picture — the
address, the viewport, the steps, the masks, the browser options, and the three
markup settings that are applied when the document is written. Change any of
them and that side is captured again, and the run says `settings changed`
rather than measuring against something that no longer applies. Scenarios that
were not in the earlier run simply run along.

Nothing about the comparison itself is reused: both diffs are computed afresh
every time, including the markup diff, which is why the numbers come out
identical to a full run.

## Scoring a run again

Nothing that decides pass or fail is in the fingerprint — the tolerances, the
alignment, the markup ignore rules and the thresholds are all applied after the
pictures were taken. So both sides can come from an earlier run, and then
nothing is photographed at all:

```bash
diffyard run diffyard.yaml --reuse a,b --reuse-from 2026-08-31_09-12-04-a1b2c3
```

which is how a threshold is tuned against nine hundred pages without capturing
them again. Masks, hidden elements, viewports and the browser options are the
exception: those change the photograph, so changing one captures that side
again and the run says `settings changed`.

## Saying so, everywhere

It must never be unclear which kind of reference a number was measured against,
so the run says so in its head and the report carries a banner:

```
  20 comparisons · chromium · 4 workers · run 2026-08-28_02-11-30-da7400
  reusing B from run 2026-08-28_02-11-02-2bba01 · captured 41 minutes ago
```

In `results.json` every comparison carries it per side:

```json
"capture": {
  "a": {
    "fingerprint": "9c3a8daae8ac56a2",
    "reusedFrom": null,
    "recapturedBecause": null
  },
  "b": {
    "fingerprint": "d82d2956e97cadcb",
    "reusedFrom": {
      "runId": "2026-08-28_02-11-02-2bba01",
      "capturedAt": "2026-08-28T00:11:02.951Z"
    },
    "recapturedBecause": null
  }
}
```

Production can of course move underneath you. That is the deliberate trade, so
the way back is a flag rather than an edit: `--refresh`, or a run without
`--reuse`. Beyond `reuse.maxAge` — a day by default — the run warns that the
shots it is measuring against have got old.
