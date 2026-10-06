// control: no wrapper (this line stands where W1 has its #if)
namespace LethAL.R300bProbe;

codeunit 91901 "R300b C1 Control"
{
    procedure Hit(): Integer
    var
        X: Integer;
    begin
        X := 9051;
        // gap
        // gap
        // gap
        X += 1;
        // gap
        // gap
        // gap
        exit(X);
    end;

    procedure Miss(): Integer
    begin
        exit(9059);
    end;
}
// control: end (this line stands where W1 has its #endif)
