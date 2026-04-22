codeunit 51000 "Wrap Target"
{
    procedure Process(Amount: Decimal)
    begin
        Amount := Amount + 1;
    end;
}
