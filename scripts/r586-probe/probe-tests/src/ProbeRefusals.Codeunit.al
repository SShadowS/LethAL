codeunit 50653 "Probe Refusals"
{
    Subtype = Test;

    [Test]
    procedure TestPageOpen()
    var
        Card: TestPage "Probe Card";
    begin
        Card.OpenEdit();
        Card.Close();
    end;

    [Test]
    procedure PageRunModal()
    begin
        Page.RunModal(Page::"Probe Card");
    end;

    [Test]
    [HandlerFunctions('ConfirmYes')]
    procedure ConfirmHandled()
    begin
        if not Confirm('Go?') then
            Error('confirm said no');
    end;

    [Test]
    [HandlerFunctions('MessageSeen')]
    procedure MessageHandled()
    begin
        Message('hello');
    end;

    [Test]
    procedure MessageUnhandled()
    begin
        Message('hello');
    end;

    [Test]
    procedure HttpGet()
    var
        Client: HttpClient;
        Response: HttpResponseMessage;
    begin
        Client.Get('http://localhost:1/x', Response);
    end;

    [Test]
    procedure StartSessionCall()
    var
        Id: Integer;
    begin
        StartSession(Id, Codeunit::"Probe Logic");
    end;

    [Test]
    procedure CommitCall()
    begin
        Commit();
    end;

    [Test]
    procedure CodeunitRunValueForm()
    var
        Ok: Boolean;
    begin
        Ok := Codeunit.Run(Codeunit::"Probe Logic");
        if not Ok then
            Error('run failed');
    end;

    [Test]
    procedure UserIdRead()
    begin
        if UserId() = '' then
            Error('empty user');
    end;

    [Test]
    procedure CompanyNameRead()
    begin
        Error('company=%1', CompanyName());
    end;

    [ConfirmHandler]
    procedure ConfirmYes(Question: Text[1024]; var Reply: Boolean)
    begin
        Reply := true;
    end;

    [MessageHandler]
    procedure MessageSeen(Msg: Text[1024])
    begin
    end;
}
