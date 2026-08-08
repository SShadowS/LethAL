// The callee every arm runs through `Codeunit.Run`. Trivial on purpose, and it WRITES, because
// both prior measurements (R72's `Write Txn Target`, R73's `Data Commit Target`) had a writing
// callee — changing that here would add a fourth variable to a design built to isolate three.
//
// It flags a row keyed on a constant rather than on caller state: `Codeunit.Run` constructs a
// FRESH instance, so anything set on a caller-side variable would not arrive, and a callee that
// silently did nothing would make "the call succeeded" and "the call never happened" look alike.
codeunit 71541 "R72 Target"
{
    trigger OnRun()
    var
        Row: Record "R72 Row";
    begin
        if not Row.Get(TargetRowNo()) then begin
            Row.Init();
            Row."Entry No." := TargetRowNo();
            Row.Insert(false);
        end;
        Row.Flagged := true;
        Row.Modify(false);
    end;

    procedure TargetRowNo(): Integer
    begin
        exit(71541);
    end;
}
