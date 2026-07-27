codeunit 79323 "Frame And Reset Probe"
{
    // R58 unknowns #2 and #3, the two the spec calls out as cheap and possibly decisive.
    //
    // #2 FRAME: is `Code Coverage."Line No."` file-relative or object-relative? `AaFrame` exercises
    //    `Probe Obj Two`, whose procedure sits low in a two-object file (see TwoObjects.Codeunit.al),
    //    and reports the raw lines recorded for THAT object id.
    //
    // #3 RESET: does `StartApplicationCoverage` CLEAR the table or ACCUMULATE across calls? The
    //    baseline calls it once per test, so if it accumulates, test N is credited with tests
    //    1..N-1's coverage — silently, and per-test attribution becomes meaningless. `ZzReset`
    //    exercises NOTHING and reports whether `Probe Obj Two` (touched only by `AaFrame`) is still
    //    present. Rows for it here mean the table accumulated across two separate fenced calls.
    //
    // Named Aa*/Zz* so discovery order is deterministic — the same trick `OrderMattersProbe` uses.
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure AaFrameOfLineNumbers()
    var
        CodeCoverageMgt: Codeunit "Code Coverage Mgt.";
        CodeCoverage: Record "Code Coverage";
        Two: Codeunit "Probe Obj Two";
        Lines: Text;
        Total: Integer;
    begin
        CodeCoverageMgt.StartApplicationCoverage();
        Total := Two.Second(9);
        CodeCoverageMgt.StopApplicationCoverage();

        CodeCoverage.SetRange("Object Type", 5);
        CodeCoverage.SetRange("Object ID", 79322);
        if CodeCoverage.FindSet() then
            repeat
                if Lines <> '' then
                    Lines += ',';
                Lines += Format(CodeCoverage."Line No.");
            until CodeCoverage.Next() = 0;

        Error('MEASURED frame obj79322Lines=[%1] exercised=%2', Lines, Total);
    end;

    [Test]
    procedure ZzResetBetweenRuns()
    var
        CodeCoverageMgt: Codeunit "Code Coverage Mgt.";
        CodeCoverage: Record "Code Coverage";
        StaleRows: Integer;
        StaleHits: Integer;
    begin
        // Deliberately exercises nothing between start and stop.
        CodeCoverageMgt.StartApplicationCoverage();
        CodeCoverageMgt.StopApplicationCoverage();

        CodeCoverage.SetRange("Object Type", 5);
        CodeCoverage.SetRange("Object ID", 79322);
        if CodeCoverage.FindSet() then
            repeat
                StaleRows += 1;
                StaleHits += CodeCoverage."No. of Hits";
            until CodeCoverage.Next() = 0;

        // staleRows=0        -> Start CLEARS; per-test attribution is sound.
        // staleRows>0 hits>0 -> it ACCUMULATES; every test inherits its predecessors' coverage and
        //                       selection silently collapses toward all-tests.
        Error('MEASURED reset staleRows=%1 staleHits=%2', StaleRows, StaleHits);
    end;
}
