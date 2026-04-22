codeunit 50106 "Branching"
{
    procedure Classify(n: Integer): Integer
    begin
        if n > 0 then
            exit(1);
        if n < 0 then
            exit(-1);
        exit(0);
    end;
}
