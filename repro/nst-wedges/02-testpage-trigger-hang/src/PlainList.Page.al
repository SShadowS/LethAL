namespace NstRepro02;

// Control: a code-free list page. In the incident record this shape was refused in 87 ms.
page 91614 "NST Repro02 Plain List"
{
    PageType = List;
    ApplicationArea = All;
    UsageCategory = Lists;
    SourceTable = "NST Repro02 Related";

    layout
    {
        area(Content)
        {
            repeater(Rows)
            {
                field("Main No."; Rec."Main No.") { ApplicationArea = All; ToolTip = 'Main No.'; }
                field(Amount; Rec.Amount) { ApplicationArea = All; ToolTip = 'Amount'; }
            }
        }
    }
}
