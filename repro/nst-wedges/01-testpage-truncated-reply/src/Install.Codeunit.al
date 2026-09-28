namespace NstRepro01;

using System.Integration;

// Registers the API codeunit as OData web service "NstRepro01" on install.
codeunit 91604 "NST Repro01 Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'NstRepro01') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"NST Repro01 API";
        Tws."Service Name" := 'NstRepro01';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
