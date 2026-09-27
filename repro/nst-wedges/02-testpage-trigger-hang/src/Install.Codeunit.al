namespace NstRepro02;

using System.Integration;

// Registers the API codeunit as OData web service "NstRepro02" on install.
codeunit 91618 "NST Repro02 Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'NstRepro02') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"NST Repro02 API";
        Tws."Service Name" := 'NstRepro02';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
