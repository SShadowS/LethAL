namespace R53.Probe;

using System.Integration;

codeunit 71504 "R53 Probe Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R53ProbeApi') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R53 Probe API";
        Tws."Service Name" := 'R53ProbeApi';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
