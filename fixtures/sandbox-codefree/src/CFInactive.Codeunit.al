#if CFINACTIVE
#pragma warning disable AL0432
#pragma warning disable AL0604
#pragma warning disable AL0667
#endif
codeunit 79901 "CF Inactive"
{
    procedure Sub(A: Integer; B: Integer): Integer
    begin
        exit(A - B);
    end;

    procedure IsSmall(X: Integer): Boolean
    begin
        exit(X < 10);
    end;

    procedure Either(P: Boolean; Q: Boolean): Boolean
    begin
        exit(P or Q);
    end;
}
