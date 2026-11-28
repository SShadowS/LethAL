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

## Amendment 1 (2026-11-28, the spec-adversary's review, before any code)
Evidence: `/coord/handoff/PR-479/adversary-r1.md`. Every fix below is in the TypeScript side or the driver: no control
change, so no 1.0.0.32. These are my calls, from design principles 1 (correct first), 5 (fail closed) and 13.

1. **The op order (fixes F4: the mutant running outside isolation at login and logout; and F10):**
   - open the session; then `ActivateForClient`; then bind through page 91015;
   - the codeunit run;
   - then End; then `DeactivateForClient` (it tombstones on the End mark, with the session still open); then
     `ReadClientAttestation`; then close.
   - Login runs before the op, when the tuple is blank. Logout runs after the tuple is cleared, so its next guard reloads a
     blank tuple.
   - End is sent ONLY after `RunNextTest` answered "All tests executed.". On any other exit, or a passed deadline, the driver
     closes without End, the op stays in flight, and it is `in-flight-unknown` plus quarantine. A red test with the fake
     driver covers it.
2. **A no-mutant confirmation before every kill (F1, B1's "confirmation AND reproduction"):**
   - (a) the killing codeunit's full declared run, in a fresh session, under a no-mutant activation (`mutantId` empty): the
     killer must pass;
   - (b) then the reproduction under the mutant: the killer must fail again.
   - A failing (a) is `confirmation-failed`, an error that STOPS the run (the environment moved), never a kill.
   - Red tests cover each direction, and there is a bcwin forced-drift leg.
3. **Reach evidence for every kill (F3, F9):**
   - a kill is accepted only if, in the killing codeunit's session, some row at or before the killer, in declared order,
     has `Loaded = true`, `loadedMutantId = M`, Activate's generation and `observedActive = true`;
   - otherwise it is `client-kill-unreached`, an error, never a kill.
   - `Loaded = false` supports a survivor only, never a kill.
4. **The WorkDate (F2, R1131):**
   - `HarnessInfo`'s `workDate` is read before and after every codeunit op; a difference from the batch baseline's date is
     `workdate-changed`, as headless.
   - Pre-committed measurement on bcwin before the backend scores: a `/cs` session's WorkDate equals `HarnessInfo`'s (read
     in the session through page 130455's run). If they differ, client mode does not score until the row carries the
     WorkDate (a 1.0.0.32, its own pre-commitment).
5. **The company (F5):**
   - the session is opened in the config's company, using the library's company parameter, confirmed by reflection;
   - before each `RunNextTest`, page 130455's `CurrentCompanyName` is read back and must equal it, or the run is refused.
6. **Completeness against the manifest (F6, F14):**
   - for each codeunit run, the manifest's declared method list is joined BOTH ways with the page results and the rows:
     each declared method has exactly one page result and one row, and no extra codeunit or method appears;
   - the rows' `testMethodRuns` are exactly 1..N in declared order;
   - before the run, the driver reads back the page's Run flags (all `Run = true`);
   - the killer is the FIRST failing method in declared order, by `testMethodRuns`, never row order. "Line no." is dropped
     from the join (the rows do not carry it).
7. **The bound session's id (F7):** taken from a `DeactivateForClient` call made before End, which answers
   `client-session-alive` with the bound id (measured in PR-478 C4). Every row must carry that id. This guards against a
   driver bug: by the writer gate, rows can only come from the bound session.
8. **A lost Activate answer (F8)** is `client-activation-unknown`, a named failure, never a verdict. The op is still cleaned
   up (bind, End, Deactivate, close) when its generation can be read, and otherwise left for recovery.
9. **The baseline (F11):**
   - a killer must be baseline-green;
   - a baseline-red method still runs under every mutant (no method is switched off);
   - a kill whose codeunit has a baseline-red method BEFORE the killer is listed in the report as `kill-after-red-method`
     (a caveat detail), since it does not compare with headless.
10. **The audit (F12)** is built from a grep for the literals `"bcdev"` and `"al-runner-v3"` across `packages/` and
    `scripts/`, not from `BackendKind` uses alone. It includes:
    - `not-run-survivors.ts`, `explain.ts`, `campaign-freeze.ts`, `changed-line-survivors.ts`, `mutation-elements.ts` (the
      caveat goes on each survivor's description);
    - `bc-v3-join.ts`, `gift-card-refreeze.ts`, `r594/compare.ts`.
11. **Lending, coverage mode, and the gate's placement:**
    - lending with no session refuses a bcdev-client run;
    - a bcdev-client run stores coverage mode `none`, which also protects older clients through their coverage-mode checks;
    - the experimental gate sits where the backend is built; its source pin scans `packages/`, `scripts/` and `itest/`.
12. **Per-mutant reach:** each survivor's rows feed GH-24's reach fields (`guardReached` from `observedActive`), so a survivor
    no test reached says so per mutant, beside the run caveat.
13. **Open risks, named in the `client-no-coverage` caveat's detail and in the report (not measured in 479a):**
    - child sessions started by a test (B4);
    - NumberSequence not rolled back;
    - IsolatedStorage, OnBefore writes and a raising subscriber under isolation (B6);
    - a forced reset without a real NST restart leaves a zombie session (control amendment 5);
    - an overrun wedges the server until a restart, ending the run's remaining work.
14. **The bcwin table** (section 3) gains:
    - `sandbox-data` plus `sandbox-data-tests` (several codeunits), against `itest:tables`' frozen table, with the same
      rule: killed and survived equal, no-coverage expected survived, any other difference a BLOCK;
    - forced legs, each a named error and never a verdict:
      - drift after the baseline (a record changed over OData): `confirmation-failed`;
      - a lost Activate answer (an injected drop): `client-activation-unknown`;
      - one method set to `Run = false` behind the driver: a completeness failure;
      - a wrong company: refused;
      - a killed sidecar: `in-flight-unknown`;
    - the planted baseline-red case, from a scratch copy of `sandbox-tests` outside the repo: no kill credited to the red
      test.

## Amendment 2 (2026-11-28, the delta review of amendment 1, and two bcwin measurements)
**Measured.**
- **The WorkDate:** a `/cs` session's WorkDate equals `HarnessInfo`'s (2026-10-01 both; `/coord/handoff/PR-479/wdprobe/`).
  Amendment 1, item 4's gate passes.
- **The company control:** page 130455 has `CurrentCompanyName` on BC 28.4 (the control dump in PR-478's bcwin run). A
  missing control is still a named refusal, never a skipped check.
- **F4's premise** (orchestrator ruling) is measured before the build: after End and Deactivate, a guarded call from a
  page action in the same `/cs` session, and from an `OnCompanyClose` subscriber at its logout, both see no mutant. A
  positive control, the same check before End, must see it active.
  - If either sees the mutant, F4 needs the AL latch as 1.0.0.32, with its own pre-commitment and proof.
  - Evidence: `/coord/handoff/PR-479/f4probe/`.

**Fixes.**
1. **A login-time load (N1).** A `Loaded` row whose generation is OLDER than Activate's is accepted only when it has
   `observedAny = false` and no mismatch. Sound, because `IsActive` refreshes before every decision, so a stale cache
   activated nothing in a method that reached no guard. It never supports a kill.
2. **One op after another (N2):**
   - no Activate starts until the previous session's close has returned;
   - the F4 probe also records whether the `OnCompanyClose` row is already written when the close returns. If it is not,
     the driver waits until it is, or the risk is named in the caveat.
   - Between End and close, the driver sends nothing except on the TypeScript side's go. A fake-driver red test covers it.
3. **Grain-aware reach (N3, and item 12):**
   - for `statement`-grain mutants, item 3 stands (`observedActive`);
   - for `enclosing` and `unplaced` grain (no reach marker), a kill needs a row at or before the killer with `Loaded = M`,
     Activate's generation and `observedAny = true`. Such a kill is labelled `reach-by-any` in the report;
   - `guardReached` is left ABSENT for those grains, never false.
4. **The no-mutant confirmation's own checks (F1 holes):**
   - (a)'s rows pass every item-6 check: (a)'s own generation; `loadedMutantId = ''` wherever Loaded; no mismatch; the
     manifest join; the bound id; the WorkDate and the company;
   - (a)'s pass is judged by row AND page together;
   - EVERY baseline-green method in (a) must pass, not only the killer;
   - (b)'s reproduction must satisfy the reach rule (item 3 as amended) in its own rows;
   - a lost Activate answer in (a) or (b) is `client-activation-unknown`, never a pass.
5. **Empty-true guards (F6):**
   - the page's read-back method lines must EQUAL the declared list (both ways) before `Run = true` is checked, so an empty
     list fails;
   - a codeunit's `OnRun` row, if the runner writes one, is expected, matched by name, and excluded from 1..N. Its absence
     is not a failure. The bcwin run records which it is.
6. **TestPage methods** (for example `Data Tests.PageActionComputesNonZero`) still run, since no method is switched off. As
   headless refuses them, their outcome is never a killer and never counted until 479b. They are listed in the report as
   `client-ran-testpage-unscored`.
7. **Named risks added to item 13:**
   - background sessions, TaskScheduler or a job queue started at login, which can reach a guard during an op;
   - subscribers to Test Runner - Mgt's per-method events in the test app or target, which run outside isolation (shared
     with headless).
