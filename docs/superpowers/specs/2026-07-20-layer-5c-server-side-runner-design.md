# Layer 5C-A — Server-Side Execution Primitive (Design)

> Status: draft for review. Predecessors: 5A (deployment identity), 5B (client-side runtime
> hardening) — both merged. This is the **foundation** half of the fencing work; the fence, lease,
> and server-side batch are the **next** layer (5C-B). Pool is after (5D).
>
> This design was shaped by an adversarial external review (`pi_ask` gpt-5.6-sol) taken during
> brainstorming, which rejected an earlier "execution-transport-only" framing as a throwaway
> interface. The reshaped foundation and every accepted finding are recorded in §14.

## 1. Goal and honest framing

Move the active-mutant control surface **out of the instrumented target** into a stable,
separately-installed **`LethAL Control` extension**, and execute each mutant test through **one
atomic OData action** in that extension (`RunMutant`) instead of the two-step "OData `SetActive`
then bc-dev SignalR hub `RunTests`". This is the structural foundation the fence needs: a stable
control surface a target republish cannot replace, and an activate+run primitive that is atomic
server-side.

5C-A does **not** add the lease, the fencing token, stale-write rejection, or the server-side
batch loop — those are 5C-B, and they are purely *additive* on top of `RunMutant`. 5C-A's success
criterion is that the **frozen bcdev verdict table (3 killed / 10 survived / 3 no-coverage,
23.1%)** is reproduced through the new execution path **and** a set of protocol-invariant probes
pass (the frozen table alone is insufficient — §11). bcdev-only; al-runner is untouched;
`workers = 1`.

**Why atomic `RunMutant` and not the old two-step.** Folding activation into the run call removes
the separate `SetActive` OData round-trip that 5B had to classify and that historically stranded a
web-service session (the Cronus28 wedge). All failure classification then lives in **one** call
that already implements 5B's dispatch state machine.

## 2. Position in the roadmap

| Layer | Delivers |
|---|---|
| 5A (done) | Deployment identity, compile/publish separation, monotonic versioning |
| 5B (done) | Client-side hardening: dispatch/effect classification, retry removal, durable quarantine |
| **5C-A (this)** | The `LethAL Control` extension + atomic `RunMutant` execution primitive; control surface moved out of the target; single-session, no fence |
| 5C-B (next) | Server-side fence: lease epoch/token, stale-write rejection, `RunMutant` gains a token check; server-side batch runner (mutant-plan table, `RunChunk`), cooperative cancel, preemption |
| 5D | Container pool + scheduling |

The fence's correctness argument (defeating the killer interleaving) belongs to 5C-B. 5C-A only
builds the surface it will fence.

## 3. Explicit non-goals (do NOT build here)

- **The fence / lease / token.** No lease epoch, no holder token, no stale-write rejection, no
  heartbeat/expiry. `RunMutant` takes an `attemptId` argument (recorded, echoed) but does **not**
  validate a lease in 5C-A — 5C-B adds that validation without changing `RunMutant`'s
  activate+run atomicity.
- **Server-side batch loop.** 5C-A runs one method per `RunMutant` call, client-driven per-mutant
  (as today). The mutant-plan table + `RunChunk` server-side loop is 5C-B.
- **Function isolation.** 5C-A uses exactly **Codeunit** isolation, matching the current
  authoritative path (§I1). Function isolation is a separately-gated later change.
- **Moving coverage off the hub.** Coverage discovery stays a one-time, one-method-per-call pass
  on the bc-dev hub (§10). The runner does not collect coverage.
- **al-runner changes.** al-runner keeps its in-app static selector and its execution path
  unchanged (single-process, non-authoritative, no shared server to fence).
- **Concurrent-session safety.** Two concurrent sessions are **not** made safe by 5C-A — that is
  5C-B's fence. 5C-A must not claim otherwise.

## 4. The `LethAL Control` extension

A standalone AL app in the repo (`fixtures/`-adjacent or a dedicated `extensions/lethal-control/`),
built and published to the container **once** as a container prerequisite, **not** as a side
effect of target deployment (§I5). Distinct app id + a dedicated object id-range (its own, **not**
CentralGauge's 50500–50599 — copying those risks collision, §I5). Depends on Microsoft
`Test Runner`.

It owns:

- **`Mutation Active` table** — moved here from the instrumented target (`DataPerCompany = false`).
  The single active-mutant record lives in the stable extension so a target republish cannot reset
  it (this is what the fence will later protect).
- **`RunMutant` OData action** (§5).
- **`ClearActive(attemptId)`** — clears the active record.
- **`HarnessInfo() → { appId, semver, protocolVersion, isolationModes, testTypes }`** — read-only,
  verified by the client before any execution (§8).
- **Install + Upgrade codeunits** — register the codeunit web service, reconciling the **full** row
  (object id, `Published`, version), not merely checking the service name exists (§I6).

The runner is exposed as an **OData V4 unbound action** on a codeunit, consistent with how LethAL
already invokes `MutationControl_SetActive` — not SOAP. SOAP is deprecated (§M1); OData executes the
same procedure and reuses LethAL's existing OData transport, auth, and `?company`/`?tenant`
handling. **Live-probe (§13):** confirm an OData action can drive the AL Test Suite framework on the
target BC version; CentralGauge proves SOAP can, OData runs the same procedure — if OData cannot,
fall back to a codeunit web service (SOAP) but keep the protocol versioned independently of transport.

## 5. The `RunMutant` protocol

```
RunMutant(artifactId: Text, attemptId: Text, mutantId: Text, testCodeunitId: Integer, testMethod: Text)
  -> { codeunitId, method, outcome, message, stackTrace }
```

Server-side, in order:

1. **Artifact guard.** If the deployed target's baked-in artifact id (5A `MutationControl_Identity`
   / the target's `ArtifactId()`) ≠ `artifactId`, return a typed `artifact-mismatch` result and run
   nothing — the caller's artifact was replaced. (This is the 5A identity check, now enforced at
   run time, and the seam 5C-B's fence tightens.)
2. **Activate.** Set the `Mutation Active` record to `mutantId` (or clear it for a baseline run when
   `mutantId` is empty). Same session as the run — atomic, no separate `SetActive`.
3. **Select exactly one method.** Build an **attempt-scoped** AL Test Suite (name derived from
   `attemptId`, within `Code[10]` — §I7, not the shared `CGWS`). Add the test codeunit's methods,
   set `Run = false` on **every** function line, then `Run = true` on **exactly** the one line whose
   name equals `testMethod` via an exact `SetRange`, never an AL filter expression. **`RunAllTests`
   resets the input record's filters** (`Test Suite Mgt.`), so per-line `Run` flags — not a filter
   — are what select the method.
4. **Run** under **Codeunit** isolation (the platform `Test Runner - Isol. Codeunit`, 130450). Do
   not switch isolation (§I1).
5. **Fail closed.** If zero or more than one method matched, or the suite produced other than
   exactly one terminal result for the requested method, return a typed `error` (never a plausible
   pass/fail). Return **only** the requested method's line: `outcome ∈ {pass, fail, skip}`, its
   `message`, and `stackTrace`.

The result maps to `TestVerdict` client-side. `timeout` (runner-confirmed) is **not** produced —
bcdev has never had a server-confirmed timeout signal (§C2 nuance); a hang is a client deadline.

## 6. Schemata / emission changes

- The instrumented target's mutant-dispatch guards call the **control extension's** active-mutant
  check instead of the in-target `Mutation Selector` reading a local `Mutation Active` table. The
  guard predicate becomes a call into the control extension (a codeunit procedure the target invokes
  via its dependency), returning whether `mutantId` is the active one for the deployed `artifactId`.
- The instrumented target's `app.json` gains a **dependency** on `LethAL Control`. LethAL publishes
  the control extension (and its symbols into the target's `.alpackages`) **first**, then compiles
  and publishes the target against it.
- The in-target `Mutation Active` table + `SetActive`/`ClearActive`/`Identity` control surface are
  **removed** from the target emission (they live in the control extension now). The target keeps
  only its `ArtifactId()` (baked, for the artifact guard) and the thin guard call.
- **al-runner emission is unchanged** — its `emitStaticSelector` in-app path stays. al-runner has no
  control extension and no fence.

The SingleInstance staleness concern (a selector caching a stale active id across calls) was
**refuted** in review: BC web-service sessions are stateless and do not preserve SingleInstance
state across calls (§I3). It is nonetheless pinned by a mandatory alternating-id live probe (§11).

## 7. Backend rewiring (bcdev)

- `BcDevMcpBackend.activate(mutantId)` becomes **client-side bookkeeping** — it records the intended
  `mutantId` (or baseline) and performs no network call. It therefore never throws `ActivationFailure`
  for bcdev; all failure classification moves to the run call. (al-runner's `activate()` is
  unchanged.)
- `BcDevMcpBackend.run(ref)` issues one `RunMutant(artifactId, attemptId, storedMutantId,
  ref.codeunitId, ref.method)` over OData and maps the result to `TestVerdict`.
- **5B dispatch state machine, mandatory (§C2):** the `RunMutant` transport classifies exactly like
  the current `run()` — a pre-dispatch failure (connect/DNS/auth before the request is sent) →
  `pre-dispatch-rejected`; any abort/connection-loss/response-read failure **after** dispatch →
  `deadline-exceeded` / `error` with `operation: "in-flight-unknown"`; never retry on the same
  container; quarantine on ambiguity. A generic timeout error that omits `in-flight-unknown` is a 5B
  regression and is forbidden.
- The `artifact-mismatch` result maps to a typed error (not a verdict); it never counts as
  `survived`.
- **Coverage discovery stays on the bc-dev hub, one method per call** (§10). Only per-mutant
  execution moves to `RunMutant`.

## 8. Harness provisioning & identity

- Publishing/installing the `LethAL Control` extension is a **container qualification prerequisite**,
  run and verified before any mutation execution — not folded into `deploy()` of the target (§I5).
- `HarnessInfo()` is called and checked first: expected app id, a compatible `protocolVersion`, and
  the supported `isolationModes` / `testTypes`. A missing, wrong-version, or wrong-identity harness
  **fails the session loudly** before execution — never degrades to running tests against an
  unverified surface.
- Install/Upgrade reconcile the full `Tenant Web Service` row (object id, `Published`, version), so a
  stale registration from a prior version cannot route the client to the wrong codeunit (§I6).
- The extension is stable across target republish (separate app; the target depends on it, so
  republishing the target never touches it).

## 9. TestPage / unsupported test types

A web-service (OData/SOAP) session cannot open TestPages (§C3). 5C-A therefore:
- Declares supported `testTypes` in `HarnessInfo` (codeunit tests).
- **Preflights** discovered tests: any test that requires a TestPage (or any unsupported class) makes
  the session **fail loudly with a named precondition error** before mutation execution. It must
  **never** silently degrade such a mutant to a false `survived` or an untracked `error`.
- The sandbox fixture is codeunit-only, so it is unaffected; the preflight exists so real projects
  fail honestly rather than silently.

## 10. Coverage handling

- Coverage discovery keeps using the existing bc-dev hub pass, unchanged, **one method per call** —
  the coverage mapper currently keys only by `testObjectId` and ignores `testMethodId`
  (`bcdev-backend.ts`), which is correct **only** while one method is discovered per call (§I4).
  5C-A must not batch multiple methods of one codeunit into a single coverage call.
- The `(testCodeunitId, testMethod)` identity used by `RunMutant` must be the **same** identity the
  coverage map is keyed on, so a mutant marked no-coverage is judged against the same test that would
  or would not run. Unknown/duplicate/missing identities are errors.

## 11. Testing & the gate (frozen table is necessary but not sufficient)

The sandbox fixture's two tests are independent and create no DB state, so **all-method execution
reproduces the same per-mutant baseline** — the frozen table cannot, by itself, catch a runner that
runs the wrong test set (§C1, §I8). The gate is the per-mutant frozen table **plus** protocol
invariants, proven by **fixture extensions** and unit/itest probes:

- **Exactly-one-method:** every backend `run(ref)` results in exactly one method executed
  server-side (assert against a runner that reports which methods ran).
- **Order-matters probe:** a test codeunit with two methods where running both changes the requested
  method's result — proves single-method selection (fails if the runner runs the whole codeunit).
- **Stale-id alternating probe:** activate A → run a method that fails unless A is observed; activate
  B → immediately run a method that fails unless B is observed; repeated over one keep-alive client —
  pins the SingleInstance/session-reuse invariant (§I3).
- **Skip + fail round-trip:** a skipped test with a known message, and a failing test whose exact
  error + stack must round-trip through the result mapping.
- **Hung-test → quarantine:** a test that hangs proves the transport yields `in-flight-unknown` and
  5B quarantines (no silent bypass, §C2).
- **Unsupported-type preflight:** a TestPage-bearing (or otherwise unsupported) suite fails loudly
  before execution (§C3).
- **Live gate:** the full bcdev itest reproduces the frozen per-mutant baseline (3/10/3) through
  `RunMutant`; al-runner unchanged (3/13/0). A differing verdict → BLOCKED.
- Mutation-test the load-bearing pieces (exact-method selection, the artifact guard, the 5B
  classification on the new transport): revert → the specific probe goes red.

## 12. Exit criteria

- `LethAL Control` extension published + installed + `HarnessInfo`-verified as a prerequisite; stable
  across target republish; install/upgrade reconcile the full web-service row.
- `RunMutant` selects and runs **exactly one** named method (Run-flag selection, fail-closed), under
  Codeunit isolation, with the artifact guard, attempt-scoped suite name.
- bcdev `run()` uses `RunMutant`; `activate()` is client-side bookkeeping; the transport implements
  5B's dispatch state machine (in-flight-unknown → quarantine), proven by the hung-test probe.
- Coverage stays hub-discovered, one method per call, keyed consistently with `RunMutant` identity.
- TestPage/unsupported types fail loudly at preflight, never as false survivors.
- The fixture is extended with the protocol-invariant probes; the gate is the per-mutant frozen
  table **plus** those invariants; live bcdev 3/10/3 and al-runner 3/13/0 reproduced.
- design.md §6.2 corrected to state Codeunit isolation is what is actually enforced (Function is
  aspirational / later).
- typecheck clean, full unit suite green, biome clean on touched files.

## 13. Open items resolved during planning (live-gated)

- **Can an OData V4 unbound action drive the AL Test Suite framework** (run tests) on the target BC
  version? (CentralGauge proves SOAP; OData runs the same procedure.) If not → codeunit web service
  (SOAP) fallback, protocol versioned independently of transport.
- The exact AL Test Suite API for single-method selection + terminal-result extraction (mirror
  CentralGauge's `Test Suite Mgt.` usage; add per-line `Run` selection).
- Confirm the target's guard-call-into-the-control-extension compiles + resolves the dependency, and
  that the artifact guard reads correctly across the app boundary.
- Confirm Codeunit isolation via the platform runner behaves identically to the hub's current
  isolation for the fixture (no silent verdict move).

A negative result on any triggers the documented fallback, never an assumption.

## 14. Adversarial review disposition (gpt-5.6-sol)

All findings accepted; the reshape (I9 → foundation) was adopted.

| # | Finding | Resolution |
|---|---|---|
| C1 | CentralGauge runs a whole codeunit, not one method; fixture blind | Exact-method `RunMutant` protocol, Run-flag selection, fail-closed (§5); fixture extended with order-matters probe (§11) |
| C2 | SOAP deadline can bypass 5B quarantine | Transport implements 5B dispatch state machine; hung-test→quarantine probe mandatory (§7, §11) |
| C3 | Web-service session can't open TestPages | Unsupported-type preflight fails loudly; declared in `HarnessInfo` (§9) |
| I1 | Isolation change is a silent verdict mover | Codeunit isolation only in 5C-A; Function deferred; design.md §6.2 corrected (§5, §12) |
| I2 | Activation visibility holds (SetActive commits) | Confirmed; folded into atomic `RunMutant` (§5, §7) |
| I3 | SingleInstance staleness refuted but needs a probe | Stale-id alternating live probe mandatory (§11) |
| I4 | Coverage keying ignores `testMethodId` | Coverage stays one-method-per-call; identity shared with `RunMutant` (§10) |
| I5 | Harness lifecycle/identity undefined | `HarnessInfo` verified as a prerequisite; own id-range; not a deploy side effect (§8) |
| I6 | Install idempotency superficial | Full-row reconcile on install/upgrade (§8) |
| I7 | Fixed suite name is shared mutable state | Attempt-scoped suite name within `Code[10]` (§5) |
| I8 | Frozen table insufficient as gate | Gate = per-mutant table **plus** protocol invariants; fixture extended (§11) |
| I9 | Execution-only split is a throwaway interface | Reshaped to the foundation: control moved into the extension, atomic `RunMutant`; 5C-B additive (whole design) |
| M1 | SOAP deprecated | OData V4 action preferred; protocol versioned independently of transport (§4) |
| M2 | Don't copy CentralGauge's hardcoded URL | Derive server/instance/tenant/company from LethAL config (§7) |

## 15. Evidence appendix (filled during implementation)

- OData-action-runs-tests live-probe transcript (or the SOAP fallback record).
- `RunMutant` single-method-selection probe (order-matters fixture) transcript.
- Stale-id alternating probe transcript over a keep-alive client.
- Hung-test → `in-flight-unknown` quarantine transcript.
- Full bcdev itest per-mutant baseline (3/10/3) reproduced through `RunMutant`, pre/post.
