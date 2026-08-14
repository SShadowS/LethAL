// R141 filter probe table -- the same shape as fixtures/sandbox-data's table 79302 "Data Related"
// ("Entry No." Integer PK, "Main No." Code[20]), so a count measured here transfers to the fixture
// arm R141 plans to add. Throwaway: not a fixture change.
table 71520 "R141 Filter Probe"
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
