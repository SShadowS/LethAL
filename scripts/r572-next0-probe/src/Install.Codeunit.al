codeunit 91501 "R572 Next0 Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R572Next0Probe') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R572 Next0 Probe";
        Tws."Service Name" := 'R572Next0Probe';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
