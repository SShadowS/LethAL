codeunit 51300 "Conditional Boundary Target"
{
    procedure Classify(n: Integer): Integer
    begin
        if n > 0 then
            exit(1);
        if n < 0 then
            exit(-1);
        if n >= 100 then
            exit(2);
        exit(0);
    end;
}
