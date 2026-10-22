report 92800 "PR"
{
    ProcessingOnly = true;
    dataset
    {
        dataitem(Outer; "PT")
        {
            dataitem(Inner; "PT")
            {
                trigger OnAfterGetRecord()
                var
                    Q, Z: Integer;
                begin
                    TakeInts(Q, Z); // POS report inner dataitem trigger
                    Message('%1', Z + Z);
                end;
            }
            trigger OnAfterGetRecord()
            var
                Q, Z: Integer;
            begin
                TakeInts(Q, Z); // POS report dataitem trigger
                Message('%1', Z + Z);
            end;
        }
    }
    requestpage
    {
        SourceTable = "PT";
        trigger OnOpenPage()
        var
            Q, Z: Integer;
        begin
            TakeInts(Q, Z); // POS request page trigger
            Message('%1', Z + Z);
        end;
    }
    var
        GQ, Z: Integer;
    procedure TakeInts(A: Integer; B: Integer) begin end;
}
