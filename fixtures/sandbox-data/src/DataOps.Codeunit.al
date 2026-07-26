// The QUALIFIED-receiver half of the fixture: `<rec>.Method(...)` sites whose receiver the symbol
// table can resolve from source (procedure locals), plus every NEGATIVE target a sloppy predicate
// would wrongly claim.
//
// Read this file as two lists. Each POSITIVE comment names the operator that must claim the site
// and the test that kills (or deliberately spares) it. Each NEGATIVE names the rule that must
// refuse it — and a negative is only useful if its Tier-1 `lethal.void-method-call` mutant has a
// verdict the suite pins, because "wrongly claimed by Tier 2" surfaces as an `operatorName` change
// on that mutant (Tier 2 outranks Tier 1 in the §3.2 dedup precedence and REPLACES it).
codeunit 79307 "Data Ops"
{
    // POSITIVE (RemoveSetRange, qualified receiver, two arguments). Killed by
    // `CountForMainIgnoresDecoys`, which seeds three out-of-filter decoy rows: without them the
    // filtered and unfiltered counts would agree and the mutant would be equivalent.
    procedure CountForMain(MainNo: Code[20]): Integer
    var
        Related: Record "Data Related";
    begin
        Related.SetRange("Main No.", MainNo);
        exit(Related.Count());
    end;

    // NEGATIVE (`SetRange` with no value). Spec §4: the no-value form CLEARS a filter, so deleting
    // it PRESERVES one — the inverse of every other deletion. `RemoveSetRange` must refuse it and
    // leave the Tier-1 `void-method-call` mutant in place. The `SetFilter` above it exists so the
    // clear has something to clear; `ClearingMainFilterCountsEverything` kills the Tier-1 mutant
    // here, so a wrong Tier-2 claim changes a KILLED mutant's operator name.
    procedure CountIgnoringMainFilter(MainNo: Code[20]): Integer
    var
        Related: Record "Data Related";
    begin
        Related.SetFilter("Main No.", '%1', MainNo);
        Related.SetRange("Main No.");
        exit(Related.Count());
    end;

    // POSITIVE (RemoveTestField, TWO-argument overload). Killed by `RequireCategoryAFails`. A
    // one-argument-only implementation of the operator fails to claim this site, and the baseline
    // then reports `lethal.void-method-call` here instead.
    procedure RequireCategoryA(MainNo: Code[20])
    var
        DataMain: Record "Data Main";
    begin
        DataMain.Get(MainNo);
        DataMain.TestField(Category, 'A');
    end;

    // POSITIVE (RemoveTestField, one-argument, qualified) that deliberately SURVIVES:
    // `TouchCategoryWeak` calls it on a row whose Category is set and asserts nothing. Spec §6
    // requires a genuine survivor sitting beside the `asserterror` negatives, or a baseline of
    // all-kills could equally be explained by the whole tier erroring out.
    procedure TouchCategory(MainNo: Code[20])
    var
        DataMain: Record "Data Main";
    begin
        DataMain.Get(MainNo);
        DataMain.TestField(Category);
    end;

    // POSITIVE (SwapModifyFlag) in the CASE-VARIANT spelling `MODIFY(TRUE)`. Killed by
    // `MarkProcessedFiresModifyTrigger`. `Processed` is assigned directly rather than validated on
    // purpose, so this site's verdict cannot borrow the field trigger's `TestField` signal.
    procedure MarkProcessed(MainNo: Code[20])
    var
        DataMain: Record "Data Main";
    begin
        DataMain.Get(MainNo);
        DataMain.Processed := true;
        DataMain.MODIFY(TRUE);
    end;

    // NEGATIVE (`Modify(SomeBoolean)`). Spec §4: literal `true` only — the semantic layer cannot
    // evaluate an arbitrary Boolean expression, so a variable argument is out of scope.
    // `ModifyWithFlagVariableRuns` kills the Tier-1 mutant here.
    procedure MarkWithFlag(MainNo: Code[20]; RunTrigger: Boolean)
    var
        DataMain: Record "Data Main";
    begin
        DataMain.Get(MainNo);
        DataMain.Processed := true;
        DataMain.Modify(RunTrigger);
    end;

    // NEGATIVE (`Insert(false)`). Nothing in Phase 1 targets `Insert`, and nothing should start
    // doing so because the argument happens to be a Boolean literal.
    // `InsertWithoutTriggerKeepsAmount` kills the Tier-1 mutant here (the following `Get` fails).
    procedure InsertWithoutTrigger(MainNo: Code[20]; Value: Decimal)
    var
        DataMain: Record "Data Main";
    begin
        if DataMain.Get(MainNo) then
            DataMain.Delete(false);
        DataMain.Init();
        DataMain."No." := MainNo;
        DataMain.Amount := Value;
        DataMain.Insert(false);
    end;

    // NEGATIVE (`SetLoadFields()` with NO arguments). Spec §5: the no-argument form resets loading
    // to default, so deleting it preserves a prior partial-load state. Both calls here survive as
    // Tier-1 mutants (`Amount` is readable either way) — a genuine equivalent-mutant pair, and the
    // reason `RemoveSetLoadFields` is Phase 2 and hint-tagged rather than scored.
    procedure LoadAmount(MainNo: Code[20]): Decimal
    var
        DataMain: Record "Data Main";
    begin
        DataMain.SetLoadFields(DataMain.Amount);
        DataMain.SetLoadFields();
        DataMain.Get(MainNo);
        exit(DataMain.Amount);
    end;

    // NEGATIVES on non-record receivers (rule 2). Three vars, three user-defined methods sharing a
    // builtin's name, each taking arguments and each with an observable side effect, so
    // `UserDefinedBuiltinsRun` kills all three Tier-1 mutants and a wrong Tier-2 claim moves a
    // killed mutant's operator name. The weights (100 / 10 / 1) keep each contribution separable.
    procedure RunUserDefinedBuiltins(): Integer
    var
        Loader: Codeunit "Data Loader";
        Validator: Codeunit "Data Validator";
        Builder: Codeunit "Data Builder";
    begin
        Loader.SetLoadFields(3);
        Validator.TestField(7);
        Builder.SetRange('A', 'Z');
        exit(Loader.LoadedFieldNo() * 100 + Validator.SeenTotal() * 10 + Builder.RangeWidth());
    end;

    // NEGATIVES on a RECORD receiver whose own table declares those procedures (rule 3, qualified
    // half). `ShadowedBuiltinsRun` asserts 48 = 42 + StrLen('AA') + StrLen('ZZZ') + 1, so deleting
    // any one of the three calls (including the implicit `Commit()` inside `Data Shadow`) changes
    // the total.
    procedure ShadowedBuiltins(): Integer
    var
        Shadow: Record "Data Shadow";
    begin
        Shadow.TestField(42);
        Shadow.SetRange('AA', 'ZZZ');
        exit(Shadow.BumpViaCommit());
    end;
}
