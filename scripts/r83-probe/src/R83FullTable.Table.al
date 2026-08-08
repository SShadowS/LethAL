// R83 table arm. Three tables, IDENTICAL in every respect except the `InherentPermissions`
// declaration, each taking the same `Insert` from the same test body in the same session. Any
// difference in outcome is the property.
table 71527 "R83 Full Table"
{
    DataClassification = SystemMetadata;
    InherentPermissions = RIMD;
    fields
    {
        field(1; "Key"; Code[20]) { DataClassification = SystemMetadata; }
    }

    keys
    {
        key(PK; "Key") { Clustered = true; }
    }
}
