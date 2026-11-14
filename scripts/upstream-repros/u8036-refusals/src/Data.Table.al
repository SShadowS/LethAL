table 50500 "Repro Row"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Stamp; DateTime) { }
        field(3; Amount; Decimal) { }
        field(4; Note; Text[30]) { }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}

page 50502 "Repro Card"
{
    PageType = Card;
    SourceTable = "Repro Row";
    layout
    {
        area(Content)
        {
            field("Code"; Rec."Code") { }
            field(Note; Rec.Note) { }
        }
    }
}

page 50503 "Repro Open Card"
{
    PageType = Card;
    SourceTable = "Repro Row";
    layout
    {
        area(Content)
        {
            field("Code"; Rec."Code") { }
        }
    }

    trigger OnOpenPage()
    begin
        // the shape a mutant left: Rec set up but never inserted, so the page's view has no row for it
        Rec.Init();
        Rec."Code" := 'NEW';
    end;
}

table 50501 "Repro Blob"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Data; Blob) { }
    }
    keys { key(PK; Id) { Clustered = true; } }
}
