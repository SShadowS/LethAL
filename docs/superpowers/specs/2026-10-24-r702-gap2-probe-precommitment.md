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

## Addendum 1 (2026-10-24): two errored runs, nothing read

- **Run 1** (08:45:40Z, build 6cd73b5c) failed on its first call with HTTP 400: "The COPY function can only be used
  with the shareTable argument set to true if both records are temporary."
  - **The cause:** the PERMANENT controls T1c and T3c used `PermCopy.Copy(R, true)`. That is itself a measured fact:
    a non-temporary variable cannot share a temporary table's data.
  - **The fix** (lethal/r702 e79d6f13): a plain second variable in the permanent branch (R696's L1 and L3 control).
- **Run 2** (08:46:51Z, build e58255bf) failed with HTTP 404: "The R702 Probe does not exist. Identification fields
  and values: Id='1'". It is another probe bug, being fixed offline.
- **Process slip, disclosed:** run 2 started before this addendum was committed. It produced no result, so nothing
  from it can be read.
- **By the rule above** (any call errors: no result, fix the probe), nothing from either run is read. Cleanup ran after
  run 1 and is checked after run 2.
- **Every reading above stands unchanged.** The next run's build sha256 is recorded in Addendum 2, committed before
  that run.

## Addendum 2 (2026-10-24, before run 3)

- **The cause of run 2:** the first temp T1v call's `X.Get(Id)` found no row. A by-value `Record` parameter copy of a
  TEMPORARY record holds none of the walker's rows.
- **The fix** (lethal/r702 be90a0f3): `MoveByValue` counts a failed `Get` as a **miss** (nothing moved), and the cell's
  summary reports `misses=<n>`. Nothing else changed.
- **Reading for T1v, added now:** `misses` equal to the number of moves attempted, on a temp cell, means the by-value
  copy does not share the temp data, so it can move nothing and T1v is FINITE by construction. Its rows count as
  "the skip is right" for that mechanism. `misses=0` with a capped cell would be the FOREVER reading above.
- **Run 3 build:** `R702.app` sha256 `ed57d19eb8833f52d20e36a25ee203ef19af52a9c535774f328a1c2e255e6447`; the run uses
  exactly that file. All other readings stand unchanged.
