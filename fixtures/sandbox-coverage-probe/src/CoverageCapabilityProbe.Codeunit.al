codeunit 79320 "Coverage Capability Probe"
{
    // R58: can the FENCED path collect its own coverage?
    //
    // The feasibility probe (docs/measurements/r58-coverage-feasibility-probe.al) established that
    // the Code Coverage API is REACHABLE from an extension depending only on `Test Runner`. What it
    // could not establish is whether coverage collected INSIDE a `RunMutant` OData session records
    // anything: that session is `GuiAllowed=No`, `ClientType=ODataV4` (R57), and nothing proves the
    // platform behaves there as it does on the bc-dev-mcp hub.
    //
    // That distinction decides R58 outright. If the fenced session records coverage, the hub can go
    // and the R55/R57 dual-runner asymmetry goes with it. If it records nothing, R58 is dead and
    // containment is the only route — "measured infeasible" being a perfectly good answer to have
    // in writing.
    //
    // Run through BOTH paths exactly as the R57 session-capability probe is: point a session's
    // `--tests` here and vary ONLY `bcdev.coverageMode` (`"procedure"` = hub, `"none"` = fence).
    //
    // Its own app rather than `sandbox-probes`: that fixture declares runtime 13.0 with no
    // platform/application, so the `Test Runner` symbol does not resolve there — and it is
    // published for the frozen `itest:bcdev` gate, which is not worth perturbing for a probe.
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure ReportsCoverageCapability()
    var
        CodeCoverageMgt: Codeunit "Code Coverage Mgt.";
        CodeCoverage: Record "Code Coverage";
        Rows: Integer;
        Hits: Integer;
        OwnRows: Integer;
        Total: Integer;
    begin
        CodeCoverageMgt.StartApplicationCoverage();
        // Exercise something this extension owns, so there is a KNOWN observation to look for
        // rather than only whatever the platform happened to touch.
        Total := Exercise(25);
        CodeCoverageMgt.StopApplicationCoverage();

        if CodeCoverage.FindSet() then
            repeat
                Rows += 1;
                Hits += CodeCoverage."No. of Hits";
                // Codeunit = 5 in BC's object-type numbering (measured under R40).
                if (CodeCoverage."Object Type" = 5) and (CodeCoverage."Object ID" = 79320) then
                    OwnRows += 1;
            until CodeCoverage.Next() = 0;

        // Raised as an error so both transports carry it back verbatim — a passing test reports
        // nothing a runner surfaces. FAILED here is the transport, not a fault.
        Error(
          'MEASURED coverageRows=%1 totalHits=%2 ownObjectRows=%3 exercised=%4',
          Rows,
          Hits,
          OwnRows,
          Total);
    end;

    local procedure Exercise(N: Integer) Sum: Integer
    var
        I: Integer;
    begin
        for I := 1 to N do
            if I mod 2 = 0 then
                Sum += I
            else
                Sum -= I;
    end;
}
