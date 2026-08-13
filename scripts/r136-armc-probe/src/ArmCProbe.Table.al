// R136 arm C probe table -- byte-for-byte the same OnDelete shape as
// fixtures/sandbox-data/src/DataTriggerProbe.Table.al: a tombstone row inserted from OnDelete,
// prefixed 'TOMB-'. Kept separate from the committed fixture on purpose (this is a throwaway
// measurement, not a fixture change).
table 71570 "R136 ArmC Probe"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Tombstone; Boolean) { }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    trigger OnDelete()
    var
        Tomb: Record "R136 ArmC Probe";
    begin
        Tomb."No." := 'TOMB-' + "No.";
        Tomb.Tombstone := true;
        Tomb.Insert(false);
    end;
}
