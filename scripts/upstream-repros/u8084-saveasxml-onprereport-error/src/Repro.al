table 51770 "SX Row"
{
    fields
    {
        field(1; "No."; Integer) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
}

report 51771 "SX Date Report"
{
    dataset
    {
        dataitem(Row; "SX Row")
        {
            column(No; "No.") { }
        }
    }

    requestpage
    {
        layout
        {
            area(Content)
            {
                field(StartingDateField; StartingDate) { Caption = 'Starting Date'; }
            }
        }
    }

    trigger OnPreReport()
    begin
        if StartingDate = 0D then
            Error('You must specify a Starting Date.');
    end;

    var
        StartingDate: Date;
}

codeunit 51772 "SX Tests"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('SaveAsXmlHandler')]
    procedure OnPreReportErrorUnderSaveAsXml() // BC: passes (the OnPreReport error reaches Report.Run and asserterror)
    begin
        asserterror Report.Run(Report::"SX Date Report");
        if StrPos(GetLastErrorText(), 'You must specify a Starting Date.') = 0 then
            Error('last error: %1', GetLastErrorText());
    end;

    [Test]
    [HandlerFunctions('SaveAsXmlHandlerWithDate')]
    procedure NoErrorUnderSaveAsXml() // control: a valid date, no error (BC: passes)
    begin
        Report.Run(Report::"SX Date Report");
    end;

    [RequestPageHandler]
    procedure SaveAsXmlHandler(var RP: TestRequestPage "SX Date Report")
    begin
        RP.StartingDateField.SetValue(0D);
        RP.SaveAsXml('sx-params.xml', 'sx-data.xml');
    end;

    [RequestPageHandler]
    procedure SaveAsXmlHandlerWithDate(var RP: TestRequestPage "SX Date Report")
    begin
        RP.StartingDateField.SetValue(DMY2Date(1, 1, 2024));
        RP.SaveAsXml('sx-params2.xml', 'sx-data2.xml');
    end;
}
