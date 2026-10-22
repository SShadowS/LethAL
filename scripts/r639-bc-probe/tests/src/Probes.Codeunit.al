// R639 plan r3, section r3.2. One case per codeunit; each runs in its own control-app call.
// Tests that carry data do so through Error('MEASURED ...'): they FAIL on purpose.
// No codeunit sets TestHttpRequestPolicy. Nothing calls outside bc1. No test loops.

codeunit 92910 "R639 Http Local"
{
    Subtype = Test;

    [Test]
    procedure HttpGet()
    var
        Client: HttpClient;
        Response: HttpResponseMessage;
    begin
        Client.Get('http://localhost:1/x', Response);
    end;
}

codeunit 92911 "R639 Http Local Raw"
{
    Subtype = Test;

    [Test]
    procedure HttpGetRaw()
    var
        Client: HttpClient;
        Response: HttpResponseMessage;
    begin
        asserterror Client.Get('http://localhost:1/x', Response);
        Error('MEASURED [%1] [%2]', GetLastErrorText(), GetLastErrorCode());
    end;
}

codeunit 92912 "R639 Dup End"
{
    Subtype = Test;

    [Test]
    procedure DuplicateNamedKey()
    var
        Row: Record "Probe Row";
    begin
        Row.DeleteAll();
        Row.Init();
        Row."Key" := 'K1';
        Row.Insert();
        Row.Init();
        Row."Key" := 'K1';
        Row.Insert();
    end;

    [Test]
    procedure AfterDupSentinel()
    var
        Row: Record "Probe Row";
    begin
        Error('MEASURED sentinel rows=%1', Row.Count());
    end;
}

codeunit 92913 "R639 Dup End Alone"
{
    Subtype = Test;

    [Test]
    procedure DuplicateNamedKey()
    var
        Row: Record "Probe Row";
    begin
        Row.DeleteAll();
        Row.Init();
        Row."Key" := 'K1';
        Row.Insert();
        Row.Init();
        Row."Key" := 'K1';
        Row.Insert();
    end;
}

codeunit 92914 "R639 Dup Then Read"
{
    Subtype = Test;

    [Test]
    procedure DuplicateNamedKeyThenRead()
    var
        Row: Record "Probe Row";
    begin
        Row.DeleteAll();
        Row.Init();
        Row."Key" := 'K1';
        Row.Insert();
        Row.Init();
        Row."Key" := 'K1';
        Row.Insert();
        if Row.Count() < 0 then;
    end;
}

codeunit 92915 "R639 Dup Then Read Raw"
{
    Subtype = Test;

    [Test]
    procedure DuplicateNamedKeyThenReadRaw()
    var
        Row: Record "Probe Row";
    begin
        Row.DeleteAll();
        asserterror begin
            Row.Init();
            Row."Key" := 'K1';
            Row.Insert();
            Row.Init();
            Row."Key" := 'K1';
            Row.Insert();
            if Row.Count() < 0 then;
        end;
        Error('MEASURED [%1] [%2]', GetLastErrorText(), GetLastErrorCode());
    end;
}
