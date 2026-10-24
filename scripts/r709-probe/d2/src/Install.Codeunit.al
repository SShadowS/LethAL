using System.Integration;

codeunit 93746 "R709 Dep Two Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R709DepTwo') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R709 Dep Two API";
        Tws."Service Name" := 'R709DepTwo';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
