table 93720 "R702 Probe"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Grp; Integer) { }
        field(3; SortKey; Integer) { }
    }

    keys
    {
        key(PK; Id) { Clustered = true; }
        key(SK; Grp, SortKey) { }
    }
}
