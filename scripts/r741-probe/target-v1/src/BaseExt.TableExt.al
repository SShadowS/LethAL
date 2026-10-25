tableextension 93860 "R741 Base Ext" extends "R741 Base"
{
    procedure Answer(): Integer
    begin
        exit(42);
    end;

    procedure Other(X: Integer): Integer
    begin
        exit(X + 1);
    end;
}
