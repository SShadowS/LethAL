codeunit 76100 "Tailcut Logic"
{
    procedure Triple(N: Integer): Integer
    begin
        exit(N * 3);
    end;

    procedure Double(N: Integer): Integer
    begin
        exit(N * 2);
    end;

    procedure IsBig(N: Integer): Boolean
    begin
        exit(N > 5);
    end;

    procedure IsSmall(N: Integer): Boolean
    begin
        exit(N < 3);
    end;
}
