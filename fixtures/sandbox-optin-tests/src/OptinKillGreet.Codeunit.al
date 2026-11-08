codeunit 77252 "Optin Kill Greet Test"
{
    Subtype = Test;

    [Test]
    procedure WelcomeNamesTheUser()
    var
        Logic: Codeunit "Optin Logic";
    begin
        if Logic.Welcome('Bob') <> 'Hello Bob' then
            Error('Expected Hello Bob, got %1.', Logic.Welcome('Bob'));
    end;
}
