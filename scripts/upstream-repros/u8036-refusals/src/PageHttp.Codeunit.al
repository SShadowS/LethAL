codeunit 50540 "Page Refusal Repros"
{
    Subtype = Test;

    [Test]
    procedure AsDecimalOfTextWithDigits()
    var
        Row: Record "Repro Row";
        Card: TestPage "Repro Card";
        D: Decimal;
    begin
        Row."Code" := 'A';
        Row.Insert();
        Card.OpenEdit();
        Card.GoToRecord(Row);
        Card.Note.SetValue('12abc');
        asserterror D := Card.Note.AsDecimal();
    end;

    [Test]
    procedure OnOpenPageLeavesRecOffTheView()
    var
        Card: TestPage "Repro Open Card";
        T: Text;
    begin
        Card.OpenView();
        T := Card."Code".Value();
        Card.Close();
    end;
}

codeunit 50541 "Http Refusal Repros"
{
    Subtype = Test;
    TestHttpRequestPolicy = AllowOutboundFromHandler;

    [Test]
    [HandlerFunctions('AnswerAll')]
    procedure RelativePathNoBaseAddress()
    var
        Client: HttpClient;
        Response: HttpResponseMessage;
    begin
        // BC: a relative path with no base address cannot be sent; only that something is raised is checked
        asserterror Client.Get('relative/path', Response);
    end;

    [HttpClientHandler]
    procedure AnswerAll(Request: TestHttpRequestMessage; var Response: TestHttpResponseMessage): Boolean
    begin
        Response.HttpStatusCode := 200;
        exit(false);
    end;
}
