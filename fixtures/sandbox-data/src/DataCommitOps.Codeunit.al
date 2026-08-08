// R73 + R72: the first POSITIVE `lethal.remove-commit` sites in any fixture.
//
// Until now `RemoveCommit` shipped proven on its refusals and unproven on its claims: both `Commit`
// sites in this fixture are the shadowed negatives (`Data Shadow` declares `Commit`,
// `Data Ops.ShadowedBuiltins` calls it qualified), both correctly refused, so no gate had ever
// GENERATED a `remove-commit` mutant, let alone killed one.
//
// TWO sites, because the operator has two entirely different kill mechanisms and R72 exists
// precisely to tell them apart:
//
//   CommitThenFail — the honest transaction-boundary shape. Deleting the `Commit()` means the write
//     rolls back with the error, and a test asserting the row survived FAILS. That is assertion
//     quality: the suite noticed.
//
//   CommitThenRun — the platform-artifact shape. Deleting the `Commit()` leaves a write transaction
//     open across `Codeunit.Run`, which BC REFUSES outright (measured 2026-08-02, identical on the
//     hub and the fenced path: "An error occurred and the transaction is stopped."). The mutant dies
//     for a reason that says nothing about the suite, which is exactly the score inflation R72's
//     diagnosis is for.
//
// Both mechanisms were measured on `fixtures/sandbox-probes` BEFORE this fixture was written — see
// `docs/measurements/README.md` §R72 and §R73. In particular a committed write was measured to
// SURVIVE a later uncaught error (`survived=Yes`) while an uncommitted one is rolled back
// (`survived=No`), which is the only reason the first test below can kill anything.
//
// `Insert(false)` deliberately: running `Data Main`'s OnInsert here would drag its triggers into a
// test about transaction boundaries.
codeunit 79312 "Data Commit Ops"
{
    procedure CommitThenFail(MainNo: Code[20])
    var
        DataMain: Record "Data Main";
    begin
        DataMain.Init();
        DataMain."No." := MainNo;
        DataMain.Category := 'A';
        DataMain.Amount := 5;
        DataMain.Insert(false);
        Commit();
        Error('deliberate failure AFTER commit');
    end;

    procedure CommitThenRun()
    var
        DataMain: Record "Data Main";
        Target: Codeunit "Data Commit Target";
    begin
        DataMain.Init();
        DataMain."No." := Target.CommitRunNo();
        DataMain.Category := 'A';
        DataMain.Amount := 7;
        DataMain.Insert(false);
        Commit();
        Codeunit.Run(Codeunit::"Data Commit Target");
    end;

    // CommitThenRunValueForm — the SAME shape as CommitThenRun with exactly one character group
    // changed, and that one difference is the whole platform-artifact mechanism.
    //
    // MEASURED 2026-08-08 (`scripts/r72-probe/`, a 2x2x2 plus controls on Cronus281): BC aborts the
    // transaction when `Codeunit.Run`'s RETURN VALUE is consumed with a write open. It does that in
    // either call frame, with or without a prior `Commit()`, and the bare statement form above
    // survives in every cell. Two further arms measured the guard form
    // (`if not Codeunit.Run(X) then ...`) and it aborts too, so "the return value is consumed"
    // covers both shapes by measurement rather than by inference.
    //
    // That is why `CommitThenRun` SURVIVED on the live gate and why R72's prediction, not the gate,
    // was wrong. Until this arm existed no fixture could produce the artifact at all, so R72's
    // diagnosis could only have been proven against a constructed string — the R31 shape the row
    // exists to avoid.
    //
    // With the `Commit()` intact the write is closed before the call, so the call succeeds and
    // returns true. With it deleted (the `lethal.remove-commit` mutant) the write is still open, BC
    // refuses at the `Ran := ...` line, the caller never regains control, and the mutant dies for a
    // reason that says nothing about the assertions. The verdict deliberately stays `killed`.
    //
    // The SAME callee as CommitThenRun, on purpose: the return-value form is then the only
    // difference between the two arms, mirroring the probe's own design.
    procedure CommitThenRunValueForm(): Boolean
    var
        DataMain: Record "Data Main";
        Target: Codeunit "Data Commit Target";
        Ran: Boolean;
    begin
        DataMain.Init();
        DataMain."No." := Target.CommitRunNo();
        DataMain.Category := 'A';
        DataMain.Amount := 9;
        DataMain.Insert(false);
        Commit();
        Ran := Codeunit.Run(Codeunit::"Data Commit Target");
        exit(Ran);
    end;
}
