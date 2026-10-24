codeunit 79600 "R402 Shape"
{
    // R731: a one-character literal assigned to a Char, or to one element of a Text. Blanking it is
    // AL0122 (`''` is a Text and does not convert to Char), which would fail the whole batch.
    procedure Run(N: Integer): Text
    var
        Ch: Char;
        T: Text[10];
    begin
        Ch := 'x';
        T := 'abc';
        T[1] := 'z';
        if Ch = 'x' then
            T[2] := 'y';
        exit(T);
    end;
}
