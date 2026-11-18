codeunit 76000 "Recheck Logic"
{
    procedure Sevens(N: Integer) T: Text
    var
        C: Char;
        I: Integer;
    begin
        for I := 1 to N do begin
            C := '7';
            T += Format(C);
        end;
    end;

    procedure SevensB(N: Integer) T: Text
    var
        C: Char;
        I: Integer;
    begin
        for I := 1 to N do begin
            C := '7';
            T += Format(C);
        end;
    end;
}
