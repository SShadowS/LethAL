table 58160 "R969 Amount"
{
    TableType = Temporary;
    fields
    {
        field(1; "No."; Integer) { }
        field(2; Amount; Decimal) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
}

page 58161 "R969 Amount Card"
{
    PageType = Card;
    SourceTable = "R969 Amount";
    SourceTableTemporary = true;
    layout
    {
        area(Content)
        {
            field(Amount; Rec.Amount)
            {
                AutoFormatType = 58162;
            }
        }
    }
}

codeunit 58162 "R969 Auto Format"
{
    EventSubscriberInstance = StaticAutomatic;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"UI Helper Triggers", AutoFormatTranslate, '', false, false)]
    local procedure OneDecimal(AutoFormatType: Integer; AutoFormatExpr: Text[80]; var Translation: Text[80])
    begin
        if AutoFormatType = 58162 then
            Translation := '<Precision,1:1><Standard Format,0>';
    end;
}

codeunit 58163 "R969 Auto Format Test"
{
    Subtype = Test;

    [Test]
    procedure CustomAutoFormatTypeShowsOneDecimal()
    var
        Card: TestPage "R969 Amount Card";
    begin
        Card.OpenNew();
        Card.Amount.SetValue(3456.67843);
        if Card.Amount.Value() <> '3,456.7' then
            Error('shown as %1', Card.Amount.Value());
    end;
}
