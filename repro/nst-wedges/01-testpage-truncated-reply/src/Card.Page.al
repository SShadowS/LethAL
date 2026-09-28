namespace NstRepro01;

// A card page with no source table: one action that sets a page variable, one field showing it.
page 91602 "NST Repro01 Card"
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
                    ToolTip = 'Value set by the Compute action.';
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
                ToolTip = 'Sets the value to 42.';

                trigger OnAction()
                begin
                    ComputedValue := 42;
                end;
            }
        }
    }

    var
        ComputedValue: Integer;
}
