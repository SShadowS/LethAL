// R33 follow-up probes. Each one exists because a claim was written into a design without being
// measured, and an adversarial review named it. Same channel as the rest of this fixture: raise,
// so the message is carried back verbatim by whichever runner executed it.
codeunit 79215 "Tier2 Phase2 Probe"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // (1) `SwapRecXRec`, the part the first probe did not measure: a field `OnValidate`, driven by
    // `Validate(...)` from AL. If `xRec` holds the pre-assignment value here, the operator HAS
    // signal in this execution model for validate-shaped sites, and the blanket no-go is wrong.
    [Test]
    procedure ReportsRecVsXRecOnValidate()
    var
        Probe: Record "Rec XRec Probe 2";
    begin
        if Probe.Get('V1') then
            Probe.Delete(false);
        Probe.Init();
        Probe."No." := 'V1';
        Probe.Amount := 100;
        Probe.Insert(false);

        Probe.Get('V1');
        Probe.Validate(Amount, 250);
    end;

    // (2) `SwapRecXRec` in `OnRename`, where the two records carry the old and new primary key.
    [Test]
    procedure ReportsRecVsXRecOnRename()
    var
        Probe: Record "Rec XRec Probe 2";
    begin
        if Probe.Get('R2') then
            Probe.Delete(false);
        if Probe.Get('R1') then
            Probe.Delete(false);
        Probe.Init();
        Probe."No." := 'R1';
        Probe.Insert(false);

        Probe.Get('R1');
        Probe.Rename('R2');
    end;

    // (3) `RemoveSetLoadFields`. The design claimed the mutant is "unkillable by construction"
    // because omitted fields are fetched JIT — twice, with two different justifications, neither
    // measured. The review's counter-claim: the JIT fetch REREADS THE ROW, and rereading a row that
    // has since been deleted raises. If it does, an `asserterror` test can kill the mutant (with
    // the call present the read raises; with it deleted the field was already in memory and does
    // not), and the refusal must be worded as a judgment, not a construction proof.
    [Test]
    procedure ReportsJitRereadOfDeletedRow()
    var
        Partial: Record "Rec XRec Probe";
        Other: Record "Rec XRec Probe";
        Raised: Boolean;
    begin
        if Partial.Get('JIT1') then
            Partial.Delete(false);
        Partial.Init();
        Partial."No." := 'JIT1';
        Partial.Amount := 7;
        Partial.Insert(false);

        Partial.SetLoadFields(Partial."No.");
        Partial.Get('JIT1');

        // Delete the row through a second variable, so the JIT fetch below has nothing to reread.
        Other.Get('JIT1');
        Other.Delete(false);

        Raised := not TryReadAmount(Partial);
        Error(
          'MEASURED jit-reread-of-deleted-row raised=%1 | lastError=%2',
          Raised,
          GetLastErrorText());
    end;

    // (4) `RemoveCommit`'s kill story. The operator ships FULLY SCORED on the claim that
    // `WriteA; Commit(); Error(...)` is observable — which assumes `Commit()` does something under
    // the platform test runner's isolation. If it is refused or is a no-op there, the operator is a
    // permanent-survivor generator on exactly the suites LethAL runs.
    [Test]
    procedure ReportsCommitUnderTestIsolation()
    var
        Probe: Record "Rec XRec Probe";
        Executed: Boolean;
    begin
        if Probe.Get('CMT1') then
            Probe.Delete(false);
        Probe.Init();
        Probe."No." := 'CMT1';
        Probe.Amount := 1;
        Probe.Insert(false);

        // Called DIRECTLY, not through a [TryFunction]. The first version wrapped it, and the
        // platform refused the wrapper rather than the call: "Call to the function 'COMMIT' is not
        // allowed inside the call to 'RunTests' when it is used as a TryFunction." That measured
        // the probe, not BC — the same self-measuring mistake R26's permission canary made.
        Commit();
        Executed := true;
        Error('MEASURED commit-executed=%1 | rowStillReadable=%2', Executed, Probe.Get('CMT1'));
    end;

    [TryFunction]
    local procedure TryReadAmount(var R: Record "Rec XRec Probe")
    var
        Value: Decimal;
    begin
        Value := R.Amount;
    end;

}
