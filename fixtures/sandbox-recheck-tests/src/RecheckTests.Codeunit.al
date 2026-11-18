// Declared order matters: al-runner v3 runs a codeunit's tests in this order (PR-162, spec amendment 6).
// Under the remove-assignment mutant of `C := '7'`, Sevens(10) is ten NUL characters. A0_ParsesSevens and
// B0_ParsesSevens then hit a refusal mid-run (the Evaluate of a NUL text), and what BC would still run after that
// point holds a Page.RunModal of page 0, which is not in al-runner's program. So the refusal's remaining reach is
// unknown, and the NEXT test's failure is withheld. B2_SeesTheMark passes after B1_OneSevenAndMarks in one
// codeunit run (TestIsolation = Function keeps the codeunit's variables) and fails alone: that is what the
// recheck's rule (e) must notice.
codeunit 76050 "Recheck A Tests"
{
    Subtype = Test;

    var
        Logic: Codeunit "Recheck Logic";

    [Test]
    procedure A0_ParsesSevens()
    var
        R: Record "Recheck Row";
        D: Decimal;
        T: Text;
    begin
        T := Logic.Sevens(10);
        if not Evaluate(D, T) then
            Error('Sevens(10) must parse as a number');
        if D < 0 then
            Page.RunModal(0, R);
    end;

    [Test]
    procedure A1_OneSeven()
    begin
        if Logic.Sevens(1) <> '7' then
            Error('Sevens(1) must be 7');
    end;
}

codeunit 76051 "Recheck B Tests"
{
    Subtype = Test;

    var
        Logic: Codeunit "Recheck Logic";
        Marked: Boolean;

    [Test]
    procedure B0_ParsesSevens()
    var
        R: Record "Recheck Row";
        D: Decimal;
        T: Text;
    begin
        T := Logic.SevensB(10);
        if not Evaluate(D, T) then
            Error('SevensB(10) must parse as a number');
        if D < 0 then
            Page.RunModal(0, R);
    end;

    [Test]
    procedure B1_OneSevenAndMarks()
    begin
        Marked := true;
        if Logic.SevensB(1) <> '7' then
            Error('SevensB(1) must be 7');
    end;

    [Test]
    procedure B2_SeesTheMark()
    begin
        if not Marked then
            Error('B1_OneSevenAndMarks must have run first in this codeunit');
    end;
}
