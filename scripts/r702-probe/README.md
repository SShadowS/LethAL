# R702 gap 2 probe: walks over a TEMPORARY record

**Status: built and compiled offline only. It has run on NO server yet.**

One invented AL app, `R702 Temp Walk Probe` (`b0a9bc3f-6c05-4dc5-97ae-fcea6eb0d3e6`, publisher `LethAL Probe`),
object ids 93720-93729, web service `R702Probe`, procedure `RunLeg(leg, find, n, isTemp)`.

Question: R696 found that a Next loop sees rows moved or inserted ahead of its cursor (it ran FOREVER). Does the
same hold when the walked record is temporary?

Legs (all walk `SetCurrentKey(Grp, SortKey)`, `Grp = 1`, N rows):

| leg | action in the loop |
|---|---|
| T1c | a second variable made by `Copy(R, true)` (shares the temp data) moves the current row's key far ahead |
| T1v | a by-value parameter copy of R moves the current row's key far ahead |
| T3o | R's own Insert of a row with a higher key |
| T3c | Insert of a higher-key row through a `Copy(R, true)` variable |
| L2 / L2b | own-variable Modify, +1000000 / +15 (the R696 own-variable legs) |

Each runs under FindSet, FindSet(true) and Find('-'), for N = 3, 60, 1000, on a temporary record (`isTemp=true`) and
on the permanent table (`isTemp=false`, the control that must reproduce R696's FOREVER for T1 and T3). Every walk
counts visits before each action and stops at 3N+10. `perm=` in the result is the permanent row count after a temp
walk: it must be 0.

## Run

    bun scripts/r702-probe/drive.ts --build --server bc2                      # offline; writes .kraken-local/r702-probe/shas.json
    bun scripts/r702-probe/drive.ts --server bc2 --lane <lane> --step publish
    bun scripts/r702-probe/drive.ts --server bc2 --lane <lane> --step run-perm
    bun scripts/r702-probe/drive.ts --server bc2 --lane <lane> --step run-temp
    bun scripts/r702-probe/drive.ts --server bc2 --lane <lane> --step cleanup

Do not rebuild after the pre-commitment records the hash (every alc build gets a fresh header id).
