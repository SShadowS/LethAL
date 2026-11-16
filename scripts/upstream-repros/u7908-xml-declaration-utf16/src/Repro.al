table 58150 "PX Blob"
{
    TableType = Temporary;

    fields
    {
        field(1; Id; Integer) { }
        field(2; Data; Blob) { }
    }

    keys
    {
        key(PK; Id) { Clustered = true; }
    }
}

report 58151 "PX Param Report"
{
    UsageCategory = None;

    dataset
    {
        dataitem(R; Integer)
        {
            DataItemTableView = where(Number = const(1));
            column(Num; Number) { }
        }
    }

    requestpage
    {
        layout
        {
            area(Content)
            {
                field(StartCtl; StartDate) { ApplicationArea = All; }
            }
        }
    }

    trigger OnPreReport()
    begin
        if StartDate <> 20260115D then
            Error('StartDate is %1', StartDate);
    end;

    var
        StartDate: Date;
}

codeunit 58152 "PX Xml Decl Tests"
{
    Subtype = Test;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure WrittenByWriteTo()
    var
        B: Record "PX Blob";
        Doc: XmlDocument;
        Node: XmlNode;
        Xml: Text;
        Out: OutStream;
    begin
        XmlDocument.ReadFrom('<?xml version="1.0" standalone="yes"?><ReportParameters><Options><Field name="StartDate" /></Options></ReportParameters>', Doc);
        Doc.SelectSingleNode('ReportParameters/Options/Field[@name="StartDate"]', Node);
        Node.AsXmlElement().Add(XmlText.Create('2026-01-15'));
        Doc.WriteTo(Xml);
        B.Data.CreateOutStream(Out);
        Report.SaveAs(Report::"PX Param Report", Xml, ReportFormat::Xml, Out);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure Utf16DeclarationOneLine()
    var
        B: Record "PX Blob";
        Out: OutStream;
    begin
        B.Data.CreateOutStream(Out);
        Report.SaveAs(Report::"PX Param Report", '<?xml version="1.0" encoding="utf-16" standalone="yes"?><ReportParameters><Options><Field name="StartDate">2026-01-15</Field></Options></ReportParameters>', ReportFormat::Xml, Out);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure PlainDeclaration()
    var
        B: Record "PX Blob";
        Out: OutStream;
    begin
        B.Data.CreateOutStream(Out);
        Report.SaveAs(Report::"PX Param Report", '<?xml version="1.0" standalone="yes"?><ReportParameters><Options><Field name="StartDate">2026-01-15</Field></Options></ReportParameters>', ReportFormat::Xml, Out);
    end;
}
