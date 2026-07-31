// R69: the host page for the TestPage probe beside it. Code-free on purpose — if opening it hangs,
// the hang is the PAGE PIPELINE in that session type, not anything this page does.
page 79203 "Probe List"
{
    PageType = List;
    ApplicationArea = All;
    UsageCategory = Lists;
    SourceTable = "Rec XRec Probe";

    layout
    {
        area(Content)
        {
            repeater(Rows)
            {
                field("No."; Rec."No.") { ApplicationArea = All; }
                field(Amount; Rec.Amount) { ApplicationArea = All; }
            }
        }
    }
}
