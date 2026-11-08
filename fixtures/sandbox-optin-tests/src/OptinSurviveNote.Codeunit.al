codeunit 77253 "Optin Survive Note Test"
{
    Subtype = Test;

    [Test]
    procedure RememberCountsNotes()
    var
        Logic: Codeunit "Optin Logic";
    begin
        Logic.Remember('abc');
        if Logic.Remembered() <> 1 then
            Error('Expected 1 note, got %1.', Logic.Remembered());
    end;
}
