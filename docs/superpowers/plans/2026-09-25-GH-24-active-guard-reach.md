# GH-24: Per-mutant and per-test reach, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-09-25),** after review round 1 (`H:/lethal-coord/reviews/GH-24-plan/review-r1.md`) and the orchestrator rulings at the end of this file. Changed: the reach claim is NARROWED to mutants whose marker can sit at their own statement, and every other mutant carries `reachGrain` and no `guardReached` (finding 1); marker placement is specified for every shape the operators emit, including the `repeat begin ... end until` body, and the fallback never throws (finding 2); grouped calls hand the validated per-entry value to `mapRanResult`, and `reachedActive` is a verdict field rather than an `attestation` member, so the existing grouped-answer test stays green unedited (finding 3); a pre-committed LIVE negative control arm is added on `sandbox-data`, with its own spec file, and the source pin asserts the read exists (finding 4). The owner questions are gone: ruled.

**Goal:** Every mutant run on the bcdev path says, per covering test, whether the mutated statement actually began executing, WHERE that can be measured at the mutant's own statement. A survivor then reads as either "reached, not noticed" (strengthen an assertion in one of the tests that got there) or "not reached" (write a case that drives execution into it). Where it cannot be measured, the report says so by name. C02-06 gets a per-mutant proof that the named mutant's own code ran in the installed binary.

**Architecture:** A marker call, `MutationSelector.Reached('<id>')`, is emitted INSIDE each mutant's own dispatch branch, at that mutant's own statement. It forwards to a new `LC Control State.NoteReached`, which sets a new SingleInstance flag `ObservedActive`. `RunMutant` returns it as `observedActive`. `RunMutantMany` resets it before each method and returns it per entry. The TS transport puts it on `TestVerdict.reachedActive`, refusing an answer without it. The orchestrator folds it into optional report fields `guardReached` and `reachedBy`, and every instrumented mutant carries `reachGrain`, a compile-time fact saying whether a marker could sit at its own statement.

**Tech Stack:** Bun + TypeScript, AL (runtime 16, BC 28), `alc`, `bun test`.

**Spec:** GitHub issue #24. Related: R32 (why `ObservedAny` is weak), R46 (unexercised survivors), R116 (`SurvivorReach`), C02-04 plan Decision 1 and Out of scope (per-mutant proof deferred to this task). Pre-commitment for the live control: `docs/superpowers/specs/2026-09-25-gh24-reach-control-precommitment.md` (written in Task 6, before any live run).

## Why a marker, and why only at the mutant's own statement

The issue proposes setting `ObservedActive` inside `IsActive` when it returns true. That flag would be true too often, because of how guards are placed.

`buildComponents` (`packages/schemata/src/components.ts`) groups mutants whose statements nest. It emits ONE dispatch chain per group, at the group's WIDEST statement, the component root (`compile.ts:35-41`). Every member's `Active('<id>')` guard is evaluated when control reaches the ROOT. The widest statement is often the whole procedure body: `lethal.empty-block` targets a procedure's body block (`BODY_PARENT_KINDS` in `packages/builtin-tier1/src/empty-block.ts`), and `findEnclosingStatement` (`packages/engine/src/ast/tree-walks.ts:92`) resolves that block as a statement. So with the issue's version, "reached" would mostly mean "the procedure was entered", which `executionProven` already says. The orchestrator accepted the marker for this reason (ruling 1).

The marker has its own limit, found in review: a mutant's "statement" is `findEnclosingStatement(before)`, and that walk can pass a branch. A procedure call counts as a statement only in a statement list (`tree-walks.ts:96`). An unbraced `if Cond then Foo()` or `case W of 1: Foo()` call is not in a statement list, so a mutant on `Foo()` (a `void-method-call` deletion, or a literal inside its arguments) resolves to the whole `if_statement` or `case_statement`. A marker there fires even when the branch is not taken. Likewise a `begin ... end` case-arm block resolves to its `case_statement` (the R180 comment in `empty-block.ts` says why).

So this plan measures reach ONLY where the marker sits at the mutant's own statement, and names every other mutant's grain instead of guessing. True branch-slot reach is filed as its own roadmap item (Task 7).

## Decisions

1. **AL change, control app 1.0.0.18 to 1.0.0.19.** `LC Control State` gains `ObservedActive: Boolean`, `NoteReached(TargetAppId, ArtifactId, MutantId)`, `ResetObservedActive()` and `AttestationObservedActive(): Boolean`. `WriteActive` and `ResetAttestationState` clear `ObservedActive` next to `ObservedAny`. `IsActive` is NOT changed. `NoteReached` sets `ObservedActive` when the tuple equals the cached active tuple; otherwise it sets `ObservedIdentityMismatch` (the branch only runs after `IsActive` returned true for the same arguments, so a mismatch is a stale or broken binary and the run must be refused). `MIN_CONTROL_VERSION` (`packages/runner/src/harness.ts:78`) moves to `1.0.0.19` in lockstep with `app.json` (pinned by `harness.test.ts:381`). The handshake then refuses 1.0.0.18 exactly as it refuses any older app today.
2. **Granularity: per test.** `LC Run Many` calls `ResetObservedActive()` directly before `NoteTestMethodRun()`/`Mgt.RunTests(...)` for each method and adds `observedActive` to that method's entry, read after `ProgressBetween` (which stays the first statement after `RunTests`, PROGRESS_BETWEEN_FIRST). `RunMutant` runs one method, so its top-level `observedActive` is already per test. No call-level value is sent for `RunMutantMany`.
3. **Wire and compatibility.** `RunMutant` (and `RunMutantWithCoverage`, which re-opens `RunMutant`'s JSON, `ControlApi.Codeunit.al:160-188`) adds top-level `observedActive: boolean`. Each `RunMutantMany` entry adds `observedActive: boolean`. On a `ran` answer the client REQUIRES a boolean. Missing or non-boolean on `RunMutant` is an `error` verdict naming control app 1.0.0.19; on a `RunMutantMany` entry it is `malformed(...)`. Never defaulted to false. Refusals and `runError` answers are not reach observations and are not read for it. `protocolVersion` stays 2.
4. **Reach grain, decided at compile time.** One exported function, `reachGrainOf(member): "statement" | "enclosing" | "unplaced"` in `packages/schemata/src/dispatch.ts`, used by BOTH `emitDispatch` (to place or omit the marker) and the manifest builder in `project.ts` (to record it). It walks from `spec.before` (inclusive) up to the resolved statement (exclusive). If any node on that path occupies a single-statement slot or a statement list without being the resolved statement (`isStatementSlot(node)` true), the grain is `"enclosing"`: the mutated code sits in a branch, loop body or case arm that the resolved statement does not always enter. Otherwise, if a placement rule below applies, `"statement"`. Otherwise `"unplaced"`. Only `"statement"` mutants get a marker.
5. **Placement, for `"statement"` grain only** (the member's resolved statement is `S`, the component root is `R`):
   - P0. `S` is `R`: prefix `MutationSelector.Reached('<id>'); ` to the branch text. The chain itself sits at `R`'s position, so this runs exactly when `R` begins.
   - P1. `S` is a `block` other than `R` (an `if`/`while`/`for` body block, or a `repeat` body block): insert `MutationSelector.Reached('<id>'); ` directly after the leading `begin` of `S`'s post-splice text, giving `then begin Reached(); ... end` and `repeat begin Reached(); ... end until ...`. If the post-splice text does not start with `begin` (after whitespace, case-insensitive), the grain is `"unplaced"`.
   - P2. `S` is not a block and sits in a statement list (`isStatementPosition(S)`): insert the prefix at `S`'s start.
   - P3. `S` is not a block and occupies a single-statement slot (`isStatementSlot(S)`, e.g. `if c then X := 1`, `if c then exit(0)`, `1: X := 2`): wrap as `begin MutationSelector.Reached('<id>'); <S> end`.
   - Anything else: `"unplaced"`, no marker, no throw.

   Edits are applied to the root text in DESCENDING position (the P3 ` end`, then the existing member splice with its consumed-terminator rule, then the prefix), so earlier offsets stay valid. No inserted text contains a newline, so line numbers do not move. All three selector emitters gain `procedure Reached(MutantId: Text)` (the parity rule); only `emitMutationSelector` forwards to `NoteReached`, the static and resource forms are empty because al-runner has no channel back.
6. **Shapes the operators emit, and where each lands.** Enumerated from the `targetNodeKinds` of every operator in `packages/builtin-tier1/src` and `packages/builtin-tier2/src`:

   | Mutated node | Resolved statement | Grain | Rule |
   |---|---|---|---|
   | `assignment_statement`, `exit_statement`, `if_statement`, `while_statement`, `repeat_statement` (whole-statement operators: `remove-assignment`, `return-value`, `negate-guard`, `loop-skip`, `loop-truncate`), in a statement list | itself | statement | P0 or P2 |
   | the same, alone in a `then`/`else`/loop/case-arm slot | itself | statement | P0 or P3 |
   | `procedure_call` in a statement list (`void-method-call`, `swap-call-arguments`, every Tier-2 call operator) | itself | statement | P0 or P2 |
   | `procedure_call` alone in a `then`/`else`/loop/case-arm slot | the enclosing `if`/`while`/`for`/`case` | enclosing | none |
   | expression or literal (`negate-conditional`, `conditional-boundary`, `remove-not`, `swap-additive`, `shift-integer`, `flip-boolean-literal`, `toggle-blank-*`, `flip-filter-literal`, `swap-enum-member`) inside a statement, reaching it without crossing a slot | the statement | statement | P0, P2 or P3 |
   | expression or literal inside a slot-occupant call (`if c then Foo(5)`) | the enclosing statement | enclosing | none |
   | `block` under `procedure`/`trigger` (`empty-block`) | itself, always the root | statement | P0 |
   | `block` as an `if`/`while`/`for` body | itself | statement | P1 |
   | `block` directly under `repeat_statement` | itself | statement | P1 (`repeat begin Reached(); ... end until`) |
   | `block` as a case-arm body | the `case_statement` | enclosing | none |

   A `"statement"` claim for an expression means its statement BEGAN, not that the sub-expression was evaluated. That is stated in the interpretation.
7. **The per-mutant fold.** For a `"statement"` grain mutant: `guardReached` is `true` if ANY run reported `reachedActive: true`; `false` only if at least one run happened and EVERY run answered with `reachedActive` defined and none reached; otherwise absent. A run that ended without an answer (timeout, a stopped/408 run, transport error, in-flight, al-runner) is UNMEASURED, never false. `reachedBy` is the qualified names of the tests whose run reached, in run order, present exactly when `guardReached` is. Partial on a kill (a kill stops at the first failing test), complete on a survivor (the `attempted` check after the loop in `runMutantsOnBackend`). For `"enclosing"` and `"unplaced"` mutants: no `guardReached`, no `reachedBy`, whatever the server said.
8. **What `guardReached: true` proves for C02-06.** During this mutant's own runs, the running binary executed a `Reached` marker carrying exactly (this session's targetAppId, the artifactId the selector bakes, this mutantId) while that tuple was active. So the named mutant's STATEMENT is in the installed binary and BEGAN executing. For an expression or argument mutant (a literal, a call inside a statement, a Tier-2 trigger expression, an argument swap) that is the enclosing statement starting, not proof the mutated sub-expression was evaluated; C02-06 must use this narrower wording. `false` is NOT proof of absence, and a mutant with no `guardReached` (other grains, al-runner) gets no proof from this task. `runNamedMutants` reuses `runMutantsOnBackend`, so it gets the fields with no extra work.
9. **Report: optional fields, no `REPORT_SCHEMA_VERSION` bump.** `MutantOutcome.guardReached?: boolean`, `reachedBy?: readonly string[]` and `reachGrain?: "statement" | "enclosing" | "unplaced"`, the same on `mutant-scored`. `reachGrain` is written for every mutant that came from a manifest, on every backend (it is a compile fact). Optional per R157's rule, so archived reports stay valid and committed sample reports are NOT regenerated (same ruling as C02-02). `STREAM_SCHEMA_VERSION` does not move (optional event fields, C02-02 precedent). The store gets none of them, just as it has no `guardObserved`; a `--resume`-carried mutant has none.
10. **Explain, in GH-24b:** `SurvivorReach` gains `reached-unnoticed`, and `covered-but-unreached`/`unreached-and-uncovered` are also decided by `guardReached === false`. That changes the value domain and a value's meaning, so `EXPLAIN_SCHEMA_VERSION` goes 4 to 5 under the rule at `explain.ts:150-171`. A survivor with `reachGrain` other than `"statement"` stays `not-decided`, and its row carries the grain so a reader sees why.
11. **al-runner:** no attestation exists there (`backend.ts:96-105`). `Reached` is a no-op in the static and resource selectors, `guardReached` stays absent, and `reach` stays `not-decided`. `reachGrain` is still written (compile fact).
12. **Gates.** Verdicts of existing mutants cannot move: the marker has no effect on target state. No existing baseline pins `guardObserved` or reach (`packages/runner/itest/mutant-equality.ts` compares `verdict|killingTest|coverageFiltered|errorClass`). The NEW fixture arm (Task 6) does move `itest:tables`' totals and adds mutants to `tables.baseline.json`, so that baseline IS re-recorded, by the owner, after the pre-committed verdicts match. Freezing reach itself into baselines is asked at acceptance (ruling 3).

## Split

Per ruling 4: coord task `GH-24` is GH-24a (Tasks 1 to 7 below; it does NOT close issue #24). A new coord task `GH-24b` (explain v5, Task 8) depends on `GH-24` and on `C02-01`, and closes issue #24.

## Global Constraints

- `CLAUDE.md` build order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files: `bunx biome check <paths>`.
- No `!` non-null assertions. `exactOptionalPropertyTypes`: `...(v !== undefined ? { k: v } : {})`.
- Fail loudly: an answer without `observedActive` is refused, never read as `false`. `false`, absent and "other grain" are different facts and stay different all the way into explain.
- AL has no unit-test harness. Verify AL by an offline `alc` compile (the `al-compiler` subagent or `/al-compile`), by the source-text pins in `packages/runner/tests/control-app-source.test.ts`, and by the live gates (owner). `itest:hang` is the only gate that exercises the stop inside `LC Run Many`, and Task 1 edits that loop.
- Fixture AL (Task 6): R169's id blocks (`sandbox-data` owns 79300-79399, its selector triple is 79397-79399), then `bun run compile:fixtures`, then the CLAUDE.md symbol/test-app update recipe (bump `sandbox-data`'s `app.json`, compile the target into `sandbox-data-tests/.alpackages`, delete the stale `.app` there, compile the tests app). Publishing is the owner's.
- The three selectors must expose the identical procedure set (`packages/schemata/tests/selector.test.ts`, "artifact identity parity").
- The lane does NOT publish anything, does NOT run live gates, does NOT re-record a baseline, does NOT edit `CLAUDE.md`.

## Review Focus

1. **An older control app (1.0.0.18).** Expected: the handshake refuses it naming 1.0.0.19. A `ran` answer with no `observedActive` is refused: an `error` verdict for `RunMutant`, a malformed call for `RunMutantMany`, never `reachedActive: false`. Pinned by `harness.test.ts` "GH-24: refuses 1.0.0.18", `run-mutant-transport.test.ts` "GH-24: a ran answer without observedActive is an error, not unreached", `run-mutant-many.test.ts` "GH-24: an entry without observedActive is malformed".
2. **A grouped call where one covering test reaches and another does not.** Expected: per-entry values reach each verdict (not an OR), and the fold gives `guardReached: true`, `reachedBy: [the one that reached]`. Pinned offline by `run-mutant-many.test.ts` "GH-24: observedActive is per entry" and `orchestrator.test.ts` "GH-24: reachedBy names only the tests that reached", and LIVE by the Task 6 control (`{skipper: false, taker: true}` in one `RunMutantMany` call, by test name).
3. **A mutant whose resolved statement is an enclosing `if` or `case`** (an unbraced then-call). Expected: grain `"enclosing"`, no marker in its branch, no `guardReached`, never "reached". Pinned by `compile.test.ts` "GH-24: an unbraced then-call is enclosing grain and gets no marker", and live by the Task 6 arm's enclosing mutant.
4. **A kill, a timeout, a stopped/408 run.** Expected: a kill keeps its verdict and folds reach from the runs that happened; a run with no answer is unmeasured, never false. Pinned by `orchestrator.test.ts` "GH-24: a kill whose runs never reached keeps its verdict and says false" and "GH-24: a run without an answer leaves reach not measured". A live kill with `guardReached: false` is a BLOCK (ruling 2).
5. **al-runner.** Expected: `Reached` is a no-op there, no `guardReached`, `reachGrain` still written. Pinned by `selector.test.ts` (parity, extended) and `orchestrator.test.ts` "GH-24: a backend that never attests records no reach", and `itest:alrunner`.

---

## GH-24a

### Task 1: Control app 1.0.0.19 (AL)

**Files:**
- Modify: `extensions/lethal-control/src/ControlState.Codeunit.al` (vars near line 33; `WriteActive` ~82; `ResetAttestationState` ~176; new procedures next to `AttestationObservedAny` ~229)
- Modify: `extensions/lethal-control/src/ControlApi.Codeunit.al` (`RunMutant` ~546, `BuildStatus` ~1100; the `RunMutantMany`/`BuildManyStatus` summaries)
- Modify: `extensions/lethal-control/src/RunMany.Codeunit.al` (the loop ~226-252)
- Modify: `extensions/lethal-control/app.json` (`version` to `1.0.0.19`)
- Modify: `packages/runner/src/harness.ts:78` (`MIN_CONTROL_VERSION = "1.0.0.19"`)
- Test: `packages/runner/tests/control-app-source.test.ts`, `packages/runner/tests/harness.test.ts`

**Interfaces (AL):**

```al
// LC Control State
ObservedActive: Boolean;   // cleared in WriteActive and ResetAttestationState, beside ObservedAny

/// GH-24: the marker the instrumented target emits INSIDE a mutant's own branch, at that mutant's
/// own statement. Not IsActive: IsActive is evaluated at the component ROOT, which can be the
/// whole procedure body. The early exit keeps a marker inside a loop cheap.
procedure NoteReached(TargetAppId: Text; ArtifactId: Text; MutantId: Text)
begin
    if ObservedActive then
        exit;
    EnsureLoaded();
    if (CachedMutantId <> '') and (CachedTargetAppId = TargetAppId) and (CachedArtifactId = ArtifactId) and (CachedMutantId = MutantId) then
        ObservedActive := true
    else
        ObservedIdentityMismatch := true;
end;

procedure ResetObservedActive()
begin
    ObservedActive := false;
end;

procedure AttestationObservedActive(): Boolean
begin
    exit(ObservedActive);
end;
```

The early exit is safe: `ObservedActive` true means the tuple already matched in this method. A mismatch before the first match still latches.

- `RunMutant`: `ObservedActive := State.AttestationObservedActive();` on the line after `IdentityMismatch := State.AttestationMismatch();` (before phase 3, which resets it). `BuildStatus` gains `ObservedActive: Boolean` and `Obj.Add('observedActive', ObservedActive);` after `observedAny`. Refusal paths pass `false`, as they do for `observedAny`; the client reads it only on `ran`.
- `LC Run Many` loop: `State.ResetObservedActive();` directly before `State.NoteTestMethodRun();`. After `FnLine.Get(...)`, `One.Add('observedActive', State.AttestationObservedActive());`.

- [ ] **Step 1: Write the failing source pins** in `control-app-source.test.ts`, reusing its `read` and `procedureBody` helpers (extend `procedureBody` for `local procedure` if needed). Every `indexOf` is asserted `>= 0` BEFORE any ordering comparison, because `-1 < n` passes when the line is missing:

```ts
const at = (body: string, needle: string): number => {
  const i = body.indexOf(needle);
  expect(i, `missing: ${needle}`).toBeGreaterThanOrEqual(0);
  return i;
};

describe("GH-24: ObservedActive, reset per method and read after ProgressBetween", () => {
  test("LC Run Many resets ObservedActive right before each method runs", () => {
    const body = procedureBody(read("RunMany.Codeunit.al"), "RunAll");
    const loop = at(body, "foreach Entry in Methods do begin");
    const reset = at(body, "State.ResetObservedActive();");
    const note = at(body, "State.NoteTestMethodRun();");
    const run = at(body, "Mgt.RunTests(RunLine, ALTestSuite);");
    expect(loop).toBeLessThan(reset);
    expect(reset).toBeLessThan(note);
    expect(note).toBeLessThan(run);
    expect(body.slice(reset, note).split(";").length).toBe(2); // nothing between reset and note
  });
  test("the entry reads ObservedActive only after ProgressBetween", () => {
    const body = procedureBody(read("RunMany.Codeunit.al"), "RunAll");
    const between = at(body, "State.ProgressBetween(FenceAttemptId, FenceOpSeq, Index);");
    const readAt = at(body, "One.Add('observedActive', State.AttestationObservedActive());");
    expect(readAt).toBeGreaterThan(between);
  });
  test("IsActive does not set ObservedActive (the root-grain trap)", () => {
    const body = procedureBody(read("ControlState.Codeunit.al"), "IsActive");
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain("ObservedActive");
  });
  test("both resets clear ObservedActive", () => {
    for (const p of ["WriteActive", "ResetAttestationState"]) {
      at(procedureBody(read("ControlState.Codeunit.al"), p), "ObservedActive := false;");
    }
  });
  test("RunMutant reads ObservedActive before phase 3 and answers it", () => {
    const body = procedureBody(read("ControlApi.Codeunit.al"), "RunMutant");
    const readAt = at(body, "State.AttestationObservedActive()");
    const phase3 = at(body, "State.TryFinishRun(");
    expect(readAt).toBeLessThan(phase3);
    at(procedureBody(read("ControlApi.Codeunit.al"), "BuildStatus"), "Obj.Add('observedActive', ObservedActive);");
  });
});
```

- [ ] **Step 2:** `harness.test.ts`: add "GH-24: refuses 1.0.0.18" next to the existing older-version refusal test, asserting the message names both `1.0.0.18` and `1.0.0.19`. The lockstep test at line 381 goes red until `app.json` moves.
- [ ] **Step 3: Run and see them fail:** `bun test packages/runner/tests/control-app-source.test.ts packages/runner/tests/harness.test.ts`.
- [ ] **Step 4: Implement** the AL and the two version bumps.
- [ ] **Step 5: Offline compile** with the `al-compiler` subagent on `U:/Git/LethAL/extensions/lethal-control`. Any diagnostic is a stop. Stage the result as `extensions/lethal-control/lethal-control.app` (control-app skill steps 1 and 2 only; do NOT publish). Task 2's offline compile needs these symbols.
- [ ] **Step 6: Red-checks:** (a) move `ResetObservedActive()` above the `foreach`: "right before each method" goes red; (b) delete the `One.Add('observedActive', ...)` line: "read after ProgressBetween" goes red on `readAt >= 0` (this is the check the r1 pin lacked); (c) add `ObservedActive := true;` to `IsActive`: the root-grain pin goes red; (d) set `MIN_CONTROL_VERSION` back to 1.0.0.18: "GH-24: refuses 1.0.0.18" goes red; (e) empty the body of `ResetObservedActive` (the pin "ResetObservedActive clears the flag" asserts, with `>= 0`, that its body contains `ObservedActive := false;`) goes red. Restore each. Add that pin to Step 1 beside the call-position pins: the call pins alone pass when the procedure does nothing.
- [ ] **Step 7: Commit** `feat(control): ObservedActive, the active mutant's own statement reached, per test (GH-24, 1.0.0.19)`.

### Task 2: Grain and marker (schemata)

**Files:**
- Modify: `packages/schemata/src/dispatch.ts` (`reachGrainOf`, `REACH_MARKER`, `emitDispatch`, `spliceIntoRoot`)
- Modify: `packages/schemata/src/project.ts` (`MutantManifestEntry` ~95 gains `reachGrain`; set where entries are built, from the same `ComponentMember` data)
- Modify: `packages/schemata/src/selector.ts` (all three emitters)
- Test: `packages/schemata/tests/compile.test.ts` (real parsed AST; `dispatch.test.ts` uses fake nodes with no `parent`, so it cannot test slots), `packages/schemata/tests/dispatch.test.ts`, `packages/schemata/tests/selector.test.ts`, `packages/schemata/tests/project.test.ts`
- Expect: golden/snapshot outputs under `packages/schemata/tests` change. Every diff must be the marker and nothing else. Read each.

**Interfaces:**
- `export const REACH_MARKER = (mutantId: string): string => \`MutationSelector.Reached('${mutantId}');\``, so tests build expectations from it.
- `export type ReachGrain = "statement" | "enclosing" | "unplaced";`
- `export function reachGrainOf(member: ComponentMember, root: ALSyntaxNode): ReachGrain` (Decision 4 and 5). Pure. Never throws for a member `buildComponents` produced.
- `MutantManifestEntry.reachGrain: ReachGrain` (required on the manifest; it is always known at compile).
- Selectors: `procedure Reached(MutantId: Text)`. Delegating form: `ControlState.NoteReached('${targetAppId}', '${artifactId}', MutantId);` with a local `ControlState: Codeunit "LC Control State";`. Static and resource forms: empty body with `// ponytail: al-runner has no channel back to LethAL, so reach is not measured there (GH-24).`

- [ ] **Step 1: Write the failing tests** in `compile.test.ts` with its existing parse-and-compile helper. Read each node's kind and parent from the parsed AST inside the test and assert it, rather than assuming what the grammar produces:

```ts
describe("GH-24: reach grain and marker placement", () => {
  test("GH-24: an unbraced then-call is enclosing grain and gets no marker", () => {
    // AL: `if Amount > 100 then Touch();` (Touch a local procedure), a void-method-call spec
    // deleting `Touch()`. Assert from the AST: the call's parent is the if_statement and
    // findEnclosingStatement returns the if. Then: reachGrainOf === "enclosing", and the compiled
    // output contains NO REACH_MARKER for that mutant id anywhere.
  });
  test("GH-24: an own statement in a then-slot is wrapped (P3)", () => {
    // AL: `if Amount < 0 then exit(0);` with a return-value spec on `exit(0)`: grain "statement",
    // its branch reads `then begin ${REACH_MARKER(id)} exit(...) end`, the marker AFTER
    // `if Amount < 0 then`, so not reached when the branch is skipped. If `Error(...)` in this slot
    // parses as error_statement, add the same case for it; if it parses as procedure_call, it is
    // enclosing grain, and the test says which.
  });
  test("GH-24: a nested statement in a list gets a plain prefix (P2)", () => {
    // procedure body with an empty-block spec on the body (ROOT) and remove-assignment on its
    // SECOND statement: the marker sits directly before that second statement.
  });
  test("GH-24: an if-body block gets the marker after its begin (P1)", () => {
    // `if Amount > 100 then begin Seen := Amount; end;` with empty-block on the then-block:
    // branch contains `then begin ${REACH_MARKER(id)} ` and still compiles to one `end` per `begin`.
  });
  test("GH-24: a repeat body block gets the marker after its begin (P1)", () => {
    // `repeat begin I += 1; end until I >= 3;` with empty-block on the repeat body block AND a
    // procedure-body empty-block (so the repeat block is a NESTED member, the r1 shape).
    // Assert from the AST that the block's parent is repeat_statement. Expected branch text:
    // `repeat begin ${REACH_MARKER(id)} ` ... `end until`. Grain "statement". No throw.
  });
  test("GH-24: a case-arm block and a case-arm call are enclosing", () => {
    // `case W of 1: begin X := 1; end; 2: Touch(); end;` with empty-block on arm 1's block and
    // void-method-call on arm 2's call: both "enclosing", no marker for either. The assignment
    // INSIDE arm 1's block (remove-assignment) is "statement" (P2).
  });
  test("GH-24: the marker adds no line and appears only in its own branch", () => {
    // for every compile above: each REACH_MARKER(id) occurs once, inside the branch guarded by
    // Active(id) (slice by `end else if`), never in the original branch; and removing every
    // marker (and each P3 `begin ` / ` end` pair) gives back the pre-GH-24 output byte for byte.
  });
});
```

And one enumeration test, which is what makes "never throws on a shape the operators emit" a checked claim:

```ts
test("GH-24: every fixture mutant gets a grain, and only statement grain gets a marker", async () => {
  // For fixtures/sandbox-app, sandbox-data, sandbox-hang and examples/gift-card, examples/credit-limit:
  // generate the real mutation set with the default operators (the same entry point the
  // orchestrator uses; copy it from the nearest project.test.ts test that instruments a fixture),
  // instrument it, and assert: no throw; every manifest entry has a reachGrain; the count of
  // REACH_MARKER occurrences equals the count of "statement" entries; and print the per-grain
  // counts per fixture. Any "unplaced" entry fails the test with its operator, node kind and parent
  // kind: a new shape needs a rule (and a compile case), not a silent fallback.
});
```

In `dispatch.test.ts`: the fake nodes have no parent, so assert only that `emitDispatch` of two members places each marker in its own branch when `reachGrainOf` is stubbed, or move these checks to `compile.test.ts`. In `selector.test.ts`: the three parity tests go red on their own once one emitter gains `Reached`; add that `emitMutationSelector` contains `ControlState.NoteReached(` and the other two contain `procedure Reached(MutantId: Text)` without it. In `project.test.ts`: a manifest entry carries the grain `reachGrainOf` returned.

- [ ] **Step 2: Run and see them fail:** `bun test packages/schemata`.
- [ ] **Step 3: Implement.** `isStatementPosition` and `isStatementSlot` are already imported in `dispatch.ts`.
- [ ] **Step 4: Full loop:** typecheck, clean dist, `bun test`, biome on touched files.
- [ ] **Step 5: Offline instrumented compile.** `bun run compile:fixtures` does NOT compile instrumented output. Run the gate-0 compile-only driver (`scripts/campaign/compile-only.ts`, args in `packages/runner/src/compile-only-args.ts`) with `controlSymbolPath` = the 1.0.0.19 `lethal-control.app` from Task 1, over `fixtures/sandbox-app`, `fixtures/sandbox-data` (after Task 6's arm exists, run it again), `fixtures/sandbox-hang`, `examples/gift-card` and `examples/credit-limit`. Also compile a scratch project holding exactly the shapes of the Step 1 tests (P1 repeat body, P1 if body, P3 exit, P2, P0), so each placement is proven by `alc` and not only by string checks. Every one must compile clean.
- [ ] **Step 6: Red-checks:** (a) return `"statement"` from `reachGrainOf` whenever a placement applies, skipping the slot walk: "unbraced then-call is enclosing" goes red; (b) drop P1's repeat case so it falls to `"unplaced"`: the repeat test and the enumeration test go red; (c) insert with `\n`: the no-line test goes red; (d) drop `Reached` from `emitStaticSelector`: the parity test goes red. Restore each.
- [ ] **Step 7: Commit** `feat(schemata): reach grain per mutant, and a marker at its own statement (GH-24)`.

### Task 3: Transport reads `observedActive`, refuses its absence

**Files:**
- Modify: `packages/runner/src/backend.ts` (`TestVerdict` ~85-110)
- Modify: `packages/runner/src/run-mutant-transport.ts` (`RunMutantResult` ~140, `GroupEntry` ~130, `runMany` entry loop ~985-1046, `mapRanResult` ~1379-1466)
- Test: `packages/runner/tests/run-mutant-transport.test.ts`, `packages/runner/tests/run-mutant-many.test.ts`

**Interfaces:**
- `TestVerdict.reachedActive?: boolean`, a verdict field BESIDE `attestation`, not inside it. Doc: the server's `observedActive` for THIS test method; set on every verdict the transport maps from a `ran` answer; absent on every other verdict and on al-runner. Keeping it out of `attestation` means the existing `toEqual({ observedAny, identityMismatch })` assertions (`run-mutant-many.test.ts:176`, `run-mutant-transport.test.ts:475`/`:482`) and the ~28 orchestrator fakes stay valid unedited, and an absent value is structurally distinct from `false`.
- `mapRanResult`'s input type becomes `Pick<RunMutantResult, "codeunitResults" | "observedAny" | "identityMismatch" | "observedActive">`. After the identity check: `if (typeof result.observedActive !== "boolean") return { ref, outcome: "error", durationMs, failureMessage: "RunMutant answer ran but carries no boolean observedActive; control app 1.0.0.19 stamps it on every answer (GH-24). Refusing to read a missing value as unreached." };` and the returned verdict gains `reachedActive: result.observedActive`.
- `runMany`, per entry, BEFORE calling `mapRanResult`: `if (typeof raw.observedActive !== "boolean") return malformed(\`entry ${i + 1} has no boolean observedActive (control app 1.0.0.19, GH-24)\`);`, then pass `{ codeunitResults: results, observedAny: attestation.observedAny, identityMismatch: false, observedActive: raw.observedActive }`. So a grouped entry's value comes from THAT entry, and the mapper never sees a call-level stand-in. The call-level `attestation` const (`:958`) is unchanged.

- [ ] **Step 1: Update the helpers, not the tests.** Add `observedActive: true` to `run-mutant-many.test.ts`'s `entry(...)` (as an optional 5th parameter, default `true`) and to `run-mutant-transport.test.ts`'s `echo()` default. These model what a 1.0.0.19 server always sends. No existing test BODY is edited; in particular "a well-formed grouped answer" (~163-184) must pass unchanged.
- [ ] **Step 2: Write the failing tests:**

```ts
// run-mutant-many.test.ts
test("GH-24: observedActive is per entry", async () => {
  const r = await /* the file's own call helper */(answer({
    methods: [entry(1, M[0].method, 2, 1, false), entry(2, M[1].method, 2, 1, true), entry(3, M[2].method, 2, 1, false)],
  }));
  expect(r.kind).toBe("verdicts");
  expect(r.verdicts.map((v) => v.reachedActive)).toEqual([false, true, false]);
});
test("GH-24: an entry without observedActive is malformed", async () => {
  const bad = entry(2, M[1].method, 2);
  delete (bad as Record<string, unknown>).observedActive;
  // expect the existing malformed shape (cause "group-answer-malformed") and message /observedActive/
});

// run-mutant-transport.test.ts, beside the attestation tests at ~465-482
test("GH-24: a ran answer without observedActive is an error, not unreached", async () => {
  const inner = echo({ observedAny: true, identityMismatch: false });
  delete inner.observedActive;
  // expect outcome "error", failureMessage /observedActive.*1\.0\.0\.19/, reachedActive undefined
});
test("GH-24: observedActive reaches the verdict", async () => {
  const inner = echo({ observedAny: true, identityMismatch: false, observedActive: false });
  // expect v.reachedActive toBe(false) and v.attestation toEqual({ observedAny: true, identityMismatch: false })
});
```

- [ ] **Step 3: Run and see them fail.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Full loop.** The pre-existing well-formed grouped-answer test is green with its body unedited; say so in the submit note.
- [ ] **Step 6: Red-checks:** (a) in `runMany`, pass `observedActive: true` for every entry instead of `raw.observedActive`: "per entry" goes red; (b) in `mapRanResult`, write `reachedActive: result.observedActive === true` and drop the refusal: "without observedActive is an error" goes red; (c) move the entry check AFTER `mapRanResult` and stop passing the value in: every grouped test goes red (the r1 failure mode, shown on purpose). Restore each.
- [ ] **Step 7: Commit** `feat(runner): the transport carries per-test reach and refuses an answer without it (GH-24)`.

### Task 4: Fold into `guardReached` / `reachedBy` / `reachGrain`

**Files:**
- Modify: `packages/runner/src/orchestrator.ts` (the covering loop's fold ~5520-5600, beside `guardObserved`; `record(...)` ~6514, ~6599, ~6650)
- Modify: `packages/runner/src/events.ts` (`mutant-scored` ~344)
- Modify: `packages/runner/src/report-fold.ts` (~376)
- Modify: `packages/runner/src/report.ts` (report mutant ~82, `MutantOutcome` ~1563, builder ~1963; doc comments carry Decision 7's wording)
- Regenerate: `bun scripts/generate-schemas.ts` (`report-v2`, `stream-v1`); `bun test packages/runner/tests/report-equality.test.ts --update-snapshots`. Read both diffs: only the three new optional properties.
- Test: `packages/runner/tests/orchestrator.test.ts` (`StubBackend` ~215; `attestingBackend` ~5204), `packages/runner/tests/report-fold.test.ts`

**Interfaces:**
- One optional positional param at the END of `record(...)`: `reach?: { readonly reachGrain: ReachGrain; readonly guardReached?: boolean; readonly reachedBy?: readonly string[] }`, spread field by field with the `exactOptionalPropertyTypes` pattern. `reachGrain` comes from the mutant's manifest entry; every `record` call that has a manifest mutant passes it, including no-coverage and known-survivor (grain is a compile fact).
- Fold, beside the `guardObserved` OR:

```ts
// GH-24: per-test reach. Unmeasured, never false: a run without an answer (timeout, a stopped
// 408, transport error, in-flight, al-runner) leaves the mutant unmeasured unless another run
// reached. Only statement-grain mutants are ever decided.
if (v.reachedActive === undefined) reachUnanswered = true;
else {
  reachAnswered = true;
  if (v.reachedActive) reachedBy.push(qualifiedTestName(ref));
}
// after the loop:
const decided =
  m.reachGrain !== "statement"
    ? {}
    : reachedBy.length > 0
      ? { guardReached: true, reachedBy }
      : reachAnswered && !reachUnanswered
        ? { guardReached: false, reachedBy: [] }
        : {};
```

A lost-ack retry yields only the final verdict (the comment at the loop head); a test asserts no ref appears twice in `reachedBy` rather than trusting the comment.

- `StubBackend`: optional hook `reachedFor?: (mutant: string | null, ref: TestMethodRef) => boolean`, default `mutant !== null`, setting `reachedActive` where `hasAttestation` is true.

- [ ] **Step 1: Write the failing tests** in `orchestrator.test.ts`:

```ts
describe("GH-24: per-mutant reach", () => {
  test("GH-24: reachedBy names only the tests that reached", async () => {
    // two covering tests, all pass (survivor), statement grain; reachedFor true only for test A.
    // expect guardReached true, reachedBy [qualified A].
  });
  test("GH-24: a survivor nobody reached says false with an empty list", async () => {});
  test("GH-24: a kill whose runs never reached keeps its verdict and says false", async () => {
    // and the mirror: reachedFor true -> guardReached true, reachedBy [killer] only (partial).
  });
  test("GH-24: a run without an answer leaves reach not measured", async () => {
    // one covering test times out (no reachedActive), the other passes with false ->
    // guardReached ABSENT, reachedBy ABSENT. And: the other reached -> guardReached true.
  });
  test("GH-24: an enclosing-grain mutant is never decided", async () => {
    // manifest grain "enclosing", reachedFor true for every test -> no guardReached, reachGrain "enclosing".
  });
  test("GH-24: a backend that never attests records no reach", async () => {
    // attestation-less backend (as al-runner): reachGrain present, guardReached/reachedBy absent,
    // in outcomes AND in the folded report.
  });
});
```

Plus in `report-fold.test.ts`: a `mutant-scored` with `reachGrain: "statement", guardReached: false, reachedBy: []` round-trips with all three keys present, and one with `reachGrain: "enclosing"` alone round-trips without the other two.

- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement,** regenerate schemas, update the snapshot.
- [ ] **Step 4: Wiring check:** run the `wiring-completeness` subagent on `reachGrain` and `guardReached` (every site that builds a `MutantOutcome` or a `mutant-scored` event).
- [ ] **Step 5: Full loop.**
- [ ] **Step 6: Red-checks:** (a) treat a missing `reachedActive` as false: "without an answer" goes red; (b) drop the `m.reachGrain !== "statement"` guard: "enclosing-grain mutant is never decided" goes red; (c) drop the spread in `report-fold.ts`: the round-trip test goes red. Restore each.
- [ ] **Step 7: Commit** `feat(runner): guardReached, reachedBy and reachGrain per mutant (GH-24)`.

### Task 5: Gate assertions (offline edit, owner runs)

**Files:**
- Create: `packages/runner/itest/reach-evidence.ts` plus `reach-evidence.test.ts` (the `notinstrumented-evidence.ts` pattern), so every assertion can be red-checked without a server
- Modify: `packages/runner/itest/bcdev.itest.ts` (the direct-transport attestation check ~497-511), `tables.itest.ts`, `chunked.itest.ts`, `envtool.itest.ts`, `al-runner.itest.ts`

**Assertions, pre-committed before the owner's run:**
- bcdev, tables, chunked, envtool: every `killed` statement-grain mutant has `guardReached === true` (a refutation is a BLOCK, ruling 2); every `survived` statement-grain mutant has `guardReached` defined; no non-statement-grain mutant has `guardReached`; every `reachedBy` entry is in that mutant's `coveringTests`; every mutant has `reachGrain`.
- bcdev's direct-transport check adds `typeof v.reachedActive === "boolean"` on every `ran` verdict, and `v.reachedActive === false` on the BASELINE runs it already issues (no mutant active, so no marker can run).
- chunked: `guardReached` and `reachedBy` (as sets) identical across the two legs, per mutant.
- al-runner: no mutant carries `guardReached`; every mutant carries `reachGrain`.
- Each gate PRINTS the reach split and grain counts. Nothing about reach is frozen yet (ruling 3).

- [ ] **Step 1:** Write `reach-evidence.ts` with one exported check per bullet and a test per check that feeds a hand-built report breaking exactly that bullet and expects a throw naming the mutant code.
- [ ] **Step 2:** Wire the checks into the gates.
- [ ] **Step 3:** typecheck, clean dist, `bun test packages/runner/itest/reach-evidence.test.ts`.
- [ ] **Step 4: Red-check:** make the "killed reached" check `return` early: its test goes red. Restore.
- [ ] **Step 5: Commit** `test(itest): pre-commit reach evidence on the gates (GH-24)`.

### Task 6: The live negative control (fixture arm + pre-commitment)

On `sandbox-data`, because `itest:tables` already runs grouped `RunMutantMany` calls and carries arm pre-commitments. `itest:chunked` runs `--only src/DataMain.Table.al` and does not see a new file.

**Files:**
- Create: `fixtures/sandbox-data/src/DataReachOps.Codeunit.al`, codeunit id = the lowest free id in 79300-79396 (79334 as of this plan; check with `grep -rho "^\(codeunit\|table\|page\) [0-9]*" fixtures/sandbox-data/src` immediately before writing)
- Modify: `fixtures/sandbox-data-tests/src/DataTests.Codeunit.al` (two tests), `fixtures/sandbox-data/app.json` (version bump), the tests project's `.alpackages` (per the CLAUDE.md recipe)
- Create: `docs/superpowers/specs/2026-09-25-gh24-reach-control-precommitment.md`, COMMITTED BEFORE the owner's live run
- Modify: `packages/runner/itest/tables.itest.ts` (`assertReachControl`, and the frozen totals once measured)

**The arm** (shape fixed; exact text is the implementer's, commented like the neighbouring arms):

```al
codeunit 79334 "Data Reach Ops"
{
    var
        Seen: Integer; // written by the branch, read by no test: the branch's effect is unasserted

    procedure Classify(Amount: Integer): Integer
    begin
        if Amount > 100 then begin
            Seen := Amount;
        end;
        if Amount > 1000 then
            Touch();
        exit(Amount);
    end;

    local procedure Touch()
    begin
        Seen := 0;
    end;
}
```

Tests (bare `Error(...)` raises, as the suite's other arms mostly do): (Named so that R197's name tie-break runs `ReachTakesBranch` FIRST and `ReachWithoutBranch` SECOND, `test-order.ts`: T sorts before W. That order is what makes the control catch a reset that does nothing: with the flag never cleared between methods, the second entry would read `true`.) `ReachWithoutBranch` calls `Classify(10)` and asserts the result is 10; `ReachTakesBranch` calls `Classify(500)` and asserts the result is 500. Both cover `Classify`, both pass on every mutant that leaves the return value alone, so both run to completion in ONE `RunMutantMany` call for each such mutant, whatever order R197 picks.

**What the pre-commitment spec must contain** (write it from the offline mutant list: `lethal run --project fixtures/sandbox-data --tests fixtures/sandbox-data-tests --dry-run --only src/DataReachOps.Codeunit.al`, never from a live run):
- Every mutant the arm adds, by operator and procedure, with its predicted verdict, `reachGrain`, `guardReached` and `reachedBy` by test name.
- THE CONTROL: `remove-assignment` of `Seen := Amount` (statement grain, P2 inside the then-block): `survived`, `reachedBy: ["...ReachTakesBranch"]`, i.e. `[ReachTakesBranch: true, ReachWithoutBranch: false]` in that ORDER within the same call; the gate asserts the order from the grouped entries, not just the set. The same prediction for `empty-block` on the then-block (P1) and any literal mutant on `Seen := Amount`.
- THE ENCLOSING CASE: `void-method-call` deleting `Touch()` (unbraced then-call): `survived` (no test reaches 1000, and nothing reads `Seen`), `reachGrain: "enclosing"`, NO `guardReached`. This is the live form of Review Focus 3.
- `negate-conditional`/`conditional-boundary`/`shift-integer` on `Amount > 100`: statement grain on the if statement, `survived`, reached by BOTH tests (the condition runs whenever the if begins).
- `empty-block` on the procedure body and `return-value` on `exit(Amount)`: `killed` by whichever test runs first, `guardReached: true`.
- `Touch`'s own mutants: `no-coverage` or `survived` with `guardReached: false`, as the dry run's coverage says; predict each.
- The BASELINE control: a direct transport run of both tests with no mutant active returns `reachedActive: false` for each (asserted in `assertReachControl`, mirroring `bcdev.itest.ts`'s direct-transport section ~427-511).
- The totals the arm moves on `itest:tables`: killed, survived, no-coverage and deployed/raw counts each rise by exactly the spec's per-verdict sums; `groupedCalls` rises by the number of new scored mutants (one call each) plus any new warm-kill replays (predicted 0: the arm has no session state); `warmKills` unchanged at 13; the one expected baseline failure is still `Data Tests.PageActionComputesNonZero` and nothing else; `declarativeSites` and `untargetedTriggerCount` unchanged; `assertionScreen.discrimination` stays `partial`. No existing mutant's verdict or `killingTest` moves. `itest:chunked`, `itest:bcdev`, `itest:alrunner` totals: unchanged (different fixture or `--only` scope).

- [ ] **Step 1:** Write the arm and the two tests. `bun run compile:fixtures`. Then the symbol/test-app recipe (bump `sandbox-data`'s `app.json`, compile the target into `sandbox-data-tests/.alpackages`, delete the stale `.app`, compile the tests app).
- [ ] **Step 2:** Offline instrumented compile of `sandbox-data` (Task 2 Step 5) and confirm, in the instrumented source, that `Seen := Amount`'s branch has its marker inside the then-block and `Touch()`'s branch has none.
- [ ] **Step 3:** Dry-run the mutant list and write the spec file with every prediction above. Commit it ALONE: `spec(GH-24): pre-commit the reach control arm's verdicts and reach`.
- [ ] **Step 4:** Add `assertReachControl` to `tables.itest.ts`: the control mutant's `reachedBy` equals `[ReachTakesBranch]` BY NAME, its covering run included `ReachWithoutBranch` AFTER `ReachTakesBranch` in one grouped call (so a `false` measured after a `true` proves the per-test reset), and the ordered per-entry values read `[true, false]`; the enclosing mutant has `reachGrain: "enclosing"` and no `guardReached`; both baseline runs `reachedActive: false`. Red-check it offline through `reach-evidence.ts`'s pattern with a hand-built report where the control reads `[ReachWithoutBranch, ReachTakesBranch]` (the root-grain bug), where the ordered values read `[true, true]` (the no-reset bug), and where `ReachWithoutBranch` is missing from the run.
- [ ] **Step 5:** Leave the frozen totals in `tables.itest.ts` at their current values with a comment pointing at the spec: the owner updates them and re-records `tables.baseline.json` only after the live run matches the spec per mutant.
- [ ] **Step 6: Commit** `test(fixtures): the reach control arm on sandbox-data (GH-24)`.

### Task 7: Roadmap

- [ ] **Step 1:** `ls docs/roadmap/` immediately before writing (R233 is free as of this plan; other sessions file concurrently, so re-check). File one item, `section: "product-gaps"`, `status: "open"`: "Reach is measured only at a mutant's own statement: a call or block alone in a branch or case arm reports no reach". Evidence by name: `reachGrainOf` and `REACH_MARKER` in `packages/schemata/src/dispatch.ts`, `findEnclosingStatement` and `isStatementSlot` in `packages/engine/src/ast/tree-walks.ts`, the grain counts the Task 2 enumeration test prints per fixture, and the `Data Reach Ops` enclosing mutant. What closing it needs: a marker inside the branch SLOT itself (wrap the slot occupant, `then begin Reached(); Foo() end`), which means the component builder must know the slot, not only the statement. Also note: expression grain (a statement began, not the sub-expression) and al-runner (no channel) are the two remaining ceilings. Cite names, never `file.ts:<line>` (R117).
- [ ] **Step 2:** `bun scripts/roadmap-index.ts`, then `bun test scripts/roadmap-index.test.ts scripts/line-citations.test.ts`.
- [ ] **Step 3: Commit** `roadmap: R<n> reach is own-statement grain only (GH-24)`.

## GH-24b (coord task `GH-24b`, depends on `GH-24` and `C02-01`)

### Task 8: Explain decides reach per mutant (v5)

**Files:**
- Modify: `packages/runner/src/report.ts` (`SurvivorReach`, `survivorReachOf`, `REACH_INTERPRETATIONS` ~1686-1735; `GUARD_EVIDENCE_INTERPRETATIONS.observed` prose points at `guardReached`)
- Modify: `packages/runner/src/explain.ts` (`EXPLAIN_SCHEMA_VERSION` 5 with a "5:" paragraph; `ExplainSurvivor.reachedBy` and `reachGrain`; the row build ~670-690; the `guardObserved` type check ~597 gets siblings; `survivorActionabilityRank` ~757 and its doc)
- Rename: `git mv schemas/explain-v4.schema.json schemas/explain-v5.schema.json`; `$id`, the `reach` enum, the new leaves; `schemas/README.md` table row; `packages/runner/tests/schemas.test.ts` (loads by filename ~211 and ~433)
- Test: `packages/runner/tests/explain.test.ts`, `interpretation.test.ts` (registry counts), `schemas.test.ts`

**Interfaces:**

```ts
export type SurvivorReach =
  | "reached-unnoticed"
  | "covered-but-unreached"
  | "unreached-and-uncovered"
  | "not-decided";

export function survivorReachOf(
  attribution: CoverageAttribution,
  guardEvidence: GuardEvidence,
  guardReached: boolean | undefined,
  reachGrain: ReachGrain | undefined,
): SurvivorReach {
  if (guardReached === true) return "reached-unnoticed";
  if (guardReached === false)
    return attribution === "exact" ? "covered-but-unreached" : "unreached-and-uncovered";
  // A report written by this build carries a grain. For "enclosing" or "unplaced" the build
  // deliberately measured nothing at the mutant's own statement, so the batch-wide guard signal
  // must not decide it either: that is the false "unreached" GH-24 exists to stop.
  if (reachGrain !== undefined) return "not-decided";
  // Archived report (no grain): the R116 derivation, unchanged.
  if (guardEvidence === "not-observed")
    return attribution === "exact" ? "covered-but-unreached" : "unreached-and-uncovered";
  return "not-decided";
}
```

- `reached-unnoticed`, basis R32 plus the Task 7 id: "The mutant's own statement began executing in at least one covering test (`reachedBy`), and every covering test still passed." entailedNegative: "The grain is the statement: an expression mutant's statement began, which does not prove the sub-expression was evaluated. Not proof the mutant is killable: an equivalent mutant reads the same."
- `not-decided` prose names its sources: `reachGrain` other than `statement`, al-runner, or a run that ended without an answer.
- `assertExplainableReport`: `guardReached === true` beside `guardObserved === false` throws `MalformedReportError` (a marker runs only inside a branch whose guard ran); `guardReached` on a mutant whose `reachGrain` is not `statement` throws; `reachedBy` without `guardReached`, or the reverse, throws.
- Rank: `reached-unnoticed` 0; proven + `not-decided` 1; proven + `covered-but-unreached` 2; unproven + `not-decided` 3; `unreached-and-uncovered` 4.

- [ ] **Step 1: Write the failing tests** in `explain.test.ts`: "GH-24: guardReached true reads reached-unnoticed and carries reachedBy"; "GH-24: guardReached false decides unreached even when guardObserved is true"; "GH-24: absent guardReached falls back to the R116 derivation" (and every committed campaign report still projects); "GH-24: enclosing grain stays not-decided and says so" (with `guardObserved: FALSE`: a fixture with `true` would pass without the grain arm); "GH-24: an archived row with no grain keeps the R116 derivation"; "GH-24: contradictory reach fields are refused"; "GH-24: reached-unnoticed ranks first".
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement,** rename the schema, update README and the `interpretation.test.ts` counts. Rebase on C02-01 first; it edits the same schema file.
- [ ] **Step 4: Full loop**, biome on touched files.
- [ ] **Step 5: Red-checks:** (a) drop the `guardReached === false` arm: "decides unreached even when guardObserved is true" goes red; (b) drop the grain throw: "contradictory reach fields" goes red; (b2) drop the `reachGrain !== undefined` arm: "enclosing grain stays not-decided" goes red; (c) leave the schema's `reach` enum unchanged: `schemas.test.ts` goes red. Restore.
- [ ] **Step 6: Commit** `feat(explain): reach decided per mutant, EXPLAIN_SCHEMA_VERSION 5 (GH-24b)`.

## Out of scope, on purpose

- **Branch-slot reach** (a call or block alone in a branch or case arm). Filed in Task 7; not built now (ruling on review r1, finding 1).
- **Re-scoring on reach.** A survivor nobody reached stays `survived`. A kill nobody reached stays `killed` AND blocks the gate (ruling 2); it is filed, never re-scored silently.
- **Freezing reach into gate baselines.** Asked at GH-24a's acceptance (ruling 3).
- **Expression grain.** A marker per sub-expression needs typed hoisting, which `compile.ts` refuses on purpose (design spec section 4).
- **A console banner line.** Explain carries reach; the R46 banner is unchanged.
- **The store.** No reach columns, same as `guardObserved`.

## Owner-run live steps

The lane cannot do these. In order:

All of this runs against ONE container, `Cronus28` (BC 28.4.53241.53758 DK, owner allocation 2026-09-25). Cronus281, Cronus282 and Cronus283 belong to CentralGauge: never lease or publish to them. Every fixture shares Cronus28, so the gates run ONE AFTER ANOTHER, never in parallel, each under `coord lease Cronus28 <lane>` with a heartbeat, released right after (`docs/superpowers/runbooks/autonomy/README.md`, section "Containers, leases and the pause"). Live gates run from the main checkout `U:\Git\LethAL`, since only it holds the gitignored configs that point at Cronus28. If Cronus28's one-time setup (control app, `sandbox-app`/`sandbox-tests`, `sandbox-data`/`sandbox-data-tests`, `Library Assert`) has not been done, do it first, per that section.

1. **Publish control app 1.0.0.19** (`.claude/skills/control-app` steps 3 and 4) to `Cronus28` only: `$env:DOCKER_CONTEXT='desktop-windows'`, `Publish-BcContainerApp -containerName Cronus28 ... -skipVerification -sync -upgrade`. Confirm first that `grep -h '"server"' fixtures/*/lethal.config.local.json` names only Cronus28. The envtool environment only if restored.
2. **Publish the `sandbox-data` target and tests apps** to `Cronus28` after Task 6 (target first, then tests; unpublish tests first if a downgrade is refused, per `.claude/skills/control-app`).
3. **Run the gates**, foreground and one at a time (one shared container); read the al-runner build line first. `itest:alrunner` needs no container:
   - `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev`: 3 / 12 / 4, `groupedCalls` 15, `warmKills` 0, discrimination `vacuous`, all unchanged, plus Task 5's checks.
   - `LETHAL_ITEST_TABLES=1 bun run itest:tables`: every EXISTING mutant's verdict and `killingTest` unchanged; the arm's mutants exactly as the committed spec predicts; the totals moved by exactly the spec's sums; `assertReachControl` green. Then update the frozen totals in `tables.itest.ts`, delete `tables.baseline.json`, re-run to re-record it, review the diff (arm mutants only), commit.
   - `LETHAL_ITEST_CHUNKED=1 bun run itest:chunked`: both legs 17 / 7 / 2, warm 9/33 and 5/57, reach identical across legs.
   - `LETHAL_ITEST_HANG=1 bun run itest:hang`: the only gate that exercises the stop inside `LC Run Many`, which Task 1 edits.
   - `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=... bun run itest:alrunner`: 3 / 12 / 4 on all four legs (its instrumented AL gains the no-op marker).
   - `itest:envtool` only if an environment exists.
4. **Any verdict difference, any spec mismatch, or any killed statement-grain mutant with `guardReached: false` is a BLOCK** (ruling 2): file it before anything else moves.
5. **Update `CLAUDE.md`**: the "Control app 1.0.0.18 (R206)" line to 1.0.0.19 (GH-24), and `itest:tables`' frozen figures once re-recorded. The lane may not edit `CLAUDE.md`.

## Submit note must say

- Every red-check run, with its red and restored-green output line.
- That the pre-existing well-formed grouped-answer test passed with its body unedited.
- The per-fixture grain counts the enumeration test printed, and that none was `unplaced`.
- That `REPORT_SCHEMA_VERSION` and `STREAM_SCHEMA_VERSION` did not move and the report schema's root `required` list did not change.
- That the control app and fixtures were compiled offline and NOT published, no live gate was run, and the spec file was committed before any live run. The live steps above are the owner's.
- That no committed sample report was regenerated (optional fields).

## Orchestrator rulings (2026-09-25)

1. **The marker approach is accepted** over the issue's `IsActive` flag: a flag set where guards are checked would mostly restate `executionProven`, which answers nothing the issue asks. Every gate re-runs once for it anyway, since GH-24a needs the owner's live run.
2. **A killed mutant whose statement never ran is a BLOCK**, filed as a roadmap item before anything else moves: it is a possible false kill, which is this project's most expensive error.
3. **Freezing reach per mutant into the gate baselines** means re-recording them, which is owner-only. It is asked at GH-24a's acceptance, not decided here.
4. **The split is accepted.** Coord task `GH-24` is GH-24a (does NOT close issue #24). A new coord task `GH-24b` (explain v5) depends on `GH-24` and on `C02-01`, and closes issue #24.
5. **R233 rides with GH-24b (owner ruling 2026-09-25: the version rule stands, the v4 practice was wrong).** Task 8 also (a) adds a test in `packages/runner/tests/schemas.test.ts`, beside R157's root-required pin, that pins every `enum` value set in `schemas/explain-v5.schema.json` against a literal list, red-checked by adding a value to one enum without updating the list; and (b) adds one sentence to the `EXPLAIN_SCHEMA_VERSION` doc comment naming R233 and the v4 drift. GH-24b closes R233.
