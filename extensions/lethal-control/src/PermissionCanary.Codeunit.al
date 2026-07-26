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
/// It deliberately NEVER fails. Every outcome — permissions present, permissions stripped, the
/// insert blowing up — is recorded as data on "LC Permission Canary State" and the method returns
/// normally. A canary that signalled by failing would be indistinguishable from a canary that
/// failed for some unrelated reason, and the caller could not tell "mocked" from "broken". So the
/// framework's own pass/fail line stays a pure infrastructure signal: anything other than a clean
/// pass, or a missing observation, means INCONCLUSIVE at the API layer, never a verdict.
/// </summary>
codeunit 71010 "LC Permission Canary"
{
    Subtype = Test;

    var
        ProbeKey: Code[20];

    /// <summary>Reports `ReadPermission`/`WritePermission` on "LC Permission Probe" and attempts a
    /// real `Insert` on it, capturing the failure text instead of letting it abort the test.
    ///
    /// The probe table has NO `InherentPermissions` — that omission is the whole measurement; see
    /// `PermissionProbe.Table.al`'s summary before touching either object.</summary>
    [Test]
    procedure ProbeInherentPermissions()
    var
        Probe: Record "LC Permission Probe";
        CanaryState: Codeunit "LC Permission Canary State";
        CanRead: Boolean;
        CanWrite: Boolean;
        InsertOk: Boolean;
        InsertError: Text;
    begin
        // A FRESH key per run, never a fixed one. With a constant key, a row left behind by an
        // earlier canary run (the test runner's per-test rollback normally removes it, but a
        // rollback is not something this method can prove happened) would make the next Insert
        // fail with "the record already exists" — a failure this canary would then read as
        // evidence of stripped permissions. That is the project's signature bug in miniature: a
        // result that looks like a measurement and is actually an artefact of leftover state.
        ProbeKey := NewProbeKey();

        // Read both permission flags BEFORE the write attempt, so nothing the attempt does (or
        // rolls back) can influence what they report.
        CanRead := Probe.ReadPermission();
        CanWrite := Probe.WritePermission();

        InsertOk := TryInsertProbe();
        // GetLastErrorText() is read IMMEDIATELY on the failing branch, before any other statement
        // can clear it — the same discipline `RunMutant` phase 2 follows (ControlApi.Codeunit.al).
        if not InsertOk then
            InsertError := GetLastErrorText();

        CanaryState.Observe(CanRead, CanWrite, InsertOk, InsertError);

        // Best-effort tidy-up of a SUCCESSFUL insert (the not-mocked world). The test runner's
        // per-test isolation normally rolls it back anyway; this just means a server whose
        // isolation ever differs does not accumulate one probe row per session. Wrapped and
        // ignored: a failed cleanup must never change what the canary reports.
        if InsertOk then
            if TryDeleteProbe() then;
    end;

    /// <summary>The real `Insert` under test, behind a catchable boundary. A [TryFunction] (not
    /// `Codeunit.Run`) because this call tree does NOT commit — a plain `Insert` on one table —
    /// so the [TryFunction] restriction that rules it out for `LC Run Method` (see that codeunit's
    /// doc comment: `Test Suite Mgt.RunAllTests` commits) does not apply here.</summary>
    [TryFunction]
    local procedure TryInsertProbe()
    var
        Probe: Record "LC Permission Probe";
    begin
        Probe.Init();
        Probe."Primary Key" := ProbeKey;
        Probe.Insert(true);
    end;

    [TryFunction]
    local procedure TryDeleteProbe()
    var
        Probe: Record "LC Permission Probe";
    begin
        if Probe.Get(ProbeKey) then
            Probe.Delete(true);
    end;

    /// <summary>20 characters of a fresh GUID — unique per run, within Code[20].</summary>
    local procedure NewProbeKey(): Code[20]
    begin
        exit(CopyStr(DelChr(Format(CreateGuid()), '=', '{}-'), 1, 20));
    end;
}
