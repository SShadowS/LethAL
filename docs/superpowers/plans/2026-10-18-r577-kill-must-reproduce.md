# R-577 build plan r2: "a kill must reproduce" (al-runner on, bcdev off)

**r2 (2026-10-18), after review-opus-plan-r1.md.** Everything below r1 holds, except:
- **B1, adopted:** with `killsMustReproduce`, a `killed` row without the reproduction marker is NOT carryable
  (`resume.ts`, both rules; `nonCarryableRows`). It follows R53's `stopHungSessions`. Red test on a pre-rule
  store.
- **I1, adopted:** a non-optional marker, `killReproduced: true` on the outcome plus a `kill_reproduced INTEGER`
  store column, set on every reproduced kill. `reproducedFailure` stays optional text.
- **I2, adopted:** the gate pre-commits and ASSERTS, per leg:
  - the mutated `test_results` rows for the killer (2 per fail kill);
  - the exact cli-default `activations`;
  - the `--server` suite-run counts, if they are reachable.
  Measured from scratch runs.
- **I3, adopted:** the SBI slice with the rule on, about 8-14 runs, before the pre-commitment. Expected:
  - 0 false kills;
  - `kill-not-reproduced` only on the wizard test;
  - M0005-M0007 reproduced every time.
- **I4, adopted:** on `kill-not-reproduced`, the mutant stays active and the covering loop CONTINUES. A later
  test that kills and reproduces gives `killed` by that test. Otherwise the result stays `error
  kill-not-reproduced`.
- **I5, adopted:**
  - the interpretation reads "the reproduction under the mutant did not end with this test failing";
  - a cap maps to `warm-confirmation-incomplete`;
  - runner-row notes are prefixed "reproducing <M> under the mutant (first run failed: <line>)".
- **Minors adopted:**
  - M1: reproduction rows are `single` at k=1.
  - M2: `tests/helpers/legacy-report.ts`, a schemas.test "additive under v3" test, and a store migration test on
    an old database.
  - M3: stub ordinals.
  - M4: the gate's "no kill-not-reproduced" half rests on I3 and the unit tests.
  - M5: a transport error during the reproduction aborts the session, as in a covering run.
- **B2 RULED (a), 2026-10-18: the rule applies to timeout kills too.** §1.5 and T9 of r1 are VOID.
  - **Reproduced means:** a second TIMEOUT under the mutant at the SAME budget (the budget the timed-out run
    was sent).
  - **When:** after the existing timeout confirm (R53/R514/R516/R517) accepts it, on both the k=1 cold path
    and the `confirmWarm` timeout grain at k>1.
  - **Not reproduced:** a pass or a fail instead gives `kill-not-reproduced`; the note says which happened.
  - **On `--server`:** the daemon restart after a non-pass/fail row (R517 I2) already exists.
  - **Tests:**
    - T9 becomes "timeout, fast confirm, timeout again" → `timeout-killed` with the marker;
    - T9b: "timeout, fast confirm, pass" → `kill-not-reproduced`;
    - T9c: the reproduction is sent the same `timeoutMs` (a counter on the stub). Red: recompute it.
  - **Measured cost on the gates:** 0. No al-runner baseline holds a `timeout-killed`:
    - leg A 3/12/4;
    - cli-default 3/12/4;
    - layout 7/3/0;
    - multiobject 6/1/5;
    - wrapped 58/37/3;
    - both symbol sets 5/4/0.
    - `itest:hang` is BC-only (R582).
    So no al-runner gate gets slower from it, and no live gate exercises it on al-runner; it rests on the
    unit tests. R582 inherits it for BC, where `itest:hang` pays one budget per timeout kill.
- **I4 CONFIRMED** (the covering loop continues after `kill-not-reproduced`). New test T10: flaky X ordered
  before deterministic killer Y gives `killed` by Y, with the marker. Red: stop the loop at X; it becomes
  `kill-not-reproduced`.

---

# r1

Drafted by an opus Plan agent (read-only; saved here by lethal-preproc), 2026-10-18, on master 0254e6d2.
Rulings: orchestrator 2026-10-18 (see R577.md "To close"). Measurement: measure.md.
Model for adding a cause: commit beba3d6c (R534).

## 0. The switch
- **A backend property, not a CLI-set orchestrator option:** `readonly killsMustReproduce?: boolean` on
  `ExecutionBackend` (`backend.ts`). Absent means off.
- **Pattern:** the same as `inRunStopIsBudget`, an optional per-backend flag that changes how the confirm
  behaves. It is kept off `BackendCapabilities`, so the stream schema does not change.
- **Why not a CLI option:** every itest calls `runSession` directly (`al-runner.itest.ts` `runOnce`), and so
  do `runNamedMutants` and verify. A CLI-set option would not reach them.
- **Who sets it:** `AlRunnerBackend` sets `readonly killsMustReproduce = true`. `BcDevMcpBackend` does not,
  so it is off; R582 adds that one line. The test stubs (`StubBackend`, `GroupStubBackend`,
  `WarmStubBackend`) leave it unset, so every existing test runs with the rule off. New tests opt in.
- **al-runner has no `runMany`:** the `backend.ts` doc says so, and `resolveGroupRuns` returns undefined. No
  al-runner run takes the group path, so that half is unit-tested only.

## 1. Every place a kill is decided
1. **Sequential loop, cold confirm** (`runMutantsOnBackend`: a `fail`/`timeout`, then
   `confirm.outcome === "pass"`, then `killed`/`timeout-killed`). **Applies when `!timedOut`.** The
   reproduction goes after the confirm passes and before `recordKill`.
2. **`coveringRuns` group/chunk path, position 1** (`opKind "many"`, `groupPosition` 1). It takes the same
   cold-confirm branch, so it applies the same way: a single `runFenced`, mirroring the confirm.
3. **`confirmWarm`, a `fail` at k > 1** (`warm.kind === "confirmed"`, then `killed`). **Applies.** It replays
   `step.chunkPrefix` (positions 1..k, the call's own prefix) through `runFencedMany` with the mutant active
   (no `confirmation` flag).
4. **The null-activation confirm itself:** unchanged. The reproduction runs only after it passes.
5. **Timeout kills** (`timeout-killed` at k = 1 via R53/R514/R516/R517; `confirmWarm` with grain `timeout`):
   **not applied.**
   - They already rest on a duration measured unmutated, with a 2x margin.
   - A random fail is not what produces them; R577's false kill was a `fail`.
   - Re-running a hang costs a whole budget per kill, and on `--server` it hits R517 I2 (an abandoned thread
     poisons the daemon).
6. **verify.ts:** it does not re-decide kills (`measuredResultOf` maps `runNamedMutants` outcomes), and verify
   is bcdev-only, so the rule is off there in R577. Under R582 the cause flows through the existing `error`
   branch with `failureNote`. `VERIFY_SCHEMA_VERSION` stays.
7. **Campaign:** it only reads verdicts. No change.
8. **`--resume` carried verdicts:** no re-decision. A carried kill carries the new field (section 4).

## 2. The rule (orchestrator.ts)
- **Extract** `coveringRuns`' inner `single` into a module function, `singleStep(ctx, ref, budget)`. The
  reproduction calls it with the step's SENT budget (`testBudgetMs`/`testBudgetSource`), never a recomputed
  one.
- **New `reproduceKill(p): Promise<ReproDecision>`,** a sibling of `confirmWarm` with the same parameter
  shape. `ReproDecision` is `{kind:"reproduced", failure}` or the same error shape as `WarmDecision`.
  - First, always `await activateOnce(backend, safety, m.mutantId)`.
  - At k = 1, call `singleStep`. Otherwise call `runFencedMany` over `step.chunkPrefix` with the step's
    `callSettings`.
  - Push every row to `testResultBuffer` with `mutantCode: m.mutantId` (MUTATED rows) and the step's
    `opKind`. Call `feedAttestation`. Do not add to `spent`: this is confirmation machinery.
  - Non-verdict endings go through `classifyNonVerdictStep(..., "reproducing <method> under the mutant")`:
    deadline-exceeded, result-lost, stranded, op-stopped, the lease causes and the transport abort, with
    their side effects. A group `call` result is handled as `confirmWarm` handles one.
  - `sessionWasReused` on any reproduction row gives `session-reused`.
  - **Reproduced** only if the killer itself answered `fail`: the single verdict, or entry k with
    `endedBy === "failure"` and `ranCount === k`. Any text counts.
  - **Everything else is `kill-not-reproduced`:** a pass, an all-pass, j < k failing first, a timeout
    instead of a fail, or a cap. The note says which.
- **Call sites:** the k > 1 `fail` branch after `warm.kind === "confirmed"`, and the cold branch after
  `confirm.outcome === "pass" && !timedOut`. Both are guarded by
  `args.backend.killsMustReproduce === true`. With the flag off, the code is unchanged.
- **Reproduced:** `killed`; `killingTest`, `killingTestRef` and `killPosition` as today;
  `killingTestFailure = v.failureMessage` (the first run); `reproducedFailure = repro.failure`; then
  `recordKill`.
- **Not reproduced:** `error` with the decision's cause and note; no `recordKill`.
- **Fail-safe:** a lost, deadline, stranded or reused reproduction gives `error` with that existing cause.
  Never `killed`, never `survived`.

## 3. Ordering and state
- **The mutant is active after the reproduction,** and nothing downstream assumes null. A survivor already
  ends with the mutant active. The next mutant starts with `activateOnce(next)`. The baseline and the
  Decision-11 rerun activate null explicitly. `activateOnce` has no cache.
- **al-runner `--server`:** `activate()` clears `serverSuite`, so the re-activation is MANDATORY. Without it,
  `run()` would read the cached null suite and every kill would become `kill-not-reproduced` (test T7).
  - With it, `ensureServerSuite` does one fresh `runTests` under the mutant.
  - Static selector: a recompile. Resource selector: one file write.
- **Store:** reproduction rows are MUTATED `test_results` rows. `sessionIdLiveness` holds: al-runner has no
  session ids, and on bcdev each single reproduction is its own session. No query assumes one mutated row
  per test per mutant.
- **Kill ledger:** `recordKill` only after reproduction, so R197 never learns from a flake.
- **Warm counters:** `warmKills` and `killPosition` are unchanged. `groupedCalls` gains +1 per warm kill
  (R582's figure).
- **`--resume`:** `kill-not-reproduced` is a plain error, so `--resume` re-runs it. A carried kill keeps
  `reproducedFailure`.
- **`lethal explain`:** the mutant appears under `notMeasured[]` with the cause and `failureNote`.

## 4. Report
- **New `MutantOutcome.reproducedFailure?: string`,** after `killingTestFailure`. Set on `killed` only, only
  when the backend has the flag, ALWAYS when reproduced (even with the same text). Its presence is the
  gate's proof that the rule ran. R86 hazard: take it from the reproduction verdict, never from the confirm.
- **`kill-not-reproduced` error:** `killingTestFailure` stays unset (kill-only). The first line of the first
  text goes into `failureNote` (R206's `split("\n")[0]`). The full text stays in the store.
- **Note** (says what LethAL did; the only advice is about LethAL's own tool):
  `kill-not-reproduced <Method>: failed under the mutant (<first line>), passed with no mutant active, then passed when LethAL re-ran it under the mutant[ by replaying the same <k> method(s) of its call]; the failure did not repeat, so it is not attributed to the mutant (R577). Re-run with --resume to measure it again.`
  Variant clauses: "then <j>. <M> failed first in the replay"; "then timed out instead of failing"; "then the
  replay stopped at the server's cap after <n> of <k>". The note never calls the test flaky.
- **Counts:** no new key. `counts.errors` includes it, and `counts.unstable` does not. Add the cause to
  `errorBreakdown`'s `named` list.
- **`ERROR_CAUSE_INTERPRETATIONS["kill-not-reproduced"]`:** the meaning (the three runs, in order); tool
  advice `--resume`; entailedNegative "Not survived (it failed once), not a kill (it did not repeat), not
  unstable (it passed with no mutant)"; basis R577.
- **Ripple:**
  - `events.ts`: on `mutant-scored` and the carried event.
  - `report-fold.ts`: both fold sites.
  - `report.ts`: type, cause, interpretations, builder, `errorBreakdown`.
  - `bun scripts/generate-schemas.ts`: report-v3 and stream-v1 enums plus the optional field, no version
    bump (beba3d6c).
  - Explain: `EXPLAIN_SCHEMA_VERSION` 16 to 17 with a history line, `schemas/explain-v17.schema.json`, the
    `schemas/README.md` row, and the link in `docs/using-lethal-from-an-agent.md`.
  - `schemas.test.ts`: the map, the enum pin, and required(v17) == required(v16).
  - `report-equality.test.ts`: one kill with `reproducedFailure` and one `kill-not-reproduced`, then
    `--update-snapshots`.
  - No new caveat. Sample reports need no regeneration (only optional fields and enum values are added).
- **Store and resume:** `store.ts` gets `MutantRow.reproducedFailure` and a column `reproduced_failure TEXT`
  (a guarded `ALTER TABLE`, as for `killing_test_failure`), plus the insert and select. `resume.ts` carries
  it. `record()` takes one more argument, threaded through the carried call sites.

## 5. Cost
- +1 test run and +1 activation per `fail` kill where the rule is on. Nothing is added for survivors, errors
  or timeout kills.
- Per transport: one-shot +1 spawn with its compile; `--server` static +1 recompile and +1 suite run;
  `--server` resource +1 suite run.
- The slice: 3 kills over ~37 covering runs, about 8% more.
- A 1% flaky test then false-kills ~1 in 10,000 instead of ~1 in 100.
- bcdev (R582): +1 `RunMutant` per cold kill, +1 `RunMutantMany` per warm kill.

## 6. Unit tests (orchestrator.test.ts; a red check per direction; order by call counters, never wall clock)
- **T1, flaky:** fail m, pass null, pass m. Expect `error`/`kill-not-reproduced`, the note holds the first
  text, `killingTest` unset, ledger empty, activations `[m, null, m]`. Red: remove the reproduction call;
  it becomes `killed`.
- **T2, reproduces:** fail, pass, fail with the same text. Expect `killed`,
  `reproducedFailure === killingTestFailure`, one `recordKill`. Red: wire it from the confirm; it is absent.
- **T3, different text:** "A", pass, "B". Expect `killed` with "A" and "B". Red: require the same text;
  it becomes `error`.
- **T4, rule off:** T1's script with the flag unset. Expect `killed`, activations `[m, null]`, no field, no
  third row. Red: force the rule on; it becomes `error`.
- **T5, k > 1:** `WarmStubBackend` where B fails under m only after A in the same session. Expect `killed`,
  `killPosition` 2, a third `runMany` over `[A,B]` under m with no confirmation flag, two mutated `many`
  rows. Red: reproduce cold; it becomes `kill-not-reproduced`.
- **T5b:** the replay is all-pass. Expect `kill-not-reproduced` with the replay clause.
- **T5c:** A fails first in the replay. Expect `kill-not-reproduced` with the "A failed first" clause.
- **T6, order:** a shared seq counter gives activate(m), run fail, activate(null), run pass, activate(m),
  run, then `recordKill`. The same shape holds on the group path.
- **T7, --server cache:** a stub caching the suite per activation. Red: drop `activateOnce(m)`; a
  deterministic kill becomes `kill-not-reproduced`.
- **T8, lost reproduction:** deadline gives `deadline-exceeded`; in-flight-unknown gives `stranded` and a
  quarantine; reused gives `session-reused`. Never `killed`; ledger empty. Red: treat a non-verdict as
  reproduced; it becomes `killed`.
- **T9, timeout excluded:** a position-1 timeout with a fast confirm gives `timeout-killed`, activations
  `[m, null]`, no reproduction.
- **resume.test.ts:** a carried kill keeps `reproducedFailure`. Red: drop the column read.
- **report.test.ts:** the banner says `kill-not-reproduced 1`. **schemas.test.ts:** the v17 enum.

## 7. Gate impact (itest:alrunner)
- **Do not move:**
  - per-mutant verdict, `killingTest` and `errorClass` against every baseline (al-runner, layout,
    multiobject, wrapped, both symbol sets, cli-default);
  - `groupedCalls` 0, `warmKills` 0, `killPosition` 1.
  - No baseline is re-recorded. Any verdict change, including any `kill-not-reproduced`, is a BLOCK.
- **cli-default:**
  - `cliDefaultMechanismFailures` pins one `--server` spawn, `--test-timeout 180`, the one-shot allow-list
    (provision, `--version`) and one R392 probe. The "3 one-shot spawns" are those three, so it STAYS 3.
  - `activations` is only checked for > 0 and printed: predicted 20 to 23.
  - `alHashes <= deploys` holds.
- **Printed or measured only, never asserted:** +1 per final `fail` kill, 0 per `timeout-killed`.
  - leg A, `--server` and resource: +3 each;
  - layout: +7;
  - multiobject: +6;
  - wrapped: +58 minus any timeout kills (MEASURE);
  - symbols: +5 per set;
  - cli-default: +3.
- **Hang-like legs and the R534 paths:** unchanged.
- **New anti-inertness assertion** in `assertVerdictTable` and every leg: every `killed` mutant has
  `reproducedFailure`, and none has `kill-not-reproduced`. Red: set the al-runner flag false; the gate fails
  by name. First MEASURE that every al-runner `fail` carries a message.
- **Measured in the scratch pre-commitment runs, not predicted:**
  - activations per leg;
  - wall-time deltas;
  - the wrapped leg's `fail` kill count;
  - every kill reproducing, and with which text.
- **BC gates:** untouched (the flag is off for bcdev).

## 8. Files, in build order
1. `backend.ts`
2. `report.ts`
3. `events.ts`, `report-fold.ts`
4. `store.ts`, `resume.ts`
5. `orchestrator.ts` (`singleStep`, `reproduceKill`, the two call sites, `record()` and its carried callers)
6. `al-runner-backend.ts` (the flag)
7. `explain.ts` v17, `schemas/explain-v17.schema.json`, `schemas/README.md`, the agent guide;
   `bun scripts/generate-schemas.ts`
8. Tests: orchestrator T1-T9, resume, report, schemas, report-equality (`--update-snapshots`)
9. `al-runner.itest.ts`: the anti-inertness assertion
10. The pre-commitment from measured scratch runs, then `itest:alrunner`, then R577 done and the roadmap
    index. R582 stays open and names the bcdev line it flips.
