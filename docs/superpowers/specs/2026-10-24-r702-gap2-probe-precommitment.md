# R-702 (roadmap R702, gap 2): pre-commitment for the temporary-walk probe (2026-10-24)

Written BEFORE any server call. Probe: `scripts/r702-probe/` on `lethal/r702` (7abd7cfd). It is invented AL: app
`b0a9bc3f-6c05-4dc5-97ae-fcea6eb0d3e6` "R702 Temp Walk Probe", ids 93720-93729, web service `R702Probe`. Build
`R702.app` sha256 `6cd73b5cd7cc64e28c1cbbbfa1309bb2f20c280a3c5466b993cfb0b64868433d`; the run uses exactly that file,
with no rebuild. Server: bc2, BC 28.4 W1, under lethal-preproc's lease. Cap = 3N+10 visits, enforced in the AL, so no
cell can hang the server (R164).

## Question

R696 measured that a Next loop over a PERMANENT table sees rows moved (L1) or inserted (L3) ahead of its cursor
through a second variable, and walks forever (capped at every N). R696's rule skips temporary walks, on the belief
that a permanent variable cannot reach a temporary table. Was that skip right? Specifically: can a second variable
bound to the SAME temporary data (via `Copy(R, true)`, or a by-value copy), or R's own Insert, make a temporary walk
run forever?

## Definition of FOREVER

A cell (leg, find method, temp yes/no) is FOREVER when it is `capped=Yes` at EVERY N tested (3, 60, 1000). Capped at
only some N is reported as MIXED, with the numbers, and is read as "not proven finite" (it counts as FOREVER for the
rule). A cell that ends uncapped at every N is FINITE. A cell result only counts if `perm=0` for temp cells (the walk
really was on a temporary record) and the visit counter is at most 3N+10.

## Cells

Each of FindSet, FindSet(true), Find('-'), at N = 3, 60, 1000:

| cell | action in the loop | temp | purpose |
|---|---|---|---|
| T1c | second variable from `Copy(R, true)` moves the current row's key far ahead | yes | gap 2, move |
| T1v | by-value parameter copy of R moves the current row's key far ahead | yes | gap 2, move |
| T3o | R's own Insert of a higher-key row | yes | gap 2, own insert |
| T3c | Insert of a higher-key row through a `Copy(R, true)` variable | yes | gap 2, shared insert |
| L2, L2b | own-variable Modify, +1000000 and +15 | yes | own-variable leg on temp |
| T1c, T1v, T3o, T3c | same four | NO | control: must reproduce R696's FOREVER (T1c, T3c) |
| L2, L2b | same | NO | control: R696 saw 1 visit (+1000000) and every second row (+15), never capped |

Control validity: the permanent T1c and T3c must be FOREVER (R696: L1 and L3 capped at every N). If they are not,
the probe does not reproduce R696 and NO temp result is read; stop and report.

## What each outcome means for R702 gap 2

- **Any temp T1 cell (T1c or T1v) or T3 cell (T3o or T3c) is FOREVER or MIXED:** the R696 rule must also cover
  temporary walks, for that mechanism: a mover through a shared variable (by `Copy(R, true)` or by-value copy) and/or
  R's own Insert into the walked temporary table. The rule's skip of temporary walks is wrong for that leg. Record
  which legs and which find methods, and extend the rule to exactly those.
- **Every temp T1 and T3 cell is FINITE (uncapped at every N), controls valid:** R696's skip of temporary walks is
  right for these mechanisms. Close the temporary-walk half of gap 2 with the measurement (cite the table).
- **T1v temp is FINITE and T1c temp is FOREVER (or the reverse):** the two ways of getting a second variable differ;
  extend the rule for the FOREVER one only, and say so.
- **A temp T3o is FINITE while a T3 cell through a shared variable is FOREVER:** an own insert moves R's own cursor
  (as the own-variable legs do) and is safe; only the shared-variable insert is covered.
- **Own-variable legs L2/L2b on temp:** expected to match the permanent controls (no Id visited twice, never capped).
  A capped L2 on temp would be a new finding: file it as its own roadmap item and widen the rule to own-variable
  Modify on temporary walks.
- **Any call errors, or the probe app does not publish:** no result. Fix the probe, do not read it.

Out of scope here (still open in R702): callee follow, RecordRef walks, helper guards.

## Steps (drive.ts, under a bc2 lease)

publish -> run-perm -> run-temp -> cleanup (unpublish; read back absent). Results in
`.kraken-local/r702-probe/results.tsv` (temp, leg, find, N, visits, distinct, maxPerId, capped, first20, rows, perm).
