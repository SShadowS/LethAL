# PR-325 spec-light v2: a client-session bcdev harness (R1170), design only, for owner review before any build

Coord PR-325 (lethal-code, 2026-11-22). **The ruling:** q-20261122T023806-7c2df9d6 (kraken from the mantra; the owner may
overrule). Principle 30, design first. **No code and no gate moves** come from this document.

**v2 folds in an Opus spec-adversary review of v1** (`/coord/handoff/PR-325/spec-review.md`):
- five blocking findings: one lane per server; a generation-checked attestation; the isolation probe; the same grouping for
  baseline and mutants; the stop marker;
- three serious ones: the timeout source; a retry only after a confirmed end; a separate version gate.

## What is measured (PR-308 → PR-321, throwaway Windows BC 28.4 with a web server; R1170)
- **Session kind:** a client session (`/cs`) runs CI's session kind. `GuiAllowed=Yes`, and a bound ConfirmHandler fires.
  The instrumented build runs normally in it.
- **Activation:** today's control app caches the active mutant per session. A Generation counter (PR-314's probe build)
  lets one kept session follow each new activation, at about 4 µs per guard call.
- **Cost per mutant:** with a kept `ClientContext`, a kept page 130455 and a no-sleep wait (PR-321), about 0.24 s for a
  one-codeunit range. That is 3 round trips at a 56.5 ms median, plus the test, plus about 0.05 s of OData activation.
  The guard was right in 25 of 25 runs.
- **Harness traps:** `-testCodeunit` alone ran 0 tests, silently, so 0 tests must count as a failure. BcContainerHelper's
  own waits sleep about 200 ms per round trip.
- **NOT measured yet,** and needed before any build (§7): whether writes made inside a test survive the Test Runner's
  isolation.

## 1. Where it sits: `ciSessionKind` picks the path
- **`headless`:** today's bcdev path, unchanged.
- **`client`:** this harness, on a server with a web server and `/cs`.
- **No `/cs`** (bc1-bc4 today; BC on Linux has no web server): REFUSE by name (`client-session-unavailable`) after a cheap
  probe, before anything is published.
  - No silent fallback; `--ci-session-kind headless` (PR-311) runs headless, with the `session-kind-mismatch` label.
- **Client mode is gated by its own check** (control 1.0.0.30 present). It does not move the global `MIN_CONTROL_VERSION`.

## 2. ONE lane per server (it was "several lanes" in v1, which was wrong)
- There is one `LC Mutation Active` row per server, which is why bcdev refuses `--workers > 1`.
- If two client lanes shared it, one lane's activation would reload under the other lane's running tests, giving a false
  kill.
- **So:** client mode runs ONE lane per server, under the lease, exactly as headless bcdev does. More throughput means
  more servers, never more lanes.

## 3. The control app: 1.0.0.30, on top of PR-309's real 1.0.0.29
- **The version clash:** PR-314's probe build was numbered 1.0.0.29, but PR-309 ships the REAL 1.0.0.29 (R1138, the
  read-only TryRenew).
- **The fix:** the counter ships as **1.0.0.30**. The probe build stays a probe: never on bc1-bc4, its containers
  removed, and its branch `lethal/pr-314` a record that never merges. Never a second 1.0.0.29.
- **What 1.0.0.30 adds:**
  - **`Generation`** on `LC Mutation Active`, bumped by every tuple write.
  - **The refresh gate keyed on "inside an OData op"** (an explicit flag set by phase 1 and cleared by phase 3 and every
    recovery path), NOT on `ExpectedArtifactId`.
    - The client session never sets `ExpectedArtifactId`, and keying on it invites a "fix" that freezes the session on
      its first mutant.
    - The fail-closed reset (`ResetSinceLoad`) keeps blocking the refresh after phase 3, as in PR-314.
    - The review confirmed that the headless path's fail-closed behaviour holds in every phase.
  - **`ActivateForClient(lease, artifact, mutant)` (fenced):**
    - writes the tuple, bumps the generation, opens an **op of a new kind, `client-run`**, commits, and returns the
      generation it wrote;
    - the op records the client session id (see §4), so the lease shows an op in flight and the in-flight and
      quarantine checks see it.
  - **`DeactivateForClient(lease, opId)` (fenced):** the `client-run` op's phase 3. It runs the tuple-conditional clear
    and the fail-closed reset.
  - **A generation-checked attestation.** The client session writes, per test method, a row keyed by `(op id, method)`,
    holding:
    - the generation and mutant id it ACTUALLY loaded;
    - `ObservedAny`, `ObservedIdentityMismatch`, `ObservedActive` (GH-24 reach) and `TestMethodRuns` (R206).
  - **The harness refuses** any row whose generation or mutant id differs from what `ActivateForClient` returned, and a
    MISSING row, by name. A missing row is never read as "not reached". That is what stops a stale tuple from producing a
    false kill with a clean attestation.
  - **Observations reset per method in the client session,** as `RunMany` does headless, and reach is not left latched
    across methods.

## 4. The driver: a kept `ClientContext` and a kept page 130455
- **The process:** a small .NET sidecar (the container has `dotnet`), ONE per server lane. It loads
  `Microsoft.Dynamics.Framework.UI.Client.dll` from the cached BC artifacts and talks to `http(s)://<server>/<instance>/cs`.
  - The credentials come from the config file, never a command line.
- **Once per lane:**
  1. open the session;
  2. read its session id (a tiny control-app page action or field the client session reports);
  3. open page 130455 and set the suite.
- **Per mutant:**
  1. `ActivateForClient` (passing the session id), keeping the generation;
  2. set the mutant's covering METHODS on the page (the same selection the headless path sends, not the whole range);
  3. `ClearTestResults`, then `RunNextTest` until `All tests executed.`;
  4. read the attestation rows and check each generation and mutant id;
  5. `DeactivateForClient`.
- **The wait:** on `ClientSessionState`, with no fixed sleeps (PR-321's shape).
- **0 results, a stale or missing attestation row, or a generation mismatch** is a harness FAILURE, never a verdict.

## 5. The same grouping for baseline, coverage and mutants
- **The difference:** page 130455 isolates per CODEUNIT; headless `RunMany` runs one `CODEUNIT.Run` per method. R198
  measured that grouping leaks one method's writes into the next.
- **So in client mode, the baseline and the coverage run use the client harness too,** and every mutant runs its covering
  methods with the SAME grouping. A test that fails only when grouped then fails at baseline, and is never green there
  only to fail under every mutant.
- The green set and the verdicts come from one session type and one grouping (the R198 rule).

## 6. Failure and stop handling
- **A hung test:**
  - the driver's interaction timeout (the mutant's budget) is only a TRIGGER;
  - the mutant scores `timeout-killed` only when the control app's stop confirms it stopped THIS session while it ran THIS
    `client-run` op (R53, `--stop-hung-sessions`, on the op's recorded session id);
  - otherwise it scores `in-flight-unknown` (a socket stall or a server1 suspend looks the same as a hang). That is
    today's R53 rule.
  - **R1171:** without the stop, the run warns `stop-hung-sessions-off` and quarantines on an overrun.
  - A client-mode hang-gate leg is required before this ships.
- **A dead session** (`InError`, a dropped connection): before ANY retry, the old session's end must be confirmed, by the
  stop or by the op's state. Then reopen the session and page, and retry the mutant once.
  - Unconfirmed means quarantine the lane by name. A lost `ActivateForClient` answer is `in-flight-unknown`.
- **Lease and fencing:**
  - `ActivateForClient` and `DeactivateForClient` carry the lease proof;
  - the client session only reads the tuple;
  - a lost lease stops the lane before its next activation.
- The test-app identity, the TestPage scan and company-write leave-outs are unchanged.

## 7. Measure BEFORE any build: one more time-boxed probe
- **The question:** do the attestation rows survive the Test Runner's isolation? Page 130455 runs tests under the
  isolation runner, and a table write inside a test method is expected to roll back with it.
- **Two candidates, each measured:**
  - (a) write the row from Test Runner event subscribers that run outside the isolated transaction;
  - (b) a SingleInstance buffer flushed by an after-codeunit subscriber.
- **The probe:** one fixture test, a mutant reached and not reached, and the row read back over OData. A design that
  cannot carry the attestation out is NOT built.

## 8. What still costs time
- **Per mutant, measured:** about 0.24 s for a one-codeunit range.
- **Not measured,** each an estimate:
  - the attestation read and the deactivation, about 2 × 50 ms more;
  - `RunNextTest` round trips, which grow with the number of covering codeunits (one per codeunit, plus one).
  - So about 0.34 s plus about 56 ms per covering codeunit.
- **The headless figure to compare with,** bcdev's per-mutant call overhead on the gate servers, is measured as part of
  the build's A/B. It is not assumed here.
- **Cuts, each measured before it is claimed:** fold the attestation read into the next activation; deactivate per
  lane-end, with the fail-closed reset kept.

## 9. What this does NOT change
- The headless path, its gates and its figures.
- The verdict rules.
- The v3 backend (al-runner already runs a client session).

## Open for the owner
- (a) A Windows BC with a web server for client-mode gates: none of bc1-bc4 has `/cs`. That is the infra call.
- (b) Refuse by name with no `/cs` (recommended) or fall back to headless with the label.
- (c) The order:
  1. the §7 isolation probe;
  2. 1.0.0.30, headless-compatible and gate-provable on bc1-bc4;
  3. the driver;
  4. client-mode gate legs, hang included.
