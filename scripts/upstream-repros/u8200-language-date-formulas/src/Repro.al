// Invented repro: date formula letters and messages under GlobalLanguage 1030 and 1031; measured on BC 28.4 W1 (PR-86).
codeunit 58350 "Lang DF Test"
{
    Subtype = Test;

    [Test]
    procedure DanishQuarterLetter()
    var
        DF: DateFormula;
    begin
        GlobalLanguage(1030);
        if not Evaluate(DF, '1K') then
            Error('BC evaluates 1K under 1030');
        if Format(DF, 0, 9) <> '1Q' then
            Error('BC gives 1Q; got %1', Format(DF, 0, 9));
    end;

    [Test]
    procedure DanishEnglishLetterFails()
    var
        DF: DateFormula;
    begin
        GlobalLanguage(1030);
        if Evaluate(DF, '1Y') then
            Error('BC fails Evaluate of 1Y under 1030');
    end;

    [Test]
    procedure DanishFormatCurrent()
    var
        DF: DateFormula;
    begin
        GlobalLanguage(1030);
        Evaluate(DF, 'CM+1D', 9);
        if Format(DF) <> 'LM+1D' then
            Error('BC gives LM+1D; got %1', Format(DF));
    end;

    [Test]
    procedure DanishCalcDateMessage()
    var
        D: Date;
    begin
        GlobalLanguage(1030);
        asserterror D := CalcDate('<1U>', DMY2Date(15, 3, 2024));
        if not GetLastErrorText().StartsWith('Der skal indgå en tidsenhed i datoformlen ''1U''') then
            Error('BC raises in Danish; got %1', GetLastErrorText());
    end;

    [Test]
    procedure GermanDayLetter()
    var
        DF: DateFormula;
    begin
        GlobalLanguage(1031);
        if not Evaluate(DF, '1T') then
            Error('BC evaluates 1T under 1031');
        if Format(DF, 0, 9) <> '1D' then
            Error('BC gives 1D; got %1', Format(DF, 0, 9));
    end;

    [Test]
    procedure GermanFormat()
    var
        DF: DateFormula;
    begin
        GlobalLanguage(1031);
        Evaluate(DF, '1Y+1M+1D', 9);
        if Format(DF) <> '1J+1M+1T' then
            Error('BC gives 1J+1M+1T; got %1', Format(DF));
    end;

    [Test]
    procedure GermanCalcDateMessage()
    var
        D: Date;
    begin
        GlobalLanguage(1031);
        asserterror D := CalcDate('<1T>', DMY2Date(15, 3, 2024));
        if not GetLastErrorText().StartsWith('Die Datumsformel „1T“ muss eine Zeiteinheit enthalten') then
            Error('BC raises in German; got %1', GetLastErrorText());
    end;
}
