table 50011 "P11 Tab"
{
    fields
    {
        field(1; Code; Code[20]) { }
        field(2; Amt; Integer) { }
    }
    keys
    {
        key(PK; Code) { Clustered = true; }
    }
}
