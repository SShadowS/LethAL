// The NON-test frame. Arms A3/A4/A7/A8 reach `Codeunit.Run` through here instead of writing it in
// the `[Test]` method's own body, which is the one structural difference between R72's original
// probe (aborted) and `Data Commit Ops.CommitThenRun` (survived on the live gate).
//
// Deliberately an ordinary codeunit, called on a variable, exactly as `Data Commit Ops` is: the
// question is whether BC's refusal depends on WHOSE frame opens the write and issues the call.
codeunit 71542 "R72 Callee"
{
    /// Write, then `Codeunit.Run` with its RETURN VALUE consumed.
    procedure WriteThenRunValueForm(EntryNo: Integer): Boolean
    var
        Row: Record "R72 Row";
        Ran: Boolean;
    begin
        Write(Row, EntryNo);
        Ran := Codeunit.Run(Codeunit::"R72 Target");
        exit(Ran);
    end;

    /// Write, then `Codeunit.Run` as a bare STATEMENT, its return value discarded.
    procedure WriteThenRunStatementForm(EntryNo: Integer)
    var
        Row: Record "R72 Row";
    begin
        Write(Row, EntryNo);
        Codeunit.Run(Codeunit::"R72 Target");
    end;

    local procedure Write(var Row: Record "R72 Row"; EntryNo: Integer)
    begin
        if Row.Get(EntryNo) then
            Row.Delete(false);
        Row.Init();
        Row."Entry No." := EntryNo;
        Row.Insert(false);
    end;
}
