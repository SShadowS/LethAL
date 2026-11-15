table 50100 "AF Setup"
{
    fields
    {
        field(1; Code; Code[10]) { }
        field(2; Decimals; Integer) { }
    }
    keys { key(PK; Code) { Clustered = true; } }

    procedure GetFormat(FieldNo: Integer): Text
    begin
        exit('<precision, 2:2><standard format, 0>');
    end;
}

table 50103 "AF Thing"
{
    fields
    {
        field(1; Code; Code[10]) { }
    }
    keys { key(PK; Code) { Clustered = true; } }
}

tableextension 50104 "AF Thing Ext" extends "AF Thing"
{
    fields
    {
        field(50100; Amount; Decimal)
        {
            AutoFormatType = 11;
            AutoFormatExpression = AFSetup.GetFormat(AFSetup.FieldNo(Decimals));
        }
    }

    var
        AFSetup: Record "AF Setup";
}

page 50101 "AF Card"
{
    SourceTable = "AF Thing";
    PageType = Card;

    layout
    {
        area(Content)
        {
            field(Code; Rec.Code) { }
        }
    }
}

pageextension 50105 "AF Card Ext" extends "AF Card"
{
    layout
    {
        addlast(Content)
        {
            field(Amount; Rec.Amount) { }
        }
    }
}

codeunit 50102 "AF Tests"
{
    Subtype = Test;

    [Test]
    procedure OpenCard()
    var
        S: Record "AF Thing";
        P: TestPage "AF Card";
    begin
        S.Code := 'A';
        S.Amount := 5;
        S.Insert();
        P.OpenView();
        P.GoToRecord(S);
        P.Amount.SetValue(7);
        P.Amount.AssertEquals(7);
    end;
}
