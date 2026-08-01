# R69 — Client-Services TestPage Batch Runner: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let LethAL produce a verdict for tests that open a `TestPage` — which the fenced `ClientType=ODataV4` session refuses (`CreateNavTestService` NotSupported, 87 ms) — by running them through a control-app page action driven over the native client-services WebSocket (`U:/Git/bc-mcp`), whose session type CAN create a test service.

**Architecture:** A new control-app work-queue table + result table + a page whose one action loops the queue in-session (reusing the existing `LC Run Method` single-method primitive), writing result rows. LethAL seeds the queue over OData, invokes the page action over the bc-mcp WebSocket, reads results back. Phase 1 CLOSES the open R69 measurement (does a genuine client-services session open a TestPage) with the smallest artifact; Phase 2 productizes it into the runner behind a brainstorm/spec; Phase 3 ships the cheap report fix independent of all of it; Phase 4 is the post-R69 roadmap queue.

**Tech Stack:** AL (BC runtime 28, `extensions/lethal-control`), TypeScript/Bun (`packages/runner`), `U:/Git/bc-mcp` (native BC client-services protocol, TS), `bccontainerhelper` (publish), `alc` (offline compile).

## Global Constraints

- Control app object IDs: range **71000–71099**; **71000–71010 are taken**. New objects use **71011+**.
- New/changed control AL means: bump `extensions/lethal-control/app.json` version, bump `MIN_CONTROL_VERSION` in `packages/runner/src/harness.ts` in lockstep, then `/control-app` (rebuild + publish to every fixture container). Current: **1.0.0.10** on Cronus281 + Cronus283.
- AL has **no unit-test harness** here. Every AL task's "test" is: (1) offline `alc` compile clean (`/al-compile` or `al-compiler` subagent), then (2) the live measurement named in the task. There is no red/green unit cycle for AL.
- Build/test loop for any TS change (order matters — the dist trap): `bun run typecheck` → `rm -rf packages/*/dist` → `bun test` → `bun run compile:fixtures`.
- Conventions (CI fails otherwise): no `!` non-null assertions; `exactOptionalPropertyTypes` (`...(v !== undefined ? { k: v } : {})`); typed error classes extend `Error` directly; fail loudly on caller-contract violations (never return a plausible empty default). Biome only on touched files.
- Containers: `docker context use desktop-windows` first (session default is the Linux engine). Cronus281 (sandbox-app/-probes) and Cronus283 (sandbox-data) are up. Codeunit **79218 "Test Page Probe"** proc `ReportsTestPageOpen` is published on Cronus281 (probes 1.0.8.0) and raises `MEASURED testpage-open=OK | GuiAllowed=%1 | ClientType=%2` when the TestPage opens.
- Probe/measurement code lives in `bc-mcp/scripts/` (imports resolve there). Existing R69 probes: `bc-mcp/scripts/r69-*.ts` — reuse their wiring (`SessionFactory`, `OpenPageOperation`, `ExecuteActionOperation`, `ReadDataOperation`).
- `.mcp.json`'s `bc` server is already repointed to `http://Cronus281/BC` (was the dead `Cronus28`).

## Design tension to resolve BEFORE Phase 2 (not a blocker for Phase 1)

`design.md:276` — **"Every test runs in its own BC test runner invocation. Never batched, never reused across tests."** Rationale: BC has no session-state reset API, so third-party/base-app `SingleInstance` codeunits leak across runner invocations that share a session. The batch loop reuses ONE client-services session across many methods, which VIOLATES this invariant. Phase 1 runs exactly one method, so the tension does not bite. Phase 2 must decide the trade explicitly (options in Task 2.0). This is the single biggest open design question and is a product call, not a mechanical one.

---

## PHASE 0 — Probe 0 (optional, cheap, parallelizable): price the options from the binary

Independent of everything else; do it if you want the capability question answered from the DLL rather than from a live run. Not on the critical path.

### Task 0.1: Enumerate `NavSession` subclasses that override `CreateNavTestService`

**Files:** none in-repo — analysis only. Record findings in ROADMAP R69.

- [ ] **Step 1:** Copy `Microsoft.Dynamics.Nav.Ncl.dll` out of a container: `docker context use desktop-windows`, then `docker cp Cronus281:"C:/Program Files/Microsoft Dynamics NAV/280/Service/Microsoft.Dynamics.Nav.Ncl.dll" <scratchpad>/`. (If the path differs, find it: `docker exec Cronus281 powershell -c "Get-ChildItem -Recurse -Filter Microsoft.Dynamics.Nav.Ncl.dll 'C:/Program Files/Microsoft Dynamics NAV'"`.)
- [ ] **Step 2:** Open in ILSpy (or `ilspycmd` if installed). Search type `NavSession` and method `CreateNavTestService`.
- [ ] **Step 3:** Record: the base `NavSession.CreateNavTestService` behaviour (the one that throws `NotSupportedException`), and which subclasses OVERRIDE it to return a real service. Map each subclass to a `ClientType` if determinable.
- [ ] **Step 4:** Write the finding into ROADMAP R69 as a dated "Probe 0" clause — it converts the `(GuiAllowed, ClientType)` correlation into a mechanism, and tells you a priori whether the client-services session class is a capable one. It CANNOT prove seeding/execution/readback, so it is a discriminator, not a substitute for Phase 1.

---

## PHASE 1 — Close the R69 measurement with the smallest control-app artifact (the decisive step)

Builds the batch-runner's real components (queue table, result table, loop codeunit, page action, seed API) but exercises them with a single item. Success = the `MEASURED …` string produced ON the bc-mcp client-services transport, OR a definitive on-path `CreateNavTestService` refusal (approach dead — a fine, recorded outcome).

**File structure (Phase 1):**
- Create `extensions/lethal-control/src/BatchQueue.Table.al` (table 71011 "LC Batch Queue") — seed target.
- Create `extensions/lethal-control/src/BatchResult.Table.al` (table 71012 "LC Batch Result") — result rows.
- Create `extensions/lethal-control/src/BatchRunner.Codeunit.al` (codeunit 71013 "LC Batch Runner") — the in-session loop.
- Create `extensions/lethal-control/src/BatchRunner.Page.al` (page 71014 "LC Batch Runner") — List over 71012 + the `Run Batch` action.
- Modify `extensions/lethal-control/src/ControlApi.Codeunit.al` — add `SeedBatchItem` / `ClearBatch` OData actions.
- Modify `extensions/lethal-control/app.json` — version `1.0.0.10` → `1.0.0.11`.
- Modify `packages/runner/src/harness.ts:37` — `MIN_CONTROL_VERSION` `1.0.0.10` → `1.0.0.11`.
- Create `bc-mcp/scripts/r69-batch-spike.ts` — the decisive probe.

### Task 1.1: Work-queue and result tables

**Files:**
- Create: `extensions/lethal-control/src/BatchQueue.Table.al`
- Create: `extensions/lethal-control/src/BatchResult.Table.al`

**Interfaces:**
- Produces: table 71011 "LC Batch Queue" fields `Line No.`(1,Integer,PK) `Codeunit ID`(2,Integer) `Method`(3,Text[128]) `Mutant Id`(4,Text[64]) `Target App Id`(5,Text[40]); table 71012 "LC Batch Result" fields `Line No.`(1,Integer,PK) `Codeunit ID`(2,Integer) `Method`(3,Text[128]) `Ok`(4,Boolean) `Attested`(5,Boolean) `Result Json`(6,Blob) `Error Text`(7,Text[2048]). (Blob for `Result Json` because per-method JSON can exceed Text[2048]; expose it through a `GetResultJson()` procedure.)

- [ ] **Step 1:** Write `BatchQueue.Table.al`, mirroring `MutationActive.Table.al`'s header (`DataClassification = SystemMetadata; DataPerCompany = false; InherentPermissions = RIMD;`). Fields as in Interfaces. Key `PK` on `Line No.` clustered.
- [ ] **Step 2:** Write `BatchResult.Table.al` the same way. Add a `Blob` field `Result Json` and two procedures:

```al
procedure SetResultJson(NewJson: Text)
var
    OStr: OutStream;
begin
    "Result Json".CreateOutStream(OStr, TextEncoding::UTF8);
    OStr.WriteText(NewJson);
end;

procedure GetResultJson(): Text
var
    IStr: InStream;
    Result: Text;
begin
    CalcFields("Result Json");
    if not "Result Json".HasValue then
        exit('');
    "Result Json".CreateInStream(IStr, TextEncoding::UTF8);
    IStr.ReadText(Result);
    exit(Result);
end;
```

- [ ] **Step 3:** Compile: `/al-compile extensions/lethal-control` (or the `al-compiler` subagent). Expected: clean (0 errors). Do NOT publish yet.
- [ ] **Step 4:** Commit.

```bash
git add extensions/lethal-control/src/BatchQueue.Table.al extensions/lethal-control/src/BatchResult.Table.al
git commit -m "feat(control): R69 batch queue + result tables (71011/71012)"
```

### Task 1.2: The in-session batch loop codeunit

**Files:**
- Create: `extensions/lethal-control/src/BatchRunner.Codeunit.al`

**Interfaces:**
- Consumes: `LC Run Method` (71007) `SetRequest(Code[10]; Integer; Text)` + `Run()` + `Results(): Text`; `LC Control State` (71002) `NextSuiteName(): Code[10]`, `WriteActive`/attestation surface (`AttestationObservedAny(): Boolean`). NOTE: `LC Run Method.SetRequest` and `Results` exist; verify `LC Control State` exposes a callable activate + `AttestationObservedAny` — if `WriteActive` is `local`, add a thin public `ActivateForBatch(TargetAppId; ArtifactId; MutantId)` wrapper in Task 1.2a.
- Produces: codeunit 71013 "LC Batch Runner" `procedure RunBatch()`.

- [ ] **Step 1:** Write the loop. Per queue row: if `Mutant Id` non-blank, activate it (attestation); run exactly one method via `LC Run Method`; capture result JSON on success or `GetLastErrorText` on a caught error; record `AttestationObservedAny`; insert a `LC Batch Result` row; **`Commit()` after every row** (Fable constraint — a later method's test-isolation rollback must not eat earlier result rows).

```al
namespace LethAL.Control;

/// <summary>R69: the in-session batch loop, invoked as ONE page action over the client-services
/// WebSocket. Reuses "LC Run Method" (the single-method fence primitive) per queue item so the AL
/// runs in the capable client-services session — the one that CAN CreateNavTestService — rather than
/// the fenced ODataV4 session that refuses it. Commits after every result row: each RunMethod drives
/// the platform test runner whose per-method isolation ROLLS BACK, and an uncommitted result row would
/// be rolled back with it (the project's empty-vs-empty signature bug).</summary>
codeunit 71013 "LC Batch Runner"
{
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
            Res."Error Text" := ErrText;
            Res.SetResultJson(Json);
            Res.Insert(true);
            Commit();
        until Queue.Next() = 0;
    end;
}
```

- [ ] **Step 2:** If `AttestationObservedAny` or `NextSuiteName` is not public on `LC Control State`, add the minimal public wrapper(s) in `ControlState.Codeunit.al` (Task 1.2a) and re-check. Keep wrappers thin; do not change existing semantics.
- [ ] **Step 3:** `/al-compile extensions/lethal-control`. Expected: clean. Resolve any "member is not accessible" by promoting the exact wrapper only.
- [ ] **Step 4:** Commit.

```bash
git add extensions/lethal-control/src/BatchRunner.Codeunit.al extensions/lethal-control/src/ControlState.Codeunit.al
git commit -m "feat(control): R69 in-session batch loop (71013), commit-per-row"
```

### Task 1.3: The page + action (the WebSocket entry point) and the seed API

**Files:**
- Create: `extensions/lethal-control/src/BatchRunner.Page.al`
- Modify: `extensions/lethal-control/src/ControlApi.Codeunit.al`

**Interfaces:**
- Produces: page 71014 "LC Batch Runner" (List, SourceTable "LC Batch Result") with action caption **`Run Batch`** calling `Codeunit."LC Batch Runner".RunBatch()`; OData actions `LethALControl_SeedBatchItem(codeunitId: Integer; method: Text)` and `LethALControl_ClearBatch()`.

- [ ] **Step 1:** Write the page — a minimal List over `LC Batch Result` (scalar fields only) whose sole job is to carry the `Run Batch` action reachable over the WebSocket. Do NOT try to surface `Result Json` on the page: a repeater field bound to a page-level global shows the last row's value for every row, and bc-mcp cannot read a `Blob` over `read-data`. Readback happens over OData (Step 2's `GetBatchResults`). The action is a plain (non-promoted) action so `executeAction({action:"Run Batch"})` resolves by caption; it calls `RunBatch()` then `CurrPage.Update(false)`.

```al
namespace LethAL.Control;

page 71014 "LC Batch Runner"
{
    PageType = List;
    SourceTable = "LC Batch Result";
    Editable = false;
    ApplicationArea = All;
    UsageCategory = Administration;

    layout
    {
        area(Content)
        {
            repeater(Lines)
            {
                field("Codeunit ID"; Rec."Codeunit ID") { }
                field(Method; Rec.Method) { }
                field(Ok; Rec.Ok) { }
                field(Attested; Rec.Attested) { }
                field("Error Text"; Rec."Error Text") { }
            }
        }
    }

    actions
    {
        area(Processing)
        {
            action("Run Batch")
            {
                Caption = 'Run Batch';
                ApplicationArea = All;
                trigger OnAction()
                var
                    Runner: Codeunit "LC Batch Runner";
                begin
                    Runner.RunBatch();
                    CurrPage.Update(false);
                end;
            }
        }
    }
}
```

- [ ] **Step 2:** Add to `LC Control API` (71003) THREE OData actions — seed, clear, and read-back — mirroring the existing `procedure`-as-unbound-action pattern already in that codeunit. `GetBatchResults` returns a JSON array so the probe (and later the runner) read the per-method result — including the MEASURED string, which lands INSIDE `LC Run Method`'s result JSON, not in `Error Text` (the test runner captures the test's `Error`, so `Run()` returns true and `Ok` is true) — over OData:

```al
/// <summary>R69: read every batch result row back as one JSON array. The per-method result JSON
/// (which carries a raised `MEASURED …` / `CreateNavTestService` message) is embedded per row.</summary>
procedure GetBatchResults() ResultsJson: Text
var
    Res: Record "LC Batch Result";
    Arr: JsonArray;
    Obj: JsonObject;
    Inner: JsonToken;
begin
    if Res.FindSet() then
        repeat
            Clear(Obj);
            Obj.Add('lineNo', Res."Line No.");
            Obj.Add('codeunitId', Res."Codeunit ID");
            Obj.Add('method', Res.Method);
            Obj.Add('ok', Res.Ok);
            Obj.Add('attested', Res.Attested);
            Obj.Add('errorText', Res."Error Text");
            if Inner.ReadFrom(Res.GetResultJson()) then
                Obj.Add('result', Inner)
            else
                Obj.Add('resultRaw', Res.GetResultJson());
            Arr.Add(Obj);
        until Res.Next() = 0;
    Arr.WriteTo(ResultsJson);
end;
```

  Then the seed/clear actions:

```al
/// <summary>R69: seed one work item into the batch queue over OData. LethAL calls this before
/// driving the page action over the client-services WebSocket.</summary>
procedure SeedBatchItem(codeunitId: Integer; method: Text) LineNo: Integer
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
    Queue.Insert(true);
    Commit();
end;

procedure ClearBatch()
var
    Queue: Record "LC Batch Queue";
    Res: Record "LC Batch Result";
begin
    Queue.DeleteAll(true);
    Res.DeleteAll(true);
    Commit();
end;
```

- [ ] **Step 3:** `/al-compile extensions/lethal-control`. Expected: clean. (The three Control API procedures auto-register as `/ODataV4/LethALControl_SeedBatchItem`, `_ClearBatch`, and `_GetBatchResults` via the existing web-service registration — no Install change needed; they hang off the already-registered `LethALControl` codeunit service.)
- [ ] **Step 4:** Commit.

```bash
git add extensions/lethal-control/src/BatchRunner.Page.al extensions/lethal-control/src/ControlApi.Codeunit.al
git commit -m "feat(control): R69 batch runner page + SeedBatchItem/ClearBatch OData actions"
```

### Task 1.4: Version bump + publish

**Files:**
- Modify: `extensions/lethal-control/app.json` (`"version": "1.0.0.10"` → `"1.0.0.11"`)
- Modify: `packages/runner/src/harness.ts:37` (`MIN_CONTROL_VERSION = "1.0.0.10"` → `"1.0.0.11"`)

- [ ] **Step 1:** Bump both versions in lockstep (a control app older than `MIN_CONTROL_VERSION` is refused by the harness — that check is why they move together).
- [ ] **Step 2:** `bun run typecheck` → `rm -rf packages/*/dist` → `bun test packages/runner` (the `MIN_CONTROL_VERSION` constant is asserted in `packages/runner/tests/cli.test.ts` — confirm still green).
- [ ] **Step 3:** `/control-app` — rebuild `lethal-control.app` with `alc` and publish to **Cronus281 and Cronus283** (tenant-scoped: `-scope Tenant -tenant default`). Confirm both report 1.0.0.11.
- [ ] **Step 4:** Commit.

```bash
git add extensions/lethal-control/app.json packages/runner/src/harness.ts
git commit -m "chore(control): bump LethAL Control 1.0.0.11 (R69 batch runner)"
```

### Task 1.5: The decisive probe — run 79218 over the client-services WebSocket

**Files:**
- Create: `bc-mcp/scripts/r69-batch-spike.ts`

**Interfaces:**
- Consumes: the bc-mcp wiring from `bc-mcp/scripts/r69-run79218.ts` (SessionFactory, OpenPageOperation, ExecuteActionOperation, ReadDataOperation); the OData action endpoints `LethALControl_ClearBatch` / `_SeedBatchItem` on `http://Cronus281/BC` (NTLM `sshadows`/`1234`).

- [ ] **Step 1:** Write the probe. **(DONE this session — authored at `bc-mcp/scripts/r69-batch-spike.ts`, UNVERIFIED because the control surface is not published yet; the publish+measure session runs and iterates it. Report: `.superpowers/sdd/…/task-1.5-report.md`.)** OData ENDPOINT CORRECTION (a plan error the author caught): the LethALControl OData actions are NOT on the WebSocket host:port — they are on BC's **derived OData port (7048)** with **HTTP Basic auth** and **required `company` + `tenant` query params** (BC 400s "the parameter 'company' is required" without `company`; see `packages/runner/src/run-mutant-transport.ts`, `harness.ts`, `harness.test.ts:237`, and the manual-curl recipe in `docs/do-trial-runbook.md`). Use bc-mcp's `cfg.bc.odataUrl` (its `deriveODataUrl`), NOT `cfg.bc.baseUrl`; reserve the NTLM/cookie session for the WebSocket handshake only.
  1. Seed over OData (Basic auth, port 7048, `?company=<Cronus281 company>&tenant=default`): `POST …/ODataV4/LethALControl_ClearBatch` `{}`; then `POST …/ODataV4/LethALControl_SeedBatchItem` `{"codeunitId":79218,"method":"ReportsTestPageOpen"}`.
  2. Over the bc-mcp WebSocket: open page **71014**; `executeAction({ action: "Run Batch" })`; if any dialog opens, dismiss with Ok(300) (the run should NOT prompt — a plain action, no StrMenu — so a dialog signals an error to surface).
  3. Read results over OData: `POST …/ODataV4/LethALControl_GetBatchResults` `{}`; the scalar `value` is a JSON STRING — parse `value`, then parse that inner JSON array, find the entry for codeunit 79218, inspect its `result` (the per-method JSON, which carries the raised `MEASURED …` message) and `errorText`. (The MEASURED string is inside `result`, NOT `errorText` — see Task 1.3 Step 2.)
  - **Open item for the publish+measure session:** Basic auth on 7048 with `sshadows`/`1234` is assumed from precedent, not verified — if the seed 401s, check the auth/port first.
- [ ] **Step 2:** Run it: `cd U:/Git/bc-mcp && BC_BASE_URL=http://Cronus281/BC BC_USERNAME=sshadows BC_PASSWORD=1234 BC_TENANT_ID=default npx tsx scripts/r69-batch-spike.ts`.
- [ ] **Step 3:** Read the verdict:
  - **PROVEN** if the result contains `MEASURED testpage-open=OK | GuiAllowed=… | ClientType=…` → a genuine client-services session opened the TestPage. Record the exact `GuiAllowed`/`ClientType` tuple the test SAW on this path (this is the datum link (c) was missing). R69's client-services route is now measured end-to-end.
  - **DEAD** if it contains `CreateNavTestService` NotSupported → the client-services `NavSession` subclass refuses too; the approach cannot rescue TestPage tests. Record loudly; fall through to Phase 3 (report-only fix) as the sole remaining lever.
  - **INCONCLUSIVE** → inspect `Error Text`/`Result Json`; likely a seeding or attestation wiring gap, not a capability answer.
- [ ] **Step 4:** Update ROADMAP R69 with the outcome (dated), and mark the SPIKE clause resolved (PROVEN or DEAD). Commit the probe.

```bash
git add bc-mcp/scripts/r69-batch-spike.ts
git commit -m "measure(probe): R69 batch runner spike — 79218 over client-services"
```

**GATE:** If DEAD, skip Phase 2 entirely and go to Phase 3 + Phase 4. If PROVEN, continue.

---

## PHASE 2 — Productize into the runner (only if Phase 1 PROVEN; design-gated)

This phase changes how a verdict is reached, so it needs a spec and adversarial review BEFORE code. Do NOT hand-wave the tasks below into implementation without Task 2.0.

### Task 2.0: Brainstorm + spec + adversary (REQUIRED before any Phase 2 code)

- [ ] **Step 1:** Run `superpowers:brainstorming` on the batch-runner integration. Resolve, at minimum, these decisions:
  1. **Session-reuse vs `design.md:276`.** One WebSocket session runs many methods → `SingleInstance` leakage across methods, violating "never reused across tests". Options: (a) one method per WebSocket session (safe, loses the batch perf win — but this path only carries the small TestPage-refused slice, so cost may be fine); (b) batch N methods per session and accept reduced isolation for this slice, documented; (c) reset what LethAL can (`Clear`) between methods, accept the rest. Pick one and write the rationale into `design.md`.
  2. **Scope.** Route ONLY fence-REFUSED tests here; everything else stays on the fenced default (R58). Requires detecting the `CreateNavTestService` refusal at baseline and per-test routing. Touches R55's dual-runner asymmetry and R58's one-runner doctrine — name it.
  3. **Per-test runner provenance in the report** (which runner produced each verdict), so a reader sees interactive-semantics verdicts as distinct.
  4. **Nonce** (Fable): the control queue/result tables need a per-invocation nonce so a stale batch's rows can never be read as this batch's (the R69 stale-suite discovery generalises).
  5. **Hang story** (Fable): the batch WebSocket can wedge mid-queue (the unexplained Cronus283 `in-flight-unknown`). The design must distinguish, for items AFTER a wedge, "not run" from "run, unrecorded" — never a wrong verdict.
  6. **Product call** (R55/R57): this path runs `GuiAllowed=Yes`, so an unhandled `Confirm` RAISES instead of returning its default — verdicts carry interactive semantics. Confirm with the user that scoping to refused tests + provenance is acceptable.
  7. **Attestation reset + the inert Phase-1 fields** (task-1.1-3 review finding). In Phase 1, table 71011's `Mutant Id`/`Target App Id` and table 71012's `Attested` are INERT PLACEHOLDERS by design: `SeedBatchItem` populates neither mutant field, `RunBatch` never calls `WriteActive`, and Phase 1 runs one plain test (79218) with no mutant. Phase 2 MUST: (a) populate `Mutant Id`/`Target App Id` on seed and have `RunBatch` `WriteActive` per row; (b) fix the attestation LEAK — `LC Control State.AttestationObservedAny()` is a `SingleInstance` flag set `true` by the target's guards and reset only by `WriteActive`/`ClearActiveIf`/`ForceClearActive`, none of which `RunBatch` currently calls, so once any row touches an instrumented site every LATER row in the batch also reads `Attested = true`. The loop must reset attestation per row (activate → run → read → clear) so `Attested` is per-row-meaningful. Until Phase 2 does this, no verdict may treat 71012's `Attested`/`Mutant Id` as load-bearing.
- [ ] **Step 2:** Write the spec to `docs/superpowers/specs/2026-…-r69-batch-runner-design.md`.
- [ ] **Step 3:** Run the `spec-adversary` agent (on `fable`) over the spec — it hunts for sequences producing a false kill / wrong verdict / silently-empty confirmation. Fix what it finds.
- [ ] **Step 4:** Write the implementation plan for Phase 2 (a fresh `writing-plans` pass off the spec). The tasks below are the SKELETON that plan will flesh out — they are not yet bite-sized because their shape depends on Task 2.0's decisions.

### Task 2.1 (skeleton): Batch backend + transport

- [ ] New backend module in `packages/runner/` (sibling to `run-mutant-transport.ts`): seed the queue over OData (`LethALControl_SeedBatchItem`), drive `Run Batch` over the bc-mcp WebSocket, read results over OData (expose `LC Batch Result` as an OData page/query — a new registration, or a `GetBatchResults` Control API action returning JSON). Carry the nonce end-to-end.
- [ ] Unit tests with a fake WebSocket/OData that assert: commit-per-row ordering (call-counter on the fake, never wall-clock), nonce match required, a wedge mid-queue yields `run-unrecorded` (not a verdict) for trailing items.

### Task 2.2 (skeleton): Orchestrator routing + provenance

- [ ] In `orchestrator.ts`: detect the baseline `CreateNavTestService` refusal per test; route only those tests to the batch backend; tag each resulting verdict with its runner provenance; everything else unchanged on the fenced default.
- [ ] Extend the report/store (`store.ts`) with a per-verdict `runner` column; surface it.

### Task 2.3 (skeleton): Live gate + differential

- [ ] Run `/coverage-differential` if collection/selection/attribution changed.
- [ ] Add a fixture test that OPENS a TestPage (the pageextension slice R30 left `no-coverage`, R69) and confirm it now yields a verdict via the batch path. Re-freeze the affected gate figures (`itest:tables` etc.) with a per-mutant join, not aggregate counts.
- [ ] Red-check every load-bearing new test with `mutation-red-checker`.

---

## PHASE 3 — The cheap report fix (do this REGARDLESS of Phase 1's outcome)

Independent of the whole client-services route. Ships value now: a `TestPage` suite on the fenced default silently loses those tests at baseline; name the refusal so a reader sees "these tests cannot run on this path" instead of N unexplained baseline failures.

### Task 3.1: Name the `CreateNavTestService` refusal in the report

**Files:**
- Modify: the baseline/verdict reporting path in `packages/runner/` (search for where `AlcCompileError` / other typed refusals are named in the report — `grep -rn "CreateNavTestService\|baseline-red\|refus" packages/runner/src`). Mirror how R27/R35/R59 name their refusals.

- [ ] **Step 1 (failing test):** In the appropriate runner test file, add a test: given a baseline test that failed with a message containing `CreateNavTestService` / `Specified method is not supported`, the report classifies it as `testpage-unsupported-on-path` (a named, safe category) rather than a generic baseline failure, and every mutant covered ONLY by such tests is reported `no-coverage` with that reason string.
- [ ] **Step 2:** Run it — expect FAIL (`bun test packages/runner -t "<name>"` after the dist-clean).
- [ ] **Step 3:** Implement the classifier + report string. Keep the typed-error separation intact (a new category, not folded into `AlcCompileError`).
- [ ] **Step 4:** Run — expect PASS. Then `bun run typecheck` → `rm -rf packages/*/dist` → `bun test packages/runner`.
- [ ] **Step 5:** `mutation-red-checker` on the new test (revert the classifier, confirm it goes red, restore).
- [ ] **Step 6:** Commit.

```bash
git add packages/runner/src/<file> packages/runner/tests/<file>
git commit -m "feat(runner): R69 — name the CreateNavTestService refusal in the report"
```

---

## PHASE 4 — Post-R69 roadmap queue (sequenced backlog, ranked by risk)

These are separate items with their own ROADMAP rows and evidence pointers; each gets its own `writing-plans` pass when reached. **Working rule for every one (learned the hard way): VERIFY the row's prescribed fix against the code BEFORE implementing — reading the code first has repeatedly turned a "false kill" hazard into a non-issue or revealed the real content was a missing diagnosis.** Run the fixed per-item cycle from `docs/superpowers/plans/2026-07-31-roadmap-execution-2.md`.

- [ ] **R70 — dangerous direction, do first.** `buildSymbolTable` keys scope on the bare object name, so `page "CDO Setup"` overwrites `table "CDO Setup"`'s variables (13 such collisions on Document Output). Fix = R30's `scopeKeyOf(kind, name)` shape one namespace over; touches 4 call sites (`receiver.ts` `lookupVar`, `types.ts` ×2, `callers.ts`) + every engine test asking `globalsOf("Vars Test")` by bare name. Needs a fixture with a cross-kind collision (all four frozen gates are blind to it). Entry: reproduce the overwrite in a unit test first.
- [ ] **R72 / R73 — RemoveCommit debts.** (R72) BC's "cannot run codeunit in a write transaction" is not distinguished from a genuine kill. (R73) no gate has ever GENERATED a `remove-commit` mutant (both fixture sites are shadowed negatives); R73's fixture work also settles whether a committed write survives a later uncaught error under test isolation — the operator's actual kill mechanism, still unmeasured.
- [ ] **R66 — now implementable.** `GetLastErrorCode()` returns `DB:ClientInsertDenied` in EN + DA and the `(TableData <id> <name> <op>: <suite>)` parenthetical survives translation byte-identically → the parenthetical is the cheap route (no AL change, no `MIN_CONTROL_VERSION` bump). Needs a red-check + a control proving a non-refusal message with a similar parenthetical is NOT matched.
- [ ] **R71 — `SwapRecXRec`.** Scope to `OnValidate`/`OnRename` (where `xRec` measurably differs, `differ=Yes`); must NOT claim `OnModify`-shaped sites (measured equivalent). First Tier-2 operator whose targeting depends on the enclosing TRIGGER KIND, not the receiver.
- [ ] **R67 / R68 — safe-direction coverage losses.** (R67) a plain `page`'s implicit `Rec` is refused though its `SourceTable` is right there (66 sites on DO). (R68) a variable declared in a TRIGGER's own `var` section resolves in no object kind.
- [ ] **Exit — Tier-3 program.** Fresh `superpowers:brainstorming` for Tier-3 (R13, which unblocks R11). Own spec, plan, battleplan.

---

## Self-review notes

- **Phase 1 is fully bite-sized and concrete** — the only phase where every step's content is fully known today, because it builds on the existing `LC Run Method` primitive and known page/table patterns.
- **Phase 2 is deliberately a skeleton behind Task 2.0** — it changes how a verdict is reached, and its shape depends on the `design.md:276` session-reuse decision, which is a product/design call, not a mechanical one. Pretending to pre-write its code would be a placeholder in disguise.
- **Phase 3 is independent** and worth shipping even if Phase 1 comes back DEAD.
- **AL "tests" are compile + live measurement**, not unit tests — stated in Global Constraints and applied per AL task, because AL has no unit harness in this repo.
- **Open risk carried from the spike:** `AttestationObservedAny` / `NextSuiteName` visibility on `LC Control State` (Task 1.2 Step 2) — if `local`, a thin public wrapper is needed; flagged, not assumed.
