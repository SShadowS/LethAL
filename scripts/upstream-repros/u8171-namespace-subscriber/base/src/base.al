namespace Repro.Base;

codeunit 51650 "Shared Name"
{
    procedure Ping()
    begin
        OnPing();
    end;

    [IntegrationEvent(false, false)]
    local procedure OnPing()
    begin
    end;
}

table 51651 "Shared Table"
{
    fields
    {
        field(1; Id; Integer) { }
    }
    keys
    {
        key(PK; Id) { Clustered = true; }
    }
}
