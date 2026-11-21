# PR-304 spec-light: running mutant tests in the session kind a project's CI uses (R1168); options for the owner

Coord PR-304 (lethal-code, 2026-11-21). Design only: no code, no live run.

## The gap
- **bcdev:** the harness runs each mutant's tests inside an ODataV4 call to the control app (`LC Run Method` / `LC Run
  Many`), so `GuiAllowed` is false.
- **DO's CI** (and the BcContainerHelper / AL-Go default): tests run in a CLIENT session, where `GuiAllowed` is true.
  - On DO, 60 of 422 tests change outcome by session kind.
  - 39 of those fail headless ("UI handlers were not executed") and therefore leave bcdev's green set.

## (a) How BcContainerHelper / AL-Go run tests
- **The mechanism:** `Run-TestsInBcContainer` opens a client session against the server's CLIENT SERVICES endpoint (the
  web client's `/cs` protocol), through .NET `ClientContext` from `Microsoft.Dynamics.Framework.UI.Client.dll`, shipped in
  the BC artifacts' test assemblies.
- **The flow:**
  1. it opens the Test Tool page (130455 "Command Line Test Tool");
  2. it sets the suite and the codeunit or method filter;
  3. it invokes Run;
  4. it reads each method's result from the page's fields.
- **The result:** every test runs in that client session, `GuiAllowed` true, with UI handlers active.
- **What LethAL would need:**
  - **Reach:** the client-services endpoint of the gate servers. `docs/gates/servers.md` lists only dev (7049), OData
    (7048) and API (7052) for `bc1`-`bc3`. **Unmeasured:** whether the BC-on-Linux servers expose client services at all.
    That is the first fact to check, through a kraken ask, since it is host configuration.
  - **A .NET client:** the container has `dotnet` (al-runner's sidecar runs on it). A small sidecar wrapping `ClientContext`
    (from the BC artifacts LethAL already caches) could drive the Test Tool page. No host-only tool, if the endpoint is
    reachable.
  - **Authentication:** the same user and password as the dev endpoint (`NavUserPassword`). Never on a command line.

## (b) What it does to the rest
- **The control app and activation:**
  - The active mutant is a control-app TABLE row, with a per-session SingleInstance cache (`LC Control State`). A client
    session would read it, so activation still goes through the fenced OData call (the lease proof is unchanged), and the
    tests then run in the client session.
  - What changes: the in-session attestation (`ObservedActive`, `NoteReached`, `TestMethodRuns`, GH-24 reach, R206
    freshness) is SingleInstance state in the session that RAN the tests. It must be persisted to a table, keyed by the
    run, and read back over OData.
  - So the control app would need a new version and a gate re-proof on every server.
- **Fencing and lease:** unchanged for activation. The client session is outside the OData lease path, so a second fence
  check (the run's id in the client session) is needed to keep the "only our run's mutant is active" proof.
- **Stop and hang:**
  - A client session in a loop must be stopped. The control app's stop (R53) ends sessions by id, and a client session has
    one, so the hang gate must be re-proven for client sessions.
  - Test-Tool timeouts differ from the OData call timeout.
- **Timing:** opening a client session costs roughly 1-3 s, and the page round-trips are slower than an in-session
  `Codeunit.Run`. A per-mutant or per-batch client session would raise bcdev's cost per mutant; this is unmeasured.
- **Coverage (R58, fenced mode):** coverage is collected in the session that runs the tests. The client session's coverage
  would need the same table-backed collection.
- **The gates:** every frozen BC gate baseline assumes headless runs. Tests that change by session kind (UI handlers)
  would move gate figures, so each gate's baseline needs a pre-committed re-record under the new mode.

## (c) Cheaper alternatives
1. **A session-kind caveat, recommended first.** It costs almost nothing.
   - At session start, a static `GuiAllowed` / UI-handler scan of the test app (PR-299's `predict.ts`, made a LethAL
     module) marks each test as `session-dependent` or not.
   - The report then names:
     - every mutant whose only covering tests are session-dependent;
     - every kill or survival that rests on a session-dependent test, as "measured headless; the project's CI may run a
       client session".
   - Plus one run-level caveat with the count.
   - No runtime change and no gate moves; one new Caveat (the ripple per CLAUDE.md).
2. **A per-project setting** `bcdev.ciSessionKind: "client" | "headless"` (default headless). With `client`, the
   caveats above become a validity warning, and a headless baseline failure of a session-dependent test is reported as
   "not measurable headless" instead of silently shrinking the green set.
3. **Cross-backend:** al-runner v3 runs WITH a client by default (R895). For session-dependent tests, v3's verdict
   measures the CI's path, though v3 is not authoritative (R586). The report could place v3's verdict beside bcdev's for
   those tests (a later option; it needs a v3 run).

## Recommendation (for the owner)
- **Now:** (c)1, plus the (c)2 setting. It makes the gap visible in every report at near-zero cost and moves no gate.
- **Next:** ask kraken whether `bc1`-`bc3` can expose client services.
  - If yes, a time-boxed probe of option (a): one fixture test with a `ConfirmHandler`, run through a `ClientContext`
    sidecar, against its headless result.
  - Then decide (a) on measured cost (per-mutant seconds, control-app changes, gate re-records).
  - If no, (a) is off the table, and (c) is the answer.
