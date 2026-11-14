codeunit 50280 "Probe Json Tab Tests"
{
    Subtype = Test;

    [Test]
    procedure TokenReadFromRawTab()
    var
        Token: JsonToken;
        Value: JsonToken;
        Tab: Text[1];
    begin
        Tab[1] := 9;
        if not Token.ReadFrom('{"question": "Name' + Tab + 'Price"}') then
            Error('JsonToken.ReadFrom returned false for a raw TAB inside a string');
        Token.AsObject().Get('question', Value);
        if Value.AsValue().AsText() <> 'Name' + Tab + 'Price' then
            Error('the value lost its TAB');
    end;

    [Test]
    procedure ObjectReadFromRawTab()
    var
        Obj: JsonObject;
        Tab: Text[1];
    begin
        Tab[1] := 9;
        if not Obj.ReadFrom('{"question": "Name' + Tab + 'Price"}') then
            Error('JsonObject.ReadFrom returned false for a raw TAB inside a string');
    end;

    [Test]
    procedure TokenReadFromEscapedTab()
    var
        Token: JsonToken;
    begin
        if not Token.ReadFrom('{"question": "Name\tPrice"}') then
            Error('JsonToken.ReadFrom returned false for an escaped TAB');
    end;
}
