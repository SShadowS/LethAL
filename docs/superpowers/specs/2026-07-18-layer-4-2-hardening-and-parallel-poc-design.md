# Layer 4.2 · Execution Hardening + Parallel POC on the In-Memory Backend — Design

**Date:** 2026-07-18
**Status:** Drafted after adversarial review; awaiting user approval
**Supersedes scope of:** the first Layer 5 sketch (container pool), which is deferred — see §7

## 1. Goal

Two things, in one coherent deliverable:

1. **Make verdicts honest.** Layer 4 currently reports a mutant as `timeout-killed` when *our own client deadline* fires, which is not evidence about the mutant. Fix the timeout taxonomy and artifact identity.
2. **Prove parallel mutation testing** end-to-end on the `al-runner` backend, where parallelism needs no coordination at all — no containers, leases, publishing, or version negotiation.

The output is a working parallel mutation-testing loop with trustworthy verdicts, and a scheduler proven in practice before it is applied to containers, where the expensive failure modes live.

## 2. Why this order (evidence, not intuition)

The original Layer 5 plan was container-pool-first. Adversarial review plus measurement changed it. Everything below was measured this session, not assumed.

| Measurement | Value | Source |
|---|---|---|
| bcdev per-test invocation | **59–114 ms** | `lethal.sqlite` runs 8–13 |
| al-runner per-test invocation (one-shot CLI) | **6,943 ms** | run 11 |
| bcdev session wall-clock that is compile+publish | **76–84%** | runs 8–13 |
| `alc` compile (host CPU, 2-file fixture) | ~1.0 s | direct timing |
| `altool publishapp` round trip | ~1.4 s | direct timing |
| al-runner server mode, cold | 4,831 ms | probe |
| al-runner server mode, cached source state | **1–4 ms** | probe |
| al-runner server mode, after selector rewrite | 3,902 ms | probe |
| Fixture batch count | 3, from 16 mutants | `--dry-run` |

Two structural facts follow:

- **Batch count is bounded by maximum overlap depth at a single site (~3), not by mutant count.** A real project with thousands of mutants still yields ~3 batches. So publish cost is near-constant while test cost scales — at real scale, test execution dominates and parallelism is the right destination. The fixture's 80%-publish profile is an artifact of having only 16 mutants and must not be generalised.
- **al-runner needs zero coordination to parallelise** (N independent processes; 32 cores available), whereas the container path needs leases, fencing, publish ordering, and cancellation. Proving the scheduler on the cheap substrate first is strictly lower risk.

## 3. Decisions, including reversals

Recorded so the reasoning survives. Items marked **reversed** were chosen and then overturned by evidence.

| Decision | Outcome |
|---|---|
| Container pool for isolation | Correct long-term, **deferred** to its own spec |
| Consume a warm pool from config | Kept, but must sit behind a provider interface that can recycle a wedged tier |
| Quarantine + requeue as failure policy | **Reversed.** Treats the symptom; requeueing a request that stranded a session strands another. Cancellation semantics come first |
| Split batches to fill the pool | **Reversed.** Deliberately multiplies the dominant cost to manufacture scheduling units. Replicate one artifact and shard mutants instead |
| Batch-per-container ownership | **Reversed.** Artifact placement and mutant scheduling are separate concerns |
| Line-level coverage in scope | **Reversed.** Unproven per bc-dev, orthogonal to parallelism, and this project has been burned repeatedly by unvalidated assumptions. Gets its own validation spike |
| Async workers in one Bun process | Kept for control flow, but the "work is I/O-bound" justification was wrong — `alc` is CPU-bound, so compile concurrency needs its own bounded semaphore, independent of worker count |

## 4. Execution hardening

### 4.1 Timeout taxonomy

**The bug.** `orchestrator.ts:332` maps `outcome === "timeout"` to verdict `timeout-killed`. That `timeout` is produced by the backend's own `Promise.race` deadline. An MCP hang, a wedged endpoint, or a slow server therefore manufactures a kill, inflating the mutation score. Had Cronus28 wedged mid-run rather than between runs, it would have produced exactly this.

**The distinction.** Two unrelated events are currently one outcome:

- **Runner-confirmed timeout** — the test runner itself stopped the test. This *is* evidence the mutant caused nontermination, and design.md §6.7's "timeout counts as killed" applies soundly.
- **Client deadline exceeded** — our own timer fired. We know nothing about what the server did. This is infrastructure noise and must never become a verdict about the mutant.

**Verified detection (al-runner).** A test-level timeout is reported distinguishably:

```json
{ "name": "HangsForever", "status": "fail",
  "message": "Test exceeded 3s timeout. Use --test-timeout 0 to disable timeout, or increase with --test-timeout <seconds>." }
```

Confirmed by direct probe: sibling tests still run and pass, and the process exits 1. `AlRunnerBackend` passes `--test-timeout` derived from the mutant's budget and classifies a matching message as a runner-confirmed timeout.

**bcdev.** Whether BC/bc-dev reports a server-side test timeout distinguishably is **not yet known**. Until verified live, the bcdev backend must treat every timeout it observes as a client deadline. This is a documented capability gap, deliberately failing safe: we under-report kills rather than fabricate them.

**Resulting outcome set.** `TestVerdict.outcome` gains `deadline-exceeded`, distinct from `timeout`:

| Outcome | Meaning | Mutant verdict |
|---|---|---|
| `timeout` | runner-confirmed the test did not terminate | `timeout-killed` (sound) |
| `deadline-exceeded` | our client timer fired; server state unknown | `error`, excluded from the score, reported separately |

A mutant whose verdict is `error` is **excluded from the mutation-score denominator** and listed under an "infrastructure" heading in the report, so a bad run reads as a bad run rather than a good score.

### 4.2 Artifact identity

`publisher.ts:58` writes a fixed `lethal-instrumented.app` into `outputDir`. Harmless while sequential; under any concurrency two workers overwrite each other's artifact and one publishes the other's code. Artifact paths become unique per (run, artifact) and are treated as immutable once written.

## 5. al-runner server mode

Currently `AlRunnerBackend` spawns a fresh CLI process per test, paying full transpile + Roslyn compile every time — 6.9 s per test, which is the entirety of run 11's 278 s.

**Protocol** (confirmed from `AlRunner/Server.cs` at v1.0.31, and by probe): newline-delimited JSON, not JSON-RPC despite the help text. Commands are `runTests`, `execute`, `shutdown`. Handshake is `{"ready":true}`. Compiled assemblies are cached under a SHA256 fingerprint of source *contents*, in an 8-entry LRU.

**What this buys.** Cost moves from per-test to per-mutant: every mutant rewrites the selector, which changes the fingerprint and forces a recompile (~3.9 s), but all of that mutant's tests then run for ~1–4 ms. Fixture arithmetic: 32 invocations × 6.9 s ≈ 220 s becomes 16 mutants × 3.9 s ≈ 62 s, roughly **3.5×**.

**Constraints, both verified:**

- **No per-procedure execution.** `ServerRequest` has no procedure field and `HandleRunTests` never sets `RunProcedure`, so `runTests` always runs the whole suite. Acceptable here: al-runner reports `coverage: "none"` (so LethAL already runs all tests per mutant) and resets state per test. It does mean per-test isolation granularity is the runner's, not ours.
- **`stubPaths` are not in the fingerprint.** Relocating the selector into a stub directory to dodge recompilation would produce cache *hits* serving a stale assembly — fast, silent, wrong verdicts. Explicitly forbidden.

Server mode is added as an opt-in path (`AlRunnerConfig.serverMode`), with the one-shot CLI retained as the default until the server path is proven equivalent on the fixture.

## 6. Parallel execution

**Worker model.** N async workers in one Bun process, each owning an independent al-runner server process. Work is I/O-bound *from the orchestrator's perspective* (child processes do the CPU work), so the event loop is not the constraint.

**Two separate limits**, deliberately not one:

- `workers` — how many mutants are in flight.
- `compileConcurrency` — a bounded semaphore around transpile/compile-heavy operations. **Defaults to `min(workers, 4)`**, independently configurable, and the plan must include a measured comparison at 1/2/4/8 on the fixture before any higher default is adopted. Worker count must not silently become compile concurrency.

**Scheduling.** Artifact placement and mutant scheduling are separate:

1. Batches are computed once, minimally (unchanged overlap batching — no split-to-fill).
2. Each worker materialises the batch artifact it needs.
3. Mutants are **sharded** across workers, not batches assigned to workers. A worker pulls the next mutant for a batch it already holds, preferring batch affinity to avoid needless rebuilds.

This keeps compiles near-minimal while letting every worker stay busy — the property split-to-fill was reaching for, without manufacturing artifacts.

**Baseline per worker.** A baseline established on worker A does not prove the same on worker B. Each worker establishes and caches its own baseline for the artifact it holds, and baseline-red tests are excluded per worker.

**Determinism.** Verdicts must be independent of shard assignment and worker count. The exit criteria pin this.

**Parallelism is al-runner-only (added 2026-07-19, review finding).** `--workers > 1` must be REJECTED for `--backend bcdev`. Per-worker `Publisher.outputDir` isolates compiled artifacts, but bcdev activation is a **single server-side record**: every worker's `MutationControlClient` targets the same server/instance/company, so one worker's `setActive` overwrites another's active mutant mid-test and results are attributed to the wrong mutant, silently. The `setActive` echo check does not help — it validates its own response, not a later overwrite. All workers would also publish the same app id to one instance. This is exactly the constraint that makes a container pool with per-container activation the design for parallelism on the authoritative backend — it belongs to that later spec, not this one.

## 7. Explicitly out of scope

Each becomes its own spec, in this order:

1. **Schemata overlap coalescing.** Compose overlapping mutants into one artifact so batching disappears entirely, restoring design.md §3.1's "one compile with all mutations embedded." This is Layer 3 debt (the deferred multi-mutation deconfliction) and is the highest-value structural change available — but it is a schemata/compiler change, not an execution change, and belongs on its own.
2. **Container pool (Layer 5 proper).** Requires everything deferred above plus exclusive **leasing and fencing** — the biggest omission in the original plan. A config list grants no ownership: two LethAL sessions can select the same container and race on its single global `Mutation Active` row, and since mutant ids restart per batch, `M0001` does not identify anything. One run's mutant executes while another records the verdict. Needs lease owner + artifact id + attempt generation + fenced activation.
3. **Line-level coverage validation spike.**
4. **DB snapshots (§6.5) and SaaS/AAD auth.**

## 8. Exit criteria

- A mutant is never reported killed on the strength of a client-side deadline; `deadline-exceeded` produces `error` and is excluded from the score.
- The al-runner fixture run reproduces the known table — 16 sites, 3 killed / 13 survived / 0 no-coverage — at worker counts 1, 2, and 4, with **verdict-identical results at every count**, on **both** the one-shot and server-mode paths. Server mode does not become the default until it is verdict-equivalent to one-shot on this fixture.
- Two consecutive runs at the same worker count are verdict-identical (determinism, design.md §13).
- Measured speedup at 4 workers is reported honestly against the 1-worker baseline, whatever it turns out to be.
- Concurrent workers never share an artifact path.
- `itest:bcdev` still passes; the sequential path is a pool of one and stays exercised.
