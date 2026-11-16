table 51700 "Args Line"
{
    fields
    {
        field(1; "Kind"; Integer) { }
        field(2; "No."; Code[20]) { }
        field(3; "Line No."; Integer) { }
        field(4; "Text"; Text[50]) { }
    }
    keys
    {
        key(PK; "Kind", "No.", "Line No.") { Clustered = true; }
    }
}

page 51701 "Args Sheet Caption"
{
    PageType = List;
    SourceTable = "Args Line";
    Caption = 'Args Sheet';

    layout
    {
        area(Content)
        {
            repeater(Lines)
            {
                field(TextField; Rec."Text") { }
            }
        }
    }

    trigger OnOpenPage()
    begin
        CaptionString := CurrPage.Caption;
    end;

    trigger OnAfterGetCurrRecord()
    begin
        CurrPage.Caption := Caption() + CaptionString;
    end;

    var
        CaptionString: Text;

    procedure Caption(): Text
    begin
        exit('X ');
    end;
}

page 51702 "Args Sheet Named"
{
    PageType = List;
    SourceTable = "Args Line";
    Caption = 'Args Sheet';

    layout
    {
        area(Content)
        {
            repeater(Lines)
            {
                field(TextField; Rec."Text") { }
            }
        }
    }

    trigger OnAfterGetCurrRecord()
    begin
        CurrPage.Caption := MakeCaption() + 'Y';
    end;

    procedure MakeCaption(): Text
    var
        L: Record "Args Line";
    begin
        if L.Get(1, 'A', 10) then
            exit(L."Text");
        exit('X ');
    end;
}

codeunit 51703 "Args Tests"
{
    Subtype = Test;

    [Test]
    procedure OpenPageWithCaptionProcedure() // BC: passes (the page's own Caption() procedure is called)
    var
        L: Record "Args Line";
        P: TestPage "Args Sheet Caption";
    begin
        L."Kind" := 1;
        L."No." := 'A';
        L."Line No." := 10;
        L.Insert();
        P.OpenView();
        P.First();
        P.Close();
    end;

    [Test]
    procedure OpenPageWithOtherName() // control: the same page shape, procedure named MakeCaption, a 3-value Get (BC: passes)
    var
        L: Record "Args Line";
        P: TestPage "Args Sheet Named";
    begin
        L."Kind" := 1;
        L."No." := 'A';
        L."Line No." := 10;
        L.Insert();
        P.OpenView();
        P.First();
        P.Close();
    end;

    [Test]
    procedure CallCaptionProcedureDirectly() // BC: passes; the page's Caption() returns 'X '
    var
        P: Page "Args Sheet Caption";
    begin
        if P.Caption() <> 'X ' then
            Error('got %1', P.Caption());
    end;
}
