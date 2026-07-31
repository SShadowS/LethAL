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
    // not an omission.
    //
    // A pageextension's code is unreachable from a test codeunit — nothing outside the page can
    // name its procedures — so the only way in is a `TestPage`. That test was written, published
    // and RUN against Cronus283 on 2026-07-31, and it did not come back: the fenced session went
    // `in-flight-unknown` on `PageExtCountsMatchingRelated` at baseline and the run quarantined the
    // tier, scoring nothing (killed=0 survived=0 noCoverage=0).
    //
    // The CAUSE first written here — "opening a TestPage on the fenced path hangs" — was WRONG, and
    // a later probe says so: a code-free page opened the same way on the fenced path fails in 87 ms
    // with `System.NotSupportedException ... NavSession.CreateNavTestService()`, and the run
    // completes. `TestPage` is REFUSED on that path, not slow. What hung on Cronus283 is still
    // unexplained (that page sat over a trigger-carrying table and its extension WROTE a row from
    // `OnOpenPage`). Both halves are R69.
    //
    // So `pageextension "Data Main List Ext"`'s mutants stay in the baseline as `no-coverage`. They
    // still prove what nothing else here does — that a pageextension-carried guard instruments,
    // compiles, publishes and installs on a live server — but the pageextension half of R30's
    // receiver resolution is UNPROVEN LIVE, and the roadmap says so.

    // ---------------------------------------------------------------------------------------------
    // Seeding helpers. All idempotent — see InsertDoublesAmountWeak's comment for why that is
    // kept even though the persistence claim behind it was measured false.
    // around every mutant run, so rows PERSIST into the next one.
    //
    // Both inserts use `Insert(false)` deliberately: running Data Main's OnInsert here would kill
    // the mutant that fixture is meant to leave surviving.
    // ---------------------------------------------------------------------------------------------

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
