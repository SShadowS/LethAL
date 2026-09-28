namespace NstRepro04;

using System.Integration;

// Registers the API codeunit as OData web service "NstRepro04" on install.
codeunit 91641 "NST Repro04 Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'NstRepro04') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"NST Repro04 API";
        Tws."Service Name" := 'NstRepro04';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
