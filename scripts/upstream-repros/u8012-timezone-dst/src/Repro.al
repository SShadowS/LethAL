dotnet
{
    assembly("mscorlib")
    {
        type("System.TimeZoneInfo"; R969TimeZoneInfo) { }
    }
}

codeunit 58170 "R969 Time Zone"
{
    Subtype = Test;

    [Test]
    procedure HawaiiHasNoDaylightSaving()
    var
        Tz: DotNet R969TimeZoneInfo;
    begin
        Tz := Tz.FindSystemTimeZoneById('Hawaiian Standard Time');
        if Tz.SupportsDaylightSavingTime then
            Error('Hawaiian Standard Time reports daylight saving time');
    end;

    [Test]
    procedure ChinaHasNoDaylightSaving()
    var
        Tz: DotNet R969TimeZoneInfo;
    begin
        Tz := Tz.FindSystemTimeZoneById('China Standard Time');
        if Tz.SupportsDaylightSavingTime then
            Error('China Standard Time reports daylight saving time');
    end;
}
