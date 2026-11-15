table 50100 "PV Batch"
{
    fields
    {
        field(1; Name; Code[10]) { }
    }
    keys { key(PK; Name) { Clustered = true; } }
}

table 50101 "PV Line"
{
    fields
    {
        field(1; Batch; Code[10]) { }
        field(2; LineNo; Integer) { }
    }
    keys { key(PK; Batch, LineNo) { Clustered = true; } }
}

page 50105 "PV Journal"
{
    PageType = Worksheet;
    SourceTable = "PV Line";

    layout
    {
        area(Content)
        {
            repeater(Lines)
            {
                field(Batch; Rec.Batch) { }
                field(LineNo; Rec.LineNo) { }
            }
        }
        area(FactBoxes)
        {
            part(StatusBatch; "Workflow Status FactBox")
            {
                Editable = false;
                Enabled = false;
                ShowFilter = false;
                Visible = ShowStatus;
            }
        }
    }

    actions
    {
        area(Processing)
        {
            action(Send)
            {
                trigger OnAction()
                var
                    Mgt: Codeunit "PV Mgt";
                begin
                    Mgt.Send(Rec);
                    RefreshStatus();
                end;
            }
        }
    }

    local procedure RefreshStatus()
    var
        B: Record "PV Batch";
    begin
        if not B.Get(Rec.Batch) then
            exit;
        ShowStatus := CurrPage.StatusBatch.Page.SetFilterOnWorkflowRecord(B.RecordId());
    end;

    trigger OnAfterGetCurrRecord()
    begin
        RefreshStatus();
    end;

    trigger OnOpenPage()
    begin
        RefreshStatus();
    end;

    var
        ShowStatus: Boolean;
}

codeunit 50106 "PV Mgt"
{
    procedure Send(Line: Record "PV Line")
    var
        B: Record "PV Batch";
        S: Record "Workflow Step Instance";
    begin
        B.Get(Line.Batch);
        S.ID := CreateGuid();
        S."Record ID" := B.RecordId();
        S.Insert();
    end;
}

codeunit 50107 "PV Tests"
{
    Subtype = Test;

    [Test]
    procedure SendMakesStatusVisible()
    var
        B: Record "PV Batch";
        L: Record "PV Line";
        P: TestPage "PV Journal";
    begin
        B.Name := 'B1';
        B.Insert();
        L.Batch := 'B1';
        L.LineNo := 1;
        L.Insert();
        P.OpenView();
        P.GoToRecord(L);
        P.Send.Invoke();
    end;
}
