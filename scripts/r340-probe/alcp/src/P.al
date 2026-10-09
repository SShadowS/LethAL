page 92800 "PP"
{
    SourceTable = "PT";
    layout
    {
        area(Content)
        {
            field(ZF; Rec.Z)
            {
                trigger OnValidate()
                var
                    Q, Z: Integer;
                begin
                    TakeInts(Q, Z); // POS page field trigger
                    Message('%1', Z + Z);
                end;
            }
            usercontrol(Ctl; "PAddIn")
            {
                trigger Ready(Z: Integer)
                begin
                    TakeInts(Q, Z); // POS usercontrol event trigger parameter (build review M2)
                    Message('%1', Z + Z);
                end;
            }
        }
    }
    actions
    {
        area(Processing)
        {
            action(Act)
            {
                trigger OnAction()
                var
                    Q, Z: Integer;
                begin
                    TakeInts(Q, Z); // POS page action trigger (build review M2: the most common header trigger)
                    Message('%1', Z + Z);
                end;
            }
        }
    }
    var
        Q, Z: Integer;
    trigger OnOpenPage()
    var
        Q2, Z: Integer;
    begin
        TakeInts(Q2, Z); // POS page trigger local
        TakeInts(Q, Z); // POS page trigger local w global Q
        Message('%1', Z + Z);
    end;
    trigger OnNextRecord(Z: Integer): Integer
    begin
        TakeInts(Q, Z); // POS page trigger parameter
        Message('%1', Z + Z);
        exit(Z);
    end;
    trigger OnFindRecord(Which: Text) Z: Boolean
    begin
        TakeBools(Z, Z); // POS page trigger named return
    end;
    procedure TakeInts(A: Integer; B: Integer) begin end;
    procedure TakeBools(A: Boolean; B: Boolean) begin end;
}
