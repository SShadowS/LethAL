# R236b: the lost TestPage baseline reply, read back from the server instead of quarantining the run, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision:** r3, 2026-09-27, answering gpt-6-sol reviews r1 and r2 (`H:/lethal-coord/reviews/R-236b-plan/review-r1.md`, `review-r2.md`) and the orchestrator's rulings on both. Per-finding answers are in "Review responses" at the end.

**Goal:** A `RunMutant` reply lost after BC sent `200` headers (the `PageActionComputesNonZero` baseline case, 4 of 4 attempts on 2026-09-27) no longer quarantines the whole run when the server hands back that op's own completed `pass` or `fail`, verified by the client. Every other case takes exactly today's path, unchanged: a baseline call quarantines; a mutant call is reconciled against the op marker by the existing `runFenced` / `runFencedMany` handling, which may make its existing one fresh attempt (design section 5).

**Architecture:** The control app (1.0.0.20) saves each answer that RAN a test into a one-row table and commits it as the action's last statement, then returns the same text. A refusal saves nothing, so it can never overwrite a kept answer. A new read-only action `GetOpAnswer` returns the saved text only when the row names the caller's exact `(attemptId, opSeq, epoch, generation)`, and echoes all four. The client, on any `in-flight-unknown` exit, reads it back once with a bounded timeout, checks the echo, scores it through the unchanged answer parser, and accepts it ONLY if the result is an identity-checked `pass` or `fail`. The readback dispatches nothing of its own. A readback that is not accepted leaves the original `in-flight-unknown` to today's handling, unchanged (Global Constraints). A pre-committed measurement (Phase A) decides whether the grouped path `RunMutantMany` needs the same treatment in this task.

**Tech Stack:** Bun + TypeScript (`packages/runner`), AL (`extensions/lethal-control`, runtime 16), BcContainerHelper under the Windows docker context, `coord` for container leases.

**Spec / evidence this plan argues from:**
- `docs/roadmap/R236.md` (Phase A read-out of 2026-09-26), `docs/roadmap/R263.md`, `docs/roadmap/R225.md`.
- `docs/superpowers/specs/2026-09-26-r236-rate-precommitment.md`, sections C3, D3, D5, D6, OUTCOME O4 to O8 and the ERRATUM.
- `docs/superpowers/plans/2026-09-26-R-236-testpage-baseline-in-flight-unknown.md` and its review responses (r2 Criticals: "a tombstone does not prove the whole action ended"; "a retry must fail closed").
- `docs/superpowers/specs/2026-09-25-gh24-reach-control-precommitment.md` sections 3, 5 and its OUTCOME "Run order".
- Orchestrator rulings of 2026-09-27 (quoted in "Review responses").

## The mechanism, from evidence already in hand

Every fact below is from the committed OUTCOME or from the scratch NDJSON it was tabulated from, `C:/Users/SShadowS/AppData/Local/Temp/r236/{A1,A2,Bp1,Bp2,restore-check}.ndjson`, re-read on 2026-09-27.

1. **Only the end of the answer is lost, after the AL had built all of it.** All 8 broken calls got `200` headers, `Transfer-Encoding: chunked`, then most of the body. The six timer cases lack 73 to 116 bytes; the two socket-close cases lack ONLY the envelope's final `}`, and their partial bodies already carry `coverageRunMs` and `coverageSerializeMs`, which `RunMutantWithCoverage` computes after `RunMutant`, `StopApplicationCoverage` and `CoverageArray` (O6). AL returns the answer as one `Text`; the platform writes it out afterwards.
2. **The fence completed in 7 of 8; the 8th could not be read** (both status reads timed out under BC OData throttling, event 705) (O4).
3. **Always this one call.** 7 broken calls in 3 894 `RunMutant*` calls in those files (8 with the warm-up session), all on `PageActionComputesNonZero`; no other call broke (O4 and the re-read).
4. **Confounded with answer size, and more.** Re-read 2026-09-27: the TestPage call's clean answer is 6 616 to 6 618 bytes; the largest clean answer of the other 67 tests is 2 872 to 2 874 bytes (`ExtCountRelatedIgnoresDecoys`). The TestPage answer is the only one above 2.9 KB (it carries the platform's CLR callstack). Every observation so far varies "opens a TestPage", "answer above ~3 KB" and "carries a CLR exception" together.
5. **Hits start late.** Every hit's headers arrived at 606 ms or later; every clean answer's by 543 ms (O5).
6. **Who drops the bytes is not known** (D6, O6).
7. **Hits can wedge the server.** 1 of 8 hits on Cronus284 and 2 of 5 on Cronus28 were followed by a failed `HarnessInfo` preflight (O8, D3).

Options, on that evidence:

- **(a) A smaller or differently terminated body** is ruled out: the loss is at the END whatever the size, and AL cannot flush or end the platform's HTTP response.
- **(b) Recovery from the op marker or progress row** is ruled out by r2 Critical 1 (a tombstone proves the FENCE ended) and gives back no answer, so it could only license a re-run (r2 Critical 2).
- **(c) CHOSEN: the answer, saved and committed by the action as its last statement, read back by the client.** It does not use the HTTP body, so it does not depend on facts 4 and 6. It adds no re-run of its own. **What the committed row proves, and what it does not:** a committed row with our exact key proves the action's AL answer construction completed: `LC Run Method` returned, the fence's phase 3 committed, coverage was stopped, `CoverageArray` read and the JSON was written (every one of those runs before `KeepAnswer`). It does NOT prove the HTTP request or the BC session ended: `exit(Answer)`, the platform's OData response handling and any session teardown still follow, and fact 7 shows that part can hang. The fix therefore uses the row only as the ANSWER, never as a licence to re-run or to assume the server is healthy; a wedged server still fails the next call, which fails closed on its own.
- **(d) Not dispatching TestPage tests client-side** is OUT (orchestrator ruling: it changes the gate's pinned expected failure). Filed as a roadmap item in Task 12.

What (c) does NOT fix: the platform still loses the tail and can still wedge (fact 7); a hit still waits up to the 120 s baseline budget before reading back (no early readback, by ruling). R236 closes only when the fix works in the live gates (Task 12), never on a mechanism label.

## Decisions this plan applies (orchestrator, 2026-09-27)

- **Containers:** Phase A and C1 on Cronus284 (dedicated to R-236), gates on Cronus28. Both receive 1.0.0.20.
- **No restart recovery.** Every wedge (a failed preflight after a hit) stops that run and goes to the owner through `coord ask`.
- **No early readback** (no body-stall watchdog); filed only.
- **Write cost** is measured from existing gate and probe timings (Task 10 step 3, Task 11 step 5).
- **Grouped path:** if Phase A sees ANY break on the non-TestPage arm, `RunMutantMany` is fixed in this task (Tasks 4 step 5 and 6b) and acceptance blocks until it is.

## Global Constraints

- Containers: ONLY `Cronus28` and `Cronus284`, each under `coord lease <name> bugs` (runbook `docs/superpowers/runbooks/autonomy/README.md`), heartbeat every 5 minutes, one live job at a time, release right after. A stopped container: `coord ask`, never start it. A wedge or any unrecoverable state: `coord ask` the owner, never restart or rebuild.
- Before any live run, confirm the config's `bcdev.server` host is the container you leased (incident E1 of the rate spec).
- Shells: **[bash]** is the Git-bash tool, **[pwsh]** is the PowerShell tool. In [pwsh] set `$env:DOCKER_CONTEXT='desktop-windows'` first.
- Build loop: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test` from the repo root. Biome only on touched files: `bunx biome check <paths>`.
- AL: verify by `/al-compile` (or the `al-compiler` subagent), then live gates. `extensions/lethal-control/app.json` `1.0.0.20` and `MIN_CONTROL_VERSION = "1.0.0.20"` in `packages/runner/src/harness.ts`, in one commit (a test pins the lockstep).
- **Acceptance rule for a readback (ruling C1), exact:** accepted ONLY when (1) `GetOpAnswer` says `found: true` and echoes `attemptId`, `opSeq`, `epoch` and `generation` equal to the request, checked client-side; AND (2) the answer, scored by the unchanged parser (which checks the echoed `targetAppId`, `artifactId`, `attemptId`, `mutantId`, `codeunitId`, `method`), yields `outcome` `pass` or `fail` with no `operation`. For the grouped path, (2) reads: a `verdicts` result whose every verdict is `pass` or `fail` with no `operation`. Everything else (a refusal, `lease-lost`, `error`, a malformed result, a partial readback body, a failed or slow read, `found: false`) keeps the original `in-flight-unknown` with the reason appended, and that verdict takes today's path UNCHANGED (review r2 ruling C1). On the baseline path (`dispatchUnmutated`, plain `runOnce`) the run quarantines. On the mutant paths, `runFenced` and `runFencedMany` reconcile it against the op marker and, on `completed` or `not-started`, make their existing ONE fresh attempt of the single call or the whole chunk; that legacy reconcile is existing, gated product behaviour and STAYS. The readback adds no dispatch of its own, and an accepted readback returns a terminal verdict, so the reconcile is never entered for it. A grouped call carrying `abortSession` (identity disagreement, unexpected 404) is NEVER replaced, even by a valid kept answer (review r2 ruling C2).
- Typed errors extend `Error` directly. No `!` non-null assertions. `exactOptionalPropertyTypes` spreads for optional props.
- No em dashes in any file written by this plan.
- Every fix is red-checked (`mutation-red-checker` subagent): revert the fix, the named test goes red, restore; report both outputs.
- A pre-commitment is committed BEFORE its live run; nothing above its `## OUTCOME` line changes afterwards.
- `CLAUDE.md` is NOT edited by this plan (owner edit, Task 12). Re-recording `tables.baseline.json` belongs to the owner.
- `packages/runner/itest/tables.itest.ts` has an UNCOMMITTED working-tree edit on 2026-09-27 (EXPECTED at GH-24 section 5's figures). It is not this plan's; never commit it, never discard it.

## Review Focus

- **A duplicate request for the same op** (a same-key re-send the fence refuses): the refusal saves nothing, so the kept `ran` answer survives. Pinned live in Task 8 and client-side in Task 6 test 8.
- **A readback that races a still-running action** (the "before headers" exits): the row still names the previous op, so `found: false`, quarantine. Task 6 test 3.
- **A readback that hangs or arrives partial under OData throttling** (O4's failed read): bounded by `min(15 s, the call's budget)`, then fail closed. Task 6 tests 5 and 12.
- **A readback whose answer is not a completed pass or fail** (refusal, `lease-lost`, malformed test result, wrong lease echo): never accepted. Task 6 tests 6 to 11.
- **The two paths after a readback on a mutant call**: an accepted readback short-circuits `runFenced`'s reconcile (one dispatch, no `lost-ack-*` warning); a failed one reaches the unchanged reconcile and its one existing fresh attempt. Task 7 tests 2 and 3 (and Task 6b step 6 for the grouped path).
- **A grouped call that must abort the session** (`abortSession`): never replaced by a kept answer. Task 6b tests 7 and 8.
- **Existing fake fetches that answer every URL alike** now see one extra `GetOpAnswer` POST on in-flight exits; such a test may change for that reason ONLY (Task 6 step 4).

---

## File map

- Create `docs/superpowers/specs/2026-09-27-r236b-reply-fix-precommitment.md` (Task 1; OUTCOME in Tasks 3, 10, 11).
- Create `scripts/r236-baseline-probe/size-arm.ts`, `scripts/r236-baseline-probe/size-arm.test.ts` (Task 2; `--kept-check` mode added in Task 8).
- Create `extensions/lethal-control/src/OpAnswer.Table.al`; modify `extensions/lethal-control/src/ControlApi.Codeunit.al`, `extensions/lethal-control/app.json`, `packages/runner/src/harness.ts` (Task 4).
- Modify `packages/runner/src/run-mutant-transport.ts`, `packages/runner/src/backend.ts`, `packages/runner/tests/run-mutant-transport.test.ts` (Tasks 5, 6, and 6b if required).
- Modify `packages/runner/src/orchestrator.ts`, `packages/runner/tests/orchestrator.test.ts` (Task 7).
- Modify `packages/runner/itest/bcdev.itest.ts` (Task 8).
- Modify `docs/roadmap/R236.md`, new roadmap files, regenerate `ROADMAP.md` (Task 12).

---

# Phase A: does the loss reach calls that do not open a TestPage?

This decides one thing: whether `RunMutantMany` is fixed in this task. It is NOT a root-cause test: widening the coverage filter changes the work and the answer's content as well as its size, so a break on the non-TestPage arm shows risk outside TestPage, not that size caused it; and zero breaks does not prove TestPage is the cause. Phase A runs before Task 4 so the control app is built once.

### Task 1: pre-commit Phase A and the acceptance (BEFORE any live run)

**Files:** Create `docs/superpowers/specs/2026-09-27-r236b-reply-fix-precommitment.md`.

- [ ] **Step 1: Write the spec with exactly these sections.**

**§A1 Facts before any run.** Facts 1 to 7 above with their sources, fact 4's numbers, and that they were re-read on 2026-09-27.

**§A2 The non-TestPage arm (Cronus284, control app 1.0.0.19, client at HEAD).**
- Arms alternating in one loop under one probe lease: **T** = `Data Tests.PageActionComputesNonZero` with coverage filter `79300..79399`; **S** = `Data Tests.ExtCountRelatedIgnoresDecoys` (passes; clean answer 2.9 KB) with a widened coverage filter chosen by calibration.
- Calibration (not counted): try, in order, `79300..79399|130000..130499`, `79300..79399|130000..139999`, `79300..79399|1..99999`; take the FIRST whose S answer is at least 6 617 bytes and whose call finishes within 10 s. None qualifies: S is "not runnable".
- Planned: 60 pairs (T then S). A **break** is a call that failed after dispatch: trace `errorPhase` `"body"` or `"fetch"`.
- After every break: one `GetOperationStatus` read and one `HarnessInfo` preflight. A failed preflight is a wedge: the loop stops, `coord ask` the owner. No restart.
- **Reading, first match wins:**
  1. **grouped fix required**: S has at least ONE break, OR S was not runnable, OR fewer than 60 pairs completed with zero S breaks (an incomplete arm cannot clear the grouped path).
  2. **grouped fix not required by this task**: all 60 pairs completed and S has zero breaks.
- Neither reading is a root-cause statement, and neither closes or narrows R236. Stated limits: a direct loop is not a session; S differs from T in more than size.

**§C Acceptance (Phase C).**
- **C1, lost-body case, probe on Cronus284, control app 1.0.0.20, client at the fix commit.** `scripts/r236-baseline-probe/probe.ts --only src/DataValueSource.Codeunit.al` (as in the rate spec), 30 counted sessions under the rate spec's D2 warm-up rule. A **recovered lost body** is a session whose TestPage call trace has `errorPhase` `"body"` AND a `lost-reply-recovered` warning names `PageActionComputesNonZero`.
  - P1: zero sessions quarantined with a reason containing `baseline test in-flight-unknown running PageActionComputesNonZero`, EXCEPT where the quarantine detail carries an `answer readback` reason that this plan's rule requires to fail closed; each such case is listed and FAILS P1 unless the owner rules it expected.
  - P2: for every recovered lost body, the trace shows headers then an INCOMPLETE body: `errorPhase` `"body"` and no `bodyEndAt` (no fixed byte threshold: measured broken replies ran to 6 616 and 6 642 bytes, O6); where the probe captured the partial bytes, they are recorded beside that call's read-back answer for the OUTCOME. The recorded TestPage baseline row is `fail`, its text matches `describeTestPageUnsupported` (`CreateNavTestService`), and the session then records all 68 baseline rows.
  - P3: at least 3 recovered lost bodies among counted sessions. Fewer: 30 more counted sessions; still fewer than 3: the lost-body case is not exercised, acceptance FAILS.
  - Every other quarantine and every wedge is listed with its reason. A wedge ends the run (`coord ask`).
- **C1b, clean failing-TestPage write/read, Cronus284.** `size-arm.ts --kept-check 10` (Task 8): 10 direct TestPage calls. For every call whose body arrived whole, `GetOpAnswer` returns `found: true` and its `answer` is byte-equal to the body's inner `value`, and the transport verdict is `fail` with `CreateNavTestService`. Any mismatch FAILS acceptance. A lost body during C1b is recorded and counted with C1's recovered lost bodies.
- **C2, gates on Cronus28, control app 1.0.0.20.** `itest:hang`, `itest:bcdev` (including Task 8's pins), `itest:chunked`, each once and as frozen. `itest:tables`: GH-24's two-run procedure (its OUTCOME "Run order"), repeated until 3 consecutive rounds pass, at most 6 rounds. The 3-in-a-row is an operational hurdle, NOT a reliability claim: EVERY round, passing or failing, is reported with its reason. Per round, run 1 (committed baseline kept) is the authority for the 377 existing mutants: it must stop in `assertMatchesBaseline` with exactly ten "present in after but missing from before" differences, all `Data Reach Ops`, and zero field differences. Run 2 (scratch baseline) must pass end to end, and Task 11's check of the ten reach mutants must print `GH-24 section 3 OK`.
- **If §A2 read "grouped fix required":** acceptance also requires Task 6b landed, its unit tests and red-checks green, and C2 run with it.
- **Write cost (reported, no threshold):** C1's median baseline `durationMs` over the 67 non-TestPage tests against the same statistic from the rate spec's arms A1 and A2 (same probe, same container); each gate's wall time against its last pre-fix run where one is recorded.

**§OUTCOME** (empty).

- [ ] **Step 2: Commit before any live run** **[bash]**

```bash
git add docs/superpowers/specs/2026-09-27-r236b-reply-fix-precommitment.md
git commit -m "precommit(R236b): non-TestPage arm and acceptance of the kept-answer readback"
```

### Task 2: `size-arm.ts`, the non-TestPage arm

**Files:**
- Create: `scripts/r236-baseline-probe/size-arm.ts`
- Test: `scripts/r236-baseline-probe/size-arm.test.ts`

**Interfaces:**
- Consumes: `traceFetch`, `CallTrace` from `scripts/r236-baseline-probe/fetch-trace.ts`; `acquireProbeLease`, `odataReadRegisteredArtifact` from `packages/runner/itest/probe-lease.ts`; `RunMutantTransport` from `packages/runner/src/run-mutant-transport.ts`; `bcFetch` from `packages/runner/src/bc-fetch.ts`; config loading and `HarnessVerifier` exactly as `probe.ts` imports them.
- Produces: `readA2(r: { readonly pairsDone: number; readonly pairsPlanned: number; readonly sBreaks: number; readonly sRunnable: boolean }): "grouped fix required" | "grouped fix not required"` (pure, exported); the CLI writes one NDJSON line per call.

- [ ] **Step 1: Failing test** **[bash]**

```ts
// scripts/r236-baseline-probe/size-arm.test.ts
import { describe, expect, test } from "bun:test";
import { readA2 } from "./size-arm";

describe("readA2", () => {
  const full = { pairsDone: 60, pairsPlanned: 60, sBreaks: 0, sRunnable: true };
  test("a complete arm with no S break clears the grouped path", () => {
    expect(readA2(full)).toBe("grouped fix not required");
  });
  test("ONE S break requires the grouped fix", () => {
    expect(readA2({ ...full, sBreaks: 1 })).toBe("grouped fix required");
  });
  test("an incomplete arm cannot clear it", () => {
    expect(readA2({ ...full, pairsDone: 59 })).toBe("grouped fix required");
  });
  test("an unrunnable S arm cannot clear it", () => {
    expect(readA2({ ...full, sRunnable: false })).toBe("grouped fix required");
  });
});
```

- [ ] **Step 2** **[bash]** `bun test scripts/r236-baseline-probe/size-arm.test.ts`: FAIL, `Cannot find module './size-arm'`.
- [ ] **Step 3: Implement.**

```ts
export function readA2(r: {
  readonly pairsDone: number;
  readonly pairsPlanned: number;
  readonly sBreaks: number;
  readonly sRunnable: boolean;
}): "grouped fix required" | "grouped fix not required" {
  if (!r.sRunnable || r.sBreaks > 0 || r.pairsDone < r.pairsPlanned) return "grouped fix required";
  return "grouped fix not required";
}
```

   The CLI, all inside `async function main()` run only under `if (import.meta.main) await main();`:
   1. Refuse unless `LETHAL_R236_SIZE_ARM=1` (print `skipped`, exit 0).
   2. Required: `--config <lethal.config.local.json>`, `--expect-container <name>`, `--out <file.ndjson>`, and `--pairs <n>` (Task 8 adds the alternative `--kept-check <n>`). Refuse (exit 2, naming the value) if the config's `bcdev.server` host is not `--expect-container`, or `--out`'s directory does not exist.
   3. `odataCfg` as `probe.ts` builds it. `artifactId = await odataReadRegisteredArtifact(odataCfg, TARGET_APP_ID)`, `TARGET_APP_ID` = the `id` in `fixtures/sandbox-data/app.json`; refuse unless 32 lowercase hex.
   4. `const probe = await acquireProbeLease(odataCfg)`; `fence = () => ({ epoch, token, serverGeneration, opSeq: probe.nextOpSeq() })` as in `bcdev.itest.ts`'s `runProtocolInvariantProbes`; release in a `finally` as that function does.
   5. `const calls: CallTrace[] = []; const tx = new RunMutantTransport(odataCfg, TARGET_APP_ID, artifactId, traceFetch(bcFetch, calls));`. T ref `{ codeunitId: 79310, codeunitName: "Data Tests", method: "PageActionComputesNonZero" }`; S ref the same codeunit, method `ExtCountRelatedIgnoresDecoys`.
   6. Calibration per §A2, one `tx.runWithCoverage({ ref: S, mutantId: "", attemptId: \`r236s-cal-${i}\`, timeoutMs: 10_000, lease: fence(), coverageObjectIdFilter: f })` per candidate, one `{ kind: "calibration", filter, bytes, ms, errorPhase }` line each.
   7. Loop per §A2 (`timeoutMs: 120_000`, attempt ids `r236s-t-<i>` / `r236s-s-<i>`), one `{ kind: "call", arm, pair, bytesReceived, headersMs, errorPhase, error, outcome, operation }` line per call. After a break: the status read and the preflight; a failed preflight writes `{ kind: "wedge" }` and exits 3.
   8. Finally `{ kind: "summary", tBreaks, sBreaks, pairsDone, pairsPlanned, sRunnable, reading: readA2(...) }`.
- [ ] **Step 4:** `bun test scripts/r236-baseline-probe/size-arm.test.ts` passes. `bun run typecheck && rm -rf packages/*/dist`. `bunx biome check scripts/r236-baseline-probe/size-arm.ts scripts/r236-baseline-probe/size-arm.test.ts`. Without the env var it prints `skipped`.
- [ ] **Step 5: Commit** `measure(R236b): non-TestPage arm for the grouped-path decision`.

### Task 3: run §A2 on Cronus284 and fill its OUTCOME

- [ ] **Step 1** **[pwsh]** `pwsh -File U:\Git\agent-coord\containers.ps1 status -Names Cronus284`; not running: `coord ask`, stop. **[bash]** `coord lease Cronus284 bugs`, heartbeat. **[pwsh]** `Get-BcContainerAppInfo -containerName Cronus284 -tenantSpecificProperties | Select Name,Version,IsInstalled` shows `LethAL Control` 1.0.0.19 installed; save it to `C:/Users/SShadowS/AppData/Local/Temp/r236b/before-284.txt` (`mkdir -p` first).
- [ ] **Step 2** **[bash]** publish the target with one probe session: `LETHAL_R236_PROBE=1 bun scripts/r236-baseline-probe/probe.ts --arm a2-prep --sessions 1 --out C:/Users/SShadowS/AppData/Local/Temp/r236b/a2-prep.ndjson`; its record's `container` must be `Cronus284`.
- [ ] **Step 3** **[bash]** `LETHAL_R236_SIZE_ARM=1 bun scripts/r236-baseline-probe/size-arm.ts --config <the Cronus284 sandbox-data config> --expect-container Cronus284 --pairs 60 --out C:/Users/SShadowS/AppData/Local/Temp/r236b/a2.ndjson`. Exit 3 (wedge): `coord ask` with the file's last lines; stop.
- [ ] **Step 4** `coord release Cronus284 bugs`.
- [ ] **Step 5** Fill §OUTCOME's A2 part word for word: calibration, per-arm breaks over actual n, every break's bytes, headers time and op status, wedges, the reading. Commit `measure(R236b): non-TestPage arm, read-out`. The reading decides whether Tasks 4 step 5 and 6b run.

---

# Phase B: the fix

### Task 4: control app 1.0.0.20, the kept answer and `GetOpAnswer`

**Files:**
- Create: `extensions/lethal-control/src/OpAnswer.Table.al`
- Modify: `extensions/lethal-control/src/ControlApi.Codeunit.al` (`RunMutant` about line 546, `RunMutantWithCoverage` about line 142, `RunMutantMany` about line 621, new procedures after `GetOperationStatus` about line 344)
- Modify: `extensions/lethal-control/app.json` (`1.0.0.20`), `packages/runner/src/harness.ts:78`

**Interfaces:**
- Produces (wire): action `LethALControl_GetOpAnswer`, body `{ epoch: number, generation: string, attemptId: string, opSeq: number }`; `value` is `{ found: true, attemptId, opSeq, epoch, generation, answer }` or `{ found: false, keptAttemptId?, keptOpSeq? }`. `answer` is byte-for-byte the text the action returned. Only answers with top-level status `ran` are ever kept.

- [ ] **Step 1: The table.**

```al
namespace LethAL.Control;

/// <summary>R236b: the last answer of a RunMutant, RunMutantWithCoverage (or, when R236b's Phase A
/// requires it, RunMutantMany) call that RAN tests, kept so a client whose HTTP reply was lost after
/// the headers can read it back instead of quarantining the run. MEASURED (R236, 2026-09-26): BC sent
/// 200 headers and then lost the END of the reply on the TestPage baseline call.
///
/// Written and COMMITTED as the action's last statement, and ONLY for an answer that ran: a refusal
/// (including a same-key duplicate the fence refuses) writes nothing, so it can never overwrite the
/// answer of the op that did run. A committed row proves the action's AL answer construction
/// completed. It does NOT prove the HTTP request or the session ended: returning the text, the
/// platform's response handling and session teardown still follow.</summary>
table 91013 "LC Op Answer"
{
    DataClassification = SystemMetadata;
    DataPerCompany = false;
    // Same reasoning as "LC Lease": the OData runner session runs as the calling user.
    InherentPermissions = RIMD;

    fields
    {
        field(1; "Primary Key"; Code[10]) { }
        field(2; "Attempt Id"; Text[64]) { }
        field(3; "Op Seq"; BigInteger) { }
        field(4; "Lease Epoch"; Integer) { }
        field(5; "Server Generation"; Text[32]) { }
        field(6; "Kept At"; DateTime) { }
        field(7; Answer; Blob) { }
    }

    keys
    {
        key(PK; "Primary Key") { Clustered = true; }
    }
}
```

- [ ] **Step 2: `RunMutant` becomes a wrapper around `RunMutantCore`, which reports whether it ran.** Rename the existing `procedure RunMutant(...) ResultJson: Text` to `local procedure RunMutantCore(TargetAppId: Text; ArtifactId: Text; AttemptId: Text; MutantId: Text; TestCodeunitId: Integer; TestMethod: Text; LeaseEpoch: Integer; LeaseToken: Text; ServerGeneration: Text; OpSeq: BigInteger; var Ran: Boolean) ResultJson: Text`. First statement `Ran := false;`; immediately before the final `exit(BuildStatus('ran', ...))` add `Ran := true;`. Every other exit leaves it false. The doc comment stays on the public wrapper:

```al
    procedure RunMutant(TargetAppId: Text; ArtifactId: Text; AttemptId: Text; MutantId: Text; TestCodeunitId: Integer; TestMethod: Text; LeaseEpoch: Integer; LeaseToken: Text; ServerGeneration: Text; OpSeq: BigInteger) ResultJson: Text
    var
        Ran: Boolean;
    begin
        ResultJson := RunMutantCore(TargetAppId, ArtifactId, AttemptId, MutantId, TestCodeunitId, TestMethod, LeaseEpoch, LeaseToken, ServerGeneration, OpSeq, Ran);
        if Ran then
            KeepAnswer(AttemptId, OpSeq, LeaseEpoch, ServerGeneration, ResultJson);
    end;
```

- [ ] **Step 3: `RunMutantWithCoverage`.** Add `Ran: Boolean;` to its vars; `Raw := RunMutantCore(..., OpSeq, Ran);` (it used to call `RunMutant`, which would now keep the answer before coverage is attached). The `if not Obj.ReadFrom(Raw) then exit(Raw);` exit stays unchanged (nothing kept). Replace the final `exit(Out);` with:

```al
        if Ran then
            KeepAnswer(AttemptId, OpSeq, LeaseEpoch, ServerGeneration, Out);
        exit(Out);
```

- [ ] **Step 4: `KeepAnswer` and `GetOpAnswer`**, after `GetOperationStatus`:

```al
    /// <summary>R236b: keep Answer as op (AttemptId, OpSeq)'s committed answer. Callers call it ONLY
    /// for an answer that ran, and ONLY as the last statement before exit: its Commit is what makes a
    /// read-back row mean "the AL answer construction completed".</summary>
    local procedure KeepAnswer(AttemptId: Text; OpSeq: BigInteger; LeaseEpoch: Integer; ServerGeneration: Text; Answer: Text)
    var
        Kept: Record "LC Op Answer";
        OutS: OutStream;
    begin
        if not Kept.Get('') then begin
            Kept.Init();
            Kept."Primary Key" := '';
            Kept.Insert();
        end;
        Kept."Attempt Id" := CopyStr(AttemptId, 1, MaxStrLen(Kept."Attempt Id"));
        Kept."Op Seq" := OpSeq;
        Kept."Lease Epoch" := LeaseEpoch;
        Kept."Server Generation" := CopyStr(ServerGeneration, 1, MaxStrLen(Kept."Server Generation"));
        Kept."Kept At" := CurrentDateTime();
        Kept.Answer.CreateOutStream(OutS, TextEncoding::UTF8);
        OutS.WriteText(Answer);
        Kept.Modify();
        Commit();
    end;

    /// <summary>OData action (R236b): the kept answer, only if the row names exactly this op under this
    /// lease. Echoes all four key values so the client verifies them itself. Read COMMITTED, so a row
    /// inside an uncommitted transaction is never returned. JSON: {found:true, attemptId, opSeq, epoch,
    /// generation, answer} or {found:false, keptAttemptId?, keptOpSeq?}.</summary>
    procedure GetOpAnswer(Epoch: Integer; Generation: Text; AttemptId: Text; OpSeq: BigInteger) ResultJson: Text
    var
        Kept: Record "LC Op Answer";
        InS: InStream;
        Part: Text;
        Answer: Text;
        Obj: JsonObject;
    begin
        Kept.ReadIsolation := IsolationLevel::ReadCommitted;
        if not Kept.Get('') then begin
            Obj.Add('found', false);
            Obj.WriteTo(ResultJson);
            exit;
        end;
        if (Kept."Attempt Id" <> AttemptId) or (Kept."Op Seq" <> OpSeq) or (Kept."Lease Epoch" <> Epoch) or (Kept."Server Generation" <> Generation) then begin
            Obj.Add('found', false);
            Obj.Add('keptAttemptId', Kept."Attempt Id");
            Obj.Add('keptOpSeq', Kept."Op Seq");
            Obj.WriteTo(ResultJson);
            exit;
        end;
        Kept.CalcFields(Answer);
        Kept.Answer.CreateInStream(InS, TextEncoding::UTF8);
        // Compact JSON (JsonObject.WriteTo) holds no raw line break, so ReadText loses nothing.
        while not InS.EOS() do begin
            InS.ReadText(Part);
            Answer += Part;
        end;
        Obj.Add('found', true);
        Obj.Add('attemptId', Kept."Attempt Id");
        Obj.Add('opSeq', Kept."Op Seq");
        Obj.Add('epoch', Kept."Lease Epoch");
        Obj.Add('generation', Kept."Server Generation");
        Obj.Add('answer', Answer);
        Obj.WriteTo(ResultJson);
    end;
```

- [ ] **Step 5 (ONLY if §A2 read "grouped fix required"): `RunMutantMany` keeps a clean `ran` answer.** Replace its final `exit(BuildManyStatus('ran', ...));` with:

```al
        ResultJson := BuildManyStatus('ran', TargetAppId, ArtifactId, AttemptId, MutantId, GroupResults, RunError, ObservedAny, IdentityMismatch, '', TestRunsBefore);
        // R236b: only a clean ran answer; a runError answer is not a verdict set and is never kept.
        if RunError = '' then
            KeepAnswer(AttemptId, OpSeq, LeaseEpoch, ServerGeneration, ResultJson);
```

   Its refusal, `suite-unresolved` and displaced exits keep nothing.
- [ ] **Step 6: Versions.** `app.json` `"version": "1.0.0.20"`; `harness.ts` `export const MIN_CONTROL_VERSION = "1.0.0.20";`. **[bash]** `bun test packages/runner/tests/harness.test.ts` passes (if it pins the literal `1.0.0.19`, update that literal only).
- [ ] **Step 7: Compile** with `/al-compile extensions/lethal-control`. Any diagnostic is a stop. Stage per `.claude/skills/control-app` steps 1 and 2. Do not publish yet (Task 9).
- [ ] **Step 8: Commit** `feat(control): ran answers are kept and committed last, GetOpAnswer reads them back with their key (R236b, 1.0.0.20)` (add the versioned `.app` only if earlier ones are tracked: `git ls-files "extensions/lethal-control/*.app"`).

### Task 5: extract `scoreAnswer` from `dispatch` (pure refactor)

**Files:** Modify `packages/runner/src/run-mutant-transport.ts` (`dispatch`, from `let result: RunMutantResult;` at about line 1352 to its end).

**Interfaces:** Produces `private scoreAnswer(value: string, req: RunMutantRequest, collectCoverage: boolean, sink: { rows?: readonly FencedCoverageRow[]; stats?: FencedCoverageStats }, durationMs: number, fencedOp: { readonly attemptId: string; readonly opSeq: number }): TestVerdict`.

- [ ] **Step 1:** Move every statement from `let result: RunMutantResult;` through `return v.outcome === "error" ? v : { ...v, ...session };` into `scoreAnswer`, reading `ref` as `req.ref`. `dispatch` ends with `return this.scoreAnswer(value, req, collectCoverage, sink, durationMs, fencedOp);`.
- [ ] **Step 2** **[bash]** `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/run-mutant-transport.test.ts packages/runner/tests/bcdev-backend.test.ts`: green, no test edited.
- [ ] **Step 3: Commit** `refactor(runner): scoreAnswer, the answer parser a readback can reuse (R236b)`.

### Task 6: the readback in the transport (single-op path)

**Files:**
- Modify: `packages/runner/src/backend.ts` (`TestVerdict`, after `fencedOp`), `packages/runner/src/run-mutant-transport.ts` (`postAction`, new `readKeptAnswer`, `execute`, new `recoverKeptAnswer`)
- Test: `packages/runner/tests/run-mutant-transport.test.ts` (new describe at the end)

**Interfaces:**
- Consumes: `scoreAnswer` (Task 5); `LeaseTuple`; `describeThrown` (already imported from `./describe-error`).
- Produces: `TestVerdict.replyRecovered?: string`; `export const KEPT_ANSWER_READ_MS = 15_000`; public `readKeptAnswer(lease: LeaseTuple, attemptId: string, opSeq: number, timeoutMs: number): Promise<KeptAnswer>` with `export type KeptAnswer = { readonly found: true; readonly answer: string } | { readonly found: false; readonly keptAttemptId?: string; readonly keptOpSeq?: number }` (Tasks 6b and 8 use both). `readKeptAnswer` throws on a transport fault, a shape fault, or an echo that does not equal the request.

- [ ] **Step 1: Failing tests.** Append:

```ts
describe("RunMutantTransport: a lost reply is read back from the committed answer (R236b)", () => {
  const FENCE = { attemptId: "a1", opSeq: 7 };
  const CLR = "Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not supported. at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()";
  const FAILED = echo({
    codeunitResults: JSON.stringify({
      testResults: [{ method: "OverBudgetDetected", result: 1, message: CLR }],
    }),
  });
  const wrap = (inner: Record<string, unknown>) => JSON.stringify({ value: JSON.stringify(inner) });
  /** The live shape: everything but the envelope's final `}`. */
  const TRUNCATED = wrap(FAILED).slice(0, -1);
  const KEY = { attemptId: "a1", opSeq: 7, epoch: 3, generation: "gen-1" };
  type Kept = { readonly status: number; readonly body: string } | "throw" | "hang";
  const found = (answer: string, key: Record<string, unknown> = KEY): Kept => ({
    status: 200,
    body: wrap({ found: true, ...key, answer }),
  });

  function routed(run: "truncated" | "stall" | "ok", kept: Kept, calls: string[], bodies: unknown[] = []): typeof fetch {
    return (async (url: unknown, init?: RequestInit) => {
      const action = /ODataV4\/LethALControl_(\w+)/.exec(String(url))?.[1] ?? String(url);
      calls.push(action);
      if (action === "GetOpAnswer") {
        bodies.push(JSON.parse(String(init?.body)));
        if (kept === "throw") throw new Error("ECONNRESET");
        if (kept === "hang") {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return new Response(kept.body, { status: kept.status });
      }
      if (run === "ok") return new Response(wrap(FAILED), { status: 200 });
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(TRUNCATED));
          if (run === "truncated") c.error(new Error("The socket connection was closed unexpectedly."));
          else signal?.addEventListener("abort", () => c.error(new Error("The operation was aborted.")), { once: true });
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
  }
  const keptUnknown = (v: { operation?: unknown; fencedOp?: unknown; replyRecovered?: unknown }) => {
    expect(v.operation).toBe("in-flight-unknown");
    expect(v.fencedOp).toEqual(FENCE);
    expect(v.replyRecovered).toBeUndefined();
  };

  test("1. body lost, kept answer is a completed fail: it is the verdict, no second RunMutant is sent", async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const v = await transport(routed("truncated", found(JSON.stringify(FAILED)), calls, bodies)).run(REQ);
    expect(v.outcome).toBe("fail");
    expect(v.operation).toBeUndefined();
    expect(v.fencedOp).toBeUndefined();
    expect(v.failureMessage).toContain("CreateNavTestService");
    expect(v.replyRecovered).toContain("2xx body could not be read");
    expect(calls).toEqual(["RunMutant", "GetOpAnswer"]);
    expect(bodies).toEqual([{ epoch: 3, generation: "gen-1", attemptId: "a1", opSeq: 7 }]);
  });

  test("2. body stalls until the budget: the kept completed pass is the verdict", async () => {
    const calls: string[] = [];
    const v = await transport(routed("stall", found(JSON.stringify(echo())), calls)).run({ ...REQ, timeoutMs: 30 });
    expect(v.outcome).toBe("pass");
    expect(v.replyRecovered).toContain("timed out after headers");
    expect(calls).toEqual(["RunMutant", "GetOpAnswer"]);
  });

  test("3. no committed answer for this op: in-flight-unknown stays and says what the server holds", async () => {
    const kept: Kept = { status: 200, body: wrap({ found: false, keptAttemptId: "a0", keptOpSeq: 6 }) };
    const v = await transport(routed("truncated", kept, [])).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("2xx body could not be read");
    expect(v.failureMessage).toContain("answer readback: the server holds no committed answer for a1/7 (it holds a0/6)");
  });

  test("4. the readback throws: in-flight-unknown stays", async () => {
    const v = await transport(routed("truncated", "throw", [])).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("answer readback failed");
  });

  test("5. the readback hangs: bounded by the call's budget, then in-flight-unknown", async () => {
    const started = Date.now();
    const v = await transport(routed("truncated", "hang", [])).run({ ...REQ, timeoutMs: 30 });
    keptUnknown(v);
    expect(v.failureMessage).toContain("answer readback failed");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("6. a kept answer that is not JSON is never accepted", async () => {
    const v = await transport(routed("truncated", found("{{{"), [])).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("answer readback not accepted");
  });

  test("7. a kept answer naming another attempt is never accepted", async () => {
    const v = await transport(routed("truncated", found(JSON.stringify(echo({ attemptId: "a9" }))), [])).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("identity mismatch");
  });

  test("8. a kept REFUSAL for the same key (a same-key duplicate) is never accepted", async () => {
    const refusal = echo({ status: "lease-invalid", reason: "op-in-flight", codeunitResults: "" });
    const v = await transport(routed("truncated", found(JSON.stringify(refusal)), [])).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("answer readback not accepted");
  });

  test("9. a kept lease-lost answer is never accepted", async () => {
    const lost = echo({ status: "lease-invalid", codeunitResults: "" });
    const v = await transport(routed("truncated", found(JSON.stringify(lost)), [])).run(REQ);
    keptUnknown(v);
  });

  test("10. a well-formed ran answer with a malformed RESULT (zero test lines) is never accepted", async () => {
    const empty = echo({ codeunitResults: JSON.stringify({ testResults: [] }) });
    const v = await transport(routed("truncated", found(JSON.stringify(empty)), [])).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("answer readback not accepted");
  });

  test("11. a kept answer under another lease (echoed epoch or generation differs) is never accepted", async () => {
    for (const key of [{ ...KEY, epoch: 4 }, { ...KEY, generation: "gen-2" }, { ...KEY, opSeq: 8 }]) {
      const v = await transport(routed("truncated", found(JSON.stringify(FAILED), key), [])).run(REQ);
      keptUnknown(v);
      expect(v.failureMessage).toContain("answer readback failed");
    }
  });

  test("12. a PARTIAL readback body is never accepted", async () => {
    const partial: Kept = { status: 200, body: wrap({ found: true, ...KEY, answer: JSON.stringify(FAILED) }).slice(0, -1) };
    const v = await transport(routed("truncated", partial, [])).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("answer readback failed");
  });

  test("13. a reply that arrives whole never reads back", async () => {
    const calls: string[] = [];
    const v = await transport(routed("ok", "throw", calls)).run(REQ);
    expect(v.outcome).toBe("fail");
    expect(v.replyRecovered).toBeUndefined();
    expect(calls).toEqual(["RunMutant"]);
  });

  test("14. runWithCoverage: the kept answer's coverage rows come back", async () => {
    const withCov = { ...FAILED, coverage: [{ objectType: 5, objectId: 79300, lineNo: 10, hits: 1 }], coverageRunMs: 1, coverageSerializeMs: 1, coverageScannedRows: 1, coverageEmittedRows: 1 };
    const r = await transport(routed("truncated", found(JSON.stringify(withCov)), [])).runWithCoverage(REQ);
    expect(r.verdict.outcome).toBe("fail");
    expect(r.coverageRows).toHaveLength(1);
  });

  test("15. runWithCoverage: a malformed kept coverage array is never accepted, and leaves no rows", async () => {
    const bad = { ...FAILED, coverage: "not-an-array" };
    const r = await transport(routed("truncated", found(JSON.stringify(bad)), [])).runWithCoverage(REQ);
    keptUnknown(r.verdict);
    expect(r.coverageRows).toBeUndefined();
  });
});
```

   Test 14's coverage row must match what `parseCoverageRows` accepts; read it first and adjust ONLY the row literal if it differs.
- [ ] **Step 2** **[bash]** `bun test packages/runner/tests/run-mutant-transport.test.ts -t "R236b"`. Expected: 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 14 and 15 FAIL (no readback, so no `replyRecovered`, no readback text, one call). 9 and 13 pass already; 13 pins that a whole reply is untouched, 9 pins the fail-closed default before and after.
- [ ] **Step 3: Implement.**

   (a) `backend.ts`, in `TestVerdict` after `fencedOp`:

```ts
  /**
   * R236b: set when the HTTP reply was lost and this verdict was scored from the answer the control
   * app committed as the action's last statement (`GetOpAnswer`). Only ever set on an identity-checked
   * `pass` or `fail`. The value is the lost reply's own failure text, so the incident stays visible.
   * The readback dispatched nothing; the verdict is the original call's own.
   */
  readonly replyRecovered?: string;
```

   (b) `postAction` gains an optional bound that covers the body read too:

```ts
  private async postAction(
    action: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ company: this.cfg.company });
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    const url = `${this.cfg.baseUrl}/ODataV4/LethALControl_${action}?${params.toString()}`;
    // Manual controller, not AbortSignal.timeout(): see the note in `dispatch`.
    const controller = new AbortController();
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        ...(timeoutMs !== undefined ? { signal: controller.signal } : {}),
      });
      /* the existing lines from `if (!res.ok)` through `return parsed as Record<string, unknown>;`, unchanged */
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
```

   (c) Module level and beside `getOperationStatus`:

```ts
export const KEPT_ANSWER_READ_MS = 15_000;

export type KeptAnswer =
  | { readonly found: true; readonly answer: string }
  | { readonly found: false; readonly keptAttemptId?: string; readonly keptOpSeq?: number };

  /**
   * R236b: the answer the control app committed as the last statement of an action that RAN, only if
   * it names exactly this op under this lease. The server's echo of all four key values is checked
   * here; any disagreement, transport fault or shape fault throws, and every caller fails closed on
   * a throw.
   */
  async readKeptAnswer(
    lease: LeaseTuple,
    attemptId: string,
    opSeq: number,
    timeoutMs: number,
  ): Promise<KeptAnswer> {
    assertAttemptId(attemptId);
    const parsed = await this.postAction(
      "GetOpAnswer",
      { epoch: lease.epoch, generation: lease.serverGeneration, attemptId, opSeq },
      timeoutMs,
    );
    if (parsed.found === false) {
      const { keptAttemptId, keptOpSeq } = parsed;
      return {
        found: false,
        ...(typeof keptAttemptId === "string" ? { keptAttemptId } : {}),
        ...(typeof keptOpSeq === "number" ? { keptOpSeq } : {}),
      };
    }
    if (parsed.found !== true) {
      throw new Error(`GetOpAnswer returned no boolean found: ${JSON.stringify(parsed).slice(0, 300)}`);
    }
    const mismatches: string[] = [];
    if (parsed.attemptId !== attemptId) mismatches.push(`attemptId ${JSON.stringify(parsed.attemptId)}`);
    if (parsed.opSeq !== opSeq) mismatches.push(`opSeq ${JSON.stringify(parsed.opSeq)}`);
    if (parsed.epoch !== lease.epoch) mismatches.push(`epoch ${JSON.stringify(parsed.epoch)}`);
    if (parsed.generation !== lease.serverGeneration) mismatches.push(`generation ${JSON.stringify(parsed.generation)}`);
    if (mismatches.length > 0) {
      throw new Error(`GetOpAnswer echoed a different key (${mismatches.join(", ")}) for ${attemptId}/${opSeq}`);
    }
    if (typeof parsed.answer !== "string") {
      throw new Error("GetOpAnswer said found but carried no string answer");
    }
    return { found: true, answer: parsed.answer };
  }
```

   (d) `execute` and the recovery step:

```ts
  private async execute(
    req: RunMutantRequest,
    collectCoverage: boolean,
  ): Promise<RunMutantWithCoverageResult> {
    const sink: { rows?: readonly FencedCoverageRow[]; stats?: FencedCoverageStats } = {};
    const first = await this.dispatch(req, collectCoverage, sink);
    // R236b: every exit that could not read the server's answer asks for the answer the server
    // committed. One place, so no exit is forgotten.
    const verdict =
      first.operation === "in-flight-unknown" && first.fencedOp !== undefined
        ? await this.recoverKeptAnswer(req, collectCoverage, sink, first, first.fencedOp)
        : first;
    return {
      verdict,
      ...(sink.rows !== undefined ? { coverageRows: sink.rows } : {}),
      ...(sink.stats !== undefined ? { coverageStats: sink.stats } : {}),
    };
  }

  /**
   * R236b. Replaces a lost reply ONLY with an identity-checked `pass` or `fail` scored from the
   * server's committed answer for exactly this op and lease. Anything else keeps `lost`, with the
   * reason appended, and the caller handles it exactly as before (a baseline quarantines; a mutant
   * call goes to the unchanged lost-ack reconcile). Dispatches nothing itself.
   */
  private async recoverKeptAnswer(
    req: RunMutantRequest,
    collectCoverage: boolean,
    sink: { rows?: readonly FencedCoverageRow[]; stats?: FencedCoverageStats },
    lost: TestVerdict,
    fencedOp: { readonly attemptId: string; readonly opSeq: number },
  ): Promise<TestVerdict> {
    const lostText = lost.failureMessage ?? "no detail";
    const keep = (why: string): TestVerdict => {
      delete sink.rows;
      delete sink.stats;
      return { ...lost, failureMessage: `${lostText}; ${why}` };
    };
    let kept: KeptAnswer;
    try {
      // ponytail: one read, bounded by the call's own budget (15 s at most); a throttled server
      // fails closed. A second read is the upgrade if C1 shows closed-on-timeout readbacks.
      kept = await this.readKeptAnswer(
        req.lease,
        fencedOp.attemptId,
        fencedOp.opSeq,
        Math.min(KEPT_ANSWER_READ_MS, req.timeoutMs),
      );
    } catch (err) {
      return keep(`answer readback failed: ${describeThrown(err)}`);
    }
    if (!kept.found) {
      const holds =
        kept.keptAttemptId !== undefined && kept.keptOpSeq !== undefined
          ? ` (it holds ${kept.keptAttemptId}/${kept.keptOpSeq})`
          : "";
      return keep(
        `answer readback: the server holds no committed answer for ${fencedOp.attemptId}/${fencedOp.opSeq}${holds}`,
      );
    }
    let v: TestVerdict;
    try {
      // `parseCoverageRows` throws `FencedCoverageError` on a malformed coverage array; from a
      // readback that is one more answer not accepted, never a thrown session.
      v = this.scoreAnswer(kept.answer, req, collectCoverage, sink, lost.durationMs, fencedOp);
    } catch (err) {
      return keep(`answer readback not accepted: ${describeThrown(err)}`);
    }
    // Ruling C1: only a completed, identity-checked pass or fail replaces an unknown.
    if ((v.outcome !== "pass" && v.outcome !== "fail") || v.operation !== undefined) {
      return keep(`answer readback not accepted (${v.outcome}${v.operation !== undefined ? `, ${v.operation}` : ""}): ${v.failureMessage ?? "no detail"}`);
    }
    return { ...v, replyRecovered: lostText };
  }
```

- [ ] **Step 4** **[bash]** `bun run typecheck && rm -rf packages/*/dist && bun test`. All fifteen R236b tests pass. For each newly failing EXISTING test, the ONLY allowed edit is to expect the one extra `GetOpAnswer` POST or the `; answer readback ...` suffix (prefer `toContain` / `toStartWith`); list each such test in the commit body. Any other failure is a stop.
- [ ] **Step 5: Red-checks** (`mutation-red-checker`), restoring after each, both outputs recorded:
   (a) in `execute`, `const verdict = first;`: tests 1, 2, 14 go red.
   (b) replace the pass/fail acceptance condition with `v.operation === "in-flight-unknown"`: tests 8 and 10 go red.
   (c) delete the four echo comparisons in `readKeptAnswer`: test 11 goes red.
   (d) pass `undefined` instead of the bound: test 5 goes red (Bun's 5 s test timeout).
   (e) remove the `try`/`catch` around `scoreAnswer`: test 15 goes red.
   (f) replace `keep(...)` with `lost` in the `!kept.found` branch: test 3 goes red.
- [ ] **Step 6:** `bunx biome check packages/runner/src/run-mutant-transport.ts packages/runner/src/backend.ts packages/runner/tests/run-mutant-transport.test.ts`.
- [ ] **Step 7: Commit** `fix(R236b): a lost RunMutant reply is read back, accepted only as an identity-checked pass or fail, no dispatch of its own`.

### Task 6b (ONLY if §A2 read "grouped fix required"): the same readback for `RunMutantMany`

**Files:** Modify `packages/runner/src/run-mutant-transport.ts` (`runMany` about line 549); Test: `packages/runner/tests/run-mutant-transport.test.ts`, `packages/runner/tests/orchestrator.test.ts`.

**Interfaces:**
- Consumes: `readKeptAnswer`, `KeptAnswer`, `KEPT_ANSWER_READ_MS` (Task 6); `announceRecovered` (Task 7).
- Produces (step 1, pure refactor): `private callOf(methods: readonly GroupMethod[]): (verdict: TestVerdict, extra?: { cause?: GroupCause; abortSession?: string }) => RunMutantManyResult` (today's `methodIndexOf` and `call` closures, hoisted unchanged) and `private scoreManyAnswer(value: string, ctx: { readonly req: RunMutantManyRequest; readonly firstMethod: GroupMethod; readonly call: (verdict: TestVerdict, extra?: { cause?: GroupCause; abortSession?: string }) => RunMutantManyResult; readonly durationMs: number; readonly fencedOp: { readonly attemptId: string; readonly opSeq: number } }): RunMutantManyResult`. It reads `methods`, `attemptId` and `mutantId` from `ctx.req` and everything else from `ctx`; nothing is captured from `runMany`'s scope. From step 4 on, each recovered verdict carries `replyRecovered`.

- [ ] **Step 1: Pure refactor, its own commit, BEFORE any recovery code.** Hoist `methodIndexOf`/`call` into `callOf`; in `runMany`, `const call = this.callOf(methods);`. Move every statement from `let result: RunMutantManyAnswer;` to the end of `runMany` into `scoreManyAnswer`, replacing each use of `call`, `firstMethod`, `methods`, `attemptId`, `mutantId`, `durationMs` and `fencedOp` with its `ctx` / `ctx.req` counterpart; `runMany` ends with `return this.scoreManyAnswer(value, { req, firstMethod, call, durationMs, fencedOp });`. **[bash]** `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/run-mutant-transport.test.ts packages/runner/tests/orchestrator.test.ts`: green with NO test edited. Commit `refactor(runner): scoreManyAnswer takes its context explicitly (R236b)`.
- [ ] **Step 2: Failing tests.** New describe `RunMutantTransport.runMany: a lost reply is read back (R236b)`, using the existing `runMany` tests' request and `ran`-answer builders (two methods) and a routed fake like Task 6's (`LethALControl_RunMutantMany` answers as configured, `GetOpAnswer` as configured; the watchdog's `GetOperationStatus` polls are filtered out of `calls` before comparing). Tests:
   1. truncated body, kept clean `ran` answer with two `pass` entries: `kind: "verdicts"`, both `pass` with `replyRecovered`, `calls` exactly `["RunMutantMany", "GetOpAnswer"]`;
   2. kept answer with a `runError`: `kind: "call"`, `operation: "in-flight-unknown"`, message contains `answer readback not accepted`;
   3. kept `lease-invalid` refusal: same as 2;
   4. `found: false`: same, message names what the server holds;
   5. echoed epoch differs: same, message contains `answer readback failed`;
   6. a whole reply never reads back;
   7. **identity disagreement**: reuse the existing `runMany` identity-disagreement test's fake (find it with `grep -n "identity disagreement" packages/runner/tests/run-mutant-transport.test.ts`), with `GetOpAnswer` routed to a VALID kept answer: the result is `kind: "call"` whose `abortSession` equals that existing test's expectation, and `calls` contains no `GetOpAnswer`;
   8. **unexpected 404**: `RunMutantMany` answers 404, `GetOpAnswer` a valid kept answer: `abortSession` starts `control-app-route-missing`, and no `GetOpAnswer` call.
- [ ] **Step 3** Run; 1 to 5 fail (no readback yet); 6, 7 and 8 pass already and pin that the recovery must leave them alone.
- [ ] **Step 4: Implement.** Rename the refactored `runMany` body to `private async runManyOnce(req: RunMutantManyRequest): Promise<RunMutantManyResult>`, and:

```ts
  async runMany(req: RunMutantManyRequest): Promise<RunMutantManyResult> {
    const first = await this.runManyOnce(req);
    // Review r2 ruling C2: a call that must abort the session is never replaced, whatever the
    // kept answer says.
    if (
      first.kind !== "call" ||
      first.abortSession !== undefined ||
      first.verdict.operation !== "in-flight-unknown" ||
      first.verdict.fencedOp === undefined
    ) {
      return first;
    }
    const lost = first.verdict;
    const fencedOp = first.verdict.fencedOp;
    const lostText = lost.failureMessage ?? "no detail";
    const keep = (why: string): RunMutantManyResult => ({
      ...first,
      verdict: { ...lost, failureMessage: `${lostText}; ${why}` },
    });
    const [firstMethod] = req.methods;
    if (firstMethod === undefined) {
      throw new Error("RunMutantMany: a call with no methods is a caller-contract violation");
    }
    let kept: KeptAnswer;
    try {
      // `KEPT_ANSWER_READ_MS` alone bounds this read: a group's budget is minutes.
      kept = await this.readKeptAnswer(req.lease, fencedOp.attemptId, fencedOp.opSeq, KEPT_ANSWER_READ_MS);
    } catch (err) {
      return keep(`answer readback failed: ${describeThrown(err)}`);
    }
    if (!kept.found) {
      const holds =
        kept.keptAttemptId !== undefined && kept.keptOpSeq !== undefined
          ? ` (it holds ${kept.keptAttemptId}/${kept.keptOpSeq})`
          : "";
      return keep(
        `answer readback: the server holds no committed answer for ${fencedOp.attemptId}/${fencedOp.opSeq}${holds}`,
      );
    }
    let r: RunMutantManyResult;
    try {
      r = this.scoreManyAnswer(kept.answer, {
        req,
        firstMethod,
        call: this.callOf(req.methods),
        durationMs: lost.durationMs,
        fencedOp,
      });
    } catch (err) {
      return keep(`answer readback not accepted: ${describeThrown(err)}`);
    }
    // Ruling C1, grouped form: only a verdict set of completed, identity-checked passes and fails.
    if (
      r.kind !== "verdicts" ||
      r.verdicts.some((v) => (v.outcome !== "pass" && v.outcome !== "fail") || v.operation !== undefined)
    ) {
      return keep("answer readback not accepted: not a verdict set of completed passes and fails");
    }
    return { ...r, verdicts: r.verdicts.map((v) => ({ ...v, replyRecovered: lostText })) };
  }
```

- [ ] **Step 5** Full loop green; existing `runMany` tests change only for the extra `GetOpAnswer` POST or the `; answer readback ...` suffix (listed in the commit body).
- [ ] **Step 6: The two paths in the orchestrator, grouped.** In `orchestrator.test.ts`, beside the existing `runFencedMany` lost-ack tests (find them with `grep -n "RunMutantMany\|runMany" packages/runner/tests/orchestrator.test.ts`) and with their fake setup: (a) a grouped call whose `runMany` returns `kind: "verdicts"` carrying `replyRecovered`: exactly one `runMany` dispatch for that chunk, no `lost-ack-*` warning, and a `lost-reply-recovered` warning (call `announceRecovered(v, emit)` for each verdict where `runFencedMany`'s caller records grouped verdicts; this assertion fails until then); (b) a grouped call whose `runMany` returns the lost `call` with `; answer readback failed` appended and a tombstoned marker: the existing reconcile runs unchanged, one fresh attempt of the whole chunk, the existing `lost-ack-retry` warning, no `lost-reply-recovered`. (b) is a characterisation of existing behaviour and passes before and after.
- [ ] **Step 7: Red-checks:** remove the readback (`return first;` straight after `runManyOnce`): transport test 1 and step 6 (a) go red. Replace the acceptance condition with `false` (always accept): tests 2 and 3 go red. Delete `first.abortSession !== undefined ||`: tests 7 and 8 go red, provided both exits carry `operation: "in-flight-unknown"` (confirm by reading `abortedVerdict` and the 404 branch first; if one does not, say so and keep the guard as defence in depth).
- [ ] **Step 8: Commit** `fix(R236b): RunMutantMany reads a lost reply back, accepted only as completed passes and fails, never over an abortSession`.

### Task 7: the recovery is announced where every single-op verdict passes

**Files:** Modify `packages/runner/src/orchestrator.ts` (`runOnce` about line 7190; callers `runFenced` about lines 1858 and 1900, `dispatchUnmutated` about line 3275); Test: `packages/runner/tests/orchestrator.test.ts` (new describe after the one holding `a BASELINE test returning in-flight-unknown records a durable quarantine`, about line 5354).

**Interfaces:** Consumes `TestVerdict.replyRecovered`. Produces `export function announceRecovered(v: TestVerdict, emit: RunEmitter | undefined): void`, `runOnce(backend, safety, ref, opts, resyncOpSeq?, emit?: RunEmitter)`, warning code `lost-reply-recovered`.

- [ ] **Step 1: Failing test.**

```ts
describe("runSession: R236b, a verdict read back after a lost reply", () => {
  test("is the test's verdict, is announced by a lost-reply-recovered warning, and quarantines nothing", async () => {
    const dir = freshTmpDir();
    const events: RunEvent[] = [];
    const backend = fakeBackend({
      capabilities: () => ({ coverage: "none", deploy: "publish", isolation: "session", authoritative: true }),
      run: async (ref) => ({
        ref,
        outcome: "pass",
        durationMs: 1,
        replyRecovered: "RunMutant 2xx body could not be read: The socket connection was closed unexpectedly.",
      }),
    });
    const report = await runSessionForTest(backend, { quarantineDir: dir, emit: [(e) => events.push(e)] });
    expect(report.quarantined).toBeUndefined();
    expect(await new QuarantineStore(dir).read("http://cronus281|BC")).toBeNull();
    const warnings = events.filter((e) => e.type === "warning" && e.code === "lost-reply-recovered");
    expect(warnings.length).toBeGreaterThan(0);
    const [first] = warnings;
    expect(first?.type === "warning" ? first.message : "").toContain("socket connection was closed");
  });
});
```

   Import `RunEvent` as the file's other `emit: [emit]` tests do (about line 2643).
   Then, INSIDE the existing describe whose name ends `a proven-complete lost ack earns one fresh attempt (design §5)` (about line 7183, so `m2Answers`, `tombstoned`, `LOST_ANSWER` and `ATTESTED` are in scope), add the two paths of review r2 ruling C1:

```ts
  test("R236b 2. an ACCEPTED readback short-circuits the reconcile: one dispatch, no lost-ack warning", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.reconcileStatus = tombstoned;
    const { lease } = leaseCfg(client);
    const dispatches = { count: 0 };
    const events: RunEvent[] = [];
    const recovered: Partial<TestVerdict> = {
      outcome: "pass",
      attestation: ATTESTED,
      replyRecovered: "RunMutant 2xx body could not be read: socket closed",
    };
    const report = await runSessionForTest(m2Answers([recovered], dispatches), {
      quarantineDir: dir,
      lease,
      emit: [(e) => events.push(e)],
    });
    const codes = events.flatMap((e) => (e.type === "warning" ? [e.code] : []));
    expect(dispatches.count).toBe(1);
    expect(codes.filter((c) => c.startsWith("lost-ack"))).toEqual([]);
    expect(codes).toContain("lost-reply-recovered");
    expect(report.mutants.find((m) => m.mutantCode === "M0002")?.verdict).toBe("survived");
  });

  test("R236b 3. a FAILED readback reaches the unchanged reconcile and its one existing fresh attempt", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.reconcileStatus = tombstoned;
    const { lease } = leaseCfg(client);
    const dispatches = { count: 0 };
    const events: RunEvent[] = [];
    const failedReadback: Partial<TestVerdict> = {
      ...LOST_ANSWER,
      failureMessage: `${LOST_ANSWER.failureMessage}; answer readback failed: ECONNRESET`,
    };
    const report = await runSessionForTest(
      m2Answers([failedReadback, { outcome: "pass", attestation: ATTESTED }], dispatches),
      { quarantineDir: dir, lease, emit: [(e) => events.push(e)] },
    );
    const codes = events.flatMap((e) => (e.type === "warning" ? [e.code] : []));
    expect(dispatches.count).toBe(2);
    expect(codes).toContain("lost-ack-unreadable");
    expect(codes).toContain("lost-ack-retry");
    expect(codes).not.toContain("lost-reply-recovered");
    expect(report.mutants.find((m) => m.mutantCode === "M0002")?.verdict).toBe("survived");
  });
```

   Test 3 characterises existing behaviour and passes before and after this task: it pins that a failed readback changes nothing downstream. Test 2 fails until step 3 (no `lost-reply-recovered` yet).
- [ ] **Step 2** `bun test packages/runner/tests/orchestrator.test.ts -t "R236b"`: the first new test and test 2 FAIL; test 3 passes.
- [ ] **Step 3: Implement.**

```ts
/** R236b: a verdict read back after a lost reply is a real incident even though it scores. */
export function announceRecovered(v: TestVerdict, emit: RunEmitter | undefined): void {
  if (v.replyRecovered === undefined) return;
  emit?.({
    type: "warning",
    code: "lost-reply-recovered",
    message: `[lethal] ${v.ref.codeunitName}.${v.ref.method}: the HTTP reply was lost (${v.replyRecovered}); the verdict was read back from the answer the server committed as the action's last step, and the test was not dispatched again (R236b)`,
  });
}

export async function runOnce(
  backend: ExecutionBackend,
  safety: SessionSafety,
  ref: TestMethodRef,
  opts: { coverage: CoverageMode; timeoutMs: number },
  resyncOpSeq?: () => Promise<void>,
  emit?: RunEmitter,
): Promise<TestVerdict> {
  safety.assertSafe(`run(${ref.codeunitName}.${ref.method})`);
  let v = await backend.run(ref, opts);
  if (v.outcome === "error" && v.operation !== undefined && isRetrySafe(v.operation)) {
    safety.assertSafe(`run(${ref.codeunitName}.${ref.method}) retry`);
    if (resyncOpSeq !== undefined) await resyncOpSeq();
    v = await backend.run(ref, opts);
  }
  announceRecovered(v, emit);
  return v;
}
```

   Pass `emit` at both `runOnce` calls in `runFenced` and `scope.emit` in `dispatchUnmutated`.
- [ ] **Step 4** `bun test packages/runner/tests/orchestrator.test.ts`: green, no snapshot changes (one that changes: stop and explain).
- [ ] **Step 5: Red-check:** make `announceRecovered`'s body `return;`; the first R236b test and test 2 go red; restore.
- [ ] **Step 6:** full loop; biome on both files; commit `feat(R236b): a read-back verdict is announced as lost-reply-recovered`.

### Task 8: live pins, the kept answer, its key, and a refused duplicate

**Files:** Modify `packages/runner/itest/bcdev.itest.ts` (`runProtocolInvariantProbes`, the "Failure round-trip" probe at about line 339); modify `scripts/r236-baseline-probe/size-arm.ts` (the `--kept-check <n>` mode).

Without these, a control app that stopped keeping answers, or let a refusal overwrite one, would make every future recovery fail closed or read the wrong thing, while the gates stayed green.

- [ ] **Step 1: bcdev.** Capture the fence and add after the probe's existing assertions:

```ts
    const failFence = fence();
    const fail = await tx.run({
      ref: { codeunitId: FAIL_PROBE_ID, codeunitName: "Fail Probe", method: "AlwaysFails" },
      mutantId: "",
      attemptId: "probe-fail",
      timeoutMs: PROBE_TIMEOUT_MS,
      lease: failFence,
    });
    /* existing assertions unchanged */

    // R236b: the committed answer is the one sent, keyed on the op, and a same-key duplicate the
    // fence refuses does not overwrite it.
    const assertKept = async (when: string) => {
      const kept = await tx.readKeptAnswer(failFence, "probe-fail", failFence.opSeq, PROBE_TIMEOUT_MS);
      assert.ok(kept.found, `${when}: GetOpAnswer must hold probe-fail's answer, got ${JSON.stringify(kept)}`);
      if (kept.found) {
        const k = JSON.parse(kept.answer) as { attemptId?: unknown; status?: unknown; codeunitResults?: unknown };
        assert.equal(k.attemptId, "probe-fail", when);
        assert.equal(k.status, "ran", when);
        assert.ok(String(k.codeunitResults).includes("LETHAL-PROBE-FAIL: exact-error-round-trip"), when);
      }
    };
    await assertKept("after the run");
    const dup = await tx.run({
      ref: { codeunitId: FAIL_PROBE_ID, codeunitName: "Fail Probe", method: "AlwaysFails" },
      mutantId: "",
      attemptId: "probe-fail",
      timeoutMs: PROBE_TIMEOUT_MS,
      lease: failFence,
    });
    assert.equal(dup.operation, "lease-lost", `a same-key duplicate must be refused, got ${JSON.stringify(dup)}`);
    await assertKept("after a refused same-key duplicate");
    const other = await tx.readKeptAnswer(failFence, "probe-fail", failFence.opSeq - 1, PROBE_TIMEOUT_MS);
    assert.equal(other.found, false, "GetOpAnswer must refuse an opSeq that is not the kept one");
```

   If the refused duplicate disturbs the later probes (it should not: a refused claim writes no row), move this block to the end of `runProtocolInvariantProbes` and say so in the commit.
- [ ] **Step 2: `size-arm.ts --kept-check <n>`** (C1b). Mode: `n` direct T calls (as in Task 2, filter `79300..79399`, attempt ids `r236s-k-<i>`). Pass the traced fetch an `onBody` hook that calls `keepOriginalBody(bodies, trace, text)`, which stores a body ONLY for the original action (`LethALControl_RunMutant` or `LethALControl_RunMutantWithCoverage`): the later `GetOpAnswer` request carries the SAME attempt id, and an unfiltered map would replace the original body with the readback's before the comparison (review r2, I5). For each call: if its body arrived whole, `const kept = await tx.readKeptAnswer(fence, attemptId, opSeq, 15_000)`; record `{ kind: "kept-check", i, whole: true, found, byteEqual: kept.found && kept.answer === JSON.parse(body).value, outcome, clr: failureMessage includes "CreateNavTestService" }`. If the body was lost, record `{ kind: "kept-check", i, whole: false, outcome, operation, replyRecovered }`. Exit 1 if any whole call has `found` false, `byteEqual` false, `outcome` not `fail` or `clr` false.
   The helper, exported from `size-arm.ts`, and its test, written first (the test fails until the helper exists):

```ts
export function keepOriginalBody(
  bodies: Map<string, string>,
  trace: { readonly action: string; readonly attemptId?: string },
  text: string,
): void {
  if (trace.action !== "LethALControl_RunMutant" && trace.action !== "LethALControl_RunMutantWithCoverage") return;
  if (trace.attemptId === undefined) return;
  bodies.set(trace.attemptId, text);
}
```

```ts
// scripts/r236-baseline-probe/size-arm.test.ts
describe("keepOriginalBody", () => {
  test("keeps the RunMutantWithCoverage body and ignores the GetOpAnswer body of the same attempt", () => {
    const bodies = new Map<string, string>();
    keepOriginalBody(bodies, { action: "LethALControl_RunMutantWithCoverage", attemptId: "r236s-k-1" }, "original");
    keepOriginalBody(bodies, { action: "LethALControl_GetOpAnswer", attemptId: "r236s-k-1" }, "readback");
    expect(bodies.get("r236s-k-1")).toBe("original");
  });
});
```

   Red-check: delete the action filter; the test goes red.
- [ ] **Step 3** **[bash]** `bun run typecheck && rm -rf packages/*/dist`; `bun test scripts/r236-baseline-probe/size-arm.test.ts`; biome on the touched files. The live runs are Tasks 10 and 11. Record there, as the pin's discrimination, that the `opSeq - 1` read is `found: false` while the others are `found: true` in the same run.
- [ ] **Step 4: Commit** `test(R236b): live pins for the kept answer, its key, a refused duplicate, and the original-body capture`.

---

# Phase C: publish, measure, gate

### Task 9: publish 1.0.0.20

- [ ] **Step 1** Cronus284 under `coord lease Cronus284 bugs`: **[pwsh]** `Publish-BcContainerApp -containerName Cronus284 -appFile "U:\Git\LethAL\extensions\lethal-control\LethAL_LethAL Control_1.0.0.20.app" -skipVerification -sync -upgrade`; `Get-BcContainerAppInfo -containerName Cronus284 -tenantSpecificProperties | Select Name,Version,IsInstalled` shows 1.0.0.20 installed. Keep the lease for Task 10.
- [ ] **Step 2** Cronus28, when Task 11 starts, the same under `coord lease Cronus28 bugs`.
- [ ] **Step 3** Any refusal: do not unpublish or force; `coord ask` with the exact output.

### Task 10: §C1 and §C1b on Cronus284

- [ ] **Step 1** **[bash]** `LETHAL_R236_SIZE_ARM=1 bun scripts/r236-baseline-probe/size-arm.ts --config <the Cronus284 config> --expect-container Cronus284 --kept-check 10 --out C:/Users/SShadowS/AppData/Local/Temp/r236b/c1b.ndjson` (needs a registered artifact: run it after step 2's first session, or after a `--arm c1-prep --sessions 1` probe session). Exit 1: FAIL, report, stop.
- [ ] **Step 2** **[bash]** `LETHAL_R236_PROBE=1 bun scripts/r236-baseline-probe/probe.ts --arm c1 --sessions 32 --out C:/Users/SShadowS/AppData/Local/Temp/r236b/c1.ndjson` (30 counted plus the D2 warm-ups). First record: `container` `Cronus284`, `controlVersion` `1.0.0.20`. Exit 3 or 4: record, `coord ask`, stop.
- [ ] **Step 3** Tabulate with a one-off `bun -e` (not committed): per session the quarantine reason, recovered lost bodies (per §C1's definition: `errorPhase` `"body"` and no `bodyEndAt`, with `bytesReceived` and headers time recorded, no byte threshold), the TestPage baseline row and whether its text matches `CreateNavTestService`, the baseline row count, every other quarantine and wedge; and the write cost: median baseline `durationMs` over the 67 non-TestPage tests here against the same from `C:/Users/SShadowS/AppData/Local/Temp/r236/A1.ndjson` and `A2.ndjson`. Apply P1 to P3 word for word (extend per P3 if needed, `--arm c1b2 --sessions 30`).
- [ ] **Step 4** `coord release Cronus284 bugs`. Fill §OUTCOME's C1 and C1b parts; commit.

### Task 11: §C2 on Cronus28

All under `coord lease Cronus28 bugs`, one at a time, foreground, from the main checkout. Record every run's wall time.

- [ ] **Step 1** **[bash]** `LETHAL_ITEST_HANG=1 bun run itest:hang`: as frozen in `packages/runner/itest/hang.itest.ts`.
- [ ] **Step 2** **[bash]** `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev`: killed 3, survived 12, no-coverage 4, `groupedCalls` 15, `warmKills` 0, `assertionScreen.discrimination` `vacuous`, per-mutant equal to `bcdev.baseline.json`, and Task 8's pins pass.
- [ ] **Step 3** **[bash]** `LETHAL_ITEST_CHUNKED=1 bun run itest:chunked`: both legs 17 / 7 / 2 with identical verdicts and `killingTest`, control `warmKills` 9 / `groupedCalls` 33, chunked 5 / 57.
- [ ] **Step 4: `itest:tables`, GH-24's two-run procedure, until 3 consecutive rounds pass, at most 6.** Every round is reported, passing or not, with its reason. Before each round **[bash]** `git diff --stat packages/runner/itest/tables.itest.ts`: the owner's uncommitted section 5 edit is expected; if absent, apply EXPECTED's section 5 figures by hand for the round and restore with `git checkout -- packages/runner/itest/tables.itest.ts` afterwards (ONLY when the edit was yours).
   - **Run 1, the authority for the 377 existing mutants** (committed baseline kept): **[bash]** `LETHAL_ITEST_TABLES=1 bun run itest:tables`. Pass: it stops in `assertMatchesBaseline` with exactly ten "present in after but missing from before" differences, every one `Data Reach Ops`, and zero field differences on any other mutant.
   - **Run 2** (scratch baseline) **[bash]**:

```bash
cd /u/Git/LethAL
SCR=C:/Users/SShadowS/AppData/Local/Temp/r236b/tables-round-$N.baseline.json
rm -f "$SCR"
cp packages/runner/itest/tables.itest.ts C:/Users/SShadowS/AppData/Local/Temp/r236b/tables.itest.ts.before
sed -i "s#^const BASELINE_PATH = .*#const BASELINE_PATH = \"$SCR\";#" packages/runner/itest/tables.itest.ts
LETHAL_ITEST_TABLES=1 bun run itest:tables; RC=$?
cp C:/Users/SShadowS/AppData/Local/Temp/r236b/tables.itest.ts.before packages/runner/itest/tables.itest.ts
echo "gate exit $RC"
bun -e '
const run = require(process.argv[1]);
const reach = run.filter((m) => m.key.split("|")[1] === "Data Reach Ops");
const problems = [];
if (reach.length !== 10) problems.push(`reach mutants ${reach.length}, want 10`);
const want = new Map([
  ["Classify|lethal.empty-block", ["killed", "survived"]],
  ["Classify|lethal.conditional-boundary", ["survived", "survived"]],
  ["Classify|lethal.remove-assignment", ["survived"]],
  ["Classify|lethal.void-method-call", ["survived"]],
  ["Classify|lethal.return-value", ["killed"]],
  ["Touch|lethal.empty-block", ["no-coverage"]],
  ["Touch|lethal.remove-assignment", ["no-coverage"]],
  ["Touch|lethal.shift-integer", ["no-coverage"]],
]);
const got = new Map();
for (const m of reach) {
  const [, , proc, op] = m.key.split("|");
  const k = `${proc}|${op}`;
  got.set(k, [...(got.get(k) ?? []), m.verdict].sort());
  if (m.verdict === "killed" && m.killingTest !== "ReachTakesBranch") problems.push(`${m.key}: killingTest ${m.killingTest}`);
}
for (const [k, v] of want) if (JSON.stringify(got.get(k) ?? []) !== JSON.stringify([...v].sort())) problems.push(`${k}: ${JSON.stringify(got.get(k))}, want ${JSON.stringify(v)}`);
for (const k of got.keys()) if (!want.has(k)) problems.push(`unexpected ${k}`);
if (problems.length > 0) { console.error(problems); process.exit(1); }
console.log("GH-24 section 3 OK");
' "$SCR"
git status --short packages/runner/itest
```

   Pass per round: run 1 as stated, run 2's gate exits 0 (including `assertReachControl` and its determinism check), and the check prints `GH-24 section 3 OK`. The check covers ONLY the ten reach mutants, matched by (procedure, operator) multiset because the two `Classify` `empty-block` mutants share a key prefix (`assertReachControl` pins which of them survives); run 1's full diff stays the authority for everything else. Any quarantine fails the round; record its reason and whether a `lost-reply-recovered` warning preceded it. Discard every `$SCR` after review; commit none.
- [ ] **Step 5** `coord release Cronus28 bugs`. Fill §OUTCOME's C2 part: every round and run with its result and reason, recovered replies seen, gate wall times against the last recorded pre-fix run of each. State in so many words that 3 passing rounds in a row is an operational hurdle and says nothing about the loss rate. Commit `measure(R236b): acceptance, C1, C1b and C2`.

### Task 12: roadmap and owner handoff

- [ ] **Step 1** **[bash]** `ls docs/roadmap/` immediately before filing anything.
- [ ] **Step 2: R236.** Append a dated section: the fix, its commits, the §A2 reading (as the grouped-path decision only), the §C read-out. Close R236 as `done (<commit>)` ONLY if C1, C1b and C2 all passed (and Task 6b landed when §A2 required it). Otherwise it stays open with the read-out. No mechanism label closes or narrows it.
- [ ] **Step 3: File**, one file each: "client-side skipping of TestPage tests: ruled out 2026-09-27 (it changes the gate's pinned expected failure)"; "a lost reply still costs the full 120 s budget before the readback (no early readback, by ruling)"; "a TestPage hit can still wedge the server" (R263's and C1's wedge counts); and, if §A2 read "grouped fix not required", "RunMutantMany has no kept-answer readback; cleared by the §A2 arm only for that arm's conditions".
- [ ] **Step 4** **[bash]** `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`; commit the roadmap files and `ROADMAP.md` together.
- [ ] **Step 5: Owner handoff** (`coord ask`, no file edits):
   1. `CLAUDE.md`'s control-app line to 1.0.0.20 ("GetOpAnswer, R236b"), worded so it does NOT imply every gate container already has it.
   2. **Every gate container and whether it has 1.0.0.20**, from **[bash]** `grep -h '"server"' fixtures/*/lethal.config*.json` in the main checkout and each lane worktree, plus the envtool environment named in `fixtures/sandbox-app/lethal.config.envtool.json` if present: Cronus28 (done, Task 9), Cronus284 (done, Task 9), and each other one listed as "needs 1.0.0.20 before its next gate run; the raised minimum refuses 1.0.0.19".
   3. The `itest:tables` baseline re-record and EXPECTED commit per GH-24, unblocked if C2 passed; R270 unblocked on the same condition.

---

## Review responses (r1, gpt-6-sol, with the orchestrator's rulings)

1. **Critical, a readback could turn an unknown into a non-verdict (ruling C1).** Accepted in full. The server keeps only answers that ran (`Ran` from `RunMutantCore`; `RunError = ''` for the grouped path), so a refusal, including a same-key duplicate the fence refuses, never overwrites a kept answer. `GetOpAnswer` echoes `attemptId`, `opSeq`, `epoch`, `generation`, verified client-side. The client accepts only an identity-checked `pass` or `fail` with no `operation`; everything else keeps the unknown. Tests: Task 6 tests 7 to 12 and 15, Task 8's live duplicate pin.
2. **Critical, the grouped path ruling not implemented (ruling C2).** §A2 now has one purpose: ANY break on the non-TestPage arm (or an incomplete or unrunnable arm) requires the grouped fix in this task, built in Task 4 step 5 and Task 6b, and acceptance blocks on it. The size and TestPage labels are gone; §A2 states it is not a root-cause test, and R236 closes only on the live gates (Task 12 step 2).
3. **Important, "committed" proves less than "request ended" (ruling I3).** The design section and the table's doc comment now say the row proves completed AL answer construction, not that the request or session ended, and the fix never uses it as proof of server health. Added C1b, a live clean failing-TestPage write/read byte-equality check, and C1 now requires the lost-body case explicitly (P2, P3).
4. **Important, missing negative cases (ruling I4).** Added: wrong lease echo (test 11, epoch, generation and opSeq), same-key refusal (test 8, plus the live pin), malformed result (test 10), partial readback body (test 12), `lease-lost` (test 9).
5. **Important, acceptance selects for clean runs (ruling I5).** Every round is reported with its reason; the 3-in-a-row is labelled an operational hurdle; the scratch check covers only the ten reach mutants and run 1's full baseline diff is the authority for the rest.
6. **Minor, every gate container (ruling M6).** Task 12 step 5 item 2 lists each container from the configs with its 1.0.0.20 status.
7. **Minor, scope.** No restart, no early readback (both filed only), write cost measured from existing timings (Task 10 step 3, Task 11 step 5). Option (d) is out and filed.

## Review responses (r2, gpt-6-sol, with the orchestrator's final rulings)

1. **Critical, a failed readback does not necessarily quarantine or avoid a re-run (ruling C1).** The legacy `runFenced` / `runFencedMany` reconcile against the op marker is existing, gated product behaviour and stays. Every unqualified "nothing is ever re-run" and "everything else quarantines" is gone: Goal, Architecture, design (c) and Global Constraints now say the readback dispatches nothing of its own, and a readback that is not accepted falls through to today's handling unchanged (a baseline call quarantines; a mutant call reconciles and may make its one existing fresh attempt). Both paths are tested: Task 7 tests 2 (an accepted readback short-circuits the reconcile) and 3 (a failed readback reaches it unchanged), and Task 6b step 6 for the grouped path.
2. **Critical, a grouped readback could erase `abortSession` (ruling C2).** `runMany` returns `first` untouched whenever it carries `abortSession`; Task 6b tests 7 (identity disagreement) and 8 (unexpected 404) pin it with a VALID kept answer on offer.
3. **Important, a fixed lost-body threshold (ruling I3).** C1 P2 and Task 10 use the trace's incomplete-body evidence (`errorPhase` `"body"`, no `bodyEndAt`); partial captures are recorded beside the call's read-back answer, with no byte threshold.
4. **Important, the `scoreManyAnswer` extraction (ruling I4).** It takes its context explicitly (`req`, `firstMethod`, `call`, `durationMs`, `fencedOp`), `call` is hoisted into `callOf`, and the move lands as its own pure-refactor commit that typechecks and passes the existing tests unedited before any recovery code (Task 6b step 1).
5. **Important, the C1b body capture (ruling I5).** `keepOriginalBody` stores only `RunMutant` / `RunMutantWithCoverage` bodies, never `GetOpAnswer`'s, with a unit test and a red-check (Task 8 step 2).

## Open questions for the orchestrator

1. §A2's rule counts an incomplete arm (a wedge before 60 pairs) as "grouped fix required", which is the conservative direction but may add Task 6b on a technicality. Keep that default?
2. Task 6b bounds the grouped readback by `KEPT_ANSWER_READ_MS` alone (15 s), not by the group budget. Acceptable?
