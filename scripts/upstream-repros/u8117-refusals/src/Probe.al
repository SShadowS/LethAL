table 50900 "PR05 Item"
{
    fields
    {
        field(1; Code; Code[20]) { }
    }
    keys
    {
        key(PK; Code) { Clustered = true; }
    }
}

page 50901 "PR05 Item Card"
{
    PageType = Card;
    SourceTable = "PR05 Item";
    layout
    {
        area(Content)
        {
            field(Code; Rec.Code) { }
        }
    }
}

codeunit 50903 "PR05 Probe Tests"
{
    Subtype = Test;

    [Test]
    procedure SidWithoutUserName() // BC: passes (it answers the current user's security identifier)
    var
        Sid: Text;
    begin
        Sid := Database.SID();
    end;

    [Test]
    procedure GoToKeyOnCardForMissingKey() // BC: passes (as a statement, GoToKey returns false and the card stays on its row)
    var
        Card: TestPage "PR05 Item Card";
        Item: Record "PR05 Item";
    begin
        Item.Code := 'A';
        Item.Insert();
        Card.OpenView();
        Card.GoToKey('MISSING');
        Card.Close();
    end;
}
