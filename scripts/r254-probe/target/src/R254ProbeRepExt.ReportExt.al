// The code whose coverage attribution R254 measures: a modify() dataitem trigger, a report-level
// trigger and a procedure, all declared in the EXTENSION. Expected (not yet measured): rows under
// Object Type ReportExtension (option ordinal 22) and Object ID 91601, not under the base report.
reportextension 91601 "R254 Probe RepExt" extends "R254 Probe Report"
{
    dataset
    {
        modify(IntItem)
        {
            trigger OnAfterAfterGetRecord()
            begin
                ExtTotal += Classify(IntItem.Number);
            end;
        }
    }

    trigger OnPreReport()
    begin
        ExtTotal := 0;
    end;

    trigger OnPostReport()
    var
        Sink: Codeunit "R254 Probe Sink";
    begin
        Sink.SetExt(ExtTotal);
    end;

    procedure Classify(N: Integer): Integer
    begin
        if N > 1 then
            exit(10);
        exit(1);
    end;

    // Read through the test's report variable AFTER RunModal: does the instance keep its globals?
    // If yes, a fixture arm needs no sink codeunit.
    procedure GetExtTotal(): Integer
    begin
        exit(ExtTotal);
    end;

    var
        ExtTotal: Integer;
}
