// PR-28 (#8154): under --no-client al-runner never calls a bound UI handler and lets an unhandled Message pass. BC, measured in a
// web-service session (lethal-bugs, bc2, /coord/handoff/PR-17/ws-run/result.md), calls the handlers and fails the unhandled Message
// "Unhandled UI". Invented; no corpus text. Run with --no-client.
codeunit 51570 "U8154 Confirm Handled"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('OnConfirm')]
    procedure Cell()
    begin
        if Confirm('Go on?') then;
    end;

    [ConfirmHandler]
    procedure OnConfirm(Question: Text[1024]; var Reply: Boolean)
    begin
        Reply := true;
    end;
}

codeunit 51571 "U8154 StrMenu Handled"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('OnStrMenu')]
    procedure Cell()
    begin
        if StrMenu('One,Two') = 1 then;
    end;

    [StrMenuHandler]
    procedure OnStrMenu(Options: Text[1024]; var Choice: Integer; Instruction: Text[1024])
    begin
        Choice := 1;
    end;
}

codeunit 51572 "U8154 Message Handled"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('OnMessage')]
    procedure Cell()
    begin
        Message('Done.');
    end;

    [MessageHandler]
    procedure OnMessage(Msg: Text[1024])
    begin
    end;
}

codeunit 51573 "U8154 Message Unhandled"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    begin
        Message('Done.');
    end;
}
