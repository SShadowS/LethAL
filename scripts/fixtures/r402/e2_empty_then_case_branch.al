codeunit 79600 "R402 Shape"
{
    // R729 shape 1 in a case branch: the branch body is `if X then;`, then another branch follows.
    procedure Run(N: Integer): Boolean
    var
        Found: Boolean;
    begin
        case N of
            1:
                if Check(1, 2) then;
            2:
                Found := true;
        end;
        exit(Found);
    end;

    local procedure Check(P: Integer; Q: Integer): Boolean
    begin
        exit(P < Q);
    end;
}
