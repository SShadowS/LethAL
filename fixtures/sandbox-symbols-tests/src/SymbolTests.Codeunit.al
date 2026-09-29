codeunit 79650 "Symbol Tests"
{
    Subtype = Test;

    var
        SymbolLogic: Codeunit "Symbol Logic";

    [Test]
    procedure RateSmall()
    begin
#if LETHALA
        if SymbolLogic.Rate(1) <> 11 then
            Error('Rate(1) must be 11 in the LETHALA build');
#elif LETHALB
        if SymbolLogic.Rate(1) <> 101 then
            Error('Rate(1) must be 101 in the LETHALB build');
#else
        if SymbolLogic.Rate(1) <> 2 then
            Error('Rate(1) must be 2 in the no-symbol build');
#endif
    end;
}
