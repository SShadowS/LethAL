codeunit 79310 "Data Tests"
{
    Subtype = Test;
    // Measured 2026-07-26: WITHOUT this, a test codeunit defaults to restrictive test permissions and
    // Microsoft's Permissions Mock refuses every write from its body — on EVERY runner, not just
    // LethAL's fenced path. That refusal is what the InherentPermissions workaround on the tables was
    // hiding. A real BC suite declares this (the Continia Document Output suite: 77 of 77 test
    // codeunits), so a fixture omitting it was testing a shape no real suite has.
    TestPermissions = Disabled;

    [Test]
    procedure BlankNoValidateFails()
    var
        DataMain: Record "Data Main";
    begin
        // Strong: OnValidate's guard must actually fire. An emptied/negated trigger body
        // stops raising this error, asserterror then fails, and the mutant is killed.
        asserterror DataMain.Validate("No.", '');
    end;

    [Test]
    procedure InsertDoublesAmountWeak()
    var
        DataMain: Record "Data Main";
    begin
        // Weak on purpose: exercises the object-level OnInsert trigger (Amount := Amount * 2)
        // but asserts nothing about the result, so a mutant there survives genuinely.
        //
        // MUST be idempotent. A normal BC test rolls back, but LethAL's two-phase fence commits
        // around each mutant run, so a row inserted here PERSISTS into the next run. Inserting a
        // fixed primary key without clearing it first made every run after the first contend with
        // the surviving row, and RunMutant timed out deterministically — which surfaced as an
        // in-flight-unknown quarantine, not as a test failure. Delete before insert.
        if DataMain.Get('X1') then
            DataMain.Delete(false);
        DataMain.Init();
        DataMain."No." := 'X1';
        DataMain.Amount := 5;
        DataMain.Insert(true);
    end;

    [Test]
    procedure NoTriggerValidateRunsWeak()
    var
        DataNoTrigger: Record "Data No Trigger";
    begin
        // Weak on purpose: exercises "Data No Trigger"'s field-level OnValidate (the table
        // whose selector var lands trailing, with no object-level trigger) but asserts
        // nothing about the outcome.
        DataNoTrigger.Validate("No.", 'A1');
    end;

    [Test]
    procedure TooLongNoValidateFails()
    var
        DataNoTrigger: Record "Data No Trigger";
    begin
        // Strong on the second table too: proves the field-level OnValidate guard fires
        // there as well, so a kill on this table's trigger site is not the fixture's only one.
        asserterror DataNoTrigger.Validate("No.", '12345678901');
    end;
}
