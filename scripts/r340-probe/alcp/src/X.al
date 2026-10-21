xmlport 92800 "PXP"
{
    schema
    {
        textelement(Root)
        {
            tableelement(PTE; "PT")
            {
                trigger OnAfterGetRecord()
                var
                    Q, Z: Integer;
                begin
                    TakeInts(Q, Z); // POS xmlport tableelement trigger
                    Message('%1', Z + Z);
                end;
            }
        }
    }
    procedure TakeInts(A: Integer; B: Integer) begin end;
}
