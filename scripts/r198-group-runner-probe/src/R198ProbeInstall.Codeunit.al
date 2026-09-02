namespace R198.Probe;

using System.Integration;

codeunit 71545 "R198 Probe Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R198ProbeApi') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R198 Probe API";
        Tws."Service Name" := 'R198ProbeApi';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
