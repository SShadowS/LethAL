codeunit 93790 "R738 Logic"
{
    procedure Answer(): Integer
    begin
        exit(1);
    end;

    procedure Other(X: Integer): Integer
    begin
        exit(X + 1);
    end;

    procedure Scale(X: Integer): Integer
    begin
        exit(X * 2);
    end;
}
