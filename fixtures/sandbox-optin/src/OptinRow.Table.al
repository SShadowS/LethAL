table 77201 "Optin Row"
{
    // R868: a cursor for the shapes `lethal.condition-true` refuses (a restart, a backward step).
    DataClassification = SystemMetadata;

    fields
    {
        field(1; Id; Integer)
        {
            DataClassification = SystemMetadata;
        }
        field(2; Qty; Integer)
        {
            DataClassification = SystemMetadata;
        }
    }

    keys
    {
        key(PK; Id)
        {
            Clustered = true;
        }
    }
}
