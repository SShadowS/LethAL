codeunit 77251 "Optin Survive Guard Test"
{
    Subtype = Test;

    [Test]
    procedure GuardPositiveDoubles()
    var
        Logic: Codeunit "Optin Logic";
    begin
        if Logic.SurvivingGuard(3) <> 6 then
            Error('Expected 6 for 3, got %1.', Logic.SurvivingGuard(3));
    end;
}
