# R69 Phase 2 — Client-Services Batch Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce real mutation verdicts for tests that open a `TestPage` — which the fenced `ClientType=ODataV4` session refuses — by routing only those tests through the control-app batch runner over the native client-services WebSocket, with per-verdict provenance and every false-verdict defence the fenced path already has.

**Architecture:** Spec `docs/superpowers/specs/2026-08-01-r69-batch-runner-design.md` (revision 2). One method per WebSocket session. A two-gate router selects tests; a transport seeds over OData, drives page 71014 over the WebSocket, and validates the server-produced result JSON (never the client-echoed row fields); activation is written and cleared on every terminal path; a wedge quarantines the tier rather than recording a per-mutant error.

**Tech Stack:** AL (BC runtime 28, `extensions/lethal-control`), TypeScript/Bun (`packages/runner`), `U:/Git/bc-mcp` (native BC client-services protocol), `bccontainerhelper` (publish), `alc` (offline compile), bun:sqlite.

## Global Constraints

- **Phase A is a GATE.** If Task 0's negative control fails, Phase B onward is ABANDONED — the routed path stays diagnosis-only and does not score. Do not "approximate" around a failed probe.
- Control app object IDs: range **71000–71099**; 71000–71014 taken. New objects use **71015+**.
- Any control AL change bumps `extensions/lethal-control/app.json` **1.0.0.11 → 1.0.0.12** AND `packages/runner/src/harness.ts:37` `MIN_CONTROL_VERSION` in lockstep (pinned by `packages/runner/tests/harness.test.ts:374`), then `/control-app` publishes to **Cronus281 and Cronus283**.
- AL has **no unit-test harness**. Every AL task's test is: offline `alc` compile clean (`/al-compile` or the `al-compiler` subagent), then the live measurement named in the task.
- TS build order (the dist trap): `bun run typecheck` → `rm -rf packages/*/dist` → `bun test`. NEVER `bun test` straight after a typecheck.
- Conventions (CI fails otherwise): no `!` non-null assertions; `exactOptionalPropertyTypes` — build optional props with `...(v !== undefined ? { k: v } : {})`; typed error classes extend `Error` **directly**, never each other; fail loudly on caller-contract violations, never return a plausible empty default.
- Biome only on files you touched: `bunx biome check <paths>`. `report.ts` has 5 PRE-EXISTING errors — do not "fix" them in this work.
- Assert phase ordering with **call counters** on stateful fakes, never wall-clock timing.
- Containers: `docker context use desktop-windows` first. Cronus281 (sandbox-app/-probes), Cronus283 (sandbox-data).
- Frozen gates that must not move: `itest:bcdev` **3/10/3**, `itest:alrunner` **3/13/0**, `itest:envtool` **3/10/3**, `itest:tables` **69/9/6 over 84** + `untargetedTriggerCount` **0**.
- Red-check every load-bearing test with the `mutation-red-checker` subagent.

---

## PHASE A — Task 0: the probe that gates everything

### Task 0: Does the client-services path return CLEAN per-procedure coverage?

**Files:**
- Create: `U:/Git/bc-mcp/scripts/r69-coverage-probe.ts` (untracked, matching every other `r69-*.ts` there)
- Modify: `ROADMAP.md` (record the reading)

**Interfaces:**
- Consumes: the wiring in `bc-mcp/scripts/r69-batch-spike.ts` (`odataPost`, `odataPostString`, `SessionFactory`, `OpenPageOperation`, `ExecuteActionOperation`) — copy it; it is MEASURED working.

- [ ] **Step 1:** Copy `r69-batch-spike.ts` to `r69-coverage-probe.ts`. Change the seed to run **two** methods in two separate invocations (`ClearBatch` → seed one → run → read, twice), because one method per session is the shipped shape.

- [ ] **Step 2: the POSITIVE reading.** Seed a method whose test touches an instrumented procedure in `fixtures/sandbox-probes`. Print the full `result` JSON. Look for any coverage payload naming that procedure.

- [ ] **Step 3: the NEGATIVE CONTROL — the load-bearing one.** Seed a method whose test touches **nothing instrumented** (an empty `[Test]` body). Print the full `result` JSON.

Expected if coverage is usable: the negative control returns **empty** target-app coverage. If it returns coverage for procedures the test never touched, the bracket is absorbing non-test activity and coverage on this path is UNUSABLE — noisy coverage would attribute a genuinely uncovered mutant to a routed test, it would be selected, run, pass because it never reaches the site, and `no-coverage` would become `survived`.

- [ ] **Step 4:** Run both:

```bash
cd U:/Git/bc-mcp && BC_BASE_URL=http://Cronus281/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
  BC_TENANT_ID=default npx tsx scripts/r69-coverage-probe.ts
```

- [ ] **Step 5:** Record the verdict in ROADMAP R69 as a dated "Task 0" clause, quoting the actual JSON shape (not a summary).

- [ ] **Step 6:** Commit the ROADMAP change.

```bash
git add ROADMAP.md
git commit -m "measure(R69): Task 0 — coverage fidelity on the client-services path"
```

**GATE:**
- **Coverage present AND negative control empty** → proceed to Phase B.
- **Either reading fails** → STOP. Record it loudly in ROADMAP R69, mark Phase 2 abandoned, and go to Phase D (the roadmap queue). The Phase-3 report naming already shipped and remains the delivered value. Do not build Phase B on a failed probe.

---

## PHASE B — Control-app changes (only if Task 0 passed)

### Task 1: Queue/result fields, the activation wrapper, and RunBatch's lifecycle

**Files:**
- Modify: `extensions/lethal-control/src/BatchQueue.Table.al`
- Modify: `extensions/lethal-control/src/BatchResult.Table.al`
- Modify: `extensions/lethal-control/src/ControlState.Codeunit.al`
- Modify: `extensions/lethal-control/src/BatchRunner.Codeunit.al`
- Modify: `extensions/lethal-control/src/ControlApi.Codeunit.al`

**Interfaces:**
- Consumes: `LC Control State` `AttestationObservedAny(): Boolean` (public, line 201), `AttestationMismatch(): Boolean` (public, line 206), `RegisteredArtifact(TargetAppId: Text): Text` (public, line 192), `NextSuiteName(): Code[10]`; `LC Run Method` `SetRequest(Code[10]; Integer; Text)`, `Results(): Text`.
- Produces: `LC Batch Queue` fields 6 `Artifact Id` (Text[64]) and 7 `Nonce` (Text[64]); `LC Batch Result` fields 8 `Identity Mismatch` (Boolean) and 9 `Nonce` (Text[64]); `LC Control State` `procedure ActivateForBatch(TargetAppId: Text; ArtifactId: Text; MutantId: Text)` and `procedure ClearForBatch(TargetAppId: Text; ArtifactId: Text; MutantId: Text)`; `LC Control API` `procedure SeedBatchItem(codeunitId: Integer; method: Text; mutantId: Text; targetAppId: Text; artifactId: Text; nonce: Text) LineNo: Integer`.

- [ ] **Step 1:** Add the two queue fields, mirroring the existing field style exactly.

```al
        field(6; "Artifact Id"; Text[64]) { }
        field(7; Nonce; Text[64]) { }
```

- [ ] **Step 2:** Add the two result fields.

```al
        field(8; "Identity Mismatch"; Boolean) { }
        field(9; Nonce; Text[64]) { }
```

- [ ] **Step 3:** Add the activation wrapper to `ControlState.Codeunit.al`, immediately after `WriteActive`. It must carry the lease invariant in its own comment — `WriteActive` is `local` BY CONSTRUCTION and this wrapper is the documented exception, not a repeal.

```al
    /// <summary>R69 Phase 2: the batch path's ONLY route to activation. WriteActive is `local` by
    /// construction — under the fence the only legitimate writer of "LC Mutation Active" is a phase 1
    /// that has just proven it holds the lease. This wrapper does NOT repeal that: the batch path is
    /// serialized against fenced work and never runs while a lease is held (spec §3.4(c)), and the
    /// runner is responsible for that ordering. Exposed because the batch loop runs in-session, where
    /// no phase-1 transaction exists to do it.
    ///
    /// Called for EVERY batch row, including unmutated gate-2 baselines (with a blank MutantId).
    /// Skipping it for baselines is the bug spec §3.4(b) exists to prevent: the "LC Mutation Active"
    /// row OUTLIVES the session, so a baseline that does not re-activate inherits the PREVIOUS row's
    /// mutant via EnsureLoaded and runs mutated.</summary>
    procedure ActivateForBatch(TargetAppId: Text; ArtifactId: Text; MutantId: Text)
    begin
        WriteActive(TargetAppId, ArtifactId, MutantId);
    end;

    /// <summary>R69 Phase 2: clears what ActivateForBatch wrote, on EVERY terminal path. The fenced
    /// primitive clears on every terminal path and design.md §6.2 states that as a guarantee; the
    /// batch path owes the same. Delegates to ClearActiveIf so a row written by someone else is
    /// never cleared by this path.</summary>
    procedure ClearForBatch(TargetAppId: Text; ArtifactId: Text; MutantId: Text)
    begin
        ClearActiveIf(TargetAppId, ArtifactId, MutantId);
    end;
```

- [ ] **Step 4:** Rewrite `RunBatch` in `BatchRunner.Codeunit.al`. Note the `ClearForBatch` in BOTH branches — the error path is where a missing clear poisons the next session.

```al
    procedure RunBatch()
    var
        Queue: Record "LC Batch Queue";
        Res: Record "LC Batch Result";
        Runner: Codeunit "LC Run Method";
        State: Codeunit "LC Control State";
        Ok: Boolean;
        Json: Text;
        ErrText: Text;
    begin
        Res.DeleteAll(true);
        Commit();
        if not Queue.FindSet() then
            exit;
        repeat
            // Activate EVERY row, baseline included (blank Mutant Id). See ActivateForBatch.
            State.ActivateForBatch(Queue."Target App Id", Queue."Artifact Id", Queue."Mutant Id");
            Runner.SetRequest(State.NextSuiteName(), Queue."Codeunit ID", Queue.Method);
            Ok := Runner.Run();
            if Ok then begin
                Json := Runner.Results();
                ErrText := '';
            end else begin
                Json := '';
                ErrText := CopyStr(GetLastErrorText(), 1, 2048);
            end;
            Res.Init();
            Res."Line No." := Queue."Line No.";
            Res."Codeunit ID" := Queue."Codeunit ID";
            Res.Method := Queue.Method;
            Res.Ok := Ok;
            Res.Attested := State.AttestationObservedAny();
            Res."Identity Mismatch" := State.AttestationMismatch();
            Res.Nonce := Queue.Nonce;
            Res."Error Text" := ErrText;
            Res.SetResultJson(Json);
            Res.Insert(true);
            Commit();
            // Clear on EVERY terminal path — including the error path above. The active row outlives
            // the session, so a miss here runs the NEXT invocation's baseline mutated.
            State.ClearForBatch(Queue."Target App Id", Queue."Artifact Id", Queue."Mutant Id");
            Commit();
        until Queue.Next() = 0;
    end;
```

- [ ] **Step 5:** Extend `SeedBatchItem` in `ControlApi.Codeunit.al` (currently line 538) to carry the new fields.

```al
    /// <summary>R69: seed one work item. `nonce` is load-bearing — it proves a result row came from
    /// THIS invocation, closing the stale-row hazard R69's own history demonstrated. It proves
    /// nothing about WHAT ran; that is the client's result-JSON validation (spec §3.3).</summary>
    procedure SeedBatchItem(codeunitId: Integer; method: Text; mutantId: Text; targetAppId: Text; artifactId: Text; nonce: Text) LineNo: Integer
    var
        Queue: Record "LC Batch Queue";
    begin
        if Queue.FindLast() then
            LineNo := Queue."Line No." + 1
        else
            LineNo := 1;
        Queue.Init();
        Queue."Line No." := LineNo;
        Queue."Codeunit ID" := codeunitId;
        Queue.Method := CopyStr(method, 1, MaxStrLen(Queue.Method));
        Queue."Mutant Id" := CopyStr(mutantId, 1, MaxStrLen(Queue."Mutant Id"));
        Queue."Target App Id" := CopyStr(targetAppId, 1, MaxStrLen(Queue."Target App Id"));
        Queue."Artifact Id" := CopyStr(artifactId, 1, MaxStrLen(Queue."Artifact Id"));
        Queue.Nonce := CopyStr(nonce, 1, MaxStrLen(Queue.Nonce));
        Queue.Insert(true);
        Commit();
    end;
```

- [ ] **Step 6:** Extend `GetBatchResults` to emit the two new fields, so the transport can read them.

```al
            Obj.Add('identityMismatch', Res."Identity Mismatch");
            Obj.Add('nonce', Res.Nonce);
```

- [ ] **Step 7:** Compile. Run `/al-compile extensions/lethal-control`. Expected: 0 errors. A "member is not accessible" here means a wrapper is missing — add only the exact wrapper, never widen `WriteActive` itself.

- [ ] **Step 8:** Commit.

```bash
git add extensions/lethal-control/src/
git commit -m "feat(control): R69 Phase 2 — nonce, identity mismatch, activate/clear per batch row"
```

### Task 2: Version bump + publish

**Files:**
- Modify: `extensions/lethal-control/app.json` (`1.0.0.11` → `1.0.0.12`)
- Modify: `packages/runner/src/harness.ts:37` (`MIN_CONTROL_VERSION` → `"1.0.0.12"`)

- [ ] **Step 1:** Bump both in lockstep.
- [ ] **Step 2:** `bun run typecheck` → `rm -rf packages/*/dist` → `bun test packages/runner`. Expected: green (`harness.test.ts:374` asserts the two values are equal).
- [ ] **Step 3:** `/control-app` — rebuild and publish to Cronus281 AND Cronus283. Verify with:

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
Invoke-ScriptInBcContainer -containerName Cronus281 -scriptblock { Get-NAVAppInfo -ServerInstance BC -Tenant default -TenantSpecificProperties -Name "LethAL Control" | Select-Object Version,Scope,IsInstalled }
```

Expected: `1.0.0.12`, `IsInstalled=True`. A stale Tenant-scope row with `IsInstalled=False` is inert and expected.

- [ ] **Step 4:** Commit.

```bash
git add extensions/lethal-control/app.json packages/runner/src/harness.ts
git commit -m "chore(control): bump LethAL Control 1.0.0.12 (R69 Phase 2)"
```

---

## PHASE C — Runner integration

### Task 3: `BatchTransport` — seed, drive, read back, VALIDATE

**Files:**
- Create: `packages/runner/src/batch-transport.ts`
- Create: `packages/runner/tests/batch-transport.test.ts`

**Interfaces:**
- Produces:
  - `export class BatchProtocolError extends Error` — extends `Error` DIRECTLY (never another typed error; CLAUDE.md).
  - `export interface BatchRunRequest { codeunitId: number; method: string; mutantId: string; targetAppId: string; artifactId: string; nonce: string; }`
  - `export interface BatchRunResult { ok: boolean; attested: boolean; identityMismatch: boolean; errorText: string; resultJson: unknown; }`
  - `export interface BatchOdata { post(action: string, body: unknown): Promise<unknown>; }`
  - `export interface BatchWebSocket { runBatchAction(): Promise<void>; }`
  - `export async function runOneBatchMethod(odata: BatchOdata, ws: BatchWebSocket, req: BatchRunRequest): Promise<BatchRunResult>`
  - `export function validateResultJson(resultJson: unknown, expectedMethod: string): { outcome: "pass" | "fail"; message?: string }`

- [ ] **Step 1: Write the failing tests.** These encode §3.2's validation contract — the row's own fields are a client round-trip and are NOT evidence.

```typescript
import { describe, expect, test } from "bun:test";
import {
  BatchProtocolError,
  runOneBatchMethod,
  validateResultJson,
} from "../src/batch-transport";

/** A result JSON in the shape codeunit 79218 actually produced (ROADMAP R69, 2026-08-01). */
function resultJson(method: string, result = 1, message = "") {
  return { name: "T", codeUnit: 79218, testResults: [{ method, result, message }] };
}

function fakes(row: Record<string, unknown> | undefined, calls: string[] = []) {
  const odata = {
    post: async (action: string) => {
      calls.push(action);
      if (action !== "GetBatchResults") return undefined;
      return { value: JSON.stringify(row === undefined ? [] : [row]) };
    },
  };
  const ws = {
    runBatchAction: async () => {
      calls.push("RunBatch");
    },
  };
  return { odata, ws, calls };
}

const REQ = {
  codeunitId: 79218,
  method: "TestFoo",
  mutantId: "M0001",
  targetAppId: "app",
  artifactId: "art",
  nonce: "N1",
};

describe("validateResultJson (R69 §3.2 — the only server-produced evidence)", () => {
  test("accepts exactly one line whose method matches", () => {
    expect(validateResultJson(resultJson("TestFoo"), "TestFoo").outcome).toBe("pass");
  });

  // Zero lines is a protocol fault, never a verdict — the fenced mapRanResult's own rule.
  test("throws when the result carries no test line", () => {
    const empty = { testResults: [] };
    expect(() => validateResultJson(empty, "TestFoo")).toThrow(BatchProtocolError);
  });

  test("throws when the result carries more than one test line", () => {
    const two = { testResults: [{ method: "TestFoo", result: 1 }, { method: "TestBar", result: 1 }] };
    expect(() => validateResultJson(two, "TestFoo")).toThrow(BatchProtocolError);
  });

  // The false-survive door: the platform ran a DIFFERENT method, and the row's own Method field
  // says TestFoo because RunBatch copied it from the queue LethAL seeded.
  test("throws when the line's method is not the requested one", () => {
    expect(() => validateResultJson(resultJson("TestBar"), "TestFoo")).toThrow(BatchProtocolError);
  });

  test("throws on an unrecognised result enum", () => {
    expect(() => validateResultJson(resultJson("TestFoo", 99), "TestFoo")).toThrow(BatchProtocolError);
  });
});

describe("runOneBatchMethod (R69 §3.2/§3.3)", () => {
  test("seeds, runs and reads back in that order", async () => {
    const calls: string[] = [];
    const { odata, ws } = fakes(
      { nonce: "N1", ok: true, attested: true, identityMismatch: false, errorText: "", result: resultJson("TestFoo") },
      calls,
    );
    await runOneBatchMethod(odata, ws, REQ);
    // Call-counter ordering, never wall-clock (CLAUDE.md).
    expect(calls).toEqual(["ClearBatch", "SeedBatchItem", "RunBatch", "GetBatchResults"]);
  });

  test("throws when no result row came back — never an empty default", async () => {
    const { odata, ws } = fakes(undefined);
    await expect(runOneBatchMethod(odata, ws, REQ)).rejects.toThrow(BatchProtocolError);
  });

  // The nonce proves the row is THIS invocation's. A stale row must never be read as an answer.
  test("throws when the row's nonce is not this invocation's", async () => {
    const { odata, ws } = fakes({
      nonce: "STALE", ok: true, attested: true, identityMismatch: false, errorText: "", result: resultJson("TestFoo"),
    });
    await expect(runOneBatchMethod(odata, ws, REQ)).rejects.toThrow(BatchProtocolError);
  });

  test("throws when the control app reports an identity mismatch", async () => {
    const { odata, ws } = fakes({
      nonce: "N1", ok: true, attested: true, identityMismatch: true, errorText: "", result: resultJson("TestFoo"),
    });
    await expect(runOneBatchMethod(odata, ws, REQ)).rejects.toThrow(BatchProtocolError);
  });
});
```

- [ ] **Step 2: Run them, expect FAIL.**

```bash
bun test packages/runner/tests/batch-transport.test.ts
```

Expected: `Cannot find module '../src/batch-transport'`. Create the module with the exported names but unimplemented bodies, re-run, and confirm the failures are now per-assertion rather than a module-load error.

- [ ] **Step 3: Implement `batch-transport.ts`.** `BatchProtocolError extends Error` directly. `validateResultJson` reads `testResults`, requires exactly one entry, requires `method === expectedMethod`, maps the result enum, and throws `BatchProtocolError` on every other shape. `runOneBatchMethod` posts `ClearBatch`, `SeedBatchItem`, calls `ws.runBatchAction()`, posts `GetBatchResults`, parses the outer `value` string then the inner array, requires exactly one row, requires `row.nonce === req.nonce`, requires `identityMismatch === false`, then calls `validateResultJson`. Every failure throws; none returns a default.

- [ ] **Step 4: Run, expect PASS.** Then `bun run typecheck` → `rm -rf packages/*/dist` → `bun test packages/runner`.

- [ ] **Step 5:** Red-check with the `mutation-red-checker` subagent. Mutations to demand: (a) drop the `line.method !== expectedMethod` check — expect RED on "throws when the line's method is not the requested one"; (b) drop the nonce comparison — expect RED on the stale-nonce test; (c) make `validateResultJson` accept `testResults.length >= 1` — expect RED on the two-line test.

- [ ] **Step 6:** Commit.

```bash
git add packages/runner/src/batch-transport.ts packages/runner/tests/batch-transport.test.ts
git commit -m "feat(runner): R69 batch transport — validate server evidence, not client echo"
```

### Task 4: `TestPageRouter` — the two gates

**Files:**
- Create: `packages/runner/src/testpage-router.ts`
- Create: `packages/runner/tests/testpage-router.test.ts`

**Interfaces:**
- Consumes: `describeTestPageUnsupported` from `./testpage-unsupported` (shipped).
- Produces: `export interface RoutedTest { codeunitName: string; method: string; gate1Evidence: string; }` and `export function selectRoutedTests(baseline: readonly { codeunitName: string; method: string; failureMessage?: string }[], gate2Passed: (t: { codeunitName: string; method: string }) => boolean): readonly RoutedTest[]`.

- [ ] **Step 1: Write the failing tests.**

```typescript
import { describe, expect, test } from "bun:test";
import { selectRoutedTests } from "../src/testpage-router";

const REFUSAL =
  "Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not " +
  "supported. at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()";

const always = () => true;
const never = () => false;

describe("selectRoutedTests (R69 §3.1)", () => {
  test("routes a fence-refused test that passes gate 2", () => {
    const routed = selectRoutedTests([{ codeunitName: "T", method: "OpensPage", failureMessage: REFUSAL }], always);
    expect(routed.map((r) => r.method)).toEqual(["OpensPage"]);
  });

  // Gate 2 is not optional: a test failing on BOTH paths is broken, and routing it would build a
  // green set from tests that never passed anywhere.
  test("does NOT route a fence-refused test that also fails on the client-services path", () => {
    expect(selectRoutedTests([{ codeunitName: "T", method: "OpensPage", failureMessage: REFUSAL }], never)).toEqual([]);
  });

  test("does not route a test that failed for an ordinary reason", () => {
    const baseline = [{ codeunitName: "T", method: "Broken", failureMessage: "Assert.AreEqual failed" }];
    expect(selectRoutedTests(baseline, always)).toEqual([]);
  });

  test("does not route a test that passed on the fence", () => {
    expect(selectRoutedTests([{ codeunitName: "T", method: "Green" }], always)).toEqual([]);
  });

  // §3.1: gate 1 is a diagnosis regex promoted to a router. The quoted evidence is reported so a
  // reader can overrule the routing decision, exactly as R35's design lets them overrule its note.
  test("carries the quoted gate-1 evidence so a reader can overrule the routing", () => {
    const routed = selectRoutedTests([{ codeunitName: "T", method: "OpensPage", failureMessage: REFUSAL }], always);
    expect(routed[0]?.gate1Evidence).toContain("CreateNavTestService");
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing, then per-assertion).

- [ ] **Step 3: Implement.** For each baseline entry with a `failureMessage`, call `describeTestPageUnsupported`; if it returns a string AND `gate2Passed` returns true, emit a `RoutedTest` carrying that string as `gate1Evidence`.

- [ ] **Step 4: Run, expect PASS.** Then the full TS loop.

- [ ] **Step 5:** Red-check: remove the `gate2Passed` condition — expect RED on "does NOT route a fence-refused test that also fails".

- [ ] **Step 6:** Commit.

```bash
git add packages/runner/src/testpage-router.ts packages/runner/tests/testpage-router.test.ts
git commit -m "feat(runner): R69 two-gate router with quoted gate-1 evidence"
```

### Task 5: Provenance through store, resume and report

**Files:**
- Modify: `packages/runner/src/store.ts` (`SCHEMA` ~line 86, `migrate()` ~line 136, `MutantVerdictRow` ~line 51)
- Modify: `packages/runner/src/report.ts` (`REPORT_SCHEMA_VERSION` line 78, `executionContext` ~line 838, console ~line 1045)
- Modify: `packages/runner/tests/report.test.ts` or a new `packages/runner/tests/runner-provenance.test.ts`

**Interfaces:**
- Produces: `runner` column on `mutants`; `readonly runner?: "fenced" | "client-services"` on `MutantVerdictRow`; `executionContexts` as an ARRAY on the report; `REPORT_SCHEMA_VERSION = 2`.

- [ ] **Step 1: Write the failing tests.**

```typescript
// A resumed interactive verdict must not read as fenced. Without this, run 1 kills a mutant under
// GuiAllowed=Yes, run 2 --resume re-records it with no tag, and an executionContext defined as
// "contexts used in THIS run" truthfully reports fenced-only — the exact drift the hardcoded
// guiAllowed:false literal prevents today.
test("a carried interactive verdict contributes its context to the report", () => {
  const r = buildReport({ /* …fenced run… */ carriedRunners: ["client-services"] });
  expect(r.validity.executionContexts.map((c) => c.runner)).toContain("client-services");
  expect(r.validity.executionContexts.find((c) => c.runner === "client-services")?.basis)
    .toContain("carried");
});

test("the schema version is bumped, because the executionContext shape is not backward compatible", () => {
  expect(REPORT_SCHEMA_VERSION).toBe(2);
});

test("each mutant row carries its runner, not just per-context counts", () => {
  const r = buildReport({ /* …one routed verdict… */ });
  expect(r.mutants[0]?.runner).toBe("client-services");
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Add `runner TEXT` to `SCHEMA`'s `mutants` table AND to `migrate()` following the existing guarded pattern:

```typescript
    if (!cols.some((c) => c.name === "runner")) {
      this.db.exec("ALTER TABLE mutants ADD COLUMN runner TEXT");
    }
```

Replace `executionContext` with `executionContexts: readonly {runner; guiAllowed; clientType; basis; verdictCount}[]`, bump `REPORT_SCHEMA_VERSION` to 2, add `runner` to the per-mutant report rows, scope the `NON-GUI EXECUTION` block to fenced verdicts, and add the companion block stating that under `GuiAllowed=Yes` an unhandled `Confirm` RAISES rather than returning its default.

- [ ] **Step 4: Run, expect PASS.** Full TS loop. Expect other tests referencing `executionContext` to break — update them; that breakage is the schema bump doing its job.

- [ ] **Step 5:** Red-check: revert the schema bump to 1 — expect RED; drop the carried-context contribution — expect RED on the resume test.

- [ ] **Step 6:** Commit.

```bash
git add packages/runner/src/store.ts packages/runner/src/report.ts packages/runner/tests/
git commit -m "feat(runner): R69 per-verdict runner provenance through store, resume and report"
```

### Task 6: Orchestrator wiring — routing, confirmation rerun, wedge quarantine

**Files:**
- Modify: `packages/runner/src/orchestrator.ts`
- Modify: `packages/runner/tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–5.

- [ ] **Step 1: Write the failing tests**, using the existing `QualificationBackend` harness in `orchestrator.test.ts` (see the `R69 —` and `R35 —` describe blocks for the pattern).

```typescript
// The fenced path never turns one failure into `killed` without a baseline confirmation (R27/R59).
// The routed path is the MOST nondeterministic session LethAL has — GuiAllowed=Yes lets dialogs
// raise — so it needs that defence more, not less.
test("a routed failure is confirmed before it becomes a kill", async () => {
  // routed test fails under the mutant AND fails its unmutated confirmation rerun
  const report = await runRoutedFlaky();
  // The report's per-mutant row names it `mutantCode` (report.ts:678 maps it from
  // `MutantManifestEntry.mutantId`) — `mutantId` does not exist on this row.
  const m = report.mutants.find((x) => x.mutantCode === "M0001");
  expect(m?.verdict).toBe("error");
  expect(m?.cause).toBe("unstable");
});

// A wedged RunBatch may still be executing WITH A MUTANT ACTIVE, holding locks. Recording a
// per-mutant error and continuing lets a fenced mutant's covering test fail on contention and be
// falsely killed.
test("a wedge quarantines the tier rather than recording a per-mutant error and continuing", async () => {
  const report = await runRoutedWedge();
  // `quarantined` is an OBJECT `{ reason }`, absent on an ordinary session — not a boolean.
  expect(report.quarantined).toBeDefined();
  expect(report.quarantined?.reason).toContain("M0001");
  expect(report.mutants.every((m) => m.verdict !== "killed")).toBe(true);
});

// The router must not leak: a mutant with fenced-green coverage keeps its fenced verdict.
test("a mutant with any fenced-green coverage is not routed", async () => {
  const report = await runMixedCoverage();
  expect(report.mutants.find((m) => m.mutantCode === "M0002")?.runner).toBe("fenced");
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Select routed tests via `selectRoutedTests`; select mutants covered EXCLUSIVELY by them; run each through `runOneBatchMethod`; on failure perform the confirmation rerun (same seed/run/readback, unmutated) and record `error cause=unstable` if it fails there too; on a wedge call the existing `quarantineInFlight` (`orchestrator.ts:835`) exactly as the fenced path does; tag every verdict with its runner. Serialize routed work against fenced work — never run it while a lease is held.

- [ ] **Step 4: Run, expect PASS.** Full TS loop.

- [ ] **Step 5:** Red-check: remove the confirmation rerun — expect RED on the flaky test; replace `quarantineInFlight` with a per-mutant `error` — expect RED on the wedge test.

- [ ] **Step 6:** Commit.

```bash
git add packages/runner/src/orchestrator.ts packages/runner/tests/orchestrator.test.ts
git commit -m "feat(runner): R69 route refused tests, confirm routed kills, quarantine on wedge"
```

---

## PHASE D — Live gate and re-freeze

### Task 7: Fixture, gates, differential

**Files:**
- Modify: `fixtures/sandbox-data-tests/src/DataTests.Codeunit.al` (add a `TestPage`-opening test)
- Modify: `CLAUDE.md` (re-freeze the gate figures)
- Modify: `ROADMAP.md` (close R69)

- [ ] **Step 1:** Add a `[Test]` to `fixtures/sandbox-data-tests` that opens the existing fixture page — the `pageextension` slice R30 left `no-coverage` precisely because of R69.
- [ ] **Step 2:** `bun run compile:fixtures`. This is mandatory after ANY `.al` change under `fixtures/` — nothing else compiles them, and a broken fixture leaves the gate measuring the previously published build (R56).
- [ ] **Step 3:** Publish the test app, then run `LETHAL_ITEST_TABLES=1 bun run itest:tables`.
- [ ] **Step 4:** Join against the frozen 69/9/6-over-84 baseline **per (mutant, runner)** — outcome alone cannot see a fenced-covered mutant drifting to an interactive kill. Every changed verdict must be explained or it is a BLOCK.
- [ ] **Step 5:** Run `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` (3/10/3) and `LETHAL_ITEST_ENVTOOL=1 bun run itest:envtool` (3/10/3). Both must be unchanged per-mutant AND all-fenced — any `client-services` tag there means the router leaked.
- [ ] **Step 6:** Run `/coverage-differential` if collection, selection or attribution changed.
- [ ] **Step 7:** Confirm report coherence: a gate-2-passing test must NOT still be listed as "cannot run on this path" while its verdicts print.
- [ ] **Step 8:** Update `CLAUDE.md`'s frozen figures and close ROADMAP R69. Commit.

```bash
git add fixtures/ CLAUDE.md ROADMAP.md
git commit -m "test(R69): TestPage fixture test + re-freeze gates per (mutant, runner)"
```

---

## Self-review notes

- **Spec coverage:** §3.1 → Task 4; §3.2 → Task 3; §3.3 → Tasks 1 (nonce field) + 3 (validation); §3.4 → Task 1; §3.5 → Tasks 1 + 3; §3.6 → Task 5; §4 → Task 0; §5 → Tasks 3 + 6; §6 → Task 6; §7 → Tasks 3–7; §8 → carried into Task 4's evidence test and the ROADMAP close.
- **Task 0 is a real gate**, not a formality. Its failure mode (noisy coverage turning `no-coverage` into `survived`) is the one transition the design forbids, so Phase B is genuinely abandoned rather than reshaped if the negative control fails.
- **Every Phase-C task's red-check names its specific mutation and expected RED test** — no "red-check the tests" hand-waves.
- **The AL tasks have no unit cycle** because AL has no harness here; their test is the `alc` compile plus Task 7's live gate, stated in Global Constraints.
- **Known residual, carried from spec §8:** gate 1 over-matches by construction. Task 4 tests the evidence-reporting mitigation, not exactness — there is none to test.
