# R77 — Custom Test Runner: Measurement Plan

**Status:** REVIEWED AND APPROVED (Fable, 2026-08-01, second pass) — cleared to run.
First draft was rejected: it could misfile both directions. See "The probe object" for why.

**Goal:** answer, by measurement, whether LethAL can supply its OWN `Subtype = TestRunner` codeunit,
and specifically whether the bcdev SignalR hub will run one. If it will, mutant activation and
attestation move INSIDE the hub session and "hub carries verdicts" — declared dead twice today —
comes back.

**This plan measures. It does not implement.** No production code changes, no `packages/` changes,
no control-app changes. Its only deliverables are a throwaway probe app, a ROADMAP finding, and a
go/no-go for a later implementation plan.

---

## What is already established (do not re-derive)

| Fact | Evidence |
|---|---|
| The hub wire has no runner/suite/isolation knob | Decompiled `HubBasedTestRunnerService`: `Initialize(company, debuggingContext, coverageMode)`, `RunTests(codeunitId, testMethods[])`, `StopTestExecution()`. `bc-dev-mcp/src/core/hubs/test-runner-hub.ts:76,138` already sends everything it accepts. |
| Controlling bc-dev-mcp does not help | The limit is server-side platform code, not the client. |
| `Subtype = TestRunner` + `OnBeforeTestRun`/`OnAfterTestRun` compiles against existing symbols | `docs/measurements/r77-custom-testrunner-probe.al`, offline alc, clean |
| `AL Test Suite."Test Runner Id"` is settable | same probe (the guessed `"Test Runner Codeunit ID"` does NOT exist) |
| `TestIsolation = Function` compiles | same probe |
| `runOnHub` never activates a mutant | `bcdev-backend.ts:771` — no `pendingMutantId` reference. Routing mutants there today = 100% silent false survivors. |
| A custom runner is NOT transport-agnostic | It applies only where execution goes through `Test Suite Mgt.RunAllTests`, which the hub bypasses |

---

## The question, precisely

**Q1 (gates everything).** When `RunTests(codeunitId, [])` names a codeunit whose `Subtype` is
`TestRunner` rather than `Test`, does the NST run it, reject it, or do something else?

**Q2 (only if Q1 = runs).** Does that runner's `OnRun` execute, and does a test it invokes via
`Codeunit.Run` actually run — and what session does that test observe?

Nothing beyond Q1/Q2 is in scope. Activation, attestation and isolation semantics are the NEXT
plan's business, and only if Q1 passes.

---

## Design

### Where

`fixtures/sandbox-probes` on **Cronus281**. Deliberately NOT `extensions/lethal-control`: the probe
must not touch the shipped control app, and sandbox-probes is the established throwaway-probe
fixture with LethAL Control already deployed alongside it for OData readback.

Object ids: sandbox-probes owns **79200..79299**. Use **79220** (free — 79213/79214/79218 are taken).

### The probe object

**Revised after adversarial review, which found the first draft could misfile BOTH directions.**

The naive design — have the runner invoke 79213 and look for its `MEASURED ...` string — is unsound
twice over:

- **False positive.** That string is byte-identical to the control run's output, produced moments
  earlier on the same container. R69 has already been burned by stale persisted results once.
- **False SILENT, and this is the dangerous one.** If the platform DOES treat 79220 as the active
  runner — the success case — then 79213's `Error(...)` is CAPTURED by the framework and handed to
  `OnAfterTestRun`. `Codeunit.Run` returns false, `OnRun` completes cleanly, and the hub (whose
  collection reports `[Test]` methods of the dispatched codeunit, of which a TestRunner has none)
  plausibly returns an empty success. The first draft would then have filed its own SUCCESS as
  SILENT -> REJECTED and killed a live avenue.

So the runner must emit a token **only it can produce**, and must be classified on that token rather
than on error-vs-success:

```al
namespace LethAL.SandboxProbes;

/// R77 probe: will the NST run a `Subtype = TestRunner` codeunit named in the hub's
/// `RunTests(codeunitId, [])`? Emits a token no other object can produce, because the obvious
/// observable (79213's own MEASURED string) is indistinguishable from the control run's output.
codeunit 79220 "Runner Probe"
{
    Subtype = TestRunner;

    var
        RanBefore: Boolean;
        RanAfter: Boolean;
        Captured: Text;

    trigger OnRun()
    var
        Marker: Record "Sandbox Probe Marker";
        Ok: Boolean;
    begin
        Ok := Codeunit.Run(Codeunit::"Session Capability Probe");
        // If the platform runs OnRun WITHOUT installing 79220 as the active runner, OnAfterTestRun
        // never fires and `captured=` would come back empty. Recover the MEASURED string on that
        // branch too, so the token answers Q2 in both worlds.
        if (not Ok) and (Captured = '') then
            Captured := GetLastErrorText();
        // Secondary observable. Survives only if the hub does not wrap dispatch in an isolation
        // that rolls it back — so PRESENT proves the runner ran, ABSENT proves nothing.
        if not Marker.Get(77770) then begin
            Marker.Init();
            Marker."Entry No." := 77770;
            Marker.Insert(false);
        end;
        Commit();
        // Primary observable: a token only this object emits.
        Error('R77-RUNNER onrun=Yes ran=%1 before=%2 after=%3 captured=%4',
            Ok, RanBefore, RanAfter, CopyStr(Captured, 1, 120));
    end;

    trigger OnBeforeTestRun(CodeunitID: Integer; CodeunitName: Text; FunctionName: Text; FunctionTestPermissions: TestPermissions): Boolean
    begin
        RanBefore := true;
        exit(true);
    end;

    trigger OnAfterTestRun(CodeunitID: Integer; CodeunitName: Text; FunctionName: Text; FunctionTestPermissions: TestPermissions; IsSuccess: Boolean)
    begin
        RanAfter := true;
        if Captured = '' then
            Captured := GetLastErrorText();
    end;
}
```

Verified before writing this, not assumed: `codeunit 79213 "Session Capability Probe"` exists with
`[Test] ReportsSessionCapabilities` raising `MEASURED GuiAllowed=%1 | ClientType=%2 | Company=%3 |
UserId=%4`; `table 79200 "Sandbox Probe Marker"` exists with a single `Entry No.` key; 79220 is free
(79200-03 and 79210-18 are taken). A bare `Codeunit.Run` on a `Subtype = Test` codeunit DOES execute
its `[Test]` methods — that is Microsoft's own runner mechanism, and this repo already captured the
stack proving it (`79218.ReportsTestPageOpen <- Test Runner - Mgt(130454).RunTests <- Test Runner -
Isol. Codeunit(130450).OnRun`).

### How it is invoked

Through **`bcdev_test_run`** — the same MCP tool `runOnHub` uses — naming **79220** with an EMPTY
method list. Reuse the existing harness; do not modify `bc-dev-mcp`, which would change what is being
measured.

### Controls — TWO, and both payloads captured verbatim

The classification is shape-comparison against references, so the references must be recorded, not
just observed.

1. **Known-good:** `bcdev_test_run` against **79213** directly (an ordinary `Subtype = Test`
   codeunit). Proves harness, container and readback. If this fails, STOP — the real probe is
   uninterpretable until it passes.
2. **Known-absent:** `bcdev_test_run` against a **nonexistent id (79299)**. Captures the wire shape of
   "never dispatchable". Without it, an empty-ish 79220 response cannot be told apart from a
   legitimate no-op — `RunTests(79220, [])` plausibly means "all `[Test]` methods", of which a
   TestRunner has none, which is neither refusal nor execution.

## Steps

- [ ] **1.** Read `fixtures/sandbox-probes/src/SessionCapabilityProbe.Codeunit.al`; confirm the object
      name, its `[Test]` method, and the exact `MEASURED …` string it raises. Confirm 79220 is unused.
- [ ] **2.** Add the probe codeunit. `bun run compile:fixtures` — mandatory after ANY `.al` change
      under `fixtures/`; nothing else compiles them.
- [ ] **3.** Publish the sandbox-probes app to Cronus281 (`$env:DOCKER_CONTEXT='desktop-windows'`
      first). Read `fixtures/README.md` for the invocation rather than guessing.
- [ ] **3b.** After publish, run `bcdev_test_discover` and confirm the discovered test set is
      UNCHANGED — cheap proof that a dormant TestRunner codeunit does not enter discovery.
- [ ] **4.** CONTROL A (known-good): `bcdev_test_run` against **79213**. Expect the `MEASURED ...`
      string. Capture the payload VERBATIM. If this fails, STOP and fix the harness.
- [ ] **4b.** CONTROL B (known-absent): `bcdev_test_run` against **79299** (nonexistent). Capture the
      payload VERBATIM. This is the "never dispatchable" reference shape.
- [ ] **4c.** STALE-MARKER GUARD (required). Marker row 77770 is the SOLE discriminator for
      RAN-UNREPORTED and nothing clears it — table data survives an app republish, so a second
      attempt would inherit the first's marker and misfile a genuine SILENT/REJECTED as
      RAN-UNREPORTED. That is the same stale-positive shape the token fix closed on the other
      channel. Before EACH probe invocation, confirm entry 77770 is ABSENT and delete it if present,
      and record "marker confirmed absent at T0" beside the payloads.
      **The marker table has no OData page or query**, so use `bcdev_debug_sql` for both the read and
      the delete — the table is `Sandbox Probe Marker`, key `Entry No.` = 77770. If `bcdev_debug_sql`
      is unavailable, fall back to writing a DIFFERENT `Entry No.` per attempt (77770, then 77771 on
      a recompile+republish) so presence is unambiguously attributable to one invocation, and say in
      the report which mechanism was used.
- [ ] **5.** PROBE RUN: `bcdev_test_run` against **79220**, empty method list. Capture the FULL
      response verbatim, including any error text, then read marker 77770 back via `bcdev_debug_sql`.
- [ ] **6.** Classify (see below), record in ROADMAP R77 with the verbatim payloads.
- [ ] **7.** Restore: revert the probe codeunit, `bun run compile:fixtures`, republish. Confirm
      `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` still reports **3 killed / 10 survived /
      3 no-coverage**. Sandbox-probes shares Cronus281 with that gate, so leaving it dirty risks it.

## Classification

Classify on the **token**, not on error-vs-success. A positive that arrives WITHOUT the
`R77-RUNNER` token is not a positive.

| Outcome | Signal | Next |
|---|---|---|
| **RUNS** | `R77-RUNNER` token present anywhere in the payload, on any channel | Platform accepts and runs a TestRunner by name. Hub-carries-verdicts is credible. Write the implementation plan (activation in `OnBeforeTestRun`, attestation in `OnAfterTestRun`). Do NOT implement here. |
| **RAN-UNREPORTED** | No token, but marker row 77770 present | The runner RAN; the hub's collection did not surface it. A plumbing limit, not a platform refusal — and `bc-dev-mcp` is ours to change. Still a live avenue. |
| **REJECTED** | Explicit platform error naming the subtype/codeunit, distinct from Control B's shape | Platform requires `Subtype = Test`. Hub closed for verdicts, on evidence. |
| **UNANSWERED (blocked)** | Error provably originating in `bc-dev-mcp` BEFORE dispatch | Q1 not answered. Do NOT record as REJECTED. |
| **SILENT** | No token, no marker, payload indistinguishable from Control B | Genuinely ambiguous. Treat as REJECTED for PLANNING only, and file the ambiguity itself as a hazard — a runner that reports success while executing nothing is this project's signature bug shape. |

**Stated limit of the marker:** if the hub wraps dispatch in an isolation that rolls back, the
`Commit()` may not survive. Marker PRESENT proves the runner ran; marker ABSENT proves nothing. The
token on the error channel is the primary observable. Note honestly that Control A proves the
`[Test]`-failure channel, not the `OnRun`-error channel — so record the raw payloads either way.

## Watch while running

- **Classify on the token**, even if the hub wraps it in a success-shaped payload. A RUNS verdict
  needs `R77-RUNNER`, never 79213's bare `MEASURED` string.
- **Step 3b is a finding, not just a precondition.** If 79220 DOES appear in `bcdev_test_discover`,
  record it — that would mean a deployed TestRunner enters discovery on shared containers, which is a
  safety fact worth having either way.
- **If the probe hangs:** recover first, re-verify the gate second, classify last. A post-hang
  readback is not trustworthy until the NST is confirmed healthy.
- Step 7: the marker row survives the republish. Harmless to the frozen gate (sandbox-probes is in no
  baseline) but delete it during restore.

## Time box

Two invocation attempts after the control passes. If `bcdev_test_run` cannot be reached at all after
~6 focused attempts, report BLOCKED with the exact errors. Do not grind, and do not start modifying
`bc-dev-mcp` to make it work — that is out of scope and would change what is being measured.

## Risks

- **Shared container.** Cronus281 also serves `itest:bcdev` (frozen 3/10/3). Step 7's restore and
  gate re-verification is not optional.
- **Publishing a `Subtype = TestRunner` codeunit** adds an object; it replaces nothing and changes no
  existing behaviour. Low risk, and it is removed in step 7.
- **A hung invocation.** If the platform mishandles the subtype it could hang rather than error.
  Recovery is the known pair: `force-reset-lease` then `clear-quarantine`; a Docker restart of
  Cronus281 only if the NST is genuinely stuck.

## Explicitly out of scope

Implementing activation or attestation in the runner; changing `LC Run Method`; setting
`AL Test Suite."Test Runner Id"` anywhere; touching `bc-dev-mcp`; wiring `routedTransport`; anything
touching R74/R75; Document Output.
