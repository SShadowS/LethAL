# R782 pre-commitment, addendum 1 (2026-10-25): N1E's gate warning set is empty

Adds to `2026-10-25-r782-serve-row-fields-precommitment.md` (ab5e0e5b).

## What happened
The first full v3 gate on lethal/r782 0ef82e1d (a157b2d34, `/coord/handoff/R-782/v3/full-0ef82e1d.log`) read every leg
`pass` except N1E, which read `infra-fail`: `GateWarningsUnrecordedError: al-runner-v3/N1E: no committed warning set ...
Observed []`. Before R782, N1E's session never completed, so the gate never reached its warning check and no set was
ever committed. Now the session completes: serve-entries, 36 kill pairs, all 36 batched and served, 0 echo mismatches.
The warning check ran and observed no warning.

## The set
`GATE_WARNINGS["al-runner-v3/N1E"] = []`, the same as `al-runner-v3/N1` and `al-runner-v3/N1S` (the same project, run
one-shot and with Dot.Step cut). An empty set means LethAL gave no gate warning for this session. It is added to
`gate-expected.ts` in the R782 branch.

## Unchanged
Every figure of the original file. The final-head gate must read N1E `pass` with 36/0/0 per mutant equal to
`bcdev.names.baseline.json`, 0 echo mismatches, and an empty warning set, and every other leg as pre-committed.
