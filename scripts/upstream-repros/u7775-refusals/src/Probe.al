table 50140 "Refusal Probe"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Amount; Decimal) { }
        field(3; Qty; Integer) { }
        field(4; Data; Blob) { }
        field(5; Name; Text[30]) { }
    }
    keys { key(PK; Id) { } }
}

xmlport 50140 "Refusal Probe Import"
{
    Format = VariableText;
    TextEncoding = WINDOWS;
    Direction = Import;
    schema
    {
        textelement(Root)
        {
            tableelement(Probe; "Refusal Probe")
            {
                fieldelement(Id; Probe.Id) { }
                fieldelement(Name; Probe.Name) { }
            }
        }
    }
}

report 50140 "Refusal Probe Report"
{
    ProcessingOnly = false;
    DefaultRenderingLayout = Rdl;
    dataset
    {
        dataitem(P; "Refusal Probe")
        {
            column(Id; Id) { }
        }
    }
    rendering
    {
        layout(Rdl) { Type = RDLC; LayoutFile = 'res/Probe.rdl'; }
    }
}

codeunit 50141 "Refusal Probe Tests"
{
    Subtype = Test;

    [Test]
    procedure XmlPortVariableTextWindows()
    var
        P: Record "Refusal Probe";
        OutS: OutStream;
        InS: InStream;
    begin
        P.Init();
        P.Data.CreateOutStream(OutS);
        OutS.WriteText('1,A');
        P.Data.CreateInStream(InS);
        Xmlport.Import(Xmlport::"Refusal Probe Import", InS);
    end;

    [Test]
    procedure FeatureKeyRollback()
    var
        FeatureKey: Record "Feature Key";
    begin
        if not FeatureKey.FindFirst() then
            exit;
        FeatureKey.Enabled := FeatureKey.Enabled::"All Users";
        FeatureKey.Modify();
        asserterror Error('roll back');
    end;

    [Test]
    procedure LicensePermissionTableData99()
    var
        LicensePermission: Record "License Permission";
    begin
        if LicensePermission.Get(LicensePermission."Object Type"::TableData, 99) then;
    end;

    [Test]
    procedure ApiWebServiceFind()
    var
        ApiWebService: Record "Api Web Service";
    begin
        if ApiWebService.FindFirst() then;
    end;

    [Test]
    procedure DownloadFromStream()
    var
        P: Record "Refusal Probe";
        InS: InStream;
        FileName: Text;
    begin
        P.Data.CreateInStream(InS);
        FileName := 'a.txt';
        File.DownloadFromStream(InS, '', '', '', FileName);
    end;

    [Test]
    procedure ReportSaveAsHtml()
    var
        P: Record "Refusal Probe";
        OutS: OutStream;
    begin
        P.Id := 1;
        P.Insert();
        P.Data.CreateOutStream(OutS);
        Report.SaveAs(Report::"Refusal Probe Report", '', ReportFormat::Html, OutS);
    end;

    [Test]
    procedure JsonNullAsDecimal()
    var
        J: JsonObject;
        T: JsonToken;
        D: Decimal;
    begin
        J.ReadFrom('{"a":null}');
        J.Get('a', T);
        asserterror D := T.AsValue().AsDecimal();
    end;

    [Test]
    procedure ResourceWithoutEncoding()
    var
        T: Text;
    begin
        T := NavApp.GetResourceAsText('latin1.txt');
    end;

    [Test]
    procedure InStreamReadBigIntegerLength()
    var
        P: Record "Refusal Probe";
        OutS: OutStream;
        InS: InStream;
        T: Text;
        L: BigInteger;
    begin
        P.Data.CreateOutStream(OutS);
        OutS.WriteText('abc');
        P.Data.CreateInStream(InS);
        L := 2;
        InS.Read(T, L);
    end;

    [Test]
    procedure SetFilterNotADecimal()
    var
        P: Record "Refusal Probe";
    begin
        asserterror P.SetFilter(Amount, 'not a number');
    end;

    [Test]
    procedure SetFilterNotAnInteger()
    var
        P: Record "Refusal Probe";
    begin
        asserterror P.SetFilter(Qty, 'not an integer');
    end;

    [Test]
    procedure CompanyFindSet()
    var
        C: Record Company;
    begin
        if C.FindSet() then;
    end;
}
