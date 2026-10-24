using System.Integration;

codeunit 93771 "R728 Dep One Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R728DepOne') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R728 Dep One API";
        Tws."Service Name" := 'R728DepOne';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
