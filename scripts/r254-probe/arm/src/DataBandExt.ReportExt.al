// R254 arm (DRAFT r3; keep this header 4 lines: the pre-commitment cites line numbers).
//   Band      - called directly through the base report's variable (no report run).
//   the modify(BandItem) trigger and OnPreReport - reached only by running the report.
//   Unreached - no test calls it: the no-coverage control; its `N + 1` is the swap-additive site.
reportextension 79341 "Data Band Ext" extends "Data Band Report"
{
    dataset
    {
        modify(BandItem)
        {
            trigger OnAfterAfterGetRecord()
            begin
                Total += Band(BandItem."Entry No.");
            end;
        }
    }

    trigger OnPreReport()
    begin
        Total := 0;
    end;

    procedure Band(N: Integer): Integer
    begin
        if N >= 3 then
            exit(2);
        exit(1);
    end;

    procedure GetTotal(): Integer
    begin
        exit(Total);
    end;

    procedure Unreached(N: Integer): Integer
    begin
        if N > 0 then
            exit(N + 1);
        exit(0);
    end;

    var
        Total: Integer;
}
