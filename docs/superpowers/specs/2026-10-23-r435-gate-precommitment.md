# R-435: gate pre-commitment (2026-10-23, before any live gate)

Branch `lethal/r435` (R435 folder fingerprint mode with the al-runner-v3 artifact cache, R639 refused-after-stop,
R694 timeout-after-refusal guard). Written before any gate ran on the branch.

## Legs

`selectLegs` on `git diff --name-only origin/master...HEAD`, copied literally: `bcdev`, `lease`, `tables`,
`chunked`, `alrunner-v3`. The four BC legs run on one bc server under a lease; `alrunner-v3` runs locally on the
pinned build (alpha.2 91253f2d6).

## Predictions

1. **bcdev, lease, tables, chunked:** every per-mutant verdict, `killingTest`, note and refusal equal to the frozen
   baselines. The diff changes only v3 code paths and the not-published fingerprint branch; bcdev's published
   fingerprint path is byte-for-byte the same.
2. **alrunner-v3:** every frozen per-mutant figure unchanged, on every leg. No frozen v3 table holds a
   `timeout-killed` (the four v3 baselines, D1, D1c, N1, L1, Y), and none holds a refused row after a timeout, so
   neither R694's guard nor R639's continue can move a recorded verdict.
3. **Proven test apps:** leg T (`sandbox-data-tests`) records the test app as proven, and legs D1 and D1c (the CDO
   checkout) do too: no `test-app-dependencies-unproven` warning on any of the three. (Offline, folder mode alone
   leaves D1/D1c unproven on "Library Variable Storage"; the artifact cache's `*.Source.zip` read closes it.)
4. **Held:** X (d) on the edge build (alpha.4) may move; it is held, not gated.

Any difference from 1-3 is a BLOCK.
