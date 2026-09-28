namespace NstRepro03;

using System.Integration;

// Registers the API codeunit as OData web service "NstRepro03" on install.
codeunit 91634 "NST Repro03 Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'NstRepro03') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"NST Repro03 API";
        Tws."Service Name" := 'NstRepro03';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
