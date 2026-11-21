codeunit 75050 "Reach Tests"
{
    Subtype = Test;

    // Methods are declared in run order. T05 arms the SingleInstance flag that T06 and T07 depend on.

    [Test]
    procedure T01ScoreMode1()
    var
        Logic: Codeunit "Reach Logic";
    begin
        if Logic.Score(1, 5) <> 15 then
            Error('Score(1,5) = %1, expected 15', Logic.Score(1, 5));
    end;

    [Test]
    procedure T02BigMode1()
    var
        Logic: Codeunit "Reach Logic";
    begin
        if not Logic.Big(1, 11) then
            Error('Big(1,11) expected true');
        if Logic.Big(1, 10) then
            Error('Big(1,10) expected false');
    end;

    [Test]
    procedure T03TallyKind1()
    var
        Logic: Codeunit "Reach Logic";
    begin
        if Logic.Tally(1, 4) <> 12 then
            Error('Tally(1,4) = %1, expected 12', Logic.Tally(1, 4));
    end;

    [Test]
    procedure T04ClampPositive()
    var
        Logic: Codeunit "Reach Logic";
    begin
        if Logic.Clamp(5) <> 12 then
            Error('Clamp(5) = %1, expected 12', Logic.Clamp(5));
    end;

    [Test]
    procedure T05ArmState()
    var
        State: Codeunit "Reach State";
    begin
        State.Arm();
        if not State.IsArmed() then
            Error('state not armed');
    end;

    [Test]
    procedure T06LateArmed()
    var
        Logic: Codeunit "Reach Logic";
    begin
        if Logic.Late(3) <> 26 then
            Error('Late(3) = %1, expected 26', Logic.Late(3));
    end;

    [Test]
    procedure T07LateMixArmed()
    var
        Logic: Codeunit "Reach Logic";
    begin
        if Logic.LateMix(4) <> 6 then
            Error('LateMix(4) = %1, expected 6', Logic.LateMix(4));
    end;
}
