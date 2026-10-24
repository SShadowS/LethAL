using System.Integration;

codeunit 93776 "R728 Dep Two Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R728DepTwo') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R728 Dep Two API";
        Tws."Service Name" := 'R728DepTwo';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
