codeunit 79902 "CF First"
{
    procedure Twice(X: Integer): Integer
    begin
        exit(X * 2);
    end;

    procedure IsZero(X: Integer): Boolean
    begin
        exit(X = 0);
    end;
}

#if CFACTIVE
#pragma warning disable AL0432
#pragma warning disable AL0604
#pragma warning disable AL0667
#endif

codeunit 79903 "CF Second"
{
    procedure Thrice(X: Integer): Integer
    begin
        exit(X * 3);
    end;

    procedure IsNegative(X: Integer): Boolean
    begin
        exit(X < 0);
    end;

    procedure Pick(Flag: Boolean): Integer
    begin
        if Flag then
            exit(1);
        exit(2);
    end;
}
