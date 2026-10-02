codeunit 79800 "Multi A"
{
    procedure Never(X: Integer): Integer
    begin
        exit(X + 7);
    end;
}

codeunit 79801 "Multi B"
{
    procedure Reached(X: Integer): Integer
    begin
        if X > 10 then
            exit(X + 1);
        exit(X); end;
    procedure Unreached(X: Integer): Integer
    begin
        exit(X * 3);
    end;
}
