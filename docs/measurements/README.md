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

## R63 — why the hub credited tests with procedures they cannot execute

Filed first as "`buildCoverageMap` matches coverage by codeunit, never by method" and **measured
wrong before any fix was written** — the standing warning applied to the roadmap's own hypothesis.

**Probe** (`packages/runner/scripts/probe-r63-hub-payload.ts`, raw `bcdev_test_run` payloads,
sandbox fixture on Cronus281 and Document Output's codeunit 68929 on the BC28 environment):

- A single-method run returns exactly ONE coverage entry, keyed by a STABLE per-method
  `testMethodId` (`ClampPercentRuns` = -853933102 across calls and across single/multi-method
  runs), with per-method-correct content. No multi-entry payload, no cross-call accumulation.
- On DO, `ChangeAutomaticToManual_WhenNoLastDate_ShouldReturnFalse` — a test that provably exits
  at its callee's first statement — is credited by the SERVER with 67 procedures, but its
  target-codeunit (6175297) subset is exactly `ChangeAuatomaticToManual` + one unresolved
  methodId: correct. The server's per-method attribution is fine.
- The 11-procedure sets from the differential are EXACTLY `{the one genuinely-executed public} ∪
  {all ten LOCAL procedures of 6175297}`. The expansion in `buildCoverageMap` — credit EVERY local
  in the object when one methodId fails to resolve — manufactured them.

**Why locals are unresolvable:** DO's compiled `SymbolReference.json` lists exactly the 5 public
methods of 6175297 with hash-like ids (`ChangeAuatomaticToManual` = -1870514509). Locals carry the
same hash-shaped ids (`ChangeAutomaticToManual` = 1921874138, pinned empirically — it is the only
other 6175297 member in the test's entry) but appear NOWHERE in the symbol file, and the hash did
not yield to java/djb2/fnv/crc32/dotnet-classic candidates (recorded so nobody re-tries blindly).

**The fix and its own measured trap:** deleting the expansion (emit object-level instead) moved
the fixture's three `LogAudit` mutants `survived -> no-coverage` live — a frozen-gate failure,
because `coverageFilter`'s object-level fallback is trigger-only and `LogAudit` IS executed
(weakly — the fixture's designed survivors). So the manifest now carries `procedureScope` and the
fallback covers local-procedure mutants at object grain, gated on `=== "local"` so public
procedures (whose member-miss means genuinely-unexecuted) are never widened. The un-gated version
went red on three tests including the pre-existing doctrine pin "an ordinary procedure mutant is
NOT credited by an object-level-only entry". Frozen gates re-verified per-mutant on the shipped
code: `itest:bcdev` 3/10/3, `itest:tables` 64/9/2 (`untargetedTriggers` 0), `itest:alrunner` 3/13/0.

---

## R59 — the unsafe direction of the runner disagreement, reproduced live (2026-07-31)

R59 predicts a **false kill**: a test the hub passes and the fence fails enters the green set, then
"fails against every mutant it covers on the verdict path, and each of those reads as a KILL".

**Built the case and ran it.** A throwaway `[Test]` on `fixtures/sandbox-tests`
(`if not GuiAllowed then Error(...)`, then a call into `Sandbox Pricing.DiscountedPrice`, which no
other test touches) published to Cronus281, run with `coverageMode: "procedure"`. It is hub-green by
construction (hub = `GuiAllowed=Yes`/`ClientType=Web`, R57) and fence-red (`GuiAllowed=No`/
`ClientType=ODataV4`), and it is the SOLE covering test of that procedure's three mutants.

| | measured |
|---|---|
| the three `Sandbox Pricing` mutants | **`error`, `cause=unstable`** — never `killed` |
| score line | `killed 3, survived 10, no-coverage 0, error 3 [unstable 3]` |
| session report | `RUNNER DISAGREEMENT: 1 test(s) …`, `runnerDisagreement.tests` = the test |

**So the entry's hazard does not exist**, and it has not since Layer 5C-A: a kill requires the
kill-confirmation rerun — `activate(null)` then the FENCED transport — to PASS, so a fence-red test
cannot produce one. What was real is the DIAGNOSIS: the run said only "unstable", which reads as
flakiness in the user's own suite.

**Control, same container, same fixture with the throwaway test removed:** `coverageMode: "procedure"`
returns **3 killed / 10 survived / 3 no-coverage**, per-mutant identical to the fenced gate across
all 16 mutants (0 differing), with no disagreement diagnosis emitted — the detector is silent when
the two runners agree. `itest:bcdev` 3/10/3 and `itest:tables` 69/9/6 both re-verified afterwards.

---

## R69's go/no-go — how many mutants are covered ONLY by TestPage tests? **2.30%**

`scripts/measure-testpage-exclusive.ts` (denominator + census) plus the two live coverage runs
described below. The threshold — **>= 5% continues R69, < 5% closes it** — was written into
`ROADMAP.md` at `49c2ec0` **before the number existed**, because this row had already produced five
retracted over-generalisations and a pre-commitment is the only thing that stops a result being
rationalised afterwards.

**Measured 2026-08-02** on Continia Document Output (`U:/Git/do-rel2`, Cloud at 28.4.0.0 — the
version the environment actually runs), through the hub (`bcdev_test_run`, `coverage: "procedure"`),
on the `lethal-do-trial` Continia environment `f19aca88`:

| | mutants | share of 19,081 |
|---|---|---|
| covered by a TestPage test (generous bound) | 980 | 5.14% |
| covered by some other test | 5,975 | 31.31% |
| covered by no test at all | 12,667 | 66.39% |
| **covered EXCLUSIVELY by TestPage tests** | **439** | **2.30%** |

Variants, none of which reach 5%: excluding the 137 `.dependencies` files whose objects belong to
other apps, **370 of 15,331 = 2.41%**; adding every mutant of the one page whose TestPage test could
not run (below), **452 = 2.37%**.

### Method

1. **Denominator** — `generateMutationSet` then `writeInstrumentedProject`, the same path a real run
   takes, so the count is post-dedup: **19,081 deployable mutants** over 554 `.al`
   (codeunit 7,328 · page 5,556 · table 3,908 · pageextension 1,228 · report 572 ·
   tableextension 489).
2. **Numerator** — two hub runs, one MCP session per test codeunit: the 19 TestPage tests, then
   every other test (1,197 executed). Coverage classified with `coverageFilter`'s own precedence
   (public procedure = member hit only; local = member else object-with-unresolvable-member;
   trigger = member else object-touched), so the figure means what a run would report.
3. Exclusive = covered by (1) and not by (2).

### What bounds it, stated because it bounds the result rather than decorating it

- **The suite is not complete.** One of 76 test codeunits (68961) died with `Connection closed`, so
  its tests contributed no coverage. That can only make the exclusive set LOOK BIGGER — the missing
  direction is safe for a "close it" decision.
- **One of the 19 TestPage tests does not exist on the server.** The environment runs test app
  29.0.0.0 while the source tree is 28.4-era, and `EMailJobsPage_QueueScheduleNotEditable_WhenFlagOn`
  is absent from the server's codeunit 68945 (24 methods, none of them that one). Bounded above by
  giving it every mutant of the page it drives (`page 6175294`, 13 mutants) — 2.37%, still below.
- **Locals are invisible at member level** (R63): 219,904 of 227,143 coverage rows could not resolve
  to a name. Handled by mirroring the byObjectUnnamed fallback rather than ignored.
- A first attempt at the non-TestPage run was **invalid and looked fine**: one long-lived MCP client,
  whose first call timed out, after which every call returned instantly with an empty payload. That
  reads downstream as "these 1,200 tests cover nothing" — indistinguishable from a real zero. It was
  caught only because `covered by some other test: 0 (0.00%)` is impossible. Hence one session per
  codeunit, and a per-codeunit `ran N, coverage entries M` line in the log.

### Reproducing

```sh
# denominator only
bun scripts/measure-testpage-exclusive.ts U:/Git/do-rel2/Cloud
```

The live half needs a running environment with the app under test published, credentials from
`continia env users <id> --json`, and `bc-dev-mcp` spawned with `BC_DEV_USER`/`BC_DEV_PASSWORD`
(see `env-tool-session.ts`'s `startEnvToolSession`). Its per-test coverage feeds the same script.

### A side finding worth keeping

**R76's "cannot be reproduced against any checkout on this machine" was wrong.** The
"9 of 104 test files" figure reproduces EXACTLY against `U:/Git/do-rel2/Test`
(`grep -rl TestPage` = 9, `.al` files = 104) — R76 was looking at `U:/Git/DO`, a different and much
smaller checkout (38 files, 146 tests). The figure was still misleading, but for a different reason
than "unreproducible": only **5** of those 9 files contain a TestPage TEST; the other 4 mention
`TestPage` elsewhere. Per test, it is 19 of 1,287 — **1.5%**, not 9%.

---

## R72 — what BC actually does when `Codeunit.Run` is called in a write transaction

`fixtures/sandbox-probes/src/WriteTxnProbe.Codeunit.al` (+ `WriteTxnTarget.Codeunit.al`). Three
tests, not one: the first attempt used a single test and produced a message at an AL-callstack line
that maps ambiguously onto the source, so the failing statement could not be named. Decoding AL's
line numbering would have been a guess; isolating the variable by A/B is cheaper and conclusive.

**Measured 2026-08-02, Cronus281, BC 28, both runners:**

| test | shape | result |
|---|---|---|
| `WriteOnly` | write, no `Codeunit.Run` | reaches its own `Error` — the write alone is fine |
| `RunOnly` | `Codeunit.Run`, no preceding write | `ran=Yes` — the call alone is fine |
| `WriteThenRun` | write, then `Codeunit.Run` | **aborts**, `An error occurred and the transaction is stopped. Contact your administrator or partner for further assistance.` |

Identical text on the HUB (`bcdev_test_run`) and on the FENCED `RunMutant` path — the per-runner
pin R72 asked for, and the two agree.

### Three findings, two of which change the detector R72 proposed

1. **The refusal is real.** BC does stop the transaction when `Codeunit.Run` is called with a write
   open. That much of R72's premise holds, and it had never been observed on this platform.
2. **It is NOT catchable, and that REFUTES half the stated hazard.** `Ran := Codeunit.Run(...)` does
   not return `false` — the error escapes and the test dies before the next statement. So the
   adversarial hole R72 was written to survive — `if not Codeunit.Run(...) then Error(PostFailedErr,
   GetLastErrorText())` re-wrapping the artifact in the caller's own message — **cannot occur for
   this artifact**: the caller never regains control to re-wrap anything.
3. **The text is BC's GENERIC transaction message**, not a specific "cannot run a codeunit in a
   write transaction". It names neither `Codeunit.Run` nor the rule. A detector keyed on that string
   alone would therefore fire on any platform-stopped transaction, and would mislabel genuine kills
   as platform noise — the unsafe direction for a diagnosis whose whole purpose is to tell the two
   apart.

### What the detector must therefore be

Condition on the OPERATOR, not on the text alone: for a `lethal.remove-commit` mutant whose deleted
`Commit()` precedes a `Codeunit.Run`, this message is strong evidence of the platform artifact; for
anything else it is not evidence at all. Verdict stays `killed` regardless (design §6.7's timeout
precedent: a diagnosis must not move a verdict), and the note is worded best-effort.

That detector cannot be PROVEN until a `remove-commit` mutant exists in a gate, which is R73's job —
no fixture has ever generated one. So R73 comes first, and R72's detector is written against a real
mutant rather than a constructed string.

---

## R73 — does a committed write survive a later uncaught error? **Yes**, and that is `RemoveCommit`'s kill mechanism

`fixtures/sandbox-probes/src/CommitProbe.Codeunit.al`. Measured 2026-08-02, Cronus281, identical on
the hub and the fenced path:

| test | shape | result |
|---|---|---|
| `CommittedWriteSurvivesLaterError` | write, `Commit`, raise | `committedWriteSurvived=Yes` |
| `UncommittedWriteIsRolledBack` | write, raise (no `Commit`) | `uncommittedWriteSurvived=No` |

The control is the point: the second shape is exactly what a `remove-commit` mutant produces, so a
transaction-boundary test that asserts the row survived CAN kill one. Measured before the fixture
was written, because if the isolation runner had rolled back committed writes too, that fixture
would have failed unmutated and the red baseline would have been blamed on the wrong thing.

Live result: `fixtures/sandbox-data`'s `Data Commit Ops.CommitThenFail` now carries the first
`lethal.remove-commit` mutant any gate has **killed** (`itest:tables`, killed by
`Data Tests.CommittedWriteSurvivesFailure`).

### The surprise, and it contradicts R72

The SECOND site — `CommitThenRun`, a `Commit()` immediately before a `Codeunit.Run` — was predicted
to die of the platform's write-transaction refusal measured under §R72. **It SURVIVED.**

The two measurements are both real and they disagree because the SHAPE differs:

| where the write and the `Codeunit.Run` sit | refused? |
|---|---|
| both in a `[Test]` method (`sandbox-probes`) | **yes** — "An error occurred and the transaction is stopped." |
| both in an ordinary codeunit called from a test (`sandbox-data`) | **no** — the call goes through, the callee flags the row, both assertions pass |

So R72's premise — "deleting a `Commit()` before a `Codeunit.Run` makes the platform refuse the
call" — is TRUE in one shape and FALSE in another, and the probe's shape did not generalise. That is
the same over-generalisation pattern this file exists to catch, caught this time by a fixture
disagreeing with a probe rather than by review.

**Consequence: R72's detector is still not built, and should not be.** There is no reproduction of
the artifact in a mutant a gate generates, so a detector would again be proven only against a
constructed string. What is needed first is a measurement of WHICH shape triggers the refusal —
call depth, `TableNo`, the test runner's own transaction, or something else — because a diagnosis
that fires on the wrong shape mislabels genuine kills as platform noise.

### ANSWERED 2026-08-08: it is the RETURN-VALUE FORM, not the shape either row guessed

`scripts/r72-probe/` — a 2 x 2 x 2 over prior `Commit()`, call frame and `Codeunit.Run` form,
measured on **Cronus281** (BC 28.0.46665.49944, `LethAL Control` 1.0.0.16) through the fenced path.
Full table and controls in that directory's README.

| | value form `Ran := Codeunit.Run(X)` | statement form `Codeunit.Run(X);` |
| --- | --- | --- |
| write opened in the `[Test]` body | **ABORT** | survives |
| write opened in a callee, called from the test | **ABORT** | survives |

Both rows hold with and without a prior `Commit()` in the test, so eight cells collapse onto ONE
factor. Controls: the value form with no write open succeeds and returns `Yes`; the write alone with
no `Codeunit.Run` succeeds.

**The frame is measured IRRELEVANT.** That is the variable the table above and R72's own row both
named, and it is not the one. What actually differs between the two prior measurements is that every
aborting arm consumed `Codeunit.Run`'s Boolean return value (`Ran := Codeunit.Run(...)`) and
`Data Commit Ops.CommitThenRun` calls it as a bare statement.

**Consequence for the detector.** The trigger is a syntactic property of the call site, visible
before anything runs: a `lethal.remove-commit` whose following `Codeunit.Run` CONSUMES its return
value. That is much sharper than the operator-plus-corroborating-text rule below, which was written
when the trigger was unknown. It is still not buildable against anything real, for an unchanged
reason: no fixture holds a `remove-commit` site in the value form, so the artifact cannot be
produced by a mutant any gate generates.

---

## R13 — can a `Permissions` property refuse anything, and is a `LockTable` deletion observable?

`fixtures/sandbox-probes/src/Tier3{Probe,RestrictiveProbe,RestrictiveGranted,PermReduced,PermGrant,PermNone}.*.al`.
Measured 2026-08-02 on **Cronus281** (BC 28.0.46665.49944, `LethAL Control` 1.0.0.14, probes
1.0.12.0) through the **fenced** path — `LethALControl_RunMutant` at baseline (`mutantId: ""`), one
call per method, which is where every verdict this tool issues is produced.

Both questions decide whether a sketched Tier-3 operator can ever kill a mutant.

### `PermissionReduce` — seven arms, one variable each

The operator weakens an object's `Permissions` property. It can only kill if that property can
REFUSE something. R1 had already measured that the fenced runner's user is SUPER and that a test
declaring `TestPermissions = Disabled` writes freely; what nobody had measured is whether a
PRODUCTION object's own reduced grant refuses anyway.

| arm | test codeunit | the called object's `Permissions` | result |
|---|---|---|---|
| A1 | `TestPermissions = Disabled` | `tabledata 79201 = r` (a `PermissionReduce` mutant) | **inserted** |
| A2 | `TestPermissions = Disabled` | `tabledata 79201 = rimd` (the unmutated form) | inserted |
| A3 | `TestPermissions = Disabled` | none at all | inserted |
| A4 | omits `TestPermissions` (→ Restrictive) | `= r` | refused — `(TableData 79201 Rec XRec Probe **Insert**: …)` |
| A5 | Restrictive | `= rimd` | refused — `(TableData 79201 Rec XRec Probe **IndirectInsert**: …)` |
| A6 | Restrictive | none | refused — `…Insert: …` |
| A7 | Restrictive, declaring `Permissions = tabledata 79201 = rimd` **on itself**, writing directly | — | refused — `…IndirectInsert: …` |

Verbatim refusal text, all four refusing arms:
`Sorry, the current permissions prevented the action. (TableData 79201 Rec XRec Probe <op>: LethAL Sandbox Probes)`.

**Two findings from these seven arms — and a third mode they do not cover, measured below.**

1. **Under `TestPermissions = Disabled` with a SUPER session the property is inert.** A1, A2 and A3
   are indistinguishable. That is the mode real suites declare — Continia Document Output: **76 of
   76** test codeunits (the 77th object matching `Subtype = Test` is a `TestRunner`, which declares
   no `TestPermissions`; `ROADMAP.md` R1's "77 of 77" is off by that one).
2. **Under Restrictive the property IS read — and it still cannot produce a kill.** A5 differs from
   A4/A6 in one token: BC demands `IndirectInsert` instead of `Insert`, which is the object's grant
   doing real work (an object property grants *indirect* rights; the caller must still hold at least
   indirect permission). But every restrictive arm is refused, mutated or not, so such a suite fails
   at BASELINE and its mutants never reach a verdict.

### The third mode — the suite lowers its OWN session, and there the mutant KILLS

The seven arms above supported the sentence *"there is no third mode"*, which an adversarial review
of the R13 decision refuted by pointing at the censused project itself:
`U:/Git/do-rel2/Test/Src/E-Seal/CDOESealSetupTests.Codeunit.al` declares `TestPermissions =
Disabled` — so it is inside finding 1's evidence — and then calls
`LibraryLowerPermissions.SetO365Basic()` in its own `Initialize()`. Permission checks are then ON
and the session is not SUPER while production code runs.

`scripts/r13-probe/` (a standalone probe app, ids 71500–71510, depending on `Tests-TestLibraries`
and `Permissions Mock`) reproduces exactly that shape. The table is Microsoft's `Item` (27), not a
probe-owned table: a table this probe invented would sit outside every stock permission set and all
arms would be refused for a reason unrelated to the variable. Measured on Cronus281, fenced:

| arm | what runs the write | callee's `Permissions` | result |
|---|---|---|---|
| A8-direct **(control)** | the test body itself | — | **refused** — `(TableData 27 Item Modify: LethAL R13 Probe)` |
| A8-grant | callee 71500 | `tabledata Item = rm` | **`modified=Yes`** |
| A8-reduced | callee 71501 | `tabledata Item = r` | **refused** |
| A8-none | callee 71502 | none | refused |
| A9 | caller 71503 grants `rm`, callee 71501 grants `r` and performs the write | — | **refused** |

**A8 is decisive: reducing `rm` to `r` — exactly what a `PermissionReduce` mutant emits — turns a
succeeding write into a refusal.** The operator IS killable. The A8-direct control is what makes
that readable: the same lowered session cannot write from the test body, so the grant arm's success
is the property doing work rather than the lowering silently failing (R26's "probe measures itself"
mistake, written as an arm instead of assumed away).

**A9 answers a second question: a caller's grant does NOT cover a write performed by a callee.** The
grant is scoped to the object whose own code performs the operation. So routing a write through a
shadow object carrying a reduced grant genuinely reduces — which is why the R13 decision refuses
`PermissionReduce` on cost and on the reachability figures below, rather than on an impossibility
claim about the emit path.

**Reachability, which is what bounds the operator's value:** a kill needs both a grant at the site
and a covering test that lowers permissions. In Continia Document Output that is **10 of 1,290
tests (0.78%), in 2 of 104 test files**, against **423** `tabledata` grants in 38 `Permissions`
properties.

A3 and A6 exist because without them A1 succeeding would only show that nothing in this fixture can
be refused, and A4 failing would only show that restrictive tests fail. The pair of pairs is what
separates "the property did it" from "the mode did it".

**A7 also refines R1.** R1's rule — "a test codeunit that does not declare `TestPermissions =
Disabled` cannot write, on any runner" — stands, and now has a mechanism: declaring the needed
permissions ON THE TEST CODEUNIT does not rescue it, it only converts the demanded permission from
`Insert` to `IndirectInsert`, which the restrictive session also lacks. Worth knowing before telling
a user with a refused suite to "add the permissions".

### `IsolationLevelSwap` — `LockTable()` alone opens a write transaction

| arm | shape | result |
|---|---|---|
| M2a | `LockTable()`, `FindFirst`, then `Codeunit.Run` | **"An error occurred and the transaction is stopped. Contact your administrator or partner for further assistance."** — the test dies and never reaches its own `Error` |
| M2b | the same read and the same call, **no** `LockTable()` (the shape a deletion leaves) | `ran=Yes` |

So a `LockTable` deletion **is** observable in a single session — through R72's platform artifact,
and only through it. In THIS frame the artifact appears on the unmutated side, so a site shaped like
M2a fails at baseline and never yields a verdict.

**Read the scope of that carefully.** Both arms sit in the `[Test]` method's own frame, and LethAL
instruments the target app, never the test app — so this is not the frame mutants occupy. R73
already measured the same artifact NOT appearing when the write and the `Codeunit.Run` sit in an
ordinary codeunit called from a test. Nothing here measures a `LockTable` deletion at a
production-frame site, and no claim is made about one.

**One thing this does add to R72's open question** (§R73: *which* shape triggers the refusal): the
opener need not be a WRITE. A bare `LockTable()` — no insert, no modify — is enough in the `[Test]`
frame. R13 varied the opener; it did not vary the frame, so the frame remains a **candidate**
variable, not the established one, and R73's question stays open.

### What this does NOT establish

- **Not** that `LockTable`'s removal is unobservable in general, and specifically not at
  production-frame sites, where nothing was measured. One single-session observable was looked for
  and found in the `[Test]` frame; the search was not exhaustive. What IS established is that the
  operator's textbook mechanism — contention between concurrent transactions — is unreachable here,
  because the platform test runner refuses a test's `StartSession` outright (*"Sessions can only be
  started in tests that are run by a TestRunner that has TestIsolation set to Disabled"*).
- **Not** anything about the operator's *strengthening* direction. A swap that ADDS a transaction
  opener (`ReadIsolation := …UpdLock`) would put the abort on the MUTATED side — baseline green,
  mutant aborts, scored `killed`, an R72-class false kill. Only deletion was measured.
- **Not** a statement about `InherentPermissions`. The additivity finding is about `Permissions`.
  `InherentPermissions` constrains rather than grants and applies irrespective of the user's
  permission sets, so it is the one object-level permission property that could refuse a SUPER
  session — a different mutation target, untouched here. Continia Document Output carries 2 of them
  across 554 files.
- **Not** a kill *rate*. 0.78% is the share of a suite's tests that lower permissions — an upper
  bound on reachability, not its intersection with the sites carrying grants.
- One BC 28 container, two tables (79201 and `Item`), one company, one SUPER OData user before
  lowering.

## R82 — how many call sites admit a type-safe argument swap? **340 provable, 893 by the looser rule**

R13 refused `EventPublisherSignature` as sketched and re-filed the observable half as R82
(`SwapCallArguments`), with the general footprint explicitly UNMEASURED — only the event-scoped
slice (44 raise sites reaching a two-same-typed-param publisher, 21 of them subscribed anywhere)
had been counted, by a name census. This is the general count, and it needs the semantic layer:
a call's arguments carry no declared types at the site.

**Counting rule pre-committed at `ef28f58`, before this ran** (R13's discipline at `349901a`).
Script: `scripts/census-swap-call-arguments.ts`. Corpus: `U:/Git/do-rel2/Cloud` — Continia Document
Output 28.4.0.0, 417 `.al` files after excluding `.dependencies/` and `Mutation*`. Denominator
19,132, R13's shipped-mutant count on the same project.

### The funnel

| step | sites |
|---|---|
| call sites with >=1 argument | 9,798 |
| call sites with >=2 arguments | 4,573 |
| ...where >=2 arguments TYPE at all through `buildTypeTable` | 1,884 (41.20%) |
| ...with a same-typed pair whose members differ in text | 893 |
| ...and `isMutableSite` (has an enclosing statement) | **893** |
| excluded: same-typed pair but IDENTICAL text — a no-op swap | 43 |
| dropped as non-executable (page/report property position) | 0 |

893 is **4.67%** of 19,132, against bar (a)'s >= 13. The zero in the last row is worth naming: unlike
`NegateConditional`, which R40 measured claiming 154 declarative page-property sites, every
argument-swap site is already executable — the operator inherits none of that problem.

### 893 is the LOOSE number, and 135 of those would not compile

`buildTypeTable`'s `extractType` keeps only the first whitespace-delimited token of a declaration,
so `Record "Sales Header"` and `Record "Purchase Header"` both answer `Record`. Re-checking each
chosen pair against its FULL declared type:

| | sites |
|---|---|
| both members declared, full declared type EQUAL | **340** (38.07%) |
| both members declared, full types DIFFER — the head matched, the type does not | **135** |
| at least one member is a literal or expression, so has no declaration to read | 418 |

The 135 break down as 118 `Record`, 9 `Codeunit`, 4 `List`, 2 `Option`, 2 `Enum` — every
subtype-bearing AL type. **An operator built on `buildTypeTable` as it stands would emit an
artifact that does not compile at 15% of its sites.** Filed as R84: nothing shipped reads the type
table today (`ctx.types` has no consumer outside its own tests), so this is a precondition of the
first operator that does, not a live defect.

### Type safety provable from source alone: **yes, for 340 sites, with no callee resolution**

R82 asked whether a same-typed swap can be proven type-safe from source. It can, and the argument
is about the ARGUMENTS rather than the callee: if the call compiles today, argument A fits
parameter *i* and B fits *j*; when A and B have the same declared type, A fits *j* and B fits *i*
too. The one hazard the arguments cannot settle is a **`var` parameter**, which AL matches by exact
type and refuses for a non-lvalue — and whether parameter *i* is `var` is the callee's business.

That hazard disappears when both members are bare variable references, since both are then lvalues
of one exact type:

| | sites |
|---|---|
| both pair members are bare identifiers | 475 (53.19%) |
| at least one is a literal or expression — a callee `var` parameter there is a compile error | 418 |
| **both bare variables AND equal full declared type — provable without resolving the callee** | **340** = 1.78% of 19,132 |

340 is 26x bar (a). **The footprint question is settled: R82 is not refusable on cost**, on the
strictest reading available, on this project.

### What is being swapped, and the equivalence risk

Of the 893: Text 416, Record 126, Integer 96, **Boolean 86**, Label 50, Date 38, `Code[20]` 24,
RecordRef 15, InStream 13, Codeunit 9. Within the provable 340, Boolean/Boolean is **40 (11.76%)** —
the slice carrying `swap-modify-flag`'s equivalence problem, where a callee frequently cannot
distinguish its two Boolean arguments. It is a minority, which is the news: the event-scoped census
could not say this, and the fear that an argument swap is mostly Booleans is measured false.

### Overlap with a shipped operator is NOT subtracted, and that is a difference from `IsolationLevelSwap`

441 of the 893 sit in statement position, where `lethal.void-method-call` already emits. R13
subtracted the equivalent overlap for `IsolationLevelSwap` (25 of 36) because a `LockTable()`
DELETION emits byte-identical text to that operator's. A swap does not: dedup identity is
`kind:start:end:after.text` (`packages/schemata/src/dedup.ts`'s `identityOf`) and `emitDispatch` chains multiple
mutants per component, so both mutants survive at one site. **Marginal == gross here.**

### What this does NOT establish

- **Not killability.** Whether a swapped call changes a verdict is unmeasured, and it is now the
  only gate left on R82. A callee that ignores the distinction between its two arguments yields an
  equivalent mutant, exactly as `swap-modify-flag` does at a smaller site count.
- **Not a measurement any current fixture can extend.** `fixtures/sandbox-data` has 3 loose sites
  and **0** provable ones; `fixtures/sandbox-app` has none at all. A live kill measurement needs a
  new fixture site, the way R30, R70 and R78 each grew the table fixture.
- **A lower bound, and the bound is large.** 2,689 of 4,573 two-argument call sites (58.80%) have
  fewer than two arguments the type table can type at all — member expressions (`Rec."No."`), call
  results, and anything declared outside `symbols.objects`. The true footprint is larger than 893
  by an unknown amount; nothing here estimates it.
- **One project.** Document Output is one codebase with one house style. Argument-heavy call sites
  are a style artifact as much as a language one.
- **The pair choice is deterministic, not exhaustive.** One mutant per site, on the first qualifying
  (i, j). A site with three same-typed arguments admits more swaps than are counted here.

## R82 live — the operator measured through the pipeline: **30 of 30 predicted verdicts, exactly**

The census (§R82 above) settled cost. This settles the mechanism. Every per-mutant verdict was
pre-committed in `docs/superpowers/specs/2026-08-03-r82-swap-call-arguments-design.md` §5 and
committed as `f9e055c` BEFORE the run, so the run could contradict its author — R73's
`remove-commit` prediction was contradicted by its run, and that contradiction was the finding.

`LETHAL_ITEST_TABLES=1 bun run itest:tables`, Cronus283, 2026-08-03. The gate moved from
84 killed / 12 survived / 10 no-coverage over 106 deployed to **109 / 17 / 10 over 136**
(148 raw specs), `untargetedTriggerCount` 0, and the session ran TWICE with identical verdicts (R9).

| arm | site | predicted | measured |
|---|---|---|---|
| A — `var` writeback, statement position | `DataSwapOps:46` | killed | **killed**, by `SwapRedirectsTheAccumulatorWriteback` |
| B — EXPRESSION position | `:69` | killed | **killed**, by `SwapReversesTheRangeComparison` |
| C — equivalent survivor (`or` is commutative) | `:92` | survived | **survived** |
| D — undertested survivor | `:116` | survived | **survived** |
| E — false kill (length overflow) | `:146` | killed by a platform error | **killed**, by `NarrowParameterOverflowsUnderTheSwap`, which asserts nothing |
| F — R84 refusal (two different record types) | `:178` | NO swap mutant | **no swap mutant**; the site's `void-method-call` is killed |

The 24 collateral Tier-1 mutants also matched, one for one. Nothing was reconciled after the fact.

### What that proves, stated narrowly

- **The two-point edit survives the pipeline.** A swap is the first mutation in this product that
  moves two spans, collapsed into one `before`/`after` pair whose replacement text carries the
  bytes between the arguments through untouched. It emits, compiles, deploys and scores.
- **Both mutants live at one site.** `:46`, `:92`, `:116` and `:146` each carry a swap AND a
  `void-method-call` mutant, and both were scored. R82's "marginal == gross" is now measured, not
  argued — it is what makes the census's 340 an addition rather than a reshuffle.
- **The compile-safety argument holds against a real compiler.** Arm A's swapped call puts a
  different variable into a `var` parameter and `alc` accepts it, as the argument in the spec
  §2.2 says it must. A hand-swapped copy of the whole fixture also compiled with zero warnings.
- **Both survivor flavours are distinguishable in the report.** C is unkillable; D is a test gap.

### Arm E — the false kill, with its artifact text

Measured directly, because the product does not record it (see the gap below). A target carrying
ONLY arm E's swap was published (1.0.20669.0) and the two tests run through `bcdev_test_run`:

```
The length of the string is 18, but it must be less than or equal to 10 characters.
Value: LONGCODE1234567890
AL Callstack:
"Data Swap Ops"(CodeUnit 79311).StampWithNarrow line 2 - LethAL Sandbox Data by LethAL version 1.0.20669.0
"Data Tests"(CodeUnit 79310).NarrowParameterOverflowsUnderTheSwap line 14 - ...
```

`WeakStampAssertionMissesTheSwap` PASSED on that same publish, which is the control: the failure is
arm E's shape, not a broken deployment. The clean target was republished afterwards (1.0.20670.0)
and all five R82 tests pass again.

One property of that text is worth keeping for whoever builds the detector R72's discipline defers:
the message is prose that WILL localise — R66 already measured that BC translates this class of
message while a structural parenthetical survives, so a detector matching the English sentence would
be another English-only detector.

An earlier version of this section also offered "the top callstack frame is in the TARGET app
(`Data Swap Ops.StampWithNarrow`), not the test" as a discriminator. **That is false, and it is
falsified by this very run** — see the correction below. Three ordinary kills in the same run have a
target-app top frame.

### The gap arm E found, which was not what it was aimed at

**Not one of the 109 kills records WHY it died** in `mutants.failure_note` — it is `NULL` for every
one — so in that record, arm E's platform overflow is indistinguishable from arm A's genuine
assertion kill. The distinction exists here only because the fixture was constructed to make it
inferable (arm E's test asserts nothing). On a real project nobody can infer it. Filed as **R86**,
the precondition for R85's "split kills by cause".

**Two corrections to that paragraph, both found by an adversarial review of the landed work and
re-measured independently. They are recorded rather than silently fixed, because each was written
here as measured and neither was.**

1. **The text is NOT missing — it is unread.** `test_results.failure_message` is NOT NULL for
   **110 of 110** failing rows in the same run, carrying the message plus a `;`-separated AL
   callstack, written by `RunMutantTransport.failureTextOf` on the fenced path and stored against a
   `mutantRowId`. The gap is one JOIN into `MutantOutcome`, not a capture to re-plumb from the
   backend. The first version of this section sent the reader to the wrong layer.
2. **"The top callstack frame is in the TARGET app" does NOT discriminate a false kill**, and that
   sentence appeared below as though it did. Classifying all 109 mutant-attributed failing rows by
   the top frame: **4 are in the target app, and only one is arm E.** The other three are ordinary
   kills where the target's own validation raised — M0059 *"Category must have a value in Data
   Main"*, M0062 and M0066 *"The Data Main does not exist"*. That is a **75% false-positive rate**
   on the only run the rule has been checked against, and it misfires on exactly the class §4 of the
   spec says must be read apart from arm E, since production validation catching a bad state is a
   REAL kill. A candidate the data supports — the failing frame's statement is not the mutated
   statement, and the message is a platform-class error — needs its own measurement, and there are
   three ready-made counterexamples in `test_results` to red-check it against.

   Worth knowing before anyone builds on this fixture: all 22 of its tests raise via bare
   `Error(...)`, so every assertion kill here puts the TEST app on top. Continia Document Output's
   suite uses Microsoft's Library Assert ~1,886 times, which puts a THIRD app on top. The fixture is
   structurally blind to the shape real assertion kills have.

### What this does NOT establish

- **Not a rate.** Six arms on a fixture written for them cannot say how often a real suite notices a
  real swap. That is R85, and its instrument must not be this fixture. Note for whoever runs it: the
  population is **390** — what `swapCallArguments.targets` actually claims on `do-rel2/Cloud` — not
  the census's 340. The census pairs over all arguments and then checks whether the chosen pair was
  two identifiers; the operator filters to identifiers first and then pairs, so it finds pairs the
  census skipped. Sampling 340 would describe something the product does not emit.
- **Not that the survivors generalise.** C and D are one commutative callee and one weak assertion,
  chosen to be readable apart. Their RATIO on a real project is unmeasured.
- **Not equivalence detection.** Nothing here tags arm C's mutant as equivalent; a reader still has
  to work that out. The operator deliberately sets no `equivalenceHint`.
- One container, one company, one BC 28 server.

## al-runner v2 — the CLI and wire contract, measured against the released binary

Answers R93, and corrects three roadmap claims that had drifted. Every line below was produced by
running `C:/Users/SShadowS/.dotnet/tools/al-runner.exe` on this Windows machine on **2026-08-07**,
against **`al-runner v2.0.0.0`** (the NuGet release, not a local build of `main`). Earlier
measurements in R93-R101 were taken against a local Release build of upstream `main` plus PR #1657;
where the two disagree, this section is the one that describes the binary a gate would actually run.

### It runs on Windows

R98 recorded that upstream `main` P/Invoked `libc`'s `mprotect` and died before any test ran. On the
released 2.0.0.0 that is gone: `--version` exits 0 with `al-runner v2.0.0.0`, and
`fixtures/sandbox-app` + `fixtures/sandbox-tests` run to 2 pass / 0 fail / 0 error, exit 0. Nothing
in R93 is blocked on the platform any more.

### The flags

| what we need | v1 | v2 (measured) |
| --- | --- | --- |
| pick one test | `--run <method>` | `--test PATTERN` (alias `--filter`) — substring of the QUALIFIED name, case-insensitive |
| the project | positional | positional, repeatable; multiple bundle dirs run sequentially and aggregate |
| symbol/package resolution | `--packages DIR` | `--package-cache PATH`, repeatable |
| dependency stubs | `--stubs DIR` | **gone** — listed under NOT YET IMPLEMENTED and not accepted as a flag |
| per-test budget | `--test-timeout <s>` | **no flag**; the env var `AL_RUNNER_TEST_TIMEOUT_SEC` — and it IS honoured (set to 15, measured a 15.027 s test) |
| per-test reset | `--test-isolation method` | `--isolation test`. **`method` is accepted only as a v1 alias for `codeunit`** — the weaker mode — silently |
| machine output | `--output-json` | `--output-json`, same envelope |

An unrecognised flag prints `Unknown option '--run'. Run with --help for the supported flags.` to
stderr and exits **2**.

### stdout is banner + JSON, so `JSON.parse(stdout)` throws

`--output-json` writes a progress banner to **stdout** ahead of the JSON — `[r2r] re-execing…`,
`[bc] …selecting BC 28.1.49838.50794…`, `al-runner - running 2 bundle(s)`, a `[1/2] <dir> - 1 suites`
line per bundle. The JSON object then starts at a line that is exactly `{` at column 0 and runs to
the end. Upstream tracks this as #1649. Any parser must locate that block; a naive first-`{` scan
meets a brace inside a banner line.

### The result envelope

Test names are QUALIFIED — `Codeunit79601.FailsLoudly` — and `--test Codeunit79601.PassesQuietly`
selects exactly that one test, so the qualified name works as both filter and lookup key.

| case | `status` | `message` | process exit |
| --- | --- | --- | --- |
| pass | `pass` | absent | 0 |
| assertion failure | `fail` | `NavNCLDialogException: <the Error() text>` | 1 |
| runner-enforced timeout | **`error`** | **`TIMEOUT after 15s`** | 1 |
| project does not compile | — (no `tests`) | `compilationErrors[]` in the JSON, AL diagnostics on stderr | 3 |
| bundle could not execute | — | — | 2 |

`stackTrace` accompanies `message` on any non-pass, `;`-free and CRLF-separated, e.g.
`"Probe Logic"(CodeUnit 79600).Spin line 6 - Probe App by LethAL version 1.0.0.0`.

The timeout row is R94: v1 said `status: "fail"` with `Test exceeded <n>s timeout`, so a matcher
keyed on `fail` misses v2's `error` and a merely-hung mutant is recorded **killed**.

The exit-code rows are R95: v1's 2 meant out-of-scope, v2's 2 means the bundle could not EXECUTE,
and a decode that maps 2 to "skip" turns a process-level failure into a mutant with no verdict and
no error.

### `--bc-version` — R101(a) has drifted

R101 states the runner picks "the latest artifact present in the cache" and does not print the
selection, and concludes a verdict gate cannot accept that. Measured on 2.0.0.0 the default is
neither silent nor latest-wins: it prints
`[bc] no --bc-version given - selecting BC 28.1.49838.50794, the exact build this binary was compiled against.`
Pinning it is still worth doing — a run should not depend on which binary built it — but it is a
preference, not the correctness hole R101 describes.

### 2.0.1 shipped the same day, and moved the timeout wording BACK

Re-measured a few hours later against **al-runner v2.0.1.0**, which published while the adapter was
being written. Unchanged: the flags, the qualified names, the exit codes (unknown flag 2, failing
test 1, compile failure 3), and `AL_RUNNER_TEST_TIMEOUT_SEC`. Changed:

| | 2.0.0.0 | 2.0.1.0 |
| --- | --- | --- |
| timeout `message` | `TIMEOUT after 15s` | `Test exceeded 12s timeout.` (v1's wording, returned) |
| timeout `status` | `error` | `error` (unchanged) |
| `--output-json` stdout | banner, then JSON | JSON at line 1 — the banner MOVED to stderr, it did not vanish |

The banner row is worth stating precisely, because "no banner on stdout" and "no banner" are
different facts and only the first is true: on 2.0.1.0 every banner line (`[r2r]`, `[bc] selected
BC …`, `al-runner - running N bundle(s)`, the per-bundle lines) is on **stderr**, and stdout is pure
JSON from line 1. Verified by capturing the two streams separately: 4 banner markers on stderr, 0 on
stdout. So a caller that merges the streams still meets the 2.0.0.0 shape, and only a caller that
reads stdout alone sees the clean one.

That is the whole argument for R123 in one row. A decode keyed on the timeout literal would have
turned every hung mutant into a KILL, silently, within hours of being written — which is why the
shipped rule classifies POSITIVELY and treats an unrecognised `status: "error"` as not-measured
rather than as a failure. The binary is a globally-installed dotnet tool that
`dotnet tool update` moves under a gate between runs, so `itest:alrunner` now stamps the version it
ran against.

### A compile failure is NOT exit 3 in the shape a real run meets

Measured 2026-08-07 on 2.0.1.0, and this corrects what the exit-code table above implies. Exit 3 is
what an invocation where **every** bundle fails to compile answers with. A real LethAL run is not
that shape: it has an instrumented TARGET that fails to compile beside a test bundle that compiles
fine. That answers with **exit 1 and completely EMPTY stdout** — no JSON envelope at all.

Exit 1 is inside the range the decode reads verdicts from. The only thing between that and a batch
of false SURVIVORS is `parseAlRunnerPayload` refusing an unreadable envelope instead of returning
`[]`. R123's contract probe therefore measures the PROPERTY — "a compile failure must not yield a
readable envelope naming the requested test" — rather than pinning either exit code, because the
first draft pinned exit 3 and was measuring a case that never happens.

### Passing the same bundle dir twice CRASHES the runner

Also measured 2026-08-07 on 2.0.1.0, found while writing that probe. Two positional bundle dirs with
the same BASENAME die with an unhandled exception rather than a named failure:

```
Unhandled exception. System.ArgumentException: An item with the same key has already been added. Key: broken3
   at System.Linq.Enumerable.ToDictionary[...]
   at AlRunner.Reporter.SerializeJsonOutput(IReadOnlyList`1 buckets, Int32 exitCode) in AlRunner/Reporter.cs:line 180
```

Exit 127 direct, and 82 when the process is reaped differently. Nothing LethAL does sends duplicate
dirs, so this costs us nothing operationally — it is filed as R124 because it is a crash against
upstream's own loud-failure rule, which is one of the three things R93's adapt-first policy says IS
worth reporting.

### An aborted spawn RESOLVES, it does not reject

Measured 2026-08-07 with this repo's own `defaultSpawn` (Bun.spawn under the hood), aborting a
500 ms controller against a child that sleeps 20 s: the call **resolved after 512 ms with
`exitCode: 143`** (128 + SIGTERM), `signal.aborted === true`, and the partial stdout the child had
already written. It did not throw.

Recorded here because it is not al-runner behaviour at all, and it still broke an al-runner check:
R123's probe first bounded each invocation by aborting a controller and catching a rejection, so the
deadline branch was dead code and a killed process reached the facts as an ordinary answer. The
`unknown-flag-rejected` fact tested only "non-zero exit", so a probe that TIMED OUT scored a match —
"the runner rejected our flag", concluded from a process that never answered. Anything bounding a
spawn must RACE it, the way `OneShotTransport.send` does, rather than wait for a throw.

### What this does NOT establish

- **Not stability.** Two of the shapes above changed between two point releases hours apart. Every
  literal in this section is a "today" value, and the reason R123 wants them measured per session
  rather than written into a decode.
- **Not the server protocol.** Everything above is CLI mode. The server protocol is measured in its
  own section below, added 2026-08-08.
- **Not a real project.** The fixture resolves zero dependencies, so it never exercises v2's hard
  artifact prerequisite or its rejection of a symbols-only `.alpackages` — that is R100, and the
  fixture gates are structurally blind to it.
- **Not the verdicts.** Whether v2 reproduces the frozen 3 killed / 13 survived / 0 no-coverage
  per-mutant is the gate's job, not this section's.

## al-runner 2.1.0.0 server mode — measured, and it is a different protocol now

Answers R97. Every line below came from driving `al-runner --server` directly over stdin/stdout on
this Windows machine on **2026-08-08**, against **al-runner v2.1.0.0**, with
`fixtures/sandbox-app` as the source bundle and `fixtures/sandbox-tests` as the test bundle.

### The defect R97 was filed for is FIXED

R97 recorded, against 2.0.0.0, that `runTests` used `SourcePaths[0]` only, so a request carrying
`[sourceDir, testDir]` never ran the test bundle and answered
`{"tests":[],"passed":0,...,"exitCode":0}` — green and empty. On 2.1.0.0 the same request runs both
bundles:

```
request:  {"command":"runTests","sourcePaths":["…/fixtures/sandbox-app","…/fixtures/sandbox-tests"]}
line 1:   {"type":"test","name":"Codeunit79100.ClampPercentRuns","status":"pass","durationMs":24}
line 2:   {"type":"test","name":"Codeunit79100.OverBudgetDetected","status":"pass","durationMs":3}
line 3:   {"type":"summary","exitCode":0,"passed":2,"failed":0,"errors":0,"total":2,"cached":true,"protocolVersion":2}
```

Order still matters, and the order LethAL sent is the correct one. Reversed
(`[testDir, sourceDir]`), the test RUNS but fails: `Codeunit 79000 is not present in the test
assembly or any loaded dependency`. So the earlier bundle is built as an implementation package and
the later one supplies the tests, which is exactly the `[sourceDir, testDir]` shape `ServerTransport`
was sending.

### The response is streaming NDJSON, not one envelope

This is the part that matters more than the fix. 2.1.0.0 answers one `{"type":"test",…}` line per
test and then one `{"type":"summary",…,"protocolVersion":2}` line. The transport this repo carried
read **one** line per request and looked for a `tests` array. Against this binary it would have
found none on the first per-test line and returned an empty list — the silently-empty confirmation
that is this project's signature bug, relocated from upstream into our own decoder.

`{"ready":true}` on start and `{"error":"Unknown command: bogusCommand"}` for an unknown command are
unchanged.

### There is NO per-test selection

Measured by sending the request with each plausible field name in turn against one warm server.
All six were **ignored**: every request ran the whole suite and returned `total: 2`.

| field sent | tests run |
| --- | --- |
| *(none)* | both |
| `testFilter` | both |
| `filter` | both |
| `test` | both |
| `tests` (array) | both |
| `testName` | both |
| `pattern` | both |

Guessed field names cannot prove a capability is absent, but they are what a caller has; the CLI's
`--test <qualified>` has no counterpart anyone can reach over this protocol today.

### What that costs, and why serverMode stays refused

`ExecutionBackend.run()` is called once per TEST. With no per-test selection the server executes T
tests on each of those T calls, so one mutant costs T² test executions where the CLI's `--test`
filter costs T. Warm-process speed is real — the same request took 6,980 ms cold and 1,011 ms warm
here — but it does not pay for a quadratic. `AlRunnerBackend` therefore still throws on
`serverMode: true`, with a message that now states these reasons rather than the fixed upstream one,
and the transport that decoded the old envelope is deleted rather than repaired.

Server mode becomes worth revisiting when the backend can make ONE call per MUTANT instead of one
per test — a single whole-suite response already carries every verdict that mutant needs. Filed as
R126.

### What this does NOT establish

- **Not isolation.** The CLI sends `--isolation test`; nothing was measured about whether the server
  protocol accepts or honours an isolation setting, and running a whole suite in one warm process is
  not obviously the same semantics as one process per test.
- **Not provisioning.** `--server`'s usage line takes only `--package-cache` and `--cache`, so it has
  no `--auto-provision`. These runs succeeded because the 28.1.49838.50794 artifacts were already
  cached from R125's work; a cold machine is untested and would likely refuse the way R125 records.
- **Not stability.** Same caveat as CLI mode: `protocolVersion: 2` is a today value.
