#if WRAPDEF
namespace LethAL.SandboxWrapped;

// R550: a one-arm wrapped REPORT alone in its file: a data-item trigger over a bounded TABLE item
// (not an open Integer item), a request-page trigger never shown, a report trigger, and two
// report-level procedures BELOW the triggers. Run by BandYRun (UseRequestPage(false), RunModal);
// `Band` is also called on an un-run report variable by BandYDirect. Its unwrapped twin
// (WrappedYBandTwin) has the same text on the same lines. Do not move a line without a new
// pre-commitment.
report 78913 "Wrapped Y Band"
{
    ProcessingOnly = true;
    UsageCategory = None;

    dataset
    {
        dataitem(BandRow; "Wrapped Band Row")
        {
            DataItemTableView = where("Band Code" = const('BAND'));

            trigger OnAfterGetRecord()
            begin
                Total += Band(BandRow.Qty);
            end;
        }
    }

    requestpage
    {
        layout
        {
            area(Content)
            {
                field(ShownField; Shown)
                {
                    Caption = 'Shown';
                }
            }
        }

        trigger OnOpenPage()
        begin
            Shown := true;
        end;
    }

    var
        Total: Integer;
        Shown: Boolean;

    trigger OnPreReport()
    begin
        Total := 0;
    end;

    procedure Band(N: Integer): Integer
    begin
        if N > 2 then
            exit(2);
        exit(1);
    end;

    procedure GetTotal(): Integer
    begin
        exit(Total);
    end;
}
#endif
