codeunit 71770 "SL Probe Tests A"
{
    // Runs first (lower id). Sets the mode and resets it; passes with or without the mutant.
    Subtype = Test;

    [Test]
    procedure BeginAndEnd()
    var
        State: Codeunit "SL Probe State";
    begin
        State.BeginIt();
        State.EndIt();
    end;
}

codeunit 71771 "SL Probe Tests B"
{
    // Runs second. Expects the plain answer, so it fails if A's mode leaked in (the mutant emptied EndIt). It then calls
    // EndIt itself as cleanup, so it COVERS the mutated block and runs under the mutant.
    Subtype = Test;

    [Test]
    procedure ComputeIsPlain()
    var
        Logic: Codeunit "SL Probe Logic";
        State: Codeunit "SL Probe State";
    begin
        if Logic.Compute(3) <> 3 then
            Error('expected 3 (mode off), got %1: the mode leaked in from an earlier codeunit', Logic.Compute(3));
        State.EndIt();
    end;
}

codeunit 71772 "SL Probe Burner"
{
    // PR-340 step 0b: covers nothing in the target and burns CPU for a fixed number of iterations (al-runner's clock
    // does not advance inside a loop, so a clock-bounded loop ends at once). A carry walk excludes it, so if its time
    // shows up in a walk's testsMs, excluded codeunits run hidden.
    Subtype = Test;

    [Test]
    procedure BurnTwoSeconds()
    var
        I: Integer;
        X: Integer;
    begin
        for I := 1 to 3000000 do
            X := (X * 31 + I) mod 1000003;
        if X < 0 then
            Error('unreachable');
    end;
}
