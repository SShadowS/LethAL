namespace LethAL.Control;

/// <summary>
/// The permission canary's test body (ROADMAP R26): the one place in LethAL that runs INSIDE a
/// test method and reports what the platform's permission state actually is there.
///
/// It exists because Microsoft's Permissions Mock (codeunit 131006, toggled by "Test Runner - Mgt"
/// 130454's `PlatformBeforeTestRun` -> `StartStopPermissionMock`) strips permissions from a test
/// body — but only on LethAL's FENCED path (`RunMutant` -> `Test Suite Mgt.RunAllTests`), and only
/// when that Microsoft app happens to be installed. The dev-service path used for baseline and
/// coverage runs is unaffected. Consequence, measured both ways: a test that writes to its own
/// app's tables fails inside the fence only, so its mutant lands `error cause=unstable` and is
/// silently UNSCORED rather than killed — and because it hinges on whether an app is installed,
/// the same project can score differently on two servers with nothing in the report saying which
/// world it ran in. This codeunit is what puts that in the report.
///
/// ############################################################################################
/// #  DO NOT WRAP THE Insert BELOW IN A [TryFunction] (OR ANY OTHER ERROR TRAP).               #
/// ############################################################################################
///
/// MEASURED LIVE, and the whole reason this file was rewritten (Cronus282, control app 1.0.0.3):
/// the first version of this canary called the `Insert` from a `[TryFunction]`, so it could
/// capture `GetLastErrorText()` and always return normally. The platform refused the call outright:
///
///     Call to the function 'INSERT' is not allowed inside the call to 'RunTests'
///     when it is used as a TryFunction.
///
/// That refusal is a TryFunction-CONTRACT violation, not an ordinary runtime error — it is not
/// caught by the very [TryFunction] that triggered it; it unwinds straight past it and aborts the
/// test method. So the canary never reached its recording call (`observed:false`), and the thing it
/// actually measured was "the platform forbids writes inside a TryFunction under RunTests" — a
/// statement about the canary's own call shape, having nothing to do with permissions. Permissions
/// were never consulted.
///
/// The proof that this was a call-shape difference and not a platform-wide truth: `RunMutant`'s own
/// path reaches a real, unwrapped `Insert` in the fixture's `InsertDoublesAmountWeak`
/// (`fixtures/sandbox-data-tests/src/DataTests.Codeunit.al`) and gets the PERMISSIONS refusal —
/// "Sorry, the current permissions prevented the action" — which is exactly the signal this canary
/// exists to observe. Same server, same test framework, different call shape. A canary that does
/// not travel the path it characterises measures nothing, and is worse than no canary at all
/// because it reports confidently about a path it never entered.
///
/// SO THE INSERT IS PLAIN, and the method is therefore ALLOWED TO FAIL. Under the mock it aborts at
/// the `Insert` and the framework records a failure; that is the expected shape of the mocked
/// world, not a malfunction. What makes that survivable is the two-stage recording below: the
/// permission flags are written to "LC Permission Canary State" BEFORE the write is attempted, so
/// an aborting write cannot erase what was already known, and a second flag is set AFTER it, which
/// only a permitted write can reach. Those globals live in the session, not the database, so the
/// abort and its rollback do not touch them — the identical property "LC Control State"'s
/// attestation already depends on for every KILLED (i.e. failing) mutant on this same path.
/// </summary>
codeunit 71010 "LC Permission Canary"
{
    Subtype = Test;

    /// <summary>Records `ReadPermission`/`WritePermission` on "LC Permission Probe", then attempts
    /// a real, unwrapped `Insert` on it — the same call shape an ordinary test body uses.
    ///
    /// The probe table has NO `InherentPermissions` — that omission is the whole measurement; see
    /// `PermissionProbe.Table.al`'s summary before touching either object.</summary>
    [Test]
    procedure ProbeInherentPermissions()
    var
        Probe: Record "LC Permission Probe";
        CanaryState: Codeunit "LC Permission Canary State";
    begin
        // STAGE 1 — recorded BEFORE the write, because the write may abort this method outright
        // (it does, under the mock). Reading the two flags first also means nothing the write does,
        // or rolls back, can influence what they report.
        CanaryState.ObservePermissions(Probe.ReadPermission(), Probe.WritePermission());

        // STAGE 2 — the measurement: a PLAIN Insert, in the test body, exactly as
        // `InsertDoublesAmountWeak` does it on the path this canary characterises. No TryFunction,
        // no asserterror, no `if ... then` swallow: any error trap here either changes the call
        // shape (see this codeunit's summary) or converts the abort into a pass, and both destroy
        // the signal. When permissions are stripped this line raises and the method ends here,
        // leaving stage 1's observation intact and stage 3 deliberately unreached.
        //
        // A FRESH GUID key per run, never a fixed one. Rows inserted on this path PERSIST between
        // runs — LethAL's two-phase fence commits around each mutant run, as the fixture's own
        // `InsertDoublesAmountWeak` records the hard way — so a constant key would make every run
        // after the first fail with "the record already exists", which this canary would then read
        // as evidence of stripped permissions. That is the project's signature bug in miniature: a
        // result that looks like a measurement and is an artefact of leftover state.
        Probe.Init();
        Probe."Primary Key" := NewProbeKey();
        Probe.Insert(true);

        // STAGE 3 — reached ONLY when the write was permitted. Its own presence is the observation;
        // there is nothing to record about an insert that never happened, and the API layer reports
        // exactly that (see "LC Permission Canary State".InsertSucceeded).
        CanaryState.ObserveInsertSucceeded();

        // Cleanup, deliberately LAST and deliberately unguarded. It runs only in the world where a
        // write is permitted, so it is expected to succeed there; and because it comes after stage
        // 3, a failure here can only fail the test line — it can no longer change or erase a
        // complete observation.
        Probe.Delete(true);
    end;

    /// <summary>20 characters of a fresh GUID — unique per run, within Code[20].</summary>
    local procedure NewProbeKey(): Code[20]
    begin
        exit(CopyStr(DelChr(Format(CreateGuid()), '=', '{}-'), 1, 20));
    end;
}
