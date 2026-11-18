table 76001 "Recheck Row"
{
    // Only here so the tests have a record to hand to Page.RunModal.
    fields
    {
        field(1; Code; Code[20])
        {
        }
    }

    keys
    {
        key(PK; Code)
        {
            Clustered = true;
        }
    }
}
