tableextension 92800 "PTX" extends "PT"
{
    fields
    {
        modify(Z)
        {
            trigger OnAfterValidate()
            var
                Q, Z: Integer;
            begin
                XT(Q, Z); // POS tableext field trigger
                Message('%1', Z + Z);
            end;
        }
    }
    procedure XT(A: Integer; B: Integer) begin end;
}
