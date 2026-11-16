codeunit 51740 "Month Text Danish"
{
    Subtype = Test;

    [Test]
    procedure MonthText()
    begin
        GlobalLanguage(1030);
        Error('V:[%1]', Format(DMY2Date(15, 3, 2024), 0, '<Month Text>'));
    end;
}

codeunit 51741 "Weekday Text French"
{
    Subtype = Test;

    [Test]
    procedure WeekdayText()
    begin
        GlobalLanguage(1036);
        Error('V:[%1]', Format(DMY2Date(6, 8, 2024), 0, '<Weekday Text>'));
    end;
}

codeunit 51742 "Month Text Swedish"
{
    Subtype = Test;

    [Test]
    procedure MonthText()
    begin
        GlobalLanguage(1053);
        Error('V:[%1]', Format(DMY2Date(6, 8, 2024), 0, '<Month Text>'));
    end;
}

codeunit 51743 "Weekday Text German"
{
    Subtype = Test;

    [Test]
    procedure WeekdayText()
    begin
        GlobalLanguage(1031);
        Error('V:[%1]', Format(DMY2Date(15, 3, 2024), 0, '<Weekday Text>'));
    end;
}
