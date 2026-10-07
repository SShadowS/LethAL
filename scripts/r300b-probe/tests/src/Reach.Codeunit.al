namespace LethAL.R300bProbe.Tests;

using LethAL.R300bProbe;

// Plain tests: each reaches ONE target object's Hit procedure and passes. Used by the hub
// (coverage procedure), bcdev line coverage, and both al-runner legs. Never calls a Miss procedure.
codeunit 91930 "R300b Reach"
{
    Subtype = Test;

    [Test]
    procedure ReachW1()
    var
        T: Codeunit "R300b W1 Wrapped";
    begin
        Check(T.Hit(), 9002);
    end;

    [Test]
    procedure ReachC1()
    var
        T: Codeunit "R300b C1 Control";
    begin
        Check(T.Hit(), 9052);
    end;

    [Test]
    procedure ReachE1()
    var
        T: Codeunit "R300b E1 TwoArm";
    begin
        Check(T.AElseHit(), 9152);
    end;

    [Test]
    procedure ReachP()
    var
        T: Codeunit "R300b M1 P Before";
    begin
        Check(T.Hit(), 9202);
    end;

    [Test]
    procedure ReachQ()
    var
        T: Codeunit "R300b M1 Q Wrapped";
    begin
        Check(T.QIfHit(), 9302);
    end;

    [Test]
    procedure ReachR()
    var
        T: Codeunit "R300b M1 R After";
    begin
        Check(T.Hit(), 9402);
    end;

    local procedure Check(Actual: Integer; Expected: Integer)
    begin
        if Actual <> Expected then
            Error('R300b reach: got %1, expected %2', Actual, Expected);
    end;
}
