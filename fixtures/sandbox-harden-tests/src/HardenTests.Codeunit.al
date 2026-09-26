codeunit 79550 "Harden Tests"
{
    Subtype = Test;
    // Decision 6 of the C02-03 plan: BC's restrictive default refuses DeleteAll/Insert in a test body.
    TestPermissions = Disabled;

    // The base suite. It kills every mutant of sandbox-harden except the five planted survivors,
    // and each target procedure is called by exactly one test here, so a kill's killer is fixed.
    // Asserts via Error() rather than Library Assert, like sandbox-hang-tests.

    [Test]
    procedure IsLargeSeparatesSmallFromLarge()
    var
        Logic: Codeunit "Harden Logic";
    begin
        if not Logic.IsLarge(500) then
            Error('IsLarge(500) should be true, got false');
        if Logic.IsLarge(50) then
            Error('IsLarge(50) should be false, got true');
    end;

    [Test]
    procedure CountInCategoryCountsRows()
    var
        Logic: Codeunit "Harden Logic";
        Entry: Record "Harden Entry";
        Got: Integer;
    begin
        Entry.DeleteAll();
        InsertEntry(1, 'A', 1);
        InsertEntry(2, 'A', 2);
        Got := Logic.CountInCategory('A');
        if Got <> 2 then
            Error('CountInCategory(A) should be 2, got %1', Got);
    end;

    [Test]
    procedure FirstAmountReadsARow()
    var
        Logic: Codeunit "Harden Logic";
        Entry: Record "Harden Entry";
        Got: Integer;
    begin
        Entry.DeleteAll();
        InsertEntry(1, 'A', 7);
        Got := Logic.FirstAmount();
        if Got <> 7 then
            Error('FirstAmount() should be 7, got %1', Got);
    end;

    [Test]
    procedure SetAmountStoresTheAmount()
    var
        Logic: Codeunit "Harden Logic";
        Entry: Record "Harden Entry";
    begin
        Entry.Init();
        Logic.SetAmount(Entry, 5);
        if Entry.Amount <> 5 then
            Error('SetAmount(Entry, 5) should leave Amount 5, got %1', Entry.Amount);
    end;

    [Test]
    procedure AmountValidateDoublesIt()
    var
        Entry: Record "Harden Entry";
    begin
        Entry.Init();
        Entry.Validate(Amount, 5);
        if Entry.Doubled <> 10 then
            Error('Validate(Amount, 5) should leave Doubled 10, got %1', Entry.Doubled);
    end;

    [Test]
    procedure BonusForPaysOnlyAboveTen()
    var
        Logic: Codeunit "Harden Logic";
        Got: Integer;
    begin
        // ONE instance on purpose: if AL carried a local across calls, BonusFor(10) would return 11.
        Got := Logic.BonusFor(11);
        if Got <> 11 then
            Error('BonusFor(11) should be 11, got %1', Got);
        Got := Logic.BonusFor(10);
        if Got <> 0 then
            Error('BonusFor(10) should be 0, got %1', Got);
        Got := Logic.BonusFor(5);
        if Got <> 0 then
            Error('BonusFor(5) should be 0, got %1', Got);
    end;

    local procedure InsertEntry(EntryNo: Integer; Cat: Code[10]; Amt: Integer)
    var
        Entry: Record "Harden Entry";
    begin
        Entry.Init();
        Entry."Entry No." := EntryNo;
        Entry.Category := Cat;
        Entry.Amount := Amt;
        Entry.Insert();
    end;
}
