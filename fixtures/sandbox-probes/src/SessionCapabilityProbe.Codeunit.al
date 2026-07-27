codeunit 79213 "Session Capability Probe"
{
    // R57: WHY do the bc-dev-mcp hub path and LethAL's fenced RunMutant path disagree about whether
    // a test passes?
    //
    // Measured on Continia Document Output (R55): 12 of 56 tests fail through the hub and pass
    // through the fence, order-independently. The most informative failure is
    // `Unhandled UI: Confirm Document Output has not been activated ...` — raised from Continia
    // Core's `IsAppActiveOrAskToActivate`, in test codeunits that declare NO handler functions at
    // all. BC raises `Unhandled UI` for a `Confirm` only in a session it treats as INTERACTIVE; a
    // non-GUI session returns the Confirm's default silently and the caller takes the other branch.
    //
    // That makes session capability the prime suspect, and it is directly measurable rather than
    // arguable. This probe reports it from INSIDE a test body, so whatever the runner did to the
    // session is what gets reported — the same reason the R1/R26 permission work had to measure the
    // platform rather than reason about it.
    //
    // Deliberately in `sandbox-probes`: that fixture is published and driven separately and is NOT
    // part of any frozen mutation baseline, so adding a test here cannot move `itest:bcdev` or
    // `itest:tables`. Adding it to `sandbox-tests` would have.
    Subtype = Test;
    // Without this a test codeunit defaults to restrictive permissions and Microsoft's Permissions
    // Mock refuses writes from its body on EVERY runner (R1). This probe writes nothing, but the
    // declaration keeps it shaped like a real suite's codeunit so the measurement describes the
    // shape real tests have.
    TestPermissions = Disabled;

    [Test]
    procedure ReportsSessionCapabilities()
    begin
        // Raised as an ERROR on purpose: a passing test reports nothing a runner surfaces, while a
        // failure message is carried back verbatim by both paths. The test showing as FAILED is the
        // transport, not a broken probe — see docs/measurements/README.md.
        Error(
          'MEASURED GuiAllowed=%1 | ClientType=%2 | Company=%3 | UserId=%4',
          GuiAllowed,
          Format(CurrentClientType),
          CompanyName,
          UserId);
    end;
}
