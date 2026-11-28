# PR-479 (479a) pre-commitment: the `bcdev-client` backend, experimental, coverage OFF

Coord PR-479 (lethal-preproc, 2026-11-28).
- **Design:** `2026-11-22-pr325-client-session-harness.md` (Amendments 1 and 2) and the control half
  `2026-11-27-pr478-control-1031.md` (amendments 1-6, all built, and proved in PR-478).
- **Split (orchestrator ruling, 2026-11-28):** 479a is this file. 479b is client-session coverage through page 130455's
  code-coverage fields, plus scoring TestPage tests (B5), each with its own pre-commitment and measurement. PR-480 is the
  cost cuts.
- **Evidence:** `/coord/handoff/PR-479/` and PR-478's `bcwin/`.

## 1. What 479a builds
1. **A new backend kind, `bcdev-client`.**
   - `BackendKind` gains it. `isBcdev` stays `kind === "bcdev"`, and a new `isBcServer(kind)` is true for both. Every one
     of the 53 kind branches is decided in an exhaustive table (`/coord/handoff/PR-479/audit.md`, committed with the build
     as a test-read list): same as bcdev, refuse by name, or a new arm.
   - The two collapses are removed: `buildBackend` and `backendName` (orchestrator) store `bcdev-client`, never `bcdev`.
   - `backendSessionKind` returns `client` for it.
2. **Experimental and opt-in (ruling, until 479b):**
   - `--backend bcdev-client` is refused by name (`bcdev-client-experimental`) unless the run also passes
     `--experimental-client-mode`.
   - No config key, default, gate leg or script picks it. A source test pins that no default and no non-test caller names
     it.
3. **A repo-owned .NET sidecar,** `packages/runner/client-driver/` (net8.0, `cs-driver` from PR-478, hardened):
   - built by `bun scripts/build-client-driver.ts`, against the cached client library plus the WCF 4.10.3 set
     (`/coord/cache/bc-client/`);
   - stdin takes one JSON command and stdout gives JSON lines; the login is read from the config FILE (path only), never
     argv or env;
   - each step has its own deadline, and first-chance exceptions are logged by name (R1240);
   - the method filter is `TestProcedureRangeFilter`;
   - before each `RunNextTest` it reads back page 130455's codeunit range, method range and runner id (B4: 130450 only), and
     refuses on a difference;
   - the order is: open, bind through page 91015 (Bound = Yes, Reason empty, or refuse), the codeunit run, End, close. A
     session is NEVER bound twice or reused.
   - CI has no `dotnet`, so unit tests drive the TypeScript side against a recorded fake driver. The real driver is
     exercised by the bcwin legs (section 5).
4. **The grouping (B1), with coverage off:** coverage off means every mutant runs EVERY test codeunit, each as its full
   declared run.
   - One fresh `/cs` session per test codeunit, in the manifest's fixed codeunit order, for the baseline and every mutant.
   - Each codeunit runs its methods in declared order. No method is switched off.
   - Results are joined by (codeunit, method, line no.), never by position.
   - R197's ledger, R1174's re-walk and `--no-kill-ledger` are refused or off by name on this backend.
5. **Per codeunit run (the TypeScript side):**
   - `ActivateForClient` (with the fence, keeping the Generation), then the driver;
   - after close, `DeactivateForClient` (expects `deactivated`), then `ReadClientAttestation`.
   - The ops are `client-run`. The lost-answer recovery (`reconcileLostAck`, `classifyRetryRefusal`, the runMany watchdog)
     and the doctor learn `client-run` beside `run`: five sites.
6. **Verdicts (B4), all from the rows:**
   - every method the page ran has exactly one row of this op, and the row's session id is the one the driver bound;
   - when `Loaded`, `loadedGeneration` equals Activate's Generation and `loadedMutantId` equals the mutant;
   - `Loaded = false` is accepted only with nothing observed;
   - no `observedIdentityMismatch`;
   - the row's `success` agrees with the page's result.
   - **A failure, never a verdict:** anything else, including an empty run, zero rows (amendment 2, item 6) or a page
     failure with no row.
   - **Killed:** a method fails and the row agrees. The kill is then REPRODUCED by replaying the same codeunit's full
     declared run in a fresh session, and must fail the same method again (`reproduceKill` gets a client arm).
     `confirmWarm`'s position arguments are not used: the replay is its confirmation.
   - **Survived:** every codeunit ran green under the mutant.
   - **The baseline:** every codeunit in client sessions; a red test is left out, as headless does.
7. **Stops and overruns (A5, and amendment 3 of the control pre-commitment):**
   - there is no `timeout-killed` in 479a;
   - a run past its bound, or a dead or unreachable session, is `in-flight-unknown`, and the lane is quarantined by name;
   - the op stays in flight (no End), recovered only by an NST restart plus ForceResetLease;
   - the driver sends no stop.
8. **TestPage tests** stay refused by name, as headless (B5's scoring is 479b's).
9. **The Caveat (ruling):** `client-no-coverage`, on EVERY bcdev-client run. "Coverage is off on this backend: a survivor
   may be a mutant no test reached. Do not read these survivors as headless survivors." The CLAUDE.md ripple follows:
   - `CAVEAT_INTERPRETATIONS`;
   - the counts in `interpretation.test.ts` and `report.test.ts`;
   - the schemas, if the caveat list is pinned there.
10. **Never mixed (B2 plus the ruling):** each refused by name, with one red test per direction:
    - `--resume` and `--resume-run`;
    - history lending (`backendBuildRefusal` gains an equality arm on kind for non-v3 pairs);
    - baseline-snapshot reuse (`findBaselineSnapshot` gains a backend predicate);
    - `campaign freeze` (a stage records its backend) and `campaign compare` (refuses a backend difference);
    - `confirm` and `--confirm-from`;
    - `scripts/bc-v3-join.ts`: a bcdev-client report on either side is refused, since no coverage-mode join is allowed.
11. **The version gate:** a bcdev-client run requires LethAL Control 1.0.0.31 or later, refused by name before anything is
    published. `MIN_CONTROL_VERSION` (headless) stays 1.0.0.29.
12. **No `/cs`:** a cheap probe of `<web base>/cs`, before any publish, refuses by name `client-session-unavailable`.
    - On bc1-bc5 the probe refuses. That is the proof that no client-run op opens on a gate server (control amendment 6).
    - The web base comes from a new optional `bcdev.webClientBaseUrl` in the config.

## 2. What 479a does not change
- The `bcdev` and `al-runner-v3` backends and every frozen gate figure: the headless gates must show 0 moves.
- The verdict rules for headless.

## 3. The expected results on bcwin (pre-committed)
- Fixture `sandbox-app` and `sandbox-tests`, 26 mutants, under `bcdev-client` on bcwin.
- With coverage off, each mutant runs Sandbox Tests (2 methods, declared order).
- **Pre-committed:** the per-mutant verdict equals `itest:bcdev`'s frozen table on every mutant whose headless verdict is
  `killed` or `survived`, with the same killing test.
- **The six headless `no-coverage` mutants** (SandboxPricing, never called) are expected `survived` under bcdev-client.
  That is the caveat's exact meaning.
- Any other difference is a BLOCK, until explained and re-committed.
- **The receipt** records, per mutant: the verdict, the killing test, the rows' session ids (all distinct; a session bound
  once), and Activate's Generation equal to the rows' `loadedGeneration`.

## 4. Proof before submit
- **VERIFY.**
- **Red tests both directions** for:
  - every never-mixed refusal;
  - the experimental gate;
  - the version gate;
  - the `/cs` probe refusal;
  - each row check in section 1, item 6 (a row from another session, the wrong generation, a missing row, a page/row
    disagreement);
  - the reproduction replay;
  - the Caveat on every bcdev-client report and on no other.
- **A spec-adversary** on this file before code, hunting false kills and silently-empty passes. An Opus build review, and
  delta reviews.
- **Headless:** 0 moves on bc1-bc3 (the gate set `legs.ts` names for the touched files).
- **The v3 gate.** **CI green.**
- **bcwin:**
  - section 3's table;
  - one forced failure of each kind, each a named failure and never a verdict: a killed sidecar, a stale artifact, the
    page's Run set changed;
  - `--backend bcdev-client` against bc2 refuses `client-session-unavailable` before publishing (under a lease, doctor
    clean before and after).
