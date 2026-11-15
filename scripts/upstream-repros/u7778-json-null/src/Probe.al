codeunit 50940 "PR05 Json Null"
{
    Subtype = Test;

    [Test]
    procedure NullAsBoolean()
    var
        J: JsonObject;
        T: JsonToken;
        B: Boolean;
    begin
        J.ReadFrom('{"a":null}');
        J.Get('a', T);
        asserterror B := T.AsValue().AsBoolean();
    end;
}
