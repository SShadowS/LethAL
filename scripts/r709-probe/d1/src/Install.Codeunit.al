using System.Integration;

codeunit 93741 "R709 Dep One Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R709DepOne') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R709 Dep One API";
        Tws."Service Name" := 'R709DepOne';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
