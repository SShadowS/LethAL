// Upstream #8028 (PR-17): Report.RunRequestPage with a RequestPageHandler bound, in a session without a client (run with
// --no-client). Invented, no corpus source text. On BC the handler takes the request page and RunRequestPage returns its
// parameters (inferred, not measured), so the test is expected to pass.
table 51440 "U8028 Row"
{
    fields { field(1; "Code"; Code[20]) { } }
    keys { key(PK; "Code") { Clustered = true; } }
}

report 51440 "U8028 Report"
{
    ProcessingOnly = true;
    dataset { dataitem(Row; "U8028 Row") { } }
    requestpage { layout { area(Content) { } } }
}

codeunit 51441 "U8028 Run Request Page"
{
    Subtype = Test;

    [HandlerFunctions('OnRequest')]
    [Test]
    procedure Cell()
    begin
        if Report.RunRequestPage(Report::"U8028 Report") = '' then
            Error('no parameters');
    end;

    [RequestPageHandler]
    procedure OnRequest(var R: TestRequestPage "U8028 Report")
    begin
        R.OK().Invoke();
    end;
}
