# R-204b: itest:hang single-path leg — pre-commitment (DRAFT, not yet run)

Status: written before the leg has ever run. Commit this under
`docs/superpowers/specs/2026-10-06-r204b-hang-single-path-precommitment.md` before the first record
run (owner/orchestrator step; this build did not touch a container, lease or gate).

## What the leg is

`packages/runner/itest/hang.itest.ts`, leg `single`: the ON leg's configuration
(`stopHungSessions: true`, `mutantTimeoutMs` 20 000, `stopGraceMs` default 30 000) plus
`groupRuns: { enabled: false }` — the session-level equivalent of the CLI's `--no-group-runs`. Every
covering test goes through `RunMutant` alone, which is the only path R-204b Part A changes (the
grouped ON leg cannot reach it). Order: ON, then SINGLE, then OFF (SINGLE also leaves the tier
clean; OFF quarantines by design and is torn down).

## Source of the expected table

There is no committed baseline file for the ON leg: its frozen table is `EXPECTED_ON` inline in
`hang.itest.ts` (38 rows). The SINGLE leg's table below is that table, verdict for verdict, with
every kill at `killPosition` 1. Derived offline from `EXPECTED_ON` at commit 9dc63a03+; nothing was
run.

## Predictions (each a gate assertion)

1. Every mutant scores the ON leg's verdict: 38 mutants, same (line, operator) set.
2. Exactly 5 `timeout-killed` (lines 37, 43, 44, 73, 145), each with a test row of outcome
   `timeout`, BC's words "stopped the session" and "StopSession", duration in [20 000, 50 000) ms,
   and `op_kind` not `many`.
3. **Zero `stopped-after-completion`** (Part A must not swallow a real hang: a hang never commits a
   completion) and **zero `stop-outcome-unconfirmed`** (R202). `counts.errors` = 0.
4. Every kill (`killed` and `timeout-killed`) at `killPosition` 1 — one method per call. In
   particular line 145 `void-method-call` is `timeout-killed` at position **1**, not the ON leg's 2,
   and the four position-2 kills of the ON leg (lines 145, 146 x2, 147) are at position 1.
5. `groupedCalls` 0, `warmKills` 0, caveat `stop-hung-sessions` present, `quarantined` absent,
   R447's single `hang-refused` row (2 sites) and `narrowed` reliability, baseline green.
6. Per-mutant equality against `packages/runner/itest/hang.single.baseline.json` (below).

**If R202's 400 shows up live** it appears as `stop-outcome-unconfirmed` on a hang mutant: that is a
GATE FAILURE. Re-run the gate once. It is never recorded as a baseline value; if it recurs, file it
against R202 with the run's failure text and do not record.

## Per-mutant table (file `src/HangLogic.Codeunit.al`)

| line | operator | verdict | killPosition |
|---|---|---|---|
| 34 | empty-block | killed | 1 |
| 35 | remove-assignment | survived | — |
| 35 | shift-integer | survived | — |
| 37 | void-method-call | timeout-killed | 1 |
| 38 | conditional-boundary | killed | 1 |
| 38 | loop-truncate | killed | 1 |
| 39 | return-value | killed | 1 |
| 43 | empty-block | timeout-killed | 1 |
| 44 | remove-assignment | timeout-killed | 1 |
| 44 | shift-integer | killed | 1 |
| 62 | empty-block | survived | — |
| 63 | conditional-boundary | killed | 1 |
| 65 | return-value | survived | — |
| 69 | empty-block | killed | 1 |
| 70 | remove-assignment | survived | — |
| 70 | shift-integer | killed | 1 |
| 71 | remove-assignment | survived | — |
| 71 | shift-integer | killed | 1 |
| 73 | remove-assignment | timeout-killed | 1 |
| 73 | shift-integer | killed | 1 |
| 74 | loop-truncate | survived | — |
| 75 | return-value | killed | 1 |
| 101 | empty-block | killed | 1 |
| 102 | remove-assignment | killed | 1 |
| 103 | conditional-boundary | killed | 1 |
| 103 | loop-skip | killed | 1 |
| 105 | remove-assignment | killed | 1 |
| 105 | shift-integer | killed | 1 |
| 107 | return-value | killed | 1 |
| 140 | empty-block | killed | 1 |
| 141 | conditional-boundary | killed | 1 |
| 142 | return-value | killed | 1 |
| 143 | remove-assignment | survived | — |
| 143 | shift-integer | survived | — |
| 145 | void-method-call | timeout-killed | **1** (ON leg: 2) |
| 146 | loop-truncate | killed | **1** (ON leg: 2) |
| 146 | conditional-boundary | killed | **1** (ON leg: 2) |
| 147 | return-value | killed | **1** (ON leg: 2) |

Totals: killed 24, timeout-killed 5, survived 9, no-coverage 0, error 0 (38 rows). The gate
asserts per row; these totals are a cross-check only.

Operator names carry the `lethal.` prefix in the report.

## ON and OFF legs: unchanged, pre-committed

Neither part can move them: a real hang never commits `ProgressBetween`, so Part A refuses nothing;
Part R only changes what happens after an UNREADABLE answer following a stop, and the ON leg's five
stops are answered by BC's 408. The ON leg keeps its inline table, `warmKills` 4,
`groupedCalls` = scored + 4, zero errors; the OFF leg keeps its quarantine. No other frozen figure
moves: bcdev, tables and chunked fire no stops (chunked now also asserts zero
`stop-outcome-unconfirmed`).

## R332 baseline and the record/confirm procedure

File: `packages/runner/itest/hang.single.baseline.json` (registered in `GATE_BASELINES`, listed in
`PENDING_FIRST_RECORD`). Until it exists, `itest:hang` REFUSES to start (preflight before any live
work), which blocks the ON and OFF legs too.

1. Commit this pre-commitment under `docs/superpowers/specs/`.
2. Record once (host, coord lease on the hang container, control app 1.0.0.20 published):
   `LETHAL_ITEST_HANG=1 LETHAL_ITEST_RECORD_BASELINE=hang.single.baseline.json bun run itest:hang`
   — the ON leg runs and is asserted, the SINGLE leg is asserted against predictions 1–5, then its
   baseline is written (exclusive `wx`) and the gate EXITS 3 (never a pass; the OFF leg does not run
   on a record run).
3. Review the file against the table above, per row.
4. Re-run without the record variable: `LETHAL_ITEST_HANG=1 bun run itest:hang` — must PASS all
   three legs.
5. In the same commit as the file: remove `hang.single.baseline.json` from `PENDING_FIRST_RECORD`
   (`baseline-wiring.test.ts` fails while a listed file exists).
