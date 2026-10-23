// R434. One read-only web service: every row of `NAV App Installed App`, the platform's list of
// installed extensions, read from AL. It writes nothing. The caller fingerprints the text; no list
// of the automation `extensions` entity is ever asked for (R433).
codeunit 92970 "R434 Probe Installed"
{
    procedure ListInstalled() Result: Text
    var
        Installed: Record "NAV App Installed App";
        Started: DateTime;
        Rows: Integer;
        Body: TextBuilder;
    begin
        Started := CurrentDateTime();
        if Installed.FindSet() then
            repeat
                Rows += 1;
                Body.Append(StrSubstNo('%1|%2|%3|%4.%5.%6.%7;', Installed."App ID", Installed.Publisher,
                    Installed.Name, Installed."Version Major", Installed."Version Minor",
                    Installed."Version Build", Installed."Version Revision"));
            until Installed.Next() = 0;
        Result := StrSubstNo('rows=%1 ms=%2 ', Rows, CurrentDateTime() - Started) + Body.ToText();
    end;
}

codeunit 92971 "R434 Probe Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R434ProbeInstalled') then exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R434 Probe Installed";
        Tws."Service Name" := 'R434ProbeInstalled';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
