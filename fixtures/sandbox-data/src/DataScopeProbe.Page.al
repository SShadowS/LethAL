// R70 fixture, half 2 of 2. Its ONLY job is to carry the same NAME as `table 79309
// "Data Scope Probe"` and to declare a global the table does not.
//
// `Helper` is a `Record "Data Main"` — a DIFFERENT table from the one the table's trigger-local
// `Helper` names. That is deliberate: R70's hazard has two halves, and this is the second. A
// receiver that resolves to the WRONG table sends rule 3's shadowing guard at the wrong table,
// which is a wrong claim even where a claim happens to be warranted.
//
// No `SourceTable`, no actions, nothing else. R76 measured that a page over a trigger-carrying
// table can HANG a fenced session; this page must never be opened by anything, and nothing here
// opens it. It exists to be PARSED.
page 79324 "Data Scope Probe"
{
    PageType = Card;
    ApplicationArea = All;

    layout
    {
        area(Content)
        {
            group(Placeholder)
            {
                field(HelperNo; HelperNo)
                {
                    ApplicationArea = All;
                    Caption = 'Helper No.';
                    Editable = false;
                    ToolTip = 'Present so the page has a layout; never displayed by any test.';
                }
            }
        }
    }

    var
        Helper: Record "Data Main";
        HelperNo: Code[20];

    trigger OnOpenPage()
    begin
        HelperNo := Helper."No.";
    end;
}
