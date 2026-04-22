codeunit 51600 "Return Value Target"
{
    procedure CountPositive(n: Integer): Integer
    begin
        if n > 0 then
            exit(n);
        exit(0);
    end;

    procedure IsPositive(n: Integer): Boolean
    begin
        exit(n > 0);
    end;

    procedure LogOnly(n: Integer)
    begin
        exit;
    end;
}
