// twin of WrappedTrigger: the wrapper's #if line, as a comment
namespace LethAL.SandboxWrapped;

// R536: a one-arm wrapped TABLE alone in its file, with a field trigger and a procedure. Its
// unwrapped twin (WrappedTriggerTwin) has the same text on the same lines. Do not move a line
// without a new pre-commitment.
table 78908 "Wrapped Trigger Twin"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; Code; Code[20])
        {
        }
        field(2; Qty; Integer)
        {
            trigger OnValidate()
            begin
                if Qty < 0 then
                    Qty := 0;
            end;
        }
    }

    keys
    {
        key(PK; Code)
        {
            Clustered = true;
        }
    }

    procedure Doubled(): Integer
    begin
        exit(Qty * 2);
    end;
}
// twin of WrappedTrigger: the wrapper's #endif line, as a comment
