// R661. One read-only web service: every Active Session row this web-service session can see.
// It writes nothing. R53 measured that a web-service session cannot see itself here, so the
// caller reads other sessions only, by difference between reads.
codeunit 92960 "R661 Probe Sessions"
{
    procedure ListSessions() Result: Text
    var
        Session: Record "Active Session";
    begin
        Session.Reset();
        if Session.FindSet() then
            repeat
                Result += StrSubstNo('%1/%2/%3/%4;', Session."Session ID", Session."Client Type",
                    Format(Session."Login Datetime", 0, 9), Session."Server Instance ID");
            until (Session.Next() = 0) or (StrLen(Result) > 1800);
    end;
}

codeunit 92961 "R661 Probe Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R661ProbeSessions') then exit;
        Tws.Init();
        Tws."Object Type" := Tws."Object Type"::Codeunit;
        Tws."Object ID" := Codeunit::"R661 Probe Sessions";
        Tws."Service Name" := 'R661ProbeSessions';
        Tws.Published := true;
        Tws.Insert(true);
    end;
}
