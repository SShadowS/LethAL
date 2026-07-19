# Layer 5A · Deployment Identity and Compile/Publish Separation — Design

**Date:** 2026-07-19
**Status:** Drafted after two rounds of adversarial review; awaiting user approval
**Supersedes:** the first Layer 5 draft (container pool in one layer), withdrawn — see §2

## 1. Goal

Make deployment an object with an identity: compile once to an **immutable, content-addressed
artifact** carrying an unambiguous id and a monotonic version, publish it as a separate step, and
**verify it actually landed** rather than trusting the publish tool's exit code.

This is the first of four sub-layers that together deliver container-pool parallelism on the
authoritative backend. It is single-container, needs no pool, and is worth building alone: it
fixes two defects already present in shipped code (§7) and produces the artifact identity that
the later fencing work depends on.

## 2. Why the pool was split into four

The first Layer 5 draft bundled the pool, leasing, fencing, cancellation and a versioning change
into one layer. Adversarial review rejected it outright, and the rejection was correct on three
counts that were verified against the code rather than argued:

- **A flat contradiction.** The draft compiled *one* artifact for N containers while baking each
  container's *per-container* lease generation into it. One artifact cannot carry C1's generation
  7 and C2's generation 19. Embed either and the other container can never validate.
- **It was a detector, not a fence.** A fence makes the resource reject stale writes. The draft
  allowed the write and checked afterward. Killing interleaving: A hangs, lease expires, B
  acquires and publishes, B calls `SetActive(MB)`; before B's runner reaches its first guard, A
  wakes and calls its stale `SetActive(MA)`, which lands on B's new artifact carrying nothing to
  reject it by; B's selector caches `MA`, runs mutant A, then asks the container its generation,
  gets B's — correct — and records the result as `MB`'s verdict. The check passes; the verdict is
  wrong.
- **A false premise.** The draft asserted twice that per-worker baseline qualification "already
  exists from Layer 4.2." It does not. `orchestrator.ts` says so in its own comment: baseline and
  coverage discovery run once against `cfg.backend`, and only kill-detection fans out.

The split, in order. Each gets its own spec, plan and implementation cycle:

| Layer | Delivers |
|---|---|
| **5A** (this) | Deployment identity, compile/publish separation, monotonic versioning, compile-only bisection |
| 5B | Single-container runtime hardening: cancellable operations, durable cross-session quarantine, failure classification |
| 5C | Real server-side fencing: a **stable control extension** the target app's publication cannot replace, owning lease epoch, lease token, artifact id and attempt id, rejecting stale writes |
| 5D | Pool qualification and scheduling: canonical container keys, N worker contexts, per-container baseline qualification, dynamic queue with attempt-level CAS finalization |

## 3. Explicit non-goal: concurrent-session safety

5A does **not** make two concurrent LethAL sessions safe. Unique monotonic versions prevent
version collision and stale downgrade; they grant no ownership. Session B can still publish over
session A between A's verification and A's tests. That is 5C's job.

This must not be advertised otherwise. `MutationControl_Identity` proves exactly one thing:

> A fresh Identity request observed code claiming artifact id X at that moment.

It does not prove continued ownership, that the artifact cannot subsequently be replaced, that a
test runner loaded the same code, or that an activation belongs to the caller. The abstraction is
therefore named `DeploymentVerifier` — never `Fence` or `LeaseIdentity`.

## 4. Interfaces

`ExecutionBackend.deploy()` is monolithic (`backend.ts:42-48`), and `BcDevMcpBackend.deploy()`
combines compile, artifact inspection and publish in one call (`bcdev-backend.ts:167-178`).
`PublisherConfig` likewise mixes host/compiler settings with target-container settings
(`publisher.ts:6-20`). Split all three now; 5D would otherwise have to dismantle them again.

```ts
interface CompiledArtifact {
  readonly artifactId: string;   // random, baked into generated AL
  readonly appId: string;
  readonly appVersion: string;   // the reserved version, as compiled
  readonly appPath: string;      // absolute, content-addressed, immutable after creation
  readonly sha256: string;       // SHA-256 of the exact final .app bytes
  readonly mutantManifest: MutantManifest;
  readonly appManifest: Readonly<Record<string, unknown>>;
  readonly coverageMetadata: ArtifactCoverageMetadata;
}

interface ArtifactCompiler   { compile(input: PreparedArtifactProject): Promise<CompiledArtifact>; }
interface ContainerDeployer  { publish(artifact: CompiledArtifact): Promise<PublishCommandResult>; }
interface DeploymentVerifier { verify(expected: CompiledArtifact): Promise<DeploymentVerification>; }
```

`coverageMetadata` is part of the artifact because `deploy()` currently builds the method index
and local-procedure index from the exact artifact and source before publishing
(`bcdev-backend.ts:167-177`, `app-package.ts:126-171`, `app-package.ts:199-242`). Moving
compilation out while leaving coverage indexing dependent on a scratch directory that may since
have been removed would be a silent regression.

### Publication success semantics

| `altool` | Identity | Outcome |
|---|---|---|
| success | matches | deployment accepted |
| success | mismatch or unavailable | indeterminate — run no tests |
| failure | matches | anomalous — abort session, run no tests |
| failure | mismatch | publication failure |

Identity is mandatory *additional* evidence. It never grants permission to ignore a failed
publish. **Every publication or verification error bypasses bisection** (§6).

## 5. Identity: two separate values

**`artifactId`** — 128 cryptographically random bits, 32 lowercase hex characters. Generated
before instrumentation, baked into the generated AL, exposed by `MutationControl_Identity`, never
derived from `runId`, never reused. Generated **per artifact, not per session**: `planArtifacts()`
retains size-based splitting (`orchestrator.ts:107-143`), so a future three-artifact session needs
three ids. Also added to the top-level `MutantManifest`, which currently carries only selector ids
and mutants (`project.ts:39-42`, `project.ts:133-145`).

**`sha256`** — computed after compilation from the exact final `.app` bytes, used for the
content-addressed path, stored in the artifact descriptor and run provenance, re-checked
immediately before publication, and **never embedded in the package**.

The digest cannot be the baked id: embedding it changes the bytes it is derived from. That fixed
point is neither reachable nor needed.

Bisection candidates get their own distinct candidate ids. 5A never publishes them, so reusing the
production id would not currently misattribute anything — distinct ids are cheap and remove a
future trap.

### al-runner interface parity (a trap in this design, caught before implementation)

`emitStaticSelector(cfg: { objectId, activeId })` emits only `Active(MutantId)`
(`selector.ts:81-96`), and `AlRunnerBackend.activate()` overwrites the entire generated selector
with it. If `MutationControl_Identity` called a *selector* procedure, every al-runner activation
would replace the selector with one lacking that procedure and the next compile would fail.

Both emitters therefore take `artifactId` and keep their interfaces in parity. `AlRunnerBackend`
retains the deployed artifact id when copying the batch directory and passes it on every static
selector emission.

## 6. Versioning

### The defect being fixed

`orchestrator.ts:854-855` stamps `1.0.<runId>.<batchIdx>` where `runId` is an autoincrement in the
**project-local** results DB. Deleting `lethal.sqlite` resets it and publishing then fails against
any container still holding a higher version — which happened during Layer 4.3 Task 7. The `1.0`
prefix is also hardcoded, so a project whose own version is `2.x` can never clear its installed
ceiling: every reservation sorts below it, forever.

### Scheme

**`<sourceMajor>.<sourceMinor>.<daysSinceUnixEpoch>.<secondsOfDay ÷ 2>`.**

Major and minor are taken from the project's own `app.json`, never hardcoded — a project
legitimately versioned `2.3.x` must not be forced under a `1.0` ceiling it can never clear. The
last two components are clock-derived and monotonic by construction, with no stored counter, so
there is no state to lose, restore stale, or reset.

Both clock components fit BC's 16-bit fields: days since 1970-01-01 is ~20,650 today and stays
under 65,535 until 2149; seconds-of-day ÷ 2 peaks at 43,200.

**Within-process monotonicity.** The 2-second resolution is coarser than a compile (~1 s), so two
artifacts in one session can derive the same value. The allocator keeps the last value it issued
and returns `max(clockDerived, lastIssued + 1)`, guaranteeing strictly increasing versions
regardless of clock granularity or a clock that steps backwards.

**BC's own rejection is the authoritative check.** On a version conflict BC names the installed
version verbatim:

```
Cannot install the extension LethAL Sandbox App by LethAL 1.0.0.999 because a newer version
1.0.106.0 was already installed.
```

Parse it, re-stamp above the reported version, recompile, retry **once**. A second conflict fails
loudly.

### Why not a live pre-publish query

Review recommended querying installed versions on every reservation and failing closed if
unavailable. **No such query surface exists in this stack**, verified by probe: `altool` has no
listing command (its full command set is compile, workspace, GetPackageManifest,
CreateSymbolPackage, GetLatestSupportedRuntimeVersion, IsSymbolOnly, IsRuntimePackage, the three
launchers, publishapp, runtests, auth); `GET /BC/dev/apps` returns 404; `bcdev_status` returns
only capability flags. The remaining option is `Get-NAVAppInfo` via bccontainerhelper, which puts
a PowerShell dependency on the core publish path — and CentralGauge's `5197b2a` records
bccontainerhelper 6.1.12 silently breaking PSSession init, forcing a hard version pin.

The scheme above satisfies the same requirement by a different route: it is authoritative and
fail-closed, querying lazily through the operation that enforces the ordering. Cost is one
recompile on conflict (~1 s), since the version lives in `app.json`.

Version-component overflow fails loudly rather than wrapping. Version holes from a session dying
after stamping are correct and never reclaimed.

### Fixed version + ForceSync: considered and rejected

Probed live: `altool publishapp --schemaupdatemode ForceSync` **does** overwrite an identical app
id and version — verified by state, not by the tool's report (a clean app published over an
instrumented one at the same version removed `MutationControl` from `$metadata`, and the endpoint
then returned 404).

That capability is precisely the hazard. A stalled publish from session A can land *after* B's and
roll the container back to A's artifact, restoring A's own identity as the witness that says A is
valid. BC's downgrade rejection — also verified live — is a server-enforced ordering guarantee,
and fixed versioning discards it.

Monotonic versioning is therefore retained deliberately. Note this is not in tension with §3:
5A does not *claim* concurrent-session safety, but it must not spend a safety property that 5C
will need. Discarding BC's ordering guarantee now would foreclose the fence later, and the
guarantee costs nothing to keep.

## 7. Two defects in shipped code, fixed here

**`runs.app_version` is wrong for every run ever recorded.** `orchestrator.ts:322` records
`cfg.appVersion ?? "0.0.0.0"` at `createRun`, before the version is derived; the real version is
stamped later at `orchestrator.ts:854-855`. Fix by reserving before `createRun`, or by adding an
explicit post-compile `recordArtifact()`. The run row must additionally store `artifactId`,
`sha256` and `appId` — provenance 5C needs, and ambiguous to retrofit after pooled runs exist.

**Layer 4.3's bisection cannot find a malformed known-survivor.** `orchestrator.ts:422` passes
`subsetMutants: execute`, the post-history-filter set (`orchestrator.ts:395-403`). Known survivors
are still instrumented into the artifact but absent from the search space, so such a mutation
breaks the full compile while being provably unfindable. The existing comment acknowledges a
"no-reproduction case" without identifying this as a cause. Fix: bisect `manifest.mutants` —
history filtering is an execution decision, not a compilation one.

## 8. Compile-only bisection

The compile question is local: *does `alc` compile this source subset?* Publication is not needed
to answer it, and a publish failure must never be attributed to a mutant. Server-only failures —
catalog conflict, schema sync failure, dependency or runtime mismatch, license, signing policy,
transport, NST resource limits — are environmental. Tier 1 mutations do not alter schema or app
metadata, so naming a mutant from repeated production publishes would be unsound.

Order:

1. prepare complete artifact
2. compile complete artifact
3. on compiler failure, bisect the **complete embedded manifest** locally
4. apply history and coverage execution decisions
5. publish
6. verify identity
7. baseline and tests

**Typed errors, not message sniffing.** `Publisher.compile()` collapses compiler rejections and
process-launch failures into generic `Error`s (`publisher.ts:65-88`). The bisection predicate
returns `false` only for a genuine deterministic `AlcCompileError`. Source-preparation I/O
failure, failed spawn, missing output, package-parse failure, hashing failure, manifest
inconsistency and artifact-store write failure all **abort** the search instead of counting as
"this subset does not compile."

Every successful candidate compile gets its own content-addressed output path. The current fixed
`lethal-instrumented.app` output name (`publisher.ts:60-68`) violates the immutable-artifact
contract and goes away.

## 9. Stale-publication probes

Two probes, because "delay A" is ambiguous — if A is delayed only after the server committed it,
the ordering under test never happens, and if A holds a catalog lock, B may simply block behind it.

**Probe A — deterministic stale dispatch.** Reserve and compile A at `V`; pause before invoking
`altool`; reserve and compile B at `V+1`; publish and verify B; then invoke A. Assert A's publish
fails, catalog version stays `V+1`, Identity stays B, and a fresh behaviour probe still observes B.

**Probe B — concurrent race.** Compile A at `V` and B at `V+1`; start both publications
concurrently, repeatedly. Regardless of completion order assert the final catalog version is
`V+1`, Identity is B, A is never final, and no partial install or same-version ambiguity remains.

If either probe lets A become final after B, monotonic versioning is not a sufficient
deployment-order barrier for this toolchain and 5A fails.

## 10. Testing

Phase separation is asserted with **call counters on instrumented fakes, never wall-clock timing**
(CentralGauge's `178644c` fixed exactly that flake).

- **Successful run:** compiler called once, publisher once, verifier once and after the publisher,
  tests start only after verification succeeds.
- **Compiler failure:** publisher and verifier call counts are zero; bisection makes compiler calls
  only; the culprit is named only after singleton-and-complement confirmation; all embedded
  mutants including history-skipped ones are in the search space.
- **Publication failure:** production compiler called once, bisection compiler callback count
  **zero**, baseline/activation/test counts zero, no mutant named as a compile culprit.
- **Identity mismatch:** `altool` may exit zero; the run aborts before baseline, activation and
  tests; bisection count stays zero.
- **Versioning:** clock-derived versions are strictly increasing; a conflict re-stamps above the
  reported version and retries exactly once; a second conflict fails loudly; overflow fails
  loudly; deleting `lethal.sqlite` does not affect version selection.

## 11. Exit criteria

**Artifact invariants,** for every successful production compile: `artifactId` present, valid and
unique; `appId` equals source `app.json`; `appVersion` equals the version in the compiled
`app.json`; `sha256` equals the hash of the exact bytes at `appPath`; `appPath` absolute and
content-addressed; re-hash immediately before publication matches; mutating the file after
compilation makes publication refuse **before** starting `altool`;
`mutantManifest.artifactId` equals the value the generated AL reports; no production compile
writes the old fixed `lethal-instrumented.app` path.

**Per-mutant regression equality** — not aggregate counts, which can match while individual
verdicts are swapped. Compare pre-5A and post-5A results by semantic mutant identity, asserting
equality of verdict, killing test, coverage-filtered status, exact tests executed and their
outcomes, baseline eligibility, and error classification. Assert no mutant missing and no semantic
identity appearing twice. The familiar `killed 3 / survived 10 / no-coverage 3` (23.1%) is derived
from this, and remains a smoke test only.

**Provenance:** `runs.app_version` equals the version actually compiled and installed; stored
`appId`, `artifactId` and digest match the artifact and the container's reported identity; no run
records `0.0.0.0` after deploying something else.

**Live:** publish A then B and confirm catalog, Identity and fresh-runner behaviour track each;
both stale-publication probes (§9) pass; deleting `lethal.sqlite` no longer breaks publishing; a
forced publish failure triggers no bisection and starts no tests.

**Non-bcdev regression:** `itest:alrunner` passes; every `emitStaticSelector()` output preserves
the artifact-identity procedure; repeated al-runner activation does not change the artifact id;
dry-run and the zero-mutant path are unchanged — with no artifact compiled or deployed and,
ideally, no version work performed when there is nothing to deploy (`orchestrator.ts:135-142`).

## 12. Out of scope

Leases and ownership; server-side activation fences; lease tokens, epochs and attempt ids; timeout
cancellation; durable quarantine; pool scheduling; per-container baseline qualification;
container fingerprinting; bccontainerhelper lifecycle; DB snapshots (design.md §6.5); the 3×
flakiness pre-flight; line-level coverage; SaaS/AAD auth.

## 13. Evidence appendix

Probed live against container Cronus281 while drafting, rather than assumed:

- `altool publishapp --schemaupdatemode ForceSync` overwrites an identical app id and version —
  confirmed by state change (`MutationControl` disappeared from `$metadata`; endpoint returned
  404), not by the tool's success report.
- BC rejects downgrades with a machine-parseable message naming the installed version.
- No installed-app query surface: `altool` has no listing command; `GET /BC/dev/apps` → 404;
  `bcdev_status` → capability flags only.
- `publisher.ts:112` does check `res.exitCode !== 0` correctly — an earlier report to the contrary
  was an artifact of a shell pipe in the probe, not a code defect.

Verified in code, having been asserted wrongly at least once during design:

- Per-worker baseline qualification does **not** exist (`orchestrator.ts` comment at the shard
  fan-out).
- `SetActive` ends in `exit(MutantId)` — it echoes the request parameter, not stored state
  (`selector.ts`).
- `MutationSelector` caches on first access; `Mutation Active` is `DataPerCompany = false`, so it
  is server-global and company partitioning provides no isolation.
