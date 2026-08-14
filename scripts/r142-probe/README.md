# R142 probe — do any conformance goldens under-specify their own operator?

Offline. No container, no AL compile, no network. Run it with:

    bun scripts/r142-probe/measure.ts

## What it asks

`runConformance` used to drain a case's `expectedSpecs` against what the operator produced and never
look at the leftovers on the PRODUCED side. So a case expecting one spec passed even when the
operator emitted that spec plus an unwanted one. Before turning an exactness check on, R142 required
knowing whether the existing goldens would survive it: a failure there could be a golden written as a
spot check rather than an operator bug, and the temptation would then be to weaken the contract
instead of completing the golden.

The script re-runs the exact walk and the exact matching rule `runConformance` uses (parentContext
plus trimmed before/after text, drained one-for-one) over every registered operator, and prints any
produced spec the case's expectation does not account for.

## Result, measured 2026-08-14

    total cases 36, empty (refusal) cases 5, non-empty cases with EXTRA specs 0

All 15 registered operators, tier 1 and tier 2. Thirty-one non-empty cases, and not one of them
produces a spec its golden does not name. The goldens were already exhaustive for their own operator,
so the exactness check cost nothing to turn on: no golden needed completing and no operator bug
surfaced.

Why that was not obvious in advance: several snippets DO produce mutations beyond the one the case is
about — an `empty-block` on the procedure body, a `return-value` on the `exit` — but those come from
OTHER operators, and the conformance runner only ever runs the one operator whose case it is. The
row's worry was real; the measurement is what showed it did not bite here.

Per-operator case counts are printed after the summary, which is how the run confirms both registries
loaded — a registry that failed to import would report zero extras just as convincingly.

The check itself now lives in `runConformance`, so this script is the record of what was measured
before it was turned on rather than a thing anyone needs to run again. Re-run it if the goldens or
the operator set change substantially and you want the same census.
