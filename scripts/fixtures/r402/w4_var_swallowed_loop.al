codeunit 79600 "R402 Shape"
{
    var
        G: Integer;

#if not LETHALX
    procedure Spin(): Integer
    var
        J: Integer;
    begin
        J := 0;
        while J < 5 do
            J += 1;
        while G < 5 do
            G += 1;
        exit(J);
    end;
#endif

    procedure SpinDirect(): Integer
    var
        J: Integer;
    begin
        J := 0;
        while J < 5 do
            J += 1;
        while G < 5 do
            G += 1;
        exit(J);
    end;
}
