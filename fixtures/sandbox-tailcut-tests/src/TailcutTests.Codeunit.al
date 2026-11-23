// Declared order matters: al-runner v3 runs a codeunit's tests in this order.
// G0_TripleTwo is a green covering test BEFORE the refusal, so the PR-250 cut entry is not empty.
// T0_RefusedFormat is refused at every baseline (Format with a 2-length Integer format string, not pinned) and covers no mutant.
// T4_SeesTheMark passes after T3_SetsMark in one codeunit run and fails alone (unstable).
codeunit 76150 "Tailcut Tests"
{
    Subtype = Test;

    var
        Logic: Codeunit "Tailcut Logic";
        Marked: Boolean;

    [Test]
    procedure G0_TripleTwo()
    begin
        if Logic.Triple(2) <> 6 then
            Error('Triple(2) must be 6');
    end;

    [Test]
    procedure T0_RefusedFormat()
    var
        T: Text;
    begin
        T := Format(8, 2, '<Integer,2>');
        if T = 'x' then
            Error('unreachable');
    end;

    [Test]
    procedure T1_DoubleTwo()
    begin
        if Logic.Double(2) <> 4 then
            Error('Double(2) must be 4');
    end;

    [Test]
    procedure T2_IsBigTen()
    begin
        if not Logic.IsBig(10) then
            Error('IsBig(10) must be true');
    end;

    [Test]
    procedure T3_SetsMark()
    begin
        Marked := true;
    end;

    [Test]
    procedure T4_SeesTheMark()
    begin
        if not Marked then
            Error('T3 must run first');
        if Logic.IsBig(5) then
            Error('IsBig(5) must be false');
    end;

    [Test]
    procedure T5_IsSmallOne()
    begin
        if not Logic.IsSmall(1) then
            Error('IsSmall(1) must be true');
    end;

    [Test]
    procedure T6_HalveZero()
    begin
        if Logic.Halve(0) <> 0 then
            Error('Halve(0) must be 0');
    end;

    [Test]
    procedure T7_HalveTen()
    begin
        if Logic.Halve(10) <> 5 then
            Error('Halve(10) must be 5');
    end;
}
