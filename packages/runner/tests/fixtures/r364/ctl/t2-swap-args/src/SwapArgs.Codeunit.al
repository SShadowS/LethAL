codeunit 50022 "T2 Swap Args"
{
    procedure Go()
    var
        A: Integer;
        B: Integer;
    begin
        Pair(A, B);
    end;

    local procedure Pair(X: Integer; Y: Integer)
    begin
    end;

    local procedure Pair(X: Integer; Y: Text)
    begin
    end;
}
