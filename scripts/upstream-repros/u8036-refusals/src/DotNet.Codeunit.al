// R-983: a member of a DotNet variable that holds no object (a mutant removed the line that made it), and .NET exceptions
// whose AL text is not pinned. BC raises an error in each; asserterror checks only that one is raised.
dotnet
{
    assembly(System)
    {
        type(System.Uri; ReproUri) { }
        type(System.UriBuilder; ReproUriBuilder) { }
        type(System.Text.RegularExpressions.Regex; ReproRegex) { }
    }
    assembly(mscorlib)
    {
        type(System.TimeZoneInfo; ReproTimeZoneInfo) { }
        type(System.Globalization.CultureInfo; ReproCultureInfo) { }
    }
}

codeunit 50520 "DotNet Refusal Repros"
{
    Subtype = Test;

    [Test]
    procedure UriAbsoluteUriNoObject()
    var
        U: DotNet ReproUri;
        T: Text;
    begin
        asserterror T := U.AbsoluteUri;
    end;

    [Test]
    procedure UriBuilderQueryNoObject()
    var
        B: DotNet ReproUriBuilder;
        T: Text;
    begin
        asserterror T := B.Query;
    end;

    [Test]
    procedure TimeZoneGetUtcOffsetNoObject()
    var
        Z: DotNet ReproTimeZoneInfo;
    begin
        asserterror Z.GetUtcOffset(CurrentDateTime());
    end;

    [Test]
    procedure RegexIsMatchStartAt()
    var
        R: DotNet ReproRegex;
    begin
        R := R.Regex('b');
        if not R.IsMatch('abc', 1) then
            Error('IsMatch(String, Int32) returned false');
    end;

    [Test]
    procedure RegexMatchesInstance()
    var
        R: DotNet ReproRegex;
    begin
        R := R.Regex('b');
        if R.Matches('abcb').Count() <> 2 then
            Error('Matches(String) did not find 2');
    end;
}
