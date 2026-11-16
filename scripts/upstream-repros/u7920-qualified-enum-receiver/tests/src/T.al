codeunit 58110 "Probe Tests 7920"
{
    Subtype = Test;

    [Test]
    procedure Passes()
    var
        U: Codeunit "Probe User";
    begin
        if U.Pick(1) <> 2 then
            Error('wrong');
    end;
}
