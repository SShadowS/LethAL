// A user-defined `TestField` on a NON-RECORD receiver (spec §6).
//
// `Validator.TestField(7)` in `Data Ops` is the direct trap for `RemoveTestField`: same name, one
// argument, statement position — everything the operator looks for except a record receiver. Only
// rule 2 of `claimsRecordMethod` refuses it. The side effect is observable so the site's Tier-1
// `void-method-call` mutant is genuinely KILLED, which is what makes a wrong Tier-2 claim show up
// as an `operatorName` change on a killed mutant rather than as silence.
codeunit 79305 "Data Validator"
{
    var
        Seen: Integer;

    procedure TestField(Value: Integer)
    begin
        Seen := Seen + Value;
    end;

    procedure SeenTotal(): Integer
    begin
        exit(Seen);
    end;
}
