namespace R472.Probe;

using System.Integration;

codeunit 91723 "R472 Probe Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R472ProbeApi') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R472 Probe API";
        Tws."Service Name" := 'R472ProbeApi';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
