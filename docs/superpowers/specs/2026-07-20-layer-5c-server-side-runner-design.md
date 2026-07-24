# Layer 5C-A — Server-Side Execution Primitive (Design)

> Status: draft for review (v2, post two adversarial passes). Predecessors: 5A (deployment
> identity), 5B (client-side runtime hardening) — merged. This is the **foundation** half of the
> fencing work; the fence, lease, and server-side batch are the **next** layer (5C-B). Pool is 5D.
>
> Shaped by two `pi_ask` gpt-5.6-sol passes during brainstorming: pass 1 rejected an
> "execution-transport-only" framing as a throwaway interface (→ the foundation reshape); pass 2 on
> the written spec caught two Critical holes (an impossible dependency cycle in the artifact guard,
> and a mutant left globally active after a run). Both are fixed here. Full disposition in §14.

## 1. Goal and honest framing

Move the active-mutant control surface **out of the instrumented target** into a stable,
separately-installed **`LethAL Control` extension**, and execute each mutant test through **one
self-contained OData call** (`RunMutant`) in that extension — activate → run exactly one method →
clear — instead of the two-step "OData `SetActive` then bc-dev SignalR hub `RunTests`". This is the
structural foundation the fence needs: a stable control surface a target republish cannot replace,
and a single-call activate+run+clear primitive.

5C-A does **not** add the lease, the fencing token, stale-write rejection, or the server-side batch
loop — those are 5C-B, *additive* on top of `RunMutant`. Success = the **frozen bcdev verdict table
(3 killed / 10 survived / 3 no-coverage, 23.1%)** reproduced through the new path **and** a set of
protocol-invariant probes pass (the frozen table alone is insufficient — §11). bcdev-only; al-runner
untouched; `workers = 1`.

**Single-call, not transactionally atomic across sessions.** `RunMutant` does activate+run+clear in
one call/session, which closes the old `SetActive`-then-`RunTests` window *within one caller*. It
does **not** make two concurrent sessions safe — without the lease (5C-B), another session can still
overwrite the active row or republish the target between calls. 5C-A must not claim otherwise.

## 2. Position in the roadmap

| Layer | Delivers |
|---|---|
| 5A (done) | Deployment identity, compile/publish separation, monotonic versioning |
| 5B (done) | Client-side hardening: dispatch/effect classification, retry removal, durable quarantine |
| **5C-A (this)** | `LethAL Control` extension + self-contained `RunMutant` (activate+run+clear); control surface + target-artifact registry moved server-side; single-session, no fence |
| 5C-B (next) | Server-side fence: machine-global lease (epoch/token) covering **both publication and `RunMutant`**, stale-write rejection (`RunMutant` gains validated `leaseEpoch`/`leaseToken`); server-side batch runner (mutant-plan table, `RunChunk`); cooperative cancel; preemption. **Protocol v2** (reuses an internal `RunMutantCore`; adds token validation without changing activate+run+clear). |
| 5D | Container pool + scheduling |

**5C-A precondition, stated honestly:** 5C-A assumes **no target publication overlaps execution**
(single session). In 5C-B, deploy/register and `RunMutant` acquire the same machine-global lease and
the token is validated immediately before activation, so publication is serialized against execution
— the artifact guard (§5) becomes a fence rather than a detector.

## 3. Explicit non-goals (do NOT build here)

- **The fence / lease / token.** No lease epoch, no holder token, no stale-write rejection, no
  heartbeat/expiry. `RunMutant` **reserves** `leaseEpoch` and `leaseToken` parameters — in 5C-A they
  MUST be empty and are ignored; 5C-B validates them (protocol v2) without changing activate+run+clear.
- **Server-side batch loop.** One method per `RunMutant` call, client-driven per-mutant (as today).
  The mutant-plan table + `RunChunk` loop is 5C-B.
- **Function isolation.** 5C-A uses exactly **Codeunit** isolation, matching the current authoritative
  path (§I1). Function isolation is a separately-gated later change.
- **Moving coverage off the hub.** Coverage discovery stays a one-time, one-method-per-call pass on
  the bc-dev hub (§10). The runner does not collect coverage.
- **al-runner changes.** al-runner keeps its in-app static selector and its execution path unchanged.
- **Concurrent-session safety.** Not delivered by 5C-A — that is 5C-B's fence.

## 4. The `LethAL Control` extension

A standalone AL app in the repo (`extensions/lethal-control/`), built and published to the container
**once** as a container prerequisite — **not** a side effect of target deployment (§I5). Distinct app
id + its **own** object id-range (never CentralGauge's 50500–50599 — copying risks collision).
Depends on Microsoft `Test Runner`.

State and surface it owns:

- **`Mutation Active` (SingleInstance-backed) active state** — the active `(targetAppId, artifactId,
  mutantId)` tuple, moved out of the instrumented target. Held both as a persistent row
  (`DataPerCompany = false`) and a SingleInstance cache the guard reads (§I1). Set/cleared only by
  `RunMutant` (§5) — never persistently active between calls.
- **`InherentPermissions` on the control tables + the state codeunit (`P1` from the live spike).**
  The OData runner session runs under the **calling user**, not an elevated test context. The spike
  proved a guard that reads the control state under a plain user session fails with "the current
  permissions prevented the action" — the current hub-based path only works because bc-dev's session
  grants the app's permissions, masking this. The control extension MUST declare
  `InherentPermissions = X` on its state tables and the state codeunit so the guard's read/write
  succeeds under any web-service session regardless of the user's assigned permission sets. (The
  in-target selector had no such declaration; moving control into the extension is the natural place
  to fix it.)
- **Target-artifact registry** (`DataPerCompany = false` table): `targetAppId → artifactId`. Written
  by the target's install/upgrade via `RegisterArtifact` (§6). This is how `LethAL Control` knows the
  deployed artifact id **without depending on the target** (the dependency runs target→control only —
  §C1).
- **`RegisterArtifact(targetAppId, artifactId)`** — upserts the registry row; called by the target's
  own install/upgrade code.
- **`RunMutant(...)`** (§5).
- **`HarnessInfo() → { appId, semver, protocolVersion, isolationModes, testTypes }`** — read-only,
  verified by the client before any execution (§8).
- **Install + Upgrade codeunits** — register the runner codeunit as a Tenant Web Service, reconciling
  the **actual service-row fields** (service name/type, object id, `Published`); app/protocol version
  is verified separately through `HarnessInfo`, not stored in the service row (§I4/§I6).

The runner is exposed as an **OData V4 unbound action** on a codeunit (consistent with LethAL's
existing `MutationControl_SetActive` usage), not SOAP (deprecated — §M1). **Live-probe (§13):**
confirm an OData action can drive the AL Test Suite framework on the target BC version (CentralGauge
proves SOAP does; OData runs the same procedure). If OData cannot, fall back to a codeunit web
service (SOAP) — the protocol is versioned independently of transport.

## 5. The `RunMutant` protocol

```
RunMutant(
  targetAppId: Text, artifactId: Text, attemptId: Text, mutantId: Text,
  testCodeunitId: Integer, testMethod: Text,
  leaseEpoch: Text /* RESERVED, must be empty in 5C-A */,
  leaseToken: Text /* RESERVED, must be empty in 5C-A */
) -> {
  targetAppId, artifactId, attemptId, mutantId, codeunitId, method,
  outcome /* pass|fail|skip */, message, stackTrace
}
```

The result echoes the full identity tuple (`targetAppId, artifactId, attemptId, mutantId,
codeunitId, method`); the **client rejects any identity mismatch** against what it sent (§I5).

Server-side, in order:

1. **Reserved-param guard.** If `leaseEpoch`/`leaseToken` are non-empty in 5C-A, fail (they belong to
   5C-B).
2. **Artifact guard (detector).** Look up `targetAppId` in the target-artifact registry (§4). If the
   registered `artifactId` ≠ the request's `artifactId`, return a typed `artifact-mismatch` result
   and run nothing — the caller's artifact was replaced. (Without the lease this only *detects* a
   stale caller; 5C-B's fence makes it authoritative — §I3.)
3. **Activate (run-scoped).** Set the active state to `(targetAppId, artifactId, mutantId)` via a
   control SingleInstance setter that updates **both** the SingleInstance cache the guard reads and
   the persistent row, then **`Commit()`** — so the write is durable and visible before the test's
   isolation boundary. (Baseline run: `mutantId` empty → active state cleared/none.)
4. **Select exactly one method.** Build an AL Test Suite whose name comes from a **control-owned
   monotonic sequence** (or a strong `attemptId` hash), within `Code[10]`, with defined
   collision behavior — never the shared `CGWS`, never a raw truncation (§I6/§I7). Add the codeunit's
   methods, set `Run = false` on **every** function line, then `Run = true` on **exactly** the line
   whose name equals `testMethod` via an exact `SetRange` (not an AL filter — `RunAllTests` resets
   input filters).
5. **Run** under **Codeunit** isolation (platform `Test Runner - Isol. Codeunit`, 130450). Do not
   switch isolation (§I1). Because activation + `Commit` happened before the isolation boundary, the
   per-test Codeunit rollback restores to the already-active pre-test state; it does not undo the
   active write.
6. **Clear (run-scoped, every terminal path).** In a `finally`-equivalent that also catches a
   framework/test error via a catchable `Codeunit.Run`/runner boundary: clear the active state (cache
   + row) and `Commit()`. The container is left **unmutated** after every `RunMutant` (§C2). If the
   clear cannot be confirmed, return an `effect-unknown` outcome (client → 5B quarantine). A hung call
   cannot clear — 5B quarantine remains the containment mechanism.
7. **Fail closed.** Zero/many matched methods, or other than exactly one terminal result for the
   requested method → typed `error` (never a plausible pass/fail). Return only the requested method's
   line plus the identity tuple.

`timeout` (runner-confirmed) is **not** produced — bcdev has never had a server-confirmed timeout
signal; a hang is a client deadline (§C2).

## 6. Schemata / emission changes

- The instrumented target's mutant guards call **into the control extension** for the active-mutant
  check (a codeunit procedure the target invokes via its dependency), returning whether `mutantId` is
  active for `(targetAppId, artifactId)`. The guard tuple is `(targetAppId, artifactId, mutantId)`,
  not `mutantId` alone (§C1).
- The instrumented target's `app.json` gains a **dependency** on `LethAL Control`. LethAL publishes
  the control extension (and its symbols into the target's `.alpackages`) **first**, then compiles
  and publishes the target against it.
- The target's generated **install/upgrade** code calls `RegisterArtifact(targetAppId, artifactId)`
  into the control extension (target→control — dependency-legal). **Registration ordering:** the
  artifact must be registered before any `RunMutant` targets it; if registration fails, **target
  publication fails** (§C1).
- The in-target `Mutation Active` table + `SetActive`/`ClearActive`/`Identity` are **removed** from
  target emission. The target keeps only its baked `ArtifactId()` value (used to register, and as the
  `artifactId` the client passes) and the thin guard call.
- **al-runner emission is unchanged** — its `emitStaticSelector` in-app path stays.

## 7. Backend rewiring (bcdev)

- `BcDevMcpBackend.activate(mutantId)` becomes **client-side bookkeeping** — records the intended
  `mutantId` (or baseline), no network call, never throws `ActivationFailure`. All failure
  classification moves to the run call. (al-runner's `activate()` unchanged.)
- **The orchestrator `finally`'s `activate(null)` server-deactivation is no longer needed for bcdev**
  — `RunMutant` self-clears (§5 step 6), so the container is never left mutated. `activate(null)` in
  `finally` remains a safe no-op for bcdev. (5B's latch-gating of `finally` is unaffected.)
- `BcDevMcpBackend.run(ref)` issues one `RunMutant(targetAppId, artifactId, attemptId,
  storedMutantId, ref.codeunitId, ref.method, "", "")` over OData; validates the echoed identity
  tuple (§I5); maps the result to `TestVerdict`.
- **5B dispatch state machine, mandatory (§C2):** the transport classifies exactly like the current
  `run()` — pre-dispatch failure → `pre-dispatch-rejected`; abort/connection-loss/response-read
  failure after dispatch, or an `effect-unknown` clear failure → `deadline-exceeded`/`error` with
  `operation: "in-flight-unknown"`; never retry on the same container; quarantine on ambiguity. A
  generic timeout error omitting `in-flight-unknown` is a forbidden 5B regression.
- `artifact-mismatch` maps to a typed error (never `survived`).
- Coverage discovery stays on the bc-dev hub, **one method per call** (§10).
- Server/instance/tenant/company/auth derived from LethAL config, not a hardcoded URL (§M2); the
  coverage (hub) and execution (`RunMutant`) paths MUST target the same company/tenant.

## 8. Harness provisioning & identity

- Publishing/installing `LethAL Control` is a **container qualification prerequisite**, verified
  before any execution — not folded into target `deploy()` (§I5).
- `HarnessInfo()` is checked first: expected app id, a compatible `protocolVersion`, supported
  `isolationModes`/`testTypes`. A missing/wrong-version/wrong-identity harness **fails the session
  loudly** before execution — never degrades to running against an unverified surface.
- Install/Upgrade reconcile the **actual** `Tenant Web Service` row fields (service name/type, object
  id, `Published`); a conflicting service name pointing at another object **fails loudly**. Version
  compatibility is a `HarnessInfo` check, not a service-row field (§I4/§I6).
- The extension is stable across target republish (separate app; target depends on it).

## 9. TestPage / unsupported test types — qualification-baseline detection

A web-service (OData/SOAP) session cannot open TestPages (§C3), and TestPage usage **cannot be
reliably detected statically** — it can hide behind helper procedures or dependent test libraries,
and discovered test codeunits are all `Subtype = Test` (§I2). So detection is **dynamic**, via the
baseline pass LethAL already runs (design.md §6.4):

- At session start, every discovered test method is run once at baseline through `RunMutant`.
- A test that cannot execute in the web-service session (its TestPage/unsupported class) surfaces as a
  **failure/error at baseline**. Such tests — and any mutant covered **only** by them — are flagged
  **`unsupported`** and excluded from mutation scheduling with a **named session-level error**, never
  silently turned into false survivors or untracked errors.
- `HarnessInfo.testTypes` documents the supported classes. The spec does **not** claim complete static
  preflight; it claims the baseline qualification catches the incompatibility before it can corrupt a
  verdict.

The sandbox fixture is codeunit-only, so it is unaffected; the qualification exists so real projects
fail honestly.

## 10. Coverage handling

- Coverage discovery keeps using the bc-dev hub pass, unchanged, **one method per call** — the mapper
  keys only by `testObjectId` and ignores `testMethodId`, which is correct **only** while one method
  is discovered per call (§I4). 5C-A must not batch methods of one codeunit into a single coverage
  call.
- The `(testCodeunitId, testMethod)` identity used by `RunMutant` must equal the identity the coverage
  map is keyed on, so a mutant marked no-coverage is judged against the same test that would/wouldn't
  run. Unknown/duplicate/missing identities are errors.

## 11. Testing & the gate (frozen table is necessary but not sufficient)

The fixture's two tests are independent and create no DB state, so **all-method execution reproduces
the same per-mutant baseline** — the frozen table cannot alone catch a runner that runs the wrong
test set (§C1/§I8). The gate is the per-mutant frozen table **plus** protocol invariants, proven by
**fixture extensions** and unit/itest probes:

- **Exactly-one-method:** every `run(ref)` results in exactly one method executed server-side.
- **Order-matters probe:** a codeunit with two methods where running both changes the requested
  method's result — proves single-method selection.
- **Run-scoped clear probe:** after a `RunMutant`, the container is unmutated (a baseline read shows
  no active mutant) — proves §5 step 6 (§C2).
- **Artifact-registry probe:** a `RunMutant` with a mismatched `artifactId` returns `artifact-mismatch`
  and runs nothing (§C1).
- **Stale-id alternating probe:** activate A → run a method that fails unless A is observed; activate B
  → immediately run a method that fails unless B is observed; repeated over one keep-alive client
  (§I1/§I3).
- **Skip + fail round-trip:** a skipped test (known message) and a failing test (exact error + stack
  round-trip through the identity-validated result).
- **Hung-test → quarantine:** a hanging test yields `in-flight-unknown` and 5B quarantines (§C2).
- **Unsupported-type qualification:** a TestPage-bearing (or unsupported) suite is flagged
  `unsupported` at baseline and excluded with a named error, before scheduling (§9).
- **Identity-mismatch rejection:** a `RunMutant` result whose echoed tuple differs from the request is
  rejected client-side (§I5).
- **Live gate:** the full bcdev itest reproduces the frozen per-mutant baseline (3/10/3) through
  `RunMutant`; al-runner unchanged (3/13/0). Differing verdict → BLOCKED.
- Mutation-test the load-bearing pieces (exact-method selection, artifact-registry guard, run-scoped
  clear, 5B classification): revert → the specific probe goes red.

## 12. Exit criteria

- `LethAL Control` published + installed + `HarnessInfo`-verified as a prerequisite; stable across
  target republish; install/upgrade reconcile the real web-service row.
- Target-artifact registry written by the target's install/upgrade; target publication fails if
  registration fails; `RunMutant`'s artifact guard reads the registry (no target dependency).
- `RunMutant` activates (cache+row+`Commit`), runs **exactly one** named method (Run-flag selection,
  fail-closed, Codeunit isolation, control-owned suite name), and **clears on every terminal path**
  (`Commit`); the container is unmutated after each call. Reserved lease params rejected if non-empty.
- Result echoes the full identity tuple; client rejects mismatches.
- bcdev `run()` uses `RunMutant`; `activate()` is bookkeeping; the transport implements 5B's dispatch
  state machine (in-flight-unknown → quarantine), proven by the hung-test probe.
- Coverage stays hub-discovered, one method per call, keyed consistently with `RunMutant` identity.
- TestPage/unsupported types flagged `unsupported` at baseline qualification, never false survivors.
- Fixture extended with the protocol-invariant probes; gate = per-mutant frozen table **plus** those
  invariants; live bcdev 3/10/3 and al-runner 3/13/0 reproduced.
- design.md §6.2 corrected to state Codeunit isolation is what is actually enforced (Function later).
- typecheck clean, unit suite green, biome clean on touched files.

## 13. Open items resolved during planning (live-gated)

- Can an OData V4 unbound action drive the AL Test Suite framework on the target BC version? If not →
  codeunit web-service (SOAP) fallback, protocol versioned independently of transport.
- The exact AL Test Suite API for single-method selection + terminal-result extraction (mirror
  CentralGauge's `Test Suite Mgt.`; add per-line `Run` selection).
- Confirm the target's guard-call + `RegisterArtifact` compile and resolve across the app-dependency
  boundary, and that the active write + `Commit` is visible to the Codeunit-isolation test run.
- Confirm the run-scoped clear reaches every terminal path including a framework/test exception (a
  catchable runner boundary), and that a hung run is the only path that cannot clear.
- Confirm Codeunit isolation via the platform runner matches the hub's current isolation for the
  fixture (no silent verdict move).

A negative result on any triggers the documented fallback, never an assumption.

## 14. Adversarial review disposition (gpt-5.6-sol, two passes)

Pass 1 (design) findings C1–C3, I1–I9, M1–M2 and pass 2 (written-spec) findings all accepted.

| # | Finding | Resolution |
|---|---|---|
| P1 C1 | CentralGauge runs a whole codeunit, not one method | Exact-method `RunMutant`, Run-flag selection, fail-closed (§5); order-matters probe (§11) |
| P1 C2 | SOAP deadline can bypass 5B quarantine | Transport implements 5B dispatch state machine; hung-test probe (§7, §11) |
| P1 C3 | Web-service session can't open TestPages | **Qualification-baseline** dynamic detection → `unsupported` + named error (§9) |
| P1 I1 | Isolation change is a silent verdict mover | Codeunit isolation only; design.md §6.2 corrected (§5, §12) |
| P1 I3 | SingleInstance staleness refuted, needs probe | Stale-id alternating probe (§11) |
| P1 I4 | Coverage mapper ignores `testMethodId` | Coverage stays one-method-per-call; identity shared with `RunMutant` (§10) |
| P1 I5/P2 C1 | Harness + **target artifact** identity | `HarnessInfo` prerequisite (§8) **and** control-owned target-artifact registry via `RegisterArtifact` — fixes the impossible target dependency (§4, §5.2, §6) |
| P1 I6/P2 I4 | Install idempotency; version field | Full **service-row** reconcile; version via `HarnessInfo`, not the row (§8) |
| P1 I7/P2 I6 | Shared suite name / collision | Control-owned monotonic suite name, `Code[10]`, defined collision behavior (§5.4) |
| P1 I8 | Frozen table insufficient | Gate = per-mutant table **plus** protocol invariants; fixture extended (§11) |
| P1 I9 | Execution-only split is throwaway | Foundation reshape: control + registry moved server-side; `RunMutant` single-call; 5C-B additive (whole design) |
| P1 M1 | SOAP deprecated | OData action preferred; protocol versioned independently of transport (§4) |
| P1 M2 | Hardcoded URL | Config-derived server/instance/tenant/company; coverage + exec same tenant (§7) |
| **P2 C2** | No-op `activate(null)` leaves mutant active | **Run-scoped `RunMutant`**: activate → run → clear-on-every-terminal-path + `Commit` (§5.6, §7) |
| **P2 I1** | Same-session commit/cache ordering unspecified | SingleInstance setter updates cache + row, `Commit` before the isolation boundary; "single-call" not "atomic across sessions" (§5.3, §1) |
| **P2 I2** | TestPage preflight isn't an algorithm | Reframed to baseline qualification (dynamic), not a static scan (§9) |
| **P2 I3** | Guard is detector-not-fence | 5C-A no-concurrent-publication precondition stated; 5C-B lease covers publication + `RunMutant` (§2) |
| **P2 I5** | `attemptId` echoed but absent from result | Result echoes full identity tuple; client validates (§5) |
| **P2 I6** | 5C-B is a protocol revision | Reserved `leaseEpoch`/`leaseToken` params now; 5C-B = protocol v2 reusing `RunMutantCore` (§2, §3, §5) |

## 15. Evidence appendix

**Task-1 live spike — DONE (2026-07-21, Cronus281). Result: OData path confirmed; one new
requirement surfaced.** A throwaway `LC Spike Runner` extension (own id-range 90000–90009, MS `Test
Runner` dependency) was compiled with `alc` against BC28 symbols and published to Cronus281 via
`altool publishapp` (no version rejection). Its `RunOne(testCodeunitId, testMethod)` codeunit,
registered as a web service, was invoked over **OData V4** at
`http://Cronus281:7048/BC/ODataV4/LCSpikeRunner_RunOne` for fixture test codeunit 79100:
- **OData V4 runs tests headlessly** — the action executed the AL Test Suite framework and returned
  structured per-method JSON. SOAP fallback is **not** needed; `RunMutant` uses OData (§4).
- **Single-method selection works** — with `Run=false` on all lines then `Run=true` on the one
  matching method, `testResults` contained **only** `OverBudgetDetected` (the sibling `ClampPercentRuns`
  absent). Confirms §5's Run-flag selection.
- **Codeunit isolation confirmed** — the stack ran through `Test Runner - Isol. Codeunit (130450)` via
  `Test Suite Mgt (130456).RunAllTests`.
- **New requirement (P1):** the test failed on `"the current permissions prevented the action.
  (TableData 79197 Mutation Active Read)"` — the OData session runs as the calling user without the
  target app's table permissions. Fixed by `InherentPermissions` on the control extension's state
  (§4). The current hub itest masks this via bc-dev's session context.

**Upgrade-trigger probe — DONE (2026-07-22, Cronus281). Result: target self-registration on
republish confirmed.** The Task 8 addendum's registry-read verifier depends on the target's emitted
Upgrade codeunit re-registering its baked `artifactId` on a republish. Whether `OnUpgradePerCompany`
fires on the runner's publish path (`altool publishapp --schemaupdatemode ForceSync`, which uses the
DEV endpoint `POST /BC/dev/apps` — dev/RAD publish historically skips upgrade codeunits) was unknown.
Probed with a throwaway app depending on `LethAL Control` whose Install writes
`RegisterArtifact('upgprobe','installed')` and Upgrade writes `'upgraded'`, read back via a
`RunMutant` oracle (registry match → `status:ran`, mismatch → `status:artifact-mismatch`):
- Publish v1.0.0.0 (fresh install) → registry `'installed'` (`OnInstallAppPerCompany` fired).
- Bump to v1.0.0.1, republish ForceSync → registry `'upgraded'` (**`OnUpgradePerCompany` fired**).
Conclusion: an emitted target Upgrade codeunit re-registers on every republish, provided the app
version increases (the runner's version is clock-monotonic via `reserveAppVersion`, so it always
does). Recorded in `mem:runmutant_odata`.

Remaining to fill (require the full live gate on the republished 5C-A stack):
- Single-method-selection (order-matters) probe transcript.
- Run-scoped-clear probe: container unmutated after `RunMutant`.
- Artifact-registry mismatch probe transcript.
- Per-run attestation: clean `observedAny && !identityMismatch` on covered runs; wrong-binary → `error`.
- Stale-id alternating probe over a keep-alive client.
- Hung-test → `in-flight-unknown` quarantine transcript.
- Full bcdev itest per-mutant baseline (3/10/3) reproduced through `RunMutant`, pre/post; al-runner 3/13/0.
