# Measurements

Probe sources kept so a claim can be re-checked rather than re-argued. A measurement nobody can
re-run is barely better than a guess.

## `object-kind-selector-var-probe.al` — which AL object kinds can carry the selector var

Answers R40. `canCarryMutationSelectorVar` (`packages/schemata/src/compile.ts`) refuses every
object kind but codeunit and table, stating that no other kind can carry
`var MutationSelector: Codeunit "Mutation Selector";` and that a guard in one "cannot compile
(AL0118)". On Continia Document Output that refusal costs 41% of the app's mutation sites.

This probe declares that exact var inside a `page`, a `pageextension`, a `tableextension` and a
`report`, each with the var placed AFTER the kind's structural sections.

**Result (2026-07-27, `alc 17.0.29.44223`, platform/application 28.0.0.0, runtime 17.0):**
exit 0, zero errors, artifact produced. All four kinds accept the declaration.

So the stated reason is wrong. The real constraint is anchor POSITION within the object — the
same thing R38 turned out to be for codeunits, where the var had to follow the object's
properties. Recovering the 41% is anchor work plus operator coverage of those bodies, not a
language limitation.

Re-run:

```sh
alc /project:<this dir's parent copy> /packagecachepath:<symbols> /out:probe.app
```

Note the probe compiles only; it does not prove the guard EXECUTES correctly in those kinds, which
is a separate live question.

## `tableextension-coverage-probe.al` — where BC attributes an extension's coverage

Answers the blocker that keeps the extensions half of R40 open. `coverageFilter` keys on
`(objectType, objectId)`; if a `tableextension`'s code were reported under the BASE table's id,
keying its mutants on the extension id would find no coverage and report every one as
`no-coverage`, while keying them on the base id would merge two objects' coverage. Guessing wrong
is the R29 failure — the one that produced 10 false survivors out of 20.

The probe declares a base table with `BaseBump()`, a tableextension with `ExtBump()`, a driver
codeunit calling both, and one `[Test]` exercising them, then reads the coverage BC returns.

**Result (2026-07-27, hosted Continia BC 28, `coverage: "procedure"`):**

```
Table:79480      base table       seen
Codeunit:79482   driver           seen
15:79481         tableextension   seen, under its OWN object id
```

Two findings:

1. **Extension code IS attributed to the extension's own id**, not the base object's. Keying
   extension mutants on the extension id is therefore correct.
2. **`objectType` arrives as the raw numeric `15`** (BC's TableExtension object-type enum), not a
   name. LethAL's manifest writes `"tableextension"`, so the two keys would not match and every
   extension mutant would silently become `no-coverage`. That — not the attribution question — is
   the real work remaining: `buildCoverageMap`/`normalizeObjectType` must map BC's numeric
   extension types, and it must be a mapping that FAILS LOUDLY on an unknown type rather than
   defaulting, since a silent mismatch is indistinguishable from "nothing covered this".

`procedure` came back `undefined` for all three objects, i.e. object-level attribution only, so an
extension mutant would additionally depend on `coverageFilter`'s object-level fallback.

## `session-capability` — why two runners disagree (R57)

`fixtures/sandbox-probes/src/SessionCapabilityProbe.Codeunit.al` reports `GuiAllowed`,
`CurrentClientType`, `CompanyName` and `UserId` from inside a `[Test]` body, so whatever the runner
did to the session is what gets reported.

It exists because R55 measured that 12 of 56 Continia Document Output tests fail through the
bc-dev-mcp hub and pass through LethAL's fenced `RunMutant`, order-independently, and the most
informative failure is `Unhandled UI: Confirm ... has not been activated` raised in test codeunits
that declare no handler functions at all. BC raises `Unhandled UI` for a `Confirm` only in a session
it treats as INTERACTIVE; a non-GUI session returns the default silently and the caller takes the
other branch. Session capability is therefore the prime suspect — and unlike the alternatives it can
be measured directly instead of argued about.

Run it by pointing a session's `--tests` at `fixtures/sandbox-probes` and running the same target
twice, changing only `bcdev.coverageMode`:

- `"procedure"` routes the BASELINE through the hub
- `"none"` routes it through the fence

The probe raises its values as an `Error`, so the test shows as FAILED — that is the transport, not
a broken probe. Compare the two messages.

It lives in `sandbox-probes` deliberately: that fixture is published and driven separately and is
not part of any frozen mutation baseline, so adding a test to it cannot move `itest:bcdev` or
`itest:tables`. Adding it to `sandbox-tests` would have.

## `gui-guard-probe.al` — the positive control for `measure-gui-guarded.ts` (R60)

`scripts/measure-gui-guarded.ts` counts mutation sites sitting behind a `GuiAllowed`/`Confirm`
guard. **Run it against this file before trusting any run that reports a low number.** It must
report `1` guarded of `3` sites (the `exit(A + 1)` inside the guarded branch) and `3` in a
GUI-mentioning procedure:

```
bun scripts/measure-gui-guarded.ts <a project dir containing gui-guard-probe.al>
```

The control exists because the script reported a confident **0.0% twice** before it was correct,
for two independent reasons, and neither is visible by reading the output:

1. `children[0]` of an `if_statement` is the `if_keyword` (text `"if"`), not the condition — so no
   condition ever matched the GUI pattern.
2. `MutationSpec` carries **no** `startIndex`. Position lives on `spec.before` (whose `astNodeId`
   is literally `"<start>-<end>"`). Reading `spec.startIndex` yields `undefined`, so every
   containment test is false.

A zero produced by a broken predicate is indistinguishable from a zero meaning "this project has no
such code" — and the second reading is the reassuring one, which is how it would have been believed.

Measured on Continia Document Output (554 `.al`, 20,032 sites): **66 guarded (0.3%)** lower bound,
**1,149 (5.7%)** in procedures mentioning an interactive construct. `fixtures/sandbox-app` reports
0/0, correctly — it contains no interactive AL.

## `r58-coverage-feasibility-probe.al` — can the fenced path collect its own coverage? (R58)

**Yes.** Compiles clean (3,342-byte artifact) against `LethAL Control`'s existing symbol set, whose
only declared dependency is Microsoft's `Test Runner`. **No new dependency is required.**

Resolved, all of it:

| API | Verdict |
|---|---|
| `Codeunit "Code Coverage Mgt."` | available |
| `.StartApplicationCoverage()` / `.StopApplicationCoverage()` | available — the start/stop shape `RunMutant` needs around a test invocation |
| `Record "Code Coverage"` | available |
| `"Object Type"` (an **Option**, not an enum — no `AsInteger()`), `"Object ID"`, `"Line No."`, `"No. of Hits"` | available — `(objectType, objectId)` plus per-line granularity and a hit count, which is what `buildCoverageMap` keys on |

Two guesses were wrong and are recorded because the next person will make them too: `"Line Type"`
has no `Function` member, and `"Object Type"` is an Option, so `.AsInteger()` does not compile.

### What this does and does not establish

It establishes that the API is REACHABLE and shaped correctly. It does **not** establish that
coverage collected inside a `RunMutant` OData session is *complete* — the fenced path runs as
`GuiAllowed=No`, `ClientType=ODataV4` (R57), and nothing here proves the platform records the same
observations there as it does on the hub. That is the next measurement, and it should be made
before any protocol work: an R58 built on an assumption would repeat R55's first framing.

Line-level coverage is also finer than the current `procedure` granularity, so mapping
`"Line No."` back to a procedure needs the compiled artifact's symbol data the way
`app-package.ts` already does for the hub payload.

## `sandbox-coverage-probe` — does the FENCED session record coverage? (R58)

**Yes, identically to the hub.** `fixtures/sandbox-coverage-probe` starts application coverage,
exercises a procedure it owns, stops, and reports what the `Code Coverage` table holds. Run through
both paths on Cronus281, same target, same config, only `bcdev.coverageMode` differing:

```
procedure (HUB)  :  coverageRows=262  totalHits=67  ownObjectRows=44
none      (FENCE):  coverageRows=262  totalHits=67  ownObjectRows=44
```

Byte-identical, including the 44 rows for the probe's own codeunit 79320. R57 independently
established that these are genuinely different sessions — `GuiAllowed=Yes/Web` on the hub versus
`No/ODataV4` on the fence — so this is not the same path measured twice.

This was R58's last open unknown, and it was a real one: the fenced session differs from the hub in
ways that DO change behaviour (R55's 12 failing tests), so "the API compiles" did not imply "the
API works there".

### What remains implementation, not feasibility

`Code Coverage` is LINE-level (`"Line No."`), while the hub returns procedure-level. Mapping lines
back to procedures needs the compiled artifact's symbol data, which `app-package.ts` already does
for the hub payload — so the machinery exists, but it is work, not a question.

The probe lives in its own app rather than `sandbox-probes` because that fixture declares
runtime 13.0 with no platform/application, so the `Test Runner` symbol carrying
`Codeunit "Code Coverage Mgt."` does not resolve there — and it is published for the frozen
`itest:bcdev` gate, which is not worth perturbing for a probe.
