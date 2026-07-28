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

## The unfiltered fenced-coverage payload does not return — R58 unknown #4, ANSWERED

`RunMutantWithCoverage` as first shipped (control app 1.0.0.8) serialized the WHOLE `Code Coverage`
table. Measured 2026-07-28 on Cronus281 against `fixtures/sandbox-app`, whose entire test body is
three lines:

| control app | object filter | headers returned | payload |
|---|---|---|---|
| 1.0.0.8 | none | **never within 300 s** | — |
| 1.0.0.9 | `79000..79199` (the artifact's `idRanges`) | **126 ms** | **1,546 bytes** |

The failure was not "slow", it was indistinguishable from a hung container: the client's fetch gave
up, `RunMutantTransport` classified it `in-flight-unknown`, and the baseline test was recorded
`error` — a durable tier quarantine. The whole session then reported `killed=0 survived=0
noCoverage=0`, i.e. the mechanism looked configured and produced nothing.

The cost is not the target's code. Inside `RunMutant` the platform records every line it executes,
which is the entire Test Runner + Test Suite Mgt + Base App machinery, so a three-line test and a
large one produce comparable tables. That is why the fix is filtering rather than a bigger client
timeout: the payload does not shrink with the work.

`RunMutantWithCoverage` therefore takes a `CoverageObjectIdFilter` (an AL `SetFilter` expression
over `"Object ID"`, built from the artifact's own `idRanges` — see `coverageObjectIdFilterOf` in
`bcdev-backend.ts`). It throws away nothing usable: only rows for objects the artifact DECLARES can
be attributed at all, and the client re-checks every row against the compiled package's
`SymbolReference.json` regardless, so a too-wide filter costs only bytes. A manifest with no
`idRanges` is REFUSED rather than sent as an empty filter — the empty filter is the hang.

The action also reports `coverageRunMs` / `coverageSerializeMs` / `coverageScannedRows` /
`coverageEmittedRows`. Those exist because the two costs behind the timeout — the platform RECORDING
and the control app SERIALIZING — look identical from the client, and only one of them is fixable by
filtering.

## Fenced vs hub coverage, per test and per mutant (R58's differential gate)

`scripts/probe-r58-differential.ts` runs one fixture through `runSession` twice, identical except
`bcdev.coverageMode`, and dumps per-test coverage sets, per-mutant verdicts, covering-test sets and
attribution. `scripts/probe-r58-compare.ts` applies the gate rules (blocking: any `killed` ->
`survived`, any `mutantCode` identity mismatch, a fenced baseline red where the hub's was green).

Measured 2026-07-28, control app 1.0.0.9:

| fixture | verdicts | covering-set changes | attribution changes | identity mismatches | member entries the fence named |
|---|---|---|---|---|---|
| `sandbox-app` (Cronus281) | 3/10/3 both | 0 | 0 | 0 | 4, matching the hub |
| `sandbox-data` (Cronus283) | 64/9/2 both | 0 | 0 | 0 | **1**, and it is LethAL's own selector |

The per-test oracle found **no member-level entry the fence produces and the hub does not** — the
signal a wrong line -> procedure mapping would show up as. Every difference was the opposite
direction and object-level: the HUB emits `Codeunit:71002` (LethAL's own control app) and, on the
table fixture, fifteen more object-level entries for Base App / test-framework objects
(`Codeunit:198`, `Codeunit:423`, `Codeunit:2000000002`, `Table:5330`, …). Those come from
`buildCoverageMap`'s object-level fallback firing on objects that are not in the target's symbol
reference at all; the fenced path drops them by scope. They changed no mutant's covering set, which
is why they had never been visible. Filed as R61.

**Read the last column before trusting the table.** `sandbox-data` passing proves less than it
looks: the fenced run named exactly one member (`Codeunit:79199::Active`, the emitted selector
codeunit) plus two object-level entries, and its verdicts matched because table-trigger mutants
take `coverageFilter`'s `byObject` fallback, which object-level entries satisfy. The hub is equally
memberless there — `SymbolReference.json` records no trigger — so the comparison is honest, but it
exercises almost none of the line -> procedure mapping. Only `sandbox-app` does, on four members.

### Continia Document Output — the differential runs, and the news is mixed

Both modes on `U:/Git/do-rel2/Cloud`, one codeunit in scope, 56 baseline tests each:

| | baseline | killed | survived | no-coverage | error |
|---|---|---|---|---|---|
| `procedure` (hub) | **12 fail / 44 pass** | 16 | 86 | 15 | 21 |
| `fenced` | **56 pass** | 4 | 8 | 92 | 1 |

The hub column reproduces the R37 benchmark exactly, so the reference is sound, and the fenced
baseline being fully green is R55's premise confirmed on one run pair.

Per-mutant, over the 105 mutants the fenced run reached (identity verified on `mutantCode` + file +
line + operator, **0 mismatches**):

```
  0 x killed -> survived        <- the blocking criterion. HOLDS.
  0 x killed -> no-coverage
  4 x error  -> killed          <- gain: mutants the hub could only score through a red test
  7 x error  -> survived        <- gain, same cause
 77 x survived -> no-coverage   <- the open question
```

**The line map is NOT the cause, and that was measured rather than argued.** The instrumented
`Codeunit 6175297` is 3,177 lines (the original is 364; instrumentation injects a guard per site),
and BC's rows for that object carry `lineNo` 30..3171 — so the lines ARE in the instrumented frame,
settling unknown #6 properly this time. Bucketing the 410 real rows against the instrumented
procedure ranges names exactly the five procedures the run attributed
(`SendPeriodStatements`, both `ChangeAut*ToManual`, `CreateStatement`, `IsCustomerStatementReport`);
bucketing them against the ORIGINAL frame names eleven, none of which match what the run produced.
The map is doing precisely what the payload supports.

**The 77 are discriminated (2026-07-28), and the answer was already in the dumps — the fence is
RIGHT, the hub's covering sets were false.** Inverting the hub dump's per-mutant `coveringTests`
into per-test procedure sets shows the five `ChangeAutomaticToManual_*` tests sharing ONE IDENTICAL
11-procedure set — the `CreateOrSendAutStatements` call tree plus the two `ChangeAu(t)omaticToManual`
they genuinely execute. An identical set across five tests with different bodies is not genuine
per-test coverage, and it is proven false for `...WhenNoLastDate...`: it calls
`ChangeAuatomaticToManual('CUST001', 0D, ...)`, whose callee's first statement is
`if LastDate = 0D then exit;`, and its setup library only INSERTs records — so nine of the eleven
are unreachable from it on ANY runner. The client-side mechanism is precise:
`buildCoverageMap` (bcdev-backend.ts) selects the payload entry with
`wireCoverage.find(e => e.testObjectId === testCodeunitId)` and never matches `testMethodId`,
though the wire protocol keys coverage entries per method — so with a multi-entry payload the
requested test is credited with another method's coverage (filed as R63).

So the two readings collapse: the hub's 77 `survived` verdicts were **vacuous** — mutants scored on
the fence against tests that never executed the mutated code — and fenced `no-coverage` is the
correct verdict. DO's suite genuinely never executes those nine procedures on either runner: every
test that tries flips the customer to Manual at the `ChangeAuatomaticToManual` early-exit or stops
at the negative-balance guard. The 77 are a Document Output test-gap finding, not a LethAL defect.
The fence's per-test attribution is precise everywhere it can be checked: its 13 covered mutants
are exactly `SendPeriodStatements` (12) plus one object-level entry — the only procedures with
mutants that any green fence test reaches.

**The discriminating experiment previously named here would have been misread, and that is worth
recording.** The plan was to run mutant M0120 through the fence against its five covering tests and
read `attestation.observedAny` as mutant-specific: `false` = never executed, `true` = executed.
But `observedAny` is set by ANY guard (`ControlState.IsActive` sets it before the mutant-id check),
and M0120's hub-mode runs already carry `guardObserved: true` — because the five tests execute
`ChangeAutomaticToManual`'s guards whether or not `CalcBalance` runs. Had that experiment been run
first, `true` would have "confirmed" the fence-loses-collections hypothesis and sent the
investigation after a defect that does not exist. The call-tree proof above is stronger and was
cheaper.

**A methodological note worth keeping.** A `--resume` run was briefly used as a gate input and
appeared to show three lost kills (`M0017`, `M0132`, `M0137`). It showed nothing of the sort:
`--resume` carries prior verdicts while recomputing attribution, so the two halves of each row came
from different runs. Resumed runs are not valid differential inputs. Caught only because the numbers
disagreed with the fresh run.

**Why a clean, COMPLETE fenced DO run does not exist:** mutant M0013 does not terminate (stranded at
both the 30 s and 120 s budgets, R53's class), and each strand latches the session unsafe, so the
tail of the mutant loop is never recorded — 105 of 138. Each strand also leaves an op marker that
quarantines the tier until an environment recycle + `force-reset-lease` + `clear-quarantine`.

### Diagnostics added because none of the above was visible

- **`LETHAL_FENCED_COVERAGE_DUMP=<path>`** — spec decision 3's raw-row artifact (JSONL, one record
  per test), which the first implementation skipped. It is the only thing that can distinguish the
  two remaining explanations.
- **A per-test warning** naming the two ways fenced coverage comes back useless while every layer
  reports success: rows arrived but NONE for a declared object (blame the object-id filter), versus
  declared-object rows arrived but no line resolved to a member (blame the line map's base frame).
  Silent on DO, which is itself the finding — the failure there is narrower than either.

### Two blockers that were not what they looked like

- The hub reference first failed with an Azure-token error. **The NST does not require Entra:**
  `Microsoft.Dynamics.Nav.Service.Dev.dll`'s `DevHostStartup` registers the shared
  `NavAuthentication` scheme, and `WebServiceCredentialsHelper.ValidAuthenticators`
  (`Microsoft.Dynamics.Nav.Service.dll`) adds `WebServiceBasicAuthenticator` whenever
  `ClientServicesCredentialType` is `NavUserPassword`/`AccessControlService`, adding Bearer only
  when `AppIdUri` **and** `WSFederationMetadataLocation` are both set. On these servers Bearer is
  never constructed. The real cause: bc-dev-mcp merges `.vscode/launch.json` first, and
  `U:/Git/DO/Cloud`'s configurations[0] is a Microsoft cloud sandbox (`Sandbox`/`TestAct`) while
  LethAL never overrides `environmentType`/`environmentName`. `do-rel2` has one OnPrem-shaped
  portal config and takes Basic.
- Mutant **M0013** does not terminate (stranded at both 30 s and 120 s budgets, R53's class). Each
  strand leaves an op marker that quarantines the tier, needing an environment recycle +
  `force-reset-lease` + `clear-quarantine` to clear.
