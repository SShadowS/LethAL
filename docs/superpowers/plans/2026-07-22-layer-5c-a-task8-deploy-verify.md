# Layer 5C-A Task 8 — deploy-verifier redesign + target self-registration + attestation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bcdev live path produce trustworthy verdicts through `RunMutant` — the target self-registers on republish, the deploy verifier reads the registry, and a per-run binary-identity attestation fence closes the "silent all-survived on a wrong/stale binary" hole — then reproduce the frozen 3/10/3 (bcdev) and 3/13/0 (al-runner) live.

**Architecture:** The instrumented target's `Mutation Selector` is the single source of the baked `(targetAppId, artifactId)`; its Install AND Upgrade codeunits register that identity into the `LethAL Control` extension (target→control) so a ForceSync republish re-registers (live-probed to fire). The `DeploymentVerifier` reads `LethALControl_RegisteredArtifact` as a pre-flight; the real correctness fence is per-run attestation — `LC Control State.IsActive` records the live selector's presented `(targetAppId, artifactId)` as a sticky mismatch flag, `RunMutant` returns `{observedAny, identityMismatch}`, the transport rejects a mismatch as `error`, and the orchestrator holds each deployed artifact's verdicts until that artifact records ≥1 clean observation (else discard + quarantine).

**Tech Stack:** Bun + TypeScript monorepo (`packages/engine|schemata|runner`), AL (`extensions/lethal-control`, emitted target under `fixtures/`), `alc.exe`/`altool.exe` (AL VS Code extension), live BC on Cronus281.

## Global Constraints

- Design authority: `docs/superpowers/specs/2026-07-22-layer-5c-a-task8-deploy-verify-design.md` (Revision 4) + parent `docs/superpowers/specs/2026-07-20-layer-5c-server-side-runner-design.md`.
- No `!` non-null assertions (biome `noNonNullAssertion: error`); destructure then check `undefined`.
- `exactOptionalPropertyTypes`: build optional props with `...(v !== undefined ? { k: v } : {})`.
- Typed error classes extend `Error` directly, never each other (`AlcCompileError` vs `ArtifactPrepareError` vs `DeploymentError`). Fail loudly on caller-contract violations; never return a plausible empty default.
- Generated AL: web-service `ObjectType` exactly `CodeUnit`; `emitMutationSelector` and `emitStaticSelector` MUST expose the identical procedure set; artifact id `/^[0-9a-f]{32}$/`.
- Verify loop: `bun run typecheck` (separate from tests) → `rm -rf packages/*/dist` (dist trap) → `bun test <pkg>`. Biome only on touched files: `bunx biome check <paths>`.
- Shell: Git bash on Windows; never `2>nul` (use `2>/dev/null`). Live itests run foreground, never polled.
- Red-check every fix by mutation (`mem:review_discipline`): revert the fix, confirm the specific test goes red, restore. Report both.
- AL has no unit-test harness in this repo: AL-only changes are verified by an offline `alc` compile + the live gate (Task 12), not `bun test`.
- alc/altool live under `~/.vscode/extensions/ms-dynamics-smb.al-18.0.2498801/bin/win32/`. LethAL Control symbols + compiled app: `extensions/lethal-control/.alpackages/*` + `extensions/lethal-control/lethal-control.app`.
- Preconditions this layer assumes (parent spec §I; not enforced in-code here): no concurrent/external publication to a container during a session; at most ONE instrumented LethAL target installed per container. bcdev is single-flight (`workers === 1`, asserted in Task 10).

---

## File Structure

- `packages/schemata/src/selector.ts` — add `TargetAppId()` to both selector emitters; single-source registration; add `emitRegisterUpgrade`; fix stale comment. (Tasks 1)
- `packages/schemata/src/project.ts` — emit `MutationUpgrade.Codeunit.al`; export emitted control-codeunit filename constants. (Task 2)
- `packages/schemata/src/index.ts` — re-export the new symbols/constants if the package barrel is how `runner` imports them. (Tasks 1–2)
- `extensions/lethal-control/src/ControlState.Codeunit.al` — attestation fields + reset/record logic. (Task 3)
- `extensions/lethal-control/src/ControlApi.Codeunit.al` — `RunMutant` returns attestation; add `RegisteredArtifact` read; remove OData `RegisterArtifact`. (Tasks 3, 7)
- `packages/runner/src/run-mutant-transport.ts` — parse attestation, reject mismatch; fetch reclassification. (Task 4)
- `packages/runner/src/backend.ts` — `TestVerdict.attestation` field. (Task 5)
- `packages/runner/src/bcdev-backend.ts` — thread attestation through `run()`; private compile-staging copy with dependency + symbol; `harnessVerifier` required + unconditional. (Tasks 5, 8)
- `packages/runner/src/deployment-verifier.ts` — registry-read verify. (Task 6)
- `packages/runner/src/al-runner-backend.ts` — delete the two control codeunits after copy. (Task 9)
- `packages/runner/src/orchestrator.ts` — `workers===1` assertion for authoritative backend; per-artifact clean-attestation ledger + fail-closed gate. (Task 10)
- `packages/runner/itest/bcdev.itest.ts` — remove the Task 7 `odataRegisterArtifact` workaround; assert attestation in the gate. (Tasks 11, 12)
- Docs: `fixtures/README.md`, `design.md` §6.2, spec §15. (Task 12)

---

### Task 1: Selector single-sourced identity + upgrade emitter

**Files:**
- Modify: `packages/schemata/src/selector.ts`
- Test: `packages/schemata/tests/selector.test.ts` (create if absent; else add cases)

**Interfaces:**
- Produces: `emitMutationSelector(cfg)` and `emitStaticSelector(cfg)` each expose procedures `Active`, `ArtifactId`, `TargetAppId`. `emitRegisterInstall({objectId})` and NEW `emitRegisterUpgrade({objectId})` both emit a codeunit that reads identity from `Codeunit "Mutation Selector"` (no `targetAppId`/`artifactId` args). `emitStaticSelector` gains a `targetAppId` field.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  emitMutationSelector,
  emitStaticSelector,
  emitRegisterInstall,
  emitRegisterUpgrade,
} from "../src/selector";

const IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };
const APP = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
const ART = "0123456789abcdef0123456789abcdef";

describe("selector single-sourced identity", () => {
  test("dynamic selector exposes Active, ArtifactId, TargetAppId", () => {
    const al = emitMutationSelector({ ...IDS, artifactId: ART, targetAppId: APP });
    expect(al).toContain("procedure TargetAppId(): Text");
    expect(al).toContain(`exit('${APP}')`);
    expect(al).toContain(`ControlState.IsActive('${APP}', '${ART}', MutantId)`);
  });

  test("static selector exposes the identical procedure set", () => {
    const dyn = emitMutationSelector({ ...IDS, artifactId: ART, targetAppId: APP });
    const stat = emitStaticSelector({ objectId: IDS.selectorId, activeId: "", artifactId: ART, targetAppId: APP });
    for (const proc of ["procedure Active(", "procedure ArtifactId(", "procedure TargetAppId("]) {
      expect(dyn).toContain(proc);
      expect(stat).toContain(proc);
    }
  });

  test("install registers identity read from the selector, not from args", () => {
    const al = emitRegisterInstall({ objectId: IDS.controlId });
    expect(al).toContain('Subtype = Install');
    expect(al).toContain("Selector: Codeunit \"Mutation Selector\"");
    expect(al).toContain("State.RegisterArtifact(Selector.TargetAppId(), Selector.ArtifactId())");
    expect(al).not.toContain(APP); // identity is NOT baked here anymore
  });

  test("upgrade registers the same way on OnUpgradePerCompany, using tableId object id", () => {
    const al = emitRegisterUpgrade({ objectId: IDS.tableId });
    expect(al).toContain(`codeunit ${IDS.tableId} "Mutation Upgrade"`);
    expect(al).toContain("Subtype = Upgrade");
    expect(al).toContain("trigger OnUpgradePerCompany()");
    expect(al).toContain("State.RegisterArtifact(Selector.TargetAppId(), Selector.ArtifactId())");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/schemata/tests/selector.test.ts`
Expected: FAIL (`emitRegisterUpgrade` not exported; `TargetAppId` absent; `emitRegisterInstall` still takes `targetAppId`/`artifactId`).

- [ ] **Step 3: Implement**

In `emitMutationSelector`'s returned AL, add after the `ArtifactId` procedure:

```al
    procedure TargetAppId(): Text
    begin
        exit('${cfg.targetAppId}');
    end;
```

Change `emitStaticSelector`'s config to `{ objectId: number; activeId: string; artifactId: string; targetAppId: string }` and add the same `TargetAppId` procedure to its output (parity rule).

Replace `emitRegisterInstall` with an identity-from-selector version and add `emitRegisterUpgrade`:

```ts
/**
 * The instrumented target's install codeunit — registers this target's identity into the
 * `LethAL Control` extension on a FRESH install (OnInstallAppPerCompany fires only then).
 * Identity is read from `Mutation Selector` so registration can NEVER diverge from the id
 * `Active` presents to the guard (design §A). Object id: the freed `controlId`.
 */
export function emitRegisterInstall(cfg: { objectId: number }): string {
  return `codeunit ${cfg.objectId} "Mutation Register"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        State: Codeunit "LC Control State";
        Selector: Codeunit "Mutation Selector";
    begin
        State.RegisterArtifact(Selector.TargetAppId(), Selector.ArtifactId());
    end;
}
`;
}

/**
 * The instrumented target's upgrade codeunit — re-registers identity on every republish
 * (OnUpgradePerCompany fires on a ForceSync republish with an increased version; live-probed
 * 2026-07-22, mem:runmutant_odata). Same identity-from-selector rule as install. Object id:
 * the freed `tableId` (the in-target Mutation Active table is gone).
 */
export function emitRegisterUpgrade(cfg: { objectId: number }): string {
  return `codeunit ${cfg.objectId} "Mutation Upgrade"
{
    Subtype = Upgrade;

    trigger OnUpgradePerCompany()
    var
        State: Codeunit "LC Control State";
        Selector: Codeunit "Mutation Selector";
    begin
        State.RegisterArtifact(Selector.TargetAppId(), Selector.ArtifactId());
    end;
}
`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/schemata/tests/selector.test.ts`
Expected: PASS.

- [ ] **Step 5: Red-check** — revert the `TargetAppId()` addition in `emitMutationSelector`; confirm the "dynamic selector exposes …" test goes red; restore.

- [ ] **Step 6: typecheck, biome, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/schemata
bunx biome check packages/schemata/src/selector.ts packages/schemata/tests/selector.test.ts
git add packages/schemata/src/selector.ts packages/schemata/tests/selector.test.ts
git commit -m "feat(5c): selector single-sources (targetAppId, artifactId); emitRegisterUpgrade"
```

---

### Task 2: project.ts emits the upgrade codeunit; export filename constants

**Files:**
- Modify: `packages/schemata/src/project.ts`
- Modify: `packages/schemata/src/index.ts` (export constants if barrel-exported)
- Test: `packages/schemata/tests/project.test.ts` (add cases; create if absent)

**Interfaces:**
- Consumes: `emitRegisterInstall({objectId})`, `emitRegisterUpgrade({objectId})` (Task 1).
- Produces: `writeInstrumentedProject` writes `MutationSelector.Codeunit.al`, `MutationRegister.Codeunit.al`, `MutationUpgrade.Codeunit.al`. Exported constants `CONTROL_REGISTER_FILENAME = "MutationRegister.Codeunit.al"`, `CONTROL_UPGRADE_FILENAME = "MutationUpgrade.Codeunit.al"` (consumed by al-runner in Task 9).

- [ ] **Step 1: Write failing test**

```ts
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseAlProject } from "../src/../<same helper the existing tests use to build InstrumentedFile[]>";
// If no such helper exists, build a minimal InstrumentedFile[] inline as the existing project.test.ts does.
import { writeInstrumentedProject, CONTROL_UPGRADE_FILENAME } from "../src/project";

test("writeInstrumentedProject emits an Upgrade codeunit registering via the selector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lethal-proj-"));
  await writeInstrumentedProject({
    targetDir: dir,
    files: [/* one InstrumentedFile with >=1 spec, as existing tests construct */],
    selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
    artifactId: "0123456789abcdef0123456789abcdef",
    targetAppId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
  });
  const names = await readdir(dir);
  expect(names).toContain(CONTROL_UPGRADE_FILENAME);
  const al = await readFile(join(dir, CONTROL_UPGRADE_FILENAME), "utf8");
  expect(al).toContain("OnUpgradePerCompany");
  expect(al).toContain("State.RegisterArtifact(Selector.TargetAppId(), Selector.ArtifactId())");
});
```

(If `packages/schemata/tests/project.test.ts` already exists, mirror its fixture-construction and add this case rather than re-inventing.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/schemata/tests/project.test.ts`
Expected: FAIL (`CONTROL_UPGRADE_FILENAME` not exported / file not written).

- [ ] **Step 3: Implement**

At the top of `project.ts` (module scope), add and export the constants; update the import:

```ts
import { type SelectorConfig, emitMutationSelector, emitRegisterInstall, emitRegisterUpgrade } from "./selector";

export const CONTROL_SELECTOR_FILENAME = "MutationSelector.Codeunit.al";
export const CONTROL_REGISTER_FILENAME = "MutationRegister.Codeunit.al";
export const CONTROL_UPGRADE_FILENAME = "MutationUpgrade.Codeunit.al";
```

In `writeInstrumentedProject`, the `emitRegisterInstall` call now takes only `{objectId}`, and add the upgrade write. Replace the current selector/register block (project.ts ~L117-134) with:

```ts
  await writeFile(
    join(input.targetDir, CONTROL_SELECTOR_FILENAME),
    emitMutationSelector({
      ...input.selectorIds,
      artifactId: input.artifactId,
      targetAppId: input.targetAppId,
    }),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, CONTROL_REGISTER_FILENAME),
    emitRegisterInstall({ objectId: input.selectorIds.controlId }),
    "utf8",
  );
  await writeFile(
    join(input.targetDir, CONTROL_UPGRADE_FILENAME),
    emitRegisterUpgrade({ objectId: input.selectorIds.tableId }),
    "utf8",
  );
```

If `packages/schemata/src/index.ts` re-exports emit symbols, add `CONTROL_*_FILENAME` and `emitRegisterUpgrade` there.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/schemata/tests/project.test.ts`
Expected: PASS.

- [ ] **Step 5: typecheck, biome, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/schemata
bunx biome check packages/schemata/src/project.ts packages/schemata/src/index.ts packages/schemata/tests/project.test.ts
git add packages/schemata/src/project.ts packages/schemata/src/index.ts packages/schemata/tests/project.test.ts
git commit -m "feat(5c): emit MutationUpgrade codeunit; export control-codeunit filename constants"
```

---

### Task 3: LethAL Control — attestation fields + RunMutant returns them

**Files:**
- Modify: `extensions/lethal-control/src/ControlState.Codeunit.al`
- Modify: `extensions/lethal-control/src/ControlApi.Codeunit.al`
- Verify: offline `alc` compile (no AL unit harness)

**Interfaces:**
- Produces: `LC Control State` methods `SetActive(TargetAppId, ArtifactId, MutantId)` (now also stores expected identity + resets attestation), `ClearActive()` (resets attestation), `IsActive(TargetAppId, ArtifactId, MutantId)` (records attestation at top), `AttestationObservedAny(): Boolean`, `AttestationMismatch(): Boolean`. `LC Control API.RunMutant(...)` result JSON gains `observedAny` (bool) and `identityMismatch` (bool).

- [ ] **Step 1: Edit `ControlState.Codeunit.al`**

Add to the `var` block:

```al
        ExpectedTargetAppId: Text;
        ExpectedArtifactId: Text;
        ObservedAny: Boolean;
        ObservedIdentityMismatch: Boolean;
```

In `SetActive`, at the TOP (before the `Active.Get('')` block), store expected + reset:

```al
        ExpectedTargetAppId := TargetAppId;
        ExpectedArtifactId := ArtifactId;
        ObservedAny := false;
        ObservedIdentityMismatch := false;
```

In `ClearActive`, add (anywhere in the body) the same reset of `ObservedAny`/`ObservedIdentityMismatch` (and clear `Expected*`) so a future direct reader can't consume a stale value:

```al
        ObservedAny := false;
        ObservedIdentityMismatch := false;
        ExpectedTargetAppId := '';
        ExpectedArtifactId := '';
```

In `IsActive`, at the TOP (BEFORE the `if CachedMutantId = '' then exit(false);` line), record the presented identity as a sticky mismatch:

```al
        ObservedAny := true;
        if (TargetAppId <> ExpectedTargetAppId) or (ArtifactId <> ExpectedArtifactId) then
            ObservedIdentityMismatch := true;
```

Add getters (e.g. after `RegisteredArtifact`):

```al
    procedure AttestationObservedAny(): Boolean
    begin
        exit(ObservedAny);
    end;

    procedure AttestationMismatch(): Boolean
    begin
        exit(ObservedIdentityMismatch);
    end;
```

- [ ] **Step 2: Edit `ControlApi.Codeunit.al` `RunMutant`**

After `CodeunitResults := RunOneMethod(...)` and BEFORE `State.ClearActive()`, capture the flags, and thread them into `BuildStatus`. Change `BuildStatus` to add the two booleans. Minimal approach — read before clear:

```al
        CodeunitResults := RunOneMethod(State.NextSuiteName(), TestCodeunitId, TestMethod);
        ObservedAny := State.AttestationObservedAny();
        IdentityMismatch := State.AttestationMismatch();
        State.ClearActive();
        exit(BuildStatus('ran', TargetAppId, ArtifactId, AttemptId, MutantId, TestCodeunitId, TestMethod, CodeunitResults, ObservedAny, IdentityMismatch));
```

Add locals `ObservedAny: Boolean; IdentityMismatch: Boolean;` to `RunMutant`. Update `BuildStatus`'s signature to accept `ObservedAny: Boolean; IdentityMismatch: Boolean` and add to the JSON object:

```al
        Obj.Add('observedAny', ObservedAny);
        Obj.Add('identityMismatch', IdentityMismatch);
```

For the early-exit statuses (`reserved-params`, `artifact-mismatch`), pass `false, false` (no run happened) to `BuildStatus`.

- [ ] **Step 3: Offline compile check (AL has no unit harness)**

```bash
SP="C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL/89209fff-e206-4df0-98a6-a50d3b0cfed5/scratchpad"
ALC="/c/Users/SShadowS/.vscode/extensions/ms-dynamics-smb.al-18.0.2498801/bin/win32/alc.exe"
"$ALC" "/project:U:/Git/LethAL/extensions/lethal-control" "/packagecachepath:U:/Git/LethAL/extensions/lethal-control/.alpackages" "/out:$SP/lethal-control-t3.app"
```
Expected: exit 0, no errors. (Delete `$SP/lethal-control-t3.app` after.)

- [ ] **Step 4: Commit**

```bash
cd U:/Git/LethAL && git add extensions/lethal-control/src/ControlState.Codeunit.al extensions/lethal-control/src/ControlApi.Codeunit.al
git commit -m "feat(5c): LethAL Control per-run attestation (sticky full-tuple IsActive; RunMutant returns observedAny/identityMismatch)"
```

---

### Task 4: RunMutantTransport — attestation + fetch reclassification

**Files:**
- Modify: `packages/runner/src/run-mutant-transport.ts`
- Test: `packages/runner/tests/run-mutant-transport.test.ts` (add cases)

**Interfaces:**
- Consumes: `RunMutant` result JSON `{status, …, observedAny?, identityMismatch?}` (Task 3).
- Produces: `TestVerdict.attestation?: { observedAny: boolean; identityMismatch: boolean }` set on the `ran` path (Task 5 defines the field). `identityMismatch === true` → `outcome: "error"` (never a verdict). Any post-`fetchFn`-invocation async rejection that is NOT our timeout abort → `operation: "in-flight-unknown"`.

- [ ] **Step 1: Write failing tests**

```ts
// add to run-mutant-transport.test.ts — reuse the file's existing fake-fetch harness shape
test("identityMismatch=true → error, never a verdict", async () => {
  const tx = makeTransport(ranBody({ observedAny: true, identityMismatch: true, method: "M", result: 2 }));
  const v = await tx.run(reqFor("M"));
  expect(v.outcome).toBe("error");
  expect(v.failureMessage).toContain("identity");
});

test("clean run surfaces attestation for the session gate", async () => {
  const tx = makeTransport(ranBody({ observedAny: true, identityMismatch: false, method: "M", result: 2 }));
  const v = await tx.run(reqFor("M"));
  expect(v.outcome).toBe("pass");
  expect(v.attestation).toEqual({ observedAny: true, identityMismatch: false });
});

test("empty attestation (no instrumented site) is allowed", async () => {
  const tx = makeTransport(ranBody({ observedAny: false, identityMismatch: false, method: "M", result: 2 }));
  const v = await tx.run(reqFor("M"));
  expect(v.outcome).toBe("pass");
  expect(v.attestation).toEqual({ observedAny: false, identityMismatch: false });
});

test("post-dispatch connection reset (not our abort) → in-flight-unknown", async () => {
  const fetchFn = async () => { throw new Error("ECONNRESET"); }; // controller.signal NOT aborted
  const tx = new RunMutantTransport(CFG, TARGET, ARTIFACT, fetchFn as unknown as typeof fetch);
  const v = await tx.run(reqFor("M"));
  expect(v.outcome).toBe("error");
  expect(v.operation).toBe("in-flight-unknown");
});
```

(Use the existing helpers in the file; `ranBody`/`makeTransport`/`reqFor` names are illustrative — match the file's current pattern for building an OData `{value:"<json>"}` response and a transport.)

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/runner/tests/run-mutant-transport.test.ts`
Expected: FAIL (attestation not parsed; reset currently classified `pre-dispatch-rejected`).

- [ ] **Step 3: Implement**

Extend `RunMutantResult` with `readonly observedAny?: unknown; readonly identityMismatch?: unknown;`.

Fix the catch block (currently classifies any non-abort throw as `pre-dispatch-rejected`). Replace its body so that once `fetchFn` has been invoked, only a synchronous pre-invocation throw is pre-dispatch; every async rejection that is not our abort is `in-flight-unknown`:

```ts
    } catch (err) {
      const durationMs = Date.now() - started;
      if (controller.signal.aborted) {
        return { ref, outcome: "deadline-exceeded", durationMs,
          failureMessage: `RunMutant timed out: ${String(err)}`, operation: "in-flight-unknown" };
      }
      // fetchFn was already invoked; a rejection here (e.g. connection reset) may have reached BC
      // AFTER the request was fully sent and left a mutant active — never retry-safe (parent §7).
      return { ref, outcome: "error", durationMs,
        failureMessage: `RunMutant connection failed after dispatch: ${String(err)}`,
        operation: "in-flight-unknown" };
    }
```

In `mapRanResult`, after the method/enum checks, compute attestation and reject a mismatch. Just before building the returned verdict:

```ts
    const attestation = {
      observedAny: result.observedAny === true,
      identityMismatch: result.identityMismatch === true,
    };
    if (attestation.identityMismatch) {
      return { ref, outcome: "error", durationMs,
        failureMessage: `RunMutant attestation identity mismatch: a selector with a non-matching (targetAppId, artifactId) ran — wrong/stale binary` };
    }
    const outcome = this.outcomeOfResultEnum(line.result);
    // …existing null-check…
    const failureMessage = this.failureTextOf(line);
    return {
      ref, outcome, durationMs, attestation,
      ...(outcome === "fail" && failureMessage !== undefined ? { failureMessage } : {}),
    };
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/runner/tests/run-mutant-transport.test.ts`
Expected: PASS (all, including the pre-existing cases).

- [ ] **Step 5: Red-check** — revert the `if (attestation.identityMismatch)` block; confirm the "identityMismatch → error" test goes red; restore. Revert the catch-block change; confirm the "post-dispatch reset → in-flight-unknown" test goes red; restore.

- [ ] **Step 6: typecheck, biome, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/run-mutant-transport.test.ts
bunx biome check packages/runner/src/run-mutant-transport.ts packages/runner/tests/run-mutant-transport.test.ts
git add packages/runner/src/run-mutant-transport.ts packages/runner/tests/run-mutant-transport.test.ts
git commit -m "feat(5c): transport parses attestation, rejects identity mismatch; post-dispatch reject -> in-flight-unknown"
```

---

### Task 5: TestVerdict.attestation field + bcdev run() threads it

**Files:**
- Modify: `packages/runner/src/backend.ts`
- Modify: `packages/runner/src/bcdev-backend.ts` (`runViaTransport`)
- Test: `packages/runner/tests/bcdev-backend.test.ts` (add a case; else the transport test in Task 4 already covers the field — this task wires it through the backend)

**Interfaces:**
- Produces: `TestVerdict.attestation?: { readonly observedAny: boolean; readonly identityMismatch: boolean }`. `BcDevMcpBackend.run()` returns the transport's verdict verbatim (already does — confirm the field is not stripped).

- [ ] **Step 1: Add the field to `backend.ts` `TestVerdict`**

```ts
  /**
   * Per-run binary-identity attestation (Layer 5C-A Task 8, design §G). Present on a bcdev
   * RunMutant `ran` path. `observedAny` = a target selector was consulted during the run;
   * `identityMismatch` is already mapped to `outcome:"error"` by the transport, so on a returned
   * verdict it is always false — the field is carried so the orchestrator can require ≥1 clean
   * observation per deployed artifact (fail-closed). Absent on al-runner and on non-ran paths.
   */
  readonly attestation?: { readonly observedAny: boolean; readonly identityMismatch: boolean };
```

- [ ] **Step 2: Confirm `runViaTransport` passes it through**

`BcDevMcpBackend.runViaTransport` returns `transport.run({...})` directly, so the `attestation` field is already carried. Add a test asserting it:

```ts
test("bcdev run() carries transport attestation through", async () => {
  // build a BcDevMcpBackend with a fake runMutantTransportFactory returning a verdict with attestation
  // (mirror the existing bcdev-backend.test.ts construction), then:
  const v = await backend.run(ref, { coverage: "none", timeoutMs: 1000 });
  expect(v.attestation).toEqual({ observedAny: true, identityMismatch: false });
});
```

- [ ] **Step 3: Run to verify pass**

Run: `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/bcdev-backend.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd U:/Git/LethAL && bunx biome check packages/runner/src/backend.ts packages/runner/tests/bcdev-backend.test.ts
git add packages/runner/src/backend.ts packages/runner/tests/bcdev-backend.test.ts
git commit -m "feat(5c): TestVerdict.attestation carried through bcdev run()"
```

---

### Task 6: DeploymentVerifier reads the registry

**Files:**
- Modify: `packages/runner/src/deployment-verifier.ts`
- Test: `packages/runner/tests/deployment-verifier.test.ts` (modify existing cases)

**Interfaces:**
- Consumes: OData `LethALControl_RegisteredArtifact` (Task 7) returning `{value:"<artifactId>"}` (bare string, single parse).
- Produces: `DeploymentVerifier.verify(expected)` unchanged return type `DeploymentVerification`; now POSTs `LethALControl_RegisteredArtifact` with body `{ targetAppId: expected.appId }`.

- [ ] **Step 1: Update tests** — the existing tests fake `postOData`/`Identity`; retarget them to the registry read. Cases: reported === expected.artifactId → `accepted`; well-formed different 32-hex → `mismatch`; empty string (no row) → `unavailable`; non-string/malformed → `unavailable`; malformed EXPECTED id still throws.

```ts
test("registry read equal → accepted", async () => {
  const v = await new DeploymentVerifier(CFG, fakeFetch(scalar(ART))).verify(artifact(ART));
  expect(v.status).toBe("accepted");
});
test("registry read different 32-hex → mismatch", async () => {
  const other = "f".repeat(32);
  const v = await new DeploymentVerifier(CFG, fakeFetch(scalar(other))).verify(artifact(ART));
  expect(v).toEqual({ status: "mismatch", reported: other });
});
test("empty registry (no row) → unavailable", async () => {
  const v = await new DeploymentVerifier(CFG, fakeFetch(scalar(""))).verify(artifact(ART));
  expect(v.status).toBe("unavailable");
});
```

Where `scalar(s)` returns a `Response` whose json is `{ value: s }`, and `fakeFetch` asserts the URL contains `LethALControl_RegisteredArtifact` and the body has `targetAppId`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/runner/tests/deployment-verifier.test.ts`
Expected: FAIL (still calling `MutationControl_Identity`).

- [ ] **Step 3: Implement** — replace the `postOData(this.cfg, this.fetchFn, "Identity")` call with a private request method mirroring `HarnessVerifier.fetchHarnessInfo`, targeting `LethALControl_RegisteredArtifact` with body `{ targetAppId: expected.appId }`. Keep the `isValidArtifactId` guards on both expected and reported. Parse the OData envelope's `value` with a SINGLE `JSON`-free read (the value IS the artifactId string, not nested JSON):

```ts
  private async readRegisteredArtifact(targetAppId: string): Promise<string | null> {
    const params = new URLSearchParams({ company: this.cfg.company });
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    const url = `${this.cfg.baseUrl}/ODataV4/LethALControl_RegisteredArtifact?${params.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { authorization: `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`, "content-type": "application/json" },
        body: JSON.stringify({ targetAppId }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const value = ((await res.json().catch(() => ({}))) as { value?: unknown }).value;
    return typeof value === "string" ? value : null;
  }
```

Then in `verify`, after the expected-id guard: `const reported = await this.readRegisteredArtifact(expected.appId).catch(() => null);` wrapped so a throw → `{ status: "unavailable", detail }`, and keep the existing reported-null/malformed → `unavailable`, equal → `accepted`, else → `mismatch` logic. Update the class doc comment: this proves "self-registration by our binary was observed" (a pre-flight), NOT a live-binary proof — that is §G attestation.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/runner/tests/deployment-verifier.test.ts`
Expected: PASS.

- [ ] **Step 5: Red-check** — change `reported === expected.artifactId` to `reported !== expected.artifactId`; confirm the accepted/mismatch tests flip; restore.

- [ ] **Step 6: typecheck, biome, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/deployment-verifier.test.ts
bunx biome check packages/runner/src/deployment-verifier.ts packages/runner/tests/deployment-verifier.test.ts
git add packages/runner/src/deployment-verifier.ts packages/runner/tests/deployment-verifier.test.ts
git commit -m "feat(5c): DeploymentVerifier reads LethALControl_RegisteredArtifact (pre-flight, not the sole proof)"
```

---

### Task 7: ControlApi RegisteredArtifact read; remove OData RegisterArtifact write

**Files:**
- Modify: `extensions/lethal-control/src/ControlApi.Codeunit.al`
- Verify: offline `alc` compile

**Interfaces:**
- Produces: OData `LethALControl_RegisteredArtifact(TargetAppId): Text` (thin wrapper over `State.RegisteredArtifact`). REMOVES `LethALControl_RegisterArtifact` (public `RegisterArtifact` procedure deleted from the API codeunit — the target's install/upgrade call `LC Control State.RegisterArtifact` in-process, so no OData write is needed).

- [ ] **Step 1: Edit `ControlApi.Codeunit.al`**

Delete the `RegisterArtifact(TargetAppId: Text; ArtifactId: Text) ResultJson: Text` procedure entirely. Add a read:

```al
    /// <summary>Read-only: the artifact id the target registered for TargetAppId (empty if none).
    /// The DeploymentVerifier reads this as a pre-flight (design §B). No OData WRITE exists — the
    /// registry is written only in-process by the target's install/upgrade codeunits (design §B2).</summary>
    procedure RegisteredArtifact(TargetAppId: Text): Text
    var
        State: Codeunit "LC Control State";
    begin
        exit(State.RegisteredArtifact(TargetAppId));
    end;
```

- [ ] **Step 2: Offline compile check**

```bash
SP="C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL/89209fff-e206-4df0-98a6-a50d3b0cfed5/scratchpad"
ALC="/c/Users/SShadowS/.vscode/extensions/ms-dynamics-smb.al-18.0.2498801/bin/win32/alc.exe"
"$ALC" "/project:U:/Git/LethAL/extensions/lethal-control" "/packagecachepath:U:/Git/LethAL/extensions/lethal-control/.alpackages" "/out:$SP/lethal-control-t7.app"
```
Expected: exit 0. Delete the scratch `.app` after.

- [ ] **Step 3: Commit**

```bash
cd U:/Git/LethAL && git add extensions/lethal-control/src/ControlApi.Codeunit.al
git commit -m "feat(5c): ControlApi exposes RegisteredArtifact read; removes OData RegisterArtifact write (registration is in-process only)"
```

---

### Task 8: bcdev deploy() — private staging copy (dependency + symbol); harnessVerifier required

**Files:**
- Modify: `packages/runner/src/bcdev-backend.ts`
- Test: `packages/runner/tests/bcdev-backend.test.ts`

**Interfaces:**
- Consumes: config gains `controlSymbolPath` (absolute path to `lethal-control.app`) and control app identity (`CONTROL_APP_ID` already in `harness.ts`; name/publisher/version constants added here or imported).
- Produces: `BcDevDeployment` now REQUIRES nothing new, but `BcDevMcpBackend` takes `harnessVerifier` as a REQUIRED constructor arg (moved out of optional). `deploy()` compiles from a private staging dir with the LethAL Control dependency injected into `app.json` and `lethal-control.app` staged in the package cache; `harnessVerifier.verify()` is called unconditionally.

- [ ] **Step 1: Write failing tests**

```ts
test("deploy() injects the LethAL Control dependency into the staged app.json and stages the symbol", async () => {
  // Use a fake ArtifactCompiler that captures the CompileInput it received. Assert the staged
  // app.json (in the dir passed to compile) has a dependency with id CONTROL_APP_ID, and that
  // lethal-control.app is present in the staged package cache.
});

test("deploy() calls harnessVerifier.verify() unconditionally and aborts if it throws", async () => {
  const verifier = { verify: mock(async () => { throw new HarnessVerificationError("bad"); }) };
  // construct backend with this verifier; expect deploy() to reject with HarnessVerificationError,
  // and compiler.compile NOT to have been called.
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/runner/tests/bcdev-backend.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Move `harnessVerifier` from the trailing optional constructor param into a required position (or into `BcDevDeployment` — pick one; simplest is making the existing param required by dropping the `?` and updating all call sites: `cli.ts`, `bcdev.itest.ts`, `stale-publish.itest.ts`, tests). In `deploy()`, replace `if (this.harnessVerifier) await this.harnessVerifier.verify();` with `await this.harnessVerifier.verify();`.

Add config fields to `BcDevConfig`: `readonly controlSymbolPath: string;` and control dependency identity (hardcode name/publisher/version or import). Before `compile`, build a private staging dir:

```ts
  private async stageForCompile(instrumentedDir: string): Promise<string> {
    const staging = join(instrumentedDir, "..", `${basename(instrumentedDir)}-staged`);
    await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await cp(instrumentedDir, staging, { recursive: true });
    // inject dependency into the staged app.json (never the shared instrumented dir)
    const appJsonPath = join(staging, "app.json");
    const app = JSON.parse(await readFile(appJsonPath, "utf8")) as { dependencies?: unknown[] };
    const deps = Array.isArray(app.dependencies) ? app.dependencies : [];
    if (!deps.some((d) => (d as { id?: string }).id === CONTROL_APP_ID)) {
      deps.push({ id: CONTROL_APP_ID, name: "LethAL Control", publisher: "LethAL", version: "1.0.0.0" });
    }
    await writeFile(appJsonPath, `${JSON.stringify({ ...app, dependencies: deps }, null, 2)}\n`, "utf8");
    // stage the control symbol into the package cache the compiler reads
    await mkdir(this.cfg.packageCachePath, { recursive: true });
    await cp(this.cfg.controlSymbolPath, join(this.cfg.packageCachePath, "lethal-control.app"));
    return staging;
  }
```

Note: `prepareCompileInput` reads `app.json` for `appId`/`appVersion` — keep those from the ORIGINAL (unchanged id/version); the dependency injection only ADDS a dependency, so `appId` is unaffected. Call `stageForCompile` and pass the staging dir to `prepareCompileInput`. Confirm `packageCachePath` is the compiler's cache (it is — `ArtifactCompilerConfig.packageCachePath`); if the staging must not pollute the caller's real cache, stage the symbol into a staging-local `.alpackages` and point compile at it instead. (Pick the approach that matches how `ArtifactCompiler` resolves `packageCachePath`; the itest already sets `packageCachePath` to `fixtures/sandbox-app/.alpackages` — staging the symbol there is acceptable for the fixture.)

- [ ] **Step 4: Run to verify they pass**

Run: `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/bcdev-backend.test.ts`
Expected: PASS. (Fix any now-broken call sites that omitted `harnessVerifier`.)

- [ ] **Step 5: Red-check** — revert the `await this.harnessVerifier.verify()` to the old `if (this.harnessVerifier)` guard with the verifier undefined; confirm the "calls verify unconditionally" test goes red; restore.

- [ ] **Step 6: typecheck, biome, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner
bunx biome check packages/runner/src/bcdev-backend.ts packages/runner/src/cli.ts packages/runner/tests/bcdev-backend.test.ts
git add packages/runner/src/bcdev-backend.ts packages/runner/src/cli.ts packages/runner/tests/bcdev-backend.test.ts
git commit -m "feat(5c): bcdev deploy() stages LethAL Control dependency+symbol in a private copy; harnessVerifier required + unconditional"
```

---

### Task 9: al-runner deletes the control-registration codeunits

**Files:**
- Modify: `packages/runner/src/al-runner-backend.ts`
- Test: `packages/runner/tests/al-runner-backend.test.ts`

**Interfaces:**
- Consumes: `CONTROL_REGISTER_FILENAME`, `CONTROL_UPGRADE_FILENAME` from `@lethal/schemata` (Task 2).

- [ ] **Step 1: Write failing test**

```ts
test("deploy() strips the control-registration codeunits from the active dir", async () => {
  // create an instrumentedDir containing MutationSelector/MutationRegister/MutationUpgrade + a source file
  await backend.deploy(instrumentedDir);
  const active = join(cfg.instrumentedDir, "active");
  const names = await readdir(active);
  expect(names).not.toContain(CONTROL_REGISTER_FILENAME);
  expect(names).not.toContain(CONTROL_UPGRADE_FILENAME);
  expect(names).toContain("MutationSelector.Codeunit.al");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/runner/tests/al-runner-backend.test.ts`
Expected: FAIL (files still present).

- [ ] **Step 3: Implement** — in `AlRunnerBackend.deploy()`, immediately after `await cp(instrumentedDir, activeDir, {recursive:true})` and before `readArtifactId(activeDir)`:

```ts
    // al-runner uses the static selector and never talks to LethAL Control; the target's
    // control-registration codeunits reference `LC Control State` and would fail al-runner's
    // dependency-free compile. Drop them (design §D). Force: synthetic fixtures may lack them.
    for (const f of [CONTROL_REGISTER_FILENAME, CONTROL_UPGRADE_FILENAME]) {
      await rm(join(activeDir, f), { force: true });
    }
```

Add the import: `import { CONTROL_REGISTER_FILENAME, CONTROL_UPGRADE_FILENAME } from "@lethal/schemata";`. (Belt for the no-deploy path: also delete-if-present in `activate()` before the compile, using the same constants — idempotent.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/runner/tests/al-runner-backend.test.ts`
Expected: PASS.

- [ ] **Step 5: Red-check** — comment out the delete loop; confirm the test goes red; restore.

- [ ] **Step 6: typecheck, biome, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/al-runner-backend.test.ts
bunx biome check packages/runner/src/al-runner-backend.ts packages/runner/tests/al-runner-backend.test.ts
git add packages/runner/src/al-runner-backend.ts packages/runner/tests/al-runner-backend.test.ts
git commit -m "fix(5c): al-runner strips MutationRegister/MutationUpgrade (no control dependency)"
```

---

### Task 10: orchestrator — workers=1 assertion + per-artifact clean-attestation gate

**Files:**
- Modify: `packages/runner/src/orchestrator.ts`
- Test: `packages/runner/tests/orchestrator.test.ts` (add cases; the file has an in-memory fake backend harness — reuse it)

**Interfaces:**
- Consumes: `TestVerdict.attestation` (Task 5).
- Produces: `runSession` throws if `caps.authoritative && workers > 1`. A new module-level `AttestationLedger` accumulates per-artifact clean observations; after each batch's mutant loop, an artifact that ran verdict-contributing (covered) mutants but recorded ZERO clean observations has its verdicts invalidated (converted to `error` with a named note) and the container quarantined.

- [ ] **Step 1: Write failing tests** (in-memory backend that returns attestation)

```ts
test("authoritative backend with workers>1 is rejected", async () => {
  await expect(runSession({ ...baseCfg, backend: authoritativeFake(), workers: 2 }))
    .rejects.toThrow(/workers.*1.*authoritative/i);
});

test("a covered artifact that never attests cleanly → verdicts invalidated, quarantined", async () => {
  // fake bcdev-like backend: run() returns pass with attestation {observedAny:false, identityMismatch:false}
  // for every covering run (simulating a wrong binary with no instrumented sites).
  const report = await runSession({ ...baseCfg, backend: neverAttestsFake() });
  // every covered mutant that would have been "survived" is instead error, and the report is quarantined.
  expect(report.mutants.every((m) => m.verdict !== "survived")).toBe(true);
  expect(report.quarantined).toBeDefined();
});

test("a covered artifact with ≥1 clean attestation reports verdicts normally", async () => {
  const report = await runSession({ ...baseCfg, backend: cleanAttestFake() });
  expect(report.mutants.some((m) => m.verdict === "survived")).toBe(true);
  expect(report.quarantined).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/runner/tests/orchestrator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the workers assertion** — in `runSession`, right after `const workers = Math.max(1, Math.floor(cfg.workers ?? 1));` (orchestrator.ts ~L556) and after `caps` is known:

```ts
  if (caps.authoritative && workers > 1) {
    throw new Error(
      "runSession: authoritative (bcdev) backend requires workers === 1 in Layer 5C-A — the " +
        "single LC Mutation Active row is not lease-protected against parallel RunMutant calls " +
        "(cross-process safety is 5C-B). Got workers=" + workers,
    );
  }
```

- [ ] **Step 4: Implement the attestation ledger**

Add a small mutable accumulator threaded like `safety`. In `runMutantsOnBackend`, after each `runOnce` result `v`, feed attestation:

```ts
      if (v.attestation?.observedAny === true && v.attestation.identityMismatch !== true) {
        args.attestation.markClean();
      }
```

Pass `attestation` (the batch's ledger) into `runMutantsOnBackend` from both the `workers===1` call (L889) and each shard (L975). Define per batch, before step 6:

```ts
      const attestation = { clean: false, markClean() { this.clean = true; } };
```

After the mutant loop / after `Promise.allSettled` settles (workers>1) and after the sequential call (workers===1), add the fail-closed gate. A batch "contributed verdicts" if any mutant in `execute` had covering tests (`perMutantTests.get(m.mutantId)?.length`). If it contributed but `!attestation.clean` AND the backend is authoritative:

```ts
      const contributed = execute.some((m) => (perMutantTests.get(m.mutantId)?.length ?? 0) > 0);
      if (caps.authoritative && contributed && !attestation.clean) {
        // No covered run confirmed the deployed binary is ours (design §G, fail-closed). Every
        // verdict from THIS artifact is untrustworthy — invalidate and quarantine (never ship a
        // false survivor). Overwrite this batch's recorded verdicts to error.
        invalidateBatchVerdicts(outcomes, batchIdx,
          `unattested artifact: no covered run observed the deployed binary's selector (artifactId ${compiled?.artifactId ?? "unknown"})`);
        safety.latchUnsafe(`artifact ${compiled?.artifactId ?? "?"} never attested`); // -> report.quarantined
      }
```

Implement `invalidateBatchVerdicts(outcomes, batchIndex, note)` (module fn): rewrite every `SessionOutcome` with `batchIndex === batchIndex` to `verdict: "error"`, `failureNote: note`. Confirm the exact `SessionOutcome`/`safety` API by reading their definitions (`safety` already has an unsafe-latch used by `quarantineInFlight` → `report.quarantined`; reuse that mechanism rather than inventing a new field). Because verdicts live in `outcomes[]` (and `store`) and `buildReport` runs only at `runSession` end (L1039), invalidation before that end is sufficient — nothing has left the orchestrator.

- [ ] **Step 5: Run to verify they pass**

Run: `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 6: Red-check** — remove the `if (caps.authoritative && contributed && !attestation.clean)` block; confirm the "never attests → invalidated/quarantined" test goes red; restore. Remove the workers assertion; confirm that test goes red; restore.

- [ ] **Step 7: typecheck, full runner suite, biome, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner
bunx biome check packages/runner/src/orchestrator.ts packages/runner/tests/orchestrator.test.ts
git add packages/runner/src/orchestrator.ts packages/runner/tests/orchestrator.test.ts
git commit -m "feat(5c): orchestrator asserts bcdev workers=1; per-artifact clean-attestation gate (fail-closed)"
```

---

### Task 11: remove the Task 7 itest workaround

**Files:**
- Modify: `packages/runner/itest/bcdev.itest.ts`

- [ ] **Step 1: Remove** the `odataRegisterArtifact` helper and its call in `runProtocolInvariantProbes`. The probe section now relies on the target having self-registered on the scratchB republish (Tasks 1–2) — the artifact guard passes because the target's own upgrade codeunit wrote the baked id. Keep the manifest-artifactId read (used to build the transport) but drop the explicit registry seed.

- [ ] **Step 2: typecheck (itest is in the tsc build), biome, commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist
bunx biome check packages/runner/itest/bcdev.itest.ts
git add packages/runner/itest/bcdev.itest.ts
git commit -m "test(5c): drop Task 7 odataRegisterArtifact workaround (target self-registers on republish)"
```

---

### Task 12: LIVE GATE + docs + housekeeping

**Files:**
- Modify: `packages/runner/itest/bcdev.itest.ts` (assert attestation in the gate)
- Modify: `fixtures/README.md`, `design.md` (§6.2), `docs/superpowers/specs/2026-07-22-layer-5c-a-task8-deploy-verify-design.md` (§ evidence)

- [ ] **Step 1: Add the attestation assertion to the gate** — in `runProtocolInvariantProbes` (or the main run assertions), assert that at least one covered-mutant run carried `attestation.observedAny === true && identityMismatch !== true` and NO run reported `identityMismatch`. (If the `SessionReport` does not surface per-run attestation, assert indirectly: the run-scoped-clear killer probe already forces a real covered run — extend it to read the transport verdict's `attestation` directly, as the probes drive the transport.)

- [ ] **Step 2: Publish the stack to Cronus281 (prerequisite order)**

Recompile + publish LethAL Control (with `RegisteredArtifact`, without the OData write), then let the itest publish the instrumented target (Tasks 1–2 + 8 staging) + sandbox-tests + sandbox-probes. Manual control-ext publish:

```bash
SP="C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL/89209fff-e206-4df0-98a6-a50d3b0cfed5/scratchpad"
ALC="/c/Users/SShadowS/.vscode/extensions/ms-dynamics-smb.al-18.0.2498801/bin/win32/alc.exe"
ALTOOL="/c/Users/SShadowS/.vscode/extensions/ms-dynamics-smb.al-18.0.2498801/bin/win32/altool.exe"
"$ALC" "/project:U:/Git/LethAL/extensions/lethal-control" "/packagecachepath:U:/Git/LethAL/extensions/lethal-control/.alpackages" "/out:$SP/lethal-control.app"
# bump the control app.json version FIRST if republishing over an installed copy (so OnUpgrade fires); then:
BC_SERVER_USERNAME=sshadows BC_SERVER_PASSWORD=1234 "$ALTOOL" publishapp "$SP/lethal-control.app" \
  --server http://Cronus281 --serverinstance BC --environmenttype OnPrem --authentication UserPassword \
  --schemaupdatemode ForceSync --tenant default
# copy the freshly compiled lethal-control.app to extensions/lethal-control/lethal-control.app so the itest stages it (Task 8)
cp "$SP/lethal-control.app" U:/Git/LethAL/extensions/lethal-control/lethal-control.app
```

- [ ] **Step 3: LIVE GATE (foreground, do NOT poll)**

```bash
cd U:/Git/LethAL && LETHAL_ITEST_BCDEV=1 bun run itest:bcdev
```
Expected: `bcdev itest: PASS` with killed 3 / survived 10 / no-coverage 3, all protocol probes pass, ≥1 clean attestation per artifact, no identity mismatch. Then:

```bash
cd U:/Git/LethAL && LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner
```
Expected: killed 3 / survived 13 / no-coverage 0. **Any differing verdict / failing probe / attestation mismatch / never-attested artifact → BLOCKED**: stop, diagnose the root cause (live is the authority, `mem:review_discipline`), fix in one commit, re-run. Do not proceed to docs until both are green.

- [ ] **Step 4: Docs**

- `fixtures/README.md`: add the harness-provisioning prerequisite (publish order), the probe app, the RunMutant execution model, and the attestation fence + the two preconditions (no concurrent publish; one instrumented target per container).
- `design.md` §6.2: correct to state Codeunit isolation is what is enforced (Function-level later).
- Spec `§ evidence`: record the live gate result (verdict table + attestation observed) and the housekeeping done.

- [ ] **Step 5: Housekeeping (host-side, interactive — ask the user to run with `! <cmd>`)**

```
! UnPublish-BcContainerApp -containerName <container> -appName "LC Spike Runner" -unInstall -force
! UnPublish-BcContainerApp -containerName <container> -appName "LethAL Upgrade Probe" -unInstall -force
```
Plus unpublish any prior instrumented sandbox target so at most one is installed (precondition 2).

- [ ] **Step 6: Commit**

```bash
cd U:/Git/LethAL && git add fixtures/README.md design.md docs/superpowers/specs/2026-07-22-layer-5c-a-task8-deploy-verify-design.md packages/runner/itest/bcdev.itest.ts extensions/lethal-control/lethal-control.app
git commit -m "docs(5c): live gate evidence (3/10/3 + attestation), harness provisioning, design.md 6.2 isolation"
```

---

## Self-Review

**Spec coverage:** §A→Tasks 1,2; §B→Task 6; §B2→Task 7; §C→Task 8; §D→Task 9; §E→Task 11; §E-qual→Task 10 (+ gate Task 12); §F→Task 12; §G→Tasks 3,4,5,10; §H fetch→Task 4, §H harness→Task 8, §H registry-key invariant→doc note (Task 12). Preconditions→Task 10 (workers) + Task 12 (housekeeping/docs). Every spec section maps to a task.

**Placeholder scan:** AL code is complete and self-contained. TS steps show real code deltas + anchors; the two spots that say "match the file's existing harness" (transport/verifier/backend/orchestrator test helpers) are deliberate — those test files already have fake-fetch/fake-backend builders and the executor must reuse them rather than duplicate, which is DRY, not a placeholder. No "TBD"/"add error handling"/"similar to Task N".

**Type consistency:** `attestation: { observedAny: boolean; identityMismatch: boolean }` identical across `backend.ts` (Task 5), transport (Task 4), orchestrator ledger (Task 10). `CONTROL_REGISTER_FILENAME`/`CONTROL_UPGRADE_FILENAME` defined in Task 2, consumed in Task 9. `RegisteredArtifact` AL proc (Task 7) matches the verifier's OData action name (Task 6). `emitRegisterInstall({objectId})`/`emitRegisterUpgrade({objectId})` signatures match between Task 1 (definition) and Task 2 (call). `TargetAppId()` added to both selector emitters (Task 1) satisfies the procedure-set-parity constraint.
