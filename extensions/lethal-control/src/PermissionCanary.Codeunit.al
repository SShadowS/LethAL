namespace LethAL.Control;

/// <summary>
/// The permission canary's test body (ROADMAP R26): the one place in LethAL that runs INSIDE a
/// test method and reports what the platform's permission state actually is there.
///
/// WHAT IT ASKS NOW, AND WHY THAT CHANGED. This object was built on a diagnosis that direct
/// measurement has since DISPROVED. The belief was that Microsoft's Permissions Mock (codeunit
/// 131006, toggled by "Test Runner - Mgt" 130454's `PlatformBeforeTestRun` ->
/// `StartStopPermissionMock`) strips a test body's permissions specifically on LethAL's FENCED path
/// (`RunMutant` -> `Test Suite Mgt.RunAllTests`), so that a project could score differently on two
/// servers depending on whether that Microsoft app happened to be installed. It does not.
///
/// MEASURED (2026-07-26), A/B on ONE property: two probe codeunits identical except for
/// `TestPermissions`, same app, same tables, same server, Permissions Mock running in BOTH arms.
/// `TestPermissions` omitted (i.e. Restrictive, the AL default) -> writes REFUSED.
/// `TestPermissions = Disabled` -> writes SUCCEED. The invocation path is not the variable; the
/// property on the test codeunit is. `continia test run` reaches the same 130454 runner with the
/// mock started, exactly as `RunMutant` does, and refuses a Restrictive codeunit on that path too.
/// Real suites declare the property — the Continia Document Output suite does so on 77 of 77 test
/// codeunits, and carries `InherentPermissions` on zero tables.
///
/// So the question this canary answers is now the honest, WEAKER one:
///
///     CAN A CORRECTLY-DECLARED TEST CODEUNIT (`TestPermissions = Disabled`) WRITE A TABLE OF ITS
///     OWN APP ON THIS SERVER?
///
/// Expected answer: YES ('not-mocked') on every server we have. That makes it a PRECONDITION CHECK
/// rather than a scoring caveat: it is what would catch Microsoft changing the rule so that even a
/// `Disabled` codeunit gets stripped — the one future in which LethAL's fenced runs would start
/// losing kills for a reason no target-side declaration can fix. The genuinely actionable half of
/// the old story now lives in the runner, which NAMES `TestPermissions` when a TARGET suite's test
/// is refused (`describeTestPermissionsRefusal`, `packages/runner/src/permission-canary.ts`).
///
/// ############################################################################################
/// #  DO NOT REMOVE `TestPermissions = Disabled` BELOW. IT IS WHAT MAKES THIS MEASURE THE SERVER. #
/// ############################################################################################
///
/// Without it this codeunit defaults to Restrictive and its write is refused on EVERY server —
/// including servers on which a real, correctly-declared suite writes perfectly well. It would then
/// report 'mocked' about its OWN declaration, not about the platform: a canary measuring itself,
/// which is worse than no canary at all because it answers confidently. That is exactly the state
/// this file shipped in before 1.0.0.6, and exactly the bug this comment exists to stop being
/// "cleaned up" back into place. This is the SECOND property here that a tidy-minded reader will
/// want to change and must not (see the TryFunction block below), and the probe table has a third
/// (`PermissionProbe.Table.al`'s DO-NOT-ADD-`InherentPermissions`).
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
/// were never consulted. A canary that does not travel the path it characterises measures nothing,
/// and is worse than no canary at all because it reports confidently about a path it never entered.
///
/// SO THE INSERT IS PLAIN, and the method is therefore ALLOWED TO FAIL. On a server where the
/// answer is genuinely 'mocked' it aborts at the `Insert` and the framework records a failure; that
/// is the expected shape of that world, not a malfunction. What makes that survivable is the
/// two-stage recording below: the permission flags are written to "LC Permission Canary State"
/// BEFORE the write is attempted, so an aborting write cannot erase what was already known, and a
/// second flag is set AFTER it, which only a permitted write can reach. Those globals live in the
/// session, not the database, so the abort and its rollback do not touch them — the identical
/// property "LC Control State"'s attestation already depends on for every KILLED (i.e. failing)
/// mutant on this same path.
/// </summary>
codeunit 71010 "LC Permission Canary"
{
    Subtype = Test;
    // LOAD-BEARING, not boilerplate. See the summary above: without it this codeunit is Restrictive
    // (the AL default), its write is refused on every server, and the canary measures its own
    // declaration instead of the platform. Removing it re-introduces the exact defect 1.0.0.6 fixed.
    TestPermissions = Disabled;

    /// <summary>Records `ReadPermission`/`WritePermission` on "LC Permission Probe", then attempts
    /// a real, unwrapped `Insert` on it — the same call shape a correctly-declared test body uses.
    ///
    /// The probe table has NO `InherentPermissions` — that omission is what keeps this measuring
    /// granted permission rather than an inherent grant that can never fail; see
    /// `PermissionProbe.Table.al`'s summary before touching either object.</summary>
    [Test]
    procedure ProbeInherentPermissions()
    var
        Probe: Record "LC Permission Probe";
        CanaryState: Codeunit "LC Permission Canary State";
    begin
        // STAGE 1 — recorded BEFORE the write, because the write may abort this method outright
        // (it does on a server that strips a Disabled codeunit). Reading the two flags first also
        // means nothing the write does, or rolls back, can influence what they report.
        CanaryState.ObservePermissions(Probe.ReadPermission(), Probe.WritePermission());

        // STAGE 2 — the measurement: a PLAIN Insert, in the test body, exactly as an ordinary test
        // does it on the path this canary characterises. No TryFunction, no asserterror, no
        // `if ... then` swallow: any error trap here either changes the call shape (see this
        // codeunit's summary) or converts the abort into a pass, and both destroy the signal. When
        // permissions are stripped this line raises and the method ends here, leaving stage 1's
        // observation intact and stage 3 deliberately unreached.
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
