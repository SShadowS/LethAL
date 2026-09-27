namespace NstRepro01;

codeunit 91603 "NST Repro01 Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // The failing arm. In an OData session the platform refuses TestPage: the test fails with
    // System.NotSupportedException at NavSession.CreateNavTestService() plus its CLR callstack,
    // which makes the answer about 6.6 KB.
    [Test]
    procedure OpenCardPage()
    var
        Card: TestPage "NST Repro01 Card";
        Shown: Integer;
    begin
        Card.OpenView();
        Card.Compute.Invoke();
        Shown := Card.ComputedValue.AsInteger();
        Card.Close();
        if Shown <> 42 then
            Error('expected 42, got %1', Shown);
    end;

    // The control arm and the warm-up calls: passes, no page, no CLR exception.
    [Test]
    procedure Passes()
    begin
        if 6 * 7 <> 42 then
            Error('arithmetic is broken');
    end;
}
