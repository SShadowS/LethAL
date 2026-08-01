# R69 Phase 2 — Client-Services Batch Runner: Design Spec

**Status:** design, pre-implementation. Supersedes the Phase 2 skeleton in
`docs/superpowers/plans/2026-08-01-r69-client-services-batch-runner.md`.

**Prerequisite, already met.** The capability is PROVEN, not assumed. Measured 2026-08-01
(ROADMAP R69, `bc-mcp/scripts/r69-batch-spike.ts`): codeunit 79218's `ReportsTestPageOpen`
produced `MEASURED testpage-open=OK | GuiAllowed=Yes | ClientType=Web` through page 71014's
`Run Batch` action driven over the bc-mcp client-services WebSocket, with an AL stack trace
bottoming out at that page action. LethAL Control 1.0.0.11 is published on Cronus281 and
Cronus283.

---

## 1. Problem

R58 made the fenced session (`GuiAllowed=No`, `ClientType=ODataV4`) the default for the baseline
as well as for the mutants. A test that opens a `TestPage` cannot run there: BC refuses to create
a test service, in 87 ms. Those tests drop out of the green set, and every mutant they alone
covered becomes unscored. Sized on a real project: 9 of Continia Document Output's 104 test files
declare a `TestPage`.

Phase 3 (shipped, commit `076b726`) NAMES that refusal so the reader is not sent to debug correct
tests. It recovers no coverage. This spec recovers the coverage.

---

## 2. Decisions taken (and who took them)

| # | Decision | Resolution | Taken by |
|---|---|---|---|
| 1 | Session reuse vs `design.md` §6.3 | **One method per WebSocket session.** | User, 2026-08-01 |
| 2 | Scope | Only tests the fenced baseline REFUSED. | User (implied by #6) |
| 3 | Provenance | Per-verdict `runner` tag; `executionContext` becomes per-context. | User, 2026-08-01 |
| 4 | Nonce | Required, load-bearing, fail-loud. | This spec |
| 5 | Hang story | Structurally dissolved by #1 — see §6. | This spec |
| 6 | Interactive semantics (product call) | **Route, scoped, with per-verdict provenance.** | User, 2026-08-01 |
| 7 | Attestation reset + inert Phase-1 fields | Leak half dissolved by #1; wiring half still required. | This spec |

### 2.1 Why one method per session

`design.md` §6.3: *"Every test runs in its own BC test runner invocation. Never batched, never
reused across tests. Rationale: BC has no session-state reset API, and `Clear(var)` only clears
what LethAL can enumerate — third-party and base-app SingleInstance codeunits are opaque."*

The spike's stack trace shows each queue row ALREADY gets its own `Test Runner - Isol. Codeunit`
(130450) invocation. What a batch would share is the **WebSocket session**, and that is exactly
what §6.3's rationale is about. The leak is not hypothetical: Phase 1's
`LC Control State.AttestationObservedAny()` is `SingleInstance` and latches `true` across rows —
§6.3's predicted failure mode, observed once, before any customer code was involved.

One method per session also means **the shipped configuration is the measured one**: the spike ran
exactly one item. Batching is unmeasured.

Cost: the WebSocket handshake is paid per method. Accepted — this path carries only the refused
slice, and correctness outranks throughput here. The queue/result tables keep their value as the
seed-and-readback contract.

---

## 3. Architecture

Five units, each independently testable.

### 3.1 `TestPageRouter` — who goes down this path

**Does:** decides which tests and which mutants use the client-services path.
**Depends on:** `describeTestPageUnsupported` (shipped, red-checked), the baseline results.

Two gates, both required:

1. **Refused on the fence.** The fenced baseline failed this test with the `CreateNavTestService`
   refusal. Reuses the Phase-3 classifier as the routing predicate rather than inventing a second
   detector, so the report's stated category and the routing decision can never disagree.
2. **Passes on the client-services path.** The test is re-run, unmutated, on the batch path. Only
   tests that PASS there join that path's green set.

Gate 2 is not optional. A test that fails on BOTH paths is simply broken; routing it would
manufacture a green set from tests that never passed anywhere, and every mutant it "covered" would
be scored against a test that cannot pass. That is this project's signature bug in a new costume.

**Mutant selection.** Only mutants covered EXCLUSIVELY by gate-2-passing tests. A mutant with any
fenced-green coverage keeps its fenced verdict, unexamined.

> **Stated limitation, deliberate.** This forgoes kills a TestPage test might land on a mutant that
> already has fenced-green coverage. Recovering them requires reconciling two verdicts of different
> semantics — which semantics wins on disagreement — and that re-opens R55's dual-runner asymmetry.
> Out of scope here; a named follow-up, not a silent omission.

### 3.2 `BatchTransport` — seed, drive, read back

**Does:** one method, one session, end to end.
**Depends on:** OData (`LethALControl_SeedBatchItem` / `_ClearBatch` / `_GetBatchResults`), the
bc-mcp client-services WebSocket.

Sequence per method:

1. `ClearBatch()`, then `SeedBatchItem(codeunitId, method, mutantId, targetAppId, nonce)` over
   OData — the derived OData port (7048), HTTP Basic auth, `company` + `tenant` required. This
   wiring is MEASURED working (spike, 2026-08-01), not assumed.
2. Open page 71014 over the WebSocket; `executeAction({action: "Run Batch"})`.
3. `GetBatchResults()` over OData; verify the nonce; read the row.
4. Close the session.

**Contract:** the transport never returns a plausible empty default. A missing row, a nonce
mismatch, or a result count other than 1 THROWS a typed error. Per CLAUDE.md, typed error classes
extend `Error` directly and never each other.

### 3.3 Nonce

A per-invocation random value, seeded with the work item and echoed into the result row.

**Why load-bearing.** R69's own history: the AL Test Tool's persisted `Success` rows were STALE
from a removed app, and freshness had to be checked rather than trusted. The same shape applies
here — a previous run's result row, a concurrent run, or a partially-cleared queue would otherwise
be read as this invocation's answer. Readback compares the nonce and throws on mismatch.

### 3.4 Attestation and the inert Phase-1 fields

Phase 1 left `LC Batch Queue."Mutant Id"` / `."Target App Id"` and `LC Batch Result.Attested`
INERT by design — `SeedBatchItem` populated neither, `RunBatch` never called `WriteActive`. Phase 2
wires them:

- `SeedBatchItem` takes and stores `mutantId` and `targetAppId`.
- `RunBatch` calls `WriteActive(targetAppId, artifactId, mutantId)` before running the row.
- `Attested` is read from `AttestationObservedAny()` after the row.

The cross-row LEAK is dissolved structurally by one-method-per-session (fresh session, fresh
`SingleInstance`), so no per-row reset is needed. This is a consequence of decision #1 and must be
re-opened if batching is ever revisited — recorded here so that link is not lost.

### 3.5 Report and store changes

- **`store.ts`:** a `runner` column on the verdict row (`"fenced"` | `"client-services"`).
- **`report.ts`:** `executionContext` stops being a single blanket object and becomes the set of
  contexts ACTUALLY used in the run, each carrying runner, `guiAllowed`, `clientType`, `basis`, and
  the count of verdicts produced under it.

  This is a correctness fix, not cosmetics. Today `report.ts` asserts unconditionally for every
  authoritative run: *"every mutant executes in a `GuiAllowed=No`, `ClientType=ODataV4` session"*.
  The measured batch path is `GuiAllowed=Yes` / `ClientType=Web`. One routed verdict makes that
  sentence false.
- **The `NON-GUI EXECUTION` console block** scopes to fenced verdicts only. A companion block
  describes the interactive ones — and must state the inversion plainly: under `GuiAllowed=Yes` an
  unhandled `Confirm` RAISES rather than returning its default, so a mutant in a `Confirm` branch
  can reach a different verdict on this path than on the fence.

---

## 4. Task 0 — the probe that must run BEFORE any of §3 is built

**Question:** does the client-services path return per-procedure COVERAGE?

The spike's result JSON carried `testResults` (method, result, message, stackTrace) and **no
coverage payload**. If coverage is unavailable on this path, §3.1's "mutants covered exclusively by
gate-2-passing tests" is unanswerable — nothing reports what those tests cover — and the design
must fall back to running every routed test against every candidate mutant (the
`caps.coverage === "none"` shape: correct, but a different architecture and a different cost).

This is measured, not reasoned. It is the project's standing rule and R69's entire history is
priors that turned out wrong under a probe.

**Probe:** seed a method whose test touches an instrumented procedure, run it through the batch
path, and inspect whether `LC Run Method`'s result JSON (or a companion Control API call) yields
procedure-level coverage. Record the answer in ROADMAP R69.

**Both outcomes are actionable:**
- *Coverage available* → §3.1 as written.
- *No coverage* → §3.1 selects candidates as "mutants currently landing `no-coverage` whose file is
  reachable from a routed test", and runs the cross-product. Bound the cost and `log()` it; never
  silently truncate.

---

## 5. Error handling

| Condition | Outcome | Rationale |
|---|---|---|
| Test refused on fence AND fails on client-services | Not routed; stays `unsupportedTests` | Broken test, not a path problem |
| WebSocket wedges mid-method | Mutant `error` (score-excluded), never a verdict | Cannot distinguish run-unrecorded from not-run |
| Nonce mismatch on readback | THROW | Caller-contract violation; empty-vs-empty is this project's signature bug |
| Result row absent | THROW | Same |
| Seed 401/400 | THROW, naming port and required params | Measured wiring; a regression here is a config error, not a verdict |

---

## 6. The hang story (decision #5)

The plan carried a requirement that the design distinguish, for items AFTER a wedge, "not run" from
"run, unrecorded". **One method per session removes the class:** there are no trailing items.

For the single in-flight item, the distinction still matters and is answered by readback. Because
`RunBatch` commits after every result row, a row that exists was genuinely produced. So:

- Row present with matching nonce → it ran; use it.
- Row absent → either never ran or ran without committing. Both → mutant `error`, never a verdict.

The unexplained Cronus283 `in-flight-unknown` hang is NOT retired by this design. It can still wedge
a session. The design's guarantee is narrower and honest: a wedge costs a verdict, never
manufactures one.

---

## 7. Testing

**Unit (fakes, no live BC):**
- Commit-per-row ordering asserted with a CALL COUNTER on the stateful fake, never wall-clock
  (CLAUDE.md).
- Nonce mismatch throws; absent row throws; neither returns an empty default.
- A wedge yields `error`, not a verdict.
- Routing: a test refused on the fence but FAILING on client-services is not routed.
- `executionContext` reports two contexts when both runners produced verdicts, and one when only
  the fence did.

**Live:**
- Add a `TestPage`-opening test to `fixtures/sandbox-data` — the `pageextension` slice R30 left
  `no-coverage` precisely because of R69. Confirm those mutants now receive a verdict.
- Re-freeze `itest:tables` (currently 69/9/6 over 84) by **per-mutant join**, never aggregate
  counts. Every changed verdict must be explained or it is a BLOCK.
- `itest:bcdev` must be unchanged per-mutant: no fixture there is routed, so a moved verdict means
  the router leaked.
- `/coverage-differential` if collection, selection or attribution changed.

**Red-check** every load-bearing test with `mutation-red-checker`.

---

## 8. What this design does NOT claim

- Batching is unmeasured and not shipped. If revisited, §3.4's leak argument re-opens.
- Coverage availability on the client-services path is UNKNOWN until Task 0.
- The Cronus283 `in-flight-unknown` hang remains unexplained and unretired.
- Mutants with mixed coverage (fenced-green AND TestPage) are not recovered.
- `GuiAllowed=Yes` verdicts carry interactive semantics. That is a reported property, not a solved
  problem: the user accepted it scoped and provenance-tagged.
