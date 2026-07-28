---
name: coverage-differential
description: Run the two-mode differential gate for any change to coverage collection, selection or attribution — one project twice, identical except the coverage mode, compared per mutant on a verified join. Use before claiming such a change is safe, because the frozen live gates cannot detect these regressions.
---

# The coverage differential gate

## Why the ordinary gates cannot do this

All four frozen gates have GREEN baselines. A change to how coverage is COLLECTED or ATTRIBUTED is
a no-op for them: every test passes either way, so every mutant is scored either way, and the
verdict tables match whatever the attribution did. R55's first candidate fix looked verified for
exactly this reason. So did R58's client half, whose unit suite was fully green while the real call
was hanging for 300 s against a live container.

A regression here does not fail anything. It changes WHICH tests are believed to cover WHICH
mutants, and the only visible consequence is mutants quietly moving to `no-coverage` — which reads
as "the suite does not cover this code", the most reassuring possible misreading.

## Run it

```bash
# fixtures: the probe drives runSession directly and dumps per-test coverage sets
bun scripts/probe-r58-differential.ts --project fixtures/sandbox-app \
  --tests fixtures/sandbox-tests --mode procedure --out <scratch>/a.json
bun scripts/probe-r58-differential.ts --project fixtures/sandbox-app \
  --tests fixtures/sandbox-tests --mode fenced --out <scratch>/b.json
bun scripts/probe-r58-compare.ts <scratch>/a.json <scratch>/b.json
```

For a real project behind an environment tool, drive `lethal run` twice with two configs differing
ONLY in `bcdev.coverageMode` and pass the two `--out` reports to the same compare script — it
accepts either shape and says so when per-test coverage is unavailable.

## The rules that cost time to learn

**A `--resume` run is NOT a valid input.** It carries prior verdicts while recomputing attribution,
so each row mixes two runs. Used once as a gate input, it manufactured three convincing "lost
kills" (`M0017`, `M0132`, `M0137`) that a fresh run showed were not real. Only compare fresh runs;
if one is incomplete, restrict the comparison to mutants BOTH runs recorded and say so — a mutant
the second run never reached is "not measured", never "moved".

**Verify the join before comparing anything that depends on it.** `mutantCode` alone is not enough:
confirm file, line and operator match at the same code. An unverified join pairs different mutants
and reports nonsense with complete confidence.

**A passing fixture can pass on its SHAPE.** `sandbox-data` matched verdicts exactly while its
fenced run named ONE member (`Codeunit:79199::Active`, LethAL's own selector) plus two object-level
entries — its table-trigger mutants matched through `coverageFilter`'s `byObject` fallback, which
is trigger-only by design (R29). That comparison is honest but exercises almost none of the
line→procedure mapping. Always read how many MEMBER-level entries each side produced, not just the
verdict table. `sandbox-app` is the fixture that actually tests attribution.

**Read the per-test oracle first.** It localises a defect to a `(test, object, procedure)` triple
instead of laundering it through verdicts, and it is minutes rather than hours.

## Blocking vs reportable

BLOCKING:
- any mutant `killed` → `survived` (a killing test was lost — R59's direction)
- any mutant `killed` → `no-coverage` (same loss, different label)
- any `mutantCode` identity mismatch — the join itself is unsafe
- a candidate baseline RED where the reference was green

REPORTABLE, and each needs a stated cause before it is accepted:
- `no-coverage` → `survived`/`killed` — the expected gain when the new mode has a greener baseline
- `survived` → `killed` — the old mode was under-reporting
- **`survived` → `no-coverage`** — the ambiguous one. Either the new mode correctly reports that no
  test on the VERDICT runner executes that code (in which case the old `survived` verdicts were
  mutated code that never ran), or the new mode lost coverage. Do not accept it as a gain without
  discriminating: run one such mutant through the new path against its covering tests and see
  whether the code is reached.
- covering-set and `attribution` changes — a mutant that survives in both runs while its covering
  set is wrong has a corrupted FINDING with an intact verdict

## Before blaming the mapping

Rule these out with measurement, in this order — each is cheap and offline:

1. **Which frame are the line numbers in?** Instrumentation multiplies file length (a 364-line
   Continia codeunit becomes 3,177). Parse the INSTRUMENTED file, bucket the real rows against its
   procedure ranges, and bucket them against the original's too. The frame that reproduces what the
   run actually attributed is the frame in use.
2. **Are the rows even present?** `LETHAL_FENCED_COVERAGE_DUMP=<path>` writes the raw rows per test.
   Procedures absent from the payload are not a mapping failure.
3. **Is `coverageFilter` involved?** Its object-level fallback is trigger-only, so an ordinary
   procedure mutant whose member key misses is CORRECTLY `no-coverage`. That is not a second bug.
