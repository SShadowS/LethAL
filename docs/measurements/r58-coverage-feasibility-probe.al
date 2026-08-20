codeunit 91098 "LC Coverage Feasibility"
{
    // R58 FEASIBILITY PROBE — does not ship.
    //
    // Question: can `RunMutant` collect per-procedure coverage itself, on the FENCED path, so the
    // hub (and with it the R55/R57 dual-runner asymmetry) can be deleted entirely?
    //
    // This compiles ONLY if the Code Coverage API is reachable from an extension whose sole
    // dependency is Microsoft's `Test Runner` — which is exactly what `LethAL Control` declares.

    procedure Probe(): Text
    var
        CodeCoverageMgt: Codeunit "Code Coverage Mgt.";
        CodeCoverage: Record "Code Coverage";
        ObjType: Integer;
        ObjId: Integer;
        LineNo: Integer;
        Hits: Integer;
    begin
        // Start/stop around an invocation — the shape RunMutant would need.
        CodeCoverageMgt.StartApplicationCoverage();
        CodeCoverageMgt.StopApplicationCoverage();

        // And read it back keyed the way `buildCoverageMap` needs: (objectType, objectId) plus a
        // per-line/procedure granularity and a hit count.
        if CodeCoverage.FindSet() then
            repeat
                ObjType := CodeCoverage."Object Type";
                ObjId := CodeCoverage."Object ID";
                LineNo := CodeCoverage."Line No.";
                Hits += CodeCoverage."No. of Hits";
            until CodeCoverage.Next() = 0;

        exit(Format(ObjType) + Format(ObjId) + Format(LineNo) + Format(Hits));
    end;
}
