codeunit 79999 "Guard Check"
{
    procedure P(A: Integer): Integer
    begin
        if GuiAllowed then
            exit(A + 1);
        exit(A - 1);
    end;
}
