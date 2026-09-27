namespace NstRepro02;

page 91612 "NST Repro02 Main List"
{
    PageType = List;
    ApplicationArea = All;
    UsageCategory = Lists;
    SourceTable = "NST Repro02 Main";

    layout
    {
        area(Content)
        {
            repeater(Rows)
            {
                field("No."; Rec."No.") { ApplicationArea = All; ToolTip = 'No.'; }
                field(Amount; Rec.Amount) { ApplicationArea = All; ToolTip = 'Amount'; }
                field("Modify Count"; Rec."Modify Count") { ApplicationArea = All; ToolTip = 'Modify Count'; }
                field("Related Total"; Rec."Related Total") { ApplicationArea = All; ToolTip = 'Related Total'; }
            }
        }
    }
}
