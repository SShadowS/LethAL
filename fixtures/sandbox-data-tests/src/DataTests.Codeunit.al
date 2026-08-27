codeunit 79310 "Data Tests"
{
    Subtype = Test;
    // Measured 2026-07-26: WITHOUT this, a test codeunit defaults to restrictive test permissions and
    // Microsoft's Permissions Mock refuses every write from its body — on EVERY runner, not just
    // LethAL's fenced path. That refusal is what the InherentPermissions workaround on the tables was
    // hiding. A real BC suite declares this (the Continia Document Output suite: 77 of 77 test
    // codeunits), so a fixture omitting it was testing a shape no real suite has.
    TestPermissions = Disabled;

    var
        DataOps: Codeunit "Data Ops";

    // ---------------------------------------------------------------------------------------------
    // Tier-1 trigger tests (Phase 0). Unchanged: they hold the object-level/field-level trigger
    // kills and the two deliberate survivors the Phase-0 exit criteria are stated in terms of.
    // ---------------------------------------------------------------------------------------------

    [Test]
    procedure BlankNoValidateFails()
    var
        DataMain: Record "Data Main";
    begin
        // Strong: OnValidate's guard must actually fire. An emptied/negated trigger body
        // stops raising this error, asserterror then fails, and the mutant is killed.
        asserterror DataMain.Validate("No.", '');
    end;

    [Test]
    procedure InsertDoublesAmountWeak()
    var
        DataMain: Record "Data Main";
    begin
        // Weak on purpose: exercises the object-level OnInsert trigger (Amount := Amount * 2)
        // but asserts nothing about the result, so a mutant there survives genuinely.
        //
        // Idempotent by construction (delete before insert). The original reason given here was
        // that LethAL's two-phase fence commits around each mutant run, so rows persist between
        // runs. MEASURED 2026-07-27 (R32 verification): they do NOT — platform test isolation
        // rolls test writes back, and all four fixture tables held 0 rows in both companies after
        // 432 fenced runs. The idempotence is still correct and still cheap; only the stated
        // reason was wrong, and a fixture comment asserting the wrong platform behaviour is how
        // the next person builds on a false premise.
        if DataMain.Get('X1') then
            DataMain.Delete(false);
        DataMain.Init();
        DataMain."No." := 'X1';
        DataMain.Amount := 5;
        DataMain.Insert(true);
    end;

    [Test]
    procedure NoTriggerValidateRunsWeak()
    var
        DataNoTrigger: Record "Data No Trigger";
    begin
        // Weak on purpose: exercises "Data No Trigger"'s field-level OnValidate (the table
        // whose selector var lands trailing, with no object-level trigger) but asserts
        // nothing about the outcome.
        DataNoTrigger.Validate("No.", 'A1');
    end;

    [Test]
    procedure TooLongNoValidateFails()
    var
        DataNoTrigger: Record "Data No Trigger";
    begin
        // Strong on the second table too: proves the field-level OnValidate guard fires
        // there as well, so a kill on this table's trigger site is not the fixture's only one.
        asserterror DataNoTrigger.Validate("No.", '12345678901');
    end;

    // ---------------------------------------------------------------------------------------------
    // Tier-2 POSITIVES — one test per operator per shape, each named with the site it must kill (or
    // deliberately spare). Every one of these is `asserterror` or asserts a value; a fixture whose
    // positives only exercise the happy path lets a wrong predicate pass and teaches nothing.
    // ---------------------------------------------------------------------------------------------

    [Test]
    procedure ProcessedRequiresCategory()
    var
        DataMain: Record "Data Main";
    begin
        // Strong, asserterror. Kills the IMPLICIT-receiver `TestField(Category)` in field
        // Processed's OnValidate: delete it and the trigger raises nothing, so asserterror fails.
        // Without an asserterror negative like this, RemoveTestField survives trivially and the
        // baseline's "real kills" claim would be false (spec §6).
        ResetMain('T-BLANKCAT', '', 0);
        DataMain.Get('T-BLANKCAT');
        asserterror DataMain.Validate(Processed, true);
    end;

    [Test]
    procedure FlaggedFiresModifyTrigger()
    var
        DataMain: Record "Data Main";
    begin
        // Strong. Kills the IMPLICIT-receiver `Modify(true)` in field Flagged's OnValidate:
        // `Modify(false)` still writes the row but skips OnModify, so "Modify Count" stays 0.
        // This is the Validate()-driven path spec §6 requires — OnValidate has to fire from test
        // code or the trigger sites are unreachable.
        ResetMain('T-FLAG', 'A', 1);
        DataMain.Get('T-FLAG');
        DataMain.Validate(Flagged, true);
        DataMain.Get('T-FLAG');
        if DataMain."Modify Count" <> 1 then
            Error('expected OnModify to run exactly once, got %1', DataMain."Modify Count");
        if not DataMain.Flagged then
            Error('expected Flagged to persist');
    end;

    [Test]
    procedure MarkProcessedFiresModifyTrigger()
    var
        DataMain: Record "Data Main";
    begin
        // Strong. Kills the CASE-VARIANT `DataMain.MODIFY(TRUE)` in Data Ops. AL is
        // case-insensitive, so a text-sensitive lowercase-only predicate silently misses this
        // exact spelling in real code (spec §4.1).
        ResetMain('T-MARK', 'A', 1);
        DataOps.MarkProcessed('T-MARK');
        DataMain.Get('T-MARK');
        if DataMain."Modify Count" <> 1 then
            Error('expected MODIFY(TRUE) to run OnModify once, got %1', DataMain."Modify Count");
        if not DataMain.Processed then
            Error('expected Processed to persist');
    end;

    [Test]
    procedure CategoryGuardNeedsCalcFields()
    var
        DataMain: Record "Data Main";
    begin
        // Strong, asserterror. Kills the IMPLICIT-receiver `CalcFields("Related Total")` in field
        // Category's OnValidate: without it the FlowField reads 0, the > 1000 guard never fires
        // and the asserterror fails. The two SEEDED RELATED ROWS (600 + 700 = 1300) are
        // load-bearing — with none, 0 = 0 either way and the mutant is equivalent (spec §6).
        ResetMain('T-CALC', 'A', 0);
        ClearRelated('T-CALC');
        AddRelated(79101, 'T-CALC', 600);
        AddRelated(79102, 'T-CALC', 700);
        DataMain.Get('T-CALC');
        asserterror DataMain.Validate(Category, 'Z');
    end;

    [Test]
    procedure CountForMainIgnoresDecoys()
    var
        Actual: Integer;
    begin
        // Strong. Kills the qualified `Related.SetRange("Main No.", MainNo)`. The three
        // OUT-OF-FILTER decoy rows are the point: without them the filtered and unfiltered counts
        // agree, RemoveSetRange survives on data starvation and proves nothing (spec §6).
        ClearRelated('T-FILT');
        ClearRelated('T-DECOY');
        AddRelated(79111, 'T-FILT', 1);
        AddRelated(79112, 'T-FILT', 2);
        AddRelated(79113, 'T-DECOY', 3);
        AddRelated(79114, 'T-DECOY', 4);
        AddRelated(79115, 'T-DECOY', 5);
        Actual := DataOps.CountForMain('T-FILT');
        if Actual <> 2 then
            Error('expected 2 in-filter rows (3 decoys must be excluded), got %1', Actual);
    end;

    [Test]
    procedure CountInCategoryUppercaseSetRange()
    var
        DataMain: Record "Data Main";
        Actual: Integer;
    begin
        // Strong. Kills the CASE-VARIANT `Rec.SETRANGE(Category, CategoryCode)` in Data Main,
        // again with an out-of-filter decoy row (category CB).
        ResetMain('T-CATA1', 'CA', 0);
        ResetMain('T-CATA2', 'CA', 0);
        ResetMain('T-CATB1', 'CB', 0);
        Actual := DataMain.CountInCategory('CA');
        if Actual <> 2 then
            Error('expected 2 rows in category CA, got %1', Actual);
    end;

    [Test]
    procedure RequireCategoryAFails()
    begin
        // Strong, asserterror. Kills the TWO-ARGUMENT `DataMain.TestField(Category, 'A')`. A
        // one-argument-only RemoveTestField never claims this site, and the baseline then reports
        // lethal.void-method-call here instead — which is the failure spec §6 asks this shape to
        // produce.
        ResetMain('T-REQ', 'B', 0);
        asserterror DataOps.RequireCategoryA('T-REQ');

        // R36: the error TEXT is asserted, not merely that an error occurred.
        //
        // `asserterror` alone accepted the WRONG error and hid a real mutant. Deleting
        // `DataMain.Get(MainNo)` leaves the record blank, and `TestField(Category, 'A')` then still
        // raises — because '' <> 'A' — so the bare assertion was satisfied by a failure with an
        // entirely different cause, and the mutant was reported SURVIVED. That is this project's
        // signature "test passes for the wrong reason", sitting inside the fixture built to catch
        // exactly that class of bug.
        //
        // BC's TestField failure names the record it was called on ("... in Data Main: No.=T-REQ").
        // A blank record cannot name 'T-REQ', so this discriminates on the one thing the deleted
        // `Get` is responsible for: whether the record was loaded at all. Asserting the expected
        // Category instead would NOT discriminate — both the real and the mutated path mention 'A'.
        if StrPos(GetLastErrorText, 'T-REQ') = 0 then
            Error(
              'expected the TestField failure to name the record it loaded (T-REQ), got: %1',
              GetLastErrorText);
    end;

    [Test]
    procedure TouchCategoryWeak()
    begin
        // WEAK on purpose (spec §6): calls TestField on a row whose Category IS set and asserts
        // nothing, so the RemoveTestField mutant at that site genuinely SURVIVES. A baseline of
        // nothing but kills could equally be explained by the whole tier erroring out.
        ResetMain('T-WEAK', 'A', 0);
        DataOps.TouchCategory('T-WEAK');
    end;

    // ---------------------------------------------------------------------------------------------
    // Tier-2 NEGATIVES — sites a sloppy predicate would wrongly claim. Each of these tests exists so
    // the site's Tier-1 `lethal.void-method-call` mutant has a verdict the baseline pins: a wrong
    // Tier-2 claim wins the §3.2 dedup precedence and REPLACES that mutant, so it surfaces as a
    // changed operatorName on a mutant whose verdict did not move.
    // ---------------------------------------------------------------------------------------------

    [Test]
    procedure ModifyWithFlagVariableRuns()
    var
        DataMain: Record "Data Main";
    begin
        // `Modify(SomeBoolean)` must NOT be swapped — spec §4 is literal `true` only.
        ResetMain('T-VARFLAG', 'A', 1);
        DataOps.MarkWithFlag('T-VARFLAG', false);
        DataMain.Get('T-VARFLAG');
        if not DataMain.Processed then
            Error('expected Processed to persist');
        if DataMain."Modify Count" <> 0 then
            Error('expected OnModify NOT to run for Modify(false), got %1', DataMain."Modify Count");
    end;

    [Test]
    procedure ClearingMainFilterCountsEverything()
    var
        Actual: Integer;
    begin
        // The no-value `SetRange("Main No.")` CLEARS a filter, so deleting it PRESERVES one — the
        // inverse of every other deletion (spec §4). RemoveSetRange must skip it. Deleting it
        // drops the count to the single T-CLR1 row, so the Tier-1 mutant here is KILLED and a
        // wrong Tier-2 claim moves a killed mutant's operator name.
        ClearRelated('T-CLR1');
        ClearRelated('T-CLR2');
        AddRelated(79121, 'T-CLR1', 1);
        AddRelated(79122, 'T-CLR2', 2);
        Actual := DataOps.CountIgnoringMainFilter('T-CLR1');
        if Actual < 2 then
            Error('expected the no-value SetRange to clear the filter (>= 2 rows), got %1', Actual);
    end;

    [Test]
    procedure InsertWithoutTriggerKeepsAmount()
    var
        DataMain: Record "Data Main";
    begin
        // `Insert(false)` must not be claimed just because its argument is a Boolean literal.
        //
        // The delete first is load-bearing, not tidiness: the fence COMMITS, so a row this test
        // inserted on an earlier mutant run survives into the next one. Without the delete, the
        // "InsertWithoutTrigger did nothing at all" mutant would find the previous run's row still
        // there and survive — a verdict that depends on run order rather than on the mutation.
        DeleteMain('T-INS');
        DataOps.InsertWithoutTrigger('T-INS', 5);
        DataMain.Get('T-INS');
        if DataMain.Amount <> 5 then
            Error('expected Insert(false) to skip OnInsert and leave Amount at 5, got %1', DataMain.Amount);
    end;

    [Test]
    procedure LoadAmountReadsField()
    var
        Actual: Decimal;
    begin
        // The no-argument `SetLoadFields()` resets loading to default; deleting it preserves a
        // partial-load state. Both SetLoadFields mutants here are genuine EQUIVALENTS (Amount is
        // readable either way) and survive — which is exactly why spec §5 makes
        // RemoveSetLoadFields hint-tagged rather than scored.
        ResetMain('T-LOAD', 'A', 7);
        Actual := DataOps.LoadAmount('T-LOAD');
        if Actual <> 7 then
            Error('expected 7, got %1', Actual);
    end;

    [Test]
    procedure UserDefinedBuiltinsRun()
    var
        Actual: Integer;
    begin
        // User-defined methods sharing a builtin's name, TAKING ARGUMENTS, on non-record
        // receivers (spec §6). `Validator.TestField(7)` and `Builder.SetRange('A', 'Z')` pass
        // every guard their operators own except "receiver resolves to a non-record in source".
        // 3*100 + 7*10 + StrLen('A' + 'Z') = 372, so deleting any one of the three moves the total.
        Actual := DataOps.RunUserDefinedBuiltins();
        if Actual <> 372 then
            Error('expected 372 (3*100 + 7*10 + 2), got %1', Actual);
    end;

    [Test]
    procedure ShadowedBuiltinsRun()
    var
        Actual: Integer;
    begin
        // A record whose OWN TABLE declares those procedures (rule 3, qualified half), reached
        // CROSS-FILE, plus the implicit `Commit()` call inside Data Shadow.
        // 42 + StrLen('AA') + StrLen('ZZZ') + 1 = 48.
        Actual := DataOps.ShadowedBuiltins();
        if Actual <> 48 then
            Error('expected 48 (42 + 2 + 3 + 1), got %1', Actual);
    end;

    [Test]
    procedure SelfShadowedRun()
    var
        Shadow: Record "Data Shadow";
        Actual: Integer;
    begin
        // The SAME-FILE twin of ShadowedBuiltinsRun. The two must agree about whether Tier 2
        // claims the site, and since 0c4989b (one project-wide SemanticContext) they do: neither
        // is claimed. The pair stays as the regression guard for that — a relapse to per-file
        // contexts changes the cross-file half's operatorName without moving any verdict.
        // 5 + StrLen('A') + StrLen('BB') = 8.
        Actual := Shadow.SelfShadowed();
        if Actual <> 8 then
            Error('expected 8 (5 + 1 + 2), got %1', Actual);
    end;

    // ---------------------------------------------------------------------------------------------
    // R30 — extension objects. The first extension mutants any LethAL gate has executed: the
    // mechanism shipped 2026-07-28 with unit tests only, because no fixture declared an extension.
    // ---------------------------------------------------------------------------------------------

    [Test]
    procedure ExtRequireCategoryFails()
    var
        DataMain: Record "Data Main";
    begin
        // Strong, asserterror. Kills the IMPLICIT `TestField(Category)` inside
        // `tableextension "Data Main Ext"` — which is only claimed if `Rec` there resolves to the
        // EXTENDED table. Deleting it empties the procedure, nothing is raised, asserterror fails.
        ResetMain('T-EXTREQ', '', 0);
        DataMain.Get('T-EXTREQ');
        asserterror DataMain.ExtRequireCategory();
        // Assert the error is the one this site raises, not merely SOME error (R36: an asserterror
        // that accepts any failure hides the mutant it exists to catch). TestField names the field.
        if StrPos(GetLastErrorText(), 'Category') = 0 then
            Error('expected a TestField error naming Category, got: %1', GetLastErrorText());
    end;

    [Test]
    procedure ExtCountRelatedIgnoresDecoys()
    var
        DataMain: Record "Data Main";
        Actual: Integer;
    begin
        // Strong. Kills `Related.SetRange("Main No.", "No.")` inside the tableextension, whose
        // receiver is declared INSIDE the extension — the site that needs an extension-scoped
        // symbol index. The three out-of-filter decoys are load-bearing: without them the filtered
        // and unfiltered counts agree and the mutant is equivalent.
        ResetMain('T-EXTCNT', 'CA', 0);
        ClearRelated('T-EXTCNT');
        ClearRelated('T-EXTDEC');
        AddRelated(79131, 'T-EXTCNT', 1);
        AddRelated(79132, 'T-EXTCNT', 2);
        AddRelated(79133, 'T-EXTDEC', 3);
        AddRelated(79134, 'T-EXTDEC', 4);
        AddRelated(79135, 'T-EXTDEC', 5);
        DataMain.Get('T-EXTCNT');
        Actual := DataMain.ExtCountRelated();
        if Actual <> 2 then
            Error('expected 2 related rows for T-EXTCNT (3 decoys must be excluded), got %1', Actual);
    end;

    // THERE IS DELIBERATELY NO TEST FOR THE `pageextension` SITE, and the reason is a measurement,
    // not an omission — three times over now.
    //
    // A pageextension's code is unreachable from a test codeunit — nothing outside the page can
    // name its procedures — so the only way in is a `TestPage`. The first such test was written,
    // published and RUN against Cronus283 on 2026-07-31, and it did not come back: the fenced
    // session went `in-flight-unknown` on `PageExtCountsMatchingRelated` at baseline and the run
    // quarantined the tier, scoring nothing (killed=0 survived=0 noCoverage=0).
    //
    // The CAUSE first written here — "opening a TestPage on the fenced path hangs" — looked WRONG
    // after a later probe: a CODE-FREE page (`fixtures/sandbox-probes/ProbeList.Page.al` +
    // `TestPageProbe.Codeunit.al`, no triggers, no FlowFields, no pageextension) opened the same
    // way on the fenced path fails in 87 ms with `System.NotSupportedException ...
    // NavSession.CreateNavTestService()`, and the run completes. `TestPage` is REFUSED on that
    // path, not slow — for THAT page. R69 Phase 2 (2026-08-01) built a second execution path
    // (client-services, `GuiAllowed=Yes`) plus a two-gate router on that finding: gate 1
    // recognises the fence-refusal text on a baseline run, gate 2 confirms the same test passes
    // unmutated on client-services, and only a mutant covered exclusively by such tests is
    // examined there.
    //
    // RE-MEASURED LIVE 2026-08-01, against THIS page (not the probe): `PageExtCountsMatchingRelated`
    // was reinstated, seeded to kill `Related.SetRange("Main No.", 'P-EXT')`, and run against
    // Cronus283 via `itest:tables` — TWICE, with a full container recovery (Docker-level restart;
    // the NST was stuck `StopPending` after the first attempt) and `force-reset-lease` between
    // them. Both runs reproduced the IDENTICAL 2026-07-31 outcome byte-for-byte: `in-flight-unknown`
    // on `PageExtCountsMatchingRelated` at baseline, `quarantined: {"reason":"baseline test
    // in-flight-unknown running PageExtCountsMatchingRelated"}`, killed=0 survived=0 noCoverage=0
    // for the ENTIRE 84-mutant run, not just this object's four. So the 87 ms fast-refusal finding
    // does NOT generalise past the code-free probe: a page whose `SourceTable` carries real
    // triggers/a FlowField, extended by a pageextension that WRITES a row from `OnOpenPage`, still
    // wedges the fenced session — deterministically, reproducibly, on the exact page R30 built.
    //
    // This also means Phase 2's router structurally CANNOT rescue this test, independent of
    // whether it would pass on client-services: `runSession`'s baseline-discovery loop
    // (`packages/runner/src/orchestrator.ts`, the `for (const ref of tests)` loop that calls
    // `quarantineInFlight` on `in-flight-unknown`) runs every discovered test once, sequentially,
    // on the fenced path, and quarantines the WHOLE session unconditionally the moment ANY one of
    // them comes back `in-flight-unknown` — before gate 1's routing logic (which only pattern-
    // matches a FAST, completed baseline failure) ever runs. A hang during baseline discovery
    // takes the entire suite down with it, not just the mutants the hanging test would have
    // covered. Filed as a refinement to R69, not a fix — no packages/ change was made pursuing
    // this; a packages/ change (e.g. isolating TestPage-suspected baseline tests behind their own,
    // shorter deadline, run separately from the rest of baseline discovery) is what closing this
    // would need, and is out of this task's scope.
    //
    // So `pageextension "Data Main List Ext"`'s mutants stay `no-coverage`, and the fixture stays
    // test-free here on purpose: a live-hanging test in this file wedges `itest:tables` for
    // EVERY future run (not just this object's), which is a strictly worse regression detector
    // than the honest no-coverage bucket it would replace.
    //
    // R76 (2026-08-01) closed the one open question the analysis above left dangling: does R53's
    // `--stop-hung-sessions` convert this BASELINE hang into a scored/failed test rather than a
    // quarantine? Reinstated this exact test again, published to Cronus283, and ran the CLI
    // directly (`bun packages/runner/src/cli.ts run --project fixtures/sandbox-data --tests
    // fixtures/sandbox-data-tests --backend bcdev --config
    // fixtures/sandbox-data/lethal.config.local.json --selector-id 79199 --control-id 79198
    // --table-id 79197 --stop-hung-sessions`, since `tables.itest.ts` does not thread the flag
    // through. Answer: QUARANTINED — same as without the flag. The armed run resolved in 34.3s
    // total (not an indefinite hang): `PageExtCountsMatchingRelated` came back `outcome: "error"`,
    // `"RunMutant 2xx body could not be read: ... socket connection was closed unexpectedly"` —
    // strong evidence the flag DID reach in and kill the BC session under the open connection, far
    // faster than the un-flagged hang. But that forced-stop outcome is still classified by
    // `requiresUnsafeLatch` as ambiguous, so the SAME baseline-discovery loop
    // (`packages/runner/src/orchestrator.ts` ~:2418-2431) still calls `quarantineInFlight` and
    // `break`s — `quarantined: {"reason":"baseline test in-flight-unknown running
    // PageExtCountsMatchingRelated"}`, byte-identical to the no-flag message, killed=0 survived=0
    // noCoverage=0. R53's stop path, proven only on MUTANT runs before this, does not generalise to
    // a BASELINE hang: it changes latency, not outcome. One genuine improvement over the two
    // pre-R76 reproductions: the container did NOT wedge this time (NST stayed `Running`
    // throughout, confirmed responsive before and after) — recovery was `force-reset-lease` +
    // `clear-quarantine` only, no Docker-level restart needed. Full transcript:
    // .superpowers/sdd/2026-08-01-r69-phase2-batch-runner/r76-containment-report.md

    // ---------------------------------------------------------------------------------------------
    // R78: the ONLY TestPage test in this fixture, and the only route to
    // `codeunit 79308 "Data Value Source".GetValue`.
    //
    // That comment is deliberate, not incidental: written this way it USED to delete every [Test]
    // below it from discovery (R79, fixed in `packages/runner/src/discovery.ts`), silently. It
    // stays in its natural wording so the fixture keeps exercising the fix.
    //
    // What it is for: `GetValue`'s `exit(42)` carries exactly one Tier-1 mutant
    // (`lethal.return-value` rewrites a non-zero numeric exit to `exit(0)`), and nothing else in the
    // fixture calls it. So that mutant is reachable ONLY through a TestPage — a purpose-built
    // instance of the case R69/R78 argue about, with a known-correct answer. Under the mutant the
    // action computes 0 instead of 42 and this test MUST fail; if it ever reports `survived` or
    // `no-coverage` while the fixture is intact, the routing pipeline is broken, not the fixture.
    //
    // Deliberately a SIMPLE page (no SourceTable, no triggers, nothing on open). R76 measured the
    // split: a page like this is REFUSED fast on the fenced path (87 ms), where a page over a
    // trigger-carrying table with a pageextension writing from `OnOpenPage` HANGS and quarantines
    // the entire run. Fast refusal is the signal the router's gate 1 detects, so this test exercises
    // the pipeline in the configuration that CAN work and does not re-open the hang — which stays
    // filed, unfixed, and is a different problem.
    //
    // Plain `Error` rather than an Assert library: this app depends only on `LethAL Sandbox Data`,
    // matching every other test here.
    // ---------------------------------------------------------------------------------------------

    [Test]
    procedure PageActionComputesNonZero()
    var
        ValueCard: TestPage "Data Value Card";
        Shown: Integer;
    begin
        ValueCard.OpenView();
        ValueCard.Compute.Invoke();
        Shown := ValueCard.ComputedValue.AsInteger();
        ValueCard.Close();

        if Shown <> 42 then
            Error('expected the Compute action to show 42 from Data Value Source.GetValue, got %1', Shown);
    end;

    [Test]
    procedure ScopeProbeTracksFieldChange()
    var
        ScopeProbe: Record "Data Scope Probe";
    begin
        // R71: kills the fixture's only `lethal.swap-rec-xrec` mutant. `Data Scope Probe.Tracked`'s
        // OnValidate does the change detection `OnValidate` exists for — `if Tracked <> xRec.Tracked`
        // — and the mutant rewrites `xRec.Tracked` to `Rec.Tracked`, comparing a value with itself.
        // The branch then never fires and `Bumped` stays false.
        //
        // `Validate` is what makes this observable: assigning the field directly would not run the
        // trigger at all, and the mutant would survive against a test that never exercised it.
        if ScopeProbe.Get('SCOPE-TRACK') then
            ScopeProbe.Delete(false);
        ScopeProbe.Init();
        ScopeProbe."No." := 'SCOPE-TRACK';
        ScopeProbe."Main No. Filter" := 'T-SCOPE';
        ScopeProbe.Tracked := 1;
        ScopeProbe.Insert(false);

        ScopeProbe.Validate(Tracked, 2);

        if not ScopeProbe.Bumped then
            Error('expected OnValidate to see xRec.Tracked=1 differ from Tracked=2 and set Bumped');
    end;

    // ---------------------------------------------------------------------------------------------
    // R73 + R72: the first POSITIVE `lethal.remove-commit` sites any fixture has ever carried, and
    // the two kill mechanisms R72 exists to tell apart.
    //
    // Both mechanisms were MEASURED on `fixtures/sandbox-probes` before this was written:
    // a committed write SURVIVES a later uncaught error (`survived=Yes`) while an uncommitted one
    // is rolled back (`survived=No`), and `Codeunit.Run` with a write transaction open is REFUSED
    // by the platform ("An error occurred and the transaction is stopped.", identical on the hub
    // and the fenced path). See `docs/measurements/README.md`. Neither test below would mean
    // anything if either measurement had come out the other way.
    // ---------------------------------------------------------------------------------------------

    [Test]
    procedure CommittedWriteSurvivesFailure()
    var
        CommitOps: Codeunit "Data Commit Ops";
        DataMain: Record "Data Main";
    begin
        // ASSERTION QUALITY, not platform noise: deleting the `Commit()` makes the write roll back
        // with the error, and this assertion notices. That is what a `remove-commit` mutant SHOULD
        // die of.
        DeleteMain('T-CMTFAIL');
        // Durable clean start. Without this the delete would itself roll back and a row left by an
        // earlier run would answer `survived` for the wrong reason.
        Commit();

        asserterror CommitOps.CommitThenFail('T-CMTFAIL');

        if not DataMain.Get('T-CMTFAIL') then
            Error('expected the row committed before the error to survive it, but it is gone');
    end;

    [Test]
    procedure CommitBeforeCodeunitRunSucceeds()
    var
        CommitOps: Codeunit "Data Commit Ops";
        Target: Codeunit "Data Commit Target";
        DataMain: Record "Data Main";
    begin
        // PLATFORM ARTIFACT: deleting the `Commit()` leaves a write transaction open across
        // `Codeunit.Run`, which BC refuses outright — the call never returns, this test dies, and
        // the mutant is scored `killed` for a reason that says nothing about the assertions below.
        // R72's diagnosis is what keeps that honest; the verdict deliberately stays `killed`.
        DeleteMain(Target.CommitRunNo());
        Commit();

        CommitOps.CommitThenRun();

        if not DataMain.Get(Target.CommitRunNo()) then
            Error('expected CommitThenRun to have inserted %1', Target.CommitRunNo());
        if not DataMain.Flagged then
            Error('expected the Codeunit.Run callee to have flagged %1', Target.CommitRunNo());
    end;

    [Test]
    procedure CommitBeforeValueFormCodeunitRunSucceeds()
    var
        CommitOps: Codeunit "Data Commit Ops";
        Target: Codeunit "Data Commit Target";
        DataMain: Record "Data Main";
    begin
        // THE PLATFORM ARTIFACT, and the only fixture site that can produce it. The test above
        // calls `Codeunit.Run` as a bare statement and its mutant SURVIVES; this one consumes the
        // return value, which is the single factor a 2x2x2 on Cronus281 measured as deciding the
        // abort (`scripts/r72-probe/`). Deleting the `Commit()` leaves the write open, BC refuses
        // at the `Ran := ...` line, and this test dies without any assertion below being reached.
        //
        // The mutant is scored `killed` and stays killed. What R72's diagnosis adds is the reason:
        // the report says this kill came from the platform refusing the mutated program, not from
        // anything asserted here. Re-scoring it would invalidate every frozen gate figure.
        //
        // The assertions still matter for the BASELINE half: with the `Commit()` intact the call
        // must actually succeed and the callee must actually have run, or "survives" and "never
        // happened" would look alike.
        DeleteMain(Target.CommitRunNo());
        Commit();

        if not CommitOps.CommitThenRunValueForm() then
            Error('expected Codeunit.Run to report success once the write was committed');

        if not DataMain.Get(Target.CommitRunNo()) then
            Error('expected CommitThenRunValueForm to have inserted %1', Target.CommitRunNo());
        if not DataMain.Flagged then
            Error('expected the Codeunit.Run callee to have flagged %1', Target.CommitRunNo());
    end;

    // ---------------------------------------------------------------------------------------------
    // R70: the cross-kind name collision, made live.
    //
    // `table 79309 "Data Scope Probe"` and `page 79324 "Data Scope Probe"` differ only in KIND —
    // the ordinary "card page named after its table" convention. The table's OnInsert filters
    // `Data Related` through a receiver declared in the TRIGGER'S OWN var section, which the symbol
    // table cannot see (R68), so the receiver is correctly unresolvable and Tier 2 must REFUSE the
    // site: `lethal.void-method-call` is the only mutant there.
    //
    // Under the R70 bug the same-named PAGE's `Helper: Record "Data Main"` answered for the table,
    // the receiver resolved to the WRONG table, and Tier 2 claimed the site as
    // `lethal.remove-setrange` — which under §3.2 dedup precedence DELETES the Tier-1 mutant.
    // Measured offline on this exact fixture: raw specs 99 -> 100 while DEPLOYED stayed 90, i.e.
    // one claim gained and one correct mutant lost. The regression is therefore visible as an
    // OPERATOR NAME at a fixed file:line, which `tables.baseline.json` compares per mutant.
    //
    // This test exists so that site is SCORED rather than no-coverage: the decoys mean deleting
    // either the `SetRange` or the whole statement widens the count and the mutant dies. A
    // no-coverage site would still catch the operator flip but would not also prove the site runs.
    // ---------------------------------------------------------------------------------------------

    [Test]
    procedure ScopeProbeCountsOnlyFilteredRelated()
    var
        ScopeProbe: Record "Data Scope Probe";
    begin
        ClearRelated('T-SCOPE');
        ClearRelated('T-SCOPEDECOY');
        AddRelated(79141, 'T-SCOPE', 10);
        AddRelated(79142, 'T-SCOPE', 20);
        AddRelated(79143, 'T-SCOPEDECOY', 30);
        AddRelated(79144, 'T-SCOPEDECOY', 40);
        AddRelated(79145, 'T-SCOPEDECOY', 50);

        if ScopeProbe.Get('SCOPE-1') then
            ScopeProbe.Delete(false);
        ScopeProbe.Init();
        ScopeProbe."No." := 'SCOPE-1';
        ScopeProbe."Main No. Filter" := 'T-SCOPE';
        ScopeProbe.Insert(true);

        ScopeProbe.Get('SCOPE-1');
        if ScopeProbe."Related Count" <> 2 then
            Error('expected OnInsert to count only the 2 T-SCOPE rows, got %1', ScopeProbe."Related Count");
    end;

    // ---------------------------------------------------------------------------------------------
    // R82 — `lethal.swap-call-arguments`, six arms. Target: codeunit 79311 "Data Swap Ops", which
    // documents each arm and its PREDICTED verdict. The predictions are pre-committed in
    // docs/superpowers/specs/2026-08-03-r82-swap-call-arguments-design.md §5 before the live run,
    // so a contradiction is a finding (R73's `remove-commit` prediction was contradicted, and that
    // WAS the finding) rather than something to reconcile quietly afterwards.
    //
    // Two of these tests are deliberately weak, and one asserts nothing at all. That is not
    // sloppiness — a survivor is only informative when the site is genuinely COVERED, and a false
    // kill is by definition one a weak test still produces.
    // ---------------------------------------------------------------------------------------------

    [Test]
    procedure SwapRedirectsTheAccumulatorWriteback()
    var
        SwapOps: Codeunit "Data Swap Ops";
        Actual: Decimal;
    begin
        // ARM A. Strong. `Accumulate(Total, Delta)` swapped writes the sum into `Delta`, so
        // `Total` comes back as the untouched starting value: 10 instead of 15. The same
        // assertion kills the site's `void-method-call` deletion (10), `empty-block` on either
        // body, and `return-value`'s `exit(0)`.
        Actual := SwapOps.RunningTotal(10.0, 5.0);
        if Actual <> 15.0 then
            Error('expected RunningTotal(10, 5) = 15, got %1', Actual);
    end;

    [Test]
    procedure SwapReversesTheRangeComparison()
    var
        SwapOps: Codeunit "Data Swap Ops";
    begin
        // ARM B, expression position — the majority shape (452 of the 893 measured sites).
        // Three assertions, each earning its keep: the first two kill the swap and both
        // `return-value` flips, the third (equal values) kills `conditional-boundary`'s
        // `<=` -> `<`, which the other two cannot see.
        if not SwapOps.AmountWithinCap(5, 10) then
            Error('expected 5 to be within a cap of 10');
        if SwapOps.AmountWithinCap(10, 5) then
            Error('expected 10 NOT to be within a cap of 5');
        if not SwapOps.AmountWithinCap(7, 7) then
            Error('expected 7 to be within a cap of 7 — the boundary case');
    end;

    [Test]
    procedure CommutativeCalleeMakesTheSwapEquivalent()
    var
        SwapOps: Codeunit "Data Swap Ops";
    begin
        // ARM C. The swap here is EQUIVALENT and must survive: `or` cannot tell its operands
        // apart, so no assertion can ever kill this mutant. The assertion is still strong, and
        // deliberately so — it kills the deletion at the same site, which is what proves the
        // survivor is equivalence rather than missing coverage.
        SwapOps.NoteFlags(true, false);
        if not SwapOps.AnyFlagSeen() then
            Error('expected NoteFlags(true, false) to record a flag');
    end;

    [Test]
    procedure WeakStampAssertionMissesTheSwap()
    var
        SwapOps: Codeunit "Data Swap Ops";
    begin
        // ARM D. Weak ON PURPOSE, and the weakness is the measurement. Asserting that a stamp
        // HAPPENED is true under the swap ('S1' instead of 'P1' is still non-blank) and false
        // under the deletion — so this one assertion spares the swap and kills
        // `void-method-call`. That discrimination is what tells a report reader "your test is
        // weak here" apart from arm C's "this mutant is unkillable".
        SwapOps.StampFromPair('P1', 'S1');
        if SwapOps.PrimaryStamp() = '' then
            Error('expected StampFromPair to leave a primary stamp');
    end;

    [Test]
    procedure NarrowParameterOverflowsUnderTheSwap()
    var
        SwapOps: Codeunit "Data Swap Ops";
    begin
        // ARM E — the FALSE-KILL arm, and it asserts NOTHING by design. Both arguments are
        // Code[20] so the operator claims the site and the swapped call compiles; the callee's
        // second parameter is Code[10], so the swap sends 18 characters into it and BC raises at
        // runtime. A kill here is credited to no assertion, which is this repo's sharpest
        // definition of a false kill: one a weak test still produces.
        //
        // The verdict STAYS killed (R72: a diagnosis must not move a verdict). What this arm is
        // for is producing the artifact TEXT a future detector would have to match — and the
        // site's `void-method-call` survivor is the control proving the kill came from the swap's
        // runtime effect rather than from anything this test does.
        SwapOps.StampWithNarrow('LONGCODE1234567890', 'S1');
    end;

    [Test]
    procedure LinkedPairIsStamped()
    var
        SwapOps: Codeunit "Data Swap Ops";
    begin
        // ARM F — the R84 refusal negative. `Link(MainRow, RelatedRow)` takes two records whose
        // truncated type heads both read `Record` and whose real types differ; the operator must
        // NOT claim it. An absence is a weak thing to assert, so the site's `void-method-call`
        // mutant is pinned here instead: a wrong Tier-1/R82 claim surfaces as an operatorName
        // change on a KILLED mutant, the detector shape R70 established. (The louder failure comes
        // first: a wrongly claimed swap does not compile, and `alc` rejects the artifact.)
        SwapOps.LinkPair('M1', 42);
        if SwapOps.PrimaryStamp() <> 'M1' then
            Error('expected LinkPair to stamp the main record no., got %1', SwapOps.PrimaryStamp());
    end;

    // ---------------------------------------------------------------------------------------------
    // R136 -- the Tier-2 trio: `swap-modify-flag` extended to Insert/Delete (1.1.0),
    // `swap-find-direction` and `validate-to-assign`. Target: `codeunit 79314 "Data Flag Ops"`,
    // `codeunit 79315 "Data Find Ops"`, `codeunit 79316 "Data Validate Ops"` and
    // `table 79330 "Data Trigger Probe"`'s own ValidateLevelImplicit, each documenting its arm's
    // PREDICTED verdict and mechanism in the R82 style.
    //
    // Spec: docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md §3. Per-mutant predictions
    // are pre-committed in a SEPARATE document before the live run, following R82's precedent --
    // a run that cannot contradict its author is a demonstration, not a measurement (R73).
    //
    // Two same-span pairs carry DIFFERENT verdicts on purpose (spec §2.4): arm B (the flag swap
    // survives, the deletion kills) and arm H (the assignment survives, the deletion kills). A
    // report that dropped one of the pair, or merged them, cannot produce two different verdicts
    // at one span.
    //
    // Arm K (`DoubleInsertWithoutKeyTriggerRaises`) is a PLATFORM-ARTIFACT kill that no screen tags
    // (R138): its covering test asserts nothing, and the kill comes from a duplicate-key error, not
    // from any assertion.
    // ---------------------------------------------------------------------------------------------

    [Test]
    procedure InsertRunTriggerSetsTheTriggerField()
    var
        Probe: Record "Data Trigger Probe";
        FlagOps: Codeunit "Data Flag Ops";
    begin
        // ARM A. Strong. Insert(false) skips OnInsert, "Inserted By Trigger" stays false.
        if Probe.Get('FLAG-A') then
            Probe.Delete(false);
        if not FlagOps.InsertWithTrigger('FLAG-A') then
            Error('expected Insert(true) to run OnInsert and set the trigger field');
    end;

    [Test]
    procedure WeakInsertAssertionMissesTheFlag()
    var
        Probe: Record "Data Trigger Probe";
        FlagOps: Codeunit "Data Flag Ops";
    begin
        // ARM B. Weak ON PURPOSE -- only asserts a row landed, which Insert(false) still produces.
        // void-method-call at the same span deletes the Insert, so no row lands, and that mutant
        // kills instead.
        if Probe.Get('FLAG-B') then
            Probe.Delete(false);
        if not FlagOps.InsertCounted('FLAG-B') then
            Error('expected InsertCounted to land a row');
    end;

    [Test]
    procedure DeleteRunTriggerLeavesTombstone()
    var
        Probe: Record "Data Trigger Probe";
        Tomb: Record "Data Trigger Probe";
        FlagOps: Codeunit "Data Flag Ops";
    begin
        // ARM C. Strong. The row is seeded HERE, in the test app, per spec §3.3 rule 3 -- the arm
        // codeunit only sets the key and deletes it. Both the row and its tombstone are cleared
        // first (rule 7): residue from an aborted run would otherwise make arm C's own Delete(true)
        // raise a SECOND tombstone insert, a duplicate key unrelated to the mutation.
        if Tomb.Get('TOMB-FLAG-C') then
            Tomb.Delete(false);
        if Probe.Get('FLAG-C') then
            Probe.Delete(false);
        Probe.Init();
        Probe."No." := 'FLAG-C';
        Probe.Insert(false);

        if not FlagOps.DeleteWithTrigger('FLAG-C') then
            Error('expected Delete(true) to run OnDelete and leave a tombstone');
    end;

    [Test]
    procedure FindFirstPicksTheLowestKeyInRange()
    var
        FindOps: Codeunit "Data Find Ops";
    begin
        // ARM D. Strong. The decoy 'FIND-0' sorts BEFORE the filtered range and carries a
        // different Level (90), so an unfiltered FindFirst (the remove-setrange collateral) would
        // land on it instead -- the decoy is what makes that collateral genuinely killable, not
        // just this arm's own swap.
        ResetTriggerProbe('FIND-0', 90);
        ResetTriggerProbe('FIND-A', 1);
        ResetTriggerProbe('FIND-B', 2);
        if FindOps.FirstLevelInRange('FIND-A', 'FIND-B') <> 1 then
            Error('expected FindFirst to land on FIND-A with Level 1');
    end;

    [Test]
    procedure FindLastPicksTheHighestKeyInRange()
    var
        FindOps: Codeunit "Data Find Ops";
    begin
        // ARM E, the other direction. The decoy 'FIND-Z' sorts AFTER the filtered range this time
        // (rule 1 is directional) and carries Level 91, different from the asserted 4.
        ResetTriggerProbe('FIND-C', 3);
        ResetTriggerProbe('FIND-D', 4);
        ResetTriggerProbe('FIND-Z', 91);
        if FindOps.LastLevelInRange('FIND-C', 'FIND-D') <> 4 then
            Error('expected FindLast to land on FIND-D with Level 4');
    end;

    [Test]
    procedure ExistenceOnlyAssertionMissesTheDirection()
    var
        FindOps: Codeunit "Data Find Ops";
    begin
        // ARM F -- the EQUIVALENT-to-this-suite survivor. AnyRow carries no filter at all (spec
        // §3.2 amendment 7), so an existence-only assertion cannot tell FindFirst from FindLast:
        // both answer "found" the moment any row exists. Level 50 is reserved to this arm alone
        // (spec §3.3 rule 2), even though AnyRow never reads it.
        ResetTriggerProbe('FIND-ANY', 50);
        if not FindOps.AnyRow() then
            Error('expected at least one row to exist');
    end;

    [Test]
    procedure ValidateRunsTheFieldTrigger()
    var
        ValidateOps: Codeunit "Data Validate Ops";
    begin
        // ARM G. Strong, quoted field identifier. No row needed -- Validate runs OnValidate
        // against the in-memory record.
        if ValidateOps.SetLevel(5) <> 10 then
            Error('expected OnValidate to double 5 into 10');
    end;

    [Test]
    procedure ValueOnlyAssertionMissesTheTriggerSkip()
    var
        ValidateOps: Codeunit "Data Validate Ops";
    begin
        // ARM H -- the sharpest survivor in the wave. The plain field value is correct even when
        // OnValidate is skipped, so asserting only the field VALUE cannot see the skip; the
        // void-method-call deletion at the same span still kills, because deleting the call
        // altogether leaves "Level" at 0.
        if ValidateOps.SetLevelWeak(7) <> 7 then
            Error('expected the Level field to hold 7');
    end;

    [Test]
    procedure ImplicitValidateRunsInsideTheTable()
    var
        Probe: Record "Data Trigger Probe";
    begin
        // ARM I -- the IMPLICIT-receiver emit path, measured live inside a TABLE object rather than
        // a codeunit.
        if Probe.ValidateLevelImplicit(6) <> 12 then
            Error('expected the implicit-receiver Validate to double 6 into 12');
    end;

    [Test]
    procedure TouchLevelRunsTheTriggerAgain()
    var
        ValidateOps: Codeunit "Data Validate Ops";
    begin
        // ARM J -- the refusal negative. The single-argument Validate("Level") has no assignment
        // equivalent, so validate-to-assign must emit nothing here; this test instead pins the
        // site's void-method-call mutant as killed.
        if ValidateOps.TouchLevel(9) <> 18 then
            Error('expected the single-argument Validate to re-run OnValidate and double 9 into 18');
    end;

    [Test]
    procedure DoubleInsertWithoutKeyTriggerRaises()
    var
        KeyProbe: Record "Data Key Probe";
        FlagOps: Codeunit "Data Flag Ops";
    begin
        // ARM K. Asserts NOTHING, by design (spec §3.2): under Insert(false) "No." never gets
        // assigned, the first blank-key insert succeeds and the second raises a duplicate key
        // before any assertion could run. The verdict, if killed, is a platform artifact that R138
        // notes no screen tags.
        KeyProbe.DeleteAll(false);
        FlagOps.InsertTwiceWithKeyTrigger();
    end;

    // ---------------------------------------------------------------------------------------------
    // R134 -- `lethal.flip-filter-literal`, eight arms (A-H; F is a documented equivalence class,
    // not a fixture procedure). Target: codeunit 79317 "Data Filter Ops", which documents each
    // arm's PREDICTED verdict and mechanism in the R82/R136 style.
    //
    // Spec: docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md section 3. Per-mutant
    // predictions are pre-committed in a SEPARATE document before the live run (Task B7), same
    // precedent as R82 and R136.
    //
    // Every arm reserves its own "Main No." tag and its own Entry No. band (79150-79192), so no
    // arm's count can see another arm's rows and no verdict depends on test execution order. Every
    // test below raises through bare Error(...), matching the fixture's existing convention (the
    // tables gate asserts the R121 assertion screen reports itself as vacuous here, which requires
    // exactly that).
    // ---------------------------------------------------------------------------------------------

    [Test]
    procedure NegationFlipChangesTheCount()
    var
        FilterOps: Codeunit "Data Filter Ops";
        Actual: Integer;
    begin
        // ARM A. Strong. One row tagged FILT-A1, two tagged FILT-A2: CountExcluding('FILT-A1')
        // counts the OTHER group (2). The flip to '=%1' would count FILT-A1's own group (1)
        // instead -- a different number, so the assertion discriminates.
        ClearRelated('FILT-A1');
        ClearRelated('FILT-A2');
        AddRelated(79150, 'FILT-A1', 1);
        AddRelated(79151, 'FILT-A2', 2);
        AddRelated(79152, 'FILT-A2', 3);
        Actual := FilterOps.CountExcluding('FILT-A1');
        if Actual <> 2 then
            Error('expected 2 rows other than FILT-A1, got %1', Actual);
    end;

    [Test]
    procedure ExistenceOnlyAssertionMissesTheNegationFlip()
    var
        FilterOps: Codeunit "Data Filter Ops";
    begin
        // ARM B. Weak ON PURPOSE (the hash-decoy survivor twin of arm A): asserts only that SOME
        // row outside FILT-B1 exists, which is true under both the original ('<>FILT-B1', seeing
        // FILT-B2's row) and the flip ('=FILT-B1', seeing FILT-B1's own row) -- existence cannot
        // tell which group was counted.
        ClearRelated('FILT-B1');
        ClearRelated('FILT-B2');
        AddRelated(79153, 'FILT-B1', 1);
        AddRelated(79154, 'FILT-B2', 2);
        if not FilterOps.AnyExcluding('FILT-B1') then
            Error('expected at least one row excluding FILT-B1');
    end;

    [Test]
    procedure BoundaryShiftAdmitsTheThresholdRow()
    var
        FilterOps: Codeunit "Data Filter Ops";
        Actual: Integer;
    begin
        // ARM C. Strong. Three consecutive entries in the FLT-C group (79160, 79161, 79162),
        // called with Threshold = 79162 (the third entry): '<79162' matches only the first two
        // (2). The shift to '<=79162' would also admit 79162 itself (3). The residue decoy, in a
        // DIFFERENT Main No. group below the threshold, proves the SetRange scope is doing real
        // work: an unscoped filter would count it too.
        ClearRelated('FLT-C');
        ClearRelated('FLT-C-RESIDUE');
        AddRelated(79159, 'FLT-C-RESIDUE', 1);
        AddRelated(79160, 'FLT-C', 2);
        AddRelated(79161, 'FLT-C', 3);
        AddRelated(79162, 'FLT-C', 4);
        Actual := FilterOps.CountBelowThreshold(79162);
        if Actual <> 2 then
            Error('expected 2 rows below the threshold entry, got %1', Actual);
    end;

    [Test]
    procedure GapAtTheBoundaryMakesTheShiftEquivalent()
    var
        FilterOps: Codeunit "Data Filter Ops";
        Actual: Integer;
    begin
        // ARM D. The equivalence survivor: a GAP at the threshold (entries 79170 and 79172 only,
        // called with Threshold = 79171) means '<79171' and '<=79171' both match just 79170 (1) --
        // no row sits exactly at the shifted boundary, so the mutant is equivalent regardless of
        // what else exists. The residue decoy proves the scope, same as arm C.
        ClearRelated('FLT-D');
        ClearRelated('FLT-D-RESIDUE');
        AddRelated(79169, 'FLT-D-RESIDUE', 1);
        AddRelated(79170, 'FLT-D', 2);
        AddRelated(79172, 'FLT-D', 3);
        Actual := FilterOps.CountBelowThresholdSparse(79171);
        if Actual <> 1 then
            Error('expected exactly the one entry below the gap, got %1', Actual);
    end;

    [Test]
    procedure RangeFlipChangesTheCountRegardlessOfInclusivity()
    var
        FilterOps: Codeunit "Data Filter Ops";
        Actual: Integer;
    begin
        // ARM E. Strong. Entries strictly below (79178, 79179) and above (79181) the bound
        // (79180), NONE exactly at it: '..79180' matches the two below (2) whether the range is
        // read as inclusive or exclusive at the bound, since no row sits there either way. The
        // flip to '79180..' would match only 79181 (1). The residue decoy, at or below the bound
        // in a different group, proves the scope.
        ClearRelated('FLT-E');
        ClearRelated('FLT-E-RESIDUE');
        AddRelated(79177, 'FLT-E-RESIDUE', 1);
        AddRelated(79178, 'FLT-E', 2);
        AddRelated(79179, 'FLT-E', 3);
        AddRelated(79181, 'FLT-E', 4);
        Actual := FilterOps.CountUpToBound(79180);
        if Actual <> 2 then
            Error('expected 2 entries at or below the bound, got %1', Actual);
    end;

    [Test]
    procedure DroppedPlaceholderFreeAlternativeChangesTheCount()
    var
        FilterOps: Codeunit "Data Filter Ops";
        Actual: Integer;
    begin
        // ARM G. Strong. Two FLT-G-DECOY rows plus three FLT-G-TARGET rows, called with
        // MainNo = 'FLT-G-TARGET': the baseline filter matches both groups (5). Dropping the
        // placeholder-free 'FLT-G-DECOY' alternative leaves only the target group (3). A tag
        // distinct from the existing CountForMainIgnoresDecoys test's own 'T-DECOY' seeding
        // (finding 5) -- reusing that tag would make this baseline count depend on residue from a
        // different test.
        ClearRelated('FLT-G-DECOY');
        ClearRelated('FLT-G-TARGET');
        AddRelated(79185, 'FLT-G-DECOY', 1);
        AddRelated(79186, 'FLT-G-DECOY', 2);
        AddRelated(79187, 'FLT-G-TARGET', 3);
        AddRelated(79188, 'FLT-G-TARGET', 4);
        AddRelated(79189, 'FLT-G-TARGET', 5);
        Actual := FilterOps.CountDecoyOrTarget('FLT-G-TARGET');
        if Actual <> 5 then
            Error('expected the decoy and target rows together (5), got %1', Actual);
    end;

    [Test]
    procedure ClosedRangeCountIsScopedByMainNo()
    var
        FilterOps: Codeunit "Data Filter Ops";
        Actual: Integer;
    begin
        // ARM H. The closed-range refusal negative: flip-filter-literal emits nothing here
        // (spec section 2.2 step 4, section 5). This test instead pins the two collateral
        // verdicts -- deleting the SetFilter (leaving the SetRange scope) still counts exactly
        // the 2 FLT-H rows the range already matched; deleting the SetRange (leaving the range
        // unscoped) would also admit the residue decoy sitting inside the same numeric range but
        // tagged differently.
        ClearRelated('FLT-H');
        ClearRelated('FLT-H-RESIDUE');
        AddRelated(79190, 'FLT-H', 1);
        AddRelated(79191, 'FLT-H-RESIDUE', 2);
        AddRelated(79192, 'FLT-H', 3);
        Actual := FilterOps.CountInRange(79190);
        if Actual <> 2 then
            Error('expected 2 rows in the closed range (residue decoy excluded by scope), got %1', Actual);
    end;

    [Test]
    procedure NotBlankFilterCountsOnlyTaggedRows()
    var
        FilterOps: Codeunit "Data Filter Ops";
        Actual: Integer;
    begin
        // ARM I (R141). The CHARACTER refusal negative: flip-filter-literal emits nothing at a
        // filter carrying an inner quote, a different code path from arm H's ladder exhaustion.
        // Entry No. band 79200..79203 holds two tagged rows and one BLANK row; the tagged residue
        // decoy sits OUTSIDE the band at 79210. Baseline counts the 2 non-blank rows in the band.
        // Deleting the SetFilter counts the blank row too (3); deleting the SetRange counts the
        // out-of-band decoy too (3). Both numbers measured directly against Cronus283 before this
        // arm was written (scripts/r141-filter-probe/).
        ClearRelated('FLT-I');
        ClearRelated('FLT-I-DECOY');
        ClearRelated('');
        AddRelated(79200, 'FLT-I', 1);
        AddRelated(79201, 'FLT-I', 2);
        AddRelated(79202, '', 3);
        AddRelated(79210, 'FLT-I-DECOY', 4);
        Actual := FilterOps.CountTaggedInBand(79200);
        if Actual <> 2 then
            Error('expected 2 non-blank rows in the band, got %1', Actual);
    end;

    // ---------------------------------------------------------------------------------------------
    // R132 -- the assertion screen's `partial` branch, which no live gate had ever exercised.
    //
    // These two tests are a TWIN PAIR over `codeunit 79318 "Data Assert Ops"`: identical target
    // shape, identical verdicts, and the only difference is HOW each one raises. The first is the
    // only test in any LethAL fixture that raises through Microsoft's Library Assert, so its kills
    // carry a failure text beginning with `Assert.` and R121's screen does NOT flag them; the second
    // raises through bare `Error(...)` like every other test here, so its kills ARE flagged. That
    // makes `assertionScreen.discrimination` report `partial` on this gate instead of `vacuous`.
    //
    // Design: docs/superpowers/specs/2026-08-14-r132-assertion-screen-partial-design.md.
    // ---------------------------------------------------------------------------------------------

    [Test]
    procedure AssertScreenSeesAnAssertionFailure()
    var
        AssertOps: Codeunit "Data Assert Ops";
        LibraryAssert: Codeunit "Library Assert";
    begin
        LibraryAssert.AreEqual(50, AssertOps.DoubledLevel(25), 'doubled level');
    end;

    [Test]
    procedure AssertScreenSeesABareErrorFailure()
    var
        AssertOps: Codeunit "Data Assert Ops";
        Actual: Integer;
    begin
        Actual := AssertOps.TripledLevel(25);
        if Actual <> 75 then
            Error('expected 75 from the tripled level, got %1', Actual);
    end;

    // R159's assertion-screen arm for `toggle-blank-string`. See
    // fixtures/sandbox-data/src/DataBlankOps.Codeunit.al for why the kill must come through
    // Library Assert rather than a bare Error.

    [Test]
    procedure BlankStringKillIsAssertionEarned()
    var
        BlankOps: Codeunit "Data Blank Ops";
        LibraryAssert: Codeunit "Library Assert";
    begin
        // Both directions, so blanking the literal cannot pass by accident on one of them.
        LibraryAssert.AreEqual(1, BlankOps.ClassifyCode('ALPHA'), 'ALPHA classifies as 1');
        LibraryAssert.AreEqual(0, BlankOps.ClassifyCode('BETA'), 'BETA classifies as 0');
    end;

    // R180's arm. See fixtures/sandbox-data/src/DataCaseOps.Codeunit.al for why the three arms are a
    // control set: the SINGLE-statement arm must gain nothing from the fix, which is what separates
    // "claims arm BLOCKS" from "claims arms".

    [Test]
    procedure CaseArmsScoreByLevel()
    var
        CaseOps: Codeunit "Data Case Ops";
    begin
        // All three arms, so every mutant in the codeunit has a covering test and a survivor there
        // is a real assertion gap rather than an unexercised branch.
        if CaseOps.ClassifyLevel(1) <> 15 then
            Error('level 1 should score 15, got %1', CaseOps.ClassifyLevel(1));
        if CaseOps.ClassifyLevel(2) <> 20 then
            Error('level 2 should score 20, got %1', CaseOps.ClassifyLevel(2));
        if CaseOps.ClassifyLevel(7) <> 99 then
            Error('an unmatched level should fall to the else and score 99, got %1', CaseOps.ClassifyLevel(7));
    end;

    // R159's assertion-screen arm for `shift-integer`. See
    // fixtures/sandbox-data/src/DataShiftOps.Codeunit.al for why the two procedures are a twin pair
    // rather than two tests of one thing: they are identical in shape, and the only difference
    // between their mutants is which side of R121's screen each kill lands on.

    [Test]
    procedure ShiftKillIsAssertionEarned()
    var
        ShiftOps: Codeunit "Data Shift Ops";
        LibraryAssert: Codeunit "Library Assert";
    begin
        // Both directions, so shifting the literal cannot pass by accident on one of them.
        LibraryAssert.AreEqual(1, ShiftOps.BandedViaAssert(10), '10 is in the band');
        LibraryAssert.AreEqual(0, ShiftOps.BandedViaAssert(11), '11 is outside the band');
    end;

    [Test]
    procedure ShiftKillIsBareErrorRaised()
    var
        ShiftOps: Codeunit "Data Shift Ops";
        Actual: Integer;
    begin
        // Both directions, exactly as the Library Assert twin checks both, so the ONLY difference
        // between the two halves of this pair is how the failure is raised.
        Actual := ShiftOps.BandedViaError(10);
        if Actual <> 1 then
            Error('expected 1 from the banded value at 10, got %1', Actual);
        Actual := ShiftOps.BandedViaError(11);
        if Actual <> 0 then
            Error('expected 0 from the banded value at 11, got %1', Actual);
    end;

    // R171's cession-seam arm. See fixtures/sandbox-data/src/DataSetOps.Codeunit.al for why the
    // three procedures are a control set rather than three tests of one thing.

    [Test]
    procedure RegionRankSeparatesInsideAndOutsideTheSet()
    var
        SetOps: Codeunit "Data Set Ops";
        Inside: Integer;
        Outside: Integer;
    begin
        Inside := SetOps.RegionRank('DK');
        Outside := SetOps.RegionRank('DE');
        // Both directions, so stripping the `not` cannot pass by accident on one of them.
        if Inside <> 1 then
            Error('expected rank 1 for a country inside the set, got %1', Inside);
        if Outside <> 0 then
            Error('expected rank 0 for a country outside the set, got %1', Outside);
    end;

    [Test]
    procedure BothOutsideRangeSeparatesEqualAndUnequal()
    var
        SetOps: Codeunit "Data Set Ops";
        Equal: Integer;
        Unequal: Integer;
    begin
        Equal := SetOps.BothOutsideRange(7, 7);
        Unequal := SetOps.BothOutsideRange(7, 9);
        if Equal <> 1 then
            Error('expected 1 when the two values are equal, got %1', Equal);
        if Unequal <> 0 then
            Error('expected 0 when the two values differ, got %1', Unequal);
    end;

    [Test]
    procedure PlainMembershipSeparatesInsideAndOutsideTheSet()
    var
        SetOps: Codeunit "Data Set Ops";
        Inside: Integer;
        Outside: Integer;
    begin
        Inside := SetOps.PlainMembership('SE');
        Outside := SetOps.PlainMembership('DE');
        if Inside <> 1 then
            Error('expected 1 for a country inside the set, got %1', Inside);
        if Outside <> 0 then
            Error('expected 0 for a country outside the set, got %1', Outside);
    end;

    // ---------------------------------------------------------------------------------------------
    // Seeding helpers. All idempotent — see InsertDoublesAmountWeak's comment for why that is
    // kept even though the persistence claim behind it was measured false.
    // around every mutant run, so rows PERSIST into the next one.
    //
    // Both inserts use `Insert(false)` deliberately: running Data Main's OnInsert here would kill
    // the mutant that fixture is meant to leave surviving.
    // ---------------------------------------------------------------------------------------------

    local procedure ResetTriggerProbe(No: Code[20]; LevelValue: Integer)
    var
        Probe: Record "Data Trigger Probe";
    begin
        if Probe.Get(No) then
            Probe.Delete(false);
        Probe.Init();
        Probe."No." := No;
        Probe."Level" := LevelValue;
        Probe.Insert(false);
    end;

    local procedure ResetMain(MainNo: Code[20]; CategoryCode: Code[10]; AmountValue: Decimal)
    var
        DataMain: Record "Data Main";
    begin
        if DataMain.Get(MainNo) then
            DataMain.Delete(false);
        DataMain.Init();
        DataMain."No." := MainNo;
        DataMain.Category := CategoryCode;
        DataMain.Amount := AmountValue;
        DataMain.Insert(false);
    end;

    local procedure DeleteMain(MainNo: Code[20])
    var
        DataMain: Record "Data Main";
    begin
        if DataMain.Get(MainNo) then
            DataMain.Delete(false);
    end;

    local procedure ClearRelated(MainNo: Code[20])
    var
        DataRelated: Record "Data Related";
    begin
        DataRelated.SetRange("Main No.", MainNo);
        DataRelated.DeleteAll(false);
    end;

    local procedure AddRelated(EntryNo: Integer; MainNo: Code[20]; AmountValue: Decimal)
    var
        DataRelated: Record "Data Related";
    begin
        if DataRelated.Get(EntryNo) then
            DataRelated.Delete(false);
        DataRelated.Init();
        DataRelated."Entry No." := EntryNo;
        DataRelated."Main No." := MainNo;
        DataRelated.Amount := AmountValue;
        DataRelated.Insert(false);
    end;
}
