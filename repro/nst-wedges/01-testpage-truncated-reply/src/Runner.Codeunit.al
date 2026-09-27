namespace NstRepro01;

using System.TestTools.TestRunner;

// Builds a one-codeunit test suite, marks exactly one method to run, runs it with
// Test Suite Mgt.RunAllTests and keeps TestResultsToJSON. Called through `if Runner.Run()` so an
// error that escapes the test runner is caught instead of failing the OData request.
codeunit 91601 "NST Repro01 Runner"
{
    var
        TestMethod: Text;
        ResultsJson: Text;

    trigger OnRun()
    var
        Suite: Record "AL Test Suite";
        Line: Record "Test Method Line";
        Mgt: Codeunit "Test Suite Mgt.";
        SuiteName: Code[10];
    begin
        SuiteName := 'NSTREPRO01';
        if Suite.Get(SuiteName) then
            Suite.Delete(true);
        Mgt.CreateTestSuite(SuiteName);
        Suite.Get(SuiteName);
        Mgt.SelectTestMethodsByRange(Suite, Format(Codeunit::"NST Repro01 Tests"));

        Line.SetRange("Test Suite", SuiteName);
        Line.SetRange("Line Type", Line."Line Type"::"Function");
        if Line.FindSet() then
            repeat
                Line.Validate(Run, false);
                Line.Modify(true);
            until Line.Next() = 0;
        Line.SetRange(Name, TestMethod);
        if Line.Count() <> 1 then
            Error('expected exactly one test method named %1', TestMethod);
        Line.FindFirst();
        Line.Validate(Run, true);
        Line.Modify(true);

        Line.Reset();
        Line.SetRange("Test Suite", SuiteName);
        Line.FindFirst();
        Mgt.RunAllTests(Line);

        Line.SetRange("Line Type", Line."Line Type"::Codeunit);
        Line.FindFirst();
        ResultsJson := Mgt.TestResultsToJSON(Line);
    end;

    procedure SetTestMethod(NewTestMethod: Text)
    begin
        TestMethod := NewTestMethod;
        ResultsJson := '';
    end;

    procedure Results(): Text
    begin
        exit(ResultsJson);
    end;
}
