using System.Integration;

codeunit 93756 "R709 Dep Solo Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R709DepSolo') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R709 Dep Solo API";
        Tws."Service Name" := 'R709DepSolo';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
