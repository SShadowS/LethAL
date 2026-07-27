# Fenced-path coverage — the client half of R58

**Status:** design. The server half shipped 2026-07-28 (control app 1.0.0.8,
`RunMutantWithCoverage`). This specifies the client that consumes it.

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
  green set, then fails against every mutant it covers, and each reads as a KILL. Nothing detects it.

Feasibility is settled (R58): a fenced `ODataV4` session records coverage **byte-identically** to the
hub — `coverageRows=262 totalHits=67 ownObjectRows=44` on both paths.

## Architecture

One new coverage mode. The hub path stays exactly as it is.

```
coverageMode: "fenced"        (new, opt-in)
  baseline  --> RunMutantWithCoverage  --> {objectType, objectId, lineNo, hits}[]
                                            |
                                            v  line -> procedure
                                       CoverageMap (existing shape)
                                            |
                                            v
                                  buildCoverageIndex / coverageFilter   (unchanged)
  mutants   --> RunMutant (unchanged)
```

Nothing downstream of `CoverageMap` changes. That is deliberate: `coverageFilter`, its three
attribution paths and the `byObject` fallback are the parts R29 was fought over, and this work must
not reopen them.

## Components

| File | Change |
|---|---|
| `packages/runner/src/run-mutant-transport.ts` | call `RunMutantWithCoverage` when the caller asks for coverage; parse the `coverage` array |
| `packages/runner/src/bcdev-backend.ts` | `coverageMode: "fenced"`; route the baseline through the transport; build a `CoverageMap` from line data |
| `packages/runner/src/line-map.ts` *(new)* | `(objectType, objectId, lineNo) -> procedureName` from the instrumented source |
| `packages/runner/src/cli.ts` | accept `"fenced"` in the config's `coverageMode` union |

## The crux: mapping a line to a procedure

The hub returns a `methodId` and `AppMethodIndex` names it. The fence returns a **line number**.

The input is available locally: LethAL *wrote* the instrumented source into the batch dir, and
`project.ts` already computes `startLine` via `lineOfIndex`. So the map is built by parsing the
emitted files — the same files that were compiled and published — and recording each procedure's
line range per `(objectType, objectId)`.

**This is the step where a mistake becomes a wrong verdict rather than a missing mutant.** A line
attributed to the wrong procedure produces a confident, non-empty, wrong covering set — which is
precisely the R29 failure that made 10 of 20 fixture survivors false. Two rules follow:

1. **A line that falls in no known procedure range emits an OBJECT-level entry** (no `procedure`),
   never a guess. The hub path already does exactly this and its doc comment explains why dropping
   the observation instead was the original false-survivor bug.
2. **An object id with no line map at all is a caller-contract violation** — the artifact was
   compiled from source LethAL wrote — so it throws rather than silently degrading. Empty-vs-empty
   "matches" is this project's signature bug.

### Measure before building

Three things are unknown and must be probed, not reasoned about:

1. **What is `"Line No."`?** A 1-based source line of the published object, or an ordinal over
   executable statements? Everything depends on this. Probe: a codeunit whose executed statement
   sits on a known line, run it, compare.
2. **Which objects appear?** The R58 probe confirmed the *test* app's own object. The target app's
   objects must appear too, or fenced coverage cannot attribute anything useful.
3. **Do lines refer to the INSTRUMENTED source?** Almost certainly — that is what was published —
   but instrumentation shifts every line, so a map built from the original source would be wrong in
   a way that still produces plausible procedure names.

## Error handling

Consistent with the existing typed-error rules: fail loudly on caller-contract violations, never
return a plausible empty default. A malformed `coverage` payload, an unmappable object id, or a
`lineNo` outside every range in a file LethAL wrote are all bugs in LethAL, not in the user's
project, and must say so.

## Testing

Unit tests for `line-map.ts` (exact boundaries: first line of a procedure, last line, a line between
procedures, a line in a trigger, a nested procedure) plus the two rules above.

**The gate that actually matters is differential**, and it is the same experiment that answered R37:
run one real project twice, identical except `coverageMode`, and compare **per-mutant** across all
mutants. `mutantCode` is a valid join when both runs generate the same source into the same batching
(verify: 0 identity mismatches at the same code, as R37 did). The result to require:

- **no mutant moves from `killed` to `survived`** — that direction would mean fenced coverage lost a
  killing test, the R59 shape
- mutants moving `no-coverage -> survived/killed` are the expected GAIN (the 14)
- any `survived -> killed` is a mutant the hub path was under-reporting, also a gain

A pure unit-test pass proves nothing here: all four frozen gates have green baselines, so the whole
mechanism is a no-op for them — the same blindness R55's candidate fix had.

## Rollout

1. Probe the three unknowns.
2. Build `line-map.ts` + transport + backend behind `coverageMode: "fenced"`, opt-in.
3. Differential run on Document Output; require the per-mutant result above.
4. Only then consider making it the default, and only then consider removing the hub.

The hub stays until step 4 passes. It is the only thing that keeps today's measured behaviour
available for comparison, and a fenced-coverage bug with no comparison point is undetectable.

## Open decisions

1. **Mode name** — `"fenced"` reads as "how it runs" rather than "what it collects". Alternative:
   `"procedure-fenced"`, since it produces the same procedure granularity by another route.
2. **Does the hub survive long term?** Removing it deletes the asymmetry outright (R55/R57/R59) and
   removes a dependency, but it is also the only independent check on fenced coverage. Keeping both
   and diffing them periodically is the cautious option and costs a config knob.
3. **Line-level coverage is finer than procedure-level.** It could feed a future per-statement
   attribution, or be collapsed immediately and thrown away. Collapsing is simpler; keeping it is
   the kind of thing that is cheap now and expensive to retrofit.

## What this does not do

It does not fix R60 (verdicts describe the non-GUI branch — that is a property of running headless
at all, not of which runner collects coverage), and it does not by itself detect R59. It removes
R59's *cause*; a detector would still be needed if the hub is kept.
