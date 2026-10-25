pageextension 93861 "R741 Card Ext" extends "R741 Base Card"
{
    procedure PageAnswer(): Integer
    begin
        exit(7);
    end;

    procedure PageOther(X: Integer): Integer
    begin
        exit(X * 2);
    end;
}
