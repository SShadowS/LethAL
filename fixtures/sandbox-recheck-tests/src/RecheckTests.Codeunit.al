// Declared order matters: al-runner v3 runs a codeunit's tests in this order (PR-162, spec amendment 7).
// A0_RefusedWithUnknownReach and B0_RefusedWithUnknownReach build a NUL text of their own (not from Sevens or
// SevensB) and Evaluate it: al-runner refuses that at EVERY baseline, and what BC would still run after the
// refusal point holds a Page.RunModal of page 0, which is not in al-runner's program (an unknown reach). They
// cover no mutant, so a covering test's failure after them is the mutant's FIRST non-pass row, and is withheld.
// The baseline is therefore 3 of 5 passing by design: A0 and B0 are refused.
// A1_OneSeven is the only covering test of the Sevens mutant, so the recheck recovers it. B2_SeesTheMark passes
// after B1_OneSevenAndMarks in one codeunit run (one instance of the test codeunit runs all its tests, so its global variables carry over; TestIsolation only governs database rollback) and
// fails alone: that is what the recheck's rule (e) must notice for the SevensB mutant.
codeunit 76050 "Recheck A Tests"
{
    Subtype = Test;

    var
        Logic: Codeunit "Recheck Logic";

    [Test]
    procedure A0_RefusedWithUnknownReach()
    var
        R: Record "Recheck Row";
        D: Decimal;
        T: Text;
        Ch: Char;
        I: Integer;
    begin
        Ch := 0;
        for I := 1 to 10 do
            T += Format(Ch);
        if not Evaluate(D, T) then
            Error('a NUL text must parse');
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
    procedure B0_RefusedWithUnknownReach()
    var
        R: Record "Recheck Row";
        D: Decimal;
        T: Text;
        Ch: Char;
        I: Integer;
    begin
        Ch := 0;
        for I := 1 to 10 do
            T += Format(Ch);
        if not Evaluate(D, T) then
            Error('a NUL text must parse');
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
