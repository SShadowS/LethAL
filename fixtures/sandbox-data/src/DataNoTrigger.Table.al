table 79301 "Data No Trigger"
{
    DataClassification = CustomerContent;
    // ROADMAP R1 REPRODUCTION (Stream A, scratch — NOT to be merged): neutralised, see DataMain.
    // InherentPermissions = RIMD;

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
