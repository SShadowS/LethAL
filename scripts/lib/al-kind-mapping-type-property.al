page 50006 "Mode Card Probe"
{
    PageType = Card;
    SourceTable = "Mode Probe";

    layout
    {
        area(Content)
        {
            field(Kind; Rec.Kind)
            {
                ApplicationArea = All;
                Enabled = Kind = Kind::Alpha;
            }
            field(Type; Rec.Type)
            {
                ApplicationArea = All;
                Visible = Type = Type::Alpha;
            }
        }
    }
}
