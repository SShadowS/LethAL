# R-569 plan r2 (lethal-code): r1 plus the adversary-r1 fixes

`plan.r1.md` holds except as changed here.

1. **The var rule (F1), replacing r1's step 6.** The rule drops only the var ENTRY: a call in report code (hop 0)
   that passes a fed name to a `var` parameter of ANOTHER object's procedure is not followed. That is the Fixed
   Asset - Projected Value path, 906 mutants, and it stays a residual. Inside a procedure reached through its
   RETURN VALUE, a call that writes a fed name through a `var` parameter IS followed, because it feeds the return
   value. This applies to a same-object procedure, a hop-1 callee, and the hop-1 callee's same-object procedures.
   Examples: `Helper.Advance(Found); exit(Found)`, or `Helper.Calc(Result)` where `Result` is the named return. A
   same-object procedure reached from report code through a `var` argument (hop 0, the same object) is followed
   as before, since it is the report's own code.
   The debug tags are split into `exit`, `ret-var` and `entry-var` for the measurement. The debug export is
   removed before the build is final.
   Expected price: about -104. That is -68, plus the ret-var targets: Detailed Calculation's Cost Calculation
   Management 8, Dimensions - Total's CopyDimFilters 10 and PEPPOL ConvertPosted* 18. The figure is re-measured
   on the built branch and every target is named.
2. **The residual in R569 (F1, F5).** It is stated in this form.
   - **Not followed:** a hop-1 callee ENTERED through a `var` argument from report code. The price measured
     906, all in Fixed Asset - Projected Value. In the sample, each loop had a second exit that makes progress on
     its own.
   - **Re-open when:** a loop's ONLY exit is fed through a `var` argument passed from report code into another
     object's procedure.
   - **Also not followed:** a `var` write made by an event SUBSCRIBER (the IsHandled/Result pattern), events raised
     on the way, globals written in another trigger, and hop 3.
3. **Tests (F4).**
   - T3: the var call is in REPORT code (hop 0), `Calc.Compute(Amount)` feeding `Done`. Expect it stays emitted.
     Red: follow the hop-0 var entry.
   - T7 (new): the hop-1 callee does `Helper.Calc(Result); exit(Result)`. Expect `Helper.Calc` refused. Red: drop
     the var scan inside return-reached procedures.
   - T4: the exit reads the hop-1 call directly in `until` (no same-object helper). Its own red: do not follow a
     call that sits directly in the exit parts (scan only the right sides of feeding assignments).
   - T6: the third-object call is an ARGUMENT of a call into another object
     (`exit(Fmt.Wrap(PPM.NextDate(...)))`). Assert both: the outer receiver's procedure (`Fmt.Wrap`) is added as
     hop 2, and `PPM.NextDate` is not. Red: ignore `r568StopsAt`.
   - T8 (new): the OnPreDataItem `CurrReport.Break` guard, in the AsmExists shape, is refused, which pins the
     stated over-refusal. Red: skip Break guards in OnPreDataItem.
   - T1, T2 and T5 are as in r1.


---

# R-569 plan r1 (lethal-code): the exit-fed second hop, return value only

Base: master b163c255 (R-521 merged; R569.md filed there). Branch `lethal/r569`, worktree /work/lethal-wt/r569:
WIP prototype `eefa20ff` merged with master at `537a669a`. Measurement: `/coord/handoff/R-569/measure.md`.

Orchestrator ruling 2026-10-10:
- build RETURN-VALUE ONLY (-68), refusal only;
- the `var`-argument path is a stated residual in R569, with a re-open condition;
- keep the 12 OnPreDataItem-Break over-refusals and name them;
- no scheme bump (0 tuples, 0 ordinals).

## Change (`packages/builtin-tier1/src/loop-hazard.ts`)
`exitFedHop2`, called from `oneHopReach` for each report, reportextension or XMLport object, adds hop-2
procedures to the hop-1 refused set.

**1. Exits.** It starts from every open-item loop's exit parts (`loopExitParts`). It also starts from the guards
of every `CurrReport.Break`/`Quit` in open-item code, and from their XMLport twins.

**2. Feeds in the exit's scope.** These come from `r531Feeds` with `fed`, under the R532/R568 boundary: at another
object's function, only the receiver feeds. The calls the search follows are those inside the exit parts and those
in the right sides of feeding assignments.

**3. Same-object procedures.** A followed call into a procedure of the same object is followed through its
RETURNED VALUE: the `exit(...)` values, the named return variable, and the guards of its `exit`s. Inside that
procedure, step 2 runs again from the returned value.

**4. Hop 1.** A followed call into another project object is a hop-1 callee (`callTargets`, with overloads
narrowed by `r531ProcsIn`). Hop 1 is already refused on master. Steps 2 and 3 run again inside the callee and its
same-object procedures, starting from its returned value.

**5. Hop 2.** A followed call from there into a THIRD object adds that procedure. It gets exactly the hop-1
treatment: the whole procedure, its same-object closure, and the event subscribers that the existing pass already
follows.

**6. Return value only.** The prototype's `var` mode is REMOVED. A call that passes a fed name to a `var`
parameter is not followed, at any step. There is no hop 3.

**7. Cleanup.** The measurement-only `r569Debug` export is removed.

## Expected price (re-measured on the built branch, fresh master leg)
- BaseApp -68: `PeriodPageManagement`.NextDate 28 plus closure 18 (CopyAccountingPeriod 10,
  SetAccountingPeriodFilter 4, GetCalendarPeriodMinDate 3, EndOfPeriod 1); `Assemble-to-Order
  Link`.AsmExistsForJobPlanningLine 12 (the OnPreDataItem Break of Whse.-Source - Create Document: a named
  over-refusal); `Production BOM Line`.GetQtyPerUnitOfMeasure 10.
- PEPPOL 0 (its 18 were `var`).
- Quality Management, Subscription Billing, E-Document Core, Withholding Tax 0.
- DC, DO, CDO, the fixtures and the other BC.History projects have no one-hop seeds (R-521 measure), and the rule
  adds no other entry path.
- Expected 0 tuples and 0 ordinals moved. If anything moves, I ask for scheme 40.

## Residuals stated in R569
- **`var` argument path (not built).** The measured price was 942 (BaseApp 924, PEPPOL 18). Of that, 906 come from
  one report, Fixed Asset - Projected Value (Calculate Normal Depreciation 580, Calculate Custom 1 Depr. 326). The
  sample found 0 hangs in 7 reads. Each loop the var path reached either has a second exit that makes progress on
  its own (`UntilDate >= EndingDate`; `More` in Dimensions - Total), or is fed only by a root name (a field of the
  cursor record, a RecRef passed for reading). **Re-open when** a loop is found whose ONLY exit is fed through a
  hop-1 `var` argument.
- Feeds are read in the exit's own scope only. A global written in another trigger is not followed, as in R531.
- No hop 3.
- Events raised on the way are not followed as feeds.

## Tests (`packages/builtin-tier1/tests/r569-exit-fed-hop2.test.ts`; each red-checked alone, full output read)
Multi-file contexts: report, hop-1 codeunit, hop-2 codeunit.
1. **The Item Budget shape** (my own AL): `repeat ... until NextLine(1) = 0`, where `NextLine` exits
   `Mgt.NextRecord(...)` and `NextRecord`'s return is assigned from `PPM.NextDate(...)`. A NextDate mutant
   (remove-assignment of the step) is emitted on master (seam off) and refused with the rule on. Red: skip the
   `exitFedHop2` call.
2. **Control.** A hop-2 call in the hop-1 callee that feeds nothing (`Other.Log(...)`) stays emitted. Red: follow
   every hop-2 call.
3. **Var not followed.** A hop-2 call reached only through a `var` argument (`Calc.Compute(Amount)`, with `Done`
   fed by `Amount`) stays emitted. Red: restore the var mode.
4. **Same-object return path.** The exit reads a same-object helper whose `exit` is the hop-1 call. Covered by test
   1; test 4 drops the helper and calls the hop-1 procedure directly in `until`. Red: drop step 3's return
   following (test 1 goes red; test 4 stays green).
5. **Break guard.** `if not Mgt.HasMore() then CurrReport.Break();` in OnAfterGetRecord, where `HasMore`'s return
   comes from a third object: refused. Red: drop the Break-guard exits.
6. **Boundary.** A hop-2 call whose result reaches the return only as an argument of a further `Obj.Proc(...)`
   (R532/R568) is not followed. Red: ignore `r568StopsAt` in the hop analysis.
A test seam (`r569Seam = { on: true }`) gives the "off equals master" leg, as `r532FeedSeam` does.

## Gates
- typecheck; `rm -rf packages/*/dist`; `bun scripts/verify.ts`; biome on touched files; line-citations and
  roadmap-index.
- Re-measure BaseApp and PEPPOL (fresh master b163c255 or newer, against the built branch): expect -68 / 0, 0
  tuples, 0 ordinals.
- Opus build review; one CI push; R569 `done (<commit>)` with the residuals; submit.


---

