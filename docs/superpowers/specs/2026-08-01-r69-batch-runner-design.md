# R69 Phase 2 — Client-Services Batch Runner: Design Spec

**Status:** design, pre-implementation. Revision 2 — incorporates the `spec-adversary` pass of
2026-08-01, which found revision 1 **not safe to implement**: three independent false-kill doors and
two false-survive doors. The architecture was unchanged by the review; the discipline around it was
not there. Every fix below copies a guarantee the fenced path already has.

Supersedes the Phase 2 skeleton in
`docs/superpowers/plans/2026-08-01-r69-client-services-batch-runner.md`.

**Prerequisite, already met.** The capability is PROVEN, not assumed. Measured 2026-08-01 (ROADMAP
R69, `bc-mcp/scripts/r69-batch-spike.ts`): codeunit 79218's `ReportsTestPageOpen` produced
`MEASURED testpage-open=OK | GuiAllowed=Yes | ClientType=Web` through page 71014's `Run Batch`
action driven over the bc-mcp client-services WebSocket, with an AL stack trace bottoming out at
that page action. LethAL Control 1.0.0.11 is published on Cronus281 and Cronus283.

---

## 1. Problem

R58 made the fenced session (`GuiAllowed=No`, `ClientType=ODataV4`) the default for the baseline as
well as for the mutants. A test that opens a `TestPage` cannot run there: BC refuses to create a
test service, in 87 ms. Those tests drop out of the green set, and every mutant they alone covered
becomes unscored. Sized on a real project: 9 of Continia Document Output's 104 test files declare a
`TestPage`.

Phase 3 (shipped, commit `076b726`) NAMES that refusal so the reader is not sent to debug correct
tests. It recovers no coverage. This spec recovers the coverage.

---

## 2. Decisions taken (and who took them)

| # | Decision | Resolution | Taken by |
|---|---|---|---|
| 1 | Session reuse vs `design.md` §6.3 | **One method per WebSocket session.** | User, 2026-08-01 |
| 2 | Scope | Only tests the fenced baseline REFUSED. | User (implied by #6) |
| 3 | Provenance | Per-verdict `runner` tag, through store, report AND resume. | User, 2026-08-01 |
| 4 | Nonce | Required, fail-loud — but see §3.3 on what it does NOT prove. | This spec |
| 5 | Hang story | Trailing-item class dissolved by #1; the wedge itself QUARANTINES (§6). | This spec |
| 6 | Interactive semantics (product call) | **Route, scoped, with per-verdict provenance.** | User, 2026-08-01 |
| 7 | Attestation reset + inert Phase-1 fields | Leak dissolved by #1; wiring + a MISMATCH CHANNEL required. | This spec |

### 2.1 Why one method per session

`design.md` §6.3: *"Every test runs in its own BC test runner invocation. Never batched, never
reused across tests. Rationale: BC has no session-state reset API, and `Clear(var)` only clears what
LethAL can enumerate — third-party and base-app SingleInstance codeunits are opaque."*

The spike's stack trace shows each queue row ALREADY gets its own `Test Runner - Isol. Codeunit`
(130450) invocation. What a batch would share is the **WebSocket session**, which is exactly what
§6.3's rationale is about. The leak is not hypothetical: Phase 1's
`LC Control State.AttestationObservedAny()` is `SingleInstance` and latches `true` across rows —
§6.3's predicted failure mode, observed once, before any customer code was involved.

One method per session also means **the shipped configuration is the measured one**: the spike ran
exactly one item. Batching is unmeasured.

Cost: the WebSocket handshake is paid per method. Accepted — this path carries only the refused
slice. The queue/result tables keep their value as the seed-and-readback contract.

> **Note the residue this does NOT clear.** One-method-per-session destroys the in-memory
> `SingleInstance` state. It does NOT clear the `LC Mutation Active` TABLE ROW, which outlives the
> session. See §3.4 — that residue was revision 1's third false-kill door.

---

## 3. Architecture

Six units, each independently testable.

### 3.1 `TestPageRouter` — who goes down this path

**Does:** decides which tests and which mutants use the client-services path.
**Depends on:** `describeTestPageUnsupported` (shipped, red-checked), the baseline results.

Two gates, both required:

1. **Refused on the fence.** The fenced baseline failed this test with the `CreateNavTestService`
   refusal. Reuses the Phase-3 classifier so the report's stated category and the routing decision
   cannot disagree.
2. **Passes on the client-services path.** The test is re-run, unmutated, on the batch path. Only
   tests that PASS there join that path's green set.

Gate 2 is not optional. A test that fails on BOTH paths is broken; routing it would build a green
set from tests that never passed anywhere, and every mutant it "covered" would be scored against a
test that cannot pass. That is this project's signature bug in a new costume.

**Gate 1 is a diagnosis regex promoted to a verdict-moving predicate, and that is a real widening.**
`TESTPAGE_REFUSAL_RE` matches `CreateNavTestService()` anywhere in `failureMessage` (message +
stack trace). Calibrated for a NOTE, where a false positive costs a mislabel. As a router it costs
scope: a test whose assertion message merely QUOTES the platform string (suites that assert on error
text do this) would be routed, and would then be reported as "opens a TestPage" when it does not.
Gate 2 bounds the damage — the test must still pass somewhere — so this is a wrong-diagnosis and
scope-widening risk, not a wrong-verdict one. Required mitigations: the report records, per routed
test, the QUOTED gate-1 evidence, so a reader can overrule the routing decision the same way R35's
design lets them overrule its diagnosis; and §8 states the residual over-match rather than implying
the predicate is exact.

**Mutant selection.** Only mutants covered EXCLUSIVELY by gate-2-passing tests. A mutant with any
fenced-green coverage keeps its fenced verdict, unexamined.

> **Stated limitation, deliberate.** This forgoes kills a TestPage test might land on a mutant that
> already has fenced-green coverage. Recovering them requires reconciling two verdicts of different
> semantics, which re-opens R55's dual-runner asymmetry. Out of scope; a named follow-up.

### 3.2 `BatchTransport` — seed, drive, read back, VALIDATE

**Does:** one method, one session, end to end.
**Depends on:** OData (`LethALControl_SeedBatchItem` / `_ClearBatch` / `_GetBatchResults`), the
bc-mcp client-services WebSocket.

Sequence per method:

1. `ClearBatch()`, then `SeedBatchItem(codeunitId, method, mutantId, targetAppId, artifactId,
   nonce)` over OData — derived OData port (7048), HTTP Basic auth, `company` + `tenant` required.
   This wiring is MEASURED working (spike, 2026-08-01), not assumed.
2. Open page 71014 over the WebSocket; `executeAction({action: "Run Batch"})`.
3. `GetBatchResults()` over OData; validate (below); read the row.
4. Close the session.

**Validation contract — the row's own fields are NOT evidence.** `LC Batch Result`'s `Line No.`,
`Codeunit ID`, `Method` and the nonce are all COPIED by `RunBatch` from the queue row LethAL itself
seeded (`BatchRunner.Codeunit.al` lines 36–42). They round-trip the client's own input. The only
server-produced evidence is the inner `LC Run Method` `Results()` JSON. The transport therefore
applies the SAME checks the fenced path already applies in `run-mutant-transport.ts`'s
`mapRanResult`:

- exactly one test line in the result JSON, or THROW (`lines.length !== 1` is a protocol fault,
  never a verdict — the fenced path's own words);
- that line's `method` equals the requested method, or THROW;
- an unrecognised result enum THROWS.

Without these, a run that executed zero methods or a different method returns `Ok=true` with
client-echoed identity fields and a matching nonce, and is scored as the requested method passing —
a survive with nothing measured. Revision 1 omitted them; this is the cited-strong/consumed-weak
pattern the house rules exist to catch.

**Kill confirmation is mandatory on this path too.** The fenced path never converts a single test
failure into `killed`: `runMutantsOnBackend` performs a kill-confirmation rerun at baseline, and if
the test fails there too the verdict is `error cause=unstable`. That is the project's principal
false-kill defence (R27/R59). The routed path is the MOST nondeterministic session LethAL has —
`GuiAllowed=Yes` lets dialogs raise, and the unexplained Cronus283 wedge lives here — so it needs
the defence more, not less. A routed failure triggers a second seed/run/readback of the same test
UNMUTATED on the same path; failing there yields `error cause=unstable`, exactly the fenced
semantics.

**General contract:** the transport never returns a plausible empty default. Missing row, nonce
mismatch, result count ≠ 1, method mismatch, identity mismatch — all THROW. Typed error classes
extend `Error` directly and never each other (CLAUDE.md).

### 3.3 Nonce — and what it does not prove

A per-invocation random value, seeded with the work item and echoed into the result row.

**What it proves:** this invocation produced this row. That closes the stale-row hazard R69's own
history demonstrated — the AL Test Tool's persisted `Success` rows were STALE from a removed app,
and freshness had to be checked rather than trusted.

**What it does NOT prove:** anything about what ran. The nonce is a client value echoed back, so a
matching nonce and a row whose `Method` says `TestFoo` are both consistent with the platform having
run nothing. Content validation is §3.2's result-JSON check, and the nonce is not a substitute for
it. Revision 1 conflated the two.

### 3.4 Activation lifecycle — activate always, clear always, never outside the lease

Phase 1 left `LC Batch Queue."Mutant Id"` / `."Target App Id"` and `LC Batch Result.Attested` INERT.
Phase 2 wires them, with three constraints revision 1 missed.

**(a) A public wrapper is required, and the missing visibility is a signal, not an obstacle.**
`WriteActive`, `ClearActiveIf`, `ForceClearActive` and `EnsureLoaded` are all `local` in
`ControlState.Codeunit.al` — revision 1's "`RunBatch` calls `WriteActive`" would not have compiled.
They are local BY CONSTRUCTION: under the fence, the only legitimate writer of `LC Mutation Active`
is a phase 1 that has just proven it holds the lease. The wrapper must therefore be narrow and must
carry that invariant, not quietly discard it.

**(b) Activate on EVERY row, including gate-2 baselines, and clear on EVERY terminal path.** The
fenced primitive clears on every terminal path and `design.md` §6.2 states that as a guarantee.
Revision 1 specified `WriteActive` with no clear. Because the `LC Mutation Active` TABLE ROW
outlives the session, that leaves this sequence:

> routed mutant M1 runs → result row committed → session closes → `LC Mutation Active` still holds
> M1 → the NEXT routed method's gate-2 baseline (unmutated, so revision 1 called no `WriteActive`)
> opens a fresh session → the first guard hit calls `EnsureLoaded()`, reads M1 from the table → **the
> gate-2 baseline runs MUTATED.**

Either that test fails gate 2 and its coverage is silently lost as a "broken test", or it passes a
baseline taken under M1 and every later kill judgement compares against the wrong world. Fenced runs
are immune only because every `RunMutant` call re-`WriteActive`s, including the baseline with
`mutantId ""`. The batch path must do the same: baseline rows activate with `""`, mutant rows
activate with their id, and every row clears on every terminal path.

**(c) Serialize against fenced work.** A batch `WriteActive` outside the lease writes the same single
row a fenced phase-1 transaction locks. Routed work never runs concurrently with a held lease; the
spec states this rather than leaving it to chance, because the failure mode is lock contention that
surfaces as an unrelated quarantine.

The cross-row in-memory LEAK is dissolved by one-method-per-session (fresh session, fresh
`SingleInstance`). That is a consequence of decision #1 and re-opens if batching is ever revisited.

### 3.5 Attestation — wired AND consumed, with a mismatch channel

Revision 1 wired `Attested` and named no consumer. A field nothing reads cannot prevent anything.

The fenced path REJECTS `identityMismatch` — "never map it to a verdict" — and rejects
`artifact-mismatch` from the registry. Without an equivalent, this sequence produces a false
survive:

> the runner passes a stale `artifactId` (target redeployed between the fenced deploy and the routed
> run) → `IsActive` never matches → the mutation is never applied → the test passes → **`survived`**,
> indistinguishable from a genuine survive.

Required:

- `LC Batch Result` gains `Identity Mismatch`, populated from `AttestationMismatch()` — already
  public, no new visibility needed.
- The transport rejects a mismatch: `error`, never a verdict.
- The batch path verifies the registered artifact for `targetAppId` equals the artifact it is
  scoring against, before scoring.
- §3.4(b)'s activate-always makes `Expected*` coherent for baseline rows. Without it, a session where
  `WriteActive` was never called has blank expectations, so EVERY guard observation sets
  `ObservedIdentityMismatch` and the attestation fields cannot be interpreted at all.

### 3.6 Report, store and resume changes

- **`store.ts`:** a `runner` column (`"fenced"` | `"client-services"`) on the verdict row, AND on
  `MutantVerdictRow`.
- **`resume.ts`:** `killed`, `survived`, `timeout-killed`, `no-coverage` and `known-survivor` are all
  in `CARRYABLE_VERDICTS`, and `MutantVerdictRow` today has no runner field. So without this, run 1
  routes a test and kills M under `GuiAllowed=Yes`; run 2 `--resume` re-records M with no tag, and
  an `executionContext` defined as "contexts actually used in THIS run" truthfully reports
  fenced-only. The reader now believes an interactive kill was fenced — the exact drift the current
  hardcoded `guiAllowed: false` prevents today. Carried verdicts must therefore carry their runner
  AND contribute their context to the set, with `basis: "carried from run <id>"`. The same door
  exists through history: an interactive `survived` must not become an unlabelled `known-survivor`.
- **`report.ts`:** `executionContext` becomes the set of contexts actually used, each carrying
  runner, `guiAllowed`, `clientType`, `basis`, and verdict count. **`REPORT_SCHEMA_VERSION` bumps
  from 1** — the shape change is not backward compatible, and a JSON consumer reading
  `validity.executionContext.guiAllowed` off the new shape gets `undefined`, which is falsy, which
  reads as "not GUI-allowed": a routed verdict silently read as fenced, below the level TypeScript's
  literal-`false` type can protect.
- **Per-mutant runner in the REPORT, not only the store.** Decision #3 promised a per-verdict tag;
  per-context counts do not let a reader identify WHICH mutants are interactive.
- The `NON-GUI EXECUTION` console block scopes to fenced verdicts only. A companion block describes
  the interactive ones and must state the inversion plainly: under `GuiAllowed=Yes` an unhandled
  `Confirm` RAISES rather than returning its default, so a mutant in a `Confirm` branch can reach a
  different verdict on this path than on the fence.

This is a correctness fix. Today `report.ts` asserts unconditionally for every authoritative run:
*"every mutant executes in a `GuiAllowed=No`, `ClientType=ODataV4` session"*. The measured batch path
is `GuiAllowed=Yes` / `ClientType=Web`. One routed verdict makes that sentence false.

---

## 4. Task 0 — the probe that must run BEFORE any of §3 is built

**Question:** does the client-services path return per-procedure COVERAGE, and is it CLEAN?

The spike's result JSON carried `testResults` (method, result, message, stackTrace) and no coverage
payload. If coverage is unavailable, §3.1's exclusivity rule is unanswerable — nothing reports what
those tests cover. This must be measured; R69's entire history is priors that turned out wrong under
a probe.

**Two readings, both required. Presence is not enough.**

1. **Positive:** a routed method whose test touches an instrumented procedure returns coverage naming
   that procedure.
2. **Negative control:** a routed method touching NOTHING instrumented must return **empty**
   target-app coverage.

The negative control is the load-bearing one. On the fence, coverage brackets one quiet session. On
this path there is by construction a live interactive page session, and if collection brackets a
companion call the bracket can absorb non-test activity. Noisy coverage attributes a GENUINELY
UNCOVERED mutant to a routed test; it is then selected, run, the test passes because it never
reaches the site, and **`no-coverage` becomes `survived`** — the one transition this design must not
permit. Accepting "coverage present" as success is the empty-vs-empty bug inverted.

**Outcomes:**
- *Coverage available AND clean* → §3.1 as written.
- *Coverage absent or noisy* → **the routed path does not score.** It stays diagnosis-only and this
  spec's §3.1 selection is abandoned rather than approximated.

> Revision 1's fallback — "mutants currently landing `no-coverage` whose FILE is reachable from a
> routed test" — is withdrawn. "Reachable" named no mechanism (none exists in the repo), so it was a
> placeholder; and it converted score-EXCLUDED `no-coverage` mutants into score-INCLUDED survivors on
> a static guess, single-shot, under interactive semantics. If a cross-product is ever wanted, its
> verdicts must carry an explicit `basis: assumed-covered` and stay OUT of the score denominator.

---

## 5. Error handling

| Condition | Outcome | Rationale |
|---|---|---|
| Test refused on fence AND fails on client-services | Not routed; stays `unsupportedTests` | Broken test, not a path problem |
| Routed test fails under a mutant | Confirmation rerun; fail-there → `error cause=unstable` | Never a single-shot kill (§3.2) |
| WebSocket wedges mid-method | **`in-flight-unknown` → latch + durable tier quarantine** | The operation may still be running WITH a mutant active (§6) |
| Nonce mismatch on readback | THROW | Caller-contract violation |
| Result row absent | THROW | Same |
| Result JSON ≠ 1 line, or method mismatch | THROW | Protocol fault, never a verdict |
| `AttestationMismatch()` true | `error`, never a verdict | Mirrors the fenced identity-mismatch rejection |
| Artifact registry disagrees | `error`, never a verdict | The mutation may never have been applied |
| Seed 401/400 | THROW, naming port and required params | Measured wiring; a regression is config, not verdict |

---

## 6. The wedge (decision #5)

One method per session removes the TRAILING-ITEM class: there are no items after a wedge to
misattribute. That much of revision 1 stands.

**What revision 1 got wrong is the wedged item itself.** It specified "mutant `error`, never a
verdict" and then implicitly continued — with the next routed method, and with fenced workers on the
same container. But a wedge is precisely "the operation may still be running server-side", and a
wedged `RunBatch` may still be executing a test **with a mutant activated and never cleared**,
holding record locks. That produces:

> routed M1 wedges mid-test → recorded `error`, run continues → fenced mutant M2's covering test hits
> lock contention against the still-running wedged test and fails → the wedged test completes before
> M2's confirmation rerun, which passes → **M2 killed falsely.**

The fenced path latches the session unsafe and durably quarantines the tier for exactly this
ambiguity. The batch path must do the same: a wedge is an `in-flight-unknown` and goes through the
existing `quarantineInFlight`, not a per-mutant error.

§6's readback rule survives, scoped to the already-committed row: because `RunBatch` inserts the
result row only AFTER `Runner.Run()` returns, a committed row does prove that test finished. Row
present with matching nonce AND passing §3.2 validation → it ran. Row absent → never ran, or ran
without committing; both → no verdict.

The unexplained Cronus283 `in-flight-unknown` hang is NOT retired by this design. The guarantee is
narrower and honest: a wedge costs verdicts and quarantines the tier; it never manufactures one.

---

## 7. Testing

**Unit (fakes, no live BC):**
- Commit-per-row ordering asserted with a CALL COUNTER on the stateful fake, never wall-clock
  (CLAUDE.md).
- Nonce mismatch throws; absent row throws; result JSON with 0 or 2 lines throws; a line whose
  method differs from the request throws. None returns an empty default.
- A routed failure triggers a confirmation rerun; failing there yields `error cause=unstable`, not
  `killed`.
- A wedge quarantines the tier; it does not record a per-mutant error and continue.
- `AttestationMismatch()` true → `error`, never a verdict.
- Activation: every routed row activates (baseline with `""`) and clears on every terminal path,
  including the error path.
- Routing: a test refused on the fence but FAILING on client-services is not routed.
- `executionContext` reports two contexts when both runners produced verdicts, one when only the
  fence did, and a RESUMED interactive verdict still contributes its context.

**Live:**
- Add a `TestPage`-opening test to `fixtures/sandbox-data` — the `pageextension` slice R30 left
  `no-coverage` precisely because of R69. Confirm those mutants now receive a verdict.
- Re-freeze `itest:tables` (currently 69/9/6 over 84) by a per-**(mutant, runner)** join. Outcome
  alone is insufficient: a fenced-covered mutant drifting to an interactive kill preserves the
  outcome while changing its meaning, and an outcome-only join cannot see it.
- `itest:bcdev` (3/10/3) and `itest:envtool` (3/10/3) must be unchanged per-mutant AND all-fenced: no
  fixture there is routed, so any `client-services` tag means the router leaked.
- `/coverage-differential` if collection, selection or attribution changed.
- **Control-app lockstep:** the new queue/result fields and the `SeedBatchItem` signature change mean
  `extensions/lethal-control/app.json` and `MIN_CONTROL_VERSION` bump together (1.0.0.11 → 1.0.0.12)
  and republish to both containers. Without it an old control app plus a new runner fails only by
  accident of an OData 400.
- **Report coherence:** a gate-2-passing test must not remain in `testPageUnsupportedTests` as
  "cannot run on this path" while its verdicts are printed. Define its membership explicitly.

**Red-check** every load-bearing test with `mutation-red-checker`.

---

## 8. What this design does NOT claim

- Batching is unmeasured and not shipped. If revisited, §2.1's and §3.4's leak arguments re-open.
- Coverage availability AND cleanliness on the client-services path are UNKNOWN until Task 0. If
  Task 0 fails either reading, the routed path does not score at all.
- The Cronus283 `in-flight-unknown` hang remains unexplained and unretired.
- Mutants with mixed coverage (fenced-green AND TestPage) are not recovered.
- Gate 1's predicate is a diagnosis regex and **over-matches by construction**: a test whose failure
  message merely quotes `CreateNavTestService()` is routed and described as opening a TestPage. Gate
  2 bounds the consequence to a mislabel plus scope widening, never a wrong verdict. The quoted
  evidence is reported so a reader can overrule it.
- `GuiAllowed=Yes` verdicts carry interactive semantics. That is a reported property, not a solved
  problem: the user accepted it scoped and provenance-tagged.
