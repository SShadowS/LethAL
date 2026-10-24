codeunit 79600 "R402 Shape"
{
    // R729 shape 1: an `if X then;` (an inner if whose then is empty, the `;` ending it) is the
    // whole body of an outer `if`. The one `;` ends both statements; a wrapper must keep it.
    procedure Probe(): Boolean
    var
        Found: Boolean;
    begin
        if not Found then
            if Check(1, 2) then;

        if Check(2, 3) then
            Found := true;
        exit(Found);
    end;

    local procedure Check(P: Integer; Q: Integer): Boolean
    begin
        exit(P < Q);
    end;
}
