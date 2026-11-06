codeunit 77152 "Dates Survivor Test"
{
    Subtype = Test;

    [Test]
    procedure DateIsSet()
    var
        Logic: Codeunit "Dates Logic";
    begin
        if not Logic.IsDateSet() then
            Error('Expected a work date to be set.');
    end;
}
