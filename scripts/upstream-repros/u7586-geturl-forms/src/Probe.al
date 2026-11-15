// PR-26 (refusal family get-url, #7586): one test per GetUrl form edge-5a58a0f16 refuses with a reason other than
// "this object type or argument list". Invented; no corpus source text. Each test only asks for the URL: BC returns a string
// for every valid ClientType and ObjectType (inferred, not measured), so each passes on BC.
table 51460 "U7586 Row"
{
    fields { field(1; "Code"; Code[20]) { } }
    keys { key(PK; "Code") { Clustered = true; } }
}

codeunit 51461 "U7586 Service"
{
    procedure Ping(): Text
    begin
        exit('pong');
    end;
}

query 51462 "U7586 Query"
{
    elements { dataitem(Row; "U7586 Row") { column(Code; Code) { } } }
}

codeunit 51463 "U7586 GetUrl Forms"
{
    Subtype = Test;

    [Test]
    procedure DefaultClientCodeunitUrl()
    var
        Url: Text;
    begin
        // edge-5a58a0f16: "(only a page or a report, and a page with a record and UseFilters false, or true for Default, are pinned)"
        Url := GetUrl(ClientType::Default, CompanyName(), ObjectType::Codeunit, Codeunit::"U7586 Service");
    end;

    [Test]
    procedure TabletClientQueryUrl()
    var
        Url: Text;
    begin
        // edge-5a58a0f16: "for Phone, Tablet and Desktop only a company, a page or report with a positive id, ... are pinned"
        Url := GetUrl(ClientType::Tablet, CompanyName(), ObjectType::Query, Query::"U7586 Query");
    end;

    [Test]
    procedure SoapCompanyUrl()
    var
        Url: Text;
    begin
        // edge-5a58a0f16: "a company of other characters than letters, digits and space" (the demo company ends in a full stop),
        // though the same company in a 4-argument SOAP call with a page is accepted
        Url := GetUrl(ClientType::SOAP, CompanyName());
    end;
}
