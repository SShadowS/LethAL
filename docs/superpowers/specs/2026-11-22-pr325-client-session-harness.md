# PR-325 spec-light: a client-session bcdev harness (R1170), design only, for owner review before any build

Coord PR-325 (lethal-code, 2026-11-22). **The ruling:** q-20261122T023806-7c2df9d6 (kraken from the mantra; the owner may
overrule). Principle 30, design first. **No code and no gate moves** come from this document.

## What is measured (PR-308 → PR-321, throwaway Windows BC 28.4 with a web server; R1170)
- **Session kind:** a client session (`/cs`) runs CI's session kind. `GuiAllowed=Yes`, and a bound ConfirmHandler fires.
  Headless does neither. LethAL's instrumented build runs normally in it.
- **Activation:** today's control app caches the active mutant for a whole session. A Generation counter on
  `LC Mutation Active` (PR-314's probe build) lets one kept session serve every mutant, at about 4 µs per guard call.
- **Cost per mutant:** with a kept `ClientContext`, a kept page 130455 and a wait with no fixed sleeps (PR-321), about
  0.24 s. That is a run of 0.191 s (3 round trips at a 56.5 ms median, plus the test), plus about 0.05 s of OData
  activation. The guard was right in 25 of 25 runs.
- **Harness traps:**
  - `-testCodeunit` alone ran 0 tests, silently; 0 tests must count as a FAILURE;
  - BcContainerHelper's own waits sleep about 200 ms per round trip.

## 1. Where it sits: `ciSessionKind` picks the path
- **`ciSessionKind: "headless"`:** today's bcdev path (ODataV4 `RunMutant`), unchanged.
- **`ciSessionKind: "client"`:** the client-session harness below, on a server that has a web server with `/cs`.
- **The backend says which it ran**, and the report's session-kind label (PR-307) reads `client`.
  `session-kind-mismatch` then drops away for client projects run this way.
- **On a server WITHOUT `/cs`** (bc1-bc4 today: BC on Linux has no web server), with `ciSessionKind: "client"`: **REFUSE
  by name** (`client-session-unavailable`), naming the server and the probe that failed.
  - Never fall back silently. The headless run is still available by passing `--ci-session-kind headless` (PR-311), and
    that run carries `session-kind-mismatch`, the existing label (principle 6: label, never hide).
  - The refusal comes from a cheap probe before anything is published.

## 2. The control app: the Generation counter as a REAL release, 1.0.0.30
- **The version clash:** PR-314's probe build was numbered 1.0.0.29, but bugs' PR-309 (R1138, the read-only TryRenew)
  ships the REAL 1.0.0.29.
- **The fix:** the counter ships as **1.0.0.30, on top of PR-309's 1.0.0.29.** The probe build stays a probe:
  - it was never on bc1-bc4, and the containers that held it are removed;
  - its branch `lethal/pr-314` is a record, and never merges;
  - nothing may ever publish a second 1.0.0.29.
- **What 1.0.0.30 adds** (the probe's shape, reviewed again for the release):
  - a `Generation` field, bumped by every write of the active tuple;
  - `IsActive` and `NoteReached` re-read one field and reload when it moved, but only outside an OData run and never
    after the fail-closed reset. PR-314's `ExpectedArtifactId` and `ResetSinceLoad` rules keep the headless path's
    fail-closed behaviour exactly.
  - **Fenced activation without a run:**
    - a lease-fenced `ActivateForClient(lease, artifact, mutant)` that writes the tuple and commits, plus a fenced
      `DeactivateForClient`;
    - today only `RunMutant` phase 1 writes the tuple, and these keep the same lease and epoch proof.
  - **The attestation in a table:** `ObservedAny`, `ObservedIdentityMismatch`, `ObservedActive` (GH-24 reach) and
    `TestMethodRuns` (R206) are written by the client session into a run-keyed row, and read back over OData by the
    harness after each mutant's tests.
    - Today they are SingleInstance state in the session that ran the tests, which in client mode is not the OData
      session.
- **The rest:** `MIN_CONTROL_VERSION` moves to 1.0.0.30 only when the client harness ships. The headless path keeps
  working against 1.0.0.30. Every server's control app is republished by the setup script, and the gates are re-proven
  per server (the CLAUDE.md control-app rule).

## 3. The driver: a kept `ClientContext` and a kept page 130455
- **The process:** a small .NET sidecar (the container has `dotnet`), one per lane. It loads
  `Microsoft.Dynamics.Framework.UI.Client.dll` from the BC artifacts LethAL already caches, and talks to
  `http(s)://<server>/<instance>/cs`.
  - The credentials are the dev endpoint's (`NavUserPassword`), read from the config file, never on a command line.
- **Once per lane:**
  1. open the session;
  2. open page 130455;
  3. set the suite, the extension id and the codeunit range.
- **Per mutant:**
  1. `ActivateForClient` over OData, about 0.05 s;
  2. `ClearTestResults`;
  3. `RunNextTest` until `All tests executed.`, reading `TestResultJson` each time;
  4. read the attestation row;
  5. `DeactivateForClient`.
- **The wait:** on `ClientSessionState` with no fixed sleeps (PR-321's shape: a brief spin, then 1 ms polls, plus a 1 ms
  settle check), with the interaction timeout from the mutant's budget.
- **Results map to `TestVerdict` as today's harness does.** A run with 0 results, or a stale result (the previous
  mutant's generation), is a FAILURE of the harness, never a verdict.

## 4. Failure and stop handling
- **A hung test in the kept session:**
  - the interaction timeout (the mutant's budget) fires on the driver side;
  - the driver then stops the client session by id through the control app's stop (R53, `--stop-hung-sessions`) and
    opens a fresh session and page;
  - the mutant scores `timeout-killed` exactly as today's headless stop does.
  - **R1171's rule applies:** without the stop, the run warns `stop-hung-sessions-off` and quarantines on an overrun.
  - The hang gate needs a client-mode leg before this ships.
- **A dead session** (`InError`, a dropped connection): the driver reopens the session and page and retries the mutant
  ONCE. A second failure makes the mutant `error` (infra, not a verdict), and three in a row stop the lane by name.
- **Lease and fencing:**
  - every `ActivateForClient` and `DeactivateForClient` carries the lease proof;
  - the client session only reads the tuple;
  - a lost lease mid-run stops the lane before its next activation, exactly as the headless path does.
- **The test-app identity, the TestPage scan and company-write leave-outs** are unchanged. Only the transport of the test
  run changes.

## 5. What still costs time, and what may cut it
- **Per mutant, about 0.24 s of harness overhead,** against bcdev's headless per-call overhead today:
  - about 3 round trips at about 56 ms;
  - one OData activation at about 50 ms;
  - one attestation read and one deactivation, about 2 × 50 ms more, NOT in PR-321's figure: about 0.34 s in all.
- **Possible cuts, each needing a measurement before it is claimed:**
  - fold the attestation read into the next mutant's activation call (one OData call fewer);
  - deactivate only at the end of a lane (the next activation overwrites the tuple; the fail-closed reset still runs at
    the lane's end);
  - several lanes, as today, since the client sessions are independent.

## 6. What this does NOT change
- The headless path, its gates and its figures.
- The verdict rules.
- The v3 backend (al-runner already runs a client session by default).

## Open for the owner
- (a) Is a Windows BC with a web server available for client-mode gates? None of bc1-bc4 has `/cs`; that is the infra call
  for the owner and kraken.
- (b) Refuse by name when `ciSessionKind=client` and no `/cs` is reachable (recommended), or fall back to headless with
  the caveat?
- (c) Build order: 1.0.0.30 first (headless-compatible, and gate-provable on bc1-bc4), then the driver.
