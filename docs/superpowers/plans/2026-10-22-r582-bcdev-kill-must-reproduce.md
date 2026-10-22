# R-582 plan r3: switch "a kill must reproduce" (R577) on for bcdev

## Changes from r2 (delta review `/coord/handoff/R-582/review-plan-r2-delta.md`)
- **F1:** U5's collision direction now checks the OLDER run. Run 1 kills M0002 with 2 rows, run 2 kills
  M0002 with 1 row, and the test checks run 1. `killerRows` has no ORDER BY and its Map keeps the last
  write, so only this setup goes red when the filter is dropped. The size direction stays. Both
  directions are red-checked (§6 U5).
- **F2:** the chunked filter keeps the re-runs' rows instead of dropping them. For each of the 5 warm
  kills, the re-run's method list must EQUAL its replay list, in order. Red check: change
  `reproduceKill`'s `methods: step.chunkPrefix` to the full ordered prefix (§4.5, §6 U7). This is an
  asserted figure in the pre-commitment.
- **F3:** hang's single allowed rerun is tightened (§5, §7.2).
- **M-c:** `envtool.itest.ts` gets the `killReproductionFailures` call and its own `REPRODUCTION_EXPECTED`
  row, so the owner's run does not fail on an unknown leg. Envtool stays UNMEASURED (§4.13).
- **M-d:** U2c gets a red check for the warm direction. U6 also fails on three timeout rows, and it
  selects rows with `method = killingTest` (§6).
- M-a and M-b are pre-commitment fixes (see `precommitment.md`). No prediction changed.

(r2 text follows, edited in place where the items above apply.)

Planner: lethal-bugs (opus, read-only). r1 2026-10-22 on master 8a2c174f; r2 the same day, after the
deep review `/coord/handoff/R-582/review-plan-opus.md` (ADOPT with fixes) and the lane's correction on
CLAUDE.md. The pre-commitment draft is `/coord/handoff/R-582/precommitment.md` (not committed). Every
current figure comes from the `docs/gates/` pages and the committed baselines, never from CLAUDE.md.

## Changes from r1

- **I1, `killerRows` takes a REQUIRED `runId`** (§6 U5). The main reason is not testapp but bcdev and
  tables: both open the fixture's own persistent store (`fixtures/sandbox-app/lethal.sqlite`,
  `fixtures/sandbox-data/lethal.sqlite`), which holds older runs with pre-R582 kills (1 killer row) and
  kills of mutants that are not killed now. Without the filter:
  - an old row can win a `<batch>/<code>` key, giving a false "expected 2, measured 1";
  - an old kill adds a key, so the size check fails.
  Every call site passes the run id, the al-runner ones too. The red test uses two runs whose kill sets
  differ.
- **I2, chunked `callSizes` filters out re-runs** (§4.5, §6 U7). Once a mutant's first replay row has
  been seen, its later mutated `many` rows are ignored. Red-checked.
- **I3, the resume cost said plainly** (§3, §8.1). Resuming a pre-R582 bcdev run re-executes every kill,
  so it republishes and re-baselines nearly every batch: close to a full rerun. This goes in R582's close
  and in a CHANGELOG entry.
- **I4, B2 kept with both costs named** (§5):
  - one more full budget per timeout kill;
  - a second stop whose outcome may be unconfirmable, which scores `error`, not `timeout-killed`.
  Both go in R582's close and in R577.md's Known limits.
- **I5, `bun install --frozen-lockfile` before the native parser build,** in the build worktree and in
  each gate worktree (§6, §7.2).
- **Minors:**
  - **M1:** U2 is cut to the one test that is new on bcdev (the `group-call` EVENT count). U3 is stated
    as a wiring test with no revert target, and its red direction is named (§6).
  - **M2:** the full list of prose to update (§8.1).
  - **M3:** `HANG_FIGURES.stoppedCallsOn` is pinned as 6 and named in `hang.md`'s figure block, which
    `gate-pages.test.ts` requires.
  - **M4:** verify's own kills are not evidenced live (§4.8, §4.9).
  - **M5:** `servers.md` records each moved figure only on the server it ran on (§8.1).
  - **M6:** live times raised by about 30% (§7.2, §8.2).
  - **M7:** heavy jobs. CLAUDE.md says a BC gate against a bc server does NOT count toward the
    two-heavy-job limit (§7.2).
  - **M8 and M9:** the close names R592's bcdev-to-v2 lending gap, and the committed-state alternation
    the rule cannot catch (§3, §8.1).
- **The open questions** are answered as the reviewer ruled (§8.3). Q4 pins 6; Q5 filters.
- **r1's Q3 (CLAUDE.md figures) is WITHDRAWN** (lane correction). Master's CLAUDE.md is R-592's version
  (since 25f55581): it holds no gate figures and points to `docs/gates/`. R582 edits only:
  - the `docs/gates/<gate>.md` pages;
  - `packages/runner/itest/gate-expected.ts` and the itest literals.
  `gate-pages.test.ts` pins all of them. There is nothing for the owner.

## Delta for the reviewer

Read these sections; the rest is r1 unchanged. No prediction changed: every figure in the
pre-commitment equals r1's.
- §3: the I3 cost paragraph and the M8 lending note.
- §4.5 (the chunked `callSizes` filter), §4.6 (`stoppedCallsOn` 6 in the block), §4.8 and §4.9 (the M4
  gap).
- §5: the two named costs.
- §6:
  - U2 trimmed to U2c only;
  - U3 reworded as a wiring test;
  - U5 rebuilt (required `runId`, two runs with different kill sets, both failure modes);
  - U7 new (the chunked filter).
- §7.2: `bun install --frozen-lockfile`, the heavy-job sentence, new wall times.
- §8.1: the prose list, with no CLAUDE.md edit. §8.2: cost. §8.3: the rulings, with Q3 withdrawn.

---

Words used here:
- **cold kill:** a kill at `killPosition` 1. Its confirm is one unmutated `RunMutant` call.
- **warm kill:** a kill at `killPosition` k > 1 inside a `RunMutantMany` call. Its confirm replays methods
  1..k unmutated in one more `RunMutantMany` (R206).
- **re-run** (R577 calls it a "reproduction"): one more run of the killing test UNDER the mutant, after
  the confirm passed.

## 0. Summary

- **The change is one line:** `readonly killsMustReproduce = true;` on `BcDevMcpBackend`. The rule, the
  carry filter, the store column and the report fields all exist since R577. No control-app, AL, schema
  or report change.
- **Call shape on bcdev:**
  - **cold kill** (k = 1, on the grouped path too): ONE single `RunMutant` (`singleStep`, op_kind
    `single`). It emits no `group-call` event, so `groupedCalls` does not move.
  - **warm kill:** ONE `RunMutantMany` over the call's own prefix 1..k, with the mutant active and no
    `confirmation` flag. That is +1 `groupedCalls` per warm kill.
  - **timeout kill:** re-run too (R577 ruling B2), at the budget the first run was SENT, through
    `StopHungRunAt`.
- **Verdicts and killing tests are unchanged on every gate,** per mutant. Any verdict move, including any
  `kill-not-reproduced`, is a BLOCK.
- **Moved figures:**
  - tables `groupedCalls` 399 -> 414;
  - chunked 33 -> 42 (control leg) and 57 -> 62 (chunked leg);
  - hang ON `groupedCalls` 42 -> 46, and its distinct-session check 37 -> 40 (6 stopped calls, pinned).
  - bcdev stays at 15.
- **No baseline file is re-recorded** (reviewer, Q2). Every `*.baseline.json` holds only key, verdict,
  killingTest, coverageFiltered, errorClass and mutatedTextSha256, which is exactly what
  `mutant-equality.ts` compares. The moved figures live in `gate-expected.ts` and in itest code.
- **Cost:** about +0.5 s per fail kill, and one more budget per timeout kill. Expected wall times:
  - tables ~464 s -> ~650-700 s;
  - verify-scale ~865 s -> ~1350 s;
  - hang ~630 s -> ~900 s.

## 1. The change

### 1.1 The switch
- `bcdev-backend.ts`: add `readonly killsMustReproduce = true;`, with a doc line naming R582.
- `backend.ts`, the doc comment on the flag: "al-runner, al-runner-v3 and bcdev set it".

### 1.2 Where the re-run happens on bcdev

| Path | First run | Confirm | Re-run (new on bcdev) | group-call events added |
|---|---|---|---|---|
| sequential, fail at k = 1 | `RunMutant` | `RunMutant`, no mutant | `RunMutant`, mutant m, same budget | 0 |
| grouped, fail at position 1 | `RunMutantMany` | `RunMutant`, no mutant | `RunMutant` (single), mutant m | 0 |
| grouped, fail at k > 1 | `RunMutantMany` | `RunMutantMany` 1..k, `confirmation: true` | `RunMutantMany` 1..k, mutant m, no flag | +1 |
| chunked | as grouped; k and the prefix are the CHUNK's | as grouped | as grouped, over the chunk's prefix | +1 per warm kill |
| timeout at k = 1 (`--stop-hung-sessions`) | stopped by `StopHungRunAt` | `RunMutant`, no mutant, `max(budget, fallback)` | `RunMutant`, mutant m, the SENT budget, stop hook wired | 0 |
| timeout at k > 1 | `RunMutantMany`, stopped | `RunMutantMany` 1..k unmutated | `RunMutantMany` 1..k, mutant m, `stopHungSessions` | +1 |

What holds on bcdev:
- **Activation.** `reproduceKill` calls `activateOnce(m)` first. bcdev's `activate()` is bookkeeping only;
  the request carries the mutant id. Without the re-activation:
  - at k > 1, `runMany` throws ("no mutant is pending");
  - at k = 1, the run goes out with `""` (no mutant) and passes.
- **Control-app call shape:** unchanged. Coverage is `none` on every re-run, so bcdev's guard "a
  fenced-coverage run is a baseline" is never reached. A hub leg's mutant runs also go through
  `RunMutant`.
- **Fence and lease:** each re-run is one more fenced operation (a new attempt id, the next opSeq) under
  the session lease, with the usual lost-ack reconciliation and one retry. If the lease is lost before
  the re-run, `classifyNonVerdictStep` latches it: `error`, never `killed`.
- **Session reuse (R206):** every call to a container gets a fresh session. A re-run in a reused session
  scores `session-reused`, never a kill (R577 T8c). This can happen on hosted environments only.
- **`killPosition` and `warmKills`:** unchanged; both come from the first run and the confirm.
- **`StopHungRunAt`:** a single re-run carries the R53 stop hook (a mutant is pending and the flag is
  on). A `RunMutantMany` re-run sends `stopHungSessions`. So a re-run timeout ends with BC's own 408 and
  its stop text, like the first one.
- **R121's assertion screen and `platformArtifactKills`:** both read the FIRST run's
  `killingTestFailure`; unchanged.
- **R197's kill ledger:** learns a kill only after the re-run. When every kill repeats, the test order
  and every `killingTest` stay the same.
- **Reach (GH-24):** re-run rows feed only the attestation ledger, never `reachedBy` or `guardObserved`.
- **`spent` and the R515/R516 budgets:** not fed by re-runs.
- **`workers > 1`** is refused on bcdev, so a re-run never crosses workers.

### 1.3 Nothing else changes
- No change to `orchestrator.ts`, `resume.ts`, `store.ts`, the `report.ts` types, `events.ts`, the
  schemas or the control app.
- `verify.ts` maps `kill-not-reproduced` through its existing `error` branch.
  `VERIFY_SCHEMA_VERSION` stays.

## 2. What a kill that does not repeat becomes on bcdev

R577's rule, unchanged:
- **`error` with cause `kill-not-reproduced`** (R577's note) when the re-run passes, answers the other
  kind (a fail for a timeout kill or the reverse), or an earlier prefix method fails first. The covering
  loop goes on, and a later test that kills and repeats still scores `killed`.
- **Its own cause** when the re-run is lost, hits our deadline, strands the tier or runs in a reused
  session.
- **`warm-confirmation-incomplete`** when the re-run hits the server's cap.
- **Never `survived`.** Nothing else moves.

## 3. The carry rule across the switch

- **Mechanism:** `buildResumeIndex(rows, stopHungSessions, killsMustReproduce)` reads
  `cfg.backend.killsMustReproduce`. It is the one call site for both `--resume` and `--resume-run`. Once
  bcdev declares the flag, a stored bcdev kill without `kill_reproduced = 1` is re-executed and counted
  in `unreproducedKills`.
- **History (I3):** every pre-R582 bcdev run has `kill_reproduced` NULL. So:
  - **resuming a run recorded on bcdev before R582 re-executes every kill;**
  - any batch with a kill left to run is published and baselined again, unless a baseline snapshot
    applies;
  - the resume is close to a full rerun, so start a fresh run instead.
  This only ever removes carried verdicts, the safe direction. It goes in R582's close and in a CHANGELOG
  entry.
- **`--skip-known-survivors` (history):** reads survivors only; unchanged.
- **Baseline snapshots (R192):** hold unmutated rows only; unchanged.
- **R-586's `runMayLend`:** a run-level check, and it runs first. R577's row filter runs after it, only on
  the rows of a run that was lent. Neither re-admits what the other removed.
- **R-389's pending identity:** affects snapshots only; no interaction.
- **Campaign compare and freeze:** compare verdicts per mutant. A kill that became `kill-not-reproduced`
  is a mismatch, which is correct. Old frozen bcdev stages still compare.
- **M8, R592:** `backendBuildRefusal` still lends between bcdev and v2 al-runner (R592's gap). After R582
  both backends write the marker, so marked kills lend in both directions. That is consistent, but R592
  must be read with it; the close names it.
- **R618 stays open:** no BC gate resumes, so the carry path is still untested live on BC.

## 4. Per-gate predictions

The full table, with servers and queues, is in `precommitment.md`.

**Common to every orchestrator-driven gate:**
- **(a)** every mutant's verdict, `killingTest`, `errorClass`, `coverageFiltered` and
  `mutatedTextSha256` equal its baseline or pre-committed table.
- **(c)** every kill has `killReproduced: true`, and no mutant is `kill-not-reproduced`.
- **(c)** exactly **2** mutated `test_results` rows for the killing test in THIS run: the first run and
  the re-run. Every BC test app is one codeunit with no repeated method name (checked), so the count
  cannot pick up a second test.
- **(d)** no baseline is re-recorded, and `warmKills` and every `killPosition` stay the same.

**Derivation:**
- `groupedCalls` counts `group-call` events. Only `runFencedMany`'s `once()` emits one.
- A cold re-run goes through `singleStep` and emits none. A warm re-run emits one. So new `groupedCalls`
  = old `groupedCalls` + warm kills.
- Distinct grouped session ids gain one answering call per warm FAIL kill.
- A warm TIMEOUT re-run is a stopped call. It records only the killer's timeout row, which the
  pass/fail filter excludes, so it adds no session id.

### 4.1 itest:bcdev (3 / 12 / 4)
- `groupedCalls` **15, unchanged**: the 3 kills are cold, so their re-runs are single calls.
- `warmKills` 0, `killPosition` 1, zero `session-reused`.
- `manyDistinct` (distinct grouped session ids) stays 15. Each run gains 3 single rows, all with distinct
  session ids.
- The assertion screen stays `vacuous`. Both runs and the determinism check are unchanged.

### 4.2 itest:bcdev-wrapped (60 / 38)
- No counter is asserted.
- Each leg (fenced, hub) adds 60 single re-runs. Fenced still equals hub per mutant.

### 4.3 itest:bcdev-names (36 killed)
- No counter is asserted.
- 36 re-runs, using the same `RunMutant` request shape as the cold confirm, so name resolution cannot
  newly fail.

### 4.4 itest:tables (314 / 70 / 22)
- **`groupedCalls` 399 -> 414** = 314 + 70 scored + 15 replays + 15 re-runs (`384 + 15 + 15`).
- Unchanged:
  - `warmKills` 15 and the five pinned positions (M0179 5, M0183 4, M0175 2, M0005 3, M0009 3);
  - `platformArtifactKills` 4, the screen `partial`, `untargetedTriggerCount` 0;
  - the one refused baseline test, `declarativeSites`, `notInstrumented`, the twin pairs and the reach
    control.
- `manyDistinct` 414 (0 stopped calls). Each run gains 299 single rows.
- **Named risk:** some tests commit. They start with a durable clean start (`DeleteMain` + `Commit()`),
  so they are predicted to repeat. A `kill-not-reproduced` there is a BLOCK.

### 4.5 itest:chunked (no baseline)
- **Control leg:** `groupedCalls` **33 -> 42** (24 scored + 9 replays + 9 re-runs). `warmKills` 9. The
  position histogram stays {1: 8, 2: 3, 3: 3, 4: 2, 5: 1}.
- **Chunked leg:** `groupedCalls` **57 -> 62** (52 covering calls + 5 replays + 5 re-runs). `warmKills` 5.
  The five warm kills stay at chunk position 2, the four `nowCold` kills at position 1.
- The replay lists (rows with `mutant_code IS NULL`) are unchanged; M0015's control replay is still 4
  methods.
- **The `callSizes` filter (I2, F2):** in `runLeg`, once a mutant's first replay row
  (`mutant_code IS NULL`) has been seen, that mutant's later mutated rows are collected as its
  `reruns` list rather than as covering calls.
  - On this fixture the re-run is the only mutated call after the confirm, so the split is exact.
  - Without it, "some mutant took more than one call" could pass on re-runs alone.
  - **F2 check:** for each of the 5 warm kills in `CHUNKED.warm`, `reruns` must EQUAL the replay list
    (the same methods in the same order, the chunk's 2 methods). Every cold kill has no `many` re-run.
    Without this check a re-run over the full ordered prefix would pass every other assertion.
  - A comment in the code says why.

### 4.6 itest:hang (`hang.single.baseline.json`, 24 / 9 / 5 timeout-killed)
- **ON leg:**
  - `groupedCalls` **42 -> 46** = 38 scored + 4 replays + 4 re-runs. The itest formula becomes
    `scored + 2 x warmKills`.
  - **`manyDistinct` 37 -> 40** = 46 - **6** stopped calls: the 5 first timeouts plus line 145's re-run.
  - Pinned as `HANG_FIGURES.stoppedCallsOn: 6`, a number that is never read back from the report, and
    named in `hang.md`'s block. A cross-check that 6 equals `timeoutKilled.length` plus the warm timeout
    kills is optional.
  - Unchanged: `warmKills` 4, `coldConfirmsOn` 4, every pinned position, and the checks on the first
    timeout row.
  - **New check:** each `timeout-killed` mutant has exactly 2 mutated `timeout` rows for its killer. Both
    carry "stopped the session" and "StopSession", with durations in [20 000, 50 000) ms. The second row
    is `single` for lines 37, 43, 44 and 73, and `many` for line 145.
- **SINGLE leg:** `groupedCalls` 0, `warmKills` 0, `coldConfirmsSingle` 5. Five single timeout re-runs,
  with the same 2-row check.
- **OFF leg:** no `timeout-killed`. Its 1 kill before the quarantine (M0001) is re-run. Every OFF
  assertion holds.

### 4.7 itest:harden (16 / 5)
Nothing pinned moves. Leg A's 16 and leg B's 20 kills are re-run. S5 still survives.

### 4.8 itest:agreement
- A 16 / 5 / 0 and B 20 / 1 / 0 per mutant.
- `publishes === 1`, K5 and the stability runs (all unmutated) are unchanged.
- Step 6 (verify faster than B) widens: verify adds 4 re-runs against B's 20.
- **Gap (M4):** verify's 4 kills go through the same loop, but `VerifyResult` has no `killReproduced`, so
  no gate shows that they repeated. Stated, not fixed (Q7).

### 4.9 itest:verify
- Step 1: 3 / 12 / 4 per mutant; the gaps are unchanged.
- Step 3: ClampPercent is killed (its re-run is not evidenced, see M4), LogAudit survives, exit 5.
- Steps 4 to 6 are unchanged; the ratio is printed only.

### 4.10 itest:verify-scale (measurement mode)
- Run A: 314 / 70 / 22 per verdict.
- V1 to V3 run survivors only, so there is no re-run.
- B1 and B2 each add 314 re-runs.
- Nothing timed is asserted; the printed ratios fall.

### 4.11 itest:testapp
- Step 1: 3 / 12 / 4 per mutant.
- The named kill `OverBudgetDetected` is re-run, asserted on the outcome's `killReproduced`. The survivor
  survives. The marker's baseline rows are unchanged.

### 4.12 itest:stale-publish and itest:lease
They drive the transport and `LeaseClient` directly, so nothing moves. Run them anyway: the proof table
is per server.

### 4.13 itest:envtool
- Host-only. The rule applies there too; it stays UNMEASURED until the owner runs it.
- **M-c:** `envtool.itest.ts` gets one `killReproductionFailures("envtool", report, store, runId)` call.
  `REPRODUCTION_EXPECTED` gets an `envtool` row with `killerRowsPerKill: 2`, so the owner's run checks the
  marker instead of failing on an unknown leg.
- A re-run on a hosted environment can come back `session-reused` (Q8).
- Named on `envtool.md` and in the close.

## 5. The hang gate and timeout re-runs

- **The ruling is kept** (B2, reviewer Q1). A server stall during the mutated run produces exactly a false
  timeout kill, and splitting the shared rule per backend would cost more than it saves.
- **Two costs, named (I4):**
  1. **One more full budget per timeout kill,** `max(2 x duration, floor)`. On a slow real suite that is
     minutes, not 20 s.
  2. **A second `StopHungRunAt` stop per re-run,** with the R202/R-204b risk of an unconfirmed outcome or
     a lost acknowledgement. Under R577 that scores `error` (`stop-outcome-unconfirmed` and similar
     causes), not `timeout-killed`, so a real hang can now end as `error`.
  Both go into R582's close and R577.md's Known limits. On the next real BC campaign, count
  `stop-outcome-unconfirmed` against `timeout-killed`.
- **On this gate:**
  - ON and SINGLE each add 5 timeout re-runs of about 20-25 s, plus short fail re-runs.
  - Wall time goes from about 630 s to about 900 s, not double.
  - This is the first live proof of R577's timeout half.
- **The one allowed rerun (F3).** It applies only to `itest:hang`, and only when ALL of these hold in the
  failed attempt:
  1. the cause is `stop-outcome-unconfirmed`, on one mutant;
  2. every other mutant equals its prediction (verdict and `killingTest`);
  3. the only failed assertions are the ones that mutant causes: on the ON leg `counts.errors` 0, the
     `groupedCalls` and `manyDistinct` formulas and its 2-row check; on the SINGLE leg the
     zero-`stop-outcome-unconfirmed` assertion.
  - At most ONE rerun per queue. A second `stop-outcome-unconfirmed` is a BLOCK.
  - Any other non-verdict cause on a re-run (a lost ack, `deadline-exceeded`, `stranded`) is a BLOCK,
    not a rerun.
  - Keep both logs. The failed attempt counts in I4's tally of `stop-outcome-unconfirmed` against
    `timeout-killed`.

## 6. Test-first unit tests

Red-check each test: revert the named line (with the Edit tool, never a script), confirm the named test
goes red, then restore. Use the `mutation-red-checker` subagent.

1. **U1, bcdev declares the flag** (`tests/bcdev-backend.test.ts`):
   - replace "stays OFF on bcdev until R582" with `expect(makeBackend(...).killsMustReproduce).toBe(true)`.
   - **Red:** delete the line in `bcdev-backend.ts`.
2. **U2c, the counter the gates read** (`tests/orchestrator.test.ts`):
   - on the grouped path with the rule on, a kill at position 1 is re-run with no `group-call` EVENT
     (count the emitted events);
   - a warm kill at k = 2 adds exactly one event.
   - **Red (cold direction):** route the k = 1 re-run through `runFencedMany`; the event count goes up
     by 1.
   - **Red (warm direction, M-d):** drop the k > 1 re-run, by making `reproduce()` resolve `undefined`
     for k > 1; the event count goes down by 1.
   - r1's U2a, U2b and U2d are dropped: R577's T1/T2, T5 and T10b already pin them, and U1 pins the flag.
3. **U3, a wiring test with no revert target** (`tests/bcdev-backend.test.ts`, the `HookSpyTransport`
   pattern):
   - `activate(m)`, `run`, `activate(null)`, `run`, `activate(m)`, `run` sends mutant ids `[m, "", m]`
     and stop hooks `[true, false, true]`;
   - `activate(null)`, `runMany({confirmation: true})`, `activate(m)`, `runMany({})` is accepted and
     sends m with `stopHungSessions`.
   - It changes no production line, so it has no red check of its own. The red direction for "the re-run
     carries m" is R577's T6/T7 (delete `activateOnce(m)` in `reproduceKill`).
   - Keep it only if the reviewer wants the bcdev wiring pinned; otherwise drop it.
4. **U4, carry from a real pre-R582 bcdev run row** (`tests/resume.test.ts`):
   - a run with backend `bcdev`, holding two `killed` rows with `kill_reproduced` NULL and one `survived`
     row;
   - resume with the flag taken from `BcDevMcpBackend`: the 2 kills are re-executed (`unreproducedKills`
     2, with R577's warning text) and the survivor is carried.
   - **Red:** set the flag false; the kills are carried.
   - **Second direction:** a row with `kill_reproduced` 1 is carried. **Red:** drop the column read.
5. **U5, `killerRows` with a REQUIRED `runId`** (`tests/itest-kill-reproduction.test.ts`):
   - the signatures become `killerRows(store, runId)` and
     `killReproductionFailures(leg, report, store, runId, ...)`. Every call site passes the run id,
     including the two in `al-runner.itest.ts`.
   - **size direction:** a store with TWO runs whose kill sets DIFFER: run 1 kills M0001 with 1 killer
     row, run 2 kills M0002 with 2 rows. Checking run 2 passes. **Red (drop the filter):** 2 keys for 1
     kill, so the size check fails.
   - **collision direction (F1):** run 1 kills M0002 with 2 rows, run 2 kills M0002 with 1 row, and the
     test checks run 1. Checking run 1 passes. **Red (drop the filter):** the query has no ORDER BY and
     returns rowid order, and the Map keeps the last write, so run 2's `n = 1` wins the key and gives
     "expected 2, measured 1".
   - Both directions must go red under the dropped filter.
   - the BC legs are added to `REPRODUCTION_EXPECTED`, all with `killerRowsPerKill: 2`. A BC-shaped store
     (one `many` kill row and one `single` re-run row) counts 2.
6. **U6, hang's two-row stop-words check** (a helper beside `hang-diagnostics.ts`, tested offline):
   - selects the mutant's mutated `timeout` rows with `method = killingTest`. At line 145 the
     prefix rows belong to another method;
   - passes on two timeout rows that carry both phrases and are in band;
   - fails on a single row, on THREE rows, on a second row without the words, and on a second row out of
     band. It also ignores a timeout row of another method. One red test per direction.
7. **U7, the chunked `callSizes` filter:**
   - an exported pure helper taken from the itest's row loop, for example in a small `chunked-rows.ts`,
     because the itest runs at import;
   - rows [covering `many` x2 in session A (methods A1, A2), a replay row (`mutant_code` NULL), re-run
     `many` x2 in session B (A1, A2)] give sizes `[2]` and `reruns` `[A1, A2]` for that mutant.
   - **Red (filter):** drop the filter; the sizes become `[2, 2]`.
   - **F2, the re-run's methods equal the replay list:** a unit case where `reruns` has 4 methods and
     the replay has 2 fails the equality. The red check in the build: change `reproduceKill`'s
     `methods: step.chunkPrefix` to the full ordered prefix. R577's T5 and the helper-driven case must
     go red offline. On the gate, the equality fails for the two warm kills at ordered position 4 /
     chunk position 2 (a 4-method re-run against a 2-method replay). Restore after.
8. **Figures:** `gate-pages.test.ts` checks the pages against `gate-expected.ts`, including
   `stoppedCallsOn`.

Build loop: `bun install --frozen-lockfile`, `bun scripts/build-native-parser.ts`, `bun run typecheck`,
`rm -rf packages/*/dist`, `bun scripts/verify.ts`, `bunx biome check <touched>`. No AL changes, so no
`compile:fixtures`.

## 7. Live run plan

### 7.1 Before any live run
1. Commit `precommitment.md` as
   `docs/superpowers/specs/2026-10-22-r582-bcdev-kill-reproduction-precommitment.md` to master
   `[skip ci]`, from a scratch origin/master worktree, with the build head sha filled in. Send the sha.
2. Build on `lethal/r582`: unit tests green, then an Opus review of the built diff.
3. No baseline is deleted or recorded. Every gate runs without `LETHAL_ITEST_RECORD_BASELINE`.

### 7.2 bc1, bc2 and bc3 in parallel
- **Queue script:** R-604's `gate-queue.sh`, copied to `/coord/handoff/R-582/` (H = that directory).
  Before each gate it waits for the lease holder to be null and for at least 10 GB free. It leases in
  our lane, heartbeats, runs `lethal doctor` once, runs each gate in the foreground and releases.
- **Never signal-stop a gate.** Do not use Cronus28 (parked) or Cronus284.
- **Heavy jobs (M7):** CLAUDE.md says a BC gate against a bc server does NOT count toward the
  container's two-heavy-job limit. At most one gate per server, and back off under 10 GB free; the queue
  does both.
- **One detached worktree per server,** at the build sha: `/work/lethal-wt/r582-bc1`, `-bc2` and `-bc3`.
  In each, in order:
  1. `bun install --frozen-lockfile`;
  2. `bun scripts/build-native-parser.ts`;
  3. `bun scripts/bc-linux-setup.ts --server bcN` (it writes that server's gitignored configs; we read
     none of them);
  4. `scripts/bc-republish.ts alpackages --server bcN` for the tests fixtures that testapp, verify,
     agreement and verify-scale need.
- **Queues** (R-604's bc2 times, plus the added calls at about 0.5 s each, plus 30%):

| server | queue, in order | predicted |
|---|---|---|
| bc1 | verify-scale (~1350 s), bcdev, bcdev-names, verify, testapp | ~25-28 min |
| bc2 | hang (~900 s), harden, agreement, bcdev-wrapped, stale-publish, lease | ~20-23 min |
| bc3 | tables (~650-700 s), chunked (~110 s) | ~13-15 min |

  Every pair is already proven on its server under LethAL Control 1.0.0.23; none is newly admitted.
- **Reading the results:** each gate must PASS and print its R577 lines (`killerRowsPerKill` 2, no
  `kill-not-reproduced`).
  - Any verdict difference, any `kill-not-reproduced`, or any counter that differs from §4 is a BLOCK,
    reported as it is.
  - One rerun is allowed only for hang, and only under §5's F3 conditions.
- **R332 is not used.** If it ever were needed: pre-commit, delete the baseline, record once with
  `LETHAL_ITEST_RECORD_BASELINE=<file>` (exit 3), re-run to confirm, review, commit.

## 8. Docs, cost, rulings

### 8.1 Files and prose to update
- **Code and figures:**
  - `gate-expected.ts`: `TABLES_FIGURES.groupedCalls` `384 + 15 + 15`;
    `CHUNKED_FIGURES.control.groupedCalls` 42 and `.chunked.groupedCalls` 62, with its "MEASURED/DERIVED"
    comment; `HANG_FIGURES.stoppedCallsOn` 6.
  - `hang.itest.ts`: the formula, `stoppedCallsOn`, the two-row check.
  - `chunked.itest.ts`: the `callSizes` filter.
  - every orchestrator-driven BC itest, `envtool.itest.ts` included (M-c): one
    `killReproductionFailures(<leg>, report, store, runId)` call per run. testapp also asserts
    `killReproduced` on its named kill.
  - `chunked.itest.ts`: the `reruns` equality check (F2).
  - `kill-reproduction.ts`: the header changes from "on an al-runner leg" to "on every backend with the
    rule"; the BC rows; the required `runId`.
- **Assertion messages:** bcdev's and tables' "one per scored mutant" and hang's "one replay per warm
  kill" now name the re-runs.
- **Doc comments:** `backend.ts` (`killsMustReproduce`); `report.ts`'s `killReproduced` ("al-runner
  today" becomes "al-runner, al-runner-v3 and bcdev").
- **CHANGELOG.md:** the R577 entry says "bcdev is unchanged; its switch is R582". Add a new R582 entry:
  - bcdev now re-runs every kill under the mutant;
  - the cost;
  - **resuming a pre-R582 bcdev run re-executes every kill and is close to a full rerun, so start fresh
    instead** (I3).
- **`docs/gates/` pages** (pinned by `gate-pages.test.ts`):
  - `tables.md`: block 414, a bullet with the split, a History line;
  - `chunked.md`: 42 and 62, with their splits; the R208 red-check numbers stay in History;
  - `hang.md`: the block gains `HANG_FIGURES.stoppedCallsOn: 6`; the formula; two stop rows per hang;
    about 15 min wall time;
  - `bcdev.md`: 15 stays, and why; every kill is re-run;
  - `bcdev-wrapped.md`, `bcdev-names.md` and `harden.md`: one sentence each;
  - `envtool.md`: the rule applies, unmeasured, `session-reused` possible.
- **`servers.md` (M5):** add only the (gate, server) pairs that ran under R-582, with their logs. Each
  moved figure was measured on that one server (tables and chunked on bc3, hang on bc2, and so on). Do
  not imply that all 39 pairs were re-proven.
- **Roadmap:**
  - `R582.md` becomes `done (<commit>)`, with the measured figures and the close notes below;
  - `R577.md` lines 55 and 90 (bcdev is now on) and its Known limits (the timeout half is now measured
    live; I4's two costs);
  - then `bun scripts/roadmap-index.ts` and `bun test scripts/line-citations.test.ts`.
- **R582's close names:**
  - envtool unmeasured;
  - R618 still open;
  - I3's resume cost;
  - I4's two timeout costs;
  - M8: R592's bcdev-to-v2 lending now lends marked kills both ways;
  - M9: the rule catches a RANDOM flake, not a test whose outcome alternates with committed state
    (fail, pass, fail). The unmutated confirm already catches the common non-idempotent case as
    `unstable`;
  - M4: verify's kills are not evidenced live.
- **CLAUDE.md is not touched.** It holds no gate figures (R-592's version); every figure lives on the
  `docs/gates/` pages and in `gate-expected.ts`.

### 8.2 Cost
- Build: about 2.5 h.
- Plan and build reviews: about 1 h.
- Pre-commitment: about 0.5 h.
- Live: about 0.5 h to set up the three worktrees, about 28 min of queue wall time, about 0.5 h to read
  the results.
- CI, roadmap and submit: about 0.5-1 h.
- **Total: about 6-7 hours, of which about 1.3 h is live.**

### 8.3 Rulings on the open questions (reviewer)
1. Re-run timeout kills on BC (B2): **yes**, with I4's two costs named.
2. No baseline re-record: **agreed**. R332 does not apply; a baseline diff is a BLOCK.
3. **WITHDRAWN** (lane correction): CLAUDE.md holds no gate figures, so there is nothing to edit and
   nothing for the owner.
4. `stoppedCallsOn`: **pinned as 6**, in `hang.md`'s block.
5. Chunked `callSizes`: **filter** (I2, U7).
6. The k = 1 shape difference (a `RunMutantMany` kill re-run as a single `RunMutant`): **accepted**. A
   failure that only that shape produces becomes `kill-not-reproduced`, the safe direction.
7. `VerifyResult` without `killReproduced`: **leave it**; the gap is stated (M4).
8. `session-reused` on hosted environments: **acceptable** as the fail-safe direction; named in the close
   and on `envtool.md`.
