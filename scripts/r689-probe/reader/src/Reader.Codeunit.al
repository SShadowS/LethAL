/// R689 measurement only. Published as the OData web service "R689Reader". Every procedure
/// answers JSON text and changes nothing but its own suite R689D.
codeunit 93900 "R689 Reader"
{
    /// Discovery as LethAL Control does it (delete the suite, Commit, then CreateTestSuite and
    /// SelectTestMethodsByRange inside `if Codeunit.Run`), in this app's own suite R689D. Answers the
    /// Run result, the session's last error right after it, the suite record, and every line.
    procedure Discover(CodeunitId: Integer): Text
    var
        Suite: Record "AL Test Suite";
        Runner: Codeunit "R689 Discover Run";
        Obj: JsonObject;
        SuiteObj: JsonObject;
        Lines: JsonArray;
        Out: Text;
        RunOk: Boolean;
    begin
        if Suite.Get('R689D') then
            Suite.Delete(true);
        Commit();
        ClearLastError();
        Runner.SetRequest('R689D', CodeunitId);
        RunOk := Runner.Run();
        Obj.Add('runOk', RunOk);
        Obj.Add('lastErrorText', GetLastErrorText());
        Obj.Add('lastErrorCallStack', GetLastErrorCallStack());
        if Suite.Get('R689D') then begin
            SuiteObj.Add('name', Suite.Name);
            SuiteObj.Add('testsToExecute', Suite."Tests to Execute");
            SuiteObj.Add('testsNotExecuted', Suite."Tests not Executed");
            SuiteObj.Add('failures', Suite.Failures);
            SuiteObj.Add('lastRun', Format(Suite."Last Run", 0, 9));
            SuiteObj.Add('testRunnerId', Suite."Test Runner Id");
            Obj.Add('suite', SuiteObj);
        end else
            Obj.Add('suite', 'absent');
        Lines.ReadFrom(LinesOf('R689D', 0));
        Obj.Add('lines', Lines);
        Obj.WriteTo(Out);
        exit(Out);
    end;

    /// LethAL Control's suites (names starting LC): every suite's line count, then every line it
    /// holds for that codeunit. A reused LC name overwrites an earlier call's rows (per session).
    procedure ControlSuites(CodeunitId: Integer): Text
    var
        Suite: Record "AL Test Suite";
        Line: Record "Test Method Line";
        Obj: JsonObject;
        One: JsonObject;
        Suites: JsonArray;
        Lines: JsonArray;
        Out: Text;
    begin
        Suite.SetFilter(Name, 'LC*');
        if Suite.FindSet() then
            repeat
                Clear(One);
                One.Add('name', Suite.Name);
                Line.Reset();
                Line.SetRange("Test Suite", Suite.Name);
                One.Add('lines', Line.Count());
                Line.SetRange("Test Codeunit", CodeunitId);
                One.Add('linesForCodeunit', Line.Count());
                Suites.Add(One);
            until Suite.Next() = 0;
        Obj.Add('suites', Suites);
        Lines.ReadFrom(LinesOf('LC*', CodeunitId));
        Obj.Add('lines', Lines);
        Obj.WriteTo(Out);
        exit(Out);
    end;

    /// The published web services on the Test Runner's pages and tables (ids 130450-130463).
    procedure WebServices(): Text
    var
        Tws: Record "Tenant Web Service";
        Ws: Record "Web Service";
        PageMeta: Record "Page Metadata";
        Arr: JsonArray;
        Obj: JsonObject;
        Out: Text;
    begin
        Tws.SetRange("Object ID", 130450, 130463);
        if Tws.FindSet() then
            repeat
                Clear(Obj);
                Obj.Add('table', 'Tenant Web Service');
                Obj.Add('objectType', Format(Tws."Object Type"));
                Obj.Add('objectId', Tws."Object ID");
                Obj.Add('serviceName', Tws."Service Name");
                Obj.Add('published', Tws.Published);
                Arr.Add(Obj);
            until Tws.Next() = 0;
        Ws.SetRange("Object ID", 130450, 130463);
        if Ws.FindSet() then
            repeat
                Clear(Obj);
                Obj.Add('table', 'Web Service');
                Obj.Add('objectType', Format(Ws."Object Type"));
                Obj.Add('objectId', Ws."Object ID");
                Obj.Add('serviceName', Ws."Service Name");
                Obj.Add('published', Ws.Published);
                Arr.Add(Obj);
            until Ws.Next() = 0;
        // Any page, from any app, built on the Test Runner's tables (an API page needs no web-service row).
        PageMeta.SetRange(SourceTable, 130450, 130463);
        if PageMeta.FindSet() then
            repeat
                Clear(Obj);
                Obj.Add('table', 'Page Metadata');
                Obj.Add('objectId', PageMeta.ID);
                Obj.Add('name', PageMeta.Name);
                Obj.Add('sourceTable', PageMeta.SourceTable);
                Obj.Add('pageType', Format(PageMeta.PageType));
                Arr.Add(Obj);
            until PageMeta.Next() = 0;
        Arr.WriteTo(Out);
        exit(Out);
    end;

    /// Cleanup, before the app is unpublished: this app's own suite R689D and its web-service row.
    procedure DeleteOwn(): Text
    var
        Suite: Record "AL Test Suite";
        Tws: Record "Tenant Web Service";
        Obj: JsonObject;
        Out: Text;
    begin
        if Suite.Get('R689D') then begin
            Suite.Delete(true);
            Obj.Add('suite', 'deleted');
        end else
            Obj.Add('suite', 'absent');
        if Tws.Get(Tws."Object Type"::Codeunit, 'R689Reader') then begin
            Tws.Delete(true);
            Obj.Add('webService', 'deleted');
        end else
            Obj.Add('webService', 'absent');
        Obj.WriteTo(Out);
        exit(Out);
    end;

    local procedure LinesOf(SuiteFilter: Text; CodeunitId: Integer): Text
    var
        Line: Record "Test Method Line";
        Mgt: Codeunit "Test Suite Mgt.";
        Arr: JsonArray;
        Obj: JsonObject;
        Out: Text;
    begin
        Line.SetFilter("Test Suite", SuiteFilter);
        if CodeunitId <> 0 then
            Line.SetRange("Test Codeunit", CodeunitId);
        if Line.FindSet() then
            repeat
                Clear(Obj);
                Obj.Add('testSuite', Line."Test Suite");
                Obj.Add('lineNo', Line."Line No.");
                Obj.Add('lineType', Format(Line."Line Type"));
                Obj.Add('testCodeunit', Line."Test Codeunit");
                Obj.Add('name', Line.Name);
                Obj.Add('function', Line."Function");
                Obj.Add('run', Line.Run);
                Obj.Add('result', Format(Line.Result));
                Obj.Add('startTime', Format(Line."Start Time", 0, 9));
                Obj.Add('finishTime', Format(Line."Finish Time", 0, 9));
                Obj.Add('errorMessagePreview', Line."Error Message Preview");
                Obj.Add('errorCode', Line."Error Code");
                Obj.Add('errorMessage', Mgt.GetFullErrorMessage(Line));
                Obj.Add('errorCallStack', Mgt.GetErrorCallStack(Line));
                Arr.Add(Obj);
            until Line.Next() = 0;
        Arr.WriteTo(Out);
        exit(Out);
    end;
}
