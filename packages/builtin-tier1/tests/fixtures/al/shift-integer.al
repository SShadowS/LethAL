codeunit 51600 "Shift Integer Target"
{
    // CLAIMED: an equality-family comparison operand, where nothing else touches the constant.
    procedure EqualityCompare(N: Integer): Integer
    begin
        if N = 5 then
            exit(1);
        exit(0);
    end;

    // CLAIMED: the other half of the equality family.
    procedure InequalityCompare(N: Integer): Integer
    begin
        if N <> 7 then
            exit(1);
        exit(0);
    end;

    // CLAIMED: an assigned value, in both the plain and the compound form.
    procedure AssignedValues()
    var
        Total: Integer;
    begin
        Total := 41;
        Total += 9;
    end;

    // CEDED to `conditional-boundary`, which already shifts this boundary: `N < 13` becomes
    // `N <= 13` there and `N < 14` here, and those two admit exactly the same values.
    procedure OrderingCompare(N: Integer): Integer
    begin
        if N < 13 then
            exit(1);
        exit(0);
    end;

    // The load-bearing case. The `0` is in the loop's EXIT CONDITION, where shifting it never
    // terminates once the recordset is exhausted -- R164's measured hazard, 290 such loops on one
    // real corpus. The refusal is POSITIONAL, not whole-loop, so `Seen += 1` in the loop BODY is
    // still claimed; refusing the whole loop would cost sites for no safety.
    procedure LoopExit(): Integer
    var
        Cust: Record Customer;
        Seen: Integer;
    begin
        if Cust.FindSet() then
            repeat
                Seen += 1;
            until Cust.Next() = 0;
        exit(Seen);
    end;

    // REFUSED: `n + 1` does not fit in AL's 32-bit signed Integer.
    procedure AtCeiling()
    var
        Total: Integer;
    begin
        Total := 2147483647;
    end;
}
