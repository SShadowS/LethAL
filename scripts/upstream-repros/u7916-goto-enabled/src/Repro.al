page 58140 "PX Enabled Walk"
{
    PageType = List;
    SourceTable = Field;
    Editable = false;
    UsageCategory = None;

    layout
    {
        area(Content)
        {
            repeater(Rows)
            {
                field(NoCtl; Rec."No.") { ApplicationArea = All; }
                field(RelCtl; Rec.RelationTableNo) { ApplicationArea = All; }
            }
        }
    }

    actions
    {
        area(Processing)
        {
            action(NextAction)
            {
                ApplicationArea = All;
                Enabled = NextEnabled;
                trigger OnAction()
                begin
                    Rec.SetRange(TableNo, Rec.RelationTableNo);
                    if Rec.FindFirst() then;
                    CurrPage.Update(false);
                end;
            }
        }
    }

    trigger OnAfterGetRecord()
    begin
        NextEnabled := Rec.RelationTableNo <> 0;
    end;

    var
        NextEnabled: Boolean;
}

codeunit 58141 "PX Enabled Walk Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // Issue #7916 measured BC 29: e2=Yes e4=Yes (the issue's own tests raise MEASURED as an error; these assert the values).
    [Test]
    procedure EnabledAfterGoToKey()
    var
        F: Record Field;
        Walk: TestPage "PX Enabled Walk";
    begin
        F.SetRange(TableNo, 112 /* Sales Invoice Header */);
        Walk.Trap();
        Page.Run(Page::"PX Enabled Walk", F);
        Walk.GoToKey(112 /* Sales Invoice Header */, 480);
        if not Walk.NextAction.Enabled() then
            Error('e1 expected Yes');
        Walk.NextAction.Invoke();
        Walk.GoToKey(480 /* Dimension Set Entry */, 3);
        if not Walk.NextAction.Enabled() then
            Error('e2 expected Yes, rel=%1', Walk.RelCtl.Value());
        Walk.GoToKey(480 /* Dimension Set Entry */, 1);
        if Walk.NextAction.Enabled() then
            Error('e3 expected No');
        Walk.GoToKey(480 /* Dimension Set Entry */, 3);
        if not Walk.NextAction.Enabled() then
            Error('e4 expected Yes, rel=%1', Walk.RelCtl.Value());
    end;

    [Test]
    procedure EnabledAfterGoToKeyNoUpdate()
    var
        F: Record Field;
        Walk: TestPage "PX Enabled Walk";
    begin
        F.SetRange(TableNo, 480 /* Dimension Set Entry */);
        Walk.Trap();
        Page.Run(Page::"PX Enabled Walk", F);
        Walk.GoToKey(480 /* Dimension Set Entry */, 3);
        if not Walk.NextAction.Enabled() then
            Error('e2 expected Yes, rel=%1', Walk.RelCtl.Value());
        Walk.GoToKey(480 /* Dimension Set Entry */, 1);
        if Walk.NextAction.Enabled() then
            Error('e3 expected No');
    end;
}
