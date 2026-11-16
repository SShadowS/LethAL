codeunit 51720 "Closing Date English"
{
    Subtype = Test;

    [Test]
    procedure ClosingDateEnglish()
    begin
        Error('V:[%1]', Format(ClosingDate(DMY2Date(31, 12, 2023))));
    end;
}

codeunit 51721 "Closing Date Danish"
{
    Subtype = Test;

    [Test]
    procedure ClosingDateDanish()
    begin
        GlobalLanguage(1030);
        Error('V:[%1]', Format(ClosingDate(DMY2Date(31, 12, 2023))));
    end;
}
