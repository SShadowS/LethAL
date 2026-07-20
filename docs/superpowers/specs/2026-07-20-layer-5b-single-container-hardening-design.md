# Layer 5B — Single-Container Runtime Hardening (Design)

> Status: draft for review (v2, post adversarial review). Predecessor: Layer 5A, merged `8d504cd`.
> Successors: 5C (server-side fencing + machine-global lease), 5D (pool qualification + scheduling).
>
> **v2 note.** v1 was REJECTED by adversarial external review (`pi_ask` gpt-5.6-sol) for claiming
> capabilities BC does not expose: a confirmable in-band test cancel, and cross-session-safe
> quarantine without cross-process exclusion. This version drops those claims and delivers the
> honest, containable subset. Full review disposition in §17.

## 1. Goal and honest framing

BC, as bc-dev exposes it today, provides **neither a confirmable in-band cancellation of a running
test nor any cross-process exclusion primitive**. 5B does not invent them. Instead it makes the
single-container path **stop doing harm** when an operation's server-side fate is unknown:

- Client-side operations become **bounded and non-leaking** — we stop waiting deterministically and
  tear down only *local* clients/children. We do **not** claim to cancel the server-side effect.
- On any **post-dispatch ambiguity** (the server may still be executing), the session enters an
  irreversible **unsafe** state: it issues **no further work-plane calls** and records a **durable
  quarantine marker** for the affected service tier.
- **Blind retries are removed.** An operation whose effect may already be committed or in-flight is
  never re-issued.
- Failures are **classified by dispatch/effect state**, not by whether an exception was thrown.

What 5B explicitly does **not** deliver (see §3): confirmable cancellation, concurrent-session
safety, and automatic self-recovery by re-poking the tier. "Cancel when possible, else quarantine"
collapses — with today's APIs — entirely into the quarantine branch. The design says so plainly.

## 2. Position in the 5A→5D split

From the 5A spec §2. Each sub-layer has its own spec/plan/implementation cycle.

| Layer | Delivers |
|---|---|
| 5A (done) | Deployment identity, compile/publish separation, monotonic versioning, compile-only bisection |
| **5B (this)** | Ambiguity containment: bounded non-leaking ops, failure classification by dispatch/effect state, retry removal, durable tier-scoped quarantine with operator-proven clearing |
| 5C | Server-side fencing **and** the machine-global lease that makes concurrent sessions safe; the confirmable-cancellation operation model, if BC can be made to support one |
| 5D | Pool qualification and scheduling |

**Moved to 5C by this design:** confirmable in-band cancellation and the machine-global lease.
Both require capabilities (a BC operation model with a terminal signal; pre-operation cross-process
exclusion) that 5B cannot deliver and must not pretend to.

## 3. Explicit non-goals (do NOT build here)

- **Confirmable in-band test cancellation.** `AbortActivity` (debugger breakpoint-response wire
  value 5) requires a session paused at a breakpoint; a full-speed test is not one, and no NST
  session id for the running test is exposed at the test-runner seam. An accepted debugger command
  is not proof a test ended, a session died, or SQL workers were released. A real cancel needs a
  bc-dev operation model (`startTest → {operationId, nstSessionId, completion}` + a terminal
  server signal) that does not exist. Deferred to 5C, gated on a live capability probe.
- **Cross-session / cross-process safety.** A machine-local store cannot prevent session B from
  reading "not quarantined" *before* session A writes its record. True safety needs an exclusion
  primitive acquired **before the first operation** — 5C's lease. 5B's quarantine is best-effort
  and **not** concurrent-session-safe; the spec states this everywhere it is relevant.
- **Active recovery / auto-clear by re-poking the tier.** Re-attempting work-plane calls against a
  possibly-wedged tier is the death spiral relabeled. Clearing is operator-proven only (§9).
- **Reroute, container pool, scheduling.** 5D.

## 4. The hazard this layer prevents

A publish or test times out host-side but **keeps running inside the BC container**. A naive retry
or fallback then issues a *second* concurrent mutating op against the same NST/SQL Express instance,
exhausting SQL's worker pool and wedging the tier. Observed live on Cronus28: the OData plane (7048)
the work uses was wedged while the dev/liveness endpoint (7049) still answered. 5B's job is to
guarantee LethAL never issues that second operation and never clears quarantine without positive
external evidence the first operation is gone.

## 5. Current behaviour being corrected

- `bcdev-backend.ts` `run()` races the MCP `callTool` against a local timer; on timeout it
  discards the late result and returns `deadline-exceeded`, leaving the server test running (its own
  comment: the next call reports "A test run is already running").
- `orchestrator.ts` `activateWithRetry()` re-issues activation on **any** failure, including after
  an ambiguous timeout, and `runWithRetry()` re-issues a test on **any** `error` outcome — including
  a SignalR close that happened *after* `RunTests` was accepted (a second concurrent test).
- Three existing re-poke sites fire against a tier we may have just stranded:
  1. `runSession`'s `finally` calls `activate(null)` (a mutating `ClearActive`) unconditionally.
  2. Publication failure runs `DeploymentVerifier` (another server op) even when the publish may
     still be active server-side.
  3. `backend.status()` runs at session start **before** any quarantine consultation.
- The `ExecutionBackend` seam returns only a final `TestVerdict` — it erases whether the request was
  ever dispatched, so the orchestrator cannot tell a retry-safe pre-dispatch failure from an
  in-flight-unknown one.
- `MutationControlClient.setActive` throws a local echo-mismatch after a 2xx whose body
  `postOData` may have swallowed — a *possibly-committed* activation misread as a clean failure.

## 6. Architecture

Every change is on the failure / ambiguity path or the seams that carry evidence to it. The healthy
path stays byte-identical: frozen verdicts (bcdev 3/10/3, 23.1%; al-runner 3/13/0, 18.8%) must not
move — a differing verdict is a bug, reported BLOCKED.

| Unit | Home | Responsibility |
|---|---|---|
| `OperationOutcome` states | new `packages/runner/src/operation-outcome.ts` | The dispatch/effect state model (§7). Pure. |
| Failure classes | new `packages/runner/src/failure-classes.ts` | Typed error classes extending `Error` directly; carry an `OperationOutcome`. |
| `SessionSafety` | new `packages/runner/src/session-safety.ts` | The irreversible per-session `unsafe` latch; gates every work-plane call (§8). |
| `QuarantineStore` | new `packages/runner/src/quarantine-store.ts` | Atomic, generation-checked machine-local store keyed by `quarantineResourceKey` (§9). Pure over an injected path. |
| `quarantineResourceKey` | `packages/runner/src/publish-serializer.ts` (or a new `resource-key.ts`) | Tier-scoped resource identity (tenant excluded), distinct from `canonicalContainerKey` (§9). |
| `ReadinessProbe` | new `packages/runner/src/readiness-probe.ts` | Non-mutating both-plane probe, used **only after** externally-proven recycle (§10). |
| Backend seam | `packages/runner/src/backend.ts` + both backends | Surface dispatch/effect evidence per operation (§11). |
| Orchestrator wiring | `packages/runner/src/orchestrator.ts` | Remove blind retries; gate all work-plane calls on `SessionSafety`; consult quarantine before `status()`; on ambiguity latch unsafe + record quarantine + stop (§12). |

al-runner: classification applies; cancellation = kill the local al-runner child; quarantine is a
no-op (no shared server tier to strand).

## 7. Failure classification — by dispatch/effect state

The single "ambiguous vs clean" axis of v1 was unsound: "not still running" is not "safe to retry".
Three independent questions must be answered: **was it dispatched? is it still executing? did it
commit an effect, and is retry idempotent?** The model:

| State | Meaning | Handling |
|---|---|---|
| `pre-dispatch-rejected` | The request provably never reached the server (connection refused before send, argument rejected pre-bind) | **Retry-safe** (the only retryable state) |
| `completed-accepted` | Server returned a terminal, well-formed success | Normal happy path |
| `completed-effect-unknown` | Server-side work has ended, but whether an effect committed is unknown (2xx with malformed/absent body; HTTP 500 after send) | **No retry.** Reconcile by *reading* current state (non-mutating) if possible; else treat as unsafe |
| `in-flight-unknown` | Server may still be executing (client deadline fired; transport dropped after dispatch) | **Latch unsafe → quarantine → stop.** Never retry |
| `cancelled-confirmed` | An exact operation was proven terminated by an external terminal signal | (Not obtainable in 5B; reserved for 5C) |

The five named failures map onto these states:

| Named failure | Typical state(s) |
|---|---|
| `deadline-exceeded` (client timer on a test run) | `in-flight-unknown` |
| `runner-confirmed-timeout` (runner said the test didn't terminate) | `completed-accepted` (server answered) → verdict `timeout-killed` |
| `activation-failure` | `pre-dispatch-rejected` (retry once) **or** `completed-effect-unknown` (echo mismatch after 2xx — no retry, verify active value) **or** `in-flight-unknown` (timeout — quarantine) |
| `publication-failure` | `pre-dispatch-rejected` / clean version-conflict (existing 5A retry) **or** `in-flight-unknown` (hang — quarantine, no verifier re-poke) |
| `transport-failure` | `pre-dispatch-rejected` (idle disconnect, retry) **or** `in-flight-unknown` (dropped mid-op — quarantine) |

Each failure is a typed class extending `Error` **directly** (never each other — the project's
`instanceof`-can't-cross-match rule) and carries its `OperationOutcome`. Classification is by the
carried state, never by message-sniffing. **The state is only trustworthy if the seam preserves it
(§11); a seam that returns a bare verdict forces `in-flight-unknown` (the safe default) whenever the
request was or may have been dispatched.**

This resolves the retry bugs: retries survive **only** for `pre-dispatch-rejected`. Echo-mismatch
after a 2xx is `completed-effect-unknown` → verify the active value, never blind-retry.

## 8. The unsafe-session latch

`SessionSafety` is a per-session one-way latch. The instant any operation resolves to
`in-flight-unknown` (or `completed-effect-unknown` that cannot be reconciled by a non-mutating
read), the session latches **unsafe** and, from that point:

- **No work-plane calls of any kind** — no deploy, activate, test, `DeploymentVerifier`,
  `status()`, readiness probe, or final `ClearActive`. Every call site checks the latch first and
  short-circuits.
- **Only local teardown** runs: abort the local `fetch`, kill the local `altool` child, close +
  clear the MCP stdio child (labelled **non-cancelling cleanup** — it does not stop server work).
- The session **records a durable quarantine marker** (§9) for the tier and exits with a distinct
  **`quarantined`** status naming the stranded op and timestamp.

Fixes the three existing re-poke bugs: the `finally` `activate(null)`, the post-publish-failure
`DeploymentVerifier`, and pre-quarantine `status()` all become latch-gated (§12).

## 9. Quarantine store — narrowed guarantee, atomic writes, tier-scoped key

**Guarantee (honest):** *best-effort durable across non-overlapping processes on one host.* It is
**not** concurrent-session-safe — two overlapping LethAL processes can still race (B reads before A
writes). That race is 5C's lease to close; 5B does not claim otherwise, anywhere.

**Key — `quarantineResourceKey`, distinct from `canonicalContainerKey`:** the death spiral exhausts
the **shared NST/SQL worker pool**, which is tier-wide, not tenant-scoped. The quarantine key
therefore identifies the **service tier** (server + serverInstance) and **excludes tenant** — a
strand under tenant A must block a tenant-B session on the same tier. Server normalization is
strengthened against aliases (host vs IP is not auto-resolvable and is documented as an operator
responsibility; port and trailing-slash are normalized). `canonicalContainerKey` (publish
serialization) keeps tenant and is left unchanged — different resource domain.

**Storage mechanics:** machine-local, per-resource file (default under `~/.lethal/quarantine/`),
written **atomically** (temp file → `fsync` → `rename`) so a crash never leaves a partial record;
clears are **generation/CAS-checked** so a stale clear cannot erase a newer quarantine. "Record
first, before any teardown" is therefore a *durable* write, not best-effort — resolving v1's
internal contradiction. A write that cannot be made durable is itself treated as unsafe (fail the
session loudly rather than proceed unmarked).

## 10. Clearing quarantine — operator-proven only

No automatic re-poke recovery. A quarantined tier clears **only** on positive external evidence:

1. **Operator-confirmed recycle** (default): the operator restarts the tier and clears the marker
   via a CLI command. Simple, always available, always safe.
2. **Externally-read restart identity** (optional enhancement, live-gated): an out-of-process NST
   process identity (e.g. service PID + process start identity from container administration) that
   is proven to (a) stay stable across client/MCP reconnects, (b) change on every relevant tier
   restart, (c) have its change coincide with old-session termination, and (d) be readable while
   the BC work planes are wedged. If any property fails the live probe, this path is **dropped** and
   clearing is operator-confirmed only. A failed identity read **only blocks; it never clears.**

Only **after** clearing does a `ReadinessProbe` run — **non-mutating both-plane reads** (an
`Identity` read on OData 7048 via `DeploymentVerifier`; the cheapest read-only test-runner
handshake). `ClearActive` is **never** a probe (it mutates the stranded table). A readiness pass is
necessary to resume but, by itself, proves nothing about a past strand.

**Startup ordering:** consult `QuarantineStore` for the tier **before** `status()` or any backend
connection. A quarantined-and-unproven tier refuses to run.

## 11. Backend seam changes (preserve dispatch/effect evidence)

The classification in §7 is only as good as the evidence the seam carries. `ExecutionBackend`
operations gain a structured result that distinguishes, at minimum:

- **whether the request was dispatched** (crossed to the server) — the pre-dispatch vs post-dispatch
  boundary that decides retry-safety;
- **whether a terminal server acknowledgement was received** — `completed-accepted` vs
  `completed-effect-unknown` vs `in-flight-unknown`.

Concretely: `run()`, `activate()`, and the publish path return (or throw a typed failure carrying)
an `OperationOutcome`. `bcdev-backend.run()` must stop collapsing all exceptions into
`outcome: "error"`; a post-`RunTests` disconnect is `in-flight-unknown`, a pre-dispatch connect
failure is `pre-dispatch-rejected`. `MutationControlClient` must expose enough to classify a 2xx
malformed-body echo mismatch as `completed-effect-unknown` (and offer a non-mutating "read active
value" to reconcile), not as a retryable rejection. Where the seam genuinely cannot know, it reports
the **safe default `in-flight-unknown`**.

## 12. Orchestrator changes

- Replace `activateWithRetry` and `runWithRetry` with a single classified attempt. Retry **only**
  `pre-dispatch-rejected`. Any `in-flight-unknown` latches unsafe (§8) and stops the session; no
  activation, test, or confirmation is retried past that point.
- The kill-confirmation baseline re-run (`activate(null)` + rerun on a failing test, design.md §6.6)
  is latch-gated: if the mutant run already latched unsafe, no confirmation runs.
- `run()` deadline (`in-flight-unknown`): latch unsafe, record the mutant `error`
  (cause `deadline-exceeded`), record the tier quarantine, exit `quarantined`.
- Session start: quarantine consultation precedes `status()`.
- `finally` teardown: latch-gated — after unsafe, only local teardown, never `activate(null)`.
- al-runner: same classification; local-child kill on ambiguity; quarantine no-op.

## 13. Fold-ins from Layer 5A

1. **Per-mutant equality gate → renamed "healthy-path regression guard."** It proves the *healthy*
   path's per-mutant verdicts are unchanged — necessary, but it gives **zero** evidence for 5B's
   failure-path logic (which never fires on a healthy run). It is **not** "the oracle every task
   checks." Each failure seam gets its own **fault-injection oracle** instead (§14).
2. **Fix `deploy:"none"` app_version** (al-runner records `0.0.0.0`). Self-contained; own task/test.
3. **`compileCheck` cleanup `rm` → `.catch(() => {})`** — cleanup failure must not mask the compile
   result. Trivial.
4. **Document the version-conflict-retry `artifactId` trap** (recompiles under the same id). Written
   note for 5C; include only if 5B's retry-classification work touches that path.

## 14. Testing & verification

- **Fault-injection oracle per failure seam** (the real proof of 5B), each a test that injects the
  fault and asserts the containment, using **stateful fakes** (a fake that keeps reporting the op as
  running until an external terminal signal it never gets, so "call abort then continue" cannot
  pass):
  - client deadline after dispatch → `in-flight-unknown`, unsafe latched, quarantine recorded, no
    further work-plane call;
  - transport close **before** vs **after** dispatch → retry vs quarantine;
  - `SetActive` 2xx malformed body → `completed-effect-unknown` → verify-active, no retry;
  - store write failure → session fails, never proceeds unmarked;
  - concurrent read/write/clear → generation check prevents stale-clear/lost-record (single-process
    ordering; cross-process race is documented as **out of scope**, not tested green);
  - crash between ambiguity and quarantine write → durable marker present on next start;
  - `finally` / `DeploymentVerifier` / `status()` suppressed after unsafe latch.
- **Mutation-test every load-bearing fix**: revert it, confirm the *specific* oracle goes red,
  restore, report both outputs. Reviewers re-run the mutation themselves.
- **Live gates**: (a) a deliberately-wedged-tier reproduction (`bccontainerhelper` restarts tiers on
  the host) proving quarantine + operator-clear end-to-end; (b) if the optional restart-identity
  path is attempted, its four properties probed live or the path is dropped. **No live `AbortActivity`
  probe — that capability is deferred to 5C.**
- **Frozen verdict tables** re-confirmed live after every behavioral-neutral change; differing
  verdict → BLOCKED. Healthy-path regression guard asserts per-mutant equality.
- **The dist trap** every task: `bun run typecheck` separately; `rm -rf packages/*/dist` after
  typecheck, before any reported `bun test`.
- **Constraints**: no `!`; `exactOptionalPropertyTypes`; typed error classes not message-sniffing;
  biome scoped to touched files.

## 15. Exit criteria

- Failure classification is by dispatch/effect state; the seam preserves the evidence; unknown ⇒
  `in-flight-unknown` (safe default).
- Retry survives **only** for `pre-dispatch-rejected`, proven by mutation (reverting re-introduces a
  blind retry and an oracle goes red). This covers `activateWithRetry`, `runWithRetry`, and the
  kill-confirmation re-run.
- On any `in-flight-unknown`, the session latches unsafe, issues no further work-plane call
  (finally / verifier / status all gated), records a **durable** tier-scoped quarantine, and exits
  `quarantined`.
- Quarantine key is tier-scoped (tenant excluded); store writes are atomic and clears CAS-checked;
  the guarantee is documented as best-effort / not concurrent-session-safe.
- Clearing is operator-proven; the optional restart-identity path is either live-proven on all four
  properties or absent; a failed identity read only blocks.
- Readiness probe is non-mutating, both-plane, post-clear only; `ClearActive` is never a probe.
- Fold-ins 1–3 landed (1 renamed + per-seam oracles); fold-in 4 noted if applicable.
- Frozen verdict tables unchanged, re-confirmed live, asserted per-mutant by the regression guard.
- `bun run typecheck` clean; full `bun test` green (count not regressed); biome clean on touched
  files.

## 16. Open items resolved during planning (live-gated)

- The out-of-process restart-identity source and its four properties (§10) — or its removal.
- The cheapest **non-mutating** read-only handshake on each work plane usable as a readiness probe.
- Exact seam shape for surfacing dispatch/terminal-ack evidence from bc-dev's SignalR test run
  (what, if anything, distinguishes "RunTests accepted" from "never dispatched" at the client).

A negative result triggers the documented conservative fallback (operator-confirmed clearing,
`in-flight-unknown` default), never an assumption.

## 17. Adversarial review disposition (v1 → v2)

All findings from the `pi_ask` gpt-5.6-sol review were **accepted**; the two load-bearing ones were
independently reverified against the code before acceptance.

| # | Finding | Resolution in v2 |
|---|---|---|
| C1 | `AbortActivity` neither targetable nor confirmatory | Confirmable cancel removed from 5B; deferred to 5C, live-gated (§3) |
| C2 | Killing the MCP child is cleanup, not cancellation | Labelled non-cancelling local teardown; "weaker confirmed" fallback deleted (§8) |
| C3 | Cross-session quarantine false without exclusion | Guarantee narrowed to best-effort / not-concurrent-safe; real safety deferred to 5C lease (§3, §9) |
| C4 | Container key is the wrong failure domain | New tier-scoped `quarantineResourceKey`, tenant excluded (§9) |
| C5 | Active recovery re-pokes the wedged tier; 3 existing re-poke bugs | Active recovery removed; unsafe latch gates all work-plane calls incl. finally/verifier/status (§8, §12) |
| C6 | Taxonomy conflates "ended" with "retry-safe" | Dispatch/effect state model; retry only pre-dispatch; seam preserves evidence (§7, §11) |
| I7 | Recycle token not viable | Operator-confirmed default; optional restart-identity path only if four properties live-proven, else dropped (§10) |
| I8 | Equality gate irrelevant to failure path | Renamed healthy-path regression guard; per-seam fault-injection oracles added (§13, §14) |

## 18. Evidence appendix (filled during implementation)

- Wedged-tier quarantine + operator-clear reproduction transcript.
- Per-seam fault-injection oracle outputs, each with its revert-goes-red mutation check.
- Healthy-path regression-guard output (per-mutant) for a full bcdev + al-runner run, pre/post-5B.
- (If attempted) restart-identity four-property probe transcript, or the record of its removal.
