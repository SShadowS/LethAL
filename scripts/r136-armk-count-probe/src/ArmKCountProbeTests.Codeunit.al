// Alternative fix candidate: keep Init() unchanged (so its existing void-method-call mutant's
// identity is untouched) and add an explicit "No." := '' assignment after it. A plain assignment
// statement is claimed by no registered operator in this product, so this should be a TRUE
// zero-census-impact fix if it works.
codeunit 71592 "ArmK Count Probe Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure DoubleInsertWithoutKeyTriggerRaises()
    var
        KeyProbe: Record "ArmK Count Probe";
        i: Integer;
    begin
        KeyProbe.DeleteAll(false);
        for i := 1 to 2 do begin
            KeyProbe.Init();
            KeyProbe."No." := '';
            KeyProbe.Insert(true);
        end;
    end;
}
