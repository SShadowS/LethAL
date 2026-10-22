# R649: BC's own Sleep under LethAL's baseline call

Run on bc2 on 2026-10-22 (results below). The driver is `scripts/r649-bc-probe/drive.ts`. It writes
`<server>-probe.json` here. The pre-commitment is `2026-10-22-r649-bc-sleep-probe-precommitment.md` (fcb16407).

## Run

After `kraken coord lease <server> bugs`, from the worktree root:

```
bun scripts/r649-bc-probe/drive.ts --server bc1
```

It refuses (exit 2) unless lane bugs holds that server. `R649_CASES=92930,92931` runs only those
codeunits. The full run may hold the lease about 25 minutes: the two 600 s cases run last.
`--remove-only` runs no case: it only removes both apps and reads them back absent (a retry after a
failed removal).

## The apps

Compiled offline with alc 18.0.43.1464, against `/coord/cache/bc-symbols/<server>/` (System
28.0.54946.56477) and the 2026-10-22 LethAL Control 1.0.0.23 (`CONTROL_APP` in `scripts/bc-linux-setup.ts`), once
per server into the gitignored `scripts/r649-bc-probe/build/<server>/`. Both compiled with no
diagnostics on all three caches. The caches hold the same System version, but their files differ by
sha256, so each server has its own build.

- **Target, "LethAL R649 BC Sleep Probe"** (`7937c2a9-…`), ids 92920-92929.
  - Install codeunit 92920 registers artifact `588155e9…` (RunMutant refuses an unregistered target).
  - Codeunit 92921 "R649 Probe Sleeper" is the v3 gate's 50605 "Probe Sleeper", word for word.
- **Tests, "LethAL R649 BC Sleep Probe Tests"** (`44c7bc28-…`), ids 92930-92939. One case per
  codeunit, each with `TestPermissions = Disabled`:

| Codeunit | Test | Body |
|---|---|---|
| 92930 | `Sleep100` | `Sleep(100)`; fails with `MEASURED elapsed …` if BC's clock shows under 100 ms |
| 92931 | `Sleep5000` | `Sleep(5000)`; the same check at 5000 ms |
| 92932 | `LongSleepThenAssert` | 50660's test of that name: `Sleep(600000)`, fails `after sleep …` if under 600000 ms |
| 92933 | `SleeperDoubles` | 50660's test of that name, against 92921 |

## Id check (2026-10-22, before any publish)

- No committed `app.json` has an `idRanges` entry that overlaps 92920-92939. R639 holds 92900-92919;
  R389 holds 91500-91579; R340 holds 92800-92849.
- `git grep` finds no `929[2-9]x` number anywhere in the repo, and none under `/coord/handoff/*/probe`.
- The two app ids and the artifact id appear nowhere else in the repo.
- On the server, the driver reads both app ids absent (0 rows) before it publishes, or it stops.

## Results (bc2, 2026-10-22, pre-commitment fcb16407)

Measured on BC 28.4 on bc2, LethAL Control 1.0.0.23, lane bugs' coord lease 15:41:26Z-15:53:41Z. The full readings are in
`bc2-probe.json`; the driver log is `/coord/handoff/R-649/probe/drive.log`.

| # | Test | LethAL's row | BC's own outcome |
|---|---|---|---|
| 1 | `Sleep100` | `pass`, 215 ms | `pass` |
| 2 | `Sleep5000` | `pass`, 5095 ms | `pass`: BC really waits, and a 5 s Sleep is green under the 120 s budget |
| 3 | `LongSleepThenAssert` (`Sleep(600000)`) | `deadline-exceeded` after 120 060 ms, `in-flight-unknown`: "RunMutant timed out before headers: AbortError: The operation was aborted.; answer readback: the server holds no committed answer for r649-92932-22828/22828 (it holds r649-92931-22827/22827)" | **no answer**: the op stayed `completed: false` at every 10 s poll to 720 s after dispatch |
| 4 | `SleeperDoubles` | not run (the pre-committed STOP after a case with no answer) | — |

**Decision-table row: B.** LethAL's baseline reading of a `Sleep(600000)` test is "not green at 120 s", as on edge
v3. "BC waits the full 600 s" is NOT measured. Case 4 (the exact X (d) shape) was not run; it starts with the same
`Sleep(600000)`, so its baseline reading is inferred to follow case 3's.

**After the run** (read-only, `/coord/handoff/R-649/probe/bc2-status.log`): 11 `GetOperationStatus` polls from
15:56:34Z to 16:01:37Z still read the op `completed: false`, `state: running` in `LongSleepThenAssert`. That is 20
minutes after dispatch, about 9 minutes past the end of a 600 s Sleep. `lethal doctor` then reported bc2's control-app
lease orphaned (held by this probe, expired 15:53:48Z). No reset was run, because the op was still live. Filed as R658.

## What stays on the server after removal

As with R639: one row in LethAL Control's artifact registry, keyed by target `7937c2a9-…`, which no
API removes. The probe has no table, so no schema ghost.
