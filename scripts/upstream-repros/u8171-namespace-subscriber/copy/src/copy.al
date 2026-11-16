namespace Repro.Copy;

codeunit 51655 "Shared Name"
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

codeunit 51657 "Copy Only Name"
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

table 51656 "Shared Table"
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
