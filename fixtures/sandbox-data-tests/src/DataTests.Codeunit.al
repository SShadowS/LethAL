codeunit 79310 "Data Tests"
{
    Subtype = Test;

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
