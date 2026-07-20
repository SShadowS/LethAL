# Layer 5B — Single-Container Runtime Hardening (Design)

> Status: draft for review. Predecessor: Layer 5A (deployment identity), merged `8d504cd`.
> Successors: 5C (server-side fencing), 5D (pool qualification + scheduling).

## 1. Goal

Make LethAL's single-container execution path **honest about server-side operations it cannot
see complete**. Today a client-side timeout abandons an in-flight Business Central operation
without cancelling it, and an ambiguous activation timeout is blindly retried. Across thousands of
mutants this strands server sessions until the OData/web-service plane saturates and the container
wedges — the "SQL death spiral" documented in `U:/Git/CentralGauge` and hit live on Cronus28
(OData 7048 unresponsive while dev 7049 still reported healthy).

5B delivers, still at `workers = 1`, one container:

1. **Externally cancellable backend operations** — a real, confirmable in-band abort, not a
   client-side `Promise.race` that discards the late result.
2. **Kill the MCP child and quarantine the container when cancellation cannot be confirmed.**
3. **Durable, cross-session quarantine** — a machine-local store; a container that stranded an
   operation stays quarantined until positive evidence (the op is confirmed gone, or the tier was
   recycled), never merely because a new run started.
4. **Distinct failure classification** — deadline-exceeded (client timer) vs runner-confirmed
   timeout vs transport failure vs activation failure vs publication failure.
5. **Remove the unconditional activation retry after an ambiguous timeout.**

## 2. Position in the 5A→5D split

From the 5A spec §2. Each sub-layer has its own spec/plan/implementation cycle.

| Layer | Delivers |
|---|---|
| 5A (done) | Deployment identity, compile/publish separation, monotonic versioning, compile-only bisection |
| **5B (this)** | Single-container runtime hardening: cancellable operations, durable cross-session quarantine, failure classification |
| 5C | Real server-side fencing: a stable control extension the target app's publication cannot replace, owning lease epoch / lease token / artifact id / attempt id, rejecting stale writes |
| 5D | Pool qualification and scheduling: canonical container keys, N worker contexts, per-container baseline qualification, dynamic queue with attempt-level CAS finalization |

## 3. Explicit non-goals (do NOT build here)

- **Server-side fencing.** No control extension, lease epoch, lease token, or stale-write
  rejection. Quarantine is a **client-side honesty mechanism**; it does not make two concurrent
  LethAL sessions safe on one container. The in-process publish serializer shipped in 5A does not
  make them safe either. That is 5C.
- **Reroute.** With one container, quarantine means *refuse and block*, not move work elsewhere.
  Rerouting to another container is 5D.
- **The container pool and scheduling.** 5D.
- **Inventing BC capabilities.** The bc-dev cancel primitive is scoped to what BC actually
  exposes (`AbortActivity`, session termination), verified live. If a mechanism does not work
  against the real server, the design degrades conservatively rather than assuming it.

## 4. The hazard this layer prevents

A publish or test times out on the host side but **keeps running inside the BC container**. A
naive retry or fallback then issues a *second* concurrent mutating operation against the same
NST/SQL Express instance, exhausting SQL's worker pool and wedging the container. Prior art's fix
was architectural: on a confirmed timeout, never fall back and never retry on the same container —
quarantine it. We reproduced the class live on Cronus28: the OData plane (7048) the work uses was
wedged while the liveness/dev endpoint (7049) still answered. **Health must probe the plane the
work uses, not a liveness endpoint.**

## 5. Current behaviour (what we are replacing)

- `packages/runner/src/bcdev-backend.ts` `run()` races the MCP `callTool` against a local timer
  (`Promise.race`); on timeout it calls `call.catch(() => {})` — "late result deliberately
  discarded" — and returns `deadline-exceeded`. The server-side test keeps running. Its own
  comment records the downstream symptom: the next call fails with "A test run is already
  running", and each abandoned run strands a server session.
- `packages/runner/src/orchestrator.ts` `activateWithRetry()` catches **any** activation failure
  and re-issues `backend.activate(mutantId)` unconditionally — including after an ambiguous
  timeout, when the first activation may still be executing server-side.
- BC tests run over a **SignalR `TestRunnerHub`** to the dev endpoint
  (`U:/Git/bc-dev-mcp/src/core/hubs/test-runner-hub.ts`); there is no cancel invoke — the only
  "stop" is `hub.stop()` (drop the connection). Activation (`SetActive`/`ClearActive`) is a
  separate OData 7048 web-service call.
- `deadline-exceeded` → verdict `error` (excluded from score) already exists; runner-confirmed
  `timeout` → `timeout-killed` (counts as kill) already exists for al-runner. bc-dev has no
  server-confirmed test-timeout signal and must not fabricate one.

## 6. Architecture

Every change is on the **failure / ambiguity path**. The healthy path stays byte-identical: the
frozen verdict tables (bcdev 3 killed / 10 survived / 3 no-coverage, 23.1%; al-runner 3 / 13 / 0,
18.8%) must not move. A differing verdict is a bug in the change, reported BLOCKED — never an
expectation to update.

New / changed units, each single-purpose and independently testable:

| Unit | Home | Responsibility |
|---|---|---|
| Failure taxonomy | new `packages/runner/src/failure-classes.ts` | Typed classes for the five distinct failures. Pure, no I/O. |
| `ContainerCanceller` | new `packages/runner/src/cancellation.ts` | Drive the in-band abort of a stranded op; return `confirmed \| unconfirmed` with evidence. |
| bc-dev cancel primitive | `U:/Git/bc-dev-mcp` (new MCP tool + hub method) | Attach to the test's NST session, issue `AbortActivity`, report result. Own spec-let + live probe. |
| `QuarantineStore` | new `packages/runner/src/quarantine-store.ts` | Machine-local persistence keyed by `canonicalContainerKey`. Read / write / clear over an injected path. Pure. |
| `HealthProbe` | new `packages/runner/src/health-probe.ts` | Confirm both work planes (OData 7048 + test-runner hub) round-trip. Not a liveness endpoint. |
| Backend interface | `packages/runner/src/backend.ts` | Add a cancellation capability; bcdev implements real abort, al-runner implements local-child kill. |
| Orchestrator wiring | `packages/runner/src/orchestrator.ts` | Replace `activateWithRetry`; on ambiguous timeout invoke canceller → quarantine-or-continue; consult store at session start (active recovery). |

## 7. Failure classification taxonomy

Five outcomes, discriminated by the single load-bearing question: **may server-side work still be
running?** ("ambiguous") vs **did the server acknowledge the outcome?** ("clean"). Only *ambiguous*
outcomes ever quarantine.

| Class | Trigger | Server op stranded? | Verdict / handling |
|---|---|---|---|
| `deadline-exceeded` | Client timer fired on a **test run**, no server confirmation | Ambiguous → cancel → quarantine if unconfirmed | verdict `error`, excluded from score (exists; keep) |
| `runner-confirmed-timeout` | The runner itself reported the test did not terminate | No (server answered) | verdict `timeout-killed`, counts as kill (exists for al-runner; bc-dev has no such signal — stays honest) |
| `activation-failure` | `SetActive` / `ClearActive` failed | Clean reject = no; **timeout = ambiguous** | Clean: one retry permitted. Timeout: cancel → quarantine, **no blind retry** |
| `publication-failure` | `altool publishapp` failed or hung | Clean conflict = no; **hang = ambiguous** | Clean (version conflict): existing 5A retry. Hang: kill altool child + `DeploymentVerifier` re-check → quarantine if unconfirmed |
| `transport-failure` | MCP child died / SignalR closed / connection refused | Only if it dropped **mid mutating-op** | Clean idle disconnect: reconnect + retry safe. Mid-op: treat as ambiguous → cancel → quarantine |

Each is a typed class extending `Error` **directly** — never each other, so `instanceof` cannot
cross-match (the project's existing `AlcCompileError` / `ArtifactPrepareError` / `DeploymentError`
separation rule). Classification is by type, never by message-sniffing.

This taxonomy resolves the `activateWithRetry` defect: the retry survives **only** for a *clean*
activation failure (server responded with a rejection, nothing stranded). An *ambiguous* activation
timeout no longer retries.

## 8. Cancellation protocol

When an **ambiguous** outcome occurs, `ContainerCanceller` runs a fixed, evidence-producing
sequence:

1. **Record the stranded op first**, before any abort attempt: write a quarantine record
   (`canonicalContainerKey`, op kind, artifact id + attempt context, NST session id if known, a
   recycle-token snapshot per §9, timestamps). A crash mid-abort must leave the container marked,
   never silently "recovered".
2. **In-band abort** via the bc-dev primitive:
   - **Test run:** bc-dev attaches its debugger hub to the NST session executing the test and
     issues `AbortActivity` (continue-action 5, present in `debugger-hub.ts`). The session id comes
     from the test-runner hub context; if bc-dev cannot resolve it, this step returns `unresolved`.
   - **Activation strand:** abort via session termination on the dev plane (candidate mechanism —
     verified in the bc-dev spec-let). If none works, `unconfirmed`.
3. **Kill + respawn the MCP child** regardless — close the stdio transport (terminates the spawned
   bc-dev process, dropping its SignalR + OData sessions) and clear the memoized client, forcing a
   clean reconnect. Bounds client-side leakage.
4. **Health-probe** the work planes (§10).
5. **Verdict:** `confirmed` **only if** the abort primitive *positively acked* the op ended
   **and** the health-probe passes. Anything else → `unconfirmed` → the container stays
   quarantined.

**Honesty rule.** `confirmed` requires a *positive server signal*, never the mere absence of an
error nor a passing health probe alone. A wedged tier can answer a health ping while a stranded
test still holds SQL workers — precisely the Cronus28 / SQL-death-spiral trap.

The bc-dev cancel primitive is a **prerequisite deliverable with its own live-probe gate**. We do
not yet know whether `AbortActivity` on a test session actually stops the run in BC. The plan
probes this live; if it fails, the design falls back to "kill+respawn + health-probe only" — a
weaker `confirmed` that in practice quarantines more aggressively. Reported honestly, never
assumed.

## 9. Quarantine store and active-recovery model

**Store.** Machine-local JSON at a per-user path (default `~/.lethal/quarantine.json`; overridable
for tests via an injected path), keyed by `canonicalContainerKey` (the 5A identity in
`publish-serializer.ts`, designed for reuse). Machine-local — not `lethal.sqlite` — so quarantine
survives `rm lethal.sqlite` and spans projects/sessions on the same host. Reads and writes are
best-effort read-modify-write; true cross-process file locking is out of scope (5C's machine-global
lease). The module is pure over its injected path — testable without touching the real home dir.

**Recycle token.** A value that changes iff the BC tier restarted, so "recycled" can be *proven*.
Candidate source: NST start-time / session-epoch from the dev plane (`bcdev_status` or equivalent).
It must be cheap and monotonic across a restart. Exact source is a spec-let with a live probe; if
no reliable token exists, "recycled" evidence degrades to operator-confirmed and recovery leans on
the confirmed-terminated path instead.

**Active-recovery flow (session start).** Before using a container, consult the store:

- **Not quarantined** → proceed normally.
- **Quarantined** → run `ContainerCanceller` recovery: re-attempt the in-band abort against the
  recorded session, health-probe, read the current recycle token.
  - **Clear iff** the abort positively confirms the op is gone **OR** the recycle token differs
    from the stored one (tier restarted → stranded op provably dead).
  - **Otherwise** → refuse to run against this container and exit with a distinct **`quarantined`
    status** naming the stored op and timestamp. A clear, actionable blocked state — not a crash.

Clearing on "a new run started" alone is structurally impossible: clearing requires a positive
abort ack or a changed recycle token.

## 10. Health-probe definition

The Cronus28 lesson is load-bearing: **probe the plane the work uses, not a liveness endpoint.**
7049 (dev) reported healthy while 7048 (OData) was wedged. `HealthProbe` checks **both** work
planes the mutation loop drives:

1. **OData 7048** — a real `MutationControl_*` round-trip (a `ClearActive`, or an `Identity` read
   via the existing `DeploymentVerifier`) under a short timeout. The plane activation uses and the
   one that wedged.
2. **Test-runner hub** — a minimal test-runner connect/initialize (or the cheapest hub handshake
   bc-dev exposes), confirming the SignalR test plane answers.

A probe **passes only if both planes round-trip within timeout.** A pass is necessary but not
sufficient for `confirmed` (§8 honesty rule): it can clear a *health* concern but never, alone,
prove a specific stranded op terminated.

## 11. Orchestrator changes

- Replace `activateWithRetry(backend, id)` with a classified single attempt. On failure, classify
  (§7): clean activation failure → one retry; ambiguous activation timeout → `ContainerCanceller`
  → quarantine-or-continue, no blind retry.
- `run()` deadline path: on `deadline-exceeded`, invoke `ContainerCanceller`; if `unconfirmed`,
  quarantine and stop the session with `quarantined` status; if `confirmed`, record the mutant as
  `error` (cause `deadline-exceeded`, as today) and continue.
- Session start: consult `QuarantineStore` and run active recovery (§9) before the first backend
  operation.
- al-runner: classification applies; cancellation = kill the local al-runner child; quarantine is
  a no-op (no shared server to strand).

## 12. Fold-ins from Layer 5A

1. **Wire the per-mutant equality gate as 5B's regression oracle.**
   `normalizeForComparison` / `diffMutants` (`packages/runner/itest/mutant-equality.ts`) currently
   has no live consumer. Wire it into the bcdev + al-runner itests so a full run is asserted
   verdict-identical **per mutant** (verdict, killing test, coverage-filtered set, tests-run +
   outcomes, baseline eligibility, error class) against a stored baseline — not just aggregate
   3/10/3. This becomes the oracle every 5B task checks the healthy path against.
2. **Fix `deploy:"none"` app_version.** al-runner runs record `runs.app_version = 0.0.0.0`; the 5A
   fix covered only publishing runs. Self-contained; own task + test.
3. **`compileCheck` cleanup `rm` → swallow.** Post-compile `rm` throws a raw fs error; change to
   `.catch(() => {})` — a cleanup failure must not mask the compile result. Trivial.
4. **Document the version-conflict-retry `artifactId` trap.** No code change — a written note where
   the retry recompiles under the same `artifactId` (two byte-streams, one id), flagged for 5C.
   Include only if 5B's cancellation/retry work touches that path.

## 13. Testing & verification

- **Mutation-test every load-bearing fix.** For each guarantee — no-retry-after-ambiguous-timeout,
  quarantine-blocks-next-session, clear-only-on-evidence, confirmed-requires-positive-ack — revert
  the fix and confirm the *specific* test goes red; restore. Report both outputs. Reviewers re-run
  the mutation themselves, not trust the report.
- **Stateful fakes.** The bc-dev backend / canceller fakes keep "reporting the op as running" until
  an abort is *actually* acked, so a test that merely calls abort-then-continues cannot pass. A
  fake asserting its own hardcoded sequence proves nothing.
- **Live execution is the authority.** Two live gates: (a) the bc-dev `AbortActivity` probe — does
  aborting a real stuck test actually free the container; (b) a deliberately-wedged-tier
  reproduction (`bccontainerhelper` restarts tiers on the host) proving quarantine + recovery
  end-to-end. Frozen verdict tables re-confirmed after every behavioral-neutral change; a differing
  verdict → BLOCKED.
- **The dist trap** every task: `bun run typecheck` separately; `rm -rf packages/*/dist` after
  typecheck, before any reported `bun test`.
- **Constraints:** no `!` (biome `noNonNullAssertion: error`); `exactOptionalPropertyTypes`
  (`...(v !== undefined ? { k: v } : {})`); typed error classes, not message-sniffing; biome
  scoped to touched files.
- **Adversarial external spec review** (`pi_ask` gpt-5.6-sol, thinking high) before the user's spec
  review — every prior layer had a class-level flaw only an outside model caught.

## 14. Exit criteria

- All five failure classes are distinct typed outcomes; classification is by type, not message.
- No retry after an ambiguous activation timeout (proven by mutation: reverting re-introduces the
  retry and a test goes red).
- A container that strands an op is quarantined durably; a fresh session refuses it until positive
  evidence clears it (proven with an injected store + a live wedged-tier reproduction).
- The in-band abort's real behaviour against BC is documented from a live probe (works, or the
  conservative fallback is in place).
- Both work planes are health-probed; a pass never alone yields `confirmed`.
- Fold-ins 1–3 landed; fold-in 4 noted if applicable.
- Frozen verdict tables unchanged, re-confirmed live, asserted at per-mutant granularity by the
  wired equality gate.
- `bun run typecheck` clean, full `bun test` green (count not regressed), biome clean on touched
  files.

## 15. Open items resolved during planning (live probes)

- Whether `AbortActivity` on a test-runner NST session actually stops the run in BC.
- The session-termination mechanism (if any) for an OData activation strand.
- A reliable, cheap recycle token that changes across a tier restart.
- The cheapest test-runner-hub handshake usable as a health probe.

Each is a plan task with a live-probe deliverable; a negative result triggers the documented
conservative fallback, not an assumption.

## 16. Evidence appendix (to be filled during implementation)

- bc-dev `AbortActivity` live-probe transcript.
- Wedged-tier quarantine + recovery reproduction transcript.
- Per-mutant equality-gate output for a full bcdev + al-runner run, pre- and post-5B.
