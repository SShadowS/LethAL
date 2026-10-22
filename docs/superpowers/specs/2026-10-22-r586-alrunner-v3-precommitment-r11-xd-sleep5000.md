# R-586 pre-commitment r11 (R-649): X (d)'s Sleeper sleeps 5 s, so its baseline is green on every build that waits

Status: committed 2026-10-22, before any R-649 code change to the probe and before any live run against it. Revised
after the delta review (`/coord/handoff/R-649/review-r11-delta.md`, ADOPT with fixes; I1, I2, M1, M2 and M3 applied).
I2's calibration is measured and quoted in (b), and step 0's merge is done (see (d4)).

It is a delta on r10 (`2026-10-22-r586-alrunner-v3-precommitment-r10-legt-order.md`). r5 (X (d)'s table), r5a (its
setup), r6 (c) (its baseline) and r10 (c) (its printed lines) stand, except where this file says otherwise. A differing
verdict in any leg is still a BLOCK.

Evidence:
- the R-649 pre-commitment (`2026-10-22-r649-bc-sleep-probe-precommitment.md`), its §7 table;
- the bc2 reading (`docs/measurements/r649/README.md` and `bc2-probe.json` on `lethal/r649`, 25072109);
- the after-run status log (`/coord/handoff/R-649/probe/bc2-status.log`);
- the edge rejudge at 77877316 (`/work/tools/al-runner-v3/rejudge/edge-57f1e4f98@77877316…/gate.log`);
- the alpha.2 regate at 77877316 (`/work/tools/al-runner-v3/regate/77877316….gate.log`);
- the offline calibration (`/coord/handoff/R-649/calibration.md`).

## Why

**The bc2 reading is §7 row B:**
- case 1, `Sleep(100)`: `pass`, 215 ms;
- case 2, `Sleep(5000)`: `pass`, 5095 ms. BC really waits, and a 5 s Sleep is green under the 120 s baseline budget;
- case 3, `Sleep(600000)`: LethAL `deadline-exceeded` at 120 060 ms, `in-flight-unknown`. BC never answered: the op
  still read `running` 20 minutes after dispatch (R658);
- case 4, the exact `SleeperDoubles` shape: NOT run (the pre-committed stop after a case with no answer).

**What row B means (§7):**
- Under LethAL's 120 s baseline budget, a `Sleep(600000)` test is not green on BC either. Edge's change (#5605's fix)
  moves toward BC, and X (d)'s current probe cannot be green on any build that waits or counts the wait.
- "BC waits the full 600 s" is NOT measured. This delta does not claim it.
- Case 4's reading is **inferred** to follow case 3: it starts with the same `Sleep(600000)`. Case 2 measured a Sleep
  written in the test itself, not one inside a called target codeunit. That a Sleep in a called codeunit waits the
  same way is **inferred**.

## (a) The change: ONE literal, and the header comment's wording

`scripts/r586-probe/extras/ProbeSleeper.Codeunit.al`, line 12: `Sleep(600000);` becomes `Sleep(5000);`.

**The header comment (M2).** Its stale cause ("their covering test passes only because Sleep does nothing on v3
alpha.2") is reworded. It keeps EXACTLY 5 comment lines (lines 1-5), so the codeunit still starts on line 6 and the
Sleep stays on line 12. X-r11a (`[12]`) and X-r11c (`[25, 31, 37, 43]`) go red if any line moves. The new text:

```
// R586 plan r4 (I-1 (4)), pre-commitments r5 and r11 (leg X (d)): a TARGET procedure that sleeps, for the Sleep rule's
// live positive control. `Waited := 1` gives mutants whose arm still runs the Sleep and leaves the result intact, so
// their covering test passes with the Sleep hit; the backend must score that pass `error` / `runner-refused`. 5 s
// (r11): green under the 120 s baseline on BC (R649) and on v3 builds that count Sleep. Removing the Sleep is the
// negative twin (no Sleep hit, the test passes: survived). Invented; copied by sleep-noop-probe.sh and leg X only.
```

Nothing else in that file changes.

**What stays the same, read from the code:**
- **Line numbers.** The literal sits alone on line 12. No line is added or removed, so the source keeps the Sleep on
  line 12, and the instrumented file keeps its four Sleep lines 25, 31, 37 and 43 (r5). The instrumented lines are
  made by `writeInstrumentedProject` from the same statements; a shorter literal on one line moves no line.
- **The Sleep index, 4 + 5.** `sleepCallLines` (`al-runner-v3-sleep.ts`) keys on a call whose callee is the bare
  identifier `Sleep`, with ANY argument. The argument's value and length play no part. Target 4 (the four arm lines),
  test 5 (`ShortSleep`, `LongSleepA`, `LongSleepB`, `LongSleepThenAssert` in `ProbeSleep.Codeunit.al`, and `SleepHang`
  in `ProbeHang.Codeunit.al`).
- **The five mutants and their codes.** r5 showed `shift-integer` never targets a call argument, so `5000` makes no new
  mutant, as `600000` made none. The codes M0001-M0005 are ordinals by position; every mutant's START position is
  unchanged (the literal is the last thing in its statement, so only END positions on line 12 and after move).
- **r5's per-mutant line predictions:** M0003 at :25, M0004 at :37, M0005's hit at :31. Unchanged.
- **§6 has no duration threshold.** It fires on a covered PASS with a hit on an indexed Sleep line, whatever the
  Sleep's length.

**What the literal's length DOES change, and why no check reads it:**
- M0002 (`void-method-call`) removes the Sleep statement. Its original text is now `Sleep(5000)`, so its original
  text, its end column, its AST hash and its `mutatedTextSha256` change.
- M0001 (`empty-block`) spans the whole `begin … end`, which holds the literal. Its original text, byte offsets and
  hashes change. Its start and end LINES do not.
- M0003, M0004 and M0005 sit on lines 13 and 14. Their text and columns do not change.
- No X (d) check reads any of those. X (d) has no committed baseline file and no `compareMutants`. It checks, per
  mutant: the operator-to-code map, the verdict, the killing test and `killReproduced`, the raw hit count on the
  arm's Sleep LINE, and the note's `ProbeSleeper.Codeunit.al:<line>:`. The note has no column. X (e) and (f) check
  fail-closed outcomes only, and (f2)/(f3) find the Sleep lines by a text match on `Sleep(`, which any argument meets.

**Leg C does not move.** Leg C's `sleep-is-noop` and its 50605 / 50660 run on the INLINE copies `SLEEPER_AL` and
`SLEEP_TESTS_AL` in `al-runner-v3-contract.ts`, not on `extras/`. r11 changes neither copy.

**The other user of the file:** `scripts/r586-probe/sleep-noop-probe.sh` copies `extras/ProbeSleeper.Codeunit.al` for
a manual reading. It is not a gate. Its ProbeSleeper readings now come from a 5 s Sleep.

## (b) 50660's other `Sleep(600000)` tests: NO change

The X (d) copy of 50660 (`extras/ProbeSleep.Codeunit.al`) keeps `LongSleepA`, `LongSleepB` and `LongSleepThenAssert`
at `Sleep(600000)`, and `ShortSleep` at `Sleep(1500)`. The smallest set of literal changes is therefore ONE: 50605's.

**Why none of them needs 5000:**
- **No X (d) check reads their verdicts.** They cover no Probe Sleeper mutant. The only check that touches them is
  r6 (c)'s "no ProbeSleep test is in `unsupportedTests`" (the itest's `!r.unsupportedTests.some(t => t.includes("Sleep"))`).
- **On edge that check already passed with them timing out** (measured, edge rejudge at 711c94d9 and 77877316: the leg
  got past that check to the per-mutant table). A timeout row is a baseline `timeout`, not a refusal, so it never
  enters `unsupportedTests` (R-647 diagnosis B2).
- **Their role in X (d) is the index.** They are 3 of the test side's 5 Sleep lines. The index counts lines, so any
  literal keeps it 5.

**Does any of them prove something only a 600 s Sleep proves?** Not in X (d). `LongSleepThenAssert`'s
"the AL clock advances by the slept time" is leg C's `sleep-is-noop` fact, measured on leg C's own inline copy:
`defect-present` on alpha.2 (the test passes, elapsed ≥ 600000, in a call under 1 s), `gone` on edge (a timeout row
"Test exceeded…"). That fact already pins "the Sleep is virtual" on each build. r11 keeps it on leg C only.

**r6 (c) is restated, not withdrawn:**
- **alpha.2:** all five ProbeSleep tests are green at baseline, as r6 (c) says. **Measured** at 77877316
  (`SleeperDoubles … pass`, `baselineGreen true`).
- **edge:** `ShortSleep` and `SleeperDoubles` green; `LongSleepA`, `LongSleepB` and `LongSleepThenAssert` are baseline
  `timeout` rows. So `baselineGreen` is false on edge. The leg does NOT assert `baselineGreen` (r10), and "no ProbeSleep
  test in `unsupportedTests`" still holds. **Inferred** (the three rows from leg C's `gone`; the check from its
  measured pass).

**The residual, and the offline calibration that closes it.** v3 runs a selected test's whole codeunit. On edge,
`SleeperDoubles` runs after three siblings that each exceed the stop. Two things are needed and neither has been seen
on edge:
1. **The row:** `SleeperDoubles` passes, its 5 s judged against its OWN budget, not one the siblings used up.
2. **The coverage (review I2):** §6 fires only when the row is a PASS, the test has exactly ONE `perTestCoverage`
   entry, and that entry has hits > 0 on an indexed Sleep line. If edge omits the entry, the baseline hits `run()`'s
   "no per-test coverage … refusing" throw, and leg X fails. If the hits are 0, M0003 and M0004 read `survived`, and
   X (d) goes red. Both fail safe, but either one misses (d3).

**The calibration (measured, 2026-10-22, `/coord/handoff/R-649/calibration.md`).** No BC was involved.
- **The binary:** the kept edge binary `failed/edge-57f1e4f98@de8f43e2…/al-runner`, sha256 `0642f9b27f0e…`,
  `al-runner 3.0.0-alpha.4+edge.20261022 (57f1e4f98)`.
- **The call:** one-shot, `test --output-json --isolation test … --test-timeout-secs 120 --codeunit 50660`.
- **The project:** scratch copies of X (d)'s project, with ProbePair, ProbeCoverage and ProbePermissions removed as
  `legXSleep` removes them.
- **The cases:** case `five`, with 50605 at `Sleep(5000)`, and a control with the original `Sleep(600000)`.

**1. The row: case `five`** (exit 7, about 50 ms of wall time):

| Test | Status | notRun | durationMs | Message |
|---|---|---|---|---|
| ShortSleep | pass | - | 0 | "" |
| LongSleepA | error | true | 0 | Test exceeded 120s timeout. |
| LongSleepB | error | true | 0 | Test exceeded 120s timeout. |
| LongSleepThenAssert | error | true | 0 | Test exceeded 120s timeout. |
| SleeperDoubles | pass | - | 0 | "" |

The control (`Sleep(600000)`) reads the same, except `SleeperDoubles`: `error`, notRun, "Test exceeded 120s timeout."
So the 5 s case is a real contrast. **A 5 s SleeperDoubles is green on edge after the three 600 s timeouts.** The
budget is per test, and the three siblings keep `Sleep(600000)`.

**2. The coverage (review I2): case `five` repeated with `--coverage-json`** (exit 7). `perTestCoverage` has 5
entries, one per test, and each test name appears once:
- **SleeperDoubles:** exactly 1 entry. Its hits are 1 on `ProbeSleeper.Codeunit.al` lines 12, 13 and 14, so the Sleep
  line 12 has hits > 0. It also hits `ProbeSleep.Codeunit.al` line 47.
- **ShortSleep:** 1 entry, on `ProbeSleep.Codeunit.al` line 16 only. It touches no ProbeSleeper line.
- **The three timed-out siblings** each get an entry: LongSleepA (line 22), LongSleepB (line 28) and
  LongSleepThenAssert (lines 37 and 38). None of them touches ProbeSleeper.

**What this rules out on edge 57f1e4f98:**
- **No missing entry.** SleeperDoubles has exactly one per-test entry, so `run()`'s "no per-test coverage …
  refusing" throw cannot fire for it, and leg X does not fail on it.
- **No zero hits.** The Sleep line is hit, so the arms that run the Sleep (M0003 and M0004) cannot read `survived`
  for want of a hit. §6 reads them `error`.

**What the calibration does not show:**
- It ran on the SOURCE project, so the Sleep is on line 12. In the gate, the instrumented file's arm lines (25, 31, 37
  and 43) carry it, and the hits per arm are r5's prediction.
- No mutant call was made. So the X (d) table on edge stays **inferred** in (d3), but its two named failure modes are
  ruled out.

## (c) The time limits X (d) runs under

| Call | Budget | `--test-timeout-secs` | 5 s virtual Sleep, alpha.2 | 5 s virtual Sleep, edge |
|---|---|---|---|---|
| Baseline | `BASELINE_TIMEOUT_DEFAULT` = 120 000 ms (the leg sets no `baselineTimeoutMs`) | 120 | under: alpha.2 does not count Sleep at all (r6, measured) | under: 5 ≪ 120 |
| Mutant (and the reproduce call) | `max(2 × baseline duration, MIN_MUTANT_BUDGET_MS)` (`budgetOf`, `orchestrator.ts`); the baseline durations are about 0 ms on a virtual clock, so the floor 180 000 ms decides; F5 takes the codeunit's largest ref budget | 180 | under | under: 5 ≪ 180 |
| Wall bound of one call | `v3CallDeadlineMs` = 10 × stop × tests-in-codeunit + 90 s | — | not reached: virtual | not reached: virtual |

The 180 s figure is **from code**, not printed by the leg. A 5 s Sleep also stays under LethAL's budgets on BC
(case 2, **measured**: 5095 ms under 120 s), so the probe is green under the same budget on every build measured.

**What X (d) now proves, stated plainly (M1).**
- **With `Sleep(600000)` on BC:** case 3 shows the BASELINE does not finish under LethAL's 120 s budget. So
  `SleeperDoubles` is not green, it covers nothing, and no X (d) mutant is scored on BC at all.
- **With `Sleep(5000)` on BC:** the baseline is green, and M0003 and M0004 would read `survived` (the test waits 5 s
  and passes; `Waited` is unused). This is **inferred** from case 2, which measured a Sleep in a test body, not in a
  called codeunit.
- **On v3:** M0003 and M0004 still read `error` by §6.
- So X (d) is a control that the §6 rule FIRES on a covered Sleep hit, which is all r5 asks of it. It is not, and never
  was, a comparison with BC's verdicts. `error` is the fail-closed direction.

## (d) Predictions

"Measured" means a run showed it. "Inferred" means it comes from code, another LethAL head or another build. "The
R-649 head" below always means the merged head of (d4) step 0.

### (d1) `itest:alrunner-v3` on alpha.2 (`alrunner 3.0.0-alpha.2 (91253f2d6)`) at the R-649 head

| Leg | Prediction | Basis |
|---|---|---|
| C, S1, S3, N1, D1, D1c, T | `pass`, every figure as r10 (e) | **Measured** at 77877316; r11 touches no file these legs read. R652's own gates passed these legs on its merged head (R652's addendum 1) |
| X (b), (c1)-(c5) | as r10 (e) | **Measured** |
| X (d) | r5's table unchanged: M0001 killed by SleeperDoubles, M0002 survived, M0003 `error` §6 at :25, M0004 `error` §6 at :37, M0005 killed; hits M0003 `[[25,1]]`, M0004 `[[37,1]]`, M0005 `[[31,1]]`, M0001 and M0002 `[]`; index 4 + 5 | Verdicts and hits **measured** at 77877316 with `Sleep(600000)`. Same with `Sleep(5000)`: **inferred** (alpha.2 Sleep is instant whatever the argument) |
| X (d), r10's lines | `SleeperDoubles baseline-batch-finished: pass`, `baselineGreen true`, each mutant's `coveringTests` `["…SleeperDoubles"]`, `stop 120 s` | **Measured** at 77877316 (pass, true); coveringTests **inferred** |
| X (e), (f1)-(f3) | fail closed, 0 survived, as before | **Measured** at 77877316 |

### (d2) `--regate <R-649 head>` on alpha.2

`pass` on all eight legs, as (d1). On pass, `.gated` takes the R-649 head. **Inferred** from (d1).
`--edge-rejudge` re-gates at `.gated`'s commit, so this MUST run first.

### (d3) `--edge-rejudge 57f1e4f98` at the R-649 head

The binary is the kept `failed/edge-57f1e4f98@de8f43e2…/al-runner`, `al-runner 3.0.0-alpha.4+edge.20261022
(57f1e4f98)`, sha256 `0642f9b2…8720`.

| Leg | Prediction | Basis |
|---|---|---|
| C | `gate-fail`: `refusal-row-shape` reads `unlike-bc` (#5700). Held lines for `none-selected-exit`, `quoted-name-unselectable`, `refusal-cascade`, `sleep-is-noop`, `upstream-compile-errors` (`gone`) and `duplicate-key-insert-raises` (`refused`); `serve-keep-reasons` `diverged` (warn) | **Measured** at 711c94d9 and 77877316 |
| S1 | `pass`, 3 / 12 / 4 over 19, index 0 + 0 | **Measured** |
| S3 | `pass` | **Measured** |
| N1 | `pass`, 36 / 0 / 0 | **Measured** |
| X (b) | its held line, `exit 3 passed 0 notRun 0: v3 now refuses the broken target (#5602 fixed)` | **Measured** at 77877316 |
| X (c1)-(c5) | `AlRunnerV3UnprovenBatchError; spawns 0` each | **Measured** at 77877316 |
| X (d) | **passes its checks:** r5's table and hits as in (d1); index 4 + 5; no ProbeSleep test in `unsupportedTests` | **Inferred.** No mutant call has been made on edge. (b)'s calibration (**measured**) rules out the two named failure modes: a missing per-test entry, and zero hits |
| X (d), r10's lines | `SleeperDoubles baseline-batch-finished: pass`; `baselineGreen false` (the three 600 s siblings are `timeout` rows); each mutant's `coveringTests` names SleeperDoubles; no "not green at baseline" text | The rows are **measured** offline in (b)'s calibration (SleeperDoubles pass; the three siblings error, notRun, "Test exceeded 120s timeout."). Through the session: **inferred** |
| X (e), (f1)-(f3) | fail closed, 0 survived. These run on edge for the FIRST time (before, (d) stopped the leg) | **Inferred** |
| **X, the leg** | **`held`, not `pass`:** (b)'s held line makes `xbHeldFirst` throw `V3LegHeld` once (c)-(f) pass | **From code** (`xbHeldFirst`, `al-runner-v3-gate.ts`) |
| D1 | `pass`, 51 / 12 / 0 over 63, index 3 + 0 | **Measured** |
| D1c | `pass`, 51 / 8 / 4 over 63, index 3 + 0 | **Measured** |
| T | **`held`**: 290 / 50 / 59, errors 7, over 406; exactly 7 lines `T: held: <code> <key>: survived/-/- -> error/runner-refused/- …` for M0157, M0158, M0159, M0161, M0162, M0163, M0164; no `gate-fail` line | **Measured** at 77877316 (`leg T: HELD`, the 7 codes by name) |

**Overall: `gate-fail`, from leg C ONLY** (X held, T held). The result goes to
`failed/edge-57f1e4f98@<R-649 head>/`, with a copy in `rejudge/edge-57f1e4f98@<R-649 head>/`. `current` does not move.
Nothing under the earlier `failed/` or `rejudge/` folders changes. Any difference from this table is reported, never
re-recorded. If X (d) still reads `no-coverage`, or SleeperDoubles reads `timeout`, that goes against (b)'s measured
calibration: report it as a finding, and do not edit r11.

### (d4) The order of the runs, and the newest edge build

**Step 0 (I1): merge first.** `lethal/r649` (25072109) was behind origin/master. Master carries R652 (merged at
e919379c), which changes the §6 path that X (d) exercises:
- `assertBound` now runs once before each request is SENT, not on every `run()`;
- `sleepPassRefusal`'s note gains `withWindowCaveat` on WINDOWED calls.

**Step 0 is DONE.** `lethal/r649` carries origin/master 4e8d9f38, merged as a `[skip ci]` merge:
`d7a1b9c0740250b8378a531b093f9f46725a1d94`. The R-649 code commits go on top of it; the R-649 head that steps (1)-(4)
run on is the FULL sha of the branch head that carries the r11 change, named in every log line and in R649's status.
If anything else merges into `lethal/r649` later, steps (1)-(3) are repeated on the new sha.

**R652's window caveat leaves X (d)'s checks unchanged.** X (d) runs under the default one-shot transport, which is
never windowed. So the caveat is never added, and the note still starts `[v3-sleep-noop] covered Sleep at` and names
`ProbeSleeper.Codeunit.al:25:` (M0003) and `:37:` (M0004), as the leg checks. **From code**, per the review.

**The two edge paths are different:**
- `--edge-rejudge <sha>` re-judges a binary ALREADY KEPT under `failed/` or `held/`, custody-checked by sha256, at
  `.gated`'s commit. It never downloads and never reads or writes `edge.last-seen`. It refuses a sha already judged at
  that commit.
- `--edge` asks for edge's CURRENT commit. If it equals `edge.last-seen` (now `57f1e4f98`) it is a no-op. If it is
  newer, it downloads that build and gates it at `.gated`'s commit, then writes `edge.last-seen` (except on
  infra-fail). Its `gate-fail` is final for that sha at that commit (`failed/`); to judge it again later needs a new
  `--regate` commit first, then `--edge-rejudge`.

**So, in order, at the R-649 head:** (0) merge origin/master; (1) `itest:alrunner-v3`; (2) `--regate <head>`;
(3) `--edge-rejudge 57f1e4f98`; (4) `--edge`. Steps (2)-(4) each hold the one gate lock, so they run one after
another. `--regate`, `--edge` and `--edge-rejudge` are skipped for the day with 3 or more other heavy jobs, or under
10 GB free.

**Prediction for (4): none is pre-committed for a new sha.** Its build is not known. If edge has moved past
`57f1e4f98`, step (4) is the orchestrator's "rejudge on the newest edge". Its log is read leg by leg against (d3), and
each difference is a finding: a re-pre-commit, never a re-record. If edge has not moved, step (4) logs `no-op`, and (3)
already is the newest edge.

## (e) Tests (pre-committed, coded after r11 is committed)

Each test goes red on its own single revert, and each guard has a red test for EACH direction. Red logs go to
`/coord/handoff/R-649/red-unit/`. All live in `packages/runner/tests/r586-gate.test.ts`.

- **X-r11a, the literal.** Read `scripts/r586-probe/extras/ProbeSleeper.Codeunit.al`. `sleepCallLines` returns exactly
  `[12]`; line 12 matches `^\s*Sleep\((\d+)\);$`; the number is 5000; and 5000 < `BASELINE_TIMEOUT_DEFAULT` and
  5000 < `MIN_MUTANT_BUDGET_MS`.
  - Red on reverting the literal to 600000 (the value, and the budget comparisons).
  - Red on adding a line above the Sleep, for example a sixth header comment line (the `[12]`).
- **X-r11c, the instrumented lines and the index (replaces X-r11b, M3).** The `gap-pins.test.ts` pattern, no v3. It
  builds the SAME scratch dirs `legXSleep` builds:
  - the target: a temp copy of `probe-app`, with `extras/ProbeSleeper.Codeunit.al` added and `ProbePair.Codeunit.al`
    removed;
  - the tests: a temp copy of `probe-tests`, with `extras/ProbeSleep.Codeunit.al` added, and
    `ProbeCoverage.Codeunit.al` and `ProbePermissions.Codeunit.al` removed.

  Then `generateMutationSet` narrowed to `src/ProbeSleeper.Codeunit.al` (as the itest's `only`), then
  `writeInstrumentedProject`. It asserts:
  - 5 mutants, with r5's operator-to-code map;
  - `sleepCallLines` of the instrumented `ProbeSleeper.Codeunit.al` is `[25, 31, 37, 43]`, and the manifest puts
    M0003's arm at 25, M0005's at 31 and M0004's at 37;
  - `buildSleepIndex(<instrumented dir>, <scratch test dir>)` has `sizes` equal to `{ target: 4, test: 5 }`, the very
    check the leg makes through `sleepIndexSize()`.

  Notes:
  - The builder first confirms that `runSession` instruments through `writeInstrumentedProject` with the same inputs.
    If not, the test drives the path `runSession` uses.
  - Red on adding a line to the source above line 12 (25 becomes 26).
  - Red on removing one sibling's Sleep from the scratch test dir (test 5 becomes 4).
  - It is NOT red on changing the literal. That is its job: it pins "the literal moves no line and no index entry".
- No verdict test changes. r10's X-c1 and X-b1, T-a*, T-b* and T1-T5 stay as they are.

## (f) Figures and files that move

- `scripts/r586-probe/extras/ProbeSleeper.Codeunit.al`: line 12, `Sleep(600000);` → `Sleep(5000);`. **This is the
  only literal.** Lines 1-5, the header comment, are reworded as in (a), and stay 5 lines.
- No index size, count, fact, baseline file or pre-committed figure changes. No baseline is re-recorded.
- `packages/runner/itest/al-runner-v3.itest.ts`: no logic change. Its comment above the unsupported check ("r6 (c):
  v3's virtual clock makes LongSleepThenAssert PASS, so the baseline is green") is reworded to r11 (b): on edge the
  three 600 s siblings are timeout rows; no ProbeSleep test is unsupported on either build.
- `docs/gates/alrunner-v3.md`:
  - add r11 to the list of pre-commitments;
  - in the X (d) bullet, say that since r11 the Sleeper sleeps 5 s (BC's case 2 is the oracle that 5 s is green under
    the budget), that the r5 table is the only pass on alpha.2 AND edge, and that on edge the leg reads `held` through
    (b);
  - add a history line.
- `docs/roadmap/R649.md`: `status: "done (<commit>)"` in the submitted branch, after (d1), (d2) and (d3) ran at that
  merged commit with the predicted readings; name r11 and the bc2 reading as how it closed. Then
  `bun scripts/roadmap-index.ts`.
- `docs/roadmap/R658.md`: unchanged (open). It is BC's behaviour after an abandoned baseline, which r11 does not
  touch; r11 only stops the GATE from needing a 600 s baseline.
- `docs/roadmap/R647.md`: unchanged (done).
- Leg C's inline `SLEEPER_AL` / `SLEEP_TESTS_AL` (`al-runner-v3-contract.ts`): unchanged. (Its doc comment calls
  `SLEEPER_AL` "`extras/ProbeSleeper.Codeunit.al`", but it was already a different copy, without `Waited`. Not r11's.)
