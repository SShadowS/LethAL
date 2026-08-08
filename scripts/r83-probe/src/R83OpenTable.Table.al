// R83 table arm. Three tables, IDENTICAL in every respect except the `InherentPermissions`
// declaration, each taking the same `Insert` from the same test body in the same session. Any
// difference in outcome is the property.
table 71525 "R83 Open Table"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "Key"; Code[20]) { DataClassification = SystemMetadata; }
    }

    keys
    {
        key(PK; "Key") { Clustered = true; }
    }
}
