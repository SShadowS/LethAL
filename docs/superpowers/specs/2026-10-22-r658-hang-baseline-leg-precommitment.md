# R-658 pre-commitment: the `itest:hang` BASELINE leg

Committed by lane bugs on 2026-10-22, before any lease for this run. It was drafted offline, and no server call was
made for it. This is revision r2.

**What r2 changes from r1.** It folds in the delta review of r1:
- D-A to D-F, and the minor items;
- the orchestrator's rulings on D-D (a durable out-of-use marker, no `kraken coord pause`) and on D-F (both goldens
  re-recorded deliberately).

**Sources:**
- the adopted plan r2, `docs/superpowers/plans/2026-10-22-r658-stop-unmutated-runs.md` §6 and §7;
- its delta review `/coord/handoff/R-658/review-plan-r2-delta.md`, with D1-D6 adopted (D1 and D2 change this leg);
- the probe pre-commitment `docs/superpowers/specs/2026-10-22-r658-bc-baseline-stop-probe-precommitment.md`, and its
  wrapper `/coord/handoff/R-658/run-probe.sh`;
- the probe's result `docs/measurements/r658/README.md` (on `lethal/r658`): on bc3, `StopSession` ended a baseline
  `RunMutant` inside `Sleep` with an AL-stop 408 about 86 ms after the stop. That was on the plain `RunMutant` path;
  the coverage path (`RunMutantWithCoverage`) is NOT measured yet (review I4). This leg measures it;
- the out-of-use marker model, `/coord/machine/out-of-use/bc3.md`.

**Terms used below:**
- *AL-stop 408*: BC's HTTP 408 answer whose body has both "stopped the session" and "StopSession"
  (`isAlStopResponse`).
- *STOP*: the rule in §5. It ends the gate with exit 5, keeps the server's coord lease, and leaves the server marked
  out of use.
- *BLOCK*: a failed prediction. The fix does not merge until it is explained.
- *Leg marker*: the file `$H/baseline-leg.state` (§5). It reads `armed`, `stop` or `passed`, or it is absent.
- *Out-of-use marker*: the file `/coord/machine/out-of-use/<server>.md` (§5).

## 1. Where it runs

**Only on `bc2` or `bc3`**, and only after these steps:
1. The owner has restarted that server's instance.
2. `bun scripts/bc-linux-setup.ts --server <that server>` has run clean:
   - it published tests app `LethAL Sandbox Hang Tests` 1.0.0.4 and read it back by sha256;
   - `lethal doctor` reports `control-version` 1.0.0.23.
3. **On bc3 only:** every clearing step in `/coord/machine/out-of-use/bc3.md` is done.
   - The R-658 probe apps (ids 92940-92959, target `d1d2d26c-…`, tests `c189159c-…`) are removed with
     `bun scripts/r658-bc-probe/drive.ts --server bc3 --remove-only` under the probe wrapper's held lease, or the
     restart and setup are confirmed to have removed them. The `--remove-only` JSON under
     `/coord/handoff/R-658/probe/` is the evidence.
   - The probe wrapper is stopped, its coord lease released, and `bc3.md` deleted.
   - Only then does this gate's wrapper take a fresh lease.

**Never `bc1`.** bc1 is the last usable server.
- Before any lease, the wrapper (§5) runs an offline check that prints `itestTargetLine` for the config. It reads only
  the `bcdev` target fields and prints no login.
- The line must name `server=192.168.2.157:7149` for bc2, or `server=192.168.2.157:7249` for bc3.
- A line naming `:7049` (bc1) is refused by name, and so is any other line. Either refusal exits 2, with no lease taken.
- After the gate, the wrapper checks the log's `grep -m1 '^\[itest target\]'` line against the same `server=` value. If
  it differs, the wrapper holds the lease.
- r1's check of the log's first line is dropped, because `bun run` writes `$ bun …` there.

**Other rules:**
- **The config** is `LETHAL_ITEST_CONFIG=lethal.config.<bc2|bc3>.json`.
- **Normal lease rules apply:**
  - count the heavy jobs and get the server's go, and only then lease;
  - one gate on that server;
  - back off when `free -g` shows under 10 GB available.
- **The worktree must be clean.** The wrapper refuses a dirty `/work/lethal-wt/r658` (any `git status --porcelain`
  output) with exit 2, and logs the head sha.

**What the run proves:**
- **One full `itest:hang` run on that server.** It also re-proves the existing ON, SINGLE and OFF legs at tests app
  1.0.0.4 and LethAL Control 1.0.0.23, with the predictions in §3. One run gives both proofs.
- **`docs/gates/servers.md`:** the fixture change makes every `itest:hang` row stale, bc1's included.
  - The rows for bc2 and bc3 read "unproven (tests app 1.0.0.4, R-658)" until that server's run passes.
  - bc1's row reads "not re-proven at 1.0.0.4; hang does not run on bc1".
  - A row is updated only from a passing run's log.

## 2. The fixture

**A new file:** `fixtures/sandbox-hang-tests/src/HangBaselineTests.Codeunit.al`, codeunit **79451 "Hang Z Baseline
Tests"**. It has `Subtype = Test` and `TestPermissions = Disabled`, and it asserts with `Error()`, like codeunit 79450.
The three tests, in this order:

| Test | Body | Unmutated result |
|---|---|---|
| `SleepsPastTheBaselineBudget` | `Logic.DrainQueue(3);` then `Sleep(25000);`. No assert. | passes in about 25 s |
| `ZPassesAfterTheStoppedTest` | empty | passes at once |
| `ZZDrainsAfterTheStop` | `Got := Logic.DrainQueue(3); if Got <> 3 then Error('DrainQueue(3) returned %1, expected 3', Got);` | passes at once (D2) |

**Ids and versions:**
- The id 79451 is inside the tests app's range, 79450-79499. Only 79450 is used today.
- The tests app goes 1.0.0.3 → 1.0.0.4.
- The target `LethAL Sandbox Hang` stays 1.0.0.4, with no source change. The tests app's dependency entry stays as it
  is.

**Offline checks:**
- `bun run compile:fixtures` passes.
- `testpage-scan.test.ts` still passes: the new codeunit has no `TestPage`.
- The codeunit never enters any other gate. R164 is not touched: the target gains no site, and `Sleep(25000)` ends by
  itself.
- Both goldens move exactly as §6 says.

**Why `SleepsPast…` calls `DrainQueue` first:** it is the leak check for the coverage recording. If the stopped
session's recording state survived the stop, the next test, `Z…`, would show `DrainQueue` in its coverage. `Z…`
covers nothing by itself, so any target member in its coverage is a leak.

**Why `ZZ…` exists (D2):** without a test that MUST cover something, "Z has no coverage" and "every mutant is
no-coverage" would also pass if coverage silently returned nothing.

**The names, against `orderCoveringTests`** (`packages/runner/src/test-order.ts`). The order is: most kills in the
procedure first, then fewest covered members, then `codeunit.method` by code unit.
- **In the old legs** (the baseline budget at its 120 s default), all three new tests pass.
  - `SleepsPast…` and `ZZ…` then cover `DrainQueue`, as `Hang Tests.DrainQueueEmptiesTheQueue` does. Each covers
    1 member, so the members key ties.
  - The name key decides: `Hang Tests.…` sorts before `Hang Z Baseline Tests.…`, because at index 5 `T` (0x54) is
    less than `Z` (0x5A).
  - So for the first `DrainQueue` mutant (line 101), the existing killer runs first. It kills, the kill ledger then
    holds 1 for it, and it stays first for lines 102, 103 (twice), 105 (twice) and 107.
  - All 7 rows are `killed` at position 1 (`EXPECTED_ON`). With stop-at-first-failure, no new test ever runs under a
    mutant.
  - That matters: under a mutant, `SleepsPast…`'s 25 s Sleep would pass the 20 s mutant budget. So a new test running
    under a mutant is a BLOCK.
  - Plan test F1 pins this order. It must read the names from the fixture `.al` files, not from string literals.
- **In the BASELINE leg** (`--tests-only` on the new file):
  - `SleepsPast…` is stopped and does not pass, so it covers nothing, and `Z…` covers nothing.
  - That leaves **`ZZDrainsAfterTheStop` as the only test covering `DrainQueue`**: the one covering test, and the
    killer, of the `DrainQueue` mutant (§4).
  - If `SleepsPast…` were counted as covering, it would sort first (`S` < `Z`) and sleep under the mutant. Assertion 3
    catches that.
- **The run order:** `Z…` and `ZZ…` sort after `SleepsPast…` both by name and by position in the file. So the
  baseline runs them after the stop, whichever of the two it orders tests by.

## 3. The existing legs: predicted unchanged, by name

The target source is unchanged. So the mutant set, its identity keys (`identityScheme` 38) and its mutated texts are
unchanged.

**Offline evidence (2026-10-22):**
- `lethal run --dry-run` on a scratch copy of `fixtures/sandbox-hang` with no config listed **38 sites, 38 deployed,
  1 batch**. They are the same 38 (line, operator) pairs as `EXPECTED_ON`, and as the 38 entries of
  `hang.single.baseline.json`.
- It ran from the `lane-bugs` worktree's built parser. The target files are identical to `lethal/r658`'s.
- **To redo at plan step 6:** the same dry-run in the `r658` worktree, once its parser is built.

**ON (`--stop-hung-sessions`, grouped):**
- **Verdicts:** all 38 `EXPECTED_ON` rows, by line and operator, with their `killPosition`s: 24 killed, 9 survived,
  5 timeout-killed.
  - The hangs are lines 37, 43, 44, 73 and 145.
  - Lines 145, 146 (twice) and 147 are at position 2. Every other kill is at position 1.
- **Counts:**
  - `baselineGreen` true; `counts.errors` 0;
  - `warmKills` **4**; `coldConfirmsOn` **4** (lines 37, 43, 44 and 73; line 145 has none);
  - `stoppedCallsOn` **6**;
  - `groupedCalls` = 38 + 2 × 4 = **46**;
  - distinct grouped session ids `manyDistinct` = 46 − 6 = **40**.
- **Unchanged too:**
  - each timeout kill is stopped twice by BC, in [20 000, 50 000) ms;
  - the R447 `hang-refused` row (1 file, 2 sites) and `narrowed`;
  - the caveats `stop-hung-sessions` and `session-warm`;
  - `killReproductionFailures` empty.
- **New and unpinned:** `baseline-test-stopped` is absent from the caveats, and `baselineStopped` is absent from the
  report. At 120 s nothing is stopped.
- **Positive control for assertion 4.12:** the ON leg's store holds **at least one `baseline_snapshots` row**. The gate
  reads it before the store closes.

**SINGLE (`--no-group-runs`):**
- **Verdicts:** `hang.single.baseline.json` per mutant: **24 killed / 9 survived / 5 timeout-killed**, each with its
  frozen `killingTest`.
- **Counts:**
  - every kill at position 1; `coldConfirmsSingle` **5**;
  - `groupedCalls` 0, `warmKills` 0;
  - no `stopped-after-completion` and no `stop-outcome-unconfirmed`.
- **No re-record.**

**A quarantine in ON or SINGLE is a STOP (D-C).** Either of these legs fires the STOP rule (§5) on any of:
- a `quarantined` event;
- a record in that leg's `LegResult.quarantineDir`;
- a mutant whose `cause` is `stranded` or `confirm-stopped`.

The gate checks these first, before that leg's other assertions. Under R658 a stop with no 408 at the cold confirm
quarantines as `stranded` (I1), and that may leave a live session behind.

**OFF:**
- **Verdicts:** as today. Fewer than 38 mutants, `timeoutKilled` 0, and at least one `error` saying "could not be
  confirmed complete".
- **Rows and status:**
  - a `deadline-exceeded` row, and no `timeout` row;
  - `quarantined` set (by design: this is NOT a STOP);
  - baseline green; not `all-errors`; the `hang-refused` row as above;
  - the teardown force-reset.
- **Unchanged under R658:** the baseline now has the stop hook even with the flag off. But at the 120 s default no
  baseline test is stopped, so nothing moves.

**Which counts the new tests DO change:**
- **`singleRows` and `singleDistinct`, by +3 each per leg (ON, SINGLE, OFF).** In the old legs the three new tests
  each add one baseline `pass` row. That row comes from its own unmutated `RunMutant` call: `op_kind` NULL or
  `single`, with its own session id. There is one batch, so one baseline pass.
- They are not grouped rows, so `manyDistinct` (40) and `groupedCalls` (46) do not move.
- The gate asserts only `singleRows === singleDistinct`, and that still holds. No pinned figure moves.
- If the live increase differs, record it. It is not a BLOCK as long as the equality holds and no pinned figure moves.
  It is filed as a correction to this note.
- **Cost:** about +25 s per leg, so about +75 s for the gate.

**Differences:**
- Any verdict or `killingTest` difference in any leg is a **BLOCK**.
- If ONLY identity keys move (not expected: the target is unchanged), follow R332 for `hang.single.baseline.json`:
  1. pre-commit the change;
  2. delete the file;
  3. one run with `LETHAL_ITEST_RECORD_BASELINE=hang.single.baseline.json` (exit 3, never a pass);
  4. a confirming run without it;
  5. review the diff, update `hang.md`, commit.

  That record run needs its own note. This wrapper holds on exit 3.

## 4. The BASELINE leg: predictions and assertions

**Where it sits:** `runLeg("baseline")`, third, in the order **ON, SINGLE, BASELINE, OFF**. Its configuration:
- `baselineTimeoutMs` **10 000** (`HANG_FIGURES.baselineBudgetMs`);
- `mutantTimeoutMs` 20 000;
- `testsOnly` `**/HangBaselineTests.Codeunit.al`;
- the operator `lethal.conditional-boundary`;
- grouping at its default.

**The mutant set (offline, 2026-10-22).** `--dry-run --operator conditional-boundary` gives **5 sites, 5 deployed,
1 batch**, and excludes 33 sites of other operators.

| Line | Procedure | Site | Predicted verdict | `coveringTests` |
|---|---|---|---|---|
| 38 | `CountUpTo` | `until Counter >= Limit` | `no-coverage` | none |
| 63 | `NextRow` | `if Walked >= Rows` | `no-coverage` | none |
| **103** | **`DrainQueue`** | **`while Pending > 0` → `>= 0`** | **`killed`, position 1, `killingTest` `ZZDrainsAfterTheStop`** | **exactly `["Hang Z Baseline Tests.ZZDrainsAfterTheStop"]`** |
| 141 | `SpinUntil` | `if Target <= 0` | `no-coverage` | none |
| 146 | `SpinUntil` | `until Counter >= Target` | `no-coverage` | none |

- **The `DrainQueue` mutant** has identity key
  `9223e82ad7544c25083f5b08316d3c99343c1fd6ff40da16b8d09c55a9a1a837|Hang Logic|DrainQueue|lethal.conditional-boundary|1`
  and mutated-text sha256 `fc55757b9d153a68035d48400b7b144162d383479b1f53bd3410b03ad9afc935`, the same as its
  `hang.single.baseline.json` entry. The gate matches it by that key, never by mutant code. Codes renumber under the
  operator filter.
- **Why it is killed:** with `>= 0`, `DrainQueue(3)` laps at `Pending` 3, 2, 1 and 0, then returns 4. `ZZ…` fails
  with "DrainQueue(3) returned 4, expected 3", in milliseconds (R173's control shape).
- **No `hang-refused` row, pinned offline.** `generateMutationSet` was run on the scratch copy (2026-10-22). With
  `operators: ["conditional-boundary"]` it returns `hangRefused: []`; with no filter it returns the 2-site row, the
  positive control.
  - The reason is in the source: R447 counts a refused site only when `--operator` admits its operator. The two
    refused sites are `remove-assignment` and `shift-integer` on line 104.
  - So the BASELINE leg's `excludedSites.files` has no `hang-refused` row, and `scoreDescribes` does not mention one.
  - The dry-run's `--out` listing has no `excludedSites` field, so this comes from `generateMutationSet`'s own output,
    the input the report's row is built from.

**Assertions, by number.** A failure of any of them is a STOP (§5, D1). The coverage source is the report's per-mutant
`coveringTests` and `verdict`, never `baseline_snapshots` (D-E): D5 records no snapshot in this leg.

1. **`Hang Z Baseline Tests.SleepsPastTheBaselineBudget`:**
   - its baseline row (`mutant_row_id` NULL) has outcome **`timeout`**;
   - its failure message has both "stopped the session" and "StopSession";
   - its `duration_ms` is in **[10 000, 15 000)**;
   - its classification is `baseline-test-stopped`.
   - Predicted: the stop fires at 10 000 ms, the AL-stop 408 arrives before 11 000 ms (the probe measured +86 ms), and
     the row reads about 10 100 ms.
2. **`ZPassesAfterTheStoppedTest`:**
   - its baseline row is `pass`;
   - it appears in NO mutant's `coveringTests`.
3. **`ZZDrainsAfterTheStop`:**
   - its baseline row is `pass`;
   - the line-103 mutant's `coveringTests` is exactly `["Hang Z Baseline Tests.ZZDrainsAfterTheStop"]`;
   - `ZZ…` appears in no other mutant's `coveringTests`.
4. **Exactly 5 mutants.**
5. **The line-103 `DrainQueue` mutant**, found by the key above:
   - is `killed`;
   - has `killPosition` 1;
   - has `killingTest` `ZZDrainsAfterTheStop`.
6. **Its mutated rows** are exactly 2 (the first run and R582's re-run). Both are `ZZ…` with outcome `fail`.
7. **Every other mutant** (lines 38, 63, 141 and 146) is **`no-coverage`**.
8. **`baselineGreen` is false.**
9. **Caveats:**
   - they include `baseline-red`, `baseline-test-stopped`, `tests-narrowed` and `operator-narrowed`;
   - they do NOT include `stop-hung-sessions`;
   - other caveats (for example `session-warm`, from the one grouped call) are recorded, not asserted.
10. **No quarantine:**
    - no `quarantined` event;
    - `report.quarantined` is undefined;
    - `LegResult.quarantineDir` holds no record (`readQuarantineRecords` returns `[]`).
11. **Warnings:** the leg's `warning` events are exactly this allow-list, each once:
    - `operator-narrowed-run` (the `--operator` narrowing);
    - `tests-only-narrowed-baseline`, whose message names 3 tests.

    Any other code is a STOP: a lease warning, `published-test-app-mismatch`, or one not yet known. Both codes are
    emitted in `orchestrator.ts`.
12. **No baseline snapshot (D5):** this run's store has no `baseline_snapshots` row. The positive control is the ON
    leg's at least one row (§3).
13. **`baselineStopped`:** `baselineStopped.tests` is exactly `["Hang Z Baseline Tests.SleepsPastTheBaselineBudget"]`
    (in the report's own name shape), with no `reusedFromRun`.
14. **No refusals:** `unsupportedTests` is empty, and there is no `permissionsRefused`.
15. **`killReproductionFailures`** for `hang/baseline` is empty.
16. **`sessionLiveness.missing` is 0.**
17. **`sessionLiveness.singleRows === sessionLiveness.singleDistinct`.**
18. **The probe acquire:** after the session, a control-app acquire under the owner **`hang-itest-baseline-probe`** is
    **granted**, and its release answers `released: true`.
19. **`stopHungSessions` is absent** from both the backend config and the `runSession` config (M4).
    - The gate checks this before the leg's first server call, and before the leg marker is armed.
    - If it is present, the gate exits 1, not 5: nothing was sent.
20. **Wall clock:** the leg, from its compile to the probe release, takes **under 5 minutes**.

**Predicted, recorded and not asserted:**
- `groupedCalls` 1 (the killed mutant's one group call; its position-1 re-run is a single call), and `warmKills` 0;
- no cold confirm (no `timeout-killed`);
- `singleRows` = `singleDistinct` = 3 (the `Z…` and `ZZ…` baseline passes, plus the re-run's `fail`), and
  `manyDistinct` 1.

**The cost:** about 10 s for the stopped test, plus the compile, the publish, one mutant and its re-run. The whole
gate goes from about 15 minutes to about 20, and the bound is 25 minutes.

**Teardown:**
- After a passing BASELINE leg, the OFF leg runs, and the `finally` teardown force-resets as today.
- Every BASELINE-leg failure is a STOP (D1), so the plan's M2 wait never applies to this leg.

## 5. The STOP rule (D1, D-B, D-C, D-D)

**Triggers.** Any one of these fires it:
1. **no AL-stop 408 for `SleepsPast…` within 40 s of its dispatch** (the 10 s budget plus the transport's 30 s stop
   grace);
2. a **`quarantined` event**, or a record in `LegResult.quarantineDir`, in the BASELINE leg;
3. the **probe acquire refused**, or its release refused;
4. **`Z…` showing target coverage**, meaning it appears in any `coveringTests`;
5. **`ZZ…` missing its coverage**: the line-103 mutant's `coveringTests` is not exactly `[ZZ…]`, or `ZZ…` does not
   pass;
6. **any other §4 assertion failing, or any throw**, once the leg marker reads `armed`. That includes an uncaught
   exception, an unhandled rejection, and an error from `runSession` or the probe;
7. **in ON or SINGLE (D-C):** a `quarantined` event, a quarantine record, or a mutant with cause `stranded` or
   `confirm-stopped`.

**The leg marker** is set by the gate. The wrapper passes its path as `LETHAL_ITEST_HANG_LEG_STATE=$H/baseline-leg.state`.
- **`armed`:** written immediately before `runLeg("baseline")`, after assertion 19's config check.
- **`passed`:** written only after all 20 assertions have passed.
- **`stop`:** written by the STOP path, as its first action, before any log line. A failed write does not change the
  exit code.
- **The crash handlers:** `process.on("uncaughtException")` and `process.on("unhandledRejection")` exit 5 while the
  marker reads `armed`.

**What the gate does on a STOP:**
- it sets an in-process STOP flag and writes `stop` to the leg marker;
- it runs no further leg (no OFF);
- it makes no teardown force-reset: the `finally` checks the flag and skips `teardown()`;
- it makes no `RecoverOp`, no `ForceResetLease` or `force-reset-lease`, and no unpublish;
- **evidence first:** before the `finally` deletes `scratchRoot`, it copies each leg's sqlite store
  (`hang-<mode>.sqlite`) and quarantine dir (`quarantine-<mode>`) to `LETHAL_ITEST_HANG_EVIDENCE_DIR` (= `$H`). A
  failed copy is logged and never changes the exit code;
- it writes a failed receipt naming the STOP;
- **it exits 5**;
- it says loudly that if BC answered the stop, the control-app lease and `lethal doctor` may read the server CLEAN,
  and that this must not be trusted until the owner's restart.

**Exit codes that are not a STOP:**
- **exit 1, before the leg marker is armed:** for example assertion 19's check, or an ordinary failure in ON or SINGLE
  that is not a D-C quarantine. Today's teardown runs.
- **exit 1, with the marker reading `passed`:** an OFF failure. Today's teardown runs.

**The out-of-use marker** follows the orchestrator's D-D ruling, modelled on `bc3.md`.
- **When it is written:**
  - before the gate starts, so before the BASELINE leg can be armed ("in use by an R-658 hang run");
  - again on any STOP or hold, with the reason, the time, and the op id if the log names one.
- **When it is removed:** only on a clean finish, meaning exit 0 with the leg marker reading `passed`.
- **Every other outcome leaves it in place:** a release after exit 1 keeps it, with a "believed clean, gate failed"
  reason, for the lane to review and clear by hand.
- **No reader:** nothing reads it automatically yet; R669 covers that.
- **No `kraken coord pause`.**

**On a STOP, the lane messages the orchestrator at once** (SendMessage to `lethal-orchestrator`), as a step and not a
note. The wrapper cannot send it, so it prints a line saying the lane must.

**The wrapper:** `/coord/handoff/R-658/run-hang-gate.sh <bc2|bc3>`.
- **Its BEHAVIOUR below is binding:** the offline target check before the lease; release only on exit 0 or 1 with the
  leg marker `passed` or absent, and the target line matching; hold on everything else and on INT/TERM; the
  out-of-use marker writes.
- **Exact helper calls may be adjusted at build time** to the real signatures (for example `printItestTarget` in
  `config-path.ts`), without changing that behaviour.
- Any change to the behaviour needs a delta pre-commitment.

```bash
#!/usr/bin/env bash
# R-658: itest:hang with the BASELINE leg, on bc2 or bc3 only, under lane bugs' coord lease.
# Release the coord lease ONLY on gate exit 0 or 1 with the leg marker `passed` or absent, and the
# [itest target] line naming the leased server. HOLD on everything else (5 = STOP, 3, 130, 137, ...),
# whenever the leg marker reads `armed` or `stop`, and on any INT/TERM while the gate runs.
set -u
SRV=${1:-}
case "$SRV" in
  bc2) WANT="server=192.168.2.157:7149" ;;
  bc3) WANT="server=192.168.2.157:7249" ;;
  bc1) echo "refused: bc1 is never used for this gate"; exit 2 ;;
  *) echo "refused: server must be bc2 or bc3, got '$SRV'"; exit 2 ;;
esac
H=/coord/handoff/R-658/hang-$SRV
WT=/work/lethal-wt/r658
OOU=/coord/machine/out-of-use/$SRV.md
CFG="lethal.config.$SRV.json"
STATE="$H/baseline-leg.state"
mkdir -p "$H"
cd "$WT" || exit 9
# Offline checks, before any lease: a clean worktree, and the config's target line (no login printed).
[ -z "$(git status --porcelain)" ] || { echo "refused: $WT is dirty"; exit 2; }
SHA=$(git rev-parse HEAD)
TL=$(LETHAL_ITEST_CONFIG="$CFG" bun -e 'import { itestConfigPath, printItestTarget } from "./packages/runner/itest/config-path"; printItestTarget(itestConfigPath("fixtures/sandbox-hang"));')
echo "$TL"
case "$TL" in *":7049"*) echo "refused: the config names bc1 (:7049)"; exit 2 ;; esac
case "$TL" in *"$WANT "*) ;; *) echo "refused: target line does not name $WANT"; exit 2 ;; esac
out=$(kraken coord lease "$SRV" bugs 2>&1) || { echo "lease refused: $out"; exit 2; }
token=$(printf '%s' "$out" | grep -o '[0-9a-f]\{8\}-[0-9a-f-]\{27\}' | head -1)
[ -n "$token" ] || { echo "no token in: $out"; exit 2; }
echo "$SRV $token $(date -u +%FT%TZ) head $SHA" > "$H/lease.txt"
mark() {  # $1 = reason; the durable out-of-use marker (orchestrator ruling D-D), modelled on bc3.md
  {
    echo "# $SRV is OUT OF USE"
    echo
    echo "- **Since:** $(date -u +%FT%TZ)"
    echo "- **Set by:** lethal-bugs (R-658 itest:hang BASELINE leg, head $SHA)"
    echo "- **Reason:** $1"
    echo "- **Op:** $(grep -o 'opAttemptId[^ ,]*' "$H/hang.log" 2>/dev/null | tail -1 || true)"
    echo "- **Coord lease:** $SRV, held by lane bugs' wrapper /coord/handoff/R-658/run-hang-gate.sh; token in $H/lease.txt"
    echo "- **Evidence:** $H (hang.log, baseline-leg.state, copied stores and quarantine dirs)"
    echo
    echo "## How to clear it"
    echo "1. The owner restarts $SRV (a host action)."
    echo "2. Run \`bun scripts/bc-linux-setup.ts --server $SRV\` until it is clean."
    echo "3. Lane bugs stops the wrapper, releases the coord lease, and deletes this file."
  } > "$OOU"
}
beat() { kraken coord heartbeat "$SRV" "$token" >/dev/null 2>&1 || echo "$(date -u +%T) heartbeat failed" >> "$H/lease.txt"; }
( while :; do sleep 60; beat; done ) &
hb=$!
release() {
  kill "$hb" 2>/dev/null
  if kraken coord release "$SRV" "$token" >/dev/null 2>&1; then
    echo "released $SRV $(date -u +%FT%TZ)" >> "$H/lease.txt"
  else
    echo "release FAILED $SRV $(date -u +%FT%TZ)" >> "$H/lease.txt"
  fi
}
hold() {
  trap - EXIT INT TERM
  kill "$hb" 2>/dev/null
  mark "STOP or hold: $1. The control-app lease and lethal doctor may read $SRV CLEAN; do not trust that."
  msg="STOP: $SRV coord lease HELD, do not release until the owner restart + re-setup"
  echo "$msg"
  echo "LANE: SendMessage lethal-orchestrator NOW: $SRV STOP ($1), marker $OOU"
  echo "$(date -u +%FT%TZ) $msg ($1; token in this file)" >> "$H/lease.txt"
  while :; do sleep 60; beat; done
}
trap release EXIT
rm -f "$STATE"
mark "in use by an R-658 itest:hang run (started $(date -u +%FT%TZ)); not yet finished"
echo "$(date -u +%T) start at $SHA on $SRV"
sig=""
trap 'sig=INT' INT
trap 'sig=TERM' TERM
LETHAL_ITEST_HANG=1 LETHAL_ITEST_CONFIG="$CFG" LETHAL_ITEST_HANG_LEG_STATE="$STATE" \
  LETHAL_ITEST_HANG_EVIDENCE_DIR="$H" bun run itest:hang > "$H/hang.log" 2>&1
g=$?
st=$(cat "$STATE" 2>/dev/null || echo absent)
echo "$(date -u +%T) gate exit=$g leg=$st${sig:+ (signal $sig)}"
[ -n "$sig" ] && hold "signal $sig, gate exit $g, leg $st"
case "$st" in armed|stop) hold "leg marker $st, gate exit $g" ;; esac
case "$(grep -m1 '^\[itest target\]' "$H/hang.log")" in
  *"$WANT "*) ;;
  *) hold "the gate's [itest target] line does not name $WANT, gate exit $g" ;;
esac
case "$g:$st" in
  0:passed) rm -f "$OOU"; exit 0 ;;
  0:absent|1:passed|1:absent) mark "gate exit $g, leg $st: released, believed clean; lane reviews and clears"; exit "$g" ;;
esac
hold "gate exit $g, leg $st"
```

**Wrapper notes:**
- **The heavy-job count and the server's go** come before the wrapper starts. Use `cd` on its own line (memory).
- **`0:absent` is impossible on a full run,** because the BASELINE leg always writes the marker. It is released but
  stays marked, for the lane to look into.
- **In the hold:** the release comes only after the owner's restart and a clean `bc-linux-setup.ts --server <that
  server>`. The lane then deletes the out-of-use marker by hand.
- **Never stop the gate with a signal** (memory). A signal goes to the hold anyway.

## 6. The new figures, the receipt and the goldens

**`HANG_FIGURES` in `gate-expected.ts`, and the `gate-figures` block in `docs/gates/hang.md`:**
- `baselineBudgetMs: 10_000` (plan);
- `baselineSleepMs: 25_000` (plan);
- `baselineLegMutants: 5` and `baselineLegKilled: 1`, so the D2 control is pinned as numbers and never read back from
  the report.

`gate-pages.test.ts` then requires all four in the page block.

**The receipt:** `emitPassed("hang", { sublegs: [...] })` becomes
`["stop-hung-sessions-on", "stop-hung-sessions-single", "stop-baseline", "stop-hung-sessions-off"]`.

**The two goldens (D-F, ruled: re-recorded deliberately).** Each is deleted, recorded once, its diff reviewed, and
committed. The commit message names both. They are offline checks.
1. **`plan-emit-golden.test.ts`**, file `packages/runner/tests/__fixtures__/instrumented-output-golden.json`:
   - It gains exactly ONE key, `fixtures/sandbox-hang-tests/src/HangBaselineTests.Codeunit.al`.
   - Predicted `mutants: 8`. That count was measured offline with `generateMutationSet` on the bodies in §2:
     - `empty-block` at the procedure bodies of `SleepsPast…` and `ZZ…`;
     - `void-method-call` on `DrainQueue(3)` and on `Sleep(25000)`;
     - in `ZZ…`: `remove-assignment`, `negate-conditional`, `shift-integer`, and `void-method-call` on `Error`.
   - The same run gave the existing `HangTests.Codeunit.al` 24, which equals its golden.
   - The key's `sha256` is known only once the file text is final.
   - If the final bodies differ from §2, re-count before recording.
   - Every existing key and value is unchanged, the 38-mutant `HangLogic` entry and the 24-mutant `HangTests` entry
     included.
2. **`r420-handlers.test.ts.snap`**, entry `R420 part 2 … fixtures/sandbox-hang-tests 1`:
   - It gains exactly one object, `codeunit:79451:Hang Z Baseline Tests`.
   - It gains its 3 procedures under `procs`: `79451:Hang Z Baseline Tests.SleepsPastTheBaselineBudget`,
     `….ZPassesAfterTheStoppedTest` and `….ZZDrainsAfterTheStop`.
   - It gains their 3 test digests under `digests`: `79451::sleepspastthebaselinebudget`,
     `79451::zpassesafterthestoppedtest` and `79451::zzdrainsafterthestop`.
   - The 5 existing digests, the `codeunit:79450:Hang Tests` object hash and the 5 existing proc hashes are unchanged.
     No other project's snapshot moves.

**`docs/gates/hang.md`:**
- the four legs, with the BASELINE leg described;
- the OFF wording: the baseline now has the stop even with the flag off, and only mutants depend on the flag;
- a History entry for R658;
- about 20 minutes for the gate.

**`docs/gates/servers.md`:** as in §1.

## 7. Also pre-committed: the bc1 gates (plan §7)

They run on `bc1` as normal gates, each under its own lease, on the submitted head. Every one is **predicted unchanged
per mutant**.
- **The reason:** every baseline now has the stop hook, but no baseline test in these fixtures runs near its budget.
  So no baseline test is stopped.
- **What each report must show:** no `baseline-test-stopped` caveat, no `baselineStopped` field, and no
  `confirm-stopped` cause.

| Gate | Frozen figures that must reproduce per mutant |
|---|---|
| `itest:bcdev` | `bcdev.baseline.json`: 3 killed / 12 survived / 4 no-coverage, 19 sites; `groupedCalls` 15, `warmKills` 0 |
| `itest:chunked` | control 17 / 7 / 2, `warmKills` 9, `groupedCalls` 42, positions {1:8, 2:3, 3:3, 4:2, 5:1}; chunked `warmKills` 5, `groupedCalls` 62; both legs equal in verdict and `killingTest` (the I5 replay wiring) |
| `itest:lend` | `LEND_FIGURES` and `LEND_MUTANTS` as frozen (for example fresh 3 / 12 / 4 with `groupedCalls` 15; resumeSnapshot carried 7, `groupedCalls` 8); covers R3 snapshot reuse and `--resume` |
| `itest:tables` | `tables.baseline.json`: 314 / 70 / 22, 428 sites, `groupedCalls` 414, `warmKills` 15; exactly one failing test, `Data Tests.PageActionComputesNonZero`, still a refusal and not a stop |
| `itest:harden` | `harden.baseline.json`: 16 killed / 5 survived |
| `itest:bcdev-names` | `bcdev.names.baseline.json`: 36 killed; `NAMES_TABLE.length` 12 |
| `itest:bcdev-wrapped` | `bcdev.wrapped.baseline.json`: 60 killed / 38 survived |

- Any per-mutant difference is a BLOCK.
- **Not run:**
  - `itest:envtool` (host-only; `itest:bcdev` stands in);
  - `itest:hang` on bc1 (never).
- **Offline, before any live gate:**
  - `bun scripts/verify.ts`, including both goldens of §6 after their deliberate re-record;
  - `bun run compile:fixtures`;
  - the schemas;
  - `itest:alrunner` and `itest:alrunner-v3`.

## Not derived offline

- **The old legs:** the exact `singleRows` / `singleDistinct` increase. Predicted +3 each per leg, and not pinned.
- **The BASELINE leg:** `groupedCalls`, `singleRows` and `manyDistinct`. Predicted 1, 3 and 1, and recorded only.
- **The plan-emit golden:** the new key's `sha256`. It is known only once the file text is final.
- **The r420 snapshot:** the new hashes. Its "existing entries unchanged" is predicted, not run offline.
- **The coverage path:** the 408 latency. This is the I4 question the leg answers. Predicted under 1 s, and bounded by
  assertion 1 and STOP trigger 1.
