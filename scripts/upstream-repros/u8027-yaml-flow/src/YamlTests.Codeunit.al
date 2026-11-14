codeunit 50300 "Yaml Flow Mapping Tests"
{
    Subtype = Test;

    [Test]
    procedure FlowMappingTwoNumbers()
    var
        O: JsonObject;
    begin
        if not O.ReadFromYaml('{"a": 1, "b": 2}') then
            Error('ReadFromYaml returned false');
    end;

    [Test]
    procedure FlowMappingTwoTexts()
    var
        O: JsonObject;
    begin
        if not O.ReadFromYaml('{"a": "x", "b": "y"}') then
            Error('ReadFromYaml returned false');
    end;

    [Test]
    procedure FlowMappingUnquotedKeys()
    var
        O: JsonObject;
    begin
        if not O.ReadFromYaml('{a: 1, b: 2}') then
            Error('ReadFromYaml returned false');
    end;

    [Test]
    procedure FlowMappingOneKey()
    var
        O: JsonObject;
    begin
        if not O.ReadFromYaml('{"a": 1}') then
            Error('ReadFromYaml returned false');
    end;

    [Test]
    procedure BlockMappingTwoKeys()
    var
        O: JsonObject;
        Lf: Text[1];
    begin
        Lf[1] := 10;
        if not O.ReadFromYaml('a: 1' + Lf + 'b: 2' + Lf) then
            Error('ReadFromYaml returned false');
    end;

    [Test]
    procedure FlowMappingTwoNumbersReadsValues()
    var
        O: JsonObject;
        T: JsonToken;
    begin
        O.ReadFromYaml('{"a": 1, "b": 2}');
        O.Get('b', T);
        if T.AsValue().AsInteger() <> 2 then
            Error('b is not 2');
    end;
}
