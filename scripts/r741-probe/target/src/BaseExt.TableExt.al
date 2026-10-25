tableextension 93860 "R741 Base Ext" extends "R741 Base"
{
    procedure Other(X: Integer): Integer
    begin
        exit(X + 1);
    end;
}
