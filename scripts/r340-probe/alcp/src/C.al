codeunit 92800 "PC"
{
    TableNo = "PT";
    trigger OnRun()
    var
        Q, Z: Integer;
    begin
        TakeInts(Q, Z); // POS codeunit OnRun TableNo
        Message('%1', Z + Z);
    end;
    procedure TakeInts(A: Integer; B: Integer) begin end;
}
