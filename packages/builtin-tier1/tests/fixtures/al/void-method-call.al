codeunit 51500 "Void Method Call Target"
{
    procedure Run(A: Integer): Integer
    var
        B: Integer;
    begin
        DoThing(A);
        Log('start');
        B := Compute(A);
        exit(B);
    end;
}
