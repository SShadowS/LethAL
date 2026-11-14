codeunit 50282 "Probe Refusal Tests"
{
    Subtype = Test;

    [Test]
    procedure ClearXmlWriteOptions()
    var
        Options: XmlWriteOptions;
    begin
        Options.PreserveWhitespace := true;
        Clear(Options);
        if Options.PreserveWhitespace then
            Error('Clear kept PreserveWhitespace');
    end;

    [Test]
    procedure RemoveLastCookie()
    var
        Request: HttpRequestMessage;
        Names: List of [Text];
    begin
        Request.SetCookie('session', 'abc');
        Request.RemoveCookie('session');
        Names := Request.GetCookieNames();
        if Names.Count() <> 0 then
            Error('a cookie is left: %1', Names.Count());
    end;

    [Test]
    procedure ErrorWithBlankErrorInfo()
    var
        Info: ErrorInfo;
    begin
        asserterror Error(Info);
    end;

    [Test]
    procedure FilterGroupOnUnopenedRecordRef()
    var
        Ref: RecordRef;
    begin
        asserterror Ref.FilterGroup(2);
    end;

    [Test]
    procedure ReadPlatformTableWithoutProvider()
    var
        Scheduler: Record "Performance Profile Scheduler";
    begin
        if not Scheduler.IsEmpty() then
            Error('expected no scheduler records');
    end;

    [Test]
    procedure ReadQueryMetadataColumn13()
    var
        QueryMetadata: Record "Query Metadata";
        Ref: RecordRef;
    begin
        if QueryMetadata.FindFirst() then begin
            Ref.GetTable(QueryMetadata);
            if Format(Ref.Field(13).Value()) = '<never>' then
                Error('unexpected');
        end;
    end;
}
