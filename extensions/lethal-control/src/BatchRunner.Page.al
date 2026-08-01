namespace LethAL.Control;

page 71014 "LC Batch Runner"
{
    PageType = List;
    SourceTable = "LC Batch Result";
    Editable = false;
    ApplicationArea = All;
    UsageCategory = Administration;

    layout
    {
        area(Content)
        {
            repeater(Lines)
            {
                field("Codeunit ID"; Rec."Codeunit ID") { }
                field(Method; Rec.Method) { }
                field(Ok; Rec.Ok) { }
                field(Attested; Rec.Attested) { }
                field("Error Text"; Rec."Error Text") { }
            }
        }
    }

    actions
    {
        area(Processing)
        {
            action("Run Batch")
            {
                Caption = 'Run Batch';
                ApplicationArea = All;
                trigger OnAction()
                var
                    Runner: Codeunit "LC Batch Runner";
                begin
                    Runner.RunBatch();
                    CurrPage.Update(false);
                end;
            }
        }
    }
}
