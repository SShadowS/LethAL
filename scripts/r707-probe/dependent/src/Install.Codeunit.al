using System.Integration;

codeunit 93711 "R707 Dep Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R707Dep') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R707 Dep API";
        Tws."Service Name" := 'R707Dep';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
