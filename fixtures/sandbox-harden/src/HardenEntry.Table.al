table 79501 "Harden Entry"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "Entry No."; Integer) { }
        field(2; Category; Code[10]) { }
        field(3; Amount; Integer)
        {
            trigger OnValidate()
            begin
                Doubled := Amount * 2;
            end;
        }
        field(4; Doubled; Integer) { }
    }

    keys
    {
        key(PK; "Entry No.") { }
    }
}
