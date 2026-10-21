pageextension 92800 "PPX" extends "PP"
{
    layout
    {
        modify(ZF)
        {
            trigger OnAfterValidate()
            var
                Q, Z: Integer;
            begin
                XTakeInts(Q, Z); // POS pageext field trigger
                Message('%1', Z + Z);
            end;
        }
    }
    trigger OnClosePage()
    var
        Q, Z: Integer;
    begin
        XTakeInts(Q, Z); // POS pageext trigger
        Message('%1', Z + Z);
    end;
    procedure XTakeInts(A: Integer; B: Integer) begin end;
}
