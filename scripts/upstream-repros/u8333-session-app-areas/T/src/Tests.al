// PR-175 (#8333, R1126). In an Essential company BC's test session starts with the company's areas, so the Premium-only
// control is removed and the TestPage reports it as not found (measured on BC 28.4 W1, issue body). edge-4ebfe7913 starts
// the session with no areas and finds the control. Invented; no corpus text.
codeunit 51850 "U8333 AA Premium Only"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure SetControlInPremiumOnlyArea()
    var
        Card: TestPage "U8333 AA Card";
    begin
        Card.OpenNew();
        Card.Code.SetValue('A');
        Card.InArea.SetValue(5);
        Card.Close();
    end;
}

codeunit 51851 "U8333 AA All"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure SetControlInAreaAll()
    var
        Card: TestPage "U8333 AA Card";
    begin
        Card.OpenNew();
        Card.Code.SetValue('B');
        Card.InAll.SetValue(5);
        Card.Close();
    end;
}
