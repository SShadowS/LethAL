codeunit 79500 "Harden Logic"
{
    // S1 conditional-boundary: no base test asks about exactly 100.
    procedure IsLarge(Amount: Integer): Boolean
    begin
        exit(Amount > 100);
    end;

    // S2 remove-setrange: every row in the base test is in the wanted category.
    procedure CountInCategory(WantedCategory: Code[10]): Integer
    var
        Entry: Record "Harden Entry";
    begin
        Entry.SetRange(Category, WantedCategory);
        exit(Entry.Count());
    end;

    // S3 swap-find-direction: the base test inserts one row, so first and last are the same.
    procedure FirstAmount(): Integer
    var
        Entry: Record "Harden Entry";
    begin
        if Entry.FindFirst() then
            exit(Entry.Amount);
        exit(0);
    end;

    // S4 validate-to-assign: the base test reads Amount, never Doubled, which OnValidate sets.
    procedure SetAmount(var Entry: Record "Harden Entry"; NewAmount: Integer)
    begin
        Entry.Validate(Amount, NewAmount);
    end;

    // S5, the planted EQUIVALENT: a local starts at 0 on every call, so `Bonus := 0` changes nothing.
    // Bonus must stay a LOCAL; as a global it would be killable (fixtures/README.md, sandbox-harden).
    procedure BonusFor(Amount: Integer): Integer
    var
        Bonus: Integer;
    begin
        Bonus := 0;
        if Amount > 10 then
            Bonus := Amount;
        exit(Bonus);
    end;
}
