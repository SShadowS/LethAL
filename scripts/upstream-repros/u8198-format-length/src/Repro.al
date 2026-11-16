// Invented repro: Format(Value, Length) truncates a DateFormula's text to Length on BC; measured on BC 28.4 W1 (PR-86).
codeunit 58330 "Fmt Len Test"
{
    Subtype = Test;

    [Test]
    procedure FormatLengthTruncatesDateFormula()
    var
        DF: DateFormula;
    begin
        Evaluate(DF, '<1Y+1M+1D>');
        if Format(DF, 4) <> '1Y+1' then
            Error('BC gives 1Y+1 for Format(DF, 4); got %1', Format(DF, 4));
    end;
}
