namespace LethAL.R254Probe;

using Microsoft.Foundation.AuditCodes;
using System.TestTools.CodeCoverage;
using System.Tooling;

codeunit 91610 "R254 Probe Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // EXPECTED TO FAIL: the measurement travels out through Error('MEASURED ...').
    // Mirrors LethAL Control's RunMutantWithCoverage + CoverageArray: Start/StopApplicationCoverage
    // around the run, then read the Code Coverage table filtered to this probe's ids.
    [Test]
    procedure MeasureReportExtCoverage()
    var
        CodeCoverageMgt: Codeunit "Code Coverage Mgt.";
        CodeCoverage: Record "Code Coverage";
        Sink: Codeunit "R254 Probe Sink";
        Rows: Text;
        AllRows: Integer;
    begin
        CodeCoverageMgt.StartApplicationCoverage();
        RunProbe();
        CodeCoverageMgt.StopApplicationCoverage();

        CodeCoverage.SetRange("Object ID", 91600, 91609);
        if CodeCoverage.FindSet() then
            repeat
                AllRows += 1;
                if CodeCoverage."No. of Hits" > 0 then
                    Rows += StrSubstNo('[type=%1(%2) id=%3 line=%4 hits=%5 kind=%6] ',
                        Format(CodeCoverage."Object Type", 0, 2), Format(CodeCoverage."Object Type"),
                        CodeCoverage."Object ID", CodeCoverage."Line No.", CodeCoverage."No. of Hits",
                        Format(CodeCoverage."Line Type"));
            until CodeCoverage.Next() = 0;
        Error('MEASURED base=%1 ext=%2 allRows=%3 hitRows: %4', Sink.GetBase(), Sink.GetExt(), AllRows, Rows);
    end;

    // EXPECTED TO PASS. Run this one with the hub's own coverage switched on (bcdev_test_run), to
    // read the objectType integer on the path LethAL's baseline uses.
    [Test]
    procedure ReachOnly()
    var
        Sink: Codeunit "R254 Probe Sink";
    begin
        RunProbe();
        if (Sink.GetBase() <> 6) or (Sink.GetExt() <> 21) then
            Error('unexpected base=%1 ext=%2 (want 6 and 21)', Sink.GetBase(), Sink.GetExt());
    end;

    // EXPECTED TO FAIL, carrying the answer: does a report variable keep the extension's globals
    // after RunModal? MEASURED kept=21 means yes; kept=0 means a fixture arm needs a sink.
    [Test]
    procedure ReadGlobalsAfterRunModal()
    var
        Rep: Report "R254 Probe Report";
    begin
        Rep.UseRequestPage(false);
        Rep.RunModal();
        Error('MEASURED kept=%1 (21 = globals survive RunModal)', Rep.GetExtTotal());
    end;

    // EXPECTED TO PASS. A reportextension procedure called straight through the base report's
    // variable, without running the report: the cheapest reach path for a fixture arm.
    [Test]
    procedure CallExtProcedureDirectly()
    var
        Rep: Report "R254 Probe Report";
    begin
        if Rep.Classify(2) <> 10 then
            Error('unexpected Classify(2)=%1 (want 10)', Rep.Classify(2));
    end;

    // Open question 1: does RunModal work AFTER this test wrote a row (no Commit)?
    [Test]
    procedure RunModalAfterWrite()
    var
        ReasonCode: Record "Reason Code";
        Sink: Codeunit "R254 Probe Sink";
    begin
        ReasonCode.Init();
        ReasonCode.Code := 'R254PROBE';
        ReasonCode.Description := 'R254 probe';
        ReasonCode.Insert();
        RunProbe();
        if (Sink.GetBase() <> 6) or (Sink.GetExt() <> 21) then
            Error('unexpected base=%1 ext=%2 (want 6 and 21)', Sink.GetBase(), Sink.GetExt());
    end;

    local procedure RunProbe()
    var
        Sink: Codeunit "R254 Probe Sink";
        Rep: Report "R254 Probe Report";
    begin
        Sink.Reset();
        Rep.UseRequestPage(false);
        Rep.RunModal();
    end;
}
