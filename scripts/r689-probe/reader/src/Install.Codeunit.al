codeunit 93901 "R689 Reader Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R689Reader') then
            exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R689 Reader";
        Tws."Service Name" := 'R689Reader';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
