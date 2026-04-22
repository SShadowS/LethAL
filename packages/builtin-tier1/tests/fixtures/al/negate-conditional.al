codeunit 51400 "Negate Conditional Target"
{
    procedure Check(A: Integer; B: Boolean; C: Boolean): Boolean
    begin
        if A = 0 then
            exit(false);
        if A <> 5 then
            exit(false);
        if B and C then
            exit(true);
        if B or C then
            exit(true);
        exit(false);
    end;
}
