codeunit 50790 "R975 Client Type"
{
    Subtype = Test;

    // Run with --no-client (a session without a client, as BC's web-service and background sessions are).
    [Test]
    procedure ReadCurrentClientType()
    begin
        if CurrentClientType() = ClientType::Windows then
            Error('a session without a client reports the Windows client');
    end;
}

// A login subscriber that reads the client type, as System Application's System Initialization does on company open.
codeunit 50791 "R975 Login Subscriber"
{
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Company Triggers", OnCompanyOpenCompleted, '', false, false)]
    local procedure OnCompanyOpenCompleted()
    begin
        if CurrentClientType() = ClientType::Background then
            exit;
    end;
}

// A test that reads nothing about the client.
codeunit 50792 "R975 Plain Test"
{
    Subtype = Test;

    [Test]
    procedure Nothing()
    begin
    end;
}
