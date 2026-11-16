// Invented repro: JSON shapes al-runner refuses, with BC 28.4 W1's measured answers (PR-87).
codeunit 58360 "Json Shapes Test"
{
    Subtype = Test;

    [Test]
    procedure NumberToBigIntegerRounds()
    var
        O: JsonObject;
        T: JsonToken;
    begin
        O.ReadFrom('{"v":1.50}');
        O.Get('v', T);
        if T.AsValue().AsBigInteger() <> 2 then
            Error('BC gives 2; got %1', T.AsValue().AsBigInteger());
    end;

    [Test]
    procedure NonZeroNumberIsTrue()
    var
        O: JsonObject;
        T: JsonToken;
    begin
        O.ReadFrom('{"v":1.50}');
        O.Get('v', T);
        if not T.AsValue().AsBoolean() then
            Error('BC gives true for 1.50');
        Clear(O);
        O.ReadFrom('{"v":1e3}');
        O.Get('v', T);
        if not T.AsValue().AsBoolean() then
            Error('BC gives true for 1e3');
    end;

    [Test]
    procedure TooLargeForIntegerRaises()
    var
        O: JsonObject;
        T: JsonToken;
        I: Integer;
    begin
        O.ReadFrom('{"v":12345678901234567890}');
        O.Get('v', T);
        asserterror I := T.AsValue().AsInteger();
        if GetLastErrorText() <> 'Unable to convert from Microsoft.Dynamics.Nav.Runtime.NavJsonValue to System.Int32.' then
            Error('BC raises a conversion error; got %1 (%2)', I, GetLastErrorText());
    end;

    [Test]
    procedure TooLargeForBigIntegerRaises()
    var
        O: JsonObject;
        T: JsonToken;
        B: BigInteger;
    begin
        O.ReadFrom('{"v":12345678901234567890}');
        O.Get('v', T);
        asserterror B := T.AsValue().AsBigInteger();
        if GetLastErrorText() <> 'Unable to convert from Microsoft.Dynamics.Nav.Runtime.NavJsonValue to Microsoft.Dynamics.Nav.Runtime.NavBigInteger.' then
            Error('BC raises a conversion error; got %1 (%2)', B, GetLastErrorText());
    end;

    [Test]
    procedure DuplicateKeyLastWins()
    var
        O: JsonObject;
        S: Text;
    begin
        if not O.ReadFrom('{"a":1,"a":2}') then
            Error('BC reads it');
        if O.Keys().Count() <> 1 then
            Error('BC keeps one key; got %1', O.Keys().Count());
        O.WriteTo(S);
        if S <> '{"a":2}' then
            Error('BC writes {"a":2}; got %1', S);
    end;

    [Test]
    procedure NumberOverflowIsInfinity()
    var
        O: JsonObject;
        S: Text;
    begin
        if not O.ReadFrom('{"a":1e400}') then
            Error('BC reads it');
        O.WriteTo(S);
        if S <> '{"a":"Infinity"}' then
            Error('BC writes {"a":"Infinity"}; got %1', S);
    end;

    [Test]
    procedure IndexOfAcrossTypes()
    var
        A: JsonArray;
    begin
        A.ReadFrom('[10,20,30,"x"]');
        if A.IndexOf(10) <> 0 then
            Error('BC: IndexOf(10) is 0; got %1', A.IndexOf(10));
        if A.IndexOf(20) <> 1 then
            Error('BC: IndexOf(20) is 1; got %1', A.IndexOf(20));
        if A.IndexOf('x') <> 3 then
            Error('BC: IndexOf(''x'') is 3; got %1', A.IndexOf('x'));
        if A.IndexOf(99) <> -1 then
            Error('BC: IndexOf(99) is -1; got %1', A.IndexOf(99));
        if A.IndexOf('20') <> -1 then
            Error('BC: IndexOf(''20'') is -1; got %1', A.IndexOf('20'));
        if A.IndexOf(20.0) <> -1 then
            Error('BC: IndexOf(20.0) is -1; got %1', A.IndexOf(20.0));
    end;
}
