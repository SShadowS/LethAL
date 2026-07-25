table 79301 "Data No Trigger"
{
    DataClassification = CustomerContent;
    // The fenced RunMutant path executes under the OData runner session, which does not hold
    // the test app's write permissions on this table — a test that INSERTs fails with
    // "the current permissions prevented the action" there while passing elsewhere. LethAL's
    // own control tables carry the same declaration for exactly this reason (Lease.Table.al).
    InherentPermissions = RIMD;

    fields
    {
        field(1; "No."; Code[20])
        {
            trigger OnValidate()
            begin
                if StrLen("No.") > 10 then
                    Error('No. too long');
            end;
        }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
}
