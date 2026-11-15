codeunit 50970 "PR10 XmlElement AddFirst"
{
    Subtype = Test;

    var
        Saved: XmlElement; // a codeunit-level element that is never assigned

    [Test]
    procedure AddFirstOnUnassignedAsBoolean()
    var
        NewElement: XmlElement;
    begin
        NewElement := XmlElement.Create('child');
        asserterror begin
            if not Saved.AddFirst(NewElement) then
                Error('AddFirst answered false');
        end;
    end;

    [Test]
    procedure AddFirstOnUnassignedStatement()
    var
        NewElement: XmlElement;
    begin
        NewElement := XmlElement.Create('child');
        asserterror Saved.AddFirst(NewElement);
    end;
}
