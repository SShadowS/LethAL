codeunit 79904 "CF Plain"
{
    procedure Inc(X: Integer): Integer
    begin
        exit(X + 1);
    end;

    procedure IsAdult(Age: Integer): Boolean
    begin
        exit(Age >= 18);
    end;

    procedure Clamp(X: Integer): Integer
    begin
        if X > 50 then
            exit(50);
        exit(X);
    end;
}
