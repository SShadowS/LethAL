#if PROBESYM
namespace LethAL.R300bProbe;

codeunit 91900 "R300b W1 Wrapped"
{
    procedure Hit(): Integer
    var
        X: Integer;
    begin
        X := 9001;
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
        exit(9009);
    end;
}
#endif
