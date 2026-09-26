codeunit 79575 "Harden Answer Key"
{
    Subtype = Test;
    // Decision 6 of the C02-03 plan: BC's restrictive default refuses DeleteAll/Insert in a test body.
    TestPermissions = Disabled;

    // The answer key. K1 to K4 each kill one actionable survivor of sandbox-harden (S1 to S4).
    // K5 is the test an agent would write to attack the planted equivalent S5; it must PASS on it.
    // Asserts via Error() rather than Library Assert, like sandbox-hang-tests.

    // K1 kills S1 (conditional-boundary on IsLarge).
    [Test]
    procedure IsLargeAtTheBoundary()
    var
        Logic: Codeunit "Harden Logic";
    begin
        if Logic.IsLarge(100) then
            Error('IsLarge(100) should be false, got true');
    end;

    // K2 kills S2 (remove-setrange on CountInCategory).
    [Test]
    procedure CountInCategoryIgnoresOtherCategories()
    var
        Logic: Codeunit "Harden Logic";
        Entry: Record "Harden Entry";
        Got: Integer;
    begin
        Entry.DeleteAll();
        InsertEntry(1, 'A', 1);
        InsertEntry(2, 'A', 2);
        InsertEntry(3, 'B', 3);
        Got := Logic.CountInCategory('A');
        if Got <> 2 then
            Error('CountInCategory(A) should be 2, got %1', Got);
    end;

    // K3 kills S3 (swap-find-direction on FirstAmount).
    [Test]
    procedure FirstAmountReadsTheFirstRow()
    var
        Logic: Codeunit "Harden Logic";
        Entry: Record "Harden Entry";
        Got: Integer;
    begin
        Entry.DeleteAll();
        InsertEntry(1, 'A', 7);
        InsertEntry(2, 'A', 9);
        Got := Logic.FirstAmount();
        if Got <> 7 then
            Error('FirstAmount() should be 7, got %1', Got);
    end;

    // K4 kills S4 (validate-to-assign on SetAmount).
    [Test]
    procedure SetAmountRunsValidation()
    var
        Logic: Codeunit "Harden Logic";
        Entry: Record "Harden Entry";
    begin
        Entry.Init();
        Logic.SetAmount(Entry, 5);
        if Entry.Doubled <> 10 then
            Error('SetAmount(Entry, 5) should leave Doubled 10, got %1', Entry.Doubled);
    end;

    // K5 attacks S5 (remove-assignment on Bonus := 0) and is expected to PASS on the mutant.
    [Test]
    procedure BonusForTwiceOnOneInstance()
    var
        Logic: Codeunit "Harden Logic";
        Got: Integer;
    begin
        Got := Logic.BonusFor(11);
        if Got <> 11 then
            Error('BonusFor(11) should be 11, got %1', Got);
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
