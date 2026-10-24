#if CFACTIVE
#pragma warning disable AL0432
#pragma warning disable AL0604
#pragma warning disable AL0667
#endif
codeunit 79900 "CF Active"
{
    procedure Add(A: Integer; B: Integer): Integer
    begin
        exit(A + B);
    end;

    procedure IsBig(X: Integer): Boolean
    begin
        exit(X > 100);
    end;

    procedure Both(P: Boolean; Q: Boolean): Boolean
    begin
        exit(P and Q);
    end;
}
