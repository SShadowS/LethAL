# R-955 (R968) pre-commitment: two refusal families join the v3 serve keep list; no gate figure moves

Written 2026-11-14 by lane code, before any gate run of the change. al-runner `current`: edge-736fc7677.

## The change

`V3_SERVE_SAFE_REFUSALS` (packages/runner/src/al-runner-server.ts) gains two entries, each anchored at both ends:
`company-findset` (`NotRun: out-of-scope: FindSet on the Company table: the database may hold companies this runtime does not know (ADR-046
decision 4a)`) and `cascade-existing-state` (R890's cascade, `an earlier test of this codeunit, <T>, changed an isolated storage key or a
number sequence that existed before it: ...`, the test name the only variable part). A serve row with either text no longer closes the
daemon (R612).

## Why

With #7978's compile cache on `current`, DO's daemon baseline still restarted 7 times in 16 minutes: 1 `company-findset`, 6
`cascade-existing-state` (R-942's serve window 1). Both families were measured clean on an invented app with R-937's kit
(`/coord/handoff/R-955/restart/result.md`): per family 47 refused requests, 27 readers on one kept daemon all equal to the control
(the reader now also reads the key's value and the sequence's current number), 20 fresh daemons equal, pid unchanged, no panic.

## Predictions

- **No gate figure moves.** Neither text occurs in the last full v3 gate (R-977's `v3final.log`, every leg) or in any BC leg log; no
  fixture reads the Company table, and the order fixture's isolated storage and number sequence never produced the cascade. Serve
  counters (daemons, closes) are unchanged on every leg.
- Unit: `al-runner-serve-rule.test.ts` keeps on the measured texts and closes on a sibling, a tail, a prefix and a missing test name;
  red both ways.
- DO's re-measure (fewer restarts) waits for R-974, as R-942's serve windows do.
