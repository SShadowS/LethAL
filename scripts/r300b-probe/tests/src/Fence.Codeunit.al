namespace LethAL.R300bProbe.Tests;

using LethAL.R300bProbe;
using System.TestTools.CodeCoverage;
using System.Tooling;

// Self-measuring tests: each opens BC application coverage the way LethAL Control's
// RunMutantWithCoverage does ("Code Coverage Mgt.".StartApplicationCoverage / Stop), calls ONE target
// object's Hit procedure, then reads the same "Code Coverage" table the fence reads, filtered to
// that object, and carries every row out through Error(). Every test FAILS BY DESIGN: the failure
// text is the measurement. Run on BC only (al-runner gets a copy of the test app without this file).
codeunit 91931 "R300b Fence"
{
    Subtype = Test;

    [Test]
    procedure FenceW1()
    var
        T: Codeunit "R300b W1 Wrapped";
    begin
        Start();
        T.Hit();
        Report(91900);
    end;

    [Test]
    procedure FenceC1()
    var
        T: Codeunit "R300b C1 Control";
    begin
        Start();
        T.Hit();
        Report(91901);
    end;

    [Test]
    procedure FenceE1()
    var
        T: Codeunit "R300b E1 TwoArm";
    begin
        Start();
        T.AElseHit();
        Report(91902);
    end;

    [Test]
    procedure FenceP()
    var
        T: Codeunit "R300b M1 P Before";
    begin
        Start();
        T.Hit();
        Report(91903);
    end;

    [Test]
    procedure FenceQ()
    var
        T: Codeunit "R300b M1 Q Wrapped";
    begin
        Start();
        T.QIfHit();
        Report(91904);
    end;

    [Test]
    procedure FenceR()
    var
        T: Codeunit "R300b M1 R After";
    begin
        Start();
        T.Hit();
        Report(91905);
    end;

    local procedure Start()
    begin
        CodeCoverageMgt.StartApplicationCoverage();
    end;

    // Every row of the object, hit or not: L<line no.>/<line type>/<hits>/<first 40 chars of BC's own
    // copy of the line>. The zero-hit rows show which lines BC treats as statements at all.
    local procedure Report(ObjectId: Integer)
    var
        CodeCoverage: Record "Code Coverage";
        Out: TextBuilder;
    begin
        CodeCoverageMgt.StopApplicationCoverage();
        CodeCoverage.SetRange("Object Type", CodeCoverage."Object Type"::Codeunit);
        CodeCoverage.SetRange("Object ID", ObjectId);
        Out.Append(StrSubstNo('MEASURED obj=%1 rows=', ObjectId));
        if CodeCoverage.FindSet() then
            repeat
                Out.Append(StrSubstNo('L%1/%2/%3/%4|', CodeCoverage."Line No.", CodeCoverage."Line Type", CodeCoverage."No. of Hits", CopyStr(DelChr(CodeCoverage.Line, '<', ' '), 1, 40)));
            until CodeCoverage.Next() = 0
        else
            Out.Append('NONE');
        Error(Out.ToText());
    end;

    var
        CodeCoverageMgt: Codeunit "Code Coverage Mgt.";
}
