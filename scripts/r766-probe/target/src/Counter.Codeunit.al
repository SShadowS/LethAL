codeunit 50760 "R766 Counter"
{
    SingleInstance = true;

    var
        Count: Integer;

    procedure Bump(): Integer
    begin
        Count += 1;
        exit(Count);
    end;
}
