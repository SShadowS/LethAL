namespace LethAL.SandboxWrapped;

// R550: a PLAIN (unwrapped) table the two report arms read. It holds no trigger and no procedure on
// purpose, so it adds no mutant and no coverage object; only BandYRun and its twin write it, each
// to its own "Band Code", deleting its own rows first.
table 78915 "Wrapped Band Row"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "Band Code"; Code[20])
        {
        }
        field(2; Entry; Integer)
        {
        }
        field(3; Qty; Integer)
        {
        }
    }

    keys
    {
        key(PK; "Band Code", Entry)
        {
            Clustered = true;
        }
    }
}
