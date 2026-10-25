/// R689: discovery inside a catchable Codeunit.Run boundary, as LethAL Control's RunMethod runs it
/// (`if Runner.Run()` after a Commit).
codeunit 93902 "R689 Discover Run"
{
    trigger OnRun()
    var
        Suite: Record "AL Test Suite";
        Mgt: Codeunit "Test Suite Mgt.";
    begin
        Mgt.CreateTestSuite(SuiteName);
        Suite.Get(SuiteName);
        Mgt.SelectTestMethodsByRange(Suite, Format(CodeunitId));
    end;

    procedure SetRequest(NewSuiteName: Code[10]; NewCodeunitId: Integer)
    begin
        SuiteName := NewSuiteName;
        CodeunitId := NewCodeunitId;
    end;

    var
        SuiteName: Code[10];
        CodeunitId: Integer;
}
