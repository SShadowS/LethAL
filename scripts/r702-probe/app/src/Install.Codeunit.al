using System.Integration;

codeunit 93723 "R702 Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R702Probe') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R702 API";
        Tws."Service Name" := 'R702Probe';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
