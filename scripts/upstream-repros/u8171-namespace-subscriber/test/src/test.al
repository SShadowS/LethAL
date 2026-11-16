namespace Repro.Tests;

using Repro.Copy;

codeunit 51660 "Ns Tests"
{
    Subtype = Test;
    EventSubscriberInstance = Manual;

    var
        Ran: Boolean;
        RanOnly: Boolean;

    [Test]
    procedure SubscriberBindsToCopy()
    var
        Shared: Codeunit "Shared Name";
    begin
        Ran := false;
        BindSubscription(this);
        Shared.Ping();
        UnbindSubscription(this);
        if not Ran then
            Error('subscriber did not run: event bound to the wrong codeunit');
    end;

    [Test]
    procedure TableIsCopys()
    var
        Rec: Record "Shared Table";
    begin
        Rec.Id := 1;
        Rec.Insert();
        if Rec.Count() <> 1 then
            Error('count was %1', Rec.Count());
    end;

    [Test]
    procedure ControlUniqueName()
    var
        Only: Codeunit "Copy Only Name";
    begin
        RanOnly := false;
        BindSubscription(this);
        Only.Ping();
        UnbindSubscription(this);
        if not RanOnly then
            Error('control: subscriber did not run');
    end;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Copy Only Name", 'OnPing', '', false, false)]
    local procedure HandleOnly()
    begin
        RanOnly := true;
    end;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Shared Name", 'OnPing', '', false, false)]
    local procedure HandlePing()
    begin
        Ran := true;
    end;
}
