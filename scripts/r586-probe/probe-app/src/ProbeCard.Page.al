page 50600 "Probe Card"
{
    PageType = Card;
    SourceTable = "Probe Row";

    layout
    {
        area(Content)
        {
            field(KeyField; Rec."Key") { }
            field(ValueField; Rec.Value) { }
        }
    }
}
