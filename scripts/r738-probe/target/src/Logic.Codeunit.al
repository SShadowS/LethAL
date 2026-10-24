codeunit 93790 "R738 Logic"
{
    procedure Other(X: Integer): Integer
    begin
        exit(X + 1);
    end;

    procedure Scale(X: Integer; Y: Integer): Integer
    begin
        exit(X * 2 + Y);
    end;
}
