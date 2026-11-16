// Invented repro: TextBuilder.ToText(StartIndex, Count) outside the text; measured on BC 28.4 W1 (PR-87).
codeunit 58370 "TB ToText Test"
{
    Subtype = Test;

    [Test]
    procedure ToTextOutsideTheText()
    var
        TB: TextBuilder;
    begin
        TB.Append('abcdef');
        if TB.ToText(2, 9) <> 'bcdef' then
            Error('BC: ToText(2, 9) is bcdef; got %1', TB.ToText(2, 9));
        if TB.ToText(-1, 1) <> 'a' then
            Error('BC: ToText(-1, 1) is a; got %1', TB.ToText(-1, 1));
        if TB.ToText(9, 1) <> '' then
            Error('BC: ToText(9, 1) is empty; got %1', TB.ToText(9, 1));
    end;
}
