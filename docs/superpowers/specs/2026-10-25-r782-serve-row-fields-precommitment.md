# R782 pre-commitment (R-782): serve-entries reads a dotted method from the row's own fields on #5798-fixed builds

Written 2026-10-25 by lethal-bugs, before any live run of the R782 build (lethal/r782 0ef82e1d).
What moves is listed in `/coord/handoff/R-782/moves.md`.

## The change
- A pin flag `serveRowFields` (only on `edge-a157b2d34`, looked up by version and sha256) says #5798 is fixed upstream.
- On a flagged build, `serveRow` takes `codeunit` and `method` from the row, requires both, and requires `name` to equal
  `Codeunit<codeunit>.<method>`. A missing field or a mismatch refuses the request by name.
- On a flagged build, R722's refusal of explicit serve-entries for a dotted method is lifted, and R761's default no
  longer falls back for an inner dot alone.
- On every other build (dcdf9e821, alpha.5), all of this stays as it is today.

## Predicted figures on `current` = al-runner 3.0.0-alpha.5+edge.20261025 (a157b2d34), `itest:alrunner-v3` (TABLES + CDO)
- **N1E:** the serve-entries session COMPLETES: 36 killed / 0 survived / 0 no-coverage over 36, per mutant equal to
  `bcdev.names.baseline.json` (verdict and killing test, as N1 asserts), with 0 echo mismatches. The `Dot.Step` row is
  scored as codeunit 78850, method `Dot.Step`. Leg N1E = `pass`. Its serve counters are printed, not pinned.
- **Every other leg:** each verdict, killing test, note set, refusal set, count and pinned counter is unchanged from
  that leg's reading on a157b2d34 at master before R782 (N1 one-shot 36/0/0; N1S 33/0/3 with `N1S_PINS`; S1E's pins;
  O1 with the pinned CDO WorkDate; D1, D1c, T per mutant).
- Update gate outcome: `pass`.

## On dcdf9e821 (not run live: no longer `current`)
Every figure as today, including N1E's fail-closed reading. Unit tests pin each direction.

## Judgement
Any other reading is a BLOCK until explained, in a dated addendum, never an edit of this file.
