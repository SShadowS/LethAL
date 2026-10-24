codeunit 79600 "R402 Shape"
{
    // R732: `case true of` with two labels that compare one variable to adjacent integers. Shifting
    // the first literal makes it equal the second label (AL0402), which would fail the whole batch.
    procedure Run(X: Integer): Integer
    var
        R: Integer;
    begin
        case true of
            X = 0:
                R := 10;
            X = 1:
                R := 20;
        end;
        exit(R);
    end;
}
