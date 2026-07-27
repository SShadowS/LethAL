codeunit 79420 "LP Selector"
{
    procedure Active(A: Text; B: Text; C: Text): Boolean
    begin
        exit(false);
    end;
}

table 79421 "LP Base"
{
    fields { field(1; "No."; Code[20]) { } }
}

page 79422 "LP Page"
{
    PageType = Card;
    SourceTable = "LP Base";
    layout { area(Content) { field("No."; Rec."No.") { ApplicationArea = All; } } }
    var
        MutationSelector: Codeunit "LP Selector";
}

pageextension 79423 "LP PageExt" extends "LP Page"
{
    var
        MutationSelector: Codeunit "LP Selector";
}

tableextension 79424 "LP TableExt" extends "LP Base"
{
    fields { field(50; "Extra"; Integer) { } }
    var
        MutationSelector: Codeunit "LP Selector";
}

report 79425 "LP Report"
{
    dataset { dataitem(Base; "LP Base") { } }
    var
        MutationSelector: Codeunit "LP Selector";
}
