# R-407 itest:alrunner pre-commitment addendum: a third multi-object leg, `--server` + resource selector

Written by lethal-code on 2026-10-09, BEFORE the confirm run. It adds to
`docs/superpowers/specs/2026-10-09-r407-multiobject-admission-precommitment.md` (e4561cbe) and changes nothing in
it.

## Why

The R-407 build review (`/coord/reviews/R-407/opus-build.md`) found that both multi-object legs run the STATIC
selector. The DEFAULT user combination, `--server` with `selectorMode: "resource"`, has therefore never run live on
an admitted multi-object file. The frame probe does not vary with the selector mode (its bundle has no selector).
Resource mode changes only the selector codeunit and the bundle's `app.json` resource folder, not the multi-object
file's text or the bundle path. So the prediction below is "identical". It is measured rather than argued.

## The new leg

`runMultiObjectLegs` gains a third leg: `runOnce(<dir>, true, "resource", fixture)` on `sandbox-multiobject`, with
`coverage: "al-runner"`, on al-runner `v2.12.0-main.43f76177` (the container's current build).

## Prediction

- **Probe.** The coverage guard runs on this leg's transport (`--server`) and prints `admitted`.
- **Mutants.** Every mutant is IDENTICAL to the one-shot leg: verdict, killing test, covering-test set and
  coverage attribution, per mutant (`assertMultiObjectLegsEqual` against the one-shot leg). It also equals e4561cbe's
  table (`assertMultiObjectRun`): killed 6 / survived 1 / no-coverage 5, with M0003 to M0005 and M0011 to M0012
  no-coverage.
- **Baseline.** Unchanged. `al-runner.multiobject.baseline.json` is recorded from the one-shot leg alone, as before.

## Block rule

Any difference on this leg (verdict, killing test, covering set, attribution, or a probe answer other than
`admitted`) is a BLOCK. It is recorded, then a new r2 addendum is written, then the run is repeated. It is never
edited into the table.
