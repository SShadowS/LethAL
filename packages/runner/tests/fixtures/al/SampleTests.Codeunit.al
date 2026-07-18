codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure PostingUpdatesTotal()
    begin
    end;

    [Test]
    [HandlerFunctions('MsgHandler')]
    procedure DiscountCapped()
    begin
    end;

    procedure Helper()
    begin
    end;

    [MessageHandler]
    procedure MsgHandler(Msg: Text[1024])
    begin
    end;
}
