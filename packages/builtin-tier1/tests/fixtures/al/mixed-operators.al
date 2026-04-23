codeunit 51900 "Mixed Operators"
{
    procedure Classify(n: Integer; OnlyPositive: Boolean): Integer
    begin
        if n > 0 then begin
            Log('positive');
            exit(n);
        end;
        if OnlyPositive and (n = 0) then
            exit(0);
        exit(-1);
    end;
}
