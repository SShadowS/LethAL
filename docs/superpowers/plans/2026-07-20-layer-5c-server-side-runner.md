# Layer 5C-A — Server-Side Execution Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) tracking. **Note:** several tasks require a LIVE BC container (Cronus281) + AL compile/publish — those verify live, not via `bun test`. The live/AL tasks suit inline execution (with the user's container) more than fire-and-forget subagents; see Execution Handoff.

**Goal:** Move the active-mutant control surface out of the instrumented target into a stable `LethAL Control` extension and execute each mutant via one self-contained OData `RunMutant` call (activate → run one method → clear), reproducing the frozen bcdev verdict table (3/10/3) through the new path plus protocol-invariant probes.

**Architecture:** A new standalone AL app (`LethAL Control`) owns the active-mutant state, a target-artifact registry (written by the target via `RegisterArtifact`), and an OData `RunMutant` action that runs exactly one test method through the AL Test Suite framework under Codeunit isolation and clears on every terminal path. The instrumented target depends on it and its guards call into it. bcdev `run()` issues `RunMutant`; coverage discovery stays on the hub. No lease/fence (that's 5C-B).

**Tech Stack:** AL (BC 28, `Test Runner` app, `Test Suite Mgt.`), Bun + TypeScript (schemata emission, bcdev backend, itests), OData V4, `altool` publish, live Cronus281.

## Global Constraints

- **Frozen verdict tables:** bcdev **3 killed / 10 survived / 3 no-coverage (23.1%)**, al-runner **3 / 13 / 0 (18.8%)**. Reproduced through the new `RunMutant` path — a differing verdict is a bug → BLOCKED.
- **The gate is the per-mutant frozen table PLUS protocol invariants** (spec §11) — the fixture's two independent tests make the aggregate table blind to a wrong-test-set runner.
- **Exact-method selection:** `RunAllTests` resets input filters — select by per-line `Run` flags (`Run=false` all, `Run=true` one via exact `SetRange`), never an AL filter. Fail closed unless exactly one method + one terminal result.
- **Run-scoped:** `RunMutant` clears the active state on every terminal path (incl. framework/test error) + `Commit`; the container is unmutated after every call.
- **5B dispatch classification on the new transport:** pre-dispatch-rejected vs in-flight-unknown → quarantine; never retry on the same container; a generic timeout omitting `in-flight-unknown` is a forbidden regression.
- **Codeunit isolation only** (not Function). **Coverage stays hub-discovered, one method per call.**
- **Identity tuple:** `RunMutant` echoes `(targetAppId, artifactId, attemptId, mutantId, codeunitId, method)`; client rejects mismatches.
- **Reserved params:** `leaseEpoch`/`leaseToken` present but MUST be empty in 5C-A (rejected if non-empty).
- **No cross-app dependency cycle:** dependency runs target→control ONLY. Control never depends on the target; it learns the artifact id via the registry.
- **AL id-range:** `LethAL Control` uses its OWN id-range, never CentralGauge's 50500–50599.
- **The dist trap:** `bun run typecheck` separate; `rm -rf packages/*/dist` after typecheck / before any reported `bun test`.
- **Windows / Git bash:** Windows paths, never `2>nul`. No `!`; `exactOptionalPropertyTypes`; typed errors. Branch: `layer-5c-server-side-runner`.
- **Live infra:** Cronus281 (server `http://Cronus281`, instance `BC`, tenant `default`, company `CRONUS Danmark A/S`, `sshadows`/`1234`); config `fixtures/sandbox-app/lethal.config.local.json`. Integration tests env-gated, foreground, do not poll.

## File Structure

**New AL (`extensions/lethal-control/`):**
- `app.json` — own id + id-range, MS `Test Runner` dependency.
- `src/MutationActive.Table.al` — active `(targetAppId, artifactId, mutantId)` state (row).
- `src/TargetArtifactRegistry.Table.al` — `targetAppId → artifactId`.
- `src/ControlState.Codeunit.al` — SingleInstance cache + setter/clear/guard-check; `RegisterArtifact`.
- `src/RunMutant.Codeunit.al` — the OData action (activate+run one method+clear); `HarnessInfo`.
- `src/Install.Codeunit.al`, `src/Upgrade.Codeunit.al` — web-service registration, full-row reconcile.

**Modified schemata (`packages/schemata/src/`):**
- `selector.ts` — target guards call the control extension; remove in-target control surface; emit `RegisterArtifact` call in the target's install; keep `ArtifactId()`.
- `project.ts` — add the `LethAL Control` dependency to the target's `app.json`.

**Modified runner (`packages/runner/src/`):**
- `run-mutant-transport.ts` (new) — OData client for `RunMutant`, 5B-classified, identity-validated.
- `bcdev-backend.ts` — `activate()` → bookkeeping; `run()` → `RunMutant`; harness provisioning + `HarnessInfo` verify; qualification-baseline unsupported-test flagging.
- `harness.ts` (new) — publish/install/verify `LethAL Control` as a prerequisite.

**Fixtures/tests:** protocol-invariant probe test codeunits under `fixtures/`; itest updates.

---

## Task 1: LIVE SPIKE — prove an OData action can run one test method

**Goal:** Resolve the make-or-break (spec §13) before building the real extension. Throwaway.

**Files:** `extensions/spike-runner/` (throwaway AL app), a scratch invocation script.

**Verification is LIVE (Cronus281), not `bun test`.**

- [ ] **Step 1: Minimal spike extension**

Create a throwaway AL app (own scratch id-range) with a codeunit exposing an OData V4 unbound action `RunOne(testCodeunitId: Integer; testMethod: Text): Text` that: builds an AL Test Suite (unique name), sets `Run=false` on all lines then `Run=true` on the one line matching `testMethod` (exact `SetRange` on the function name), runs under `Test Runner - Isol. Codeunit` (130450), and returns that one method's `{outcome, message}` as JSON. Mirror CentralGauge's `WSTestRunner.Codeunit.al` (`Test Suite Mgt.` usage) but (a) single-method via Run flags, (b) exposed as an OData action (web-services XML `CodeUnit`), not SOAP. Register via an Install codeunit.

```al
// sketch — fill from CentralGauge's Test Suite Mgt. usage
codeunit 90000 "LC Spike Runner"
{
    procedure RunOne(TestCodeunitId: Integer; TestMethod: Text) ResultJson: Text
    var
        ALTestSuite: Record "AL Test Suite";
        Line: Record "Test Method Line";
        Mgt: Codeunit "Test Suite Mgt.";
        Obj: JsonObject;
        SuiteName: Code[10];
    begin
        SuiteName := 'LCSPK';
        if ALTestSuite.Get(SuiteName) then ALTestSuite.Delete(true);
        Mgt.CreateTestSuite(SuiteName);
        ALTestSuite.Get(SuiteName);
        Mgt.SelectTestMethodsByRange(ALTestSuite, Format(TestCodeunitId));
        // Run flags: false all, true the one method (RunAllTests resets filters!)
        Line.SetRange("Test Suite", SuiteName);
        Line.SetRange("Line Type", Line."Line Type"::"Function");
        if Line.FindSet() then repeat Line.Run := false; Line.Modify(); until Line.Next() = 0;
        Line.Reset();
        Line.SetRange("Test Suite", SuiteName);
        Line.SetRange("Line Type", Line."Line Type"::"Function");
        Line.SetRange(Name, TestMethod); // exact match, not a filter expression
        if Line.Count() <> 1 then error('expected exactly one method %1, got %2', TestMethod, Line.Count());
        Line.FindFirst(); Line.Run := true; Line.Modify();
        Line.Reset(); Line.SetRange("Test Suite", SuiteName); Line.FindFirst();
        Mgt.RunAllTests(Line);
        // read back the one method's result line
        Line.Reset(); Line.SetRange("Test Suite", SuiteName);
        Line.SetRange("Line Type", Line."Line Type"::"Function"); Line.SetRange(Name, TestMethod);
        Line.FindFirst();
        Obj.Add('method', TestMethod);
        Obj.Add('result', Format(Line.Result)); // Success/Failure/Skipped/... enum
        Obj.Add('message', Line."Error Message Preview");
        Obj.WriteTo(ResultJson);
    end;
}
```

- [ ] **Step 2: Publish to Cronus281 + register the web service**

Compile with `alc`, publish with `altool` (the same path LethAL uses), confirm the OData action is reachable: `POST http://Cronus281/ODataV4/<svc>_RunOne?company=...&tenant=default` with `{ "testCodeunitId": <fixture test cu>, "testMethod": "OverBudgetDetected" }`.

- [ ] **Step 3: Probe — does it run, single-method, isolation, result?**

Invoke `RunOne` for the fixture's `OverBudgetDetected` and `ClampPercentRuns` separately. Confirm: (a) it executes (returns a real pass/fail), (b) requesting one method runs ONLY that method (add a temporary 2-method probe codeunit where running both changes the result), (c) the result maps to a usable outcome. Record the exact JSON shapes + the `Result` enum values.

- [ ] **Step 4: Decision + record**

Write the outcome to the spec's §15 evidence appendix: **OData-runs-tests = YES** (proceed with OData `RunMutant`) or **NO** (fall back to a SOAP codeunit web service — CentralGauge's exact pattern — keeping the protocol transport-independent). Capture the working AL Test Suite API calls + result-enum mapping for Task 3. Delete the spike extension from the container after.

- [ ] **Step 5: Commit the spike record (not the throwaway app)**

```bash
cd U:/Git/LethAL && git add docs/superpowers/specs/2026-07-20-layer-5c-server-side-runner-design.md
git commit -m "spike(5c): OData-action-runs-tests probe result recorded in spec appendix"
```

> If the spike BLOCKS (neither OData nor SOAP can run a single method with usable per-method results), STOP and escalate — the layer's execution model needs rethinking before any further task.

---

## Task 2: `LethAL Control` extension — state, registry, HarnessInfo, install

**Files:**
- Create: `extensions/lethal-control/app.json`, `src/MutationActive.Table.al`, `src/TargetArtifactRegistry.Table.al`, `src/ControlState.Codeunit.al`, `src/Install.Codeunit.al`, `src/Upgrade.Codeunit.al`, `src/HarnessInfo.Codeunit.al` (or fold HarnessInfo into RunMutant's codeunit).
- Test: live compile + a `HarnessInfo` round-trip probe.

**Interfaces (Produces):**
- Table `Mutation Active`: `TargetAppId`, `ArtifactId`, `MutantId` (DataPerCompany=false, single row).
- Table `Target Artifact Registry`: `TargetAppId` (PK), `ArtifactId`.
- Codeunit `LC Control State` (SingleInstance): `SetActive(targetAppId, artifactId, mutantId)`, `ClearActive()`, `IsActive(targetAppId, artifactId, mutantId): Boolean`, `RegisterArtifact(targetAppId, artifactId)`, `RegisteredArtifact(targetAppId): Text`.
- `HarnessInfo(): Text` (JSON: appId, semver, protocolVersion, isolationModes, testTypes).

- [ ] **Step 1: `app.json`** — own app id (fresh GUID), own id-range (e.g. 71000–71099 — NOT 50500–50599), `Test Runner` dependency, `target: OnPrem`, runtime matching BC28.

- [ ] **Step 2: Tables** — `Mutation Active` (the active tuple, single row keyed by a constant PK) and `Target Artifact Registry` (`TargetAppId` PK → `ArtifactId`). Both `DataPerCompany = false`.

- [ ] **Step 3: `LC Control State` SingleInstance codeunit** — cache the active tuple in SingleInstance vars AND mirror to the row; `SetActive` updates both + `Commit()`; `ClearActive` clears both + `Commit()`; `IsActive` returns cache match; `RegisterArtifact` upserts the registry row; `RegisteredArtifact` reads it. (The guard the target calls is `IsActive`.)

- [ ] **Step 4: Install + Upgrade codeunits** — register the RunMutant codeunit (Task 3) as a Tenant Web Service, reconciling the full row (name/type, object id, `Published`); a conflicting name→wrong object fails loudly. Upgrade codeunit re-reconciles.

- [ ] **Step 5: `HarnessInfo`** — returns the JSON identity/capability block.

- [ ] **Step 6: LIVE — compile + publish + `HarnessInfo` round-trip**

Compile with `alc`, publish with `altool`, call `HarnessInfo` over OData, confirm the expected appId/protocolVersion/testTypes come back. Commit the AL + a note.

```bash
cd U:/Git/LethAL && git add extensions/lethal-control && git commit -m "feat(5c): LethAL Control extension — active state, target-artifact registry, HarnessInfo, install/upgrade"
```

---

## Task 3: `RunMutant` OData action (activate → run one method → clear)

**Files:** Create `extensions/lethal-control/src/RunMutant.Codeunit.al`; live probes.

**Interfaces (Produces):** the `RunMutant(targetAppId, artifactId, attemptId, mutantId, testCodeunitId, testMethod, leaseEpoch, leaseToken)` OData action returning the identity-tuple + `{outcome, message, stackTrace}` JSON (spec §5).

- [ ] **Step 1: Implement `RunMutant`** following spec §5 exactly, using Task 1's proven AL Test Suite API:
  1. Reserved-param guard: `leaseEpoch`/`leaseToken` non-empty → error.
  2. Artifact guard: `RegisteredArtifact(targetAppId) <> artifactId` → return `artifact-mismatch`, run nothing.
  3. `ControlState.SetActive(targetAppId, artifactId, mutantId)` (+ Commit inside).
  4. Build suite (control-owned monotonic name within Code[10]), Run-flag single-method selection (fail closed on ≠1).
  5. `RunAllTests` under Codeunit isolation.
  6. **`try`-equivalent (catchable runner boundary): always `ControlState.ClearActive()` (+ Commit) before returning**, incl. on a test/framework error. If clear can't be confirmed → `effect-unknown`.
  7. Read back the one method's terminal result; fail closed unless exactly one; return the identity tuple + outcome/message/stack.

- [ ] **Step 2: LIVE — probes (records for spec §15)**
  - Single-method: `RunMutant` for one fixture method runs only that method (2-method order-matters probe).
  - Run-scoped clear: after `RunMutant`, a `HarnessInfo`/state read shows no active mutant.
  - Artifact-mismatch: a wrong `artifactId` returns `artifact-mismatch`, runs nothing.
  - Reserved-param: non-empty `leaseToken` → error.

- [ ] **Step 3: Commit**

```bash
cd U:/Git/LethAL && git add extensions/lethal-control/src/RunMutant.Codeunit.al && git commit -m "feat(5c): RunMutant OData action — run-scoped activate+run-one-method+clear, artifact-registry guard"
```

---

## Task 4: Schemata emission — guards call the control extension; target registers

**Files:** Modify `packages/schemata/src/selector.ts`, `packages/schemata/src/project.ts`; tests `packages/schemata/tests/*`.

**Interfaces:** the instrumented target's guard predicate calls `LC Control State.IsActive(targetAppId, artifactId, mutantId)` instead of the in-target selector; the target's `app.json` depends on `LethAL Control`; the target's install/upgrade calls `RegisterArtifact`.

- [ ] **Step 1 (TDD): emit-shape tests** — assert the emitted target AL (a) contains a guard call into the control extension (not an in-target `Mutation Active` read), (b) no longer emits the `Mutation Active` table / `Mutation Control` codeunit, (c) emits a `RegisterArtifact(targetAppId, artifactId)` call in the target's install trigger, (d) still emits `ArtifactId()`. Write the failing tests first.

- [ ] **Step 2: Update `selector.ts`** — replace the in-target selector/control emission with the guard-call-into-control-extension form; keep `emitStaticSelector` (al-runner) untouched. Emit the target install `RegisterArtifact` call.

- [ ] **Step 3: Update `project.ts`** — add the `LethAL Control` dependency to the target's `app.json` (id + name + publisher + version); ensure the control extension's symbols are placed in the target's `.alpackages` before compile.

- [ ] **Step 4: typecheck + dist + unit tests + biome**, then **LIVE compile probe** — the instrumented sandbox target compiles against the published `LethAL Control` (the guard call + `RegisterArtifact` resolve across the dependency). Commit.

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/schemata
git add packages/schemata && git commit -m "feat(5c): target guards call LethAL Control; target registers its artifact; dependency added"
```

> If the guard-call or `RegisterArtifact` doesn't resolve across the boundary (symbols, dependency direction), STOP — this is the §13 open item; adjust the control extension's public surface, don't hack the target.

---

## Task 5: Backend rewiring — `RunMutant` transport + bcdev `run()`

**Files:** Create `packages/runner/src/run-mutant-transport.ts`; modify `packages/runner/src/bcdev-backend.ts`; tests.

**Interfaces (Produces):**
- `RunMutantTransport.run(req): Promise<TestVerdict>` — OData client, 5B-classified (pre-dispatch vs in-flight-unknown), validates the echoed identity tuple, maps `artifact-mismatch`/`effect-unknown` to typed errors.
- `BcDevMcpBackend.activate()` → bookkeeping; `run()` → `RunMutant`.

- [ ] **Step 1 (TDD): transport classification tests** — mirror the 5B `run()` fake-fetch tests: a pre-dispatch fetch throw → `pre-dispatch-rejected`; an abort-after-dispatch → `in-flight-unknown`; a 2xx result whose echoed identity tuple ≠ request → rejected error; an `artifact-mismatch` result → typed error not `survived`. Write failing first.

- [ ] **Step 2: Implement `run-mutant-transport.ts`** — build the OData `RunMutant` POST (config-derived URL/company/tenant/auth, reserved params empty), the `postOData`-style dispatch classification (reuse `activation.ts`'s pattern), identity-tuple validation, result→`TestVerdict` mapping.

- [ ] **Step 3: Rewire `bcdev-backend.ts`** — `activate(mutantId)` stores the id (no network, no throw); `run(ref)` calls the transport with the stored id + `ref`; coverage discovery unchanged (hub). Add harness provisioning + `HarnessInfo` verification as a session prerequisite (a new `harness.ts` or in `deploy`/session-start).

- [ ] **Step 4: typecheck + dist + unit tests + biome; mutation-check** the identity-validation + classification (revert → the specific test reddens). Commit.

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner
git add packages/runner/src && git commit -m "feat(5c): bcdev run() uses RunMutant (5B-classified, identity-validated); activate() bookkeeping"
```

---

## Task 6: Qualification-baseline unsupported-test detection

**Files:** Modify `packages/runner/src/orchestrator.ts` (baseline pass) + `bcdev-backend.ts`; tests.

**Interfaces:** the baseline pass flags a test that errors because it can't run in the web-service session (TestPage/unsupported) as `unsupported`, excludes it + any mutant covered only by it, with a named session-level error — never a false survivor (spec §9).

- [ ] **Step 1 (TDD):** a fake backend whose baseline run of a specific method returns an `unsupported`-class error → the orchestrator marks that method `unsupported`, excludes mutants covered only by it, and the report names it; a mutant with OTHER covering tests still runs. Write failing first.

- [ ] **Step 2: Implement** the baseline-qualification classification + exclusion + report field.

- [ ] **Step 3: typecheck + dist + tests + biome; commit.**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner
git add packages/runner && git commit -m "feat(5c): qualification-baseline flags unsupported tests, excludes with named error"
```

---

## Task 7: Fixture protocol-invariant probes + gate

**Files:** Create probe test codeunits under `fixtures/`; modify `packages/runner/itest/bcdev.itest.ts`.

- [ ] **Step 1: Probe fixtures** — an order-matters 2-method test codeunit; a skip test with a known message; a fail test with an exact error; (optionally) a TestPage-bearing test to prove the unsupported qualification. Keep the CORE sandbox fixture's 16-mutant table unchanged (the probes are additional, not counted in 3/10/3).

- [ ] **Step 2: itest assertions** — beyond the per-mutant baseline: assert exactly-one-method-ran per `run(ref)` (via the runner reporting executed methods), the run-scoped-clear invariant, the artifact-mismatch behavior, the identity-mismatch rejection. Gate = per-mutant table PLUS these.

- [ ] **Step 3: unit/typecheck/biome; commit.**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner
git add fixtures packages/runner/itest && git commit -m "test(5c): protocol-invariant probe fixtures + gate (per-mutant table plus invariants)"
```

---

## Task 8: Live gate + docs

**Files:** `fixtures/README.md`, `design.md` (§6.2 correction), spec §15 evidence.

- [ ] **Step 1: Publish the full stack** — `LethAL Control` extension, then the instrumented sandbox target (dependency + registration), then the test app, to Cronus281 (as a documented prerequisite sequence).

- [ ] **Step 2: LIVE GATE (foreground, do not poll)** — `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` reproduces **3/10/3** through `RunMutant` + all protocol invariants; `LETHAL_ITEST_ALRUNNER=1 ... bun run itest:alrunner` unchanged **3/13/0**. A differing verdict → **BLOCKED** (bug in the change).

- [ ] **Step 3: Docs** — `fixtures/README.md` harness-provisioning prerequisite + the RunMutant execution model; correct `design.md` §6.2 to state Codeunit isolation is enforced (Function later); fill spec §15 evidence.

- [ ] **Step 4: Commit.**

```bash
cd U:/Git/LethAL && git add fixtures/README.md design.md docs/superpowers/specs/2026-07-20-layer-5c-server-side-runner-design.md
git commit -m "docs(5c): harness provisioning + RunMutant execution model; correct design.md 6.2 isolation; live-gate evidence"
```

---

## Self-Review

**Spec coverage:** §4 control extension → Task 2; §5 RunMutant → Task 3 (+ Task 1 spike proves the primitive); §6 emission → Task 4; §7 backend → Task 5; §8 harness provisioning → Tasks 2/5; §9 qualification → Task 6; §10 coverage → unchanged (asserted in Task 7/8); §11 gate → Tasks 7/8; §12 exit criteria → Task 8; §13 open items → Task 1 spike + Task 4 live compile.

**Placeholder scan:** the AL in Tasks 1/3 is a sketch to be filled from Task 1's proven Test Suite API (the spike deliberately precedes and de-risks the exact API); this is a real ordering dependency, not a vague TODO. The live-verified tasks state their probe explicitly.

**Type/name consistency:** `RunMutant` signature + identity tuple identical across Tasks 3/5/7; `LC Control State.IsActive`/`SetActive`/`ClearActive`/`RegisterArtifact` identical across Tasks 2/3/4; the target→control dependency direction held everywhere (control never depends on target).

**Risk note (honest):** Tasks 1, 2, 3, 4(live), 8 require a live BC container + AL compile/publish and cannot be verified by `bun test` alone. If the Task 1 spike fails (no headless single-method run), the execution model is BLOCKED and must be reconsidered before Tasks 2+. Tasks 5, 6, 7 are TS-TDD and can proceed in parallel with the AL work only after the spike confirms the `RunMutant` contract.
