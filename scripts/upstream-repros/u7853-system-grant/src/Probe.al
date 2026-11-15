codeunit 50293 "Probe Banner Subscriber"
{
    EventSubscriberInstance = StaticAutomatic;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"System Action Triggers", GetRoleCenterBannerPartID, '', true, true)]
    local procedure OnGetRoleCenterBannerPartID(var PartID: Integer)
    begin
        PartID := 42;
    end;
}

codeunit 50294 "Probe Banner Tests"
{
    Subtype = Test;

    [Test]
    procedure CompilesAndRuns()
    begin
    end;
}
