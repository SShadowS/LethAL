// Upstream #7995 (its unreduced Regex case) as reduced in #8268: a DotNet value that was never assigned, passed where a .NET
// parameter is a value type. al-runner refuses each null call ("has no overload taking N argument(s) of the given types (...,
// null)"). BC's answers, measured on BC 28.4 W1 (bc3, PR-213, 2026-11-19): creating the object fails with code
// DotNetCreate:NullReference; a static method call treats the null Byte as 0. Each test passes on BC.
dotnet
{
    assembly(mscorlib)
    {
        type(System.DateTimeOffset; U7995DateTimeOffset) { }
        type(System.DateTime; U7995DateTime) { }
        type(System.TimeSpan; U7995TimeSpan) { }
        type(System.Convert; U7995Convert) { }
        type(System.Byte; U7995Byte) { }
    }
    assembly(System)
    {
        type(System.Text.RegularExpressions.Regex; U7995Regex) { }
        type(System.Text.RegularExpressions.RegexOptions; U7995RegexOptions) { }
    }
}

codeunit 58390 "U7995 Null TimeSpan Create"
{
    Subtype = Test;

    [Test]
    procedure NullTimeSpanIntoDateTimeOffset()
    var
        D: DotNet U7995DateTime;
        TS: DotNet U7995TimeSpan;
        DTO: DotNet U7995DateTimeOffset;
    begin
        D := D.UtcNow();
        asserterror DTO := DTO.DateTimeOffset(D, TS);
        if GetLastErrorCode() <> 'DotNetCreate:NullReference' then
            Error('BC: code DotNetCreate:NullReference, got %1 (%2)', GetLastErrorCode(), GetLastErrorText());
    end;
}

codeunit 58391 "U7995 Null Byte ToString"
{
    Subtype = Test;

    [Test]
    procedure NullByteIsZero()
    var
        B: DotNet U7995Byte;
        Cv: DotNet U7995Convert;
    begin
        if Cv.ToString(B, 2) <> '0' then
            Error('BC: Convert.ToString of a never-assigned Byte in base 2 is 0, got %1', Cv.ToString(B, 2));
    end;
}

codeunit 58392 "U7995 Null Regex Timeout"
{
    Subtype = Test;

    [Test]
    procedure NullTimeSpanIntoRegex()
    var
        R: DotNet U7995Regex;
        Opt: DotNet U7995RegexOptions;
        TS: DotNet U7995TimeSpan;
    begin
        Opt := Opt.None;
        asserterror R := R.Regex('a+', Opt, TS);
        if GetLastErrorCode() <> 'DotNetCreate:NullReference' then
            Error('BC: code DotNetCreate:NullReference, got %1 (%2)', GetLastErrorCode(), GetLastErrorText());
    end;
}

codeunit 58393 "U7995 Control"
{
    Subtype = Test;

    [Test]
    procedure EveryArgumentAssigned()
    var
        D: DotNet U7995DateTime;
        TS: DotNet U7995TimeSpan;
        DTO: DotNet U7995DateTimeOffset;
        B: DotNet U7995Byte;
        Cv: DotNet U7995Convert;
    begin
        // UTC with a zero offset, so the offset check holds in any host time zone.
        D := D.UtcNow();
        TS := TS.TimeSpan(0, 0, 0);
        DTO := DTO.DateTimeOffset(D, TS);
        B := Cv.ToByte(5);
        if Cv.ToString(B, 2) <> '101' then
            Error('wrong: %1', Cv.ToString(B, 2));
    end;
}
