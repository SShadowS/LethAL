// The REAL fixture's exact Count()-based trigger, byte-for-byte (matches
// fixtures/sandbox-data/src/DataKeyProbe.Table.al). Left completely unmodified throughout this
// investigation: the bug and its fix both belong in the CALLER's loop, not in this trigger. See
// README.md for the full investigation.
table 71591 "ArmK Count Probe"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "No."; Code[20]) { }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    trigger OnInsert()
    begin
        if "No." = '' then
            "No." := 'KEY-' + Format(Count() + 1);
    end;
}
