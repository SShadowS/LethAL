report 91600 "R254 Probe Report"
{
    ProcessingOnly = true;
    UsageCategory = None;

    dataset
    {
        dataitem(IntItem; Integer)
        {
            DataItemTableView = where(Number = filter(1 .. 3));

            trigger OnAfterGetRecord()
            begin
                BaseTotal += IntItem.Number;
            end;
        }
    }

    trigger OnPostReport()
    var
        Sink: Codeunit "R254 Probe Sink";
    begin
        Sink.SetBase(BaseTotal);
    end;

    var
        BaseTotal: Integer;
}
