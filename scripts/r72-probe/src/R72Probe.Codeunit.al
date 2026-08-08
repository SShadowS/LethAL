// R72: WHICH variable makes BC abort the transaction when `Codeunit.Run` is called with a write
// transaction open?
//
// Two measurements on this platform disagree, and R72 is blocked because nobody knows which
// difference between them matters:
//
//   ABORTS  — `fixtures/sandbox-probes/src/WriteTxnProbe.Codeunit.al` (2026-08-02) and
//             `Tier3Probe` arms M2a/M2b (R13, 2026-08-02). Write (or a bare `LockTable()`) in the
//             `[Test]` method's OWN body, then `Ran := Codeunit.Run(...)`, no prior `Commit()`.
//             BC answers "An error occurred and the transaction is stopped."
//
//   SURVIVES — `Data Commit Ops.CommitThenRun` with its `Commit()` deleted, live on the tables
//             gate. Write in an ORDINARY CODEUNIT called from a test, then `Codeunit.Run(...)` as
//             a bare STATEMENT, and the test had issued a `Commit()` of its own just before.
//
// R72's own row names the FRAME as the candidate. It never names the other two differences, and
// the return-value form is the one with a mechanism behind it: the Boolean form of `Codeunit.Run`
// promises to roll the callee back on failure, which is something the platform may refuse to
// promise inside a transaction it did not open. This probe therefore varies all THREE
// independently rather than assuming the row picked the right one.
//
//   priorCommit x frame x form  =  2 x 2 x 2  =  8 arms, plus 2 controls.
//
// Every arm reports through `Error(...)` (see the al-probe skill): a passing test surfaces nothing,
// a failing one carries its message back verbatim. So an arm that reaches its own `MEASURED ...`
// message did NOT abort, and an arm that comes back with BC's generic transaction message did.
// A red test here is the transport, not a broken experiment.
codeunit 71543 "R72 Probe"
{
    Subtype = Test;
    // R1: without this, Microsoft's Permissions Mock refuses the writes below on every runner and
    // the probe would measure its own permissions rather than the transaction rule.
    TestPermissions = Disabled;

    // ---- no prior Commit ----------------------------------------------------------------

    [Test]
    procedure A1_NoCmt_Test_Val()
    var
        Ran: Boolean;
    begin
        // The exact shape R72 already measured as ABORTING. Repeated here so this probe carries
        // its own reproduction rather than resting on a five-day-old run against a container that
        // has been republished since.
        WriteHere(71001);
        Ran := Codeunit.Run(Codeunit::"R72 Target");
        Error('MEASURED arm=A1_NoCmt_Test_Val ran=%1 reachedAfterCall=Yes', Ran);
    end;

    [Test]
    procedure A2_NoCmt_Test_Stmt()
    begin
        WriteHere(71002);
        Codeunit.Run(Codeunit::"R72 Target");
        Error('MEASURED arm=A2_NoCmt_Test_Stmt ran=n/a reachedAfterCall=Yes');
    end;

    [Test]
    procedure A3_NoCmt_Callee_Val()
    var
        Callee: Codeunit "R72 Callee";
        Ran: Boolean;
    begin
        Ran := Callee.WriteThenRunValueForm(71003);
        Error('MEASURED arm=A3_NoCmt_Callee_Val ran=%1 reachedAfterCall=Yes', Ran);
    end;

    [Test]
    procedure A4_NoCmt_Callee_Stmt()
    var
        Callee: Codeunit "R72 Callee";
    begin
        Callee.WriteThenRunStatementForm(71004);
        Error('MEASURED arm=A4_NoCmt_Callee_Stmt ran=n/a reachedAfterCall=Yes');
    end;

    // ---- with a prior Commit, which is what the surviving fixture test does -----------------

    [Test]
    procedure A5_Cmt_Test_Val()
    var
        Ran: Boolean;
    begin
        Commit();
        WriteHere(71005);
        Ran := Codeunit.Run(Codeunit::"R72 Target");
        Error('MEASURED arm=A5_Cmt_Test_Val ran=%1 reachedAfterCall=Yes', Ran);
    end;

    [Test]
    procedure A6_Cmt_Test_Stmt()
    begin
        Commit();
        WriteHere(71006);
        Codeunit.Run(Codeunit::"R72 Target");
        Error('MEASURED arm=A6_Cmt_Test_Stmt ran=n/a reachedAfterCall=Yes');
    end;

    [Test]
    procedure A7_Cmt_Callee_Val()
    var
        Callee: Codeunit "R72 Callee";
        Ran: Boolean;
    begin
        Commit();
        Ran := Callee.WriteThenRunValueForm(71007);
        Error('MEASURED arm=A7_Cmt_Callee_Val ran=%1 reachedAfterCall=Yes', Ran);
    end;

    [Test]
    procedure A8_Cmt_Callee_Stmt()
    var
        Callee: Codeunit "R72 Callee";
    begin
        // The shape `Data Commit Ops.CommitThenRun` presents to the live gate with its `Commit()`
        // deleted, and the one that SURVIVED.
        Commit();
        Callee.WriteThenRunStatementForm(71008);
        Error('MEASURED arm=A8_Cmt_Callee_Stmt ran=n/a reachedAfterCall=Yes');
    end;

    // ---- the GUARD form, added 2026-08-08 -------------------------------------------------
    //
    // The 2x2x2 above varied only the ASSIGNMENT form (`Ran := Codeunit.Run(X)`) against the bare
    // statement. Real AL consumes the return value a second way, and R72's original row named it
    // as the adversarial hole a detector must survive:
    //
    //     if not Codeunit.Run(X) then Error(SomethingErr, GetLastErrorText());
    //
    // A detector that flags "the return value is consumed" claims this shape too, and until these
    // two arms ran that claim rested on the mechanism ("the Boolean form promises a rollback the
    // platform will not make inside a transaction it did not open") rather than on a measurement.
    // A shipped diagnosis resting on an inference is the thing this repo keeps getting wrong, so
    // it is measured instead.
    //
    // B1 is the question; B2 is the control that keeps the answer about the TRANSACTION rather
    // than about the guard form as such, exactly as C1 does for the assignment form.

    [Test]
    procedure B1_NoCmt_Test_Guard()
    begin
        WriteHere(71011);
        if not Codeunit.Run(Codeunit::"R72 Target") then
            Error('MEASURED arm=B1_NoCmt_Test_Guard ranFalse=Yes caught=%1', GetLastErrorText());
        Error('MEASURED arm=B1_NoCmt_Test_Guard ranFalse=No reachedAfterCall=Yes');
    end;

    [Test]
    procedure B2_RunOnly_Guard()
    begin
        // No write opened first.
        if not Codeunit.Run(Codeunit::"R72 Target") then
            Error('MEASURED arm=B2_RunOnly_Guard ranFalse=Yes caught=%1', GetLastErrorText());
        Error('MEASURED arm=B2_RunOnly_Guard ranFalse=No reachedAfterCall=Yes');
    end;

    // ---- controls -----------------------------------------------------------------------

    [Test]
    procedure C1_RunOnly_Val()
    var
        Ran: Boolean;
    begin
        // No write opened first. If this aborts too, the callee is at fault and the transaction is
        // not the variable at all.
        Ran := Codeunit.Run(Codeunit::"R72 Target");
        Error('MEASURED arm=C1_RunOnly_Val ran=%1 reachedAfterCall=Yes', Ran);
    end;

    [Test]
    procedure C2_WriteOnly()
    begin
        // If this fails, the refusal in the arms above is about permissions or the probe table,
        // not about the transaction rule.
        WriteHere(71010);
        Error('MEASURED arm=C2_WriteOnly reachedAfterWrite=Yes');
    end;

    /// One row per arm, so a leftover row from another arm can never be the reason a write
    /// behaves differently.
    local procedure WriteHere(EntryNo: Integer)
    var
        Row: Record "R72 Row";
    begin
        if Row.Get(EntryNo) then
            Row.Delete(false);
        Row.Init();
        Row."Entry No." := EntryNo;
        Row.Insert(false);
    end;
}
