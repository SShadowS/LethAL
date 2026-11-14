table 50270 "Probe Setting"
{
    fields
    {
        field(1; Id; Guid) { }
        field(2; Label; Text[30]) { }
    }
    keys { key(PK; Id) { Clustered = true; } }
}

page 50271 "Probe Setup Guide"
{
    PageType = NavigatePage;
    SourceTable = "Probe Setting";
    SourceTableTemporary = true;

    layout
    {
        area(Content)
        {
            field(Label; Rec.Label) { ApplicationArea = All; }
        }
    }

    trigger OnOpenPage()
    begin
        Rec.Init();
        Rec.Insert();
    end;
}

codeunit 50272 "Probe Temp Page Tests"
{
    Subtype = Test;

    [Test]
    procedure OpenNewThenSetValue()
    var
        Guide: TestPage "Probe Setup Guide";
        Setting: Record "Probe Setting";
    begin
        Guide.OpenNew();
        Guide.Label.SetValue('Draft');   // fails here on al-runner
        Guide.Close();
        if not Setting.IsEmpty() then
            Error('the real table holds %1 record(s), expected 0', Setting.Count());
    end;

    [Test]
    procedure OpenNewWithoutSetValue()
    var
        Guide: TestPage "Probe Setup Guide";
    begin
        Guide.OpenNew();
        Guide.Close();
        Guide.OpenNew();
        Guide.Close();
    end;
}
