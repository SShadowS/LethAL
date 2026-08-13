// R134 filter probe table -- a plain Integer primary key plus a Code[20] grouping field, the same
// shape as fixtures/sandbox-data's table 79302 "Data Related" ("Entry No." Integer PK, "Main No."
// Code[20]). Kept separate from the committed fixture on purpose: this is a throwaway measurement,
// not a fixture change.
table 71600 "R134 Filter Probe"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "Entry No."; Integer) { }
        field(2; "Main No."; Code[20]) { }
    }

    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
    }
}
