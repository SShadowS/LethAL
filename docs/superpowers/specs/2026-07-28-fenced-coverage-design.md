# Fenced-path coverage — the client half of R58

**Status:** BUILT 2026-07-28. The client half ships behind `coverageMode: "fenced"`, opt-in. The
server half needed one more change that only measurement could find — see unknown #4 below: control
app **1.0.0.8 was unusable**, and 1.0.0.9 takes an object-id filter. The differential gate passes on
both sandbox fixtures. On Continia Document Output it passes its BLOCKING criterion (0 mutants move
`killed` -> `survived`) while surfacing an unresolved question: 77 mutants move `survived` ->
`no-coverage`, and whether that is the fence being right or the fence losing coverage is not yet
discriminated. `"fenced"` therefore stays opt-in and rollout step 5 does not start.

Earlier: design, revised after an external review that found a fatal rule, an internal contradiction,
and three missing unknowns.

**Goal:** collect coverage on the same runner that produces verdicts, so the green set and the
verdicts stop coming from two different sessions.

## Why — all measured, none assumed

LethAL's coverage comes from the bc-dev-mcp hub, but every mutant runs through the fenced
`RunMutant` OData action. Those are different sessions, and the difference is not cosmetic:

| | baseline runner | mutant runner |
|---|---|---|
| `coverageMode: "procedure"` (default) | bc-dev-mcp hub — `GuiAllowed=Yes`, `ClientType=Web` | fenced — `GuiAllowed=No`, `ClientType=ODataV4` |
| `coverageMode: "none"` | fenced | fenced |

Consequences, each measured on Continia Document Output (R55, R57):

- **12 of 56 tests fail on the hub and pass on the fence**, order-independent (verified in both
  orderings). BC treats a handler-less `Confirm` as UI in a GUI-allowed session and raises
  `Unhandled UI`; a non-GUI session returns the default silently and the caller takes the other
  branch. Continia Core's `IsAppActiveOrAskToActivate` is exactly that shape.
- A failing test leaves the green set and **takes its coverage with it**, so mutants in the
  procedures it covered are reported `no-coverage`. Measured: **14 mutants**, all in
  `CreateOrSendAutStatements`, with 9 of the 12 failures being the tests that cover it. Plus **21**
  mutants reported `error` for want of a green covering test.
- Direction is currently safe — verdicts come from the fence, and R37 confirmed zero false
  survivors across all 138 mutants — so today's damage is confined to *which* mutants get scored.
  **R59 is the unsafe direction**: a test that passes on the hub and fails on the fence enters the
  green set, then fails against every mutant it covers, and each reads as a KILL.

Feasibility is settled (R58): a fenced `ODataV4` session records coverage identically to the hub —
`coverageRows=262 totalHits=67 ownObjectRows=44` on both paths. **Do not over-read that result:** it
holds for tests that behave identically on both runners. The 12 Confirm-branching tests execute
*different branches* on the two paths, so their coverage will legitimately differ.

## Architecture

One new coverage mode. The hub path is untouched until the gates below pass.

```
coverageMode: "fenced"        (new, opt-in — see Rollout for its removal condition)
  baseline  --> RunMutantWithCoverage  --> {objectType, objectId, lineNo, hits}[]
                                            |
                                            v  line -> procedure   (target-app objects ONLY)
                                       CoverageMap (existing shape)
                                            |
                                            v
                                  buildCoverageIndex / coverageFilter   (unchanged)
  mutants   --> RunMutant (unchanged)
```

Nothing downstream of `CoverageMap` changes. `coverageFilter`, its three attribution paths and the
`byObject` fallback are the parts R29 was fought over, and this work must not reopen them.

## Components

| File | Change |
|---|---|
| `run-mutant-transport.ts` | call `RunMutantWithCoverage` when coverage is requested; parse the `coverage` array |
| `bcdev-backend.ts` | add `"fenced"` to `coverageMode`; **fix `run()`'s dispatch predicate** (today `if (opts.coverage !== "none") return this.runOnHub(...)` — a fenced baseline requests coverage and would go to the hub); **fix `status()`'s `=== "none"` branch** so fenced mode does not probe bc-dev-mcp, the dependency it exists to avoid; widen `capabilities().coverage` and every consumer of that union |
| `line-map.ts` *(new)* | `(objectType, objectId, lineNo) -> procedureName`, scoped to artifact-declared objects |
| `orchestrator.ts` | the baseline now takes the fenced path under a non-`"none"` mode. The comment near `resyncSessionOpSeq` (~line 1982) states the current call site is "safe only while the backend reports `coverage: \"procedure\"` (the baseline then never takes the fenced RunMutant path)". A fenced baseline consumes `opSeq`s, can hit `lease-invalid`, and must participate in reconciliation |
| `cli.ts` | accept `"fenced"` in the config union |

## The crux: mapping a line to a procedure

The hub returns a `methodId` and `AppMethodIndex` names it. The fence returns a **line number**.

**This is the step where a mistake becomes a wrong verdict rather than a missing mutant.** A line
attributed to the wrong procedure produces a confident, non-empty, wrong covering set — precisely
the R29 failure that made 10 of 20 fixture survivors false.

### Scope: artifact-declared objects only

`CoverageArray` serializes the **entire** `Code Coverage` table — Base App, System App, Test Runner,
the test app, Continia Core, and LethAL's own control and selector codeunits. Most rows are not from
the artifact LethAL compiled.

Two consequences the first draft got wrong:

- **The map is built only over objects the compiled artifact declares**, cross-checked against the
  `SymbolReference.json` that `AppMethodIndex.fromAppFile` already extracts — never over everything
  in the batch dir. `prepareBatchProject` deliberately copies DO's 137 `.dependencies` sources
  (R39), and those objects are published by their *own* installed apps whose bytes need not match
  the copied text. Indexing them would resolve real coverage rows to plausible-but-wrong procedure
  names at member level, feeding `byMember`. That is the R29 shape with extra steps.
- **A row for an object outside the artifact is SKIPPED, not an error.** The hub path already
  behaves this way and says why: `AppMethodIndex.lookup` is "undefined when the object isn't in this
  app's own symbol reference (e.g. platform/base-app code incidentally covered) — callers should
  skip it."

The map covers **every `.al` the artifact compiled**, not only the instrumented ones:
`prepareBatchProject` copies skipped files verbatim (uninstrumentable kinds, `--only`-excluded
files), and the emitted `Mutation*` selector objects (default ids 79197–79199) will show heavy hits
and need either a map entry or an explicit exemption.

### Rules

1. **A line that falls in no known procedure range emits an OBJECT-level entry** (no `procedure`),
   never a guess. This covers BC's line `0` object-level rows, trigger-header rows, and var-section
   lines that carry hits. The hub path does exactly this, and its doc comment explains that
   *dropping* the observation instead was the original false-survivor bug.
2. **An object the artifact DECLARES but the map lacks is a caller-contract violation** and throws.
   Scoped that way deliberately: the unscoped version of this rule would fire on the first Base App
   row and abort every real run.
3. **Never emit `procedure: ""`.** `buildCoverageIndex` throws on a blank-but-present procedure by
   design — it would collide with the `<type>:<id>::` key a trigger mutant builds.
4. **Triggers are not indexed as procedures.** A line inside a trigger therefore falls in no range
   and takes rule 1, giving byte-parity with the hub's `byObject`-only behaviour for trigger code.
   Chosen explicitly: emitting the trigger name instead would land in `byMember` under a key no
   mutant queries, which is harmless *and invisible to the differential gate* — a silent divergence
   between the two implementations.

### Build it with the parser, not a regex

`findLocalProcedureNames` is regex-based and its own doc justifies that as a safe
over-approximation. `line-map.ts` is verdict-affecting: a regex fooled by the word `procedure` in a
comment or string mis-draws a range and produces a wrong member key. tree-sitter-al is already
loaded and the batch dir's text is on disk. Parse it; the boundary cases come free.

## Measure before building

1. ~~**What is `"Line No."`?**~~ **ANSWERED 2026-07-28** — a 1-based SOURCE LINE. A 79-line probe
   file returned `0, 26..67, 69..78`: line 26 is its first `procedure`, 69 the second, 78 the
   closing `end;`, and the absent 68 is the blank line between them. So rows span each procedure
   contiguously **including its declaration line and `end;`** (a `[declLine, endLine]` range
   suffices, with no statement-level reasoning), gaps between procedures are simply absent, and
   **line `0` is object-level**, landing on rule 1.
2. ~~**Is numbering file-relative or OBJECT-relative?**~~ **ANSWERED 2026-07-28 — OBJECT-relative,
   and the base is not where you would guess.** Probed with a two-object file
   (`TwoObjects.Codeunit.al`): object 79322's `Second` occupies FILE lines 33–40, and BC reported
   `[0, 6..13]` — offset exactly 27, so reported 6 → file 33 (the `procedure` line) and reported
   13 → file 40 (its `end;`), consistent with unknown #1's pattern.

   **Object line 1 is file line 28 — the BLANK line before `codeunit 79322`, not the keyword
   line.** The base includes the object's leading trivia. A map that assumed "the `codeunit`
   keyword is object line 1" would be off by however much whitespace or comment precedes each
   object, which varies per object — shifting every range onto its neighbour, which is the
   wrong-procedure/wrong-verdict failure this whole section exists to prevent.

   This also confirms unknown #1 proved less than it appeared to: in a single-object file starting
   at line 1 the two frames coincide exactly, so that probe could not have distinguished them. The
   review that predicted this was right, and it is this project's signature hazard in miniature.

   **Confirmed 2026-07-28 with a third object preceded by TWO blank lines**, the case that
   separates "previous end + 1" from "keyword − 1" (with one blank line they coincide, so the
   first two measurements agreed with each other AND with a wrong hypothesis). Object 79324's
   `Third` spans FILE lines 46-49 and BC reported object lines **5-8** = base 42 = previous end
   + 1. Implemented and unit-tested in `line-map.ts`.
3. ~~**Does `StartApplicationCoverage` CLEAR or ACCUMULATE?**~~ **ANSWERED 2026-07-28 — it
   CLEARS.** `ZzResetBetweenRuns` starts and stops coverage having exercised nothing, then looks
   for object 79322, which only the preceding test touched: `staleRows=0 staleHits=0`. So each
   fenced call sees only its own execution and per-test attribution is sound.

   This was the unknown most likely to kill the design — accumulation would have credited test N
   with tests 1..N−1's coverage, silently collapsing selection toward all-tests.
4. ~~**Payload size and response time on a real DO test.**~~ **ANSWERED 2026-07-28, and it was the
   one that bit.** Unfiltered, `RunMutantWithCoverage` never returned HEADERS within 300 s — not on
   a DO test, on `fixtures/sandbox-app`, whose entire test body is three lines. The client's fetch
   gave up, `RunMutantTransport` classified it `in-flight-unknown`, and the session reported
   `killed=0 survived=0 noCoverage=0` while looking perfectly configured.

   The cost is not the target's code: inside `RunMutant` the platform records every line the Test
   Runner, Test Suite Mgt and Base App execute, so the table does not shrink with the test. A larger
   client timeout would therefore not have fixed it, and the "consider passing `idRanges`" hedge in
   the first draft was too weak — it is mandatory. Control app 1.0.0.9 takes a
   `CoverageObjectIdFilter` and the same call answers in **126 ms / 1,546 bytes**.

   Two things follow that are worth stating. An EMPTY filter is not a benign default, it is the
   hang, so a manifest with no `idRanges` is refused rather than sent. And the filter is not
   load-bearing for correctness — the client re-checks every row against the compiled package's
   `SymbolReference.json` — so a too-wide filter costs bytes and a too-narrow one loses coverage,
   which is why it is the artifact's declared ranges verbatim.
5. ~~**Do the TARGET app's objects appear at all?**~~ **YES** — measured on Continia Document
   Output: 12 of 13 scored mutants attributed `exact` (member level) to named DO tests.
6. ~~**Do lines refer to the INSTRUMENTED source?**~~ **YES, confirmed by construction the moment #5
   was.** The resolved names are real procedures of the target on a 554-file project that also
   carries 137 `.dependencies` sources the map must not index (R39); a map built in the wrong frame
   could not produce `exact` attribution against the mutants' own procedure names.

## Error handling

Fail loudly on caller-contract violations; never return a plausible empty default. Concretely: a
malformed `coverage` array on a `ran` result is a typed error; **absent coverage on a non-`ran`
result is normal** (refusal statuses carry no coverage, and `RunMutantWithCoverage` returns the
inner payload untouched when it cannot parse it). An out-of-range line is *not* an error — see
rule 1; the first draft said both, which was a contradiction.

Two invariants to state rather than assume:

- **`pendingMutantId` must be null during baseline.** `runViaTransport` sends
  `this.pendingMutantId ?? ""`; a stale id would run the entire baseline against a mutant.
- **`baselineDuration` now includes coverage-collection overhead** that mutant runs do not pay. The
  mutant budget is `2 × baseline` (`MIN_MUTANT_BUDGET_MS`), so budgets inflate slightly. Safe
  direction, and deliberate — R47 and R53 were fought over exactly these budgets, so it is recorded
  rather than discovered later.

## Testing

Unit tests for `line-map.ts`: first line of a procedure, last line, a line between procedures, a
line in a trigger (→ object-level, rule 4), line 0, an object outside the artifact (→ skipped), an
artifact-declared object with no map (→ throws).

**Run the cheap oracle first.** Baseline only, both modes, diffing the derived per-test procedure
sets that feed `buildCoverageIndex`. The expected difference is *exactly* the 12 hub-failing tests'
coverage. Any other member-level entry the fence produces that the hub does not is a mapping bug,
localised to a `(test, object, procedure)` triple instead of laundered through verdicts. Minutes,
not hours, and it points at the defect rather than its shadow.

**Then the differential per-mutant gate**, the same experiment that answered R37. Implemented as
`scripts/probe-r58-differential.ts` (runs one fixture through `runSession` twice, dumping per-test
coverage sets alongside per-mutant verdicts) and `scripts/probe-r58-compare.ts` (applies the rules
below and exits 1 on a blocking difference): one project twice,
identical except `coverageMode`, compared per-mutant with `mutantCode` verified as a safe join
(0 identity mismatches at the same code). Required:

- **no mutant moves `killed` → `survived`** — that means fenced coverage lost a killing test (R59)
- `no-coverage` → `survived`/`killed` is the expected gain (the 14)
- `survived` → `killed` is also a gain — the hub was under-reporting
- **covering-test sets and `attribution` values are compared too, not just verdicts.** A mutant that
  survives in both runs while the fenced run's covering set is wrong has a corrupted *finding* with
  an intact verdict, and `CoverageSplit.attribution` exists precisely to be trustworthy
- **moves to `error` are bounded**, not merely reported
- **the fenced baseline is 56/56 green on DO**, or the exceptions are named

Run it on **two** projects: DO exercises the Confirm-branch shape but not multi-object files,
trigger-heavy code or extensions — `itest:tables` differential covers what DO does not.

A pure unit-test pass proves nothing: all four frozen gates have green baselines, so the whole
mechanism is a no-op for them — the same blindness R55's candidate fix had. That was not a
hypothetical: the unit suite was fully green while the unfiltered coverage call was hanging for
300 s against a live container.

### Result, 2026-07-28

| fixture | verdicts | covering-set changes | attribution changes | identity mismatches |
|---|---|---|---|---|
| `sandbox-app` | 3/10/3 both | 0 | 0 | 0 |
| `sandbox-data` | 64/9/2 both | 0 | 0 | 0 |
| Document Output | see below | — | — | — |

The per-test oracle found **no member-level entry the fence produces and the hub does not**, which
is the signal a wrong mapping would give. Every difference ran the other way: the HUB emits
object-level entries for objects outside the target's own symbol reference (`Codeunit:71002`, and
fifteen Base App / test-framework objects on the table fixture). Filed as R61.

Read `sandbox-data` carefully, though: it passed on the fixture's SHAPE. Its fenced run named
exactly one member (`Codeunit:79199::Active`, the emitted selector) plus two object-level entries,
and its table-trigger mutants matched through `coverageFilter`'s `byObject` fallback. The hub is
equally memberless there, so the comparison is honest — it simply exercises almost none of the
line -> procedure mapping. Only `sandbox-app` does, on four members.

### Document Output

Both modes on `U:/Git/do-rel2/Cloud`, 56 baseline tests each. The hub reproduces the R37 benchmark
exactly (12 fail / 44 pass, 16/86/15/21); the fenced baseline is **56/56 green**. Per-mutant over
the 105 the fenced run reached, identity verified with 0 mismatches:

```
  0 x killed -> survived     <- the blocking criterion. HOLDS.
  0 x killed -> no-coverage
  4 x error  -> killed       <- gain
  7 x error  -> survived     <- gain
 77 x survived -> no-coverage  <- unresolved
```

The line map is not the cause, and this time that is measured: the instrumented codeunit is 3,177
lines (original 364) and BC's rows carry `lineNo` 30..3171, so the lines are in the INSTRUMENTED
frame — unknown #6, now settled properly rather than "by construction". Bucketing the 410 real rows
against the instrumented ranges names exactly the five procedures the run attributed; against the
original frame it names eleven, none of which match. The rows for the other eight procedures are
absent from the payload.

Two readings remain, with opposite consequences: the fenced session genuinely does not execute them
(R60 — headless takes the non-GUI branch, and then the hub's 77 `survived` verdicts were mutated
code that never ran), or fenced collection loses them (and R58 under-reports). All eight missing
procedures' covering tests pass on BOTH runners, so this is not R55's red-test mechanism. The
discriminating experiment — run one `CalcBalance` mutant through the fence against its five
fence-green covering tests — is named and not yet run.

Two process notes worth keeping. A `--resume` run is NOT a valid differential input: it carries
prior verdicts while recomputing attribution, so each row mixes two runs; used briefly here, it
manufactured three convincing "lost kills" that the fresh run showed were not real. And no CLEAN
COMPLETE fenced DO run exists, because mutant M0013 does not terminate (R53's class): each strand
latches the session unsafe so the tail is never recorded, and leaves an op marker that quarantines
the tier until an environment recycle + `force-reset-lease` + `clear-quarantine`.

`"fenced"` therefore stays opt-in and rollout step 5 does not start.

### Which unknowns are genuinely pre-build

Unknowns 1–3 could invalidate the DESIGN, and all three are now answered favourably: source lines,
object-relative frame, and `Start` clears. Nothing left can force a different architecture.

Unknowns 4–6 cannot be probed cheaply, and pretending otherwise would produce a probe that answers
an easier question than the one asked. Each needs a real test exercising the INSTRUMENTED TARGET
while coverage is on, and that is the production path itself:

- the probe app cannot reference the target (a test app depending on the target would break on
  `reserveAppVersion`'s per-run version), and invoking it by literal id runs an empty `OnRun`
- `sandbox-tests` exercises the target but does not collect coverage
- `RunMutant` does not collect coverage; only `RunMutantWithCoverage` does, and no client calls it
  yet

So they are **validation during step 2**, not gates before it: wire the transport to call the new
action, dump the raw payload, and read the answers off one real session. That ordering is safe
because none of the three can invalidate the design — they calibrate it:

- **#4 payload size / response time** decides whether server-side filtering by `idRanges` is
  required, not whether the approach works. It must be measured before the first DO run, because a
  slow baseline response is an `in-flight-unknown`, i.e. a durable quarantine (R44/R47).
- **#5 do target objects appear** would, if the answer were no, mean the server half is useless —
  but the R58 probe already saw a non-test object (its own) recorded, so the mechanism is not
  test-app-specific.
- **#6 instrumented vs original lines** is confirmed by construction the moment #5 is answered: the
  published artifact IS the instrumented source, so any line that resolves to a procedure resolves
  in that frame. The check is that resolved names are SANE, not that the frame is the other one.

## Rollout

1. ~~Probe unknowns 1–3~~ **done** — none invalidates the design.
2. Build `line-map.ts` + transport + backend + orchestrator routing behind `coverageMode: "fenced"`,
   answering unknowns 4–6 from the first real session's raw payload before wiring the map into
   `CoverageMap`.
3. Baseline-only coverage diff (the cheap oracle).
4. Differential per-mutant gate on DO **and** the table fixture.
5. **`"fenced"` becomes the default in the release after step 4 passes; the hub is deleted one
   release later.** A dated condition, not "consider" — the failure mode of opt-in here is not
   drift, it is *stall*: every frozen gate is green either way, so nothing forces the decision while
   the 14 lost mutants and the R59 exposure remain shipping behaviour.

## Decisions

1. **Mode name: `"fenced"`.** The existing `"none"` already encodes *routing* rather than
   granularity, so the union is a routing axis and `"fenced"` is consistent with it.
2. **The hub does not survive.** Keeping it as a periodic cross-check sounds cautious and is not:
   the hub measures a *different session type*, so the diff is permanently red-noisy (12/56 on DO)
   for reasons unrelated to any fenced-coverage bug — inviting exactly the R55-shaped misdiagnosis
   that took two roadmap items to untangle. The genuinely independent check is the R58 byte-identity
   probe, which survives as a probe fixture without keeping a production code path.
3. **Keep the raw line rows as a diagnostic artifact; collapse them for `CoverageMap`.** No
   per-statement attribution now. But the first time a line falls in no known range on a real
   project — and it will — the raw rows are the only evidence of what BC actually said.

## What this does not do

It does not fix R60 (verdicts describing the non-GUI branch is a property of running headless at
all, not of which runner collects coverage). It removes R59's *cause* rather than detecting it — if
decision 2 is reversed and the hub stays, R59 still needs a detector.
