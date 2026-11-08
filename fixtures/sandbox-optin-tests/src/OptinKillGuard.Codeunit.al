// R868. One codeunit per verdict, one file each; every test is alone in its codeunit.

codeunit 77250 "Optin Kill Guard Test"
{
    Subtype = Test;

    [Test]
    procedure GuardBelowZeroIsZero()
    var
        Logic: Codeunit "Optin Logic";
    begin
        if Logic.KilledGuard(-5) <> 0 then
            Error('Expected 0 for a negative amount, got %1.', Logic.KilledGuard(-5));
        if Logic.KilledGuard(4) <> 8 then
            Error('Expected 8 for 4, got %1.', Logic.KilledGuard(4));
    end;
}
