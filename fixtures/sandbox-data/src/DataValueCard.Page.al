// R78 fixture, half 2 of 2. The only path to `codeunit 79308 "Data Value Source".GetValue`.
//
// No `SourceTable` on purpose. The record is irrelevant to what is being measured, and binding one
// would drag in `Data Main`'s triggers — the exact ingredient R76 measured as turning a fast,
// routable refusal into a session-wedging HANG. This page must stay on the simple side of that
// split.
//
// The displayed field is bound to a page-level global rather than a record field, so the value a
// `TestPage` reads back is unambiguously the one the action just computed.
page 79323 "Data Value Card"
{
    PageType = Card;
    ApplicationArea = All;
    UsageCategory = Administration;

    layout
    {
        area(Content)
        {
            group(Result)
            {
                field(ComputedValue; ComputedValue)
                {
                    ApplicationArea = All;
                    Caption = 'Computed Value';
                    Editable = false;
                    ToolTip = 'The value returned by Data Value Source.GetValue.';
                }
            }
        }
    }

    actions
    {
        area(Processing)
        {
            action(Compute)
            {
                ApplicationArea = All;
                Caption = 'Compute';
                ToolTip = 'Calls Data Value Source.GetValue and shows the result.';

                trigger OnAction()
                var
                    ValueSource: Codeunit "Data Value Source";
                begin
                    ComputedValue := ValueSource.GetValue();
                end;
            }
        }
    }

    var
        ComputedValue: Integer;
}
