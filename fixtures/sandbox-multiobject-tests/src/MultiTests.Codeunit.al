codeunit 79850 "Multi Tests"
{
    Subtype = Test;

    var
        MultiB: Codeunit "Multi B";
        MultiControl: Codeunit "Multi Control";

    [Test]
    procedure ReachedBothWays()
    begin
        if MultiB.Reached(20) <> 21 then
            Error('Reached(20) must be 21');
        if MultiB.Reached(5) <> 5 then
            Error('Reached(5) must be 5');
    end;

    [Test]
    procedure ControlDoubles()
    begin
        if MultiControl.Double(3) <> 6 then
            Error('Double(3) must be 6');
    end;
}
